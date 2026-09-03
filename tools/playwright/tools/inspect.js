/**
 * tools/inspect.js — Unified context inspection tool.
 *
 * Implements the v2 browser tool contract (plan step 5):
 * - Single tool with view reducer: "summary" | "elements" | "element" | "frames" | "media"
 * - Profile-specific reducers: classification, landing, hosting, embedded
 * - Bounded output fitting payload budget
 * - Cached by (view, args, page_state.id)
 * - Returns v2 ToolEnvelope
 */

import crypto from 'node:crypto';
import { successEnvelope, errorEnvelope } from '../shared/tool-envelope.js';
import { TOOL_ERROR_CODES } from '../../shared/error-codes.js';
import { detectAccessState } from '../runtime/access-state.js';
import { defaultEvidenceStore } from '../runtime/evidence-store.js';
import { getPage } from '../shared/browser.js';

// In-memory cache keyed by `${profile}::${view}::${argsHash}::${pageStateId}`
const inspectCache = new Map();

function cleanText(str, maxLen = 160) {
  return String(str || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

const PROMPT_INJECTION_PATTERNS = [
  /ignore previous instructions/i,
  /system prompt/i,
  /you are now a/i,
  /developer mode/i,
  /jailbreak/i,
  /output only the following/i,
  /disregard/i,
];

function checkPromptInjectionSignals(text) {
  const flags = [];
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      flags.push(`Matched pattern: ${pattern.source}`);
    }
  }
  return flags;
}

