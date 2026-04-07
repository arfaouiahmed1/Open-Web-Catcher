import {
  buildEnvelope,
  buildFrameState,
  captureScreenshot,
  getMediaSummary,
  resolveFrame,
  withBrowserSession,
} from '../shared/tool-runtime.js';

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

export async function captureStreams({
  frame_path = 'root',
  duration_ms = 12000,
  player_iframe_hint = '',
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const frameState = await buildFrameState(page, frame_path);
    if (!frameState.ok) {
      return buildEnvelope(page, { frame_path, ok: false, error: frameState.error });
    }

    const targetFrame = frameState.frame;
    const streams = new Map();
    const evidence = [];

    const add = (url, source_layer) => {
      if (!url || !isStream(url) || streams.has(url)) return;
      streams.set(url, {
        url,
        protocol: getProtocol(url),
        source_layer,
      });
      evidence.push({ url, source_layer });
    };

    const pageClient = await page.createCDPSession();
    await pageClient.send('Network.enable');
    pageClient.on('Network.requestWillBeSent', ({ request }) => add(request.url, 'page_cdp_request'));
    pageClient.on('Network.responseReceived', ({ response }) => add(response.url, 'page_cdp_response'));
    page.on('response', (response) => add(response.url(), 'page_response'));

    let hintedFrame = null;
    if (player_iframe_hint) {
      hintedFrame = page.frames().find((frame) => frame.url().includes(player_iframe_hint));
    }
    const effectiveFrame = hintedFrame || targetFrame;

    let frameClient = null;
    try {
      frameClient = await effectiveFrame.createCDPSession();
      await frameClient.send('Network.enable');
      frameClient.on('Network.requestWillBeSent', ({ request }) => add(request.url, 'frame_cdp_request'));
      frameClient.on('Network.responseReceived', ({ response }) => add(response.url, 'frame_cdp_response'));
    } catch {
      frameClient = null;
    }

    await new Promise((resolve) => setTimeout(resolve, duration_ms));

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

    await pageClient.detach().catch(() => {});
    if (frameClient) {
      await frameClient.detach().catch(() => {});
    }

    const result = Array.from(streams.values());
    return buildEnvelope(page, {
      frame_path,
      screenshot,
      data: {
        duration_ms,
        player_iframe_hint,
        evidence,
        media_state,
        streams: result,
        m3u8_urls: result.filter((entry) => entry.protocol === 'hls').map((entry) => entry.url),
        mpd_urls: result.filter((entry) => entry.protocol === 'dash').map((entry) => entry.url),
        mp4_urls: result.filter((entry) => ['mp4', 'webm'].includes(entry.protocol)).map((entry) => entry.url),
        total_streams: result.length,
      },
    });
  });
}
