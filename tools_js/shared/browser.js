/**
 * shared/browser.js - Puppeteer browser helpers.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FingerprintGenerator } from 'fingerprint-generator';
import { FingerprintInjector } from 'fingerprint-injector';
import puppeteerCore from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { enableBlocking } from './adblocker.js';

const puppeteer = addExtra(puppeteerCore);
const stealthPlugin = StealthPlugin();
// Keep UA + client hints fully aligned with our explicit profile rotation.
stealthPlugin.enabledEvasions.delete('user-agent-override');
puppeteer.use(stealthPlugin);

const WS_ENDPOINT = process.env.BROWSER_WS_ENDPOINT || 'ws://127.0.0.1:9222';
const EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/local/bin/google-chrome-stable';
const CHROME_VERSION_API_URL =
  process.env.OWC_CHROME_VERSION_API_URL ||
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const CHROME_VERSION_FALLBACK = String(process.env.OWC_CHROME_VERSION_FALLBACK || '146.0.0.0').trim();
const CHROME_VERSION_TIMEOUT_MS = Number.parseInt(
  String(process.env.OWC_CHROME_VERSION_FETCH_TIMEOUT_MS || '6000'),
  10,
);
const FORCED_VIEWPORT = { width: 1920, height: 1080 };
const FORCED_WINDOWS_PLATFORM = 'Win32';
const FORCED_WINDOWS_PLATFORM_VERSION = '10.0.0';
const FORCED_LANGUAGE = 'en-US,en;q=0.9';
const DEFAULT_LAUNCH_ARGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--remote-allow-origins=*',

  // ── Window / viewport ───────────────────────────────────────────────────────
  // headless=new does NOT honour defaultViewport alone for rendering — the
  // actual paint buffer is taken from the OS window size. Set it explicitly
  // so layout, media queries, and video players all render at 1920×1080.
  `--window-size=${FORCED_VIEWPORT.width},${FORCED_VIEWPORT.height}`,
  '--window-position=0,0',
  '--force-device-scale-factor=1',

  // ── Anti-bot ────────────────────────────────────────────────────────────────
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--hide-crash-restore-bubble',
  '--exclude-switches=enable-automation',

  // ── GPU / video decode ───────────────────────────────────────────────────────
  // Do NOT use --disable-gpu — it kills video frame compositing.
  // Software rasterisation still decodes H.264/AAC when running real Chrome.
  '--use-gl=swiftshader',
  '--use-angle=swiftshader-webgl',
  '--enable-webgl',
  '--ignore-gpu-blocklist',

  // ── Media / autoplay ────────────────────────────────────────────────────────
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream',
  '--mute-audio',
  // Keep the software video decoder path; do NOT try hardware on Linux headless.
  '--disable-features=UseChromeOSDirectVideoDecoder,IsolateOrigins,site-per-process',
  '--enable-features=NetworkService,NetworkServiceInProcess,OverlayScrollbar',

  // ── Stability ────────────────────────────────────────────────────────────────
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--metrics-recording-only',
  '--password-store=basic',
  '--use-mock-keychain',
];

const configuredPageFingerprints = new WeakSet();
const hardenedPages = new WeakSet();
const pageCdps = new WeakMap();
let chromeVersionPromise = null;
let fingerprintSuitePromise = null;

function buildChromeBrands(majorVersion) {
  return [
    { brand: 'Not.A/Brand', version: '99' },
    { brand: 'Chromium', version: majorVersion },
    { brand: 'Google Chrome', version: majorVersion },
  ];
}

function buildSecChUa(brands) {
  return brands.map((entry) => `"${entry.brand}";v="${entry.version}"`).join(', ');
}

function getChromeMajorVersion(version) {
  const major = Number.parseInt(String(version || '').split('.')[0] || '', 10);
  if (Number.isFinite(major) && major > 0) {
    return String(major);
  }

  return String(CHROME_VERSION_FALLBACK.split('.')[0] || '146');
}

async function fetchJson(url) {
  const timeoutMs = Number.isFinite(CHROME_VERSION_TIMEOUT_MS)
    ? CHROME_VERSION_TIMEOUT_MS
    : 6000;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Chrome version endpoint returned HTTP ${response.status}`);
  }

  return response.json();
}

async function resolveLatestStableChromeVersion() {
  const explicitVersion = String(process.env.OWC_CHROME_VERSION || '').trim();
  if (explicitVersion) {
    return explicitVersion;
  }

  if (!chromeVersionPromise) {
    chromeVersionPromise = (async () => {
      try {
        const payload = await fetchJson(CHROME_VERSION_API_URL);
        const stableVersion = payload?.channels?.Stable?.version;
        if (stableVersion && /^\d+\.\d+\.\d+\.\d+$/.test(stableVersion)) {
          return stableVersion;
        }
      } catch {
        // Continue to secondary/fallback resolution below.
      }

      try {
        const fallbackPayload = await fetchJson(
          'https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions?page_size=1',
        );
        const versionName = fallbackPayload?.versions?.[0]?.name || '';
        const extracted = String(versionName).match(/\d+\.\d+\.\d+\.\d+/)?.[0];
        if (extracted) {
          return extracted;
        }
      } catch {
        // Hard fallback below.
      }

      return CHROME_VERSION_FALLBACK;
    })();
  }

  return chromeVersionPromise;
}

function toHeaderRecord(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    output[String(key)] = String(value);
  }
  return output;
}

function toCdpHeaderRecord(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    output[String(key).toLowerCase()] = String(value);
  }
  return output;
}

function buildFingerprintConstraints(chromeMajorVersion) {
  const browserConstraints = [];
  if (chromeMajorVersion) {
    const major = Number(chromeMajorVersion);
    if (Number.isFinite(major) && major > 0) {
      browserConstraints.push({
        name: 'chrome',
        minVersion: major,
        maxVersion: major,
      });
    }
  }

  if (!browserConstraints.length) {
    browserConstraints.push({ name: 'chrome' });
  }

  return {
    browsers: browserConstraints,
    devices: ['desktop'],
    operatingSystems: ['windows'],
    locales: ['en-US'],
    screen: {
      minWidth: FORCED_VIEWPORT.width,
      maxWidth: FORCED_VIEWPORT.width,
      minHeight: FORCED_VIEWPORT.height,
      maxHeight: FORCED_VIEWPORT.height,
    },
  };
}

function buildFingerprintMajorCandidates(chromeMajorVersion) {
  const parsedMajor = Number(chromeMajorVersion);
  if (!Number.isFinite(parsedMajor) || parsedMajor <= 0) {
    return [null];
  }

  const candidates = [parsedMajor];
  for (let offset = 1; offset <= 12; offset += 1) {
    const candidate = parsedMajor - offset;
    if (candidate >= 120) {
      candidates.push(candidate);
    }
  }

  candidates.push(null);
  return candidates;
}

function generateFingerprintBundle(generator, chromeMajorVersion) {
  const majorCandidates = buildFingerprintMajorCandidates(chromeMajorVersion);
  let lastError = null;

  for (const majorCandidate of majorCandidates) {
    try {
      return generator.getFingerprint(buildFingerprintConstraints(majorCandidate));
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Failed to generate a browser fingerprint.');
}

function synchronizeFingerprint(fingerprintBundle, chromeVersion, chromeMajorVersion) {
  const synchronized = structuredClone(fingerprintBundle);
  const navigator = synchronized?.fingerprint?.navigator;
  if (!navigator) {
    return synchronized;
  }

  const chromeVersionToken = `Chrome/${chromeVersion}`;
  navigator.userAgent = String(navigator.userAgent || '')
    .replace(/Chrome\/[\d.]+/gi, chromeVersionToken)
    .replace(/\s+/g, ' ')
    .trim();
  navigator.appVersion = String(navigator.appVersion || '')
    .replace(/Chrome\/[\d.]+/gi, chromeVersionToken)
    .replace(/\s+/g, ' ')
    .trim();
  navigator.platform = FORCED_WINDOWS_PLATFORM;
  navigator.language = 'en-US';
  navigator.languages = ['en-US', 'en'];

  if (navigator.userAgentData) {
    const brands = buildChromeBrands(chromeMajorVersion);
    navigator.userAgentData.brands = brands;
    navigator.userAgentData.fullVersionList = brands.map((entry) => ({
      ...entry,
      version: chromeVersion,
    }));
    navigator.userAgentData.uaFullVersion = chromeVersion;
    navigator.userAgentData.platform = 'Windows';
    navigator.userAgentData.platformVersion = FORCED_WINDOWS_PLATFORM_VERSION;
    navigator.userAgentData.mobile = false;
    navigator.userAgentData.architecture = 'x86';
    navigator.userAgentData.bitness = '64';
    navigator.userAgentData.model = '';
  }

  const synchronizedHeaders = {
    ...toHeaderRecord(synchronized.headers),
    'User-Agent': navigator.userAgent,
    'Accept-Language': FORCED_LANGUAGE,
  };

  synchronized.headers = synchronizedHeaders;
  return synchronized;
}

function buildProfileFromFingerprint(synchronizedBundle, chromeVersion, chromeMajorVersion) {
  const navigator = synchronizedBundle.fingerprint.navigator;
  const userAgentMetadata = navigator.userAgentData || {};
  const brands = Array.isArray(userAgentMetadata.brands)
    ? userAgentMetadata.brands
    : buildChromeBrands(chromeMajorVersion);
  const fullVersionList = Array.isArray(userAgentMetadata.fullVersionList)
    ? userAgentMetadata.fullVersionList
    : brands.map((entry) => ({ ...entry, version: chromeVersion }));

  const secChUa = buildSecChUa(brands);
  const headers = {
    ...toHeaderRecord(synchronizedBundle.headers),
    'User-Agent': navigator.userAgent,
    'Accept-Language': FORCED_LANGUAGE,
    'Cache-Control': 'max-age=0',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-CH-UA': secChUa,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-CH-UA-Platform-Version': `"${FORCED_WINDOWS_PLATFORM_VERSION}"`,
    'Sec-CH-UA-Full-Version': `"${chromeVersion}"`,
  };

  return {
    userAgent: navigator.userAgent,
    language: FORCED_LANGUAGE,
    secChUa,
    chromeVersion,
    chromeMajorVersion,
    headers,
    userAgentMetadata: {
      brands,
      fullVersion: chromeVersion,
      fullVersionList,
      platform: 'Windows',
      platformVersion: FORCED_WINDOWS_PLATFORM_VERSION,
      architecture: userAgentMetadata.architecture || 'x86',
      model: userAgentMetadata.model || '',
      mobile: false,
      bitness: userAgentMetadata.bitness || '64',
      wow64: false,
    },
  };
}

async function getPageCdp(page) {
  let cdp = pageCdps.get(page);
  if (!cdp) {
    cdp = await page.target().createCDPSession();
    pageCdps.set(page, cdp);
  }
  return cdp;
}

async function ensureStreamCorsInjection(page, profile) {
  if (hardenedPages.has(page)) {
    return;
  }

  // Stream CORS patching is OPT-IN because it forces credentials:include and
  // mode:cors on any request containing .m3u8/.ts/stream/playlist/manifest.
  // Most video CDNs reject credentialed CORS (no ACAO: * + ACAC: true) so the
  // patch actively breaks playback on sites like FreeShot. Only turn it on
  // for sites you know require it via OWC_ENABLE_STREAM_CORS_PATCH=true.
  const streamCorsEnabled = String(process.env.OWC_ENABLE_STREAM_CORS_PATCH || 'false')
    .trim()
    .toLowerCase();
  if (streamCorsEnabled !== 'true' && streamCorsEnabled !== '1' && streamCorsEnabled !== 'yes') {
    hardenedPages.add(page);
    return;
  }

  const streamHeaders = {
    originHeader: 'Origin',
    refererHeader: 'Referer',
    secFetchDest: 'empty',
    secFetchMode: 'cors',
    secFetchSite: 'same-origin',
    secChUa: profile.secChUa,
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
    secChUaFullVersion: `"${profile.chromeVersion}"`,
  };

  await page.evaluateOnNewDocument((headerTemplate) => {
    // Use a Symbol-based flag so there is no enumerable/string global that
    // anti-bot scripts can scan for.
    const flagKey = Symbol.for('__stream_cors_patched__');
    if (globalThis[flagKey]) {
      return;
    }
    Object.defineProperty(globalThis, flagKey, { value: true, writable: false });

    const streamPattern = /(\.m3u8|\.mpd|\.m4s|\.ts)(\?|$)|manifest|playlist|stream/i;
    const isStreamUrl = (candidate) => {
      if (!candidate) return false;
      return streamPattern.test(String(candidate));
    };

    const patchHeaders = (headers, locationLike) => {
      if (!headers.has(headerTemplate.originHeader)) {
        headers.set(headerTemplate.originHeader, locationLike.origin);
      }
      if (!headers.has(headerTemplate.refererHeader)) {
        headers.set(headerTemplate.refererHeader, locationLike.href);
      }

      headers.set('Sec-Fetch-Dest', headerTemplate.secFetchDest);
      headers.set('Sec-Fetch-Mode', headerTemplate.secFetchMode);
      headers.set('Sec-Fetch-Site', headerTemplate.secFetchSite);
      headers.set('Sec-CH-UA', headerTemplate.secChUa);
      headers.set('Sec-CH-UA-Mobile', headerTemplate.secChUaMobile);
      headers.set('Sec-CH-UA-Platform', headerTemplate.secChUaPlatform);
      headers.set('Sec-CH-UA-Full-Version', headerTemplate.secChUaFullVersion);
      if (!headers.has('Accept')) {
        headers.set('Accept', '*/*');
      }
      return headers;
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const requestUrl = typeof input === 'string' ? input : input?.url;
      if (!isStreamUrl(requestUrl)) {
        return originalFetch(input, init);
      }

      const baseHeaders = init?.headers || (input instanceof Request ? input.headers : undefined);
      const headers = patchHeaders(new Headers(baseHeaders), window.location);
      return originalFetch(input, {
        ...init,
        mode: init?.mode || 'cors',
        credentials: init?.credentials || 'include',
        headers,
      });
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
      this.__owcStreamUrl = String(url || '');
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function send(body) {
      if (isStreamUrl(this.__owcStreamUrl)) {
        try {
          this.withCredentials = true;
          this.setRequestHeader(headerTemplate.originHeader, window.location.origin);
          this.setRequestHeader(headerTemplate.refererHeader, window.location.href);
          this.setRequestHeader('Sec-Fetch-Dest', headerTemplate.secFetchDest);
          this.setRequestHeader('Sec-Fetch-Mode', headerTemplate.secFetchMode);
          this.setRequestHeader('Sec-Fetch-Site', headerTemplate.secFetchSite);
          this.setRequestHeader('Sec-CH-UA', headerTemplate.secChUa);
          this.setRequestHeader('Sec-CH-UA-Mobile', headerTemplate.secChUaMobile);
          this.setRequestHeader('Sec-CH-UA-Platform', headerTemplate.secChUaPlatform);
          this.setRequestHeader('Sec-CH-UA-Full-Version', headerTemplate.secChUaFullVersion);
        } catch {
          // Best effort: browsers can reject restricted request headers.
        }
      }

      return originalSend.call(this, body);
    };
  }, streamHeaders);

  hardenedPages.add(page);
}

