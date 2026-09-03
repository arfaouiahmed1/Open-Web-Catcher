/**
 * shared/browser.js - Playwright browser helpers.
 *
 * Public API matches the Puppeteer version so tool files work unchanged:
 *   connectBrowser(wsEndpoint)       → { browser, context }
 *   launchEphemeralBrowser(sessionId, { browserProfile, targetHost, targetUrl })
 *                                    → { browser, context, stateDir, userDataDir }
 *   closeEphemeralBrowser(session)    (never deletes the persistent state jar)
 *   getPage(session, { targetUrl })  → Page
 *   getPageNetworkDiagnostics(page, { limit })
 *   getIframeDiagnostics(page, { limit })
 *   retryNavigationAfterAutoRecovery(page, { url, waitUntil, timeoutMs })
 *   ensureStreamCorsInjection(contextOrPage, profile)  (opt-in, T20-a)
 *   enforceWindowBounds(sessionOrBrowser, page)        (best-effort, T20-e)
 *
 * T21 persona contract (ADR-003): every launch pins ONE deterministic
 * Windows 11 x64 persona (version-matched Chrome UA + client-hint brands,
 * timezone/locale/Accept-Language bound to the proxy exit geo, no dnt) onto
 * a persistent (profile,target-host) cookie jar under
 * data/browser-state/<stable-hash>/ launched through launchPersistentContext.
 * Fingerprint rotation is removed by design; the persona is pinned per jar.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { loadBrowserDriver } from "./browser-driver.js";
import { defaultSessionManager } from "../runtime/session-manager.js";
import { PageStateTracker } from "../runtime/page-state.js";
import { NetworkLedger } from "../runtime/network-ledger.js";
import { PopupLedger } from "../runtime/popup-ledger.js";
import { LocatorEngine } from "../runtime/locator-engine.js";
import { detectAccessState } from "../runtime/access-state.js";
import { defaultEvidenceStore, EvidenceStore } from "../runtime/evidence-store.js";
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
import { buildPersona, resolvePersonaGeo } from "./persona.js";
import { resolveBrowserStateDir } from "./browser-state.js";
import {
  getBrowserRuntimeSettings,
  getEffectiveRuntimeMetadata,
} from "./runtime-config.js";

const { chromium } = await loadBrowserDriver();
const WS_ENDPOINT = process.env.BROWSER_WS_ENDPOINT || "ws://127.0.0.1:9223";
const EXECUTABLE_PATH =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/usr/local/bin/google-chrome-stable";
const CHROME_VERSION_API_URL =
  process.env.OWC_CHROME_VERSION_API_URL ||
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const CHROME_VERSION_FALLBACK = String(
  process.env.OWC_CHROME_VERSION_FALLBACK || "149.0.7827.115",
).trim();
const CHROME_VERSION_TIMEOUT_MS = Number.parseInt(
  String(process.env.OWC_CHROME_VERSION_FETCH_TIMEOUT_MS || "6000"),
  10,
);
const FORCED_VIEWPORT = { width: 1920, height: 1080 };
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
  "--disable-blink-features=AutomationControlled",

  // ── GPU / video decode ───────────────────────────────────────────────────────
  // Real GPU/renderer is preserved on purpose: no SwiftShader overrides that
  // would contradict the persona's real-laptop claims (T21/ADR-003).
  "--enable-webgl",

  // ── Media / autoplay ────────────────────────────────────────────────────────
  "--autoplay-policy=no-user-gesture-required",
  // NOTE: IsolateOrigins and site-per-process intentionally omitted — they
  // break cross-origin iframe auth flows that video player embeds depend on.
  "--disable-features=UseChromeOSDirectVideoDecoder",

  // ── Stability ────────────────────────────────────────────────────────────────
  "--no-first-run",
  "--no-default-browser-check",
  // Persist session cookies to disk so jar restarts keep the full cookie
  // state ("continue where you left off" semantics; T21 returning-visitor jar).
  "--restore-last-session",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

// Per-page state stored in WeakMaps (garbage collected with the page)
const pageCdps = new WeakMap();
const pageNetworkState = new WeakMap();
const pagePolicyState = new WeakMap();
const pageNetworkListeners = new WeakSet();
const pagePopupGuardsInstalled = new WeakSet();
let chromeVersionPromise = null;
const preparedContexts = new WeakSet();
const activePageByContext = new WeakMap();

function runtimeSetting(key) {
  return getBrowserRuntimeSettings("playwright")?.[key];
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Utility helpers (identical to Puppeteer version)
// ---------------------------------------------------------------------------

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

// Ported from puppeteer browser.js:293-305 ([TOOL-P4], plan T20-a).
function getStreamCorsPatchEnabled() {
  return parseBoolean(
    runtimeSetting("stream_cors_patch_enabled") ??
      process.env.OWC_ENABLE_STREAM_CORS_PATCH,
    false,
  );
}

function getStreamCorsIncludeCredentials() {
  return parseBoolean(
    runtimeSetting("stream_cors_include_credentials") ??
      process.env.OWC_STREAM_CORS_INCLUDE_CREDENTIALS,
    false,
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
    false,
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

function toCdpHeaderRecord(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    output[String(key).toLowerCase()] = String(value);
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
// T21 deterministic persona plumbing (ADR-003)
//
// One atomic persona per (profile,target-host) jar: version-matched Chrome
// UA/client hints from shared/persona.js, timezone/locale bound to the proxy
// exit geo (resolved once per normalized proxy identity via resolvePersonaGeo,
// fixed coherent fallback for direct/no-proxy), no fingerprint rotation.
// ---------------------------------------------------------------------------

function getHeadlessLaunchEnabled() {
  return parseBoolean(
    runtimeSetting("headless") ?? process.env.OWC_BROWSER_HEADLESS,
    true,
  );
}

const PROXY_GEO_LOOKUP_URL = String(
  process.env.OWC_PROXY_GEO_LOOKUP_URL || "https://ipapi.co/json/",
).trim();
const PROXY_GEO_LOOKUP_TIMEOUT_MS = Number.parseInt(
  String(process.env.OWC_PROXY_GEO_LOOKUP_TIMEOUT_MS || "8000"),
  10,
);

function normalizeProxyGeoKey(candidate) {
  // candidate.key is the normalized scheme|host|port|user|pass identity from
  // shared/proxy-pool.js; direct connections share one fixed key whose lookup
  // short-circuits to the fixed fallback pair.
  return candidate?.key
    ? `playwright-proxy:${String(candidate.key).trim().toLowerCase()}`
    : "playwright-direct";
}

function normalizeIpGeoPayload(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const timezone =
    source.timezone?.id ??
    source.timezone_id ??
    source.timezone ??
    source.time_zone;
  const country = String(source.country_code ?? source.countryCode ?? "").trim();
  const primaryLanguage = String(source.languages ?? source.locale ?? "")
    .split(",")[0]
    .trim();
  let locale = "";
  if (primaryLanguage.includes("-")) {
    locale = primaryLanguage;
  } else if (primaryLanguage && country) {
    locale = `${primaryLanguage}-${country.toUpperCase()}`;
  } else {
    locale = primaryLanguage;
  }
  return {
    timezoneId: typeof timezone === "string" ? timezone.trim() : "",
    locale,
  };
}

/**
 * Best-effort proxy exit-geo probe executed THROUGH the live proxied context
 * so the geography matches the actual exit IP. Any failure resolves to null
 * and resolvePersonaGeo() then caches the fixed coherent fallback pair for
 * that proxy key.
 */