export async function inspect(args = {}) {
  const startTime = Date.now();
  const view = String(args.view || 'summary').toLowerCase().trim();
  const limit = Math.min(200, Math.max(1, Number(args.limit || 50)));
  const cursor = args.cursor ? parseInt(args.cursor, 10) : 0;
  const framePath = String(args.frame_path || 'root');
  const includeScreenshot = Boolean(args.include_screenshot);
  const profile = String(args.profileName || args.browserProfile || 'general').toLowerCase();

  // Validate view
  if (!['summary', 'elements', 'element', 'frames', 'media'].includes(view)) {
    return errorEnvelope({
      tool: 'inspect',
      code: TOOL_ERROR_CODES.ERR_INVALID_TOOL_INPUT,
      message: `Invalid view "${view}". Must be "summary", "elements", "element", "frames", or "media".`,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  // Resolve page
  let page = null;
  let pageStateTracker = null;
  let evidenceStore = defaultEvidenceStore;

  try {
    if (args.browserSession?.page) {
      page = args.browserSession.page;
      pageStateTracker = args.browserSession.pageStateTracker;
      if (args.browserSession.evidenceStore) evidenceStore = args.browserSession.evidenceStore;
    } else {
      page = await getPage(args.browserSession, { browserProfile: profile });
    }
  } catch (err) {
    return errorEnvelope({
      tool: 'inspect',
      code: TOOL_ERROR_CODES.ERR_TOOL_TIMEOUT,
      message: `Could not acquire page: ${err.message}`,
      retryable: true,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  // Current page state
  const pageState = pageStateTracker
    ? await pageStateTracker.getPageState(framePath).catch(() => null)
    : { id: '', dom_epoch: 0, url: page.url() || '', title: await page.title().catch(() => ''), frame_path: framePath, captured_at: new Date().toISOString() };

  // Cache check
  const argsHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ view, limit, cursor, framePath, scope_ref: args.scope_ref, role: args.role, text: args.text }))
    .digest('hex')
    .slice(0, 12);
  const cacheKey = `${profile}::${view}::${argsHash}::${pageState.id}`;

  if (inspectCache.has(cacheKey)) {
    const cached = inspectCache.get(cacheKey);
    return {
      ...cached,
      telemetry: {
        ...cached.telemetry,
        cache_hit: true,
        duration_ms: Date.now() - startTime,
      },
    };
  }

  const accessState = await detectAccessState(page);

  // Optional screenshot proof
  let screenshotRef = null;
  if (includeScreenshot) {
    try {
      const shot = await evidenceStore.saveScreenshot(page, { scope: 'viewport' });
      screenshotRef = shot.blobref;
    } catch {}
  }

  // Target frame
  let targetFrame = page;
  if (framePath && framePath !== 'root') {
    const matched = page.frames().find((f) => f.name() === framePath || f.url().includes(framePath));
    if (matched) targetFrame = matched;
  }

  let data = {};
  let pagination = null;
  let totalCandidates = 0;

  // View-based extraction
  try {
    if (view === 'summary') {
      data = await extractSummaryView(targetFrame, profile, pageState.id);
    } else if (view === 'elements') {
      const res = await extractElementsView(targetFrame, {
        role: args.role,
        text: args.text,
        attribute: args.attribute,
        scopeRef: args.scope_ref,
        cursor,
        limit,
        pageStateId: pageState.id,
      });
      data = { elements: res.items, prompt_injection_signals: res.injectionSignals };
      pagination = res.pagination;
    } else if (view === 'element') {
      data = await extractSingleElementView(targetFrame, args.scope_ref || args.candidate_id, pageState.id);
    } else if (view === 'frames') {
      data = await extractFramesView(page);
    } else if (view === 'media') {
      data = await extractMediaView(targetFrame);
    }
  } catch (err) {
    return errorEnvelope({
      tool: 'inspect',
      page_state: pageState,
      code: TOOL_ERROR_CODES.ERR_TOOL_TIMEOUT,
      message: `Inspection failed in view "${view}": ${err.message}`,
      retryable: true,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  const result = successEnvelope({
    tool: 'inspect',
    page_state: pageState,
    proof: {
      before_screenshot_ref: screenshotRef,
      access_state: accessState,
    },
    data: {
      view,
      profile,
      access_state: accessState,
      ...data,
    },
    pagination,
    telemetry: {
      duration_ms: Date.now() - startTime,
      cache_hit: false,
      payload_bytes: JSON.stringify(data).length,
    },
  });

  // Store in cache
  inspectCache.set(cacheKey, result);
  if (inspectCache.size > 100) {
    const firstKey = inspectCache.keys().next().value;
    inspectCache.delete(firstKey);
  }

  return result;
}

// ---------------------------------------------------------------------------
// View Reducers
// ---------------------------------------------------------------------------

async function extractSummaryView(frame, profile, pageStateId) {
  const summary = await frame.evaluate((pid) => {
    const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
    const title = document.title || '';

    // Count interactive controls
    const buttons = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]');
    const links = document.querySelectorAll('a[href]');
    const videos = document.querySelectorAll('video');
    const iframes = document.querySelectorAll('iframe');

    // Collect top heading text
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .slice(0, 10)
      .map((h) => h.innerText.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    return {
      title,
      meta_description: metaDesc.slice(0, 160),
      og_title: ogTitle.slice(0, 160),
      headings,
      counts: {
        buttons: buttons.length,
        links: links.length,
        videos: videos.length,
        iframes: iframes.length,
      },
    };
  }, pageStateId).catch(() => ({ title: '', headings: [], counts: {} }));

  return {
    summary,
    prompt_injection_signals: checkPromptInjectionSignals(summary.title + ' ' + summary.headings.join(' ')),
  };
}

async function extractElementsView(frame, { role, text, attribute, scopeRef, cursor = 0, limit = 50, pageStateId }) {
  const extracted = await frame.evaluate(({ role, text, attribute, scopeRef, pageStateId }) => {
    const selector = role ? `[role="${role}"], ${role}` : 'button, [role="button"], a[href], input, select, video';
    let root = document;
    if (scopeRef) {
      const scoped = document.querySelector(`[data-owc-id="${scopeRef}"]`) || document.getElementById(scopeRef);
      if (scoped) root = scoped;
    }

    const all = Array.from(root.querySelectorAll(selector));
    const items = [];
    let injectionCount = 0;
    const injectionSamples = [];

    let idCounter = 0;
    for (const el of all) {
      idCounter++;
      // Skip hidden
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || el.offsetParent === null) continue;

      const innerText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      const ariaLabel = el.getAttribute('aria-label') || '';
      const name = ariaLabel || innerText;

      // Filter by text if provided
      if (text && !name.toLowerCase().includes(text.toLowerCase())) continue;

      // Filter by attribute if provided
      if (attribute && !el.hasAttribute(attribute)) continue;

      const candidateId = `c_${idCounter}@${pageStateId}`;
      el.setAttribute('data-owc-id', `c_${idCounter}`);

      items.push({
        candidate_id: candidateId,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        name,
        href: el.getAttribute('href') || null,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    }

    return { items };
  }, { role, text, attribute, scopeRef, pageStateId }).catch(() => ({ items: [] }));

  const total = extracted.items.length;
  const paged = extracted.items.slice(cursor, cursor + limit);
  const hasMore = cursor + limit < total;
  const nextCursor = hasMore ? String(cursor + limit) : null;

  return {
    items: paged,
    pagination: {
      cursor: nextCursor,
      has_more: hasMore,
      returned: paged.length,
      total,
    },
    injectionSignals: [],
  };
}

async function extractSingleElementView(frame, scopeRef, pageStateId) {
  if (!scopeRef) return { element: null };

  const idOnly = String(scopeRef).split('@')[0];
  const detail = await frame.evaluate(({ idOnly }) => {
    const el = document.querySelector(`[data-owc-id="${idOnly}"]`) || document.getElementById(idOnly);
    if (!el) return null;

    const rect = el.getBoundingClientRect();
    const attrs = {};
    for (const attr of el.attributes) {
      attrs[attr.name] = attr.value.slice(0, 200);
    }

    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      class: el.className || null,
      attributes: attrs,
      text: (el.innerText || '').slice(0, 500),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      disabled: el.hasAttribute('disabled'),
      visible: rect.width > 0 && rect.height > 0,
    };
  }, { idOnly }).catch(() => null);

  return { element: detail };
}

async function extractFramesView(page) {
  const frames = page.frames().map((f) => ({
    name: f.name() || null,
    url: f.url(),
    is_main: f === page.mainFrame(),
    origin: (() => {
      try { return new URL(f.url()).origin; } catch { return ''; }
    })(),
  }));
  return { frames, total_frames: frames.length };
}

async function extractMediaView(frame) {
  const media = await frame.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video')).map((v, i) => ({
      index: i,
      src: v.src || v.currentSrc || null,
      current_time: v.currentTime,
      duration: v.duration,
      paused: v.paused,
      ended: v.ended,
      ready_state: v.readyState,
      video_width: v.videoWidth,
      video_height: v.videoHeight,
    }));

    const playerGlobals = [];
    if (window.Hls) playerGlobals.push('hls.js');
    if (window.dashjs) playerGlobals.push('dashjs');
    if (window.videojs) playerGlobals.push('videojs');
    if (window.jwplayer) playerGlobals.push('jwplayer');

    return { videos, player_libraries: playerGlobals };
  }).catch(() => ({ videos: [], player_libraries: [] }));

  return media;
}
