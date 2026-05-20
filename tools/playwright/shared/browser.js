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

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FingerprintGenerator } from "fingerprint-generator";
import { FingerprintInjector } from "fingerprint-injector";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import {
  getProxyCandidatePlan,
  markProxyFailure,
  markProxySuccess,
  normalizeProxyRuntimeConfig,
  shouldAllowSharedBrowserFallback,
} from "../../shared/proxy-pool.js";
import {
  classifyChromeError,
  classifyIframeFailure,
  extractChromeNetErrorCode,
} from "../../shared/error-codes.js";
import { computeBrowserPolicy } from "../../shared/browser-policy.js";
import { disableBlocking, enableBlocking } from "./adblocker.js";
import {
  getBrowserRuntimeSettings,
  getEffectiveRuntimeMetadata,
} from "./runtime-config.js";

const stealthPlugin = StealthPlugin();
// fingerprint-injector controls userAgent — stealth's override contradicts it.
stealthPlugin.enabledEvasions.delete("user-agent-override");
// fingerprint-injector handles navigator.plugins already.
stealthPlugin.enabledEvasions.delete("navigator.plugins");
chromium.use(stealthPlugin);

const WS_ENDPOINT = process.env.BROWSER_WS_ENDPOINT || "ws://127.0.0.1:9223";
const EXECUTABLE_PATH =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/usr/local/bin/google-chrome-stable";
const CHROME_VERSION_API_URL =
  process.env.OWC_CHROME_VERSION_API_URL ||
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const CHROME_VERSION_FALLBACK = String(
  process.env.OWC_CHROME_VERSION_FALLBACK || "148.0.7778.167",
).trim();
const CHROME_VERSION_TIMEOUT_MS = Number.parseInt(
  String(process.env.OWC_CHROME_VERSION_FETCH_TIMEOUT_MS || "6000"),
  10,
);
const FORCED_VIEWPORT = { width: 1920, height: 1080 };
const FORCED_WINDOWS_PLATFORM = "Win32";
const FORCED_WINDOWS_PLATFORM_VERSION = "10.0.0";
const FORCED_LANGUAGE = "en-US,en;q=0.9";
const UBOL_EXTENSION_DIR = String(
  process.env.OWC_UBOL_EXTENSION_DIR || "/app/tools/playwright/extensions/ubol",
).trim();

const DEFAULT_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",

  // ── Window / viewport ───────────────────────────────────────────────────────
  `--window-size=${FORCED_VIEWPORT.width},${FORCED_VIEWPORT.height}`,
  "--window-position=0,0",
  "--force-device-scale-factor=2",

  // ── Anti-bot ────────────────────────────────────────────────────────────────

  // ── GPU / video decode ───────────────────────────────────────────────────────
  "--use-gl=swiftshader",
  "--use-angle=swiftshader-webgl",
  "--enable-webgl",

  // ── Media / autoplay ────────────────────────────────────────────────────────
  "--autoplay-policy=no-user-gesture-required",
  // NOTE: IsolateOrigins and site-per-process intentionally omitted — they
  // break cross-origin iframe auth flows that video player embeds depend on.
  "--disable-features=UseChromeOSDirectVideoDecoder",

  // ── Stability ────────────────────────────────────────────────────────────────
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

// Per-page state stored in WeakMaps (garbage collected with the page)
const pageFingerprintState = new WeakMap();
const pageCdps = new WeakMap();
const pageNetworkState = new WeakMap();
const pagePolicyState = new WeakMap();
const pageNetworkListeners = new WeakSet();
const pagePopupGuardsInstalled = new WeakSet();
const recentlyUsedFingerprintSignatures = [];
let chromeVersionPromise = null;
const fingerprintSuiteCache = new Map();
const preparedContexts = new WeakSet();

function runtimeSetting(key) {
  return getBrowserRuntimeSettings("playwright")?.[key];
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Utility helpers (identical to Puppeteer version)
// ---------------------------------------------------------------------------

function buildChromeBrands(majorVersion) {
  return [
    { brand: "Not.A/Brand", version: "99" },
    { brand: "Chromium", version: majorVersion },
    { brand: "Google Chrome", version: majorVersion },
  ];
}

function buildSecChUa(brands) {
  return brands
    .map((entry) => `"${entry.brand}";v="${entry.version}"`)
    .join(", ");
}

function getChromeMajorVersion(version) {
  const major = Number.parseInt(String(version || "").split(".")[0] || "", 10);
  if (Number.isFinite(major) && major > 0) {
    return String(major);
  }
  return String(CHROME_VERSION_FALLBACK.split(".")[0] || "146");
}

async function fetchJson(url) {
  const timeoutMs = Number.isFinite(CHROME_VERSION_TIMEOUT_MS)
    ? CHROME_VERSION_TIMEOUT_MS
    : 6000;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`Chrome version endpoint returned HTTP ${response.status}`);
  }
  return response.json();
}

async function resolveLatestStableChromeVersion() {
  const explicitVersion = String(process.env.OWC_CHROME_VERSION || "").trim();
  if (explicitVersion) return explicitVersion;

  if (!chromeVersionPromise) {
    chromeVersionPromise = (async () => {
      try {
        const payload = await fetchJson(CHROME_VERSION_API_URL);
        const stableVersion = payload?.channels?.Stable?.version;
        if (stableVersion && /^\d+\.\d+\.\d+\.\d+$/.test(stableVersion))
          return stableVersion;
      } catch {
        /* fall through */
      }

      try {
        const fallbackPayload = await fetchJson(
          "https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions?page_size=1",
        );
        const versionName = fallbackPayload?.versions?.[0]?.name || "";
        const extracted = String(versionName).match(/\d+\.\d+\.\d+\.\d+/)?.[0];
        if (extracted) return extracted;
      } catch {
        /* fall through */
      }

      return CHROME_VERSION_FALLBACK;
    })();
  }

  return chromeVersionPromise;
}

function parseChromeVersionCandidate(value) {
  const match = String(value || "").match(/(\d+\.\d+\.\d+\.\d+)/);
  return match?.[1] || "";
}

async function resolveEffectiveChromeVersion(browser = null) {
  const explicitVersion = String(process.env.OWC_CHROME_VERSION || "").trim();
  if (explicitVersion) return explicitVersion;

  try {
    const detectedVersion = parseChromeVersionCandidate(
      await browser?.version?.(),
    );
    if (detectedVersion) return detectedVersion;
  } catch {
    // Fall back to official version sources below.
  }

  return resolveLatestStableChromeVersion();
}

