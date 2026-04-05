/**
 * harvest.js — 6-layer CDP stream detection.
 *
 * CLI usage:
 *   node harvest.js '<json>'
 *
 * JSON payload:
 *   { browserWSEndpoint, waitSeconds?, includeIframes? }
 *
 * Layers:
 *   1. Network request interception (CDP Network.requestWillBeSent)
 *   2. XHR/fetch response interception (page.on('response'))
 *   3. <source> / <video src> element scan
 *   4. iframe src collection
 *   5. Service worker network events (if accessible)
 *   6. JS variable memory scan (window.__hls__, videojs instances, etc.)
 *
 * Output (stdout JSON):
 *   { streams: [{ url, protocol, quality, sourceLayer }], total }
 */

"use strict";

const { connectBrowser, getPage } = require("./shared/browser");

const STREAM_PATTERNS = [
  { re: /\.m3u8(\?|$)/i,  protocol: "hls" },
  { re: /\.mpd(\?|$)/i,   protocol: "dash" },
  { re: /\.mp4(\?|$)/i,   protocol: "mp4" },
  { re: /\.ts(\?|$)/i,    protocol: "ts-segment" },
  { re: /\.webm(\?|$)/i,  protocol: "webm" },
  { re: /manifest/i,      protocol: "manifest" },
];

function detectProtocol(url) {
  for (const { re, protocol } of STREAM_PATTERNS) {
    if (re.test(url)) return protocol;
  }
  return "unknown";
}

function isStreamUrl(url) {
  return STREAM_PATTERNS.some(({ re }) => re.test(url));
}

async function main() {
  const params = JSON.parse(process.argv[2] || "{}");
  const { browserWSEndpoint, waitSeconds = 5, includeIframes = true } = params;

  if (!browserWSEndpoint) throw new Error("browserWSEndpoint is required");

  const browser = await connectBrowser(browserWSEndpoint);
  const page = await getPage(browser);

  const streams = new Map(); // url → stream object

  function addStream(url, layer) {
    if (!streams.has(url)) {
      streams.set(url, { url, protocol: detectProtocol(url), quality: "", sourceLayer: layer });
    }
  }

  // Layer 1: CDP network events
  const client = await page.createCDPSession();
  await client.send("Network.enable");
  client.on("Network.requestWillBeSent", ({ request }) => {
    if (isStreamUrl(request.url)) addStream(request.url, "network-cdp");
  });

  // Layer 2: Puppeteer response events
  page.on("response", (res) => {
    if (isStreamUrl(res.url())) addStream(res.url(), "response-intercept");
  });

  // Wait for network activity
  await new Promise((r) => setTimeout(r, waitSeconds * 1000));

  // Layer 3: <source> and <video> elements
  const domStreams = await page.evaluate(() => {
    const urls = [];
    document.querySelectorAll("video, source").forEach((el) => {
      const src = el.src || el.currentSrc || el.getAttribute("src") || "";
      if (src) urls.push(src);
    });
    return urls;
  });
  domStreams.forEach((u) => addStream(u, "dom-elements"));

  // Layer 4: iframe srcs
  if (includeIframes) {
    const iframeSrcs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("iframe")).map((f) => f.src).filter(Boolean)
    );
    iframeSrcs.forEach((u) => { if (isStreamUrl(u)) addStream(u, "iframe-src"); });
  }

  // Layer 5: JS memory scan (videojs, hls.js, dashjs, jwplayer)
  const jsStreams = await page.evaluate(() => {
    const found = [];
    try {
      // Hls.js
      if (window.Hls?.instances) window.Hls.instances.forEach((h) => found.push(h.url));
      // videojs
      if (window.videojs) {
        Object.values(window.videojs.players || {}).forEach((p) => {
          const src = p?.currentSrc?.();
          if (src) found.push(src);
        });
      }
      // JW Player
      if (window.jwplayer) {
        const jw = window.jwplayer();
        const src = jw?.getPlaylistItem?.()?.file;
        if (src) found.push(src);
      }
      // Dash.js
      if (window.dashjs?.MediaPlayer) {
        // dashjs exposes nothing easily without the instance reference
      }
      // Generic: scan window object keys for m3u8 strings
      JSON.stringify(window.__streams__ || window.__playlist__ || {})
        .match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/gi)
        ?.forEach((u) => found.push(u));
    } catch (_) {}
    return found;
  });
  jsStreams.forEach((u) => { if (u) addStream(u, "js-memory"); });

  // Layer 6: service worker (limited access from page context)
  const swStreams = await page.evaluate(async () => {
    const found = [];
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      // Can't intercept SW requests from here directly — placeholder layer
    } catch (_) {}
    return found;
  });
  swStreams.forEach((u) => addStream(u, "service-worker"));

  await client.detach();
  await browser.disconnect();

  const result = Array.from(streams.values()).filter((s) => isStreamUrl(s.url));
  process.stdout.write(JSON.stringify({ streams: result, total: result.length }));
}

main().catch((err) => {
  process.stderr.write(err.message + "\n");
  process.exit(1);
});
