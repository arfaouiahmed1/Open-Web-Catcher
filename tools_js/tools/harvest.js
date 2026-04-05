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

import { connectBrowser, getPage } from '../shared/browser.js';
import { screenshotViewport } from '../shared/screenshot.js';

const STREAM_PATTERNS = [
  { re: /\.m3u8(\?|$)/i,   protocol: 'hls'      },
  { re: /\.mpd(\?|$)/i,    protocol: 'dash'     },
  { re: /\.mp4(\?|$)/i,    protocol: 'mp4'      },
  { re: /\.webm(\?|$)/i,   protocol: 'webm'     },
  { re: /\.ism\/manifest/i, protocol: 'smooth'   },
  { re: /manifest\.m3u8/i,  protocol: 'hls'     },
];

const isStream = url => STREAM_PATTERNS.some(({ re }) => re.test(url));
const getProtocol = url => STREAM_PATTERNS.find(({ re }) => re.test(url))?.protocol || 'unknown';

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

  const streams = new Map();  // url → stream object
  const add = (url, layer) => {
    if (url && isStream(url) && !streams.has(url)) {
      streams.set(url, { url, protocol: getProtocol(url), source_layer: layer });
    }
  };

  // Layer 1: CDP network interception
  const client = await page.createCDPSession();
  await client.send('Network.enable');
  client.on('Network.requestWillBeSent', ({ request }) => add(request.url, 'cdp-request'));
  client.on('Network.responseReceived', ({ response }) => add(response.url, 'cdp-response'));

  // Layer 2: Puppeteer response events
  page.on('response', res => add(res.url(), 'response-intercept'));

  // Also attach to player iframe if provided
  let iframePage = null;
  if (player_iframe_url) {
    try {
      const frames = page.frames();
      iframePage = frames.find(f => f.url().includes(player_iframe_url.replace(/^https?:\/\//, '').split('/')[0]));
      if (iframePage) {
        iframePage.on('response', res => add(res.url(), 'iframe-response'));
        const iClient = await iframePage.createCDPSession();
        await iClient.send('Network.enable');
        iClient.on('Network.requestWillBeSent', ({ request }) => add(request.url, 'iframe-cdp'));
      }
    } catch (_) { /* iframe may be cross-origin */ }
  }

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
  };
}
