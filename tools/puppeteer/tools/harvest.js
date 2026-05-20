/**
 * tools/harvest.js — 6-layer CDP stream detection.
 *
 * Layers:
 *   1. CDP Network.requestWillBeSent  (before request leaves browser)
 *   2. Puppeteer response events      (after response headers arrive)
 *   3. <video>/<source> DOM elements
 *   4. iframe src scan
 *   5. JS player object inspection    (hls.js, videojs, jwplayer, dashjs)
 *   6. performance.getEntriesByType retroactive scan
 */

import {
  connectBrowser,
  getIframeDiagnostics,
  getPage,
  getPageNetworkDiagnostics,
} from '../shared/browser.js';
import { screenshotViewport } from '../shared/screenshot.js';

const STREAM_PATTERNS = [
  { re: /\.m3u8(\?|$)/i,   protocol: 'hls'      },
  { re: /\.mpd(\?|$)/i,    protocol: 'dash'     },
  { re: /\.mp4(\?|$)/i,    protocol: 'mp4'      },
  { re: /\.(m4s|ts)(\?|$)/i, protocol: 'segment' },
  { re: /\.webm(\?|$)/i,   protocol: 'webm'     },
  { re: /\.ism\/manifest/i, protocol: 'smooth'   },
  { re: /manifest\.m3u8/i,  protocol: 'hls'     },
  { re: /\/(?:hls|live|stream|video|broadcast|secure)\/.*(?:master|index|chunklist|playlist|manifest|mono)(?:[.-]|$|\?)/i, protocol: 'hls' },
  { re: /(?:[?&](?:format|type|protocol)=hls|[?&](?:hls|m3u8|playlist|manifest)=)/i, protocol: 'hls' },
  { re: /(?:[?&](?:format|type|protocol)=dash|[?&](?:dash|mpd)=)/i, protocol: 'dash' },
];

const isStream = url => STREAM_PATTERNS.some(({ re }) => re.test(url));
const getProtocol = url => STREAM_PATTERNS.find(({ re }) => re.test(url))?.protocol || 'unknown';

function normalizeHost(value) {
  const input = String(value || '').trim();
  if (!input) return '';

  try {
    return new URL(input).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return input.replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase();
  }
}

/**
 * @param {{
 *   duration_ms?: number,
 *   player_iframe_url?: string,
 *   browserWsEndpoint?: string,
 * }} params
 */