async function getFingerprintSuite() {
  if (!fingerprintSuitePromise) {
    fingerprintSuitePromise = (async () => {
      const chromeVersion = await resolveLatestStableChromeVersion();
      const chromeMajorVersion = getChromeMajorVersion(chromeVersion);
      const fingerprintGenerator = new FingerprintGenerator();

      return {
        chromeVersion,
        chromeMajorVersion,
        fingerprintGenerator,
        fingerprintInjector: new FingerprintInjector(),
      };
    })();
  }

  return fingerprintSuitePromise;
}

async function applyFingerprint(page) {
  if (configuredPageFingerprints.has(page)) return;

  try {
    const suite = await getFingerprintSuite();
    const generated = generateFingerprintBundle(
      suite.fingerprintGenerator,
      suite.chromeMajorVersion,
    );
    const synchronized = synchronizeFingerprint(
      generated,
      suite.chromeVersion,
      suite.chromeMajorVersion,
    );
    const profile = buildProfileFromFingerprint(
      synchronized,
      suite.chromeVersion,
      suite.chromeMajorVersion,
    );

    await suite.fingerprintInjector.attachFingerprintToPuppeteer(page, synchronized);
    // Fingerprint injector can alter viewport; force exact desktop dimensions afterwards.
    await page.setViewport(FORCED_VIEWPORT);

    const cdp = await getPageCdp(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: profile.userAgent,
      acceptLanguage: profile.language,
      platform: FORCED_WINDOWS_PLATFORM,
      userAgentMetadata: profile.userAgentMetadata,
    });
    await cdp.send('Network.setExtraHTTPHeaders', {
      headers: toCdpHeaderRecord(profile.headers),
    });

    await page.setCacheEnabled(true);
    await page.setBypassCSP(true);
    await page.setExtraHTTPHeaders(profile.headers);
    await ensureStreamCorsInjection(page, profile);

    await page.evaluateOnNewDocument((fingerprintProfile) => {
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      if (!window.chrome) {
        window.chrome = {};
      }
      if (!window.chrome.runtime) {
        window.chrome.runtime = {};
      }
      if (!window.chrome.app) {
        window.chrome.app = {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        };
      }

      const uaData = {
        brands: fingerprintProfile.userAgentMetadata.brands,
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: async () => ({
          architecture: fingerprintProfile.userAgentMetadata.architecture,
          bitness: fingerprintProfile.userAgentMetadata.bitness,
          fullVersionList: fingerprintProfile.userAgentMetadata.fullVersionList,
          model: '',
          platform: 'Windows',
          platformVersion: fingerprintProfile.userAgentMetadata.platformVersion,
          uaFullVersion: fingerprintProfile.chromeVersion,
          wow64: false,
        }),
        toJSON() {
          return {
            brands: this.brands,
            mobile: this.mobile,
            platform: this.platform,
          };
        },
      };

      if (!navigator.userAgentData) {
        Object.defineProperty(navigator, 'userAgentData', {
          get: () => uaData,
        });
      }

      const originalNavigator = Navigator.prototype;
      if (!Object.getOwnPropertyDescriptor(originalNavigator, 'userAgent')) {
        Object.defineProperty(originalNavigator, 'userAgent', {
          get: () => fingerprintProfile.userAgent,
        });
      }

      const originalSecChUa = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgentData');
      if (!originalSecChUa) {
        Object.defineProperty(Navigator.prototype, 'userAgentData', {
          get: () => ({
            brands: uaData.brands,
            mobile: uaData.mobile,
            platform: uaData.platform,
            getHighEntropyValues: uaData.getHighEntropyValues,
            toJSON: uaData.toJSON,
          }),
        });
      }

      // Autoplay helper — force videos to be muted before .play() so the
      // autoplay policy accepts them. Use a Symbol-keyed sentinel so no
      // enumerable global is exposed for bot fingerprinting.
      if (window.HTMLMediaElement && window.HTMLMediaElement.prototype) {
        const mediaProto = window.HTMLMediaElement.prototype;
        const patchedKey = Symbol.for('__media_autoplay_patched__');
        if (!mediaProto[patchedKey]) {
          Object.defineProperty(mediaProto, patchedKey, {
            value: true,
            configurable: false,
            enumerable: false,
            writable: false,
          });

          const originalPlay = mediaProto.play;
          mediaProto.play = function play(...args) {
            this.muted = this.muted || this.autoplay;
            return originalPlay.apply(this, args);
          };
        }
      }
    }, {
      userAgent: profile.userAgent,
      userAgentMetadata: profile.userAgentMetadata,
      chromeVersion: profile.chromeVersion,
      chromeMajorVersion: profile.chromeMajorVersion,
      secChUa: profile.secChUa,
    });
  } catch (error) {
    // Best-effort hardening only; do not fail tool calls on fingerprint setup.
    const debugFingerprint = String(process.env.OWC_DEBUG_FINGERPRINT || '').trim().toLowerCase();
    if (debugFingerprint === '1' || debugFingerprint === 'true' || debugFingerprint === 'yes') {
      console.warn('[owc] fingerprint hardening skipped:', error?.message || error);
    }
  }

  configuredPageFingerprints.add(page);
}

