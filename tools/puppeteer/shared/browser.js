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
import {
  describeProxyCandidate,
  getProxyCandidatePlan,
  markProxyFailure,
  markProxySuccess,
  normalizeProxyRuntimeConfig,
  shouldAllowSharedBrowserFallback,
} from '../../shared/proxy-pool.js';
import {
  classifyChromeError,
  classifyIframeFailure,
  extractChromeNetErrorCode,
} from '../../shared/error-codes.js';
import { computeBrowserPolicy } from '../../shared/browser-policy.js';
import { disableBlocking, enableBlocking } from './adblocker.js';
import { getBrowserRuntimeSettings, getEffectiveRuntimeMetadata } from './runtime-config.js';

const puppeteer = addExtra(puppeteerCore);
const stealthPlugin = StealthPlugin();
// Keep UA + client hints fully aligned with our explicit profile rotation.
stealthPlugin.enabledEvasions.delete('user-agent-override');
// fingerprint-injector handles navigator.plugins already; stealth's version contradicts it.
stealthPlugin.enabledEvasions.delete('navigator.plugins');
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
const FORCED_VIEWPORT_OPTIONS = { ...FORCED_VIEWPORT, deviceScaleFactor: 2 };
const FORCED_WINDOWS_PLATFORM = 'Win32';
const FORCED_WINDOWS_PLATFORM_VERSION = '10.0.0';
const FORCED_LANGUAGE = 'en-US,en;q=0.9';
const UBOL_EXTENSION_DIR = String(process.env.OWC_UBOL_EXTENSION_DIR || '/app/tools/puppeteer/extensions/ubol').trim();
const DEFAULT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',

  // ── Window / viewport ───────────────────────────────────────────────────────
  // Modern headless mode does NOT honour defaultViewport alone for rendering — the
  // actual paint buffer is taken from the OS window size. Set it explicitly
  // so layout, media queries, and video players all render at 1920×1080.
  `--window-size=${FORCED_VIEWPORT.width},${FORCED_VIEWPORT.height}`,
  '--window-position=0,0',
  '--force-device-scale-factor=2',

  // ── Anti-bot ────────────────────────────────────────────────────────────────

  // ── GPU / video decode ───────────────────────────────────────────────────────
  // Do NOT use --disable-gpu — it kills video frame compositing.
  // Software rasterisation still decodes H.264/AAC when running real Chrome.
  '--use-gl=swiftshader',
  '--use-angle=swiftshader-webgl',
  '--enable-webgl',

  // ── Media / autoplay ────────────────────────────────────────────────────────
  '--autoplay-policy=no-user-gesture-required',
  // Keep the software video decoder path; do NOT try hardware on Linux headless.
  // NOTE: IsolateOrigins and site-per-process intentionally omitted — disabling them
  // broke cross-origin iframe auth flows that video player embeds depend on.
  '--disable-features=UseChromeOSDirectVideoDecoder',

  // ── Stability ────────────────────────────────────────────────────────────────
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

const pageFingerprintState = new WeakMap();
const pageCdps = new WeakMap();
const pageNetworkState = new WeakMap();
const pagePolicyState = new WeakMap();
const pageNetworkListeners = new WeakSet();
const pagePreparationPromises = new WeakMap();
const pagePopupGuardsInstalled = new WeakSet();
const recentlyUsedFingerprintSignatures = [];
let chromeVersionPromise = null;
const fingerprintSuiteCache = new Map();
const launchedSessionMetadata = new Map();
const browserProxyMetadata = new WeakMap();
const browserPageLifecycleInstalled = new WeakSet();