export async function harvest({
  duration_ms = 12_000,
  player_iframe_url = '',
  browserWsEndpoint,
} = {}) {
  const browser = await connectBrowser(browserWsEndpoint);
  const page    = await getPage(browser);
  const targetIframeHost = normalizeHost(player_iframe_url);

  const isTargetIframeUrl = (candidate) => {
    if (!targetIframeHost) return false;
    const host = normalizeHost(candidate);
    return Boolean(host) && (host === targetIframeHost || host.endsWith(`.${targetIframeHost}`));
  };

  const streams = new Map();  // url → stream object
  const add = (url, layer, metadata = {}) => {
    if (!url || !isStream(url)) return;

    const existing = streams.get(url);
    if (!existing) {
      streams.set(url, {
        url,
        protocol: getProtocol(url),
        source_layer: layer,
        source_layers: [layer],
        frame_url: metadata.frame_url || '',
        resource_type: metadata.resource_type || '',
        status: metadata.status ?? null,
        error_text: metadata.error_text || '',
      });
      return;
    }

    if (!existing.source_layers.includes(layer)) {
      existing.source_layers.push(layer);
    }
    if (!existing.frame_url && metadata.frame_url) {
      existing.frame_url = metadata.frame_url;
    }
    if (!existing.resource_type && metadata.resource_type) {
      existing.resource_type = metadata.resource_type;
    }
    if (existing.status == null && metadata.status != null) {
      existing.status = metadata.status;
    }
    if (!existing.error_text && metadata.error_text) {
      existing.error_text = metadata.error_text;
    }
  };

  // Layer 1: CDP network interception
  const client = await page.createCDPSession();
  await client.send('Network.enable');
  client.on('Network.requestWillBeSent', ({ request, type }) => {
    const sourceLayer = isTargetIframeUrl(request?.url) ? 'iframe-cdp-request' : 'cdp-request';
    add(request?.url, sourceLayer, { resource_type: type || '' });
  });
  client.on('Network.responseReceived', ({ response, type }) => {
    const sourceLayer = isTargetIframeUrl(response?.url) ? 'iframe-cdp-response' : 'cdp-response';
    add(response?.url, sourceLayer, {
      resource_type: type || '',
      status: response?.status ?? null,
    });
  });

  // Layer 2: Puppeteer response events
  page.on('response', (res) => {
    const frameUrl = res.frame?.()?.url?.() || '';
    const sourceLayer = isTargetIframeUrl(frameUrl) || isTargetIframeUrl(res.url())
      ? 'iframe-response'
      : 'response-intercept';
    add(res.url(), sourceLayer, {
      frame_url: frameUrl,
      status: res.status?.() ?? null,
      resource_type: res.request?.()?.resourceType?.() || '',
    });
  });
  page.on('requestfailed', (request) => {
    const frameUrl = request.frame?.()?.url?.() || '';
    const sourceLayer = isTargetIframeUrl(frameUrl) || isTargetIframeUrl(request.url?.())
      ? 'iframe-request-failed'
      : 'request-failed';
    add(request.url?.(), sourceLayer, {
      frame_url: frameUrl,
      resource_type: request.resourceType?.() || '',
      error_text: request.failure?.()?.errorText || '',
    });
  });

  // Wait for stream traffic
  await new Promise(r => setTimeout(r, duration_ms));

  // Layer 3: DOM elements
  const domUrls = await page.evaluate(() =>
    Array.from(document.querySelectorAll('video, source')).map(el => el.src || el.currentSrc).filter(Boolean)
  );
  domUrls.forEach(u => add(u, 'dom-elements'));

  // Layer 4: iframe srcs
  const iframeSrcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe')).map(f => f.src).filter(Boolean)
  );
  iframeSrcs.forEach(u => add(u, 'iframe-src'));

  // Layer 5: JS player objects
  const jsUrls = await page.evaluate(() => {
    const found = [];
    try {
      // hls.js
      if (window.Hls?.instances) window.Hls.instances.forEach(h => h.url && found.push(h.url));
      // videojs
      Object.values(window.videojs?.players || {}).forEach(p => {
        const s = p?.currentSrc?.(); if (s) found.push(s);
      });
      // jwplayer
      const jw = window.jwplayer?.();
      const jws = jw?.getPlaylistItem?.()?.file; if (jws) found.push(jws);
      // Generic window property scan
      const raw = JSON.stringify(window.__streams__ || window.__playlist__ || {});
      (raw.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/gi) || []).forEach(u => found.push(u));
    } catch (_) {}
    return found;
  });
  jsUrls.forEach(u => u && add(u, 'js-player'));

  // Layer 6: performance.getEntriesByType retroactive scan
  const perfUrls = await page.evaluate(() => {
    try {
      return performance.getEntriesByType('resource').map(e => e.name);
    } catch (_) { return []; }
  });
  perfUrls.forEach(u => add(u, 'perf-api'));

  // Screenshot of current player state
  let screenshot_url = null;
  try { screenshot_url = await screenshotViewport(page); } catch (_) {}

  const network_diagnostics = getPageNetworkDiagnostics(page, { limit: 40 });
  const iframe_diagnostics = await getIframeDiagnostics(page, { limit: 24 });

  // Video state
  const video_state = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return 'absent';
    if (v.paused && v.readyState < 2) return 'loading';
    if (v.paused) return 'paused';
    return 'playing';
  });

  await client.detach();
  await browser.disconnect();

  const result = Array.from(streams.values());
  const m3u8 = result.filter(s => s.protocol === 'hls').map(s => s.url);
  const mpd  = result.filter(s => s.protocol === 'dash').map(s => s.url);
  const mp4  = result.filter(s => ['mp4', 'webm'].includes(s.protocol)).map(s => s.url);

  return {
    streams: result,
    m3u8_urls: m3u8,
    mpd_urls:  mpd,
    mp4_urls:  mp4,
    total:     result.length,
    video_state,
    screenshot_url,
    network_diagnostics,
    iframe_diagnostics,
  };
}
