import crypto from 'node:crypto';

import { connectBrowser, getPage } from './browser.js';
import { screenshotFull, screenshotViewport } from './screenshot.js';
import { uploadImage } from './upload.js';

function hashValue(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

const CHALLENGE_PATTERNS = [
  /cloudflare/,
  /cf-challenge/,
  /challenge-platform/,
  /just a moment/,
  /checking your browser/,
  /verify you are human/,
  /security check/,
  /captcha/,
  /attention required/,
];

const BLOCK_PATTERNS = [
  /access denied/,
  /forbidden/,
  /temporarily unavailable/,
  /request blocked/,
  /unusual traffic/,
  /rate limit/,
  /blocked/,
];

function safeUrlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function encodeElementRef(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeElementRef(elementRef) {
  return JSON.parse(Buffer.from(elementRef, 'base64url').toString('utf8'));
}

export function summarizePurpose(url, name = '', width = 0, height = 0) {
  const haystack = `${url} ${name}`.toLowerCase();
  if (/captcha|cloudflare|verify|challenge/.test(haystack)) return 'challenge';
  if (/ad|banner|doubleclick|googlesyndication|popunder|track/.test(haystack)) return 'ad';
  if (/embed|player|stream|video/.test(haystack)) return 'player';
  if (width >= 300 && height >= 180) return 'content';
  return 'unknown';
}

export function detectAccessStateFromSignals({
  title = '',
  textSample = '',
  htmlSample = '',
  url = '',
} = {}) {
  const haystack = `${title}\n${textSample}\n${htmlSample}\n${url}`.toLowerCase();
  const reasons = [];
  let suspectedProvider = '';

  for (const pattern of CHALLENGE_PATTERNS) {
    if (pattern.test(haystack)) {
      reasons.push(pattern.source);
    }
  }

  const challengeDetected = reasons.length > 0;
  if (/cloudflare|cf-challenge|challenge-platform/.test(haystack)) {
    suspectedProvider = 'cloudflare';
  } else if (/captcha|verify you are human|security check/.test(haystack)) {
    suspectedProvider = 'generic_challenge';
  }

  const blockReasons = [];
  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(haystack)) {
      blockReasons.push(pattern.source);
    }
  }

  const blocked = challengeDetected || blockReasons.length > 0;
  const confidence = challengeDetected
    ? 'high'
    : blockReasons.length > 0
      ? 'medium'
      : 'low';

  return {
    blocked,
    challenge_detected: challengeDetected,
    suspected_provider: suspectedProvider || 'none',
    confidence,
    reasons: [...new Set([...reasons, ...blockReasons])],
  };
}

async function collectFrameMetrics(frame) {
  try {
    return await frame.evaluate(() => {
      const body = document.body;
      const doc = document.documentElement;
      const text = (body?.innerText || '').replace(/\s+/g, ' ').trim();
      return {
        title: document.title || '',
        readyState: document.readyState || 'unknown',
        textSample: text.slice(0, 1200),
        textLength: text.length,
        htmlSample: (doc?.outerHTML || '').slice(0, 3000),
        linkCount: document.querySelectorAll('a[href]').length,
        buttonCount: document.querySelectorAll('button,[role="button"],[role="tab"],[onclick]').length,
        inputCount: document.querySelectorAll('input,textarea,select').length,
        overlayCount: document.querySelectorAll('[class*="overlay"],[class*="modal"],[class*="popup"]').length,
        videoCount: document.querySelectorAll('video').length,
        iframeCount: document.querySelectorAll('iframe').length,
      };
    });
  } catch (error) {
    return {
      title: '',
      readyState: 'error',
      textSample: '',
      textLength: 0,
      htmlSample: '',
      linkCount: 0,
      buttonCount: 0,
      inputCount: 0,
      overlayCount: 0,
      videoCount: 0,
      iframeCount: 0,
      error: error.message,
    };
  }
}