function runtimeSetting(key) {
  return getBrowserRuntimeSettings('puppeteer')?.[key];
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function parseChromeVersionCandidate(value) {
  const match = String(value || '').match(/(\d+\.\d+\.\d+\.\d+)/);
  return match?.[1] || '';
}

async function resolveEffectiveChromeVersion(browser = null) {
  const explicitVersion = String(process.env.OWC_CHROME_VERSION || '').trim();
  if (explicitVersion) {
    return explicitVersion;
  }

  try {
    const detectedVersion = parseChromeVersionCandidate(await browser?.version?.());
    if (detectedVersion) {
      return detectedVersion;
    }
  } catch {
    // Fall back to official version sources below.
  }

  return resolveLatestStableChromeVersion();
}

function parseBoolean(value, defaultValue = false) {
  if (value == null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function getBrowserLaunchTimeoutMs() {
  return Number.parseInt(
    String(runtimeSetting('launch_timeout_ms') ?? process.env.OWC_BROWSER_LAUNCH_TIMEOUT_MS ?? '45000'),
    10,
  );
}

function getUbolEnabled() {
  return parseBoolean(runtimeSetting('ubol_enabled') ?? process.env.OWC_UBOL_ENABLED, true);
}

function getFingerprintRotationMode() {
  return String(runtimeSetting('fingerprint_rotation_mode') ?? process.env.OWC_FINGERPRINT_ROTATION_MODE ?? 'origin')
    .trim()
    .toLowerCase();
}

function getFingerprintRotationIntervalMs() {
  return Number.parseInt(
    String(runtimeSetting('fingerprint_rotation_interval_ms') ?? process.env.OWC_FINGERPRINT_ROTATION_INTERVAL_MS ?? '180000'),
    10,
  );
}

function getFingerprintRotationMaxUses() {
  return Number.parseInt(
    String(runtimeSetting('fingerprint_rotation_max_uses') ?? process.env.OWC_FINGERPRINT_ROTATION_MAX_USES ?? '6'),
    10,
  );
}

function getFingerprintRecentPoolSize() {
  return Number.parseInt(
    String(runtimeSetting('fingerprint_recent_pool_size') ?? process.env.OWC_FINGERPRINT_RECENT_POOL_SIZE ?? '12'),
    10,
  );
}

function getFingerprintFallbackStrategy() {
  return String(runtimeSetting('fingerprint_fallback_strategy') ?? process.env.OWC_FINGERPRINT_FALLBACK_STRATEGY ?? 'profile')
    .trim()
    .toLowerCase();
}

function getAdblockAutoRecoveryEnabled() {
  return parseBoolean(
    runtimeSetting('adblock_auto_recovery_enabled') ?? process.env.OWC_ADBLOCK_AUTO_RECOVERY_ENABLED,
    true,
  );
}

function getAdblockAutoRecoveryRetryEnabled() {
  return parseBoolean(
    runtimeSetting('adblock_auto_recovery_retry') ?? process.env.OWC_ADBLOCK_AUTO_RECOVERY_RETRY,
    true,
  );
}

function getStreamCorsPatchEnabled() {
  return parseBoolean(
    runtimeSetting('stream_cors_patch_enabled') ?? process.env.OWC_ENABLE_STREAM_CORS_PATCH,
    false,
  );
}

function getStreamCorsIncludeCredentials() {
  return parseBoolean(
    runtimeSetting('stream_cors_include_credentials') ?? process.env.OWC_STREAM_CORS_INCLUDE_CREDENTIALS,
    false,
  );
}

function getIframeSandboxPatchEnabled() {
  return parseBoolean(
    runtimeSetting('iframe_sandbox_patch_enabled') ?? process.env.OWC_IFRAME_SANDBOX_PATCH,
    true,
  );
}

function getIframeAutoRecoveryEnabled() {
  return parseBoolean(
    runtimeSetting('iframe_auto_recovery_enabled') ?? process.env.OWC_IFRAME_AUTO_RECOVERY_ENABLED,
    true,
  );
}

function getIframeRecoveryTimeoutMs() {
  return Number.parseInt(
    String(runtimeSetting('iframe_recovery_timeout_ms') ?? process.env.OWC_IFRAME_RECOVERY_TIMEOUT_MS ?? '20000'),
    10,
  );
}

function getPopupBlockingEnabled() {
  return parseBoolean(
    runtimeSetting('popup_blocking_enabled') ?? process.env.OWC_POPUP_BLOCKING_ENABLED,
    true,
  );
}

function getExtraLaunchArgs() {
  const configured = runtimeSetting('extra_launch_args');
  if (!Array.isArray(configured)) {
    return [];
  }
  return configured.map((item) => String(item || '').trim()).filter(Boolean);
}

function getProxyRuntimeConfig() {
  return normalizeProxyRuntimeConfig(getBrowserRuntimeSettings('puppeteer') || {});
}

function getRuntimeSettings() {
  return getBrowserRuntimeSettings('puppeteer') || {};
}

function buildEffectivePolicy({
  browserProfile = '',
  targetUrl = '',
  currentUrl = '',
  sharedConnection = false,
  iframeUrls = [],
  playerHints = [],
} = {}) {
  return computeBrowserPolicy({
    browserId: 'puppeteer',
    browserProfile,
    runtimeSettings: getRuntimeSettings(),
    targetUrl,
    currentUrl,
    iframeUrls,
    playerHints,
    sharedConnection,
  });
}

function setPageEffectivePolicy(page, policy) {
  pagePolicyState.set(page, policy);
  const state = getNetworkState(page);
  state.effectivePolicy = policy;
  state.effectiveRuntime = getEffectiveRuntimeMetadata('puppeteer');
}

export function getPageEffectivePolicy(page) {
  return pagePolicyState.get(page) || null;
}

export function getPageEffectiveRuntime(page) {
  const state = getNetworkState(page);
  return state.effectiveRuntime || getEffectiveRuntimeMetadata('puppeteer');
}

function clampPositiveInteger(value, fallback) {
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function normalizeRotationMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (['off', 'none', 'false', '0', 'never'].includes(normalized)) {
    return 'never';
  }
  if (['page', 'always'].includes(normalized)) {
    return 'page';
  }
  if (['origin', 'domain', 'site'].includes(normalized)) {
    return 'origin';
  }
  if (['interval', 'time'].includes(normalized)) {
    return 'interval';
  }
  return 'origin';
}

function getOriginFromUrl(urlLike) {
  const input = String(urlLike || '').trim();
  if (!input || input === 'about:blank' || input === 'about:newtab') {
    return '';
  }

  try {
    return new URL(input).origin;
  } catch {
    return '';
  }
}

function getFingerprintSignature(bundle) {
  const navigator = bundle?.fingerprint?.navigator || {};
  const userAgentData = navigator.userAgentData || {};
  const brandToken = Array.isArray(userAgentData.fullVersionList)
    ? userAgentData.fullVersionList.map((entry) => `${entry.brand}/${entry.version}`).join('|')
    : Array.isArray(userAgentData.brands)
      ? userAgentData.brands.map((entry) => `${entry.brand}/${entry.version}`).join('|')
      : '';

  return [
    navigator.userAgent || '',
    navigator.platform || '',
    navigator.language || '',
    brandToken,
  ].join('::');
}

function rememberFingerprintSignature(signature) {
  if (!signature) return;

  recentlyUsedFingerprintSignatures.push(signature);
  const poolSize = clampPositiveInteger(getFingerprintRecentPoolSize(), 12);
  while (recentlyUsedFingerprintSignatures.length > poolSize) {
    recentlyUsedFingerprintSignatures.shift();
  }
}

function shouldRotateFingerprint(state, page, targetUrl, forceRotate) {
  if (forceRotate) {
    return true;
  }

  if (!state) {
    return true;
  }

  const rotationMode = normalizeRotationMode(getFingerprintRotationMode());
  if (rotationMode === 'never') {
    return false;
  }

  if (rotationMode === 'page') {
    return true;
  }

  const now = Date.now();
  const maxUses = clampPositiveInteger(getFingerprintRotationMaxUses(), 6);
  const intervalMs = clampPositiveInteger(getFingerprintRotationIntervalMs(), 180000);
  if (maxUses > 0 && state.useCount >= maxUses) {
    return true;
  }
  if (intervalMs > 0 && (now - state.appliedAt) >= intervalMs) {
    return true;
  }

  if (rotationMode === 'origin') {
    const expectedOrigin = getOriginFromUrl(targetUrl) || getOriginFromUrl(page.url());
    if (expectedOrigin && state.origin && expectedOrigin !== state.origin) {
      return true;
    }
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

function toCdpHeaderRecord(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    output[String(key).toLowerCase()] = String(value);
  }
  return output;
}

function normalizeFailureText(value) {
  return String(value || '').trim().toLowerCase();
}

function isLikelyIframeOrPlayerRequest({ url = '', resourceType = '' } = {}) {
  const normalizedUrl = String(url || '').toLowerCase();
  const normalizedType = String(resourceType || '').toLowerCase();

  if (['sub_frame', 'media'].includes(normalizedType)) {
    return true;
  }

  if (/(\.m3u8|\.mpd|\.m4s|\.ts)(\?|$)|player|embed|stream|playlist|manifest|video/.test(normalizedUrl)) {
    return true;
  }

  return false;
}

function summarizeNetworkFailures(failures = []) {
  const summary = {
    total: failures.length,
    blocked_by_client: 0,
    aborted: 0,
    iframe_or_player_related: 0,
    by_resource_type: {},
    by_error_code: {},
    transient_error_count: 0,
    limited_error_count: 0,
    permanent_error_count: 0,
    unknown_error_count: 0,
  };

  for (const failure of failures) {
    const resourceType = String(failure.resource_type || 'other');
    summary.by_resource_type[resourceType] = (summary.by_resource_type[resourceType] || 0) + 1;
    const errorCode = String(failure.error_code || '').trim();
    if (errorCode) {
      summary.by_error_code[errorCode] = (summary.by_error_code[errorCode] || 0) + 1;
    }
    if (failure.blocked_by_client) summary.blocked_by_client += 1;
    if (failure.aborted) summary.aborted += 1;
    if (failure.iframe_or_player_related) summary.iframe_or_player_related += 1;
    if (failure.error_category === 'transient') summary.transient_error_count += 1;
    else if (failure.error_category === 'limited') summary.limited_error_count += 1;
    else if (failure.error_category === 'permanent') summary.permanent_error_count += 1;
    else summary.unknown_error_count += 1;
  }

  return summary;
}

function getNetworkState(page) {
  let state = pageNetworkState.get(page);
  if (!state) {
    state = {
      failures: [],
      failuresLimit: 120,
      effectivePolicy: null,
      effectiveRuntime: null,
      autoRecovery: {
        attempted: false,
        disabled_blocking: false,
        retried_navigation: false,
        retry_succeeded: false,
        reason: '',
        error: null,
        disable_promise: null,
      },
      iframeRecovery: {
        attempted: false,
        detection_reason: '',
        patches_applied: [],
        final_error: null,
        recovery_attempts: 0,
        success: false,
        unrecoverable: false,
        pending_promise: null,
      },
    };
    pageNetworkState.set(page, state);
  }
  return state;
}

function recordRequestFailure(page, request) {
  const state = getNetworkState(page);
  const failureText = normalizeFailureText(request.failure?.()?.errorText || '');
  const url = request.url?.() || '';
  const resourceType = request.resourceType?.() || 'other';
  const errorCode = extractChromeNetErrorCode(failureText);
  const chromeError = classifyChromeError({ message: failureText, url });
  const failure = {
    timestamp: Date.now(),
    url,
    method: request.method?.() || 'GET',
    resource_type: resourceType,
    frame_url: request.frame?.()?.url?.() || '',
    error_text: failureText,
    error_code: errorCode || chromeError.error_code,
    error_category: chromeError.error_category,
    blocked_by_client: failureText.includes('blocked_by_client') || failureText.includes('blockedbyclient'),
    aborted: failureText.includes('aborted'),
    iframe_or_player_related: isLikelyIframeOrPlayerRequest({ url, resourceType }),
  };
  const iframeFailure = classifyIframeFailure({
    errorText: failureText,
    errorCode: failure.error_code,
    resourceType,
    blockedByClient: failure.blocked_by_client,
    aborted: failure.aborted,
  });
  failure.iframe_failure_reason = iframeFailure.detection_reason;
  failure.iframe_recoverable = iframeFailure.recoverable;

  state.failures.push(failure);
  while (state.failures.length > state.failuresLimit) {
    state.failures.shift();
  }

  return failure;
}

async function performIframeRecovery(page, failure) {
  const state = getNetworkState(page);
  const recovery = state.iframeRecovery;
  const timeoutMs = Math.max(5000, getIframeRecoveryTimeoutMs() || 20000);

  recovery.attempted = true;
  recovery.detection_reason = failure.iframe_failure_reason || '';
  recovery.patches_applied = [];
  recovery.final_error = null;
  recovery.recovery_attempts += 1;
  recovery.success = false;
  recovery.unrecoverable = false;

  try {
    if (recovery.detection_reason === 'x_frame_options' || recovery.detection_reason === 'csp') {
      recovery.unrecoverable = true;
      recovery.final_error = recovery.detection_reason === 'csp'
        ? 'unrecoverable_content_security_policy'
        : 'unrecoverable_x_frame_options';
      return;
    }

    if (recovery.detection_reason === 'sandbox') {
      recovery.patches_applied.push('relax_sandbox');
      await ensureIframeSandboxPatch(page);
      recovery.patches_applied.push('reload_with_retry');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
      recovery.success = true;
      return;
    }

    if (recovery.detection_reason === 'cors') {
      const disabled = await disableBlocking(page);
      recovery.patches_applied.push(disabled ? 'disable_blocking' : 'blocking_already_disabled');
      recovery.patches_applied.push('reload_with_retry');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
      recovery.success = true;
      return;
    }

    if (recovery.detection_reason === 'network') {
      recovery.patches_applied.push('reload_with_retry');
      await wait(1000);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
      recovery.success = true;
      return;
    }

    recovery.final_error = 'no_recovery_strategy';
  } catch (error) {
    recovery.final_error = error?.message || String(error);
  }
}

function attachNetworkDiagnostics(page) {
  if (pageNetworkListeners.has(page)) {
    return;
  }
  pageNetworkListeners.add(page);

  page.on('requestfailed', (request) => {
    const failure = recordRequestFailure(page, request);
    const state = getNetworkState(page);

    if (getAdblockAutoRecoveryEnabled() && !state.autoRecovery.attempted) {
      const recoverableFailure = failure.iframe_or_player_related
        && failure.blocked_by_client;

      if (recoverableFailure) {
        state.autoRecovery.attempted = true;
        state.autoRecovery.reason = failure.blocked_by_client
          ? 'blocked_by_client_iframe_or_player_request'
          : 'aborted_iframe_or_player_request';

        state.autoRecovery.disable_promise = disableBlocking(page)
          .then(async (disabled) => {
            state.autoRecovery.disabled_blocking = Boolean(disabled);
            if (disabled) {
              // Reload so the player can make its requests now that the blocker is off.
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            }
          })
          .catch((error) => {
            state.autoRecovery.error = error?.message || String(error);
          })
          .finally(() => {
            state.autoRecovery.disable_promise = null;
          });
      }
    }

    if (!getIframeAutoRecoveryEnabled() || state.iframeRecovery.attempted || !failure.iframe_failure_reason) {
      return;
    }
    if (failure.iframe_failure_reason === 'adblock') {
      return;
    }

    state.iframeRecovery.pending_promise = performIframeRecovery(page, failure)
      .finally(() => {
        state.iframeRecovery.pending_promise = null;
      });
  });
}

function buildCriticalResourceFailures(failures = []) {
  const buckets = new Map();
  const normalized = Array.isArray(failures) ? failures : [];
  const classifyFailure = (failure) => {
    const url = String(failure?.url || '').toLowerCase();
    const resourceType = String(failure?.resource_type || '').toLowerCase();
    if (/\.m3u8(?:$|[?#])|\.mpd(?:$|[?#])|manifest|playlist/.test(url) || resourceType === 'media') return 'manifest_media';
    if (resourceType === 'script') return 'script';
    if (resourceType === 'stylesheet') return 'stylesheet';
    if (resourceType === 'font') return 'font';
    if (resourceType === 'sub_frame') return 'sub_frame';
    return '';
  };

  for (const failure of normalized) {
    const kind = classifyFailure(failure);
    if (!kind || buckets.has(kind)) continue;
    buckets.set(kind, {
      kind,
      url: failure.url || '',
      host: (() => {
        try {
          return new URL(failure.url || '').hostname;
        } catch {
          return '';
        }
      })(),
      resource_type: failure.resource_type || '',
      http_status: failure.http_status || null,
      error: failure.error_text || '',
      error_code: failure.error_code || '',
      error_category: failure.error_category || '',
      blocked_by_client: Boolean(failure.blocked_by_client),
      frame_url: failure.frame_url || '',
      status_text: failure.status_text || '',
    });
  }

  return Array.from(buckets.values());
}

function buildRenderGapSignals(failures = []) {
  const normalized = Array.isArray(failures) ? failures : [];
  const byType = (type) => normalized.filter((failure) => failure?.resource_type === type);
  const blockedFailures = normalized.filter((failure) => failure?.blocked_by_client);
  const manifestFailure = buildCriticalResourceFailures(normalized).find((failure) => failure.kind === 'manifest_media') || null;

  return {
    failed_script_count: byType('script').length,
    failed_stylesheet_count: byType('stylesheet').length,
    failed_font_count: byType('font').length,
    failed_subframe_count: byType('sub_frame').length,
    blocked_by_client_total: blockedFailures.length,
    blocked_by_client_by_type: blockedFailures.reduce((acc, failure) => {
      const key = failure.resource_type || 'other';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    missing_player_supporting_assets: Boolean(
      byType('script').some((failure) => /(player|videojs|jwplayer|hls)/i.test(`${failure.url || ''} ${failure.frame_url || ''}`))
      || byType('stylesheet').length > 0
      || byType('font').length > 0
      || Boolean(manifestFailure),
    ),
    overlay_gate_possible: false,
  };
}

export function getPageNetworkDiagnostics(page, { limit = 10 } = {}) {
  const state = getNetworkState(page);
  const cappedFailures = state.failures.slice(-Math.max(1, Number.parseInt(String(limit || 10), 10) || 10));
  const summary = summarizeNetworkFailures(cappedFailures);
  const { disable_promise, ...publicRecovery } = state.autoRecovery;
  const { pending_promise, ...publicIframeRecovery } = state.iframeRecovery;
  const critical_resource_failures = buildCriticalResourceFailures(state.failures);
  const render_gap_signals = buildRenderGapSignals(state.failures);
  const manifest_failure = critical_resource_failures.find((failure) => failure.kind === 'manifest_media') || null;

  return {
    request_failures: cappedFailures,
    request_failure_summary: summary,
    failures_by_error_code: summary.by_error_code,
    transient_error_count: summary.transient_error_count,
    limited_error_count: summary.limited_error_count,
    permanent_error_count: summary.permanent_error_count,
    unknown_error_count: summary.unknown_error_count,
    auto_recovery: {
      ...publicRecovery,
    },
    iframe_recovery_attempted: Boolean(publicIframeRecovery.attempted),
    iframe_recovery_reason: publicIframeRecovery.detection_reason || '',
    iframe_recovery_success: Boolean(publicIframeRecovery.success),
    iframe_recovery: {
      ...publicIframeRecovery,
    },
    effective_policy: state.effectivePolicy || null,
    effective_runtime: state.effectiveRuntime || getEffectiveRuntimeMetadata('puppeteer'),
    critical_resource_failures,
    render_gap_signals,
    manifest_failure,
  };
}

export async function getIframeDiagnostics(page, { limit = 24 } = {}) {
  const normalizedLimit = Math.max(1, Number.parseInt(String(limit || 24), 10) || 24);
  const rows = await page.mainFrame().evaluate((innerLimit) => {
    const toSafeOrigin = (candidate) => {
      try {
        return new URL(candidate, window.location.href).origin;
      } catch {
        return '';
      }
    };

    const classify = (iframe) => {
      const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
      const sandbox = (iframe.getAttribute('sandbox') || '').trim();
      const allow = (iframe.getAttribute('allow') || '').trim();
      const rect = iframe.getBoundingClientRect();
      const sandboxTokens = sandbox
        ? sandbox.split(/\s+/).map((token) => token.trim()).filter(Boolean)
        : [];

      const sourceOrigin = toSafeOrigin(src);
      const crossOrigin = Boolean(sourceOrigin && sourceOrigin !== window.location.origin);
      const iframeLikePlayer = /(player|embed|stream|video|watch)/i.test(`${src} ${iframe.id || ''} ${iframe.className || ''}`)
        || (rect.width >= 280 && rect.height >= 160);
      const sandboxLikelyRestrictive = sandboxTokens.length > 0
        && (!sandboxTokens.includes('allow-scripts') || !sandboxTokens.includes('allow-same-origin'));

      return {
        src,
        origin: sourceOrigin,
        cross_origin: crossOrigin,
        sandbox,
        sandbox_tokens: sandboxTokens,
        allow,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: rect.width > 0 && rect.height > 0,
        likely_player: iframeLikePlayer,
        restrictive_sandbox: sandboxLikelyRestrictive,
      };
    };

    return Array.from(document.querySelectorAll('iframe')).slice(0, innerLimit).map(classify);
  }, normalizedLimit).catch(() => []);
  const state = getNetworkState(page);
  const recovery = state.iframeRecovery;
  const restrictiveSandboxFailedCount = state.failures
    .filter((failure) => failure.iframe_failure_reason === 'sandbox')
    .length;

  return {
    total: rows.length,
    cross_origin_count: rows.filter((row) => row.cross_origin).length,
    restrictive_sandbox_count: rows.filter((row) => row.restrictive_sandbox).length,
    restrictive_sandbox_failed_count: restrictiveSandboxFailedCount,
    likely_player_count: rows.filter((row) => row.likely_player).length,
    recovery_attempted: Boolean(recovery.attempted),
    recovery_reason: recovery.detection_reason || '',
    recovery_patches: [...(recovery.patches_applied || [])],
    recovery_success: Boolean(recovery.success),
    recovery_error: recovery.final_error,
    iframes: rows,
  };
}

export async function retryNavigationAfterAutoRecovery(page, {
  url,
  waitUntil = 'networkidle2',
  timeoutMs = 30000,
} = {}) {
  const state = getNetworkState(page);
  if (state.autoRecovery.disable_promise) {
    await state.autoRecovery.disable_promise.catch(() => {});
  }
  if (state.iframeRecovery.pending_promise) {
    await state.iframeRecovery.pending_promise.catch(() => {});
  }

  if (!getAdblockAutoRecoveryRetryEnabled()) {
    return {
      attempted: false,
      reason: 'auto_recovery_retry_disabled',
    };
  }

  if (!state.autoRecovery.disabled_blocking) {
    return {
      attempted: false,
      reason: 'blocking_not_disabled',
    };
  }

  if (state.autoRecovery.retried_navigation) {
    return {
      attempted: false,
      reason: 'retry_already_attempted',
    };
  }

  state.autoRecovery.retried_navigation = true;
  const targetUrl = String(url || '').trim() || page.url();
  try {
    await page.goto(targetUrl, {
      waitUntil,
      timeout: timeoutMs,
    });
    state.autoRecovery.retry_succeeded = true;
    return {
      attempted: true,
      succeeded: true,
      wait_until: waitUntil,
      target_url: targetUrl,
    };
  } catch (error) {
    state.autoRecovery.retry_succeeded = false;
    state.autoRecovery.error = error?.message || String(error);
    return {
      attempted: true,
      succeeded: false,
      wait_until: waitUntil,
      target_url: targetUrl,
      error: state.autoRecovery.error,
    };
  }
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

function generateRotatingFingerprintBundle(generator, chromeVersion, chromeMajorVersion) {
  const attempts = Math.max(4, clampPositiveInteger(getFingerprintRecentPoolSize(), 12));
  let selected = null;
  let selectedSignature = '';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const generated = generateFingerprintBundle(generator, chromeMajorVersion);
    const synchronized = synchronizeFingerprint(generated, chromeVersion, chromeMajorVersion);
    const signature = getFingerprintSignature(synchronized);
    const recentlyUsed = recentlyUsedFingerprintSignatures.includes(signature);

    if (!recentlyUsed) {
      rememberFingerprintSignature(signature);
      return synchronized;
    }

    if (!selected) {
      selected = synchronized;
      selectedSignature = signature;
    }
  }

  if (selected) {
    rememberFingerprintSignature(selectedSignature);
    return selected;
  }

  const generated = generateFingerprintBundle(generator, chromeMajorVersion);
  const synchronized = synchronizeFingerprint(generated, chromeVersion, chromeMajorVersion);
  rememberFingerprintSignature(getFingerprintSignature(synchronized));
  return synchronized;
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
  // Stream CORS patching is OPT-IN because it forces credentials:include and
  // mode:cors on any request containing .m3u8/.ts/stream/playlist/manifest.
  // Most video CDNs reject credentialed CORS (no ACAO: * + ACAC: true) so the
  // patch actively breaks playback on sites like FreeShot. Only turn it on
  // for sites you know require it via OWC_ENABLE_STREAM_CORS_PATCH=true.
  if (!getStreamCorsPatchEnabled()) {
    return;
  }

  const streamHeaders = {
    originHeader: 'Origin',
    refererHeader: 'Referer',
    secFetchDest: 'empty',
    secFetchMode: 'cors',
    secFetchSite: 'cross-site',
    includeCredentials: getStreamCorsIncludeCredentials(),
    secChUa: profile.secChUa,
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
    secChUaFullVersion: `"${profile.chromeVersion}"`,
  };

  await page.evaluateOnNewDocument((headerTemplate) => {
    // Use a Symbol-based flag so there is no enumerable/string global that
    // anti-bot scripts can scan for.
    const flagKey = Symbol.for('__stream_cors_patched__');
    const templateKey = Symbol.for('__stream_cors_template__');
    globalThis[templateKey] = headerTemplate;

    if (globalThis[flagKey]) {
      return;
    }
    Object.defineProperty(globalThis, flagKey, { value: true, writable: false });

    const streamPattern = /(\.m3u8|\.mpd|\.m4s|\.ts)(\?|$)|manifest|playlist|stream/i;
    const isStreamUrl = (candidate) => {
      if (!candidate) return false;
      return streamPattern.test(String(candidate));
    };

    const getTemplate = () => globalThis[templateKey] || headerTemplate;

    const computeFetchSite = (requestUrl, locationLike) => {
      try {
        const resolved = new URL(String(requestUrl || ''), locationLike.href);
        return resolved.origin === locationLike.origin ? 'same-origin' : 'cross-site';
      } catch {
        return 'cross-site';
      }
    };

    const patchHeaders = (headers, locationLike, requestUrl) => {
      const activeTemplate = getTemplate();
      if (!headers.has(activeTemplate.originHeader)) {
        headers.set(activeTemplate.originHeader, locationLike.origin);
      }
      if (!headers.has(activeTemplate.refererHeader)) {
        headers.set(activeTemplate.refererHeader, locationLike.href);
      }

      headers.set('Sec-Fetch-Dest', activeTemplate.secFetchDest);
      headers.set('Sec-Fetch-Mode', activeTemplate.secFetchMode);
      headers.set('Sec-Fetch-Site', computeFetchSite(requestUrl, locationLike));
      headers.set('Sec-CH-UA', activeTemplate.secChUa);
      headers.set('Sec-CH-UA-Mobile', activeTemplate.secChUaMobile);
      headers.set('Sec-CH-UA-Platform', activeTemplate.secChUaPlatform);
      headers.set('Sec-CH-UA-Full-Version', activeTemplate.secChUaFullVersion);
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
      const activeTemplate = getTemplate();
      const headers = patchHeaders(new Headers(baseHeaders), window.location, requestUrl);
      return originalFetch(input, {
        ...init,
        mode: init?.mode || 'cors',
        credentials: init?.credentials || (activeTemplate.includeCredentials ? 'include' : 'same-origin'),
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
          const activeTemplate = getTemplate();
          this.withCredentials = Boolean(activeTemplate.includeCredentials);
          this.setRequestHeader(activeTemplate.originHeader, window.location.origin);
          this.setRequestHeader(activeTemplate.refererHeader, window.location.href);
          this.setRequestHeader('Sec-Fetch-Dest', activeTemplate.secFetchDest);
          this.setRequestHeader('Sec-Fetch-Mode', activeTemplate.secFetchMode);
          this.setRequestHeader('Sec-Fetch-Site', computeFetchSite(this.__owcStreamUrl, window.location));
          this.setRequestHeader('Sec-CH-UA', activeTemplate.secChUa);
          this.setRequestHeader('Sec-CH-UA-Mobile', activeTemplate.secChUaMobile);
          this.setRequestHeader('Sec-CH-UA-Platform', activeTemplate.secChUaPlatform);
          this.setRequestHeader('Sec-CH-UA-Full-Version', activeTemplate.secChUaFullVersion);
        } catch {
          // Best effort: browsers can reject restricted request headers.
        }
      }

      return originalSend.call(this, body);
    };
  }, streamHeaders);

  await page.evaluate((headerTemplate) => {
    const templateKey = Symbol.for('__stream_cors_template__');
    globalThis[templateKey] = headerTemplate;
  }, streamHeaders).catch(() => {});
}

async function ensureIframeSandboxPatch(page) {
  if (!getIframeSandboxPatchEnabled()) {
    return;
  }

  const patchIframeSandbox = () => {
    const patchKey = Symbol.for('__owc_iframe_sandbox_patch__');
    if (globalThis[patchKey]) {
      return;
    }
    Object.defineProperty(globalThis, patchKey, { value: true, writable: false });

    const requiredSandboxTokens = [
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-presentation',
      'allow-modals',
    ];

    const requiredAllowTokens = ['autoplay', 'fullscreen', 'encrypted-media', 'picture-in-picture'];

    const isLikelyPlayerIframe = (iframe) => {
      const rect = iframe.getBoundingClientRect();
      const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
      const haystack = `${src} ${iframe.id || ''} ${iframe.name || ''} ${iframe.className || ''}`.toLowerCase();
      return /(player|embed|stream|video|watch|live)/.test(haystack)
        || (rect.width >= 280 && rect.height >= 160);
    };

    const patchIframe = (iframe) => {
      if (!(iframe instanceof HTMLIFrameElement)) {
        return;
      }
      if (!isLikelyPlayerIframe(iframe)) {
        return;
      }

      const sandboxAttr = (iframe.getAttribute('sandbox') || '').trim();
      if (sandboxAttr) {
        const tokens = new Set(sandboxAttr.split(/\s+/).map((token) => token.trim()).filter(Boolean));
        let changedSandbox = false;
        for (const token of requiredSandboxTokens) {
          if (!tokens.has(token)) {
            tokens.add(token);
            changedSandbox = true;
          }
        }
        if (changedSandbox) {
          iframe.setAttribute('sandbox', Array.from(tokens).join(' '));
        }
      }

      const allowAttr = (iframe.getAttribute('allow') || '').trim();
      const allowTokens = new Set(allowAttr.split(/[;\s]+/).map((token) => token.trim()).filter(Boolean));
      let changedAllow = false;
      for (const token of requiredAllowTokens) {
        if (!allowTokens.has(token)) {
          allowTokens.add(token);
          changedAllow = true;
        }
      }
      if (changedAllow) {
        iframe.setAttribute('allow', Array.from(allowTokens).join('; '));
      }
    };

    for (const iframe of document.querySelectorAll('iframe')) {
      patchIframe(iframe);
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          patchIframe(mutation.target);
          continue;
        }

        for (const node of mutation.addedNodes || []) {
          if (!(node instanceof Element)) {
            continue;
          }

          if (node instanceof HTMLIFrameElement) {
            patchIframe(node);
          }

          for (const iframe of node.querySelectorAll?.('iframe') || []) {
            patchIframe(iframe);
          }
        }
      }
    });

    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['sandbox', 'allow', 'src', 'data-src', 'class', 'id', 'name'],
    });
  };

  await page.evaluateOnNewDocument(patchIframeSandbox);
  await page.evaluate(patchIframeSandbox).catch(() => {});
}

async function getFingerprintSuite(browser = null) {
  const chromeVersion = await resolveEffectiveChromeVersion(browser);
  const cacheKey = chromeVersion || CHROME_VERSION_FALLBACK;

  if (!fingerprintSuiteCache.has(cacheKey)) {
    fingerprintSuiteCache.set(cacheKey, {
      chromeVersion: cacheKey,
      chromeMajorVersion: getChromeMajorVersion(cacheKey),
      fingerprintGenerator: new FingerprintGenerator(),
      fingerprintInjector: new FingerprintInjector(),
    });
  }

  return fingerprintSuiteCache.get(cacheKey);
}

function buildFallbackFingerprintProfile(chromeVersion, chromeMajorVersion) {
  const brands = buildChromeBrands(chromeMajorVersion);
  const fullVersionList = brands.map((entry) => ({ ...entry, version: chromeVersion }));
  const userAgent = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'AppleWebKit/537.36 (KHTML, like Gecko)',
    `Chrome/${chromeVersion}`,
    'Safari/537.36',
  ].join(' ');
  const secChUa = buildSecChUa(brands);

  return {
    userAgent,
    language: FORCED_LANGUAGE,
    secChUa,
    chromeVersion,
    chromeMajorVersion,
    headers: {
      'User-Agent': userAgent,
      'Accept-Language': FORCED_LANGUAGE,
      'Cache-Control': 'max-age=0',
      Pragma: 'no-cache',
      'Upgrade-Insecure-Requests': '1',
      'Sec-CH-UA': secChUa,
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-CH-UA-Platform-Version': `"${FORCED_WINDOWS_PLATFORM_VERSION}"`,
      'Sec-CH-UA-Full-Version': `"${chromeVersion}"`,
    },
    userAgentMetadata: {
      brands,
      fullVersion: chromeVersion,
      fullVersionList,
      platform: 'Windows',
      platformVersion: FORCED_WINDOWS_PLATFORM_VERSION,
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    },
  };
}

async function applyRuntimeFingerprintProfile(page, runtimeProfile) {
  const applyProfile = (fingerprintProfile) => {
    const profileKey = Symbol.for('__owc_fingerprint_profile__');
    globalThis[profileKey] = fingerprintProfile;
    const readProfile = () => globalThis[profileKey] || fingerprintProfile;

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

    Object.defineProperty(Navigator.prototype, 'platform', {
      configurable: true,
      get: () => 'Win32',
    });
    Object.defineProperty(Navigator.prototype, 'language', {
      configurable: true,
      get: () => 'en-US',
    });
    Object.defineProperty(Navigator.prototype, 'languages', {
      configurable: true,
      get: () => ['en-US', 'en'],
    });
    Object.defineProperty(Navigator.prototype, 'userAgent', {
      configurable: true,
      get: () => readProfile().userAgent,
    });

    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      configurable: true,
      get: () => {
        const profile = readProfile();
        const metadata = profile.userAgentMetadata;
        const uaData = {
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
          toJSON() {
            return {
              brands: this.brands,
              mobile: this.mobile,
              platform: this.platform,
            };
          },
        };
        return uaData;
      },
    });

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
  };

  await page.evaluateOnNewDocument(applyProfile, runtimeProfile);
  await page.evaluate(applyProfile, runtimeProfile).catch(() => {});
}

async function applyFingerprintProfileToPage(page, profile) {
  await page.setViewport(FORCED_VIEWPORT_OPTIONS);

  await page.setUserAgent({
    userAgent: profile.userAgent,
    userAgentMetadata: profile.userAgentMetadata,
    platform: FORCED_WINDOWS_PLATFORM,
  });

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
  await page.setExtraHTTPHeaders(profile.headers);
  await ensureStreamCorsInjection(page, profile);
  await applyRuntimeFingerprintProfile(page, {
    userAgent: profile.userAgent,
    userAgentMetadata: profile.userAgentMetadata,
    chromeVersion: profile.chromeVersion,
    chromeMajorVersion: profile.chromeMajorVersion,
    secChUa: profile.secChUa,
  });
}

function rememberPageFingerprintState(page, targetUrl, profile) {
  pageFingerprintState.set(page, {
    useCount: 1,
    appliedAt: Date.now(),
    lastUsedAt: Date.now(),
    origin: getOriginFromUrl(targetUrl) || getOriginFromUrl(page.url()),
    userAgent: profile.userAgent,
  });
}

async function applyProxyAuthentication(page) {
  const metadata = browserProxyMetadata.get(page.browser()) || null;
  const proxy = metadata?.proxy || null;
  if (!proxy || (!proxy.username && !proxy.password)) {
    return;
  }

  await page.authenticate({
    username: proxy.username || '',
    password: proxy.password || '',
  });
}

async function applyFingerprint(page, { targetUrl = '', forceRotate = false } = {}) {
  const state = pageFingerprintState.get(page) || null;
  if (!shouldRotateFingerprint(state, page, targetUrl, forceRotate) && state) {
    pageFingerprintState.set(page, {
      ...state,
      useCount: state.useCount + 1,
      lastUsedAt: Date.now(),
    });
    return;
  }

  let suite = null;
  try {
    suite = await getFingerprintSuite(page.browser());
    const synchronized = generateRotatingFingerprintBundle(
      suite.fingerprintGenerator,
      suite.chromeVersion,
      suite.chromeMajorVersion,
    );
    const profile = buildProfileFromFingerprint(
      synchronized,
      suite.chromeVersion,
      suite.chromeMajorVersion,
    );

    await suite.fingerprintInjector.attachFingerprintToPuppeteer(page, synchronized);
    await applyFingerprintProfileToPage(page, profile);
    rememberPageFingerprintState(page, targetUrl, profile);
  } catch (error) {
    const debugFingerprint = String(process.env.OWC_DEBUG_FINGERPRINT || '').trim().toLowerCase();
    const fallbackStrategy = getFingerprintFallbackStrategy();
    const fallbackEnabled = fallbackStrategy === 'profile';

    if (fallbackEnabled) {
      try {
        suite = suite || await getFingerprintSuite(page.browser());
        const fallbackProfile = buildFallbackFingerprintProfile(
          suite.chromeVersion,
          suite.chromeMajorVersion,
        );
        await applyFingerprintProfileToPage(page, fallbackProfile);
        rememberPageFingerprintState(page, targetUrl, fallbackProfile);
        if (debugFingerprint === '1' || debugFingerprint === 'true' || debugFingerprint === 'yes') {
          console.warn('[owc] fingerprint injector fallback applied:', error?.message || error);
        }
        return;
      } catch (fallbackError) {
        if (debugFingerprint === '1' || debugFingerprint === 'true' || debugFingerprint === 'yes') {
          console.warn(
            '[owc] fingerprint hardening skipped:',
            `${error?.message || error}; fallback failed: ${fallbackError?.message || fallbackError}`,
          );
        }
      }
    } else if (debugFingerprint === '1' || debugFingerprint === 'true' || debugFingerprint === 'yes') {
      console.warn('[owc] fingerprint hardening skipped:', error?.message || error);
    }

    if (state) {
      pageFingerprintState.set(page, {
        ...state,
        useCount: state.useCount + 1,
        lastUsedAt: Date.now(),
      });
    }
  }
}

async function enforceWindowBounds(browser, page) {
  if (!browser || !page) return;

  if (typeof page.windowId !== 'function' || typeof browser.setWindowBounds !== 'function') {
    return;
  }

  try {
    const windowId = await page.windowId();
    await browser.setWindowBounds(windowId, {
      left: 0,
      top: 0,
      width: FORCED_VIEWPORT.width,
      height: FORCED_VIEWPORT.height,
      windowState: 'normal',
    });
  } catch {
    // Best effort: remote providers may not expose window management.
  }
}

async function installPopupGuards(page) {
  if (!getPopupBlockingEnabled() || !page || pagePopupGuardsInstalled.has(page)) {
    return;
  }

  pagePopupGuardsInstalled.add(page);
  page.on('dialog', (dialog) => {
    dialog.dismiss().catch(() => {});
  });

  await page.evaluateOnNewDocument(() => {
    const blockerKey = Symbol.for('__owc_popup_blocker__');
    if (globalThis[blockerKey]) {
      return;
    }
    Object.defineProperty(globalThis, blockerKey, { value: true, writable: false });

    const noopOpen = () => null;
    try {
      Object.defineProperty(window, 'open', {
        configurable: true,
        writable: false,
        value: noopOpen,
      });
    } catch {
      try {
        window.open = noopOpen;
      } catch {
        // ignore
      }
    }
  });

  await page.evaluate(() => {
    const noopOpen = () => null;
    try {
      window.open = noopOpen;
    } catch {
      // ignore
    }
  }).catch(() => {});
}

async function preparePageForAutomation(browser, page, {
  targetUrl = '',
  forceRotateFingerprint = false,
  browserProfile = '',
  bestEffort = false,
} = {}) {
  const existing = pagePreparationPromises.get(page);
  if (existing) {
    await existing;
  }

  const preparation = (async () => {
    const browserMetadata = browserProxyMetadata.get(browser) || {};
    const effectiveProfile = browserProfile || browserMetadata.browserProfile || '';
    const currentUrl = page.url?.() || '';
    const resolvedTargetUrl = targetUrl || currentUrl;
    const effectivePolicy = buildEffectivePolicy({
      browserProfile: effectiveProfile,
      targetUrl: resolvedTargetUrl,
      currentUrl,
      sharedConnection: browserMetadata.sharedConnection !== false,
    });

    await applyProxyAuthentication(page);
    await installPopupGuards(page);
    await applyFingerprint(page, {
      targetUrl: resolvedTargetUrl,
      forceRotate: forceRotateFingerprint,
    });
    await enforceWindowBounds(browser, page);
    await page.setViewport(FORCED_VIEWPORT_OPTIONS);
    attachNetworkDiagnostics(page);
    setPageEffectivePolicy(page, effectivePolicy);
    await page.setCacheEnabled(true);

    if (effectivePolicy.cosmetic_filtering_enabled) {
      try {
        await enableBlocking(page, { targetUrl: resolvedTargetUrl });
      } catch (error) {
        const debugAdblock = String(process.env.OWC_DEBUG_ADBLOCK || '').trim().toLowerCase();
        if (debugAdblock === '1' || debugAdblock === 'true' || debugAdblock === 'yes') {
          console.warn('[owc] adblocker attach skipped:', error?.message || error);
        }
      }
    } else {
      await disableBlocking(page).catch(() => {});
    }
  })();

  pagePreparationPromises.set(page, preparation);
  try {
    if (!bestEffort) {
      await preparation;
      return;
    }

    await preparation.catch((error) => {
      const debugFingerprint = String(process.env.OWC_DEBUG_FINGERPRINT || '').trim().toLowerCase();
      const debugAdblock = String(process.env.OWC_DEBUG_ADBLOCK || '').trim().toLowerCase();
      if (debugFingerprint === '1' || debugFingerprint === 'true' || debugFingerprint === 'yes'
        || debugAdblock === '1' || debugAdblock === 'true' || debugAdblock === 'yes') {
        console.warn('[owc] background page preparation skipped:', error?.message || error);
      }
    });
  } finally {
    if (pagePreparationPromises.get(page) === preparation) {
      pagePreparationPromises.delete(page);
    }
  }
}

function installBrowserPageLifecycle(browser) {
  if (!browser || browserPageLifecycleInstalled.has(browser)) {
    return;
  }

  browserPageLifecycleInstalled.add(browser);
  browser.on('targetcreated', async (target) => {
    if (target.type?.() !== 'page') {
      return;
    }

    try {
      if (getPopupBlockingEnabled()) {
        const opener = typeof target.opener === 'function' ? target.opener() : null;
        if (opener) {
          const popup = await target.page();
          await popup?.close().catch(() => {});
          return;
        }
      }
      const page = await target.page();
      if (!page) {
        return;
      }
      await preparePageForAutomation(browser, page, { bestEffort: true });
    } catch {
      // Best effort only. getPage() still performs strict preparation later.
    }
  });

  browser.pages()
    .then((pages) => Promise.allSettled(
      pages.map((page) => preparePageForAutomation(browser, page, { bestEffort: true })),
    ))
    .catch(() => {});
}

async function launchBrowserAttempt({ launchTimeout, launchArgs, userDataDir, proxy = null } = {}) {
  const nextLaunchArgs = [...launchArgs];
  if (proxy?.server) {
    nextLaunchArgs.push(`--proxy-server=${proxy.server}`);
  }

  const browser = await puppeteer.launch({
    executablePath: EXECUTABLE_PATH,
    headless: true,
    defaultViewport: FORCED_VIEWPORT_OPTIONS,
    timeout: launchTimeout,
    waitForInitialPage: true,
    userDataDir,
    args: nextLaunchArgs,
  });

  browserProxyMetadata.set(browser, { proxy });
  installBrowserPageLifecycle(browser);
  return browser;
}

async function validateProxyConnection(browser, { testUrl, timeoutMs } = {}) {
  const pages = await browser.pages();
  const page = pages.find((candidate) => candidate.url() === 'about:blank') || pages[0] || await browser.newPage();
  await applyProxyAuthentication(page);
  const response = await page.goto(testUrl, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });
  if (!response || !response.ok()) {
    throw new Error(`Proxy validation failed for ${testUrl}`);
  }
  await page.goto('about:blank', { waitUntil: 'load', timeout: Math.min(timeoutMs, 5000) }).catch(() => {});
}