/**
 * Connect to an existing browser by WebSocket endpoint.
 */
export async function connectBrowser(wsEndpoint = WS_ENDPOINT) {
  return puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: FORCED_VIEWPORT,
  });
}

/**
 * Launch an isolated browser for one MCP session.
 */
export async function launchEphemeralBrowser(sessionId) {
  const safeSessionId = String(sessionId || 'session').replace(/[^a-zA-Z0-9_-]/g, '_');
  const userDataDir = path.join(os.tmpdir(), `owc-browser-${safeSessionId}-${Date.now()}`);
  const browser = await puppeteer.launch({
    executablePath: EXECUTABLE_PATH,
    headless: 'new',
    defaultViewport: FORCED_VIEWPORT,
    userDataDir,
    args: DEFAULT_LAUNCH_ARGS,
  });

  return {
    browser,
    wsEndpoint: browser.wsEndpoint(),
    userDataDir,
  };
}

/**
 * Close an isolated browser and remove its temporary profile directory.
 */
export async function closeEphemeralBrowser(session) {
  if (!session) return;

  try {
    if (session.browser) {
      await session.browser.close();
    }
  } finally {
    if (session.userDataDir) {
      await fs.rm(session.userDataDir, { recursive: true, force: true });
    }
  }
}

/**
 * Get the active page (reuse blank page or open a new one).
 */
export async function getPage(browser) {
  const pages = await browser.pages();
  // Prefer the most recently active navigated page over blank placeholders.
  // Blank pages are opened by Puppeteer at launch and by previous tool calls,
  // but after navigate() the browser holds the real destination — use it.
  const navigated = pages.filter((p) => p.url() !== 'about:blank' && p.url() !== 'about:newtab');
  const page = navigated[navigated.length - 1]
    ?? pages.find((p) => p.url() === 'about:blank')
    ?? await browser.newPage();

  // applyFingerprint internally enforces FORCED_VIEWPORT after injector runs.
  // We set it once more here as the single authoritative enforcement point so
  // every tool that calls getPage() is guaranteed 1920×1080 regardless of
  // whether the fingerprint step was skipped (already applied) or threw.
  await applyFingerprint(page);
  await page.setViewport(FORCED_VIEWPORT);

  await page.setCacheEnabled(true);
  await page.setBypassCSP(true);
  await enableBlocking(page);
  return page;
}
