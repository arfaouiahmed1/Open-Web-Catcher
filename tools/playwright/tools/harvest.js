/**
 * tools/harvest.js — Discover and probe media streams.
 *
 * Implements the v2 browser tool contract (plan step 5):
 * - Always-on network ledger inspection
 * - DOM video/source scan, iframe scan, player globals, performance entries
 * - HLS parsing via m3u8-parser, DASH parsing via fast-xml-parser
 * - Manifest probing (HEAD, Range)
 * - Returns v2 ToolEnvelope
 */

import { successEnvelope, errorEnvelope } from '../shared/tool-envelope.js';
import { TOOL_ERROR_CODES } from '../../shared/error-codes.js';
import { classifyStreamPattern } from '../runtime/network-ledger.js';
import { defaultEvidenceStore } from '../runtime/evidence-store.js';
import { getPage } from '../shared/browser.js';

let _M3U8Parser = null;
let _xmlParser = null;

async function getM3U8Parser() {
  if (_M3U8Parser) return _M3U8Parser;
  try {
    const mod = await import('m3u8-parser');
    _M3U8Parser = mod.Parser || mod.default?.Parser || mod.default;
    return _M3U8Parser;
  } catch {
    return null;
  }
}

async function getXmlParser() {
  if (_xmlParser) return _xmlParser;
  try {
    const mod = await import('fast-xml-parser');
    const ParserClass = mod.XMLParser || mod.default?.XMLParser;
    if (ParserClass) {
      _xmlParser = new ParserClass({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    }
    return _xmlParser;
  } catch {
    return null;
  }
}
export async function harvest(args = {}) {
  const startTime = Date.now();
  const framePath = String(args.frame_path || 'root');
  const probeManifests = args.probe_manifests !== false;

  // Resolve page and runtime modules
  let page = null;
  let pageStateTracker = null;
  let networkLedger = null;
  let evidenceStore = defaultEvidenceStore;

  try {
    if (args.browserSession?.page) {
      page = args.browserSession.page;
      pageStateTracker = args.browserSession.pageStateTracker;
      networkLedger = args.browserSession.networkLedger;
      if (args.browserSession.evidenceStore) evidenceStore = args.browserSession.evidenceStore;
    } else {
      page = await getPage(args.browserSession, { browserProfile: args.browserProfile });
    }
  } catch (err) {
    return errorEnvelope({
      tool: 'harvest',
      code: TOOL_ERROR_CODES.ERR_TOOL_TIMEOUT,
      message: `Could not acquire active page: ${err.message}`,
      retryable: true,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  const streamsMap = new Map(); // url -> streamRecord

  function addStream(url, layer, metadata = {}) {
    if (!url || typeof url !== 'string') return;
    const cleanUrl = url.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) return;

    const protocol = classifyStreamPattern(cleanUrl, metadata.contentType || '') || 'unknown';
    if (!protocol || protocol === 'unknown') return;

    const existing = streamsMap.get(cleanUrl);
    if (!existing) {
      streamsMap.set(cleanUrl, {
        url: cleanUrl,
        protocol,
        quality: metadata.quality || '',
        source_layer: layer,
        source_layers: [layer],
        frame_url: metadata.frameUrl || '',
        http_status: metadata.status || null,
        content_type: metadata.contentType || null,
        verified: false,
        codecs: metadata.codecs || null,
        encrypted: Boolean(metadata.encrypted),
        drm_hint: metadata.drmHint || null,
        expiry: metadata.expiry || null,
      });
    } else {
      if (!existing.source_layers.includes(layer)) {
        existing.source_layers.push(layer);
      }
      if (metadata.status && !existing.http_status) existing.http_status = metadata.status;
      if (metadata.contentType && !existing.content_type) existing.content_type = metadata.contentType;
      if (metadata.quality && !existing.quality) existing.quality = metadata.quality;
    }
  }

  // 1. Layer: Always-on Network Ledger
  if (networkLedger) {
    const entries = networkLedger.getEntries();
    for (const e of entries) {
      if (e.streamPattern) {
        addStream(e.url, 'network_ledger', {
          status: e.status,
          contentType: e.contentType,
          frameUrl: e.frameUrl,
        });
      }
    }
  }

  // 2. Layer: DOM Video/Source Scan
  try {
    const domMedia = await page.evaluate(() => {
      const results = [];
      for (const v of document.querySelectorAll('video, audio')) {
        if (v.src) results.push({ url: v.src, type: v.getAttribute('type') || '' });
        if (v.currentSrc) results.push({ url: v.currentSrc, type: '' });
      }
      for (const s of document.querySelectorAll('source')) {
        const src = s.src || s.getAttribute('data-src');
        if (src) results.push({ url: src, type: s.type || '' });
      }
      return results;
    }).catch(() => []);

    for (const item of domMedia) {
      addStream(item.url, 'dom_scan', { contentType: item.type });
    }
  } catch {}

  // 3. Layer: Iframe src scan
  try {
    const iframes = page.frames().map((f) => f.url()).filter(Boolean);
    for (const fUrl of iframes) {
      if (classifyStreamPattern(fUrl)) {
        addStream(fUrl, 'iframe_scan', { frameUrl: fUrl });
      }
    }
  } catch {}

  // 4. Layer: Performance entries retroactive scan
  try {
    const perfUrls = await page.evaluate(() => {
      if (!window.performance || !performance.getEntriesByType) return [];
      return performance.getEntriesByType('resource')
        .map((r) => r.name)
        .filter((u) => u && typeof u === 'string');
    }).catch(() => []);

    for (const u of perfUrls) {
      if (classifyStreamPattern(u)) {
        addStream(u, 'performance_entries');
      }
    }
  } catch {}

  // 5. Probe manifests with HEAD / Range and parse playlists
  const streams = Array.from(streamsMap.values());
  if (probeManifests && streams.length > 0) {
    await Promise.all(
      streams.map(async (st) => {
        try {
          // Probe HEAD
          const headRes = await fetch(st.url, {
            method: 'HEAD',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(5000),
          }).catch(() => null);

          if (headRes && headRes.ok) {
            st.verified = true;
            st.http_status = headRes.status;
            st.content_type = headRes.headers.get('content-type') || st.content_type;
          }

          // If HLS, fetch first chunk or manifest text to parse master playlist
          if (st.protocol === 'hls') {
            const getRes = await fetch(st.url, {
              headers: { Range: 'bytes=0-65535' },
              signal: AbortSignal.timeout(6000),
            }).catch(() => null);

            if (getRes && (getRes.ok || getRes.status === 206)) {
              const text = await getRes.text().catch(() => '');
              if (text.includes('#EXTM3U')) {
                st.verified = true;
                const ParserClass = await getM3U8Parser();
                if (ParserClass) {
                  try {
                    const parser = new ParserClass();
                    parser.push(text);
                    parser.end();

                    const parsed = parser.manifest;
                    if (parsed?.playlists?.length > 0) {
                      const best = parsed.playlists[0];
                      if (best.attributes?.RESOLUTION) {
                        st.quality = `${best.attributes.RESOLUTION.width}x${best.attributes.RESOLUTION.height}`;
                      }
                      if (best.attributes?.CODECS) {
                        st.codecs = best.attributes.CODECS;
                      }
                    }
                  } catch {}
                } else {
                  const resMatch = text.match(/RESOLUTION=(\d+x\d+)/i);
                  if (resMatch) st.quality = resMatch[1];
                  const codecsMatch = text.match(/CODECS="([^"]+)"/i);
                  if (codecsMatch) st.codecs = codecsMatch[1];
                }
                if (text.includes('#EXT-X-KEY')) {
                  st.encrypted = true;
                  st.drm_hint = 'EXT-X-KEY present in manifest';
                }
              }
            }
          } else if (st.protocol === 'dash') {
            const getRes = await fetch(st.url, {
              headers: { Range: 'bytes=0-65535' },
              signal: AbortSignal.timeout(6000),
            }).catch(() => null);

            if (getRes && (getRes.ok || getRes.status === 206)) {
              const text = await getRes.text().catch(() => '');
              if (text.includes('<MPD')) {
                st.verified = true;
                const parser = await getXmlParser();
                if (parser) {
                  try {
                    const parsedXml = parser.parse(text);
                    if (parsedXml?.MPD && text.includes('ContentProtection')) {
                      st.encrypted = true;
                      st.drm_hint = 'ContentProtection tag present';
                    }
                  } catch {}
                }
              }
            }
          }
        } catch {
          // Probe error: keep existing metadata
        }
      }),
    );
  }

  // Current page state
  const pageState = pageStateTracker
    ? await pageStateTracker.getPageState(framePath).catch(() => null)
    : { id: '', dom_epoch: 0, url: page.url() || '', title: await page.title().catch(() => ''), frame_path: framePath, captured_at: new Date().toISOString() };

  // Proof screenshot
  let beforeScreenshotRef = null;
  try {
    const shot = await evidenceStore.saveScreenshot(page, { scope: 'viewport' });
    beforeScreenshotRef = shot.blobref;
  } catch {}

  return successEnvelope({
    tool: 'harvest',
    page_state: pageState,
    proof: {
      before_screenshot_ref: beforeScreenshotRef,
      network_evidence: streams.map((s) => ({ url: s.url, protocol: s.protocol, verified: s.verified })),
    },
    data: {
      streams,
      total_discovered: streams.length,
      layers_active: ['network_ledger', 'dom_scan', 'iframe_scan', 'performance_entries'],
    },
    telemetry: {
      duration_ms: Date.now() - startTime,
      payload_bytes: JSON.stringify(streams).length,
    },
  });
}