function parseBoolean(value, defaultValue = false) {
  if (value == null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function getBrowserLaunchTimeoutMs() {
  return Number.parseInt(
    String(
      runtimeSetting("launch_timeout_ms") ??
        process.env.OWC_BROWSER_LAUNCH_TIMEOUT_MS ??
        "45000",
    ),
    10,
  );
}

function getFingerprintRotationMode() {
  return String(
    runtimeSetting("fingerprint_rotation_mode") ??
      process.env.OWC_FINGERPRINT_ROTATION_MODE ??
      "origin",
  )
    .trim()
    .toLowerCase();
}

function getFingerprintRotationIntervalMs() {
  return Number.parseInt(
    String(
      runtimeSetting("fingerprint_rotation_interval_ms") ??
        process.env.OWC_FINGERPRINT_ROTATION_INTERVAL_MS ??
        "180000",
    ),
    10,
  );
}

function getFingerprintRotationMaxUses() {
  return Number.parseInt(
    String(
      runtimeSetting("fingerprint_rotation_max_uses") ??
        process.env.OWC_FINGERPRINT_ROTATION_MAX_USES ??
        "6",
    ),
    10,
  );
}

function getFingerprintRecentPoolSize() {
  return Number.parseInt(
    String(
      runtimeSetting("fingerprint_recent_pool_size") ??
        process.env.OWC_FINGERPRINT_RECENT_POOL_SIZE ??
        "12",
    ),
    10,
  );
}

function getFingerprintFallbackStrategy() {
  return String(
    runtimeSetting("fingerprint_fallback_strategy") ??
      process.env.OWC_FINGERPRINT_FALLBACK_STRATEGY ??
      "profile",
  )
    .trim()
    .toLowerCase();
}

function getAdblockAutoRecoveryEnabled() {
  return parseBoolean(
    runtimeSetting("adblock_auto_recovery_enabled") ??
      process.env.OWC_ADBLOCK_AUTO_RECOVERY_ENABLED,
    true,
  );
}

function getAdblockAutoRecoveryRetryEnabled() {
  return parseBoolean(
    runtimeSetting("adblock_auto_recovery_retry") ??
      process.env.OWC_ADBLOCK_AUTO_RECOVERY_RETRY,
    true,
  );
}

function getIframeSandboxPatchEnabled() {
  return parseBoolean(
    runtimeSetting("iframe_sandbox_patch_enabled") ??
      process.env.OWC_IFRAME_SANDBOX_PATCH,
    true,
  );
}

function getUbolEnabled() {
  return parseBoolean(
    runtimeSetting("ubol_enabled") ?? process.env.OWC_UBOL_ENABLED,
    true,
  );
}

function getIframeAutoRecoveryEnabled() {
  return parseBoolean(
    runtimeSetting("iframe_auto_recovery_enabled") ??
      process.env.OWC_IFRAME_AUTO_RECOVERY_ENABLED,
    true,
  );
}

function getIframeRecoveryTimeoutMs() {
  return Number.parseInt(
    String(
      runtimeSetting("iframe_recovery_timeout_ms") ??
        process.env.OWC_IFRAME_RECOVERY_TIMEOUT_MS ??
        "20000",
    ),
    10,
  );
}

function getPopupBlockingEnabled() {
  return parseBoolean(
    runtimeSetting("popup_blocking_enabled") ??
      process.env.OWC_POPUP_BLOCKING_ENABLED,
    true,
  );
}

function getExtraLaunchArgs() {
  const configured = runtimeSetting("extra_launch_args");
  if (!Array.isArray(configured)) return [];
  return configured.map((item) => String(item || "").trim()).filter(Boolean);
}

function getProxyRuntimeConfig() {
  return normalizeProxyRuntimeConfig(
    getBrowserRuntimeSettings("playwright") || {},
  );
}

function getRuntimeSettings() {
  return getBrowserRuntimeSettings("playwright") || {};
}

function buildEffectivePolicy({
  browserProfile = "",
  targetUrl = "",
  currentUrl = "",
  sharedConnection = false,
  iframeUrls = [],
  playerHints = [],
} = {}) {
  return computeBrowserPolicy({
    browserId: "playwright",
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
  state.effectiveRuntime = getEffectiveRuntimeMetadata("playwright");
}

export function getPageEffectivePolicy(page) {
  return pagePolicyState.get(page) || null;
}

export function getPageEffectiveRuntime(page) {
  const state = getNetworkState(page);
  return state.effectiveRuntime || getEffectiveRuntimeMetadata("playwright");
}

function clampPositiveInteger(value, fallback) {
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

function normalizeRotationMode(mode) {
  const normalized = String(mode || "")
    .trim()
    .toLowerCase();
  if (["off", "none", "false", "0", "never"].includes(normalized))
    return "never";
  if (["page", "always"].includes(normalized)) return "page";
  if (["origin", "domain", "site"].includes(normalized)) return "origin";
  if (["interval", "time"].includes(normalized)) return "interval";
  return "origin";
}

function getOriginFromUrl(urlLike) {
  const input = String(urlLike || "").trim();
  if (!input || input === "about:blank" || input === "about:newtab") return "";
  try {
    return new URL(input).origin;
  } catch {
    return "";
  }
}

function getFingerprintSignature(bundle) {
  const navigator = bundle?.fingerprint?.navigator || {};
  const userAgentData = navigator.userAgentData || {};
  const brandToken = Array.isArray(userAgentData.fullVersionList)
    ? userAgentData.fullVersionList
        .map((e) => `${e.brand}/${e.version}`)
        .join("|")
    : Array.isArray(userAgentData.brands)
      ? userAgentData.brands.map((e) => `${e.brand}/${e.version}`).join("|")
      : "";
  return [
    navigator.userAgent || "",
    navigator.platform || "",
    navigator.language || "",
    brandToken,
  ].join("::");
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
  if (forceRotate || !state) return true;
  const rotationMode = normalizeRotationMode(getFingerprintRotationMode());
  if (rotationMode === "never") return false;
  if (rotationMode === "page") return true;
  const now = Date.now();
  const maxUses = clampPositiveInteger(getFingerprintRotationMaxUses(), 6);
  const intervalMs = clampPositiveInteger(
    getFingerprintRotationIntervalMs(),
    180000,
  );
  if (maxUses > 0 && state.useCount >= maxUses) return true;
  if (intervalMs > 0 && now - state.appliedAt >= intervalMs) return true;
  if (rotationMode === "origin") {
    const expectedOrigin =
      getOriginFromUrl(targetUrl) || getOriginFromUrl(page.url());
    if (expectedOrigin && state.origin && expectedOrigin !== state.origin)
      return true;
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
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isLikelyIframeOrPlayerRequest({ url = "", resourceType = "" } = {}) {
  const normalizedUrl = String(url || "").toLowerCase();
  const normalizedType = String(resourceType || "").toLowerCase();
  if (["sub_frame", "media"].includes(normalizedType)) return true;
  if (
    /(\.m3u8|\.mpd|\.m4s|\.ts)(\?|$)|player|embed|stream|playlist|manifest|video/.test(
      normalizedUrl,
    )
  )
    return true;
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
    const resourceType = String(failure.resource_type || "other");
    summary.by_resource_type[resourceType] =
      (summary.by_resource_type[resourceType] || 0) + 1;
    const errorCode = String(failure.error_code || "").trim();
    if (errorCode)
      summary.by_error_code[errorCode] =
        (summary.by_error_code[errorCode] || 0) + 1;
    if (failure.blocked_by_client) summary.blocked_by_client += 1;
    if (failure.aborted) summary.aborted += 1;
    if (failure.iframe_or_player_related) summary.iframe_or_player_related += 1;
    if (failure.error_category === "transient")
      summary.transient_error_count += 1;
    else if (failure.error_category === "limited")
      summary.limited_error_count += 1;
    else if (failure.error_category === "permanent")
      summary.permanent_error_count += 1;
    else summary.unknown_error_count += 1;
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
      effectivePolicy: null,
      effectiveRuntime: null,
      autoRecovery: {
        attempted: false,
        disabled_blocking: false,
        retried_navigation: false,
        retry_succeeded: false,
        reason: "",
        error: null,
        disable_promise: null,
      },
      iframeRecovery: {
        attempted: false,
        detection_reason: "",
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
  const rawFailure = request.failure?.();
  const failureText = normalizeFailureText(
    rawFailure?.errorText || rawFailure || "",
  );
  const url = request.url() || "";
  const resourceType = request.resourceType() || "other";
  const errorCode = extractChromeNetErrorCode(failureText);
  const chromeError = classifyChromeError({ message: failureText, url });
  const failure = {
    timestamp: Date.now(),
    url,
    method: request.method() || "GET",
    resource_type: resourceType,
    frame_url: request.frame()?.url() || "",
    error_text: failureText,
    error_code: errorCode || chromeError.error_code,
    error_category: chromeError.error_category,
    blocked_by_client:
      failureText.includes("blocked_by_client") ||
      failureText.includes("blockedbyclient"),
    aborted: failureText.includes("aborted"),
    iframe_or_player_related: isLikelyIframeOrPlayerRequest({
      url,
      resourceType,
    }),
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
  while (state.failures.length > state.failuresLimit) state.failures.shift();
  return failure;
}

// In Playwright, disableBlocking on a page means updating the context route handler.
async function disableBlockingForPage(page) {
  try {
    return await disableBlocking(page);
  } catch {
    return false;
  }
}

async function performIframeRecovery(page, failure) {
  const state = getNetworkState(page);
  const recovery = state.iframeRecovery;
  const timeoutMs = Math.max(5000, getIframeRecoveryTimeoutMs() || 20000);

  recovery.attempted = true;
  recovery.detection_reason = failure.iframe_failure_reason || "";
  recovery.patches_applied = [];
  recovery.final_error = null;
  recovery.recovery_attempts += 1;
  recovery.success = false;
  recovery.unrecoverable = false;

  try {
    if (
      recovery.detection_reason === "x_frame_options" ||
      recovery.detection_reason === "csp"
    ) {
      recovery.unrecoverable = true;
      recovery.final_error =
        recovery.detection_reason === "csp"
          ? "unrecoverable_content_security_policy"
          : "unrecoverable_x_frame_options";
      return;
    }

    if (recovery.detection_reason === "sandbox") {
      recovery.patches_applied.push("relax_sandbox");
      await page.evaluate(patchIframeSandboxFn).catch(() => {});
      recovery.patches_applied.push("reload_with_retry");
      await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
      recovery.success = true;
      return;
    }

    if (recovery.detection_reason === "cors") {
      const disabled = await disableBlockingForPage(page);
      recovery.patches_applied.push(
        disabled ? "disable_blocking" : "blocking_already_disabled",
      );
      recovery.patches_applied.push("reload_with_retry");
      await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
      recovery.success = true;
      return;
    }

    if (recovery.detection_reason === "network") {
      recovery.patches_applied.push("reload_with_retry");
      await wait(1000);
      await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
      recovery.success = true;
      return;
    }

    recovery.final_error = "no_recovery_strategy";
  } catch (error) {
    recovery.final_error = error?.message || String(error);
  }
}

function attachNetworkDiagnostics(page) {
  if (pageNetworkListeners.has(page)) return;
  pageNetworkListeners.add(page);

  page.on("requestfailed", (request) => {
    const failure = recordRequestFailure(page, request);
    const state = getNetworkState(page);

    if (getAdblockAutoRecoveryEnabled() && !state.autoRecovery.attempted) {
      const recoverableFailure =
        failure.iframe_or_player_related && failure.blocked_by_client;

      if (recoverableFailure) {
        state.autoRecovery.attempted = true;
        state.autoRecovery.reason = failure.blocked_by_client
          ? "blocked_by_client_iframe_or_player_request"
          : "aborted_iframe_or_player_request";

        state.autoRecovery.disable_promise = disableBlockingForPage(page)
          .then(async (disabled) => {
            state.autoRecovery.disabled_blocking = Boolean(disabled);
            if (disabled) {
              // Reload so the player can make its requests now that blocking is off.
              await page
                .reload({ waitUntil: "domcontentloaded", timeout: 20000 })
                .catch(() => {});
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

    if (
      !getIframeAutoRecoveryEnabled() ||
      state.iframeRecovery.attempted ||
      !failure.iframe_failure_reason
    )
      return;
    if (failure.iframe_failure_reason === "adblock") return;

    state.iframeRecovery.pending_promise = performIframeRecovery(
      page,
      failure,
    ).finally(() => {
      state.iframeRecovery.pending_promise = null;
    });
  });
}

function buildCriticalResourceFailures(failures = []) {
  const buckets = new Map();
  const normalized = Array.isArray(failures) ? failures : [];
  const classifyFailure = (failure) => {
    const url = String(failure?.url || "").toLowerCase();
    const resourceType = String(failure?.resource_type || "").toLowerCase();
    if (
      /\.m3u8(?:$|[?#])|\.mpd(?:$|[?#])|manifest|playlist/.test(url) ||
      resourceType === "media"
    )
      return "manifest_media";
    if (resourceType === "script") return "script";
    if (resourceType === "stylesheet") return "stylesheet";
    if (resourceType === "font") return "font";
    if (resourceType === "sub_frame") return "sub_frame";
    return "";
  };

  for (const failure of normalized) {
    const kind = classifyFailure(failure);
    if (!kind || buckets.has(kind)) continue;
    buckets.set(kind, {
      kind,
      url: failure.url || "",
      host: (() => {
        try {
          return new URL(failure.url || "").hostname;
        } catch {
          return "";
        }
      })(),
      resource_type: failure.resource_type || "",
      http_status: failure.http_status || null,
      error: failure.error_text || "",
      error_code: failure.error_code || "",
      error_category: failure.error_category || "",
      blocked_by_client: Boolean(failure.blocked_by_client),
      frame_url: failure.frame_url || "",
      status_text: failure.status_text || "",
    });
  }

  return Array.from(buckets.values());
}

function buildRenderGapSignals(failures = []) {
  const normalized = Array.isArray(failures) ? failures : [];
  const byType = (type) =>
    normalized.filter((failure) => failure?.resource_type === type);
  const blockedFailures = normalized.filter(
    (failure) => failure?.blocked_by_client,
  );
  const manifestFailure =
    buildCriticalResourceFailures(normalized).find(
      (failure) => failure.kind === "manifest_media",
    ) || null;

  return {
    failed_script_count: byType("script").length,
    failed_stylesheet_count: byType("stylesheet").length,
    failed_font_count: byType("font").length,
    failed_subframe_count: byType("sub_frame").length,
    blocked_by_client_total: blockedFailures.length,
    blocked_by_client_by_type: blockedFailures.reduce((acc, failure) => {
      const key = failure.resource_type || "other";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    missing_player_supporting_assets: Boolean(
      byType("script").some((failure) =>
        /(player|videojs|jwplayer|hls)/i.test(
          `${failure.url || ""} ${failure.frame_url || ""}`,
        ),
      ) ||
      byType("stylesheet").length > 0 ||
      byType("font").length > 0 ||
      Boolean(manifestFailure),
    ),
    overlay_gate_possible: false,
  };
}

function filterFailuresForCurrentPage(page, failures = []) {
  const currentUrl = String(page.url?.() || "");
  let currentOrigin = "";
  try {
    currentOrigin = new URL(currentUrl).origin;
  } catch {
    currentOrigin = "";
  }
  if (!currentUrl || currentUrl === "about:blank") return failures;

  return failures.filter((failure) => {
    const frameUrl = String(failure?.frame_url || "");
    const requestUrl = String(failure?.url || "");
    if (!frameUrl) return true;
    if (frameUrl === currentUrl || frameUrl.startsWith(`${currentUrl}#`))
      return true;
    if (requestUrl === currentUrl) return true;
    if (!currentOrigin) return false;
    try {
      return new URL(frameUrl).origin === currentOrigin;
    } catch {
      return false;
    }
  });
}

export function getPageNetworkDiagnostics(page, { limit = 10 } = {}) {
  const state = getNetworkState(page);
  const scopedFailures = filterFailuresForCurrentPage(page, state.failures);
  const cappedFailures = scopedFailures.slice(
    -Math.max(1, Number.parseInt(String(limit || 10), 10) || 10),
  );
  const summary = summarizeNetworkFailures(cappedFailures);
  const { disable_promise, ...publicRecovery } = state.autoRecovery;
  const { pending_promise, ...publicIframeRecovery } = state.iframeRecovery;
  const critical_resource_failures =
    buildCriticalResourceFailures(scopedFailures);
  const render_gap_signals = buildRenderGapSignals(scopedFailures);
  const manifest_failure =
    critical_resource_failures.find(
      (failure) => failure.kind === "manifest_media",
    ) || null;
  return {
    request_failures: cappedFailures,
    request_failure_summary: summary,
    failures_by_error_code: summary.by_error_code,
    transient_error_count: summary.transient_error_count,
    limited_error_count: summary.limited_error_count,
    permanent_error_count: summary.permanent_error_count,
    unknown_error_count: summary.unknown_error_count,
    auto_recovery: { ...publicRecovery },
    iframe_recovery_attempted: Boolean(publicIframeRecovery.attempted),
    iframe_recovery_reason: publicIframeRecovery.detection_reason || "",
    iframe_recovery_success: Boolean(publicIframeRecovery.success),
    iframe_recovery: { ...publicIframeRecovery },
    effective_policy: state.effectivePolicy || null,
    effective_runtime:
      state.effectiveRuntime || getEffectiveRuntimeMetadata("playwright"),
    critical_resource_failures,
    render_gap_signals,
    manifest_failure,
  };
}

export async function getIframeDiagnostics(page, { limit = 24 } = {}) {
  const normalizedLimit = Math.max(
    1,
    Number.parseInt(String(limit || 24), 10) || 24,
  );
  const rows = await page
    .mainFrame()
    .evaluate((innerLimit) => {
      const toSafeOrigin = (candidate) => {
        try {
          return new URL(candidate, window.location.href).origin;
        } catch {
          return "";
        }
      };
      const classify = (iframe) => {
        const src =
          iframe.getAttribute("src") || iframe.getAttribute("data-src") || "";
        const sandbox = (iframe.getAttribute("sandbox") || "").trim();
        const allow = (iframe.getAttribute("allow") || "").trim();
        const rect = iframe.getBoundingClientRect();
        const sandboxTokens = sandbox
          ? sandbox
              .split(/\s+/)
              .map((t) => t.trim())
              .filter(Boolean)
          : [];
        const sourceOrigin = toSafeOrigin(src);
        const crossOrigin = Boolean(
          sourceOrigin && sourceOrigin !== window.location.origin,
        );
        const iframeLikePlayer =
          /(player|embed|stream|video|watch)/i.test(
            `${src} ${iframe.id || ""} ${iframe.className || ""}`,
          ) ||
          (rect.width >= 280 && rect.height >= 160);
        const sandboxLikelyRestrictive =
          sandboxTokens.length > 0 &&
          (!sandboxTokens.includes("allow-scripts") ||
            !sandboxTokens.includes("allow-same-origin"));
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
      return Array.from(document.querySelectorAll("iframe"))
        .slice(0, innerLimit)
        .map(classify);
    }, normalizedLimit)
    .catch(() => []);
  const state = getNetworkState(page);
  const recovery = state.iframeRecovery;
  const restrictiveSandboxFailedCount = state.failures.filter(
    (failure) => failure.iframe_failure_reason === "sandbox",
  ).length;

  return {
    total: rows.length,
    cross_origin_count: rows.filter((r) => r.cross_origin).length,
    restrictive_sandbox_count: rows.filter((r) => r.restrictive_sandbox).length,
    restrictive_sandbox_failed_count: restrictiveSandboxFailedCount,
    likely_player_count: rows.filter((r) => r.likely_player).length,
    recovery_attempted: Boolean(recovery.attempted),
    recovery_reason: recovery.detection_reason || "",
    recovery_patches: [...(recovery.patches_applied || [])],
    recovery_success: Boolean(recovery.success),
    recovery_error: recovery.final_error,
    iframes: rows,
  };
}

export async function retryNavigationAfterAutoRecovery(
  page,
  { url, waitUntil = "networkidle", timeoutMs = 30000 } = {},
) {
  const state = getNetworkState(page);
  if (state.autoRecovery.disable_promise) {
    await state.autoRecovery.disable_promise.catch(() => {});
  }
  if (state.iframeRecovery.pending_promise) {
    await state.iframeRecovery.pending_promise.catch(() => {});
  }

  if (!getAdblockAutoRecoveryRetryEnabled()) {
    return { attempted: false, reason: "auto_recovery_retry_disabled" };
  }
  if (!state.autoRecovery.disabled_blocking) {
    return { attempted: false, reason: "blocking_not_disabled" };
  }
  if (state.autoRecovery.retried_navigation) {
    return { attempted: false, reason: "retry_already_attempted" };
  }

  state.autoRecovery.retried_navigation = true;
  const targetUrl = String(url || "").trim() || page.url();
  try {
    await page.goto(targetUrl, { waitUntil, timeout: timeoutMs });
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
      browserConstraints.push({
        name: "chrome",
        minVersion: major,
        maxVersion: major,
      });
    }
  }
  if (!browserConstraints.length) browserConstraints.push({ name: "chrome" });
  return {
    browsers: browserConstraints,
    devices: ["desktop"],
    operatingSystems: ["windows"],
    locales: ["en-US"],
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
    try {
      return generator.getFingerprint(
        buildFingerprintConstraints(majorCandidate),
      );
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error("Failed to generate a browser fingerprint.");
}

function synchronizeFingerprint(
  fingerprintBundle,
  chromeVersion,
  chromeMajorVersion,
) {
  const synchronized = structuredClone(fingerprintBundle);
  const navigator = synchronized?.fingerprint?.navigator;
  if (!navigator) return synchronized;

  const chromeVersionToken = `Chrome/${chromeVersion}`;
  navigator.userAgent = String(navigator.userAgent || "")
    .replace(/Chrome\/[\d.]+/gi, chromeVersionToken)
    .replace(/\s+/g, " ")
    .trim();
  navigator.appVersion = String(navigator.appVersion || "")
    .replace(/Chrome\/[\d.]+/gi, chromeVersionToken)
    .replace(/\s+/g, " ")
    .trim();
  navigator.platform = FORCED_WINDOWS_PLATFORM;
  navigator.language = "en-US";
  navigator.languages = ["en-US", "en"];

  if (navigator.userAgentData) {
    const brands = buildChromeBrands(chromeMajorVersion);
    navigator.userAgentData.brands = brands;
    navigator.userAgentData.fullVersionList = brands.map((e) => ({
      ...e,
      version: chromeVersion,
    }));
    navigator.userAgentData.uaFullVersion = chromeVersion;
    navigator.userAgentData.platform = "Windows";
    navigator.userAgentData.platformVersion = FORCED_WINDOWS_PLATFORM_VERSION;
    navigator.userAgentData.mobile = false;
    navigator.userAgentData.architecture = "x86";
    navigator.userAgentData.bitness = "64";
    navigator.userAgentData.model = "";
  }

  synchronized.headers = {
    ...toHeaderRecord(synchronized.headers),
    "User-Agent": navigator.userAgent,
    "Accept-Language": FORCED_LANGUAGE,
  };
  return synchronized;
}

function buildProfileFromFingerprint(
  synchronizedBundle,
  chromeVersion,
  chromeMajorVersion,
) {
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
    "User-Agent": navigator.userAgent,
    "Accept-Language": FORCED_LANGUAGE,
    "Cache-Control": "max-age=0",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-CH-UA": secChUa,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    "Sec-CH-UA-Platform-Version": `"${FORCED_WINDOWS_PLATFORM_VERSION}"`,
    "Sec-CH-UA-Full-Version": `"${chromeVersion}"`,
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
      platform: "Windows",
      platformVersion: FORCED_WINDOWS_PLATFORM_VERSION,
      architecture: userAgentMetadata.architecture || "x86",
      model: userAgentMetadata.model || "",
      mobile: false,
      bitness: userAgentMetadata.bitness || "64",
      wow64: false,
    },
  };
}

function generateRotatingFingerprintBundle(
  generator,
  chromeVersion,
  chromeMajorVersion,
) {
  const attempts = Math.max(
    4,
    clampPositiveInteger(getFingerprintRecentPoolSize(), 12),
  );
  let selected = null;
  let selectedSignature = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const generated = generateFingerprintBundle(generator, chromeMajorVersion);
    const synchronized = synchronizeFingerprint(
      generated,
      chromeVersion,
      chromeMajorVersion,
    );
    const signature = getFingerprintSignature(synchronized);
    if (!recentlyUsedFingerprintSignatures.includes(signature)) {
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
  const synchronized = synchronizeFingerprint(
    generated,
    chromeVersion,
    chromeMajorVersion,
  );
  rememberFingerprintSignature(getFingerprintSignature(synchronized));
  return synchronized;
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
  const fullVersionList = brands.map((entry) => ({
    ...entry,
    version: chromeVersion,
  }));
  const userAgent = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "AppleWebKit/537.36 (KHTML, like Gecko)",
    `Chrome/${chromeVersion}`,
    "Safari/537.36",
  ].join(" ");
  const secChUa = buildSecChUa(brands);

  return {
    userAgent,
    language: FORCED_LANGUAGE,
    secChUa,
    chromeVersion,
    chromeMajorVersion,
    headers: {
      "User-Agent": userAgent,
      "Accept-Language": FORCED_LANGUAGE,
      "Cache-Control": "max-age=0",
      Pragma: "no-cache",
      "Upgrade-Insecure-Requests": "1",
      "Sec-CH-UA": secChUa,
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Windows"',
      "Sec-CH-UA-Platform-Version": `"${FORCED_WINDOWS_PLATFORM_VERSION}"`,
      "Sec-CH-UA-Full-Version": `"${chromeVersion}"`,
    },
    userAgentMetadata: {
      brands,
      fullVersion: chromeVersion,
      fullVersionList,
      platform: "Windows",
      platformVersion: FORCED_WINDOWS_PLATFORM_VERSION,
      architecture: "x86",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Playwright-specific init scripts (equivalent of evaluateOnNewDocument)
// ---------------------------------------------------------------------------

const runtimeFingerprintPatchFn = (fingerprintProfile) => {
  const profileKey = Symbol.for("__owc_fingerprint_profile__");
  globalThis[profileKey] = fingerprintProfile;
  const readProfile = () => globalThis[profileKey] || fingerprintProfile;

  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};
  if (!window.chrome.app) {
    window.chrome.app = {
      isInstalled: false,
      InstallState: {
        DISABLED: "disabled",
        INSTALLED: "installed",
        NOT_INSTALLED: "not_installed",
      },
      RunningState: {
        CANNOT_RUN: "cannot_run",
        READY_TO_RUN: "ready_to_run",
        RUNNING: "running",
      },
    };
  }

  Object.defineProperty(Navigator.prototype, "platform", {
    configurable: true,
    get: () => "Win32",
  });
  Object.defineProperty(Navigator.prototype, "language", {
    configurable: true,
    get: () => "en-US",
  });
  Object.defineProperty(Navigator.prototype, "languages", {
    configurable: true,
    get: () => ["en-US", "en"],
  });
  Object.defineProperty(Navigator.prototype, "userAgent", {
    configurable: true,
    get: () => readProfile().userAgent,
  });
  Object.defineProperty(Navigator.prototype, "userAgentData", {
    configurable: true,
    get: () => {
      const profile = readProfile();
      const metadata = profile.userAgentMetadata;
      return {
        brands: metadata.brands,
        mobile: false,
        platform: "Windows",
        getHighEntropyValues: async () => ({
          architecture: metadata.architecture,
          bitness: metadata.bitness,
          fullVersionList: metadata.fullVersionList,
          model: "",
          platform: "Windows",
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
    },
  });

  // Autoplay helper
  if (window.HTMLMediaElement?.prototype) {
    const mediaProto = window.HTMLMediaElement.prototype;
    const patchedKey = Symbol.for("__media_autoplay_patched__");
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

const popupBlockerInitScript = () => {
  const blockerKey = Symbol.for("__owc_popup_blocker__");
  if (globalThis[blockerKey]) {
    return;
  }
  Object.defineProperty(globalThis, blockerKey, {
    value: true,
    writable: false,
  });
  const noopOpen = () => null;
  try {
    Object.defineProperty(window, "open", {
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
};

async function installPopupGuards(page) {
  if (
    !getPopupBlockingEnabled() ||
    !page ||
    pagePopupGuardsInstalled.has(page)
  ) {
    return;
  }
  pagePopupGuardsInstalled.add(page);
  page.on("dialog", (dialog) => {
    dialog.dismiss().catch(() => {});
  });
  await page.addInitScript(popupBlockerInitScript).catch(() => {});
  await page.evaluate(popupBlockerInitScript).catch(() => {});
}

const patchIframeSandboxFn = () => {
  const patchKey = Symbol.for("__owc_iframe_sandbox_patch__");
  if (globalThis[patchKey]) return;
  Object.defineProperty(globalThis, patchKey, { value: true, writable: false });

  const requiredSandboxTokens = [
    "allow-scripts",
    "allow-same-origin",
    "allow-forms",
    "allow-popups",
    "allow-popups-to-escape-sandbox",
    "allow-presentation",
    "allow-modals",
  ];
  const requiredAllowTokens = [
    "autoplay",
    "fullscreen",
    "encrypted-media",
    "picture-in-picture",
  ];

  const isLikelyPlayerIframe = (iframe) => {
    const rect = iframe.getBoundingClientRect();
    const src =
      iframe.getAttribute("src") || iframe.getAttribute("data-src") || "";
    return (
      /(player|embed|stream|video|watch|live)/.test(
        `${src} ${iframe.id || ""} ${iframe.name || ""} ${iframe.className || ""}`.toLowerCase(),
      ) ||
      (rect.width >= 280 && rect.height >= 160)
    );
  };

  const patchIframe = (iframe) => {
    if (!(iframe instanceof HTMLIFrameElement) || !isLikelyPlayerIframe(iframe))
      return;
    const sandboxAttr = (iframe.getAttribute("sandbox") || "").trim();
    if (sandboxAttr) {
      const tokens = new Set(
        sandboxAttr
          .split(/\s+/)
          .map((t) => t.trim())
          .filter(Boolean),
      );
      let changed = false;
      for (const token of requiredSandboxTokens) {
        if (!tokens.has(token)) {
          tokens.add(token);
          changed = true;
        }
      }
      if (changed) iframe.setAttribute("sandbox", Array.from(tokens).join(" "));
    }
    const allowTokens = new Set(
      (iframe.getAttribute("allow") || "")
        .split(/[;\s]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    );
    let changedAllow = false;
    for (const token of requiredAllowTokens) {
      if (!allowTokens.has(token)) {
        allowTokens.add(token);
        changedAllow = true;
      }
    }
    if (changedAllow)
      iframe.setAttribute("allow", Array.from(allowTokens).join("; "));
  };

  for (const iframe of document.querySelectorAll("iframe")) patchIframe(iframe);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        patchIframe(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes || []) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLIFrameElement) patchIframe(node);
        for (const iframe of node.querySelectorAll?.("iframe") || [])
          patchIframe(iframe);
      }
    }
  });
  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "sandbox",
      "allow",
      "src",
      "data-src",
      "class",
      "id",
      "name",
    ],
  });
};

// ---------------------------------------------------------------------------
// Context-level fingerprint application (Playwright approach)
// ---------------------------------------------------------------------------

async function createFingerprintedContext(
  browser,
  profile,
  synchronizedBundle = null,
  { injectFingerprint = true } = {},
) {
  const context = await browser.newContext({
    viewport: FORCED_VIEWPORT,
    deviceScaleFactor: 2,
    userAgent: profile.userAgent,
    locale: profile.language || "en-US",
    extraHTTPHeaders: profile.headers,
  });

  // Apply fingerprint at context level (affects all pages including cross-origin iframes)
  if (injectFingerprint && synchronizedBundle) {
    try {
      const suite = await getFingerprintSuite(browser);
      await suite.fingerprintInjector.attachFingerprintToPlaywright(
        context,
        synchronizedBundle,
      );
    } catch (err) {
      console.warn(
        "[owc-pw] fingerprint injection skipped:",
        err?.message || err,
      );
    }
  }

  // Runtime JS patches via addInitScript (= evaluateOnNewDocument but context-scoped)
  await context.addInitScript(runtimeFingerprintPatchFn, {
    userAgent: profile.userAgent,
    userAgentMetadata: profile.userAgentMetadata,
    chromeVersion: profile.chromeVersion,
    chromeMajorVersion: profile.chromeMajorVersion,
    secChUa: profile.secChUa,
  });

  // Remove Playwright-specific globals that some sites check
  await context.addInitScript(() => {
    try {
      delete window.__playwright;
    } catch {
      /* ignore */
    }
    try {
      delete window.__pw_manual;
    } catch {
      /* ignore */
    }
  });
  if (getPopupBlockingEnabled()) {
    await context.addInitScript(popupBlockerInitScript);
    context.on("page", async (page) => {
      try {
        const opener = await page.opener().catch(() => null);
        if (opener) {
          await page.close().catch(() => {});
          return;
        }
        await installPopupGuards(page);
      } catch {
        // ignore
      }
    });
  }

  preparedContexts.add(context);

  return context;
}

async function prepareSharedContext(context) {
  if (preparedContexts.has(context)) {
    return context;
  }

  await context.addInitScript(() => {
    try {
      delete window.__playwright;
    } catch {
      /* ignore */
    }
    try {
      delete window.__pw_manual;
    } catch {
      /* ignore */
    }
  });
  if (getPopupBlockingEnabled()) {
    await context.addInitScript(popupBlockerInitScript);
    context.on("page", async (page) => {
      try {
        const opener = await page.opener().catch(() => null);
        if (opener) {
          await page.close().catch(() => {});
          return;
        }
        await installPopupGuards(page);
      } catch {
        // ignore
      }
    });
  }
  preparedContexts.add(context);
  return context;
}

async function launchBrowserAttempt({
  launchTimeout,
  launchArgs,
  proxy = null,
  userDataDir = "",
  persistent = false,
} = {}) {
  const launchOptions = {
    executablePath: EXECUTABLE_PATH,
    headless: true,
    timeout: launchTimeout,
    args: launchArgs,
    proxy: proxy?.server
      ? {
          server: proxy.server,
          username: proxy.username || undefined,
          password: proxy.password || undefined,
        }
      : undefined,
  };

  if (persistent) {
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      viewport: FORCED_VIEWPORT,
      deviceScaleFactor: 2,
    });
    return {
      browser: context.browser(),
      context,
      persistent: true,
    };
  }

  const browser = await chromium.launch(launchOptions);
  return {
    browser,
    context: null,
    persistent: false,
  };
}

async function validateProxyConnection(
  launchResult,
  { testUrl, timeoutMs } = {},
) {
  const persistentContext = launchResult?.context || null;
  const browser = launchResult?.browser || null;
  const temporaryContext = persistentContext
    ? null
    : await browser.newContext({
        viewport: FORCED_VIEWPORT,
        deviceScaleFactor: 2,
        ignoreHTTPSErrors: true,
      });

  const context = persistentContext || temporaryContext;
  try {
    const page = context.pages()[0] || (await context.newPage());
    const response = await page.goto(testUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    if (!response || !response.ok()) {
      throw new Error(`Proxy validation failed for ${testUrl}`);
    }
  } finally {
    if (temporaryContext) {
      await temporaryContext.close().catch(() => {});
    }
  }
}

export function isSharedBrowserFallbackAllowed() {
  return shouldAllowSharedBrowserFallback(getProxyRuntimeConfig());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Connect to an existing browser by WebSocket endpoint (CDP).
 * Returns { browser, context, disconnect } session object.
 *
 * If wsEndpoint is already a session object (e.g. passed from isolated MCP mode),
 * it is returned directly with a no-op disconnect so tool cleanup calls work safely.
 */
export async function connectBrowser(wsEndpoint = WS_ENDPOINT) {
  // Pass-through: already a session object from isolated MCP mode.
  if (
    wsEndpoint != null &&
    typeof wsEndpoint === "object" &&
    wsEndpoint.context
  ) {
    if (typeof wsEndpoint.disconnect === "function") return wsEndpoint;
    return { ...wsEndpoint, disconnect: async () => {} };
  }
  const endpoint = String(wsEndpoint || "").trim() || WS_ENDPOINT;
  const browser = await chromium.connectOverCDP(endpoint);

  let context = null;
  let ownsContext = false;
  try {
    const suite = await getFingerprintSuite(browser);
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
    context = await createFingerprintedContext(browser, profile, synchronized);
    ownsContext = true;
  } catch (error) {
    if (getFingerprintFallbackStrategy() === "profile") {
      try {
        const suite = await getFingerprintSuite(browser);
        const profile = buildFallbackFingerprintProfile(
          suite.chromeVersion,
          suite.chromeMajorVersion,
        );
        context = await createFingerprintedContext(browser, profile, null, {
          injectFingerprint: false,
        });
        ownsContext = true;
      } catch {
        context = browser.contexts()[0] || null;
        if (context) {
          await prepareSharedContext(context);
        }
      }
    } else {
      context = browser.contexts()[0] || null;
      if (context) {
        await prepareSharedContext(context);
      }
    }
  }

  if (!context) {
    throw new Error(
      "Could not resolve a Playwright browser context from the connected browser.",
    );
  }

  return {
    browser,
    context,
    userDataDir: null,
    browserProfile: "",
    launchPolicy: null,
    sharedConnection: true,
    ownsBrowser: false,
    ownsContext,
    disconnect: async () => browser.disconnect(),
  };
}

/**
 * Launch an isolated browser for one MCP session.
 * Returns { browser, context, userDataDir }.
 */
export async function launchEphemeralBrowser(
  sessionId,
  { browserProfile = "" } = {},
) {
  const safeSessionId = String(sessionId || "session").replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const userDataDir = path.join(
    os.tmpdir(),
    `owc-pw-${safeSessionId}-${Date.now()}`,
  );
  const launchTimeoutMs = getBrowserLaunchTimeoutMs();
  const launchTimeout = Number.isFinite(launchTimeoutMs)
    ? Math.max(0, launchTimeoutMs)
    : 45000;
  const launchArgs = [...DEFAULT_LAUNCH_ARGS, ...getExtraLaunchArgs()];
  const launchPolicy = buildEffectivePolicy({ browserProfile });

  let launchPersistentContext = false;
  if (launchPolicy.ubol_enabled && getUbolEnabled() && UBOL_EXTENSION_DIR) {
    try {
      await fs.access(path.join(UBOL_EXTENSION_DIR, "manifest.json"));
      launchArgs.push(`--disable-extensions-except=${UBOL_EXTENSION_DIR}`);
      launchArgs.push(`--load-extension=${UBOL_EXTENSION_DIR}`);
      launchPersistentContext = true;
    } catch {
      console.warn(
        `[owc-pw] uBOL extension not found at ${UBOL_EXTENSION_DIR}; continuing without extension.`,
      );
    }
  }

  const proxySelectionKey = `playwright:${
    String(browserProfile || "default")
      .trim()
      .toLowerCase() || "default"
  }`;
  const proxyPlan = await getProxyCandidatePlan(
    proxySelectionKey,
    getProxyRuntimeConfig(),
  );
  const attemptedErrors = [];
  let browser = null;
  let context = null;
  let persistentContext = false;
  let selectedProxy = null;

  if (proxyPlan.enabled && launchPolicy.use_proxy_on_first_attempt) {
    for (const candidate of proxyPlan.candidates) {
      try {
        const launchResult = await launchBrowserAttempt({
          launchTimeout,
          launchArgs,
          proxy: candidate,
          userDataDir,
          persistent: launchPersistentContext,
        });
        await validateProxyConnection(launchResult, {
          testUrl: proxyPlan.testUrl,
          timeoutMs: proxyPlan.validationTimeoutMs,
        });
        browser = launchResult.browser;
        context = launchResult.context;
        persistentContext = launchResult.persistent;
        markProxySuccess(proxySelectionKey, candidate);
        selectedProxy = candidate;
        break;
      } catch (error) {
        attemptedErrors.push(
          `${candidate.server} (${candidate.sourceId}) -> ${error?.message || error}`,
        );
        markProxyFailure(proxySelectionKey, candidate);
        if (context) {
          await context.close().catch(() => {});
          context = null;
        } else if (browser) {
          await browser.close().catch(() => {});
          browser = null;
        }
        persistentContext = false;
      }
    }
  }

  if (!browser && (!proxyPlan.enabled || proxyPlan.allowDirectFallback)) {
    const launchResult = await launchBrowserAttempt({
      launchTimeout,
      launchArgs,
      proxy: null,
      userDataDir,
      persistent: launchPersistentContext,
    });
    browser = launchResult.browser;
    context = launchResult.context;
    persistentContext = launchResult.persistent;
  }

  if (!browser) {
    throw new Error(
      attemptedErrors.length
        ? `No working proxy candidate was available. ${attemptedErrors.join(" | ")}`
        : "No working proxy candidate was available.",
    );
  }

  if (!context) {
    const suite = await getFingerprintSuite(browser);
    try {
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
      context = await createFingerprintedContext(
        browser,
        profile,
        synchronized,
      );
    } catch (error) {
      if (getFingerprintFallbackStrategy() !== "profile") {
        await browser.close().catch(() => {});
        throw error;
      }
      const profile = buildFallbackFingerprintProfile(
        suite.chromeVersion,
        suite.chromeMajorVersion,
      );
      context = await createFingerprintedContext(browser, profile, null, {
        injectFingerprint: false,
      });
    }
  } else {
    await prepareSharedContext(context);
  }

  return {
    browser,
    context,
    userDataDir,
    proxy: selectedProxy,
    proxy_strategy: proxyPlan.strategy,
    browserProfile,
    launchPolicy,
    sharedConnection: false,
    ownsBrowser: !persistentContext,
    ownsContext: true,
    disconnect: async () => browser.close(),
  };
}

/**
 * Close an isolated browser and remove its temporary profile directory.
 */
export async function closeEphemeralBrowser(session) {
  if (!session) return;
  try {
    if (session.sharedConnection) {
      if (session.ownsContext && session.context?.close) {
        await session.context.close().catch(() => {});
      }
      if (typeof session.disconnect === "function") {
        await session.disconnect().catch(() => {});
      }
      return;
    }

    if (session.context?.close && session.ownsContext) {
      await session.context.close().catch(() => {});
    }
    if (session.browser && session.ownsBrowser !== false) {
      await session.browser.close();
    }
  } finally {
    if (session.userDataDir) {
      await fs
        .rm(session.userDataDir, { recursive: true, force: true })
        .catch(() => {});
    }
  }
}

/**
 * Get the active page from the session context.
 * In Playwright, pages are per-context; we pick the most recently navigated one.
 */
export async function getPage(
  session,
  { targetUrl = "", forceRotateFingerprint = false, browserProfile = "" } = {},
) {
  // Accept either a raw context or a { browser, context } session object
  const context = session?.context ?? session;
  if (!context || typeof context.pages !== "function") {
    throw new Error(
      "Playwright browser context is unavailable for this session.",
    );
  }
  const sharedConnection = Boolean(session?.sharedConnection);
  const effectiveBrowserProfile =
    browserProfile || session?.browserProfile || "";

  const pages = context.pages();
  const navigated = pages.filter(
    (p) => p.url() !== "about:blank" && p.url() !== "about:newtab",
  );
  const page =
    navigated[navigated.length - 1] ??
    pages.find((p) => p.url() === "about:blank") ??
    (await context.newPage());

  // Enforce viewport (context setting may be overridden by some sites)
  await page.setViewportSize(FORCED_VIEWPORT);
  await installPopupGuards(page);
  attachNetworkDiagnostics(page);
  const effectivePolicy = buildEffectivePolicy({
    browserProfile: effectiveBrowserProfile,
    targetUrl,
    currentUrl: page.url(),
    sharedConnection,
  });
  setPageEffectivePolicy(page, effectivePolicy);

  if (
    effectivePolicy.page_blocking_disabled ||
    !effectivePolicy.cosmetic_filtering_enabled
  ) {
    await disableBlockingForPage(page).catch(() => {});
  } else {
    await enableBlocking(page, { targetUrl }).catch(() => {});
  }

  return page;
}