export function isSharedBrowserFallbackAllowed() {
  return shouldAllowSharedBrowserFallback(getProxyRuntimeConfig());
}

/**
 * Connect to an existing browser by WebSocket endpoint.
 */
export async function connectBrowser(wsEndpoint = WS_ENDPOINT) {
  const browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: FORCED_VIEWPORT_OPTIONS,
  });
  const metadata = launchedSessionMetadata.get(wsEndpoint);
  if (metadata) {
    browserProxyMetadata.set(browser, { ...metadata, sharedConnection: false });
  } else {
    browserProxyMetadata.set(browser, { proxy: null, browserProfile: '', launchPolicy: null, sharedConnection: true });
  }
  installBrowserPageLifecycle(browser);
  return browser;
}

/**
 * Launch an isolated browser for one MCP session.
 */
export async function launchEphemeralBrowser(sessionId, { browserProfile = '' } = {}) {
  const safeSessionId = String(sessionId || 'session').replace(/[^a-zA-Z0-9_-]/g, '_');
  const userDataDir = path.join(os.tmpdir(), `owc-browser-${safeSessionId}-${Date.now()}`);
  const launchTimeoutMs = getBrowserLaunchTimeoutMs();
  const launchTimeout = Number.isFinite(launchTimeoutMs) ? Math.max(0, launchTimeoutMs) : 45000;
  const launchArgs = [...DEFAULT_LAUNCH_ARGS];
  const launchPolicy = buildEffectivePolicy({ browserProfile });
  launchArgs.push(...getExtraLaunchArgs());

  if (launchPolicy.ubol_enabled && getUbolEnabled() && UBOL_EXTENSION_DIR) {
    try {
      await fs.access(path.join(UBOL_EXTENSION_DIR, 'manifest.json'));
      launchArgs.push(`--disable-extensions-except=${UBOL_EXTENSION_DIR}`);
      launchArgs.push(`--load-extension=${UBOL_EXTENSION_DIR}`);
    } catch {
      console.warn(`[owc] uBOL extension not found at ${UBOL_EXTENSION_DIR}; continuing without extension.`);
    }
  }

  const proxySelectionKey = `puppeteer:${String(browserProfile || 'default').trim().toLowerCase() || 'default'}`;
  const proxyPlan = await getProxyCandidatePlan(proxySelectionKey, getProxyRuntimeConfig());
  const attemptedErrors = [];
  let browser = null;
  let selectedProxy = null;

  if (proxyPlan.enabled && launchPolicy.use_proxy_on_first_attempt) {
    for (const candidate of proxyPlan.candidates) {
      try {
        browser = await launchBrowserAttempt({
          launchTimeout,
          launchArgs,
          userDataDir,
          proxy: candidate,
        });
        await validateProxyConnection(browser, {
          testUrl: proxyPlan.testUrl,
          timeoutMs: proxyPlan.validationTimeoutMs,
        });
        markProxySuccess(proxySelectionKey, candidate);
        selectedProxy = candidate;
        break;
      } catch (error) {
        attemptedErrors.push(`${describeProxyCandidate(candidate)} -> ${error?.message || error}`);
        markProxyFailure(proxySelectionKey, candidate);
        if (browser) {
          await browser.close().catch(() => {});
          browser = null;
        }
      }
    }
  }

  if (!browser && (!proxyPlan.enabled || proxyPlan.allowDirectFallback)) {
    browser = await launchBrowserAttempt({
      launchTimeout,
      launchArgs,
      userDataDir,
      proxy: null,
    });
  }

  if (!browser) {
    throw new Error(
      attemptedErrors.length
        ? `No working proxy candidate was available. ${attemptedErrors.join(' | ')}`
        : 'No working proxy candidate was available.',
    );
  }

  launchedSessionMetadata.set(browser.wsEndpoint(), {
    proxy: selectedProxy,
    browserProfile,
    launchPolicy,
  });

  return {
    browser,
    wsEndpoint: browser.wsEndpoint(),
    userDataDir,
    browserProfile,
    launchPolicy,
  };
}

