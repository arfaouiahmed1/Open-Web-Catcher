/**
 * shared/browser.js - Playwright browser helpers.
 *
 * Public API matches the Puppeteer version so tool files work unchanged:
 *   connectBrowser(wsEndpoint)       → { browser, context }
 *   launchEphemeralBrowser(sessionId) → { browser, context, userDataDir }
 *   closeEphemeralBrowser(session)
 *   getPage(session, { targetUrl, forceRotateFingerprint })  → Page
 *   getPageNetworkDiagnostics(page, { limit })
 *   getIframeDiagnostics(page, { limit })
 *   retryNavigationAfterAutoRecovery(page, { url, waitUntil, timeoutMs })
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FingerprintGenerator } from 'fingerprint-generator';
import { FingerprintInjector } from 'fingerprint-injector';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { attachAdBlocker } from './adblocker.js';

const stealthPlugin = StealthPlugin();
// fingerprint-injector controls userAgent — stealth's override contradicts it.
stealthPlugin.enabledEvasions.delete('user-agent-override');
// fingerprint-injector handles navigator.plugins already.
stealthPlugin.enabledEvasions.delete('navigator.plugins');
chromium.use(stealthPlugin);

const WS_ENDPOINT = process.env.BROWSER_WS_ENDPOINT || 'ws://127.0.0.1:9223';
const EXECUTABLE_PATH =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/usr/local/bin/google-chrome-stable';
const CHROME_VERSION_API_URL =
  process.env.OWC_CHROME_VERSION_API_URL ||
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const CHROME_VERSION_FALLBACK = String(process.env.OWC_CHROME_VERSION_FALLBACK || '146.0.0.0').trim();
const CHROME_VERSION_TIMEOUT_MS = Number.parseInt(
  String(process.env.OWC_CHROME_VERSION_FETCH_TIMEOUT_MS || '6000'),
  10,
);
const BROWSER_LAUNCH_TIMEOUT_MS = Number.parseInt(
  String(process.env.OWC_BROWSER_LAUNCH_TIMEOUT_MS || '45000'),
  10,
);
const FORCED_VIEWPORT = { width: 1920, height: 1080 };
const FORCED_WINDOWS_PLATFORM = 'Win32';
const FORCED_WINDOWS_PLATFORM_VERSION = '10.0.0';
const FORCED_LANGUAGE = 'en-US,en;q=0.9';
const FINGERPRINT_ROTATION_MODE = String(process.env.OWC_FINGERPRINT_ROTATION_MODE || 'origin')
  .trim()
  .toLowerCase();
const FINGERPRINT_ROTATION_INTERVAL_MS = Number.parseInt(
  String(process.env.OWC_FINGERPRINT_ROTATION_INTERVAL_MS || '180000'),
  10,
);
const FINGERPRINT_ROTATION_MAX_USES = Number.parseInt(
  String(process.env.OWC_FINGERPRINT_ROTATION_MAX_USES || '6'),
  10,
);
const FINGERPRINT_RECENT_POOL_SIZE = Number.parseInt(
  String(process.env.OWC_FINGERPRINT_RECENT_POOL_SIZE || '12'),
  10,
);
const ADBLOCK_AUTO_RECOVERY_ENABLED = parseBoolean(
  process.env.OWC_ADBLOCK_AUTO_RECOVERY_ENABLED,
  true,
);
const ADBLOCK_AUTO_RECOVERY_ON_ABORT = parseBoolean(
  process.env.OWC_ADBLOCK_AUTO_RECOVERY_ON_ABORT,
  true,
);
const ADBLOCK_AUTO_RECOVERY_RETRY_ENABLED = parseBoolean(
  process.env.OWC_ADBLOCK_AUTO_RECOVERY_RETRY,
  true,
);
const STREAM_CORS_INCLUDE_CREDENTIALS = parseBoolean(
  process.env.OWC_STREAM_CORS_INCLUDE_CREDENTIALS,
  false,
);

// Playwright: no uBOL extension — adblock done via context.route() in adblocker.js

const DEFAULT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--remote-allow-origins=*',

  // ── Window / viewport ───────────────────────────────────────────────────────
  `--window-size=${FORCED_VIEWPORT.width},${FORCED_VIEWPORT.height}`,
  '--window-position=0,0',
  '--force-device-scale-factor=1',

  // ── Anti-bot ────────────────────────────────────────────────────────────────
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--hide-crash-restore-bubble',
  '--exclude-switches=enable-automation',

  // ── GPU / video decode ───────────────────────────────────────────────────────
  '--use-gl=swiftshader',
  '--use-angle=swiftshader-webgl',
  '--enable-webgl',
  '--ignore-gpu-blocklist',

  // ── Media / autoplay ────────────────────────────────────────────────────────
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream',
  '--mute-audio',
  // NOTE: IsolateOrigins and site-per-process intentionally omitted — they
  // break cross-origin iframe auth flows that video player embeds depend on.
  '--disable-features=UseChromeOSDirectVideoDecoder',
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

// Per-page state stored in WeakMaps (garbage collected with the page)
const pageFingerprintState = new WeakMap();
const pageCdps = new WeakMap();
const pageNetworkState = new WeakMap();
const pageNetworkListeners = new WeakSet();
const recentlyUsedFingerprintSignatures = [];
let chromeVersionPromise = null;
let fingerprintSuitePromise = null;

// ---------------------------------------------------------------------------
// Utility helpers (identical to Puppeteer version)
// ---------------------------------------------------------------------------

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
  const timeoutMs = Number.isFinite(CHROME_VERSION_TIMEOUT_MS) ? CHROME_VERSION_TIMEOUT_MS : 6000;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`Chrome version endpoint returned HTTP ${response.status}`);
  }
  return response.json();
}

async function resolveLatestStableChromeVersion() {
  const explicitVersion = String(process.env.OWC_CHROME_VERSION || '').trim();
  if (explicitVersion) return explicitVersion;

  if (!chromeVersionPromise) {
    chromeVersionPromise = (async () => {
      try {
        const payload = await fetchJson(CHROME_VERSION_API_URL);
        const stableVersion = payload?.channels?.Stable?.version;
        if (stableVersion && /^\d+\.\d+\.\d+\.\d+$/.test(stableVersion)) return stableVersion;
      } catch { /* fall through */ }

      try {
        const fallbackPayload = await fetchJson(
          'https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions?page_size=1',
        );
        const versionName = fallbackPayload?.versions?.[0]?.name || '';
        const extracted = String(versionName).match(/\d+\.\d+\.\d+\.\d+/)?.[0];
        if (extracted) return extracted;
      } catch { /* fall through */ }

      return CHROME_VERSION_FALLBACK;
    })();
  }

  return chromeVersionPromise;
}