async function describeFrame(frame, framePath, rootOrigin, index = 0) {
  const frameUrl = frame.url() || '';
  const metrics = await collectFrameMetrics(frame);
  let boundingBox = null;

  if (frame.parentFrame()) {
    try {
      const frameElement = await frame.frameElement();
      boundingBox = await frameElement.boundingBox();
      await frameElement.dispose();
    } catch {
      boundingBox = null;
    }
  }

  return {
    frame_path: framePath,
    url: frameUrl,
    name: frame.name() || '',
    title: metrics.title || '',
    parent_frame_path: frame.parentFrame() ? framePath.split('.').slice(0, -1).join('.') || 'root' : null,
    child_count: frame.childFrames().length,
    index,
    accessible: !metrics.error,
    cross_origin: Boolean(rootOrigin && frameUrl && safeUrlOrigin(frameUrl) && safeUrlOrigin(frameUrl) !== rootOrigin),
    candidate_purpose: summarizePurpose(
      frameUrl,
      frame.name() || '',
      Math.round(boundingBox?.width || 0),
      Math.round(boundingBox?.height || 0),
    ),
    dimensions: boundingBox
      ? {
          x: Math.round(boundingBox.x),
          y: Math.round(boundingBox.y),
          width: Math.round(boundingBox.width),
          height: Math.round(boundingBox.height),
        }
      : null,
    signals: {
      ready_state: metrics.readyState,
      text_length: metrics.textLength,
      links: metrics.linkCount,
      buttons: metrics.buttonCount,
      inputs: metrics.inputCount,
      overlays: metrics.overlayCount,
      videos: metrics.videoCount,
      iframes: metrics.iframeCount,
    },
  };
}

async function walkFrames(frame, framePath, rootOrigin, collector, index = 0) {
  collector.push(await describeFrame(frame, framePath, rootOrigin, index));
  const children = frame.childFrames();
  for (let index = 0; index < children.length; index += 1) {
    await walkFrames(children[index], `${framePath}.${index}`, rootOrigin, collector, index);
  }
}

export async function buildFrameTree(page) {
  const frames = [];
  const rootOrigin = safeUrlOrigin(page.url());
  await walkFrames(page.mainFrame(), 'root', rootOrigin, frames, 0);
  return frames;
}

export async function resolveFrame(page, framePath = 'root') {
  if (!framePath || framePath === 'root') {
    return { ok: true, frame: page.mainFrame(), frame_path: 'root' };
  }

  const parts = String(framePath).split('.');
  if (parts[0] !== 'root') {
    return { ok: false, error: `Invalid frame_path '${framePath}'` };
  }

  let frame = page.mainFrame();
  for (let index = 1; index < parts.length; index += 1) {
    const childIndex = Number.parseInt(parts[index], 10);
    if (!Number.isInteger(childIndex) || childIndex < 0) {
      return { ok: false, error: `Invalid frame_path segment '${parts[index]}'` };
    }
    const children = frame.childFrames();
    if (childIndex >= children.length) {
      return { ok: false, error: `Frame path '${framePath}' does not exist` };
    }
    frame = children[childIndex];
  }

  return { ok: true, frame, frame_path: framePath };
}

export async function buildFrameState(page, framePath = 'root') {
  const resolved = await resolveFrame(page, framePath);
  if (!resolved.ok) {
    return {
      ok: false,
      frame_path: framePath,
      dom_epoch: '',
      page_state_id: '',
      error: resolved.error,
    };
  }

  const frame = resolved.frame;
  const metrics = await collectFrameMetrics(frame);
  const domEpoch = hashValue(`${frame.url()}|${metrics.readyState}|${metrics.textSample}|${metrics.htmlSample}`);
  const pageStateId = hashValue(`${page.url()}|${framePath}|${domEpoch}`);

  return {
    ok: true,
    frame,
    frame_path: framePath,
    dom_epoch: domEpoch,
    page_state_id: pageStateId,
    frame_metrics: metrics,
  };
}