/**
 * Close an isolated browser and remove its temporary profile directory.
 */
export async function closeEphemeralBrowser(session) {
  if (!session) return;

  try {
    if (session.wsEndpoint) {
      launchedSessionMetadata.delete(session.wsEndpoint);
    }
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
export async function getPage(browser, {
  targetUrl = '',
  forceRotateFingerprint = false,
  browserProfile = '',
} = {}) {
  const pages = await browser.pages();
  // Prefer the most recently active navigated page over blank placeholders.
  // Blank pages are opened by Puppeteer at launch and by previous tool calls,
  // but after navigate() the browser holds the real destination — use it.
  const navigated = pages.filter((p) => p.url() !== 'about:blank' && p.url() !== 'about:newtab');
  const page = navigated[navigated.length - 1]
    ?? pages.find((p) => p.url() === 'about:blank')
    ?? await browser.newPage();

  await preparePageForAutomation(browser, page, {
    targetUrl,
    forceRotateFingerprint,
    browserProfile,
  });
  return page;

  // applyFingerprint internally enforces FORCED_VIEWPORT after injector runs.
  // We set it once more here as the single authoritative enforcement point so
  // every tool that calls getPage() is guaranteed 1920×1080 regardless of
  // whether the fingerprint step was skipped (already applied) or threw.
  await applyFingerprint(page, { targetUrl, forceRotate: forceRotateFingerprint });
  await enforceWindowBounds(browser, page);
  await page.setViewport(FORCED_VIEWPORT_OPTIONS);
  attachNetworkDiagnostics(page);
  const browserMetadata = browserProxyMetadata.get(browser) || {};
  const effectivePolicy = buildEffectivePolicy({
    browserProfile: browserProfile || browserMetadata.browserProfile || '',
    targetUrl,
    currentUrl: page.url(),
    sharedConnection: browserMetadata.sharedConnection !== false,
  });
  setPageEffectivePolicy(page, effectivePolicy);

  await page.setCacheEnabled(true);
  if (effectivePolicy.cosmetic_filtering_enabled) {
    try {
      await enableBlocking(page, { targetUrl });
    } catch (error) {
      const debugAdblock = String(process.env.OWC_DEBUG_ADBLOCK || '').trim().toLowerCase();
      if (debugAdblock === '1' || debugAdblock === 'true' || debugAdblock === 'yes') {
        console.warn('[owc] adblocker attach skipped:', error?.message || error);
      }
    }
  } else {
    await disableBlocking(page).catch(() => {});
  }
  return page;
}
