import {
  buildEnvelope,
  buildFrameState,
  captureScreenshot,
  getMediaSummary,
  resolveFrame,
  withBrowserSession,
} from '../shared/tool-runtime.js';
import { getPageNetworkDiagnostics } from '../shared/browser.js';
import { getBrowserRuntimeSettings } from '../shared/runtime-config.js';

const STREAM_PATTERNS = [
  { re: /\.m3u8(\?|$)/i, protocol: 'hls' },
  { re: /\.mpd(\?|$)/i, protocol: 'dash' },
  { re: /\.mp4(\?|$)/i, protocol: 'mp4' },
  { re: /\.webm(\?|$)/i, protocol: 'webm' },
  { re: /\.ism\/manifest/i, protocol: 'smooth' },
  { re: /manifest\.m3u8/i, protocol: 'hls' },
];

const isStream = (url) => STREAM_PATTERNS.some(({ re }) => re.test(url));
const getProtocol = (url) => STREAM_PATTERNS.find(({ re }) => re.test(url))?.protocol || 'unknown';

function runtimeSetting(key) {
  return getBrowserRuntimeSettings('playwright')?.[key];
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function getMediaCaptureTimeoutMs(explicitDuration) {
  if (Number.isFinite(explicitDuration) && explicitDuration > 0) return Math.floor(explicitDuration);
  const configured = Number.parseInt(String(runtimeSetting('media_capture_timeout_ms') ?? '30000'), 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 30000;
}

function getMediaCorsDiagnosticsEnabled() {
  return parseBoolean(runtimeSetting('media_cors_patch_enabled'), false);
}

function normalizeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    normalized[String(key).toLowerCase()] = String(value);
  }
  return normalized;
}

function toOrigin(urlLike, fallbackBase = '') {
  try {
    return new URL(String(urlLike || ''), fallbackBase || undefined).origin;
  } catch {
    return '';
  }
}

function didPlaybackStart(mediaState = {}) {
  return (mediaState.videos || []).some((video) =>
    (!video.paused && (video.ready_state >= 2 || video.current_time > 0))
    || Number(video.current_time || 0) > 0,
  );
}