function createXpath(node) {
  const parts = [];
  let current = node;
  while (current && current.nodeType === 1) {
    let idx = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) idx += 1;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${idx}]`);
    current = current.parentElement;
  }
  return `//${parts.join('/')}`;
}

function createSelector(node) {
  if (node.id) return `#${node.id}`;
  if (node.getAttribute('name')) return `[name="${node.getAttribute('name')}"]`;
  const classes = (node.className || '').toString().trim().split(/\s+/).filter(Boolean);
  if (classes.length > 0) return `.${classes.slice(0, 2).join('.')}`;
  return node.tagName.toLowerCase();
}

function inferKind(node) {
  const tag = node.tagName.toLowerCase();
  const type = (node.getAttribute('type') || '').toLowerCase();
  const role = (node.getAttribute('role') || '').toLowerCase();
  const classes = (node.className || '').toString().toLowerCase();

  if (tag === 'iframe') return 'iframe';
  if (tag === 'video') return 'video';
  if (tag === 'form') return 'form';
  if (tag === 'select') return 'select';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (tag === 'input' || tag === 'textarea') return 'input';
  if (role === 'tab' || classes.includes('tab')) return 'tab';
  if (classes.includes('overlay') || classes.includes('modal') || classes.includes('popup')) return 'overlay';
  if (tag === 'a' && node.getAttribute('href')) return 'link';
  if (tag === 'button' || role === 'button' || node.getAttribute('onclick')) return 'button';
  return 'element';
}