function parseBoolean(value, defaultValue = false) {
  if (value == null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function clampPositiveInteger(value, fallback) {
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

function normalizeRotationMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (['off', 'none', 'false', '0', 'never'].includes(normalized)) return 'never';
  if (['page', 'always'].includes(normalized)) return 'page';
  if (['origin', 'domain', 'site'].includes(normalized)) return 'origin';
  if (['interval', 'time'].includes(normalized)) return 'interval';
  return 'origin';
}

function getOriginFromUrl(urlLike) {
  const input = String(urlLike || '').trim();
  if (!input || input === 'about:blank' || input === 'about:newtab') return '';
  try { return new URL(input).origin; } catch { return ''; }
}

function getFingerprintSignature(bundle) {
  const navigator = bundle?.fingerprint?.navigator || {};
  const userAgentData = navigator.userAgentData || {};
  const brandToken = Array.isArray(userAgentData.fullVersionList)
    ? userAgentData.fullVersionList.map((e) => `${e.brand}/${e.version}`).join('|')
    : Array.isArray(userAgentData.brands)
      ? userAgentData.brands.map((e) => `${e.brand}/${e.version}`).join('|')
      : '';
  return [navigator.userAgent || '', navigator.platform || '', navigator.language || '', brandToken].join('::');
}

function rememberFingerprintSignature(signature) {
  if (!signature) return;
  recentlyUsedFingerprintSignatures.push(signature);
  const poolSize = clampPositiveInteger(FINGERPRINT_RECENT_POOL_SIZE, 12);
  while (recentlyUsedFingerprintSignatures.length > poolSize) {
    recentlyUsedFingerprintSignatures.shift();
  }
}

function shouldRotateFingerprint(state, page, targetUrl, forceRotate) {
  if (forceRotate || !state) return true;
  const rotationMode = normalizeRotationMode(FINGERPRINT_ROTATION_MODE);
  if (rotationMode === 'never') return false;
  if (rotationMode === 'page') return true;
  const now = Date.now();
  const maxUses = clampPositiveInteger(FINGERPRINT_ROTATION_MAX_USES, 6);
  const intervalMs = clampPositiveInteger(FINGERPRINT_ROTATION_INTERVAL_MS, 180000);
  if (maxUses > 0 && state.useCount >= maxUses) return true;
  if (intervalMs > 0 && (now - state.appliedAt) >= intervalMs) return true;
  if (rotationMode === 'origin') {
    const expectedOrigin = getOriginFromUrl(targetUrl) || getOriginFromUrl(page.url());
    if (expectedOrigin && state.origin && expectedOrigin !== state.origin) return true;
  }
  return false;
}

function toHeaderRecord(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    output[String(key)] = String(value);
  }
  return output;
}

function normalizeFailureText(value) {
  return String(value || '').trim().toLowerCase();
}

function isLikelyIframeOrPlayerRequest({ url = '', resourceType = '' } = {}) {
  const normalizedUrl = String(url || '').toLowerCase();
  const normalizedType = String(resourceType || '').toLowerCase();
  if (['sub_frame', 'media'].includes(normalizedType)) return true;
  if (/(\.m3u8|\.mpd|\.m4s|\.ts)(\?|$)|player|embed|stream|playlist|manifest|video/.test(normalizedUrl)) return true;
  return false;
}

function summarizeNetworkFailures(failures = []) {
  const summary = {
    total: failures.length,
    blocked_by_client: 0,
    aborted: 0,
    iframe_or_player_related: 0,
    by_resource_type: {},
  };
  for (const failure of failures) {
    const resourceType = String(failure.resource_type || 'other');
    summary.by_resource_type[resourceType] = (summary.by_resource_type[resourceType] || 0) + 1;
    if (failure.blocked_by_client) summary.blocked_by_client += 1;
    if (failure.aborted) summary.aborted += 1;
    if (failure.iframe_or_player_related) summary.iframe_or_player_related += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Network diagnostics (adapted for Playwright request API)
// ---------------------------------------------------------------------------

function getNetworkState(page) {
  let state = pageNetworkState.get(page);
  if (!state) {
    state = {
      failures: [],
      failuresLimit: 120,
      autoRecovery: {
        attempted: false,
        disabled_blocking: false,
        retried_navigation: false,
        retry_succeeded: false,
        reason: '',
        error: null,
        disable_promise: null,
      },
    };
    pageNetworkState.set(page, state);
  }
  return state;
}

function recordRequestFailure(page, request) {
  const state = getNetworkState(page);
  const failureText = normalizeFailureText(request.failure() || '');
  const url = request.url() || '';
  const resourceType = request.resourceType() || 'other';
  const failure = {
    timestamp: Date.now(),
    url,
    method: request.method() || 'GET',
    resource_type: resourceType,
    frame_url: request.frame()?.url() || '',
    error_text: failureText,
    blocked_by_client: failureText.includes('blocked_by_client') || failureText.includes('blockedbyclient'),
    aborted: failureText.includes('aborted'),
    iframe_or_player_related: isLikelyIframeOrPlayerRequest({ url, resourceType }),
  };
  state.failures.push(failure);
  while (state.failures.length > state.failuresLimit) state.failures.shift();
  return failure;
}

// In Playwright, disableBlocking on a page means updating the context route handler.
// We keep a per-page flag and the context route aborts nothing when disabled.
const pageBlockingDisabled = new WeakSet();

async function disableBlockingForPage(page) {
  try {
    pageBlockingDisabled.add(page);
    return true;
  } catch { return false; }
}

function attachNetworkDiagnostics(page) {
  if (pageNetworkListeners.has(page)) return;
  pageNetworkListeners.add(page);

  page.on('requestfailed', (request) => {
    const failure = recordRequestFailure(page, request);
    const state = getNetworkState(page);

    if (!ADBLOCK_AUTO_RECOVERY_ENABLED || state.autoRecovery.attempted) return;

    const recoverableFailure = failure.iframe_or_player_related
      && (failure.blocked_by_client || (ADBLOCK_AUTO_RECOVERY_ON_ABORT && failure.aborted));

    if (!recoverableFailure) return;

    state.autoRecovery.attempted = true;
    state.autoRecovery.reason = failure.blocked_by_client
      ? 'blocked_by_client_iframe_or_player_request'
      : 'aborted_iframe_or_player_request';

    state.autoRecovery.disable_promise = disableBlockingForPage(page)
      .then(async (disabled) => {
        state.autoRecovery.disabled_blocking = Boolean(disabled);
        if (disabled) {
          // Reload so the player can make its requests now that blocking is off.
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        }
      })
      .catch((error) => {
        state.autoRecovery.error = error?.message || String(error);
      })
      .finally(() => {
        state.autoRecovery.disable_promise = null;
      });
  });
}

export function getPageNetworkDiagnostics(page, { limit = 30 } = {}) {
  const state = getNetworkState(page);
  const cappedFailures = state.failures.slice(-Math.max(1, Number.parseInt(String(limit || 30), 10) || 30));
  const { disable_promise, ...publicRecovery } = state.autoRecovery;
  return {
    request_failures: cappedFailures,
    request_failure_summary: summarizeNetworkFailures(cappedFailures),
    auto_recovery: { ...publicRecovery },
  };
}

export async function getIframeDiagnostics(page, { limit = 24 } = {}) {
  const normalizedLimit = Math.max(1, Number.parseInt(String(limit || 24), 10) || 24);
  const rows = await page.mainFrame().evaluate((innerLimit) => {
    const toSafeOrigin = (candidate) => {
      try { return new URL(candidate, window.location.href).origin; } catch { return ''; }
    };
    const classify = (iframe) => {
      const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
      const sandbox = (iframe.getAttribute('sandbox') || '').trim();
      const allow = (iframe.getAttribute('allow') || '').trim();
      const rect = iframe.getBoundingClientRect();
      const sandboxTokens = sandbox ? sandbox.split(/\s+/).map((t) => t.trim()).filter(Boolean) : [];
      const sourceOrigin = toSafeOrigin(src);
      const crossOrigin = Boolean(sourceOrigin && sourceOrigin !== window.location.origin);
      const iframeLikePlayer = /(player|embed|stream|video|watch)/i.test(`${src} ${iframe.id || ''} ${iframe.className || ''}`)
        || (rect.width >= 280 && rect.height >= 160);
      const sandboxLikelyRestrictive = sandboxTokens.length > 0
        && (!sandboxTokens.includes('allow-scripts') || !sandboxTokens.includes('allow-same-origin'));
      return {
        src, origin: sourceOrigin, cross_origin: crossOrigin, sandbox, sandbox_tokens: sandboxTokens,
        allow, width: Math.round(rect.width), height: Math.round(rect.height),
        visible: rect.width > 0 && rect.height > 0, likely_player: iframeLikePlayer,
        restrictive_sandbox: sandboxLikelyRestrictive,
      };
    };
    return Array.from(document.querySelectorAll('iframe')).slice(0, innerLimit).map(classify);
  }, normalizedLimit).catch(() => []);

  return {
    total: rows.length,
    cross_origin_count: rows.filter((r) => r.cross_origin).length,
    restrictive_sandbox_count: rows.filter((r) => r.restrictive_sandbox).length,
    likely_player_count: rows.filter((r) => r.likely_player).length,
    iframes: rows,
  };
}

export async function retryNavigationAfterAutoRecovery(page, {
  url,
  waitUntil = 'networkidle',
  timeoutMs = 30000,
} = {}) {
  const state = getNetworkState(page);
  if (state.autoRecovery.disable_promise) {
    await state.autoRecovery.disable_promise.catch(() => {});
  }

  if (!ADBLOCK_AUTO_RECOVERY_RETRY_ENABLED) {
    return { attempted: false, reason: 'auto_recovery_retry_disabled' };
  }
  if (!state.autoRecovery.disabled_blocking) {
    return { attempted: false, reason: 'blocking_not_disabled' };
  }
  if (state.autoRecovery.retried_navigation) {
    return { attempted: false, reason: 'retry_already_attempted' };
  }

  state.autoRecovery.retried_navigation = true;
  const targetUrl = String(url || '').trim() || page.url();
  try {
    await page.goto(targetUrl, { waitUntil, timeout: timeoutMs });
    state.autoRecovery.retry_succeeded = true;
    return { attempted: true, succeeded: true, wait_until: waitUntil, target_url: targetUrl };
  } catch (error) {
    state.autoRecovery.retry_succeeded = false;
    state.autoRecovery.error = error?.message || String(error);
    return {
      attempted: true, succeeded: false, wait_until: waitUntil, target_url: targetUrl,
      error: state.autoRecovery.error,
    };
  }
}

// ---------------------------------------------------------------------------
// CDP helper (Playwright: async, page-scoped)
// ---------------------------------------------------------------------------

export async function getPageCdp(page) {
  let cdp = pageCdps.get(page);
  if (!cdp) {
    cdp = await page.context().newCDPSession(page);
    pageCdps.set(page, cdp);
  }
  return cdp;
}

// ---------------------------------------------------------------------------
// Fingerprinting helpers
// ---------------------------------------------------------------------------

function buildFingerprintConstraints(chromeMajorVersion) {
  const browserConstraints = [];
  if (chromeMajorVersion) {
    const major = Number(chromeMajorVersion);
    if (Number.isFinite(major) && major > 0) {
      browserConstraints.push({ name: 'chrome', minVersion: major, maxVersion: major });
    }
  }
  if (!browserConstraints.length) browserConstraints.push({ name: 'chrome' });
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
  if (!Number.isFinite(parsedMajor) || parsedMajor <= 0) return [null];
  const candidates = [parsedMajor];
  for (let offset = 1; offset <= 12; offset += 1) {
    const candidate = parsedMajor - offset;
    if (candidate >= 120) candidates.push(candidate);
  }
  candidates.push(null);
  return candidates;
}

function generateFingerprintBundle(generator, chromeMajorVersion) {
  const majorCandidates = buildFingerprintMajorCandidates(chromeMajorVersion);
  let lastError = null;
  for (const majorCandidate of majorCandidates) {
    try { return generator.getFingerprint(buildFingerprintConstraints(majorCandidate)); }
    catch (error) { lastError = error; }
  }
  if (lastError) throw lastError;
  throw new Error('Failed to generate a browser fingerprint.');
}

function synchronizeFingerprint(fingerprintBundle, chromeVersion, chromeMajorVersion) {
  const synchronized = structuredClone(fingerprintBundle);
  const navigator = synchronized?.fingerprint?.navigator;
  if (!navigator) return synchronized;

  const chromeVersionToken = `Chrome/${chromeVersion}`;
  navigator.userAgent = String(navigator.userAgent || '')
    .replace(/Chrome\/[\d.]+/gi, chromeVersionToken).replace(/\s+/g, ' ').trim();
  navigator.appVersion = String(navigator.appVersion || '')
    .replace(/Chrome\/[\d.]+/gi, chromeVersionToken).replace(/\s+/g, ' ').trim();
  navigator.platform = FORCED_WINDOWS_PLATFORM;
  navigator.language = 'en-US';
  navigator.languages = ['en-US', 'en'];

  if (navigator.userAgentData) {
    const brands = buildChromeBrands(chromeMajorVersion);
    navigator.userAgentData.brands = brands;
    navigator.userAgentData.fullVersionList = brands.map((e) => ({ ...e, version: chromeVersion }));
    navigator.userAgentData.uaFullVersion = chromeVersion;
    navigator.userAgentData.platform = 'Windows';
    navigator.userAgentData.platformVersion = FORCED_WINDOWS_PLATFORM_VERSION;
    navigator.userAgentData.mobile = false;
    navigator.userAgentData.architecture = 'x86';
    navigator.userAgentData.bitness = '64';
    navigator.userAgentData.model = '';
  }

  synchronized.headers = {
    ...toHeaderRecord(synchronized.headers),
    'User-Agent': navigator.userAgent,
    'Accept-Language': FORCED_LANGUAGE,
  };
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
    : brands.map((e) => ({ ...e, version: chromeVersion }));
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

function generateRotatingFingerprintBundle(generator, chromeVersion, chromeMajorVersion) {
  const attempts = Math.max(4, clampPositiveInteger(FINGERPRINT_RECENT_POOL_SIZE, 12));
  let selected = null;
  let selectedSignature = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const generated = generateFingerprintBundle(generator, chromeMajorVersion);
    const synchronized = synchronizeFingerprint(generated, chromeVersion, chromeMajorVersion);
    const signature = getFingerprintSignature(synchronized);
    if (!recentlyUsedFingerprintSignatures.includes(signature)) {
      rememberFingerprintSignature(signature);
      return synchronized;
    }
    if (!selected) { selected = synchronized; selectedSignature = signature; }
  }
  if (selected) { rememberFingerprintSignature(selectedSignature); return selected; }
  const generated = generateFingerprintBundle(generator, chromeMajorVersion);
  const synchronized = synchronizeFingerprint(generated, chromeVersion, chromeMajorVersion);
  rememberFingerprintSignature(getFingerprintSignature(synchronized));
  return synchronized;
}

async function getFingerprintSuite() {
  if (!fingerprintSuitePromise) {
    fingerprintSuitePromise = (async () => {
      const chromeVersion = await resolveLatestStableChromeVersion();
      const chromeMajorVersion = getChromeMajorVersion(chromeVersion);
      return {
        chromeVersion,
        chromeMajorVersion,
        fingerprintGenerator: new FingerprintGenerator(),
        fingerprintInjector: new FingerprintInjector(),
      };
    })();
  }
  return fingerprintSuitePromise;
}

// ---------------------------------------------------------------------------
// Playwright-specific init scripts (equivalent of evaluateOnNewDocument)
// ---------------------------------------------------------------------------

const runtimeFingerprintPatchFn = (fingerprintProfile) => {
  const profileKey = Symbol.for('__owc_fingerprint_profile__');
  globalThis[profileKey] = fingerprintProfile;
  const readProfile = () => globalThis[profileKey] || fingerprintProfile;

  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};
  if (!window.chrome.app) {
    window.chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    };
  }

  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'Win32' });
  Object.defineProperty(Navigator.prototype, 'language', { configurable: true, get: () => 'en-US' });
  Object.defineProperty(Navigator.prototype, 'languages', { configurable: true, get: () => ['en-US', 'en'] });
  Object.defineProperty(Navigator.prototype, 'userAgent', { configurable: true, get: () => readProfile().userAgent });
  Object.defineProperty(Navigator.prototype, 'userAgentData', {
    configurable: true,
    get: () => {
      const profile = readProfile();
      const metadata = profile.userAgentMetadata;
      return {
        brands: metadata.brands,
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: async () => ({
          architecture: metadata.architecture,
          bitness: metadata.bitness,
          fullVersionList: metadata.fullVersionList,
          model: '',
          platform: 'Windows',
          platformVersion: metadata.platformVersion,
          uaFullVersion: profile.chromeVersion,
          wow64: false,
        }),
        toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
      };
    },
  });

  // Autoplay helper
  if (window.HTMLMediaElement?.prototype) {
    const mediaProto = window.HTMLMediaElement.prototype;
    const patchedKey = Symbol.for('__media_autoplay_patched__');
    if (!mediaProto[patchedKey]) {
      Object.defineProperty(mediaProto, patchedKey, { value: true, configurable: false, enumerable: false, writable: false });
      const originalPlay = mediaProto.play;
      mediaProto.play = function play(...args) {
        this.muted = this.muted || this.autoplay;
        return originalPlay.apply(this, args);
      };
    }
  }
};