export async function captureStreams({
  frame_path = 'root',
  duration_ms,
  player_iframe_hint = '',
  browserWsEndpoint,
  browserProfile = '',
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const frameState = await buildFrameState(page, frame_path);
    if (!frameState.ok) {
      return buildEnvelope(page, { frame_path, ok: false, error: frameState.error });
    }

    const targetFrame = frameState.frame;
    const captureWindowMs = getMediaCaptureTimeoutMs(duration_ms);
    const detectCorsFailures = getMediaCorsDiagnosticsEnabled();
    const streams = new Map();
    const evidence = [];
    const corsFailures = [];
    const corsFailureKeys = new Set();
    let manifestResponse = null;

    const add = (url, source_layer) => {
      if (!url || !isStream(url) || streams.has(url)) return;
      streams.set(url, {
        url,
        protocol: getProtocol(url),
        source_layer,
      });
      evidence.push({ url, source_layer });
    };

    const addCorsFailure = ({ url, source_layer, reason, status = null, headers = {} }) => {
      if (!detectCorsFailures || !url) return;
      const normalizedHeaders = normalizeHeaders(headers);
      const key = [url, source_layer, reason, status, normalizedHeaders['access-control-allow-origin'] || ''].join('|');
      if (corsFailureKeys.has(key)) return;
      corsFailureKeys.add(key);
      corsFailures.push({
        url,
        source_layer,
        reason,
        status,
        access_control_allow_origin: normalizedHeaders['access-control-allow-origin'] || '',
      });
    };

    const pageClient = await page.context().newCDPSession(page);
    let frameClient = null;
    let pageResponseListener = null;
    let requestFailedListener = null;

    let hintedFrame = null;
    if (player_iframe_hint) {
      hintedFrame = page.frames().find((frame) => frame.url().includes(player_iframe_hint));
    }
    const effectiveFrame = hintedFrame || targetFrame;
    const pageOrigin = toOrigin(effectiveFrame.url(), page.url()) || toOrigin(page.url());

    try {
      await pageClient.send('Network.enable');
      pageClient.on('Network.requestWillBeSent', ({ request }) => add(request.url, 'page_cdp_request'));
      pageClient.on('Network.responseReceived', ({ response }) => {
        add(response.url, 'page_cdp_response');
        if (!manifestResponse && isStream(response.url)) {
          manifestResponse = {
            url: response.url,
            status: Number(response.status || 0) || null,
            source_layer: 'page_cdp_response',
          };
        }
        if (!detectCorsFailures || !isStream(response.url)) return;
        const responseOrigin = toOrigin(response.url, effectiveFrame.url());
        if (!responseOrigin || responseOrigin === pageOrigin) return;
        const headers = normalizeHeaders(response.headers);
        if (Number(response.status || 0) === 0) {
          addCorsFailure({ url: response.url, source_layer: 'page_cdp_response', reason: 'status_0', status: response.status, headers });
          return;
        }
        if (!headers['access-control-allow-origin']) {
          addCorsFailure({ url: response.url, source_layer: 'page_cdp_response', reason: 'missing_acao_header', status: response.status, headers });
        }
      });

      pageResponseListener = (response) => add(response.url(), 'page_response');
      page.on('response', pageResponseListener);

      requestFailedListener = (request) => {
        const requestUrl = request.url() || '';
        if (!isStream(requestUrl) && request.resourceType() !== 'media') return;
        const failureText = String(request.failure?.()?.errorText || request.failure?.() || '').toLowerCase();
        if (!failureText) return;
        if (failureText.includes('cors') || failureText.includes('cross-origin') || failureText.includes('blocked_by_response')) {
          addCorsFailure({ url: requestUrl, source_layer: 'page_requestfailed', reason: failureText });
        }
      };
      page.on('requestfailed', requestFailedListener);

      // Playwright CDP is page-scoped only (no frame-level CDP sessions).
      // Use an additional page-level session and filter events by the effective frame's URL.
      const effectiveFrameUrl = effectiveFrame.url();
      try {
        frameClient = await page.context().newCDPSession(page);
        await frameClient.send('Network.enable');
        frameClient.on('Network.requestWillBeSent', ({ request }) => {
          if (!effectiveFrameUrl || request.url.startsWith(effectiveFrameUrl.replace(/\/[^/]*$/, ''))) {
            add(request.url, 'frame_cdp_request');
          }
        });
        frameClient.on('Network.responseReceived', ({ response }) => {
          if (!effectiveFrameUrl || !response.url.startsWith(effectiveFrameUrl.replace(/\/[^/]*$/, ''))) {
            return;
          }
          add(response.url, 'frame_cdp_response');
          if (!manifestResponse && isStream(response.url)) {
            manifestResponse = {
              url: response.url,
              status: Number(response.status || 0) || null,
              source_layer: 'frame_cdp_response',
            };
          }
          if (!detectCorsFailures || !isStream(response.url)) return;
          const responseOrigin = toOrigin(response.url, effectiveFrame.url());
          if (!responseOrigin || responseOrigin === pageOrigin) return;
          const headers = normalizeHeaders(response.headers);
          if (Number(response.status || 0) === 0) {
            addCorsFailure({ url: response.url, source_layer: 'frame_cdp_response', reason: 'status_0', status: response.status, headers });
            return;
          }
          if (!headers['access-control-allow-origin']) {
            addCorsFailure({ url: response.url, source_layer: 'frame_cdp_response', reason: 'missing_acao_header', status: response.status, headers });
          }
        });
      } catch {
        frameClient = null;
      }

      await new Promise((resolve) => setTimeout(resolve, captureWindowMs));

      const domUrls = await effectiveFrame.evaluate(() =>
        Array.from(document.querySelectorAll('video, source'))
          .map((node) => node.currentSrc || node.src || node.getAttribute('src') || '')
          .filter(Boolean),
      ).catch(() => []);
      domUrls.forEach((url) => add(url, 'dom'));

      const iframeUrls = await effectiveFrame.evaluate(() =>
        Array.from(document.querySelectorAll('iframe'))
          .map((node) => node.src || node.getAttribute('src') || '')
          .filter(Boolean),
      ).catch(() => []);
      iframeUrls.forEach((url) => add(url, 'iframe_src'));

      const jsUrls = await effectiveFrame.evaluate(() => {
        const found = [];
        try {
          if (window.Hls?.instances) {
            window.Hls.instances.forEach((instance) => instance.url && found.push(instance.url));
          }
          Object.values(window.videojs?.players || {}).forEach((player) => {
            const source = player?.currentSrc?.();
            if (source) found.push(source);
          });
          const jwItem = window.jwplayer?.()?.getPlaylistItem?.();
          if (jwItem?.file) found.push(jwItem.file);
          const raw = JSON.stringify(window.__streams__ || window.__playlist__ || {});
          (raw.match(/https?:\/\/[^\s"']+\.(m3u8|mpd|mp4)[^\s"']*/gi) || []).forEach((url) => found.push(url));
        } catch {
          // ignore
        }
        return found;
      }).catch(() => []);
      jsUrls.forEach((url) => add(url, 'js_player'));

      const perfUrls = await effectiveFrame.evaluate(() => {
        try {
          return performance.getEntriesByType('resource').map((entry) => entry.name);
        } catch {
          return [];
        }
      }).catch(() => []);
      perfUrls.forEach((url) => add(url, 'performance'));

      const media_state = await getMediaSummary(effectiveFrame);
      const screenshot = await captureScreenshot(page, { mode: 'viewport' });
      const network_diagnostics = getPageNetworkDiagnostics(page, { limit: 12 });
      const result = Array.from(streams.values());
      const playbackStarted = didPlaybackStart(media_state);
      const streamEvidenceFound = result.length > 0;
      return buildEnvelope(page, {
        frame_path,
        ok: playbackStarted || streamEvidenceFound,
        error: playbackStarted || streamEvidenceFound
          ? null
          : 'No playback or stream evidence was observed during capture window.',
        screenshot,
        data: {
          duration_ms: captureWindowMs,
          capture_window_ms: captureWindowMs,
          player_iframe_hint,
          evidence,
          media_state,
          playback_started: playbackStarted,
          stream_evidence_found: streamEvidenceFound,
          verification_basis: {
            requires_playback_or_stream_evidence: true,
            stream_patterns: STREAM_PATTERNS.map((entry) => entry.protocol),
          },
          cors_failures_detected: corsFailures,
          manifest_failure: network_diagnostics.manifest_failure,
          manifest_response: manifestResponse,
          effective_policy: network_diagnostics.effective_policy,
          effective_runtime: network_diagnostics.effective_runtime,
          critical_resource_failures: network_diagnostics.critical_resource_failures,
          render_gap_signals: network_diagnostics.render_gap_signals,
          network_diagnostics,
          streams: result,
          m3u8_urls: result.filter((entry) => entry.protocol === 'hls').map((entry) => entry.url),
          mpd_urls: result.filter((entry) => entry.protocol === 'dash').map((entry) => entry.url),
          mp4_urls: result.filter((entry) => ['mp4', 'webm'].includes(entry.protocol)).map((entry) => entry.url),
          total_streams: result.length,
        },
      });
    } finally {
      if (pageResponseListener) page.off('response', pageResponseListener);
      if (requestFailedListener) page.off('requestfailed', requestFailedListener);
      await pageClient.detach().catch(() => {});
      if (frameClient) {
        await frameClient.detach().catch(() => {});
      }
    }
  }, { browserProfile });
}