export async function collectElements(frame, framePath = 'root') {
  return frame.evaluate(({ framePathValue }) => {
    const isVisible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return rect.width > 0
        && rect.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && style.opacity !== '0';
    };

    const nodes = Array.from(
      document.querySelectorAll(
        'a[href],button,input,textarea,select,video,iframe,form,[role="button"],[role="tab"],[onclick],[class*="tab"],[class*="overlay"],[class*="modal"],[class*="popup"]',
      ),
    );

    return nodes.map((node, index) => {
      const rect = node.getBoundingClientRect();
      const attrs = {};
      for (const attr of ['href', 'src', 'name', 'placeholder', 'type', 'role', 'value', 'aria-label', 'data-server', 'data-source']) {
        const value = node.getAttribute(attr);
        if (value) attrs[attr] = value;
      }

      const text = (node.innerText || node.textContent || node.value || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const kind = (() => {
        const tag = node.tagName.toLowerCase();
        const type = (node.getAttribute('type') || '').toLowerCase();
        const role = (node.getAttribute('role') || '').toLowerCase();
        const classes = (node.className || '').toString().toLowerCase();

        if (tag === 'iframe') return 'iframe';
        if (tag === 'video') return 'video';
        if (tag === 'form') return 'form';
        if (tag === 'select') return 'select';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (tag === 'input' || tag === 'textarea') return 'input';
        if (role === 'tab' || classes.includes('tab')) return 'tab';
        if (classes.includes('overlay') || classes.includes('modal') || classes.includes('popup')) return 'overlay';
        if (tag === 'a' && node.getAttribute('href')) return 'link';
        if (tag === 'button' || role === 'button' || node.getAttribute('onclick')) return 'button';
        return 'element';
      })();

      const xpath = (() => {
        const parts = [];
        let current = node;
        while (current && current.nodeType === 1) {
          let idx = 1;
          let sibling = current.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === current.tagName) idx += 1;
            sibling = sibling.previousElementSibling;
          }
          parts.unshift(`${current.tagName.toLowerCase()}[${idx}]`);
          current = current.parentElement;
        }
        return `//${parts.join('/')}`;
      })();

      const selector = (() => {
        if (node.id) return `#${node.id}`;
        const name = node.getAttribute('name');
        if (name) return `[name="${name}"]`;
        const classes = (node.className || '').toString().trim().split(/\s+/).filter(Boolean);
        if (classes.length > 0) return `.${classes.slice(0, 2).join('.')}`;
        return `${node.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
      })();

      return {
        kind,
        tag: node.tagName.toLowerCase(),
        type: (node.getAttribute('type') || '').toLowerCase(),
        role: (node.getAttribute('role') || '').toLowerCase(),
        text,
        href: node.getAttribute('href') || '',
        src: node.getAttribute('src') || '',
        selector,
        xpath,
        attrs,
        visible: isVisible(node),
        checked: Boolean(node.checked),
        disabled: Boolean(node.disabled),
        selected: Boolean(node.selected),
        value: (node.value || '').slice(0, 200),
        frame_path: framePathValue,
        geometry: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          center_x: Math.round(rect.x + rect.width / 2),
          center_y: Math.round(rect.y + rect.height / 2),
        },
        nearby_text: (node.parentElement?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 220),
      };
    });
  }, { framePathValue: framePath });
}

export function augmentElements(elements, pageState) {
  return elements.map((element) => ({
    ...element,
    page_state_id: pageState.page_state_id,
    dom_epoch: pageState.dom_epoch,
    element_ref: encodeElementRef({
      frame_path: pageState.frame_path,
      selector: element.selector,
      xpath: element.xpath,
      text: element.text,
      tag: element.tag,
      kind: element.kind,
      dom_epoch: pageState.dom_epoch,
      page_state_id: pageState.page_state_id,
    }),
  }));
}

export function filterElements(elements, {
  kind,
  text_contains = '',
  href_contains = '',
  attr = null,
  visible_only = true,
  limit = 20,
} = {}) {
  const normalizedText = String(text_contains || '').toLowerCase();
  const normalizedHref = String(href_contains || '').toLowerCase();
  const attrName = attr?.name ? String(attr.name) : '';
  const attrValue = attr?.value_contains ? String(attr.value_contains).toLowerCase() : '';

  return elements
    .filter((element) => !kind || element.kind === kind)
    .filter((element) => !visible_only || element.visible)
    .filter((element) => !normalizedText || element.text.toLowerCase().includes(normalizedText))
    .filter((element) => !normalizedHref || element.href.toLowerCase().includes(normalizedHref))
    .filter((element) => {
      if (!attrName) return true;
      const value = element.attrs?.[attrName] || '';
      return !attrValue || String(value).toLowerCase().includes(attrValue);
    })
    .slice(0, limit);
}

async function resolveByText(frame, text) {
  const handle = await frame.evaluateHandle((needle) => {
    const normalizedNeedle = needle.toLowerCase();
    const nodes = Array.from(
      document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="tab"],[onclick],label'),
    );
    for (const node of nodes) {
      const candidate = (node.innerText || node.textContent || node.value || '').replace(/\s+/g, ' ').trim();
      if (candidate.toLowerCase().includes(normalizedNeedle)) {
        return node;
      }
    }
    return null;
  }, text);
  return handle.asElement();
}

export async function resolveElementTarget(page, {
  frame_path = 'root',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
} = {}) {
  let effectiveFramePath = frame_path || 'root';
  let locator = { selector, xpath, text };

  if (element_ref) {
    let decoded;
    try {
      decoded = decodeElementRef(element_ref);
    } catch {
      return { ok: false, code: 'invalid_element_ref', error: 'Could not decode element_ref' };
    }

    effectiveFramePath = decoded.frame_path || effectiveFramePath;
    locator = {
      selector: decoded.selector || selector,
      xpath: decoded.xpath || xpath,
      text: decoded.text || text,
    };

    const currentState = await buildFrameState(page, effectiveFramePath);
    if (!currentState.ok) {
      return { ok: false, code: 'frame_not_found', error: currentState.error };
    }
    if (decoded.dom_epoch && decoded.dom_epoch !== currentState.dom_epoch) {
      return {
        ok: false,
        code: 'stale_ref',
        error: 'element_ref is stale for the current DOM snapshot',
        frame_path: effectiveFramePath,
        page_state_id: currentState.page_state_id,
        dom_epoch: currentState.dom_epoch,
      };
    }
  }

  const frameState = await buildFrameState(page, effectiveFramePath);
  if (!frameState.ok) {
    return { ok: false, code: 'frame_not_found', error: frameState.error };
  }

  const frame = frameState.frame;
  let handle = null;
  let locatorUsed = {};

  try {
    if (locator.selector) {
      handle = await frame.waitForSelector(locator.selector, { timeout: 8000 });
      locatorUsed = { selector: locator.selector };
    } else if (locator.xpath) {
      await frame.waitForSelector(`::-p-xpath(${locator.xpath})`, { timeout: 8000 });
      const matches = await frame.$$(`::-p-xpath(${locator.xpath})`);
      handle = matches[0] || null;
      locatorUsed = { xpath: locator.xpath };
    } else if (locator.text) {
      handle = await resolveByText(frame, locator.text);
      locatorUsed = { text: locator.text };
    }
  } catch {
    handle = null;
  }

  if (!handle) {
    return {
      ok: false,
      code: 'element_not_found',
      error: 'Could not resolve an element from the provided locator',
      frame_path: effectiveFramePath,
      page_state_id: frameState.page_state_id,
      dom_epoch: frameState.dom_epoch,
    };
  }

  return {
    ok: true,
    frame,
    frame_path: effectiveFramePath,
    handle,
    locator_used: locatorUsed,
    page_state_id: frameState.page_state_id,
    dom_epoch: frameState.dom_epoch,
  };
}

export async function captureScreenshot(page, {
  handle = null,
  mode = 'viewport',
  fallbackFull = false,
} = {}) {
  try {
    if (handle) {
      const buffer = await handle.screenshot({ type: 'png' });
      const screenshotUrl = await uploadImage(`data:image/png;base64,${buffer.toString('base64')}`);
      return { ok: true, screenshot_url: screenshotUrl, screenshot_mode: 'element' };
    }

    if (mode === 'full') {
      return { ok: true, screenshot_url: await screenshotFull(page), screenshot_mode: 'full' };
    }

    return { ok: true, screenshot_url: await screenshotViewport(page), screenshot_mode: 'viewport' };
  } catch (error) {
    if (handle && fallbackFull) {
      try {
        return { ok: true, screenshot_url: await screenshotViewport(page), screenshot_mode: 'viewport' };
      } catch {
        // fall through
      }
    }

    return {
      ok: false,
      screenshot_url: '',
      screenshot_mode: mode,
      screenshot_error: error.message,
    };
  }
}

export function makeObservedChange(before, after, newTabUrls = []) {
  return {
    navigated: before.url !== after.url,
    url_changed: before.url !== after.url,
    dom_changed: before.dom_epoch !== after.dom_epoch,
    popup_opened: newTabUrls.length > 0,
    new_tab_urls: newTabUrls,
  };
}

export async function capturePageSnapshot(page, framePath = 'root') {
  const state = await buildFrameState(page, framePath);
  return {
    url: page.url(),
    frame_path: framePath,
    dom_epoch: state.dom_epoch || '',
    page_state_id: state.page_state_id || '',
  };
}

export async function buildEnvelope(page, {
  frame_path = 'root',
  title = '',
  ok = true,
  error = null,
  warnings = [],
  observed_change = null,
  screenshot = null,
  screenshotHandle = null,
  screenshotMode = 'viewport',
  data = {},
} = {}) {
  const pageState = await buildFrameState(page, frame_path);
  const accessState = detectAccessStateFromSignals({
    title: await page.title().catch(() => ''),
    textSample: pageState.frame_metrics?.textSample || '',
    htmlSample: pageState.frame_metrics?.htmlSample || '',
    url: page.url(),
  });
  const screenshotResult = screenshot || await captureScreenshot(page, {
    handle: screenshotHandle,
    mode: screenshotMode,
    fallbackFull: true,
  });

  const mergedWarnings = [...warnings];
  let finalOk = ok;
  let finalError = error;

  if (!screenshotResult.ok) {
    mergedWarnings.push(`screenshot_upload_failed: ${screenshotResult.screenshot_error}`);
    finalOk = false;
    finalError = finalError || `screenshot_upload_failed: ${screenshotResult.screenshot_error}`;
  }

  return {
    ok: finalOk && pageState.ok,
    url: page.url(),
    title: title || await page.title().catch(() => ''),
    frame_path,
    screenshot_url: screenshotResult.screenshot_url || '',
    page_state_id: pageState.page_state_id || '',
    dom_epoch: pageState.dom_epoch || '',
    error: pageState.ok ? finalError : pageState.error,
    warnings: mergedWarnings,
    observed_change,
    access_state: accessState,
    ...data,
  };
}

export async function withBrowserSession(browserWsEndpoint, run) {
  const browser = await connectBrowser(browserWsEndpoint);
  try {
    const page = await getPage(browser);
    return await run({ browser, page });
  } finally {
    await browser.disconnect();
  }
}

export function trackNewTabs(browser) {
  const newTabUrls = [];
  const listener = async (target) => {
    if (target.type() !== 'page') return;
    try {
      const popup = await target.page();
      newTabUrls.push(popup.url());
      await popup.close().catch(() => {});
    } catch {
      // ignore
    }
  };

  browser.on('targetcreated', listener);
  return {
    new_tab_urls: newTabUrls,
    dispose: () => browser.off('targetcreated', listener),
  };
}

export async function readElementDetail(page, params = {}) {
  const resolved = await resolveElementTarget(page, params);
  if (!resolved.ok) {
    return { ok: false, ...resolved };
  }

  const detail = await resolved.frame.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const attrs = {};
    for (const attr of node.getAttributeNames()) {
      attrs[attr] = node.getAttribute(attr);
    }

    const nearby = node.parentElement?.innerText || '';
    return {
      tag: node.tagName.toLowerCase(),
      text: (node.innerText || node.textContent || node.value || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      html_preview: (node.outerHTML || '').slice(0, 1000),
      attrs,
      state: {
        checked: Boolean(node.checked),
        disabled: Boolean(node.disabled),
        selected: Boolean(node.selected),
        value: (node.value || '').slice(0, 300),
      },
      geometry: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        center_x: Math.round(rect.x + rect.width / 2),
        center_y: Math.round(rect.y + rect.height / 2),
      },
      nearby_text: nearby.replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  }, resolved.handle);

  const screenshot = await captureScreenshot(page, { handle: resolved.handle, fallbackFull: true });
  await resolved.handle.dispose().catch(() => {});

  return {
    ok: true,
    frame_path: resolved.frame_path,
    page_state_id: resolved.page_state_id,
    dom_epoch: resolved.dom_epoch,
    detail,
    screenshot,
  };
}

export async function getMediaSummary(frame) {
  try {
    return await frame.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('video')).slice(0, 5);
      const libraries = {
        jwplayer: Boolean(window.jwplayer),
        videojs: Boolean(window.videojs),
        hls: Boolean(window.Hls),
        dashjs: Boolean(window.dashjs),
      };

      return {
        video_count: videos.length,
        player_libraries: libraries,
        videos: videos.map((video, index) => ({
          index,
          current_src: video.currentSrc || video.src || '',
          paused: Boolean(video.paused),
          ready_state: Number(video.readyState || 0),
          network_state: Number(video.networkState || 0),
          current_time: Number(video.currentTime || 0),
          duration: Number(video.duration || 0),
          muted: Boolean(video.muted),
        })),
      };
    });
  } catch (error) {
    return {
      video_count: 0,
      player_libraries: {},
      videos: [],
      error: error.message,
    };
  }
}