const patchIframeSandboxFn = () => {
  const patchKey = Symbol.for('__owc_iframe_sandbox_patch__');
  if (globalThis[patchKey]) return;
  Object.defineProperty(globalThis, patchKey, { value: true, writable: false });

  const requiredSandboxTokens = [
    'allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups',
    'allow-popups-to-escape-sandbox', 'allow-presentation', 'allow-modals',
  ];
  const requiredAllowTokens = ['autoplay', 'fullscreen', 'encrypted-media', 'picture-in-picture'];

  const isLikelyPlayerIframe = (iframe) => {
    const rect = iframe.getBoundingClientRect();
    const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
    return /(player|embed|stream|video|watch|live)/.test(`${src} ${iframe.id || ''} ${iframe.name || ''} ${iframe.className || ''}`.toLowerCase())
      || (rect.width >= 280 && rect.height >= 160);
  };

  const patchIframe = (iframe) => {
    if (!(iframe instanceof HTMLIFrameElement) || !isLikelyPlayerIframe(iframe)) return;
    const sandboxAttr = (iframe.getAttribute('sandbox') || '').trim();
    if (sandboxAttr) {
      const tokens = new Set(sandboxAttr.split(/\s+/).map((t) => t.trim()).filter(Boolean));
      let changed = false;
      for (const token of requiredSandboxTokens) { if (!tokens.has(token)) { tokens.add(token); changed = true; } }
      if (changed) iframe.setAttribute('sandbox', Array.from(tokens).join(' '));
    }
    const allowTokens = new Set((iframe.getAttribute('allow') || '').split(/[;\s]+/).map((t) => t.trim()).filter(Boolean));
    let changedAllow = false;
    for (const token of requiredAllowTokens) { if (!allowTokens.has(token)) { allowTokens.add(token); changedAllow = true; } }
    if (changedAllow) iframe.setAttribute('allow', Array.from(allowTokens).join('; '));
  };

  for (const iframe of document.querySelectorAll('iframe')) patchIframe(iframe);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') { patchIframe(mutation.target); continue; }
      for (const node of mutation.addedNodes || []) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLIFrameElement) patchIframe(node);
        for (const iframe of node.querySelectorAll?.('iframe') || []) patchIframe(iframe);
      }
    }
  });
  observer.observe(document.documentElement || document, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['sandbox', 'allow', 'src', 'data-src', 'class', 'id', 'name'],
  });
};