async function probeProxyExitGeo(context) {
  if (
    !PROXY_GEO_LOOKUP_URL ||
    !context ||
    typeof context.newPage !== "function"
  ) {
    return null;
  }
  let page = null;
  try {
    page = await context.newPage();
    await page.goto(PROXY_GEO_LOOKUP_URL, {
      waitUntil: "domcontentloaded",
      timeout: Number.isFinite(PROXY_GEO_LOOKUP_TIMEOUT_MS)
        ? PROXY_GEO_LOOKUP_TIMEOUT_MS
        : 8000,
    });
    const bodyText = await page
      .evaluate(() => document.body?.innerText || "")
      .catch(() => "");
    return normalizeIpGeoPayload(JSON.parse(String(bodyText || "").trim()));
  } catch {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
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
  const personaLanguages =
    Array.isArray(fingerprintProfile.languages) &&
    fingerprintProfile.languages.length
      ? fingerprintProfile.languages.slice()
      : ["en-US", "en"];
  Object.defineProperty(Navigator.prototype, "language", {
    configurable: true,
    get: () => personaLanguages[0],
  });
  Object.defineProperty(Navigator.prototype, "languages", {
    configurable: true,
    get: () => personaLanguages.slice(),
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
  const attemptsKey = "__owc_popup_blocker_attempts__";
  globalThis[attemptsKey] = Array.isArray(globalThis[attemptsKey])
    ? globalThis[attemptsKey]
    : [];
  const recordOpenAttempt = (url = "", target = "", features = "") => {
    const attempts = Array.isArray(globalThis[attemptsKey])
      ? globalThis[attemptsKey]
      : [];
    attempts.push({
      url: String(url || ""),
      target: String(target || ""),
      features: String(features || ""),
      timestamp: Date.now(),
      blocked: true,
      reason: "window_open_blocked",
    });
    globalThis[attemptsKey] = attempts.slice(-30);
  };
  const noopOpen = (url = "", target = "", features = "") => {
    recordOpenAttempt(url, target, features);
    return null;
  };
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

// ---------------------------------------------------------------------------
// Stream-CORS injection suite (ported from puppeteer browser.js:1182-1318,
// [TOOL-P4], plan T20-a) + window-bounds enforcement (puppeteer :1706-1725).
//
// Engine divergence vs puppeteer original:
//  - Puppeteer injects per page via evaluateOnNewDocument inside
//    applyFingerprintProfileToPage. Playwright fingerprints at CONTEXT level
//    (covers cross-origin iframes), so the patch is installed via
//    context.addInitScript and replayed onto already-open pages.
//  - Sec-* headers are forbidden header names for JS fetch/XHR; the in-page
//    patches stay best-effort exactly like the puppeteer original. When the
//    opt-in flag is on we additionally pin the client-hint headers at the
//    network layer through a cached CDP session (Network.setExtraHTTPHeaders)
//    so stream requests carry them even when the JS patch cannot.
// ---------------------------------------------------------------------------

const streamCorsInitScript = (headerTemplate) => {
  // Use a Symbol-based flag so there is no enumerable/string global that
  // anti-bot scripts can scan for.
  const flagKey = Symbol.for("__stream_cors_patched__");
  const templateKey = Symbol.for("__stream_cors_template__");
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
      const resolved = new URL(String(requestUrl || ""), locationLike.href);
      return resolved.origin === locationLike.origin ? "same-origin" : "cross-site";
    } catch {
      return "cross-site";
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

    headers.set("Sec-Fetch-Dest", activeTemplate.secFetchDest);
    headers.set("Sec-Fetch-Mode", activeTemplate.secFetchMode);
    headers.set("Sec-Fetch-Site", computeFetchSite(requestUrl, locationLike));
    headers.set("Sec-CH-UA", activeTemplate.secChUa);
    headers.set("Sec-CH-UA-Mobile", activeTemplate.secChUaMobile);
    headers.set("Sec-CH-UA-Platform", activeTemplate.secChUaPlatform);
    headers.set("Sec-CH-UA-Full-Version", activeTemplate.secChUaFullVersion);
    if (!headers.has("Accept")) {
      headers.set("Accept", "*/*");
    }
    return headers;
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const requestUrl = typeof input === "string" ? input : input?.url;
    if (!isStreamUrl(requestUrl)) {
      return originalFetch(input, init);
    }

    const baseHeaders = init?.headers || (input instanceof Request ? input.headers : undefined);
    const activeTemplate = getTemplate();
    const headers = patchHeaders(new Headers(baseHeaders), window.location, requestUrl);
    return originalFetch(input, {
      ...init,
      mode: init?.mode || "cors",
      credentials: init?.credentials || (activeTemplate.includeCredentials ? "include" : "same-origin"),
      headers,
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
    this.__owcStreamUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function send(body) {
    if (isStreamUrl(this.__owcStreamUrl)) {
      try {
        const activeTemplate = getTemplate();
        this.withCredentials = Boolean(activeTemplate.includeCredentials);
        this.setRequestHeader(activeTemplate.originHeader, window.location.origin);
        this.setRequestHeader(activeTemplate.refererHeader, window.location.href);
        this.setRequestHeader("Sec-Fetch-Dest", activeTemplate.secFetchDest);
        this.setRequestHeader("Sec-Fetch-Mode", activeTemplate.secFetchMode);
        this.setRequestHeader("Sec-Fetch-Site", computeFetchSite(this.__owcStreamUrl, window.location));
        this.setRequestHeader("Sec-CH-UA", activeTemplate.secChUa);
        this.setRequestHeader("Sec-CH-UA-Mobile", activeTemplate.secChUaMobile);
        this.setRequestHeader("Sec-CH-UA-Platform", activeTemplate.secChUaPlatform);
        this.setRequestHeader("Sec-CH-UA-Full-Version", activeTemplate.secChUaFullVersion);
      } catch {
        // Best effort: browsers can reject restricted request headers.
      }
    }

    return originalSend.call(this, body);
  };
};

/**
 * Install the opt-in stream-CORS patch. `target` may be a BrowserContext
 * (preferred: covers every future page incl. iframes) or a single Page.
 */
export async function ensureStreamCorsInjection(target, profile) {
  // Stream CORS patching is OPT-IN because it forces credentials:include and
  // mode:cors on any request containing .m3u8/.ts/stream/playlist/manifest.
  // Most video CDNs reject credentialed CORS (no ACAO: * + ACAC: true) so the
  // patch actively breaks playback on sites like FreeShot. Only turn it on
  // for sites you know require it via OWC_ENABLE_STREAM_CORS_PATCH=true.
  if (!target || !profile || !getStreamCorsPatchEnabled()) {
    return;
  }

  const streamHeaders = {
    originHeader: "Origin",
    refererHeader: "Referer",
    secFetchDest: "empty",
    secFetchMode: "cors",
    secFetchSite: "cross-site",
    includeCredentials: getStreamCorsIncludeCredentials(),
    secChUa: profile.secChUa,
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"',
    secChUaFullVersion: `"${profile.chromeVersion}"`,
  };

  await target.addInitScript(streamCorsInitScript, streamHeaders);

  const pages = typeof target.pages === "function" ? target.pages() : [target];
  for (const page of pages) {
    await page
      .evaluate((headerTemplate) => {
        const templateKey = Symbol.for("__stream_cors_template__");
        globalThis[templateKey] = headerTemplate;
      }, streamHeaders)
      .catch(() => {});
  }

  // Network-layer pinning of the client-hint headers only (never Origin/
  // Referer globally). Gated behind the same opt-in flag; best effort.
  for (const page of pages) {
    try {
      const cdp = await getPageCdp(page);
      await cdp.send("Network.enable").catch(() => {});
      await cdp.send("Network.setExtraHTTPHeaders", {
        headers: toCdpHeaderRecord({
          "Sec-CH-UA": profile.secChUa,
          "Sec-CH-UA-Mobile": "?0",
          "Sec-CH-UA-Platform": '"Windows"',
          "Sec-CH-UA-Full-Version": `"${profile.chromeVersion}"`,
        }),
      });
    } catch {
      // Best effort: remote targets may refuse extra CDP sessions.
    }
  }
}

/**
 * Best-effort window bounds enforcement via CDP Browser.setWindowBounds
 * (puppeteer parity, plan T20-e). Accepts a session object or raw browser;
 * silently no-ops when window management is unavailable (remote providers).
 */
export async function enforceWindowBounds(sessionOrBrowser, page) {
  if (!page || typeof page.context?.newCDPSession !== "function") {
    return;
  }

  try {
    const cdp = await getPageCdp(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left: 0,
        top: 0,
        width: FORCED_VIEWPORT.width,
        height: FORCED_VIEWPORT.height,
        windowState: "normal",
      },
    });
  } catch {
    // Best effort: remote providers may not expose window management.
  }
}

const removeAutomationGlobalsInitFn = () => {
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
};

const personaPatchedPages = new WeakSet();

/**
 * Persona timezone/locale via CDP emulation, per page: Playwright exposes no
 * post-launch context-level timezone setter for persistent contexts.
 */
async function applyPersonaPageEmulation(page, persona) {
  if (!page || personaPatchedPages.has(page)) return;
  personaPatchedPages.add(page);
  try {
    const cdp = await getPageCdp(page);
    if (persona.timezoneId) {
      await cdp
        .send("Emulation.setTimezoneOverride", {
          timezoneId: persona.timezoneId,
        })
        .catch(() => {});
    }
    if (persona.locale) {
      await cdp
        .send("Emulation.setLocaleOverride", {
          locale: persona.locale,
          acceptLanguage: persona.acceptLanguage,
        })
        .catch(() => {});
    }
  } catch {
    // Best effort: contexts without CDP keep host defaults.
  }
}

const personaPreparedContexts = new WeakSet();

/**
 * Pin ONE deterministic persona onto a context: navigator/locale init
 * patches, network-layer headers, opt-in stream-CORS machinery (T20-a),
 * popup guards, and CDP timezone emulation for existing + future pages.
 */
async function applyPersonaToContext(context, persona, chromeVersion) {
  if (!context || personaPreparedContexts.has(context)) return context;
  personaPreparedContexts.add(context);
  preparedContexts.add(context);

  await context
    .addInitScript(runtimeFingerprintPatchFn, {
      userAgent: persona.userAgent,
      userAgentMetadata: persona.userAgentMetadata,
      chromeVersion,
      chromeMajorVersion: String(chromeVersion || "").split(".")[0] || "",
      languages: persona.languages,
      locale: persona.locale,
    })
    .catch(() => {});

  await context.addInitScript(removeAutomationGlobalsInitFn).catch(() => {});

  // Opt-in stream-CORS patch at context level so every future page (and
  // cross-origin iframe) inherits it ([TOOL-P4], plan T20-a).
  await ensureStreamCorsInjection(context, {
    secChUa: String(persona.headers?.["sec-ch-ua"] || ""),
    chromeVersion,
  }).catch(() => {});

  if (typeof context.setExtraHTTPHeaders === "function") {
    await context.setExtraHTTPHeaders(persona.headers).catch(() => {});
  }

  if (getPopupBlockingEnabled()) {
    await context.addInitScript(popupBlockerInitScript);
    context.on("page", async (page) => {
      try {
        await installPopupGuards(page);
      } catch {
        // ignore
      }
    });
  }

  context.on("page", (page) => {
    applyPersonaPageEmulation(page, persona).catch(() => {});
  });
  for (const page of context.pages()) {
    await applyPersonaPageEmulation(page, persona).catch(() => {});
  }

  return context;
}

/** Fresh (non-persistent) persona context, e.g. for shared CDP browsers. */
async function createPersonaContext(browser, persona, chromeVersion) {
  const context = await browser.newContext({
    viewport: FORCED_VIEWPORT,
    deviceScaleFactor: 2,
    userAgent: persona.userAgent,
    locale: persona.locale,
    timezoneId: persona.timezoneId,
    extraHTTPHeaders: persona.headers,
  });
  return applyPersonaToContext(context, persona, chromeVersion);
}

async function prepareSharedContext(context) {
  if (preparedContexts.has(context)) {
    return context;
  }

  await context.addInitScript(removeAutomationGlobalsInitFn);
  if (getPopupBlockingEnabled()) {
    await context.addInitScript(popupBlockerInitScript);
    context.on("page", async (page) => {
      try {
        await installPopupGuards(page);
      } catch {
        // ignore
      }
    });
  }
  preparedContexts.add(context);
  return context;
}

async function launchPersistentAttempt({
  launchTimeout,
  launchArgs,
  proxy = null,
  stateDir,
}) {
  const context = await chromium.launchPersistentContext(stateDir, {
    executablePath: EXECUTABLE_PATH,
    headless: getHeadlessLaunchEnabled(),
    timeout: launchTimeout,
    args: launchArgs,
    ignoreHTTPSErrors: true,
    viewport: FORCED_VIEWPORT,
    deviceScaleFactor: 2,
    proxy: proxy?.server
      ? {
          server: proxy.server,
          username: proxy.username || undefined,
          password: proxy.password || undefined,
        }
      : undefined,
  });
  return { browser: context.browser?.() ?? null, context };
}

// One live browser session per persistent state jar. Concurrent acquisitions
// for the same (profile,target-host) join the running browser instead of
// fighting over Chromium's profile lock; the jar directory itself is never
// deleted, so cookies survive complete close cycles (ADR-003).
const jarSessions = new Map();

function acquireJarSession(stateDir, launchFactory) {
  let entry = jarSessions.get(stateDir);
  if (!entry) {
    entry = { refs: 0, session: null };
    jarSessions.set(stateDir, entry);
    entry.promise = launchFactory()
      .then((session) => {
        entry.session = session;
        return session;
      })
      .catch((error) => {
        if (jarSessions.get(stateDir) === entry) {
          jarSessions.delete(stateDir);
        }
        throw error;
      });
  }
  entry.refs += 1;
  return entry.promise;
}

/** Returns true when the jar session is still shared and must stay open. */
function releaseJarSession(session) {
  const stateDir = session?.stateDir;
  const entry = stateDir ? jarSessions.get(stateDir) : null;
  if (!entry || entry.session !== session) return false;
  entry.refs -= 1;
  if (entry.refs > 0) return true;
  jarSessions.delete(stateDir);
  return false;
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
  const validationPage = await context.newPage();
  try {
    const response = await validationPage.goto(testUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    if (!response || !response.ok()) {
      throw new Error(`Proxy validation failed for ${testUrl}`);
    }
  } finally {
    if (temporaryContext) {
      await temporaryContext.close().catch(() => {});
    } else {
      // Keep the persistent jar free of validation tabs.
      await validationPage.close().catch(() => {});
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
    // Shared fallback browsers have no proxy binding: the persona uses the
    // fixed coherent fallback geo pair.
    const chromeVersion = await resolveEffectiveChromeVersion(browser);
    const persona = buildPersona({ chromeVersion, geo: null });
    context = await createPersonaContext(browser, persona, chromeVersion);
    ownsContext = true;
  } catch (error) {
    console.warn(
      "[owc-pw] persona context unavailable on shared browser:",
      error?.message || error,
    );
    context = browser.contexts()[0] || null;
    if (context) {
      await prepareSharedContext(context);
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
 * Launch an isolated browser for one MCP session on the persistent
 * (profile,target-host) state jar (T21/ADR-003).
 *
 * Returns { browser, context, stateDir, userDataDir, ... } where stateDir ===
 * userDataDir is the deterministic data/browser-state/<hash>/ jar shared by
 * every session with the same profile and target host.
 */
export async function launchEphemeralBrowser(
  sessionId,
  { browserProfile = "", targetHost = "", targetUrl = "" } = {},
) {
  const requestedHost =
    String(targetHost || "").trim() ||
    (() => {
      try {
        return new URL(String(targetUrl || "").trim()).hostname || "";
      } catch {
        return "";
      }
    })();
  const stateDir = resolveBrowserStateDir({
    profile: browserProfile,
    targetHost: requestedHost,
  });

  return acquireJarSession(stateDir, async () => {
    const launchTimeoutMs = getBrowserLaunchTimeoutMs();
    const launchTimeout = Number.isFinite(launchTimeoutMs)
      ? Math.max(0, launchTimeoutMs)
      : 45000;
    const launchArgs = [...DEFAULT_LAUNCH_ARGS, ...getExtraLaunchArgs()];
    const launchPolicy = buildEffectivePolicy({ browserProfile });

    if (launchPolicy.ubol_enabled && getUbolEnabled() && UBOL_EXTENSION_DIR) {
      try {
        await fs.access(path.join(UBOL_EXTENSION_DIR, "manifest.json"));
        launchArgs.push(`--disable-extensions-except=${UBOL_EXTENSION_DIR}`);
        launchArgs.push(`--load-extension=${UBOL_EXTENSION_DIR}`);
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
    let selectedProxy = null;

    if (proxyPlan.enabled && launchPolicy.use_proxy_on_first_attempt) {
      for (const candidate of proxyPlan.candidates) {
        try {
          const launchResult = await launchPersistentAttempt({
            launchTimeout,
            launchArgs,
            proxy: candidate,
            stateDir,
          });
          await validateProxyConnection(launchResult, {
            testUrl: proxyPlan.testUrl,
            timeoutMs: proxyPlan.validationTimeoutMs,
          });
          browser = launchResult.browser;
          context = launchResult.context;
          selectedProxy = candidate;
          markProxySuccess(proxySelectionKey, candidate);
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
        }
      }
    }

    if (!context && (!proxyPlan.enabled || proxyPlan.allowDirectFallback)) {
      const launchResult = await launchPersistentAttempt({
        launchTimeout,
        launchArgs,
        proxy: null,
        stateDir,
      });
      browser = launchResult.browser;
      context = launchResult.context;
    }

    if (!context) {
      throw new Error(
        attemptedErrors.length
          ? `No working proxy candidate was available. ${attemptedErrors.join(" | ")}`
          : "No working proxy candidate was available.",
      );
    }

    const chromeVersion = await resolveEffectiveChromeVersion(browser);
    const proxyKey = normalizeProxyGeoKey(selectedProxy);
    const geo = await resolvePersonaGeo(proxyKey, async () =>
      selectedProxy ? probeProxyExitGeo(context) : null,
    );
    const persona = buildPersona({ chromeVersion, geo });
    await applyPersonaToContext(context, persona, chromeVersion);

    return {
      browser,
      context,
      userDataDir: stateDir,
      stateDir,
      targetHost: requestedHost,
      proxy: selectedProxy,
      proxy_strategy: proxyPlan.strategy,
      browserProfile,
      launchPolicy,
      persona: {
        userAgent: persona.userAgent,
        locale: persona.locale,
        timezoneId: persona.timezoneId,
        acceptLanguage: persona.acceptLanguage,
        proxy_key: proxyKey,
        geo_source: selectedProxy ? "proxy_exit_probe" : "fixed_fallback",
      },
      sharedConnection: false,
      ownsBrowser: false,
      ownsContext: true,
      disconnect: async () => {
        if (browser) await browser.close().catch(() => {});
        else await context.close().catch(() => {});
      },
    };
  });
}

/**
 * Close an isolated browser session.
 *
 * The persistent state jar (stateDir/userDataDir under
 * data/browser-state/<hash>/) is intentionally NEVER deleted: cookies and
 * site state must survive across runs (T21/ADR-003). Jar sessions are
 * ref-counted; the underlying browser closes only with the last holder.
 */
export async function closeEphemeralBrowser(session) {
  if (!session) return;
  if (releaseJarSession(session)) return;

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
  } catch {
    // Close is best-effort; the persistent jar stays untouched regardless.
  }
}

/**
 * Get the active page from the session context.
 * In Playwright, pages are per-context; we pick the most recently navigated one.
 */
export {
  defaultSessionManager,
  PageStateTracker,
  NetworkLedger,
  PopupLedger,
  LocatorEngine,
  detectAccessState,
  defaultEvidenceStore,
  EvidenceStore,
};

export async function getPage(
  session,
  { targetUrl = "", browserProfile = "" } = {},
) {
  if (session?.page && !session.page.isClosed()) {
    return session.page;
  }
  const sharedConnection = Boolean(session?.sharedConnection);
  const effectiveBrowserProfile =
    browserProfile || session?.browserProfile || "";

  const pages = context.pages();
  const activePage = activePageByContext.get(context);
  let page = activePage && !activePage.isClosed?.() ? activePage : null;

  if (!page) {
    const navigated = pages.filter(
      (p) => p.url() !== "about:blank" && p.url() !== "about:newtab",
    );
    const nonPopupPages = [];
    for (const candidate of navigated) {
      if (!(await candidate.opener().catch(() => null))) {
        nonPopupPages.push(candidate);
      }
    }
    page =
      nonPopupPages[nonPopupPages.length - 1] ??
      navigated[navigated.length - 1] ??
      pages.find((p) => p.url() === "about:blank") ??
      (await context.newPage());
  }

  // Enforce viewport (context setting may be overridden by some sites)
  await page.setViewportSize(FORCED_VIEWPORT);
  // Best-effort OS-window bounds via CDP (puppeteer parity, plan T20-e).
  await enforceWindowBounds(session, page);
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

  setActivePage(context, page);
  return page;
}

export function setActivePage(sessionOrContext, page) {
  const context = sessionOrContext?.context ?? sessionOrContext;
  if (!context || !page || page.isClosed?.()) return;
  activePageByContext.set(context, page);
}