// ---------------------------------------------------------------------------
// Context-level fingerprint application (Playwright approach)
// ---------------------------------------------------------------------------

async function createFingerprintedContext(browser, profile, synchronizedBundle) {
  const suite = await getFingerprintSuite();

  const context = await browser.newContext({
    viewport: FORCED_VIEWPORT,
    userAgent: profile.userAgent,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: profile.headers,
    bypassCSP: true,
    colorScheme: 'dark',
  });

  // Apply fingerprint at context level (affects all pages including cross-origin iframes)
  try {
    await suite.fingerprintInjector.attachFingerprintToPlaywright(context, synchronizedBundle);
  } catch (err) {
    console.warn('[owc-pw] fingerprint injection skipped:', err?.message || err);
  }

  // Runtime JS patches via addInitScript (= evaluateOnNewDocument but context-scoped)
  await context.addInitScript(runtimeFingerprintPatchFn, {
    userAgent: profile.userAgent,
    userAgentMetadata: profile.userAgentMetadata,
    chromeVersion: profile.chromeVersion,
    chromeMajorVersion: profile.chromeMajorVersion,
    secChUa: profile.secChUa,
  });

  await context.addInitScript(patchIframeSandboxFn);

  // Remove Playwright-specific globals that some sites check
  await context.addInitScript(() => {
    try { delete window.__playwright; } catch { /* ignore */ }
    try { delete window.__pw_manual; } catch { /* ignore */ }
  });

  // Apply route-based ad blocking
  await attachAdBlocker(context, { pageBlockingDisabled });

  return context;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Connect to an existing browser by WebSocket endpoint (CDP).
 * Returns { browser, context } session object.
 */
export async function connectBrowser(wsEndpoint = WS_ENDPOINT) {
  const browser = await chromium.connectOverCDP(wsEndpoint);
  let context = browser.contexts()[0];
  if (!context) {
    const suite = await getFingerprintSuite();
    const synchronized = generateRotatingFingerprintBundle(
      suite.fingerprintGenerator, suite.chromeVersion, suite.chromeMajorVersion,
    );
    const profile = buildProfileFromFingerprint(synchronized, suite.chromeVersion, suite.chromeMajorVersion);
    context = await createFingerprintedContext(browser, profile, synchronized);
  }
  return { browser, context, userDataDir: null };
}

/**
 * Launch an isolated browser for one MCP session.
 * Returns { browser, context, userDataDir }.
 */
export async function launchEphemeralBrowser(sessionId) {
  const safeSessionId = String(sessionId || 'session').replace(/[^a-zA-Z0-9_-]/g, '_');
  const userDataDir = path.join(os.tmpdir(), `owc-pw-${safeSessionId}-${Date.now()}`);
  const launchTimeout = Number.isFinite(BROWSER_LAUNCH_TIMEOUT_MS) ? Math.max(0, BROWSER_LAUNCH_TIMEOUT_MS) : 45000;

  const browser = await chromium.launch({
    executablePath: EXECUTABLE_PATH,
    headless: true,
    timeout: launchTimeout,
    args: DEFAULT_LAUNCH_ARGS,
  });

  const suite = await getFingerprintSuite();
  const synchronized = generateRotatingFingerprintBundle(
    suite.fingerprintGenerator, suite.chromeVersion, suite.chromeMajorVersion,
  );
  const profile = buildProfileFromFingerprint(synchronized, suite.chromeVersion, suite.chromeMajorVersion);
  const context = await createFingerprintedContext(browser, profile, synchronized);

  return { browser, context, userDataDir };
}

/**
 * Close an isolated browser and remove its temporary profile directory.
 */
export async function closeEphemeralBrowser(session) {
  if (!session) return;
  try {
    if (session.browser) await session.browser.close();
  } finally {
    if (session.userDataDir) {
      await fs.rm(session.userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Get the active page from the session context.
 * In Playwright, pages are per-context; we pick the most recently navigated one.
 */
export async function getPage(session, {
  targetUrl = '',
  forceRotateFingerprint = false,
} = {}) {
  // Accept either a raw context or a { browser, context } session object
  const context = session?.context ?? session;

  const pages = context.pages();
  const navigated = pages.filter((p) => p.url() !== 'about:blank' && p.url() !== 'about:newtab');
  const page = navigated[navigated.length - 1]
    ?? pages.find((p) => p.url() === 'about:blank')
    ?? await context.newPage();

  // Enforce viewport (context setting may be overridden by some sites)
  await page.setViewportSize(FORCED_VIEWPORT);
  attachNetworkDiagnostics(page);

  // Apply iframe sandbox patch to the live page as well (addInitScript covers future pages)
  await page.evaluate(patchIframeSandboxFn).catch(() => {});

  return page;
}
