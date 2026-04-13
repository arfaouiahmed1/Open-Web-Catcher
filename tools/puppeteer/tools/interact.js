/**
 * tools/interact.js — Reliable interaction tool with explicit locator strategy,
 * frame targeting, and verification signals for fallback decisions.
 */

import { connectBrowser, getPage } from '../shared/browser.js';
import { screenshotViewport } from '../shared/screenshot.js';
import { resolveElementTarget } from '../shared/tool-runtime.js';

const delay = (min = 80, max = 300) =>
  new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

const RESOLVE_TIMEOUT_MS = 8000;

/**
 * @param {{
 *   mode: 'click'|'play'|'type'|'select'|'coordinates'|'check'|'checkbox'|'radio',
 *   element_ref?: string,
 *   selector?: string,
 *   xpath?: string,
 *   text?: string,
 *   value?: string,
 *   option_text?: string,
 *   option_value?: string,
 *   checked?: boolean,
 *   frame_path?: string,
 *   frame_url_contains?: string,
 *   locator_strategy?: 'strict'|'xpath_first'|'selector_first'|'text_first',
 *   x?: number,
 *   y?: number,
 *   fallback_to_coordinates?: boolean,
 *   wait_ms?: number,
 *   browserWsEndpoint?: string,
 * }} params
 */
export async function interact({
  mode = 'click',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  value = '',
  option_text = '',
  option_value = '',
  checked,
  frame_path = 'root',
  frame_url_contains = '',
  locator_strategy = 'strict',
  x,
  y,
  fallback_to_coordinates = true,
  wait_ms = 3000,
  browserWsEndpoint,
} = {}) {
  const browser = await connectBrowser(browserWsEndpoint);
  const page = await getPage(browser);
  const beforeUrl = page.url();

  let success = false;
  let executed = false;
  let verified = false;
  let error = null;
  let verification_reason = 'interaction not attempted';
  let locator_used = null;
  let target_before = null;
  let target_after = null;
  let before_state = null;
  let after_state = null;
  let frame_info = {
    frame_path,
    frame_url: page.url(),
  };
  const new_tab_urls = [];

  const locator_attempt = {
    locator_strategy,
    provided: {
      element_ref: Boolean(element_ref),
      xpath: Boolean(xpath),
      selector: Boolean(selector),
      text: Boolean(text),
    },
  };

  // Capture new tabs (usually ad popups — record but ignore)
  const targetCreatedListener = async (target) => {
    if (target.type() === 'page' && target !== page.target()) {
      const p = await target.page();
      new_tab_urls.push(p.url() || 'about:blank');
      await p.close().catch(() => {});
    }
  };
  browser.on('targetcreated', targetCreatedListener);

  let resolvedFrame = page.mainFrame();
  let resolvedFramePath = 'root';
  let elementHandle = null;
  let point_before = null;
  let point_after = null;
  let fallback_used = '';
  let element_resolution = null;

  try {
    const frameResolution = await _resolveFrame(page, frame_path, frame_url_contains);
    resolvedFrame = frameResolution.frame;
    resolvedFramePath = frameResolution.frame_path;
    frame_info = {
      frame_path: resolvedFramePath,
      frame_url: resolvedFrame.url(),
    };

    before_state = await _captureState(page, resolvedFrame);

    switch (mode) {
      case 'click': {
        let resolved;
        try {
          resolved = await _resolveActionTarget(page, resolvedFrame, resolvedFramePath, {
            element_ref,
            selector,
            xpath,
            text,
            locator_strategy,
          });
        } catch (resolveError) {
          if (fallback_to_coordinates && Number.isFinite(x) && Number.isFinite(y)) {
            point_before = await _elementAtPoint(page, x, y);
            await _performCoordinateClick(page, x, y);
            point_after = await _elementAtPoint(page, x, y);
            locator_used = { kind: 'coordinates_fallback' };
            fallback_used = 'coordinates';
            executed = true;
            break;
          }
          throw resolveError;
        }
        elementHandle = resolved.handle;
        locator_used = resolved.used;
        element_resolution = resolved.resolution || element_resolution;
        resolvedFrame = resolved.frame || resolvedFrame;
        resolvedFramePath = resolved.frame_path || resolvedFramePath;
        frame_info = {
          frame_path: resolvedFramePath,
          frame_url: resolvedFrame.url(),
        };
        before_state = await _captureState(page, resolvedFrame);
        target_before = await _snapshotElement(elementHandle);
        await delay();
        await elementHandle.click();
        executed = true;
        break;
      }

      case 'play': {
        let playedViaElement = false;
        if (element_ref || selector || xpath || text) {
          try {
            const resolved = await _resolveActionTarget(page, resolvedFrame, resolvedFramePath, {
              element_ref,
              selector,
              xpath,
              text,
              locator_strategy,
            });
            elementHandle = resolved.handle;
            locator_used = resolved.used;
            element_resolution = resolved.resolution || element_resolution;
            resolvedFrame = resolved.frame || resolvedFrame;
            resolvedFramePath = resolved.frame_path || resolvedFramePath;
            frame_info = {
              frame_path: resolvedFramePath,
              frame_url: resolvedFrame.url(),
            };
            before_state = await _captureState(page, resolvedFrame);
            target_before = await _snapshotElement(elementHandle);
            await delay(50, 150);
            await elementHandle.click();
            playedViaElement = true;
          } catch (resolveError) {
            if (fallback_to_coordinates && Number.isFinite(x) && Number.isFinite(y)) {
              point_before = await _elementAtPoint(page, x, y);
              await _performCoordinateClick(page, x, y);
              point_after = await _elementAtPoint(page, x, y);
              locator_used = { kind: 'coordinates_fallback' };
              fallback_used = 'coordinates';
              playedViaElement = true;
            } else {
              throw resolveError;
            }
          }
        }

        const playAttempted = await resolvedFrame.evaluate(() => {
          const video = document.querySelector('video');
          if (!video) return false;
          video.muted = true;
          const maybePromise = video.play?.();
          if (maybePromise && typeof maybePromise.catch === 'function') {
            maybePromise.catch(() => {});
          }
          return true;
        }).catch(() => false);

        executed = playedViaElement || playAttempted;
        break;
      }

      case 'type': {
        const resolved = await _resolveActionTarget(page, resolvedFrame, resolvedFramePath, {
          element_ref,
          selector,
          xpath,
          text,
          locator_strategy,
        });
        elementHandle = resolved.handle;
        locator_used = resolved.used;
        element_resolution = resolved.resolution || element_resolution;
        resolvedFrame = resolved.frame || resolvedFrame;
        resolvedFramePath = resolved.frame_path || resolvedFramePath;
        frame_info = {
          frame_path: resolvedFramePath,
          frame_url: resolvedFrame.url(),
        };
        before_state = await _captureState(page, resolvedFrame);
        target_before = await _snapshotElement(elementHandle);

        await elementHandle.click({ clickCount: 3 });
        await elementHandle.evaluate((node) => {
          if ('value' in node) node.value = '';
        });
        await delay(50, 100);
        await elementHandle.type(value, { delay: 45 + Math.random() * 70 });
        executed = true;
        break;
      }

      case 'select': {
        const resolved = await _resolveActionTarget(page, resolvedFrame, resolvedFramePath, {
          element_ref,
          selector,
          xpath,
          text,
          locator_strategy,
        });
        elementHandle = resolved.handle;
        locator_used = resolved.used;
        element_resolution = resolved.resolution || element_resolution;
        resolvedFrame = resolved.frame || resolvedFrame;
        resolvedFramePath = resolved.frame_path || resolvedFramePath;
        frame_info = {
          frame_path: resolvedFramePath,
          frame_url: resolvedFrame.url(),
        };
        before_state = await _captureState(page, resolvedFrame);
        target_before = await _snapshotElement(elementHandle);

        const selected = await elementHandle.evaluate((node, payload) => {
          if (!node || node.tagName?.toLowerCase() !== 'select') {
            throw new Error('Target element is not a <select>');
          }
          const options = Array.from(node.options || []);
          let chosen = null;

          if (payload.option_value) {
            chosen = options.find((option) => option.value === payload.option_value) || null;
          }
          if (!chosen && payload.option_text) {
            const needle = String(payload.option_text).toLowerCase();
            chosen = options.find((option) => (option.textContent || '').toLowerCase().includes(needle)) || null;
          }
          if (!chosen && options.length) {
            chosen = options[0];
          }
          if (!chosen) {
            throw new Error('No selectable option found');
          }

          node.value = chosen.value;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));

          return {
            value: node.value,
            text: (chosen.textContent || '').trim(),
          };
        }, { option_text, option_value });

        locator_attempt.selected_option = selected;
        executed = true;
        break;
      }

      case 'coordinates': {
        if (x == null || y == null) throw new Error('x and y are required for coordinates mode');
        point_before = await _elementAtPoint(page, x, y);
        await _performCoordinateClick(page, x, y);
        point_after = await _elementAtPoint(page, x, y);
        executed = true;
        break;
      }

      case 'checkbox':
      case 'check': {
        let resolved;
        try {
          resolved = await _resolveActionTarget(page, resolvedFrame, resolvedFramePath, {
            element_ref,
            selector,
            xpath,
            text,
            locator_strategy,
          });
        } catch (resolveError) {
          if (fallback_to_coordinates && Number.isFinite(x) && Number.isFinite(y)) {
            point_before = await _elementAtPoint(page, x, y);
            await _performCoordinateClick(page, x, y);
            point_after = await _elementAtPoint(page, x, y);
            locator_used = { kind: 'coordinates_fallback' };
            fallback_used = 'coordinates';
            executed = true;
            break;
          }
          throw resolveError;
        }

        elementHandle = resolved.handle;
        locator_used = resolved.used;
        element_resolution = resolved.resolution || element_resolution;
        resolvedFrame = resolved.frame || resolvedFrame;
        resolvedFramePath = resolved.frame_path || resolvedFramePath;
        frame_info = {
          frame_path: resolvedFramePath,
          frame_url: resolvedFrame.url(),
        };
        before_state = await _captureState(page, resolvedFrame);
        target_before = await _snapshotElement(elementHandle);

        const desired = typeof checked === 'boolean' ? checked : true;
        const beforeChecked = Boolean(target_before?.checked);
        if (beforeChecked !== desired) {
          await elementHandle.click();
        }

        locator_attempt.desired_checked = desired;
        executed = true;
        break;
      }

      case 'radio': {
        let resolved;
        try {
          resolved = await _resolveActionTarget(page, resolvedFrame, resolvedFramePath, {
            element_ref,
            selector,
            xpath,
            text,
            locator_strategy,
          });
        } catch (resolveError) {
          if (fallback_to_coordinates && Number.isFinite(x) && Number.isFinite(y)) {
            point_before = await _elementAtPoint(page, x, y);
            await _performCoordinateClick(page, x, y);
            point_after = await _elementAtPoint(page, x, y);
            locator_used = { kind: 'coordinates_fallback' };
            fallback_used = 'coordinates';
            executed = true;
            break;
          }
          throw resolveError;
        }

        elementHandle = resolved.handle;
        locator_used = resolved.used;
        element_resolution = resolved.resolution || element_resolution;
        resolvedFrame = resolved.frame || resolvedFrame;
        resolvedFramePath = resolved.frame_path || resolvedFramePath;
        frame_info = {
          frame_path: resolvedFramePath,
          frame_url: resolvedFrame.url(),
        };
        before_state = await _captureState(page, resolvedFrame);
        target_before = await _snapshotElement(elementHandle);
        await elementHandle.click();
        executed = true;
        break;
      }

      default:
        throw new Error(`Unknown interact mode: ${mode}`);
    }

    await delay(50, 140);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: Math.max(wait_ms, 1200) }).catch(() => {});

    after_state = await _captureState(page, resolvedFrame);
    if (elementHandle) {
      target_after = await _snapshotElement(elementHandle);
    }

    const verification = _verifyInteraction({
      mode,
      value,
      option_text,
      option_value,
      checked,
      before_state,
      after_state,
      target_before,
      target_after,
      point_before,
      point_after,
      new_tab_urls,
    });

    verified = verification.verified;
    verification_reason = verification.reason;
    success = executed && verified;
  } catch (e) {
    error = e?.message || String(e);
    success = false;
    verified = false;
    verification_reason = `interaction failed: ${error}`;
  } finally {
    browser.off('targetcreated', targetCreatedListener);
    if (elementHandle) {
      await elementHandle.dispose().catch(() => {});
    }
  }

  const finalUrl = page.url();
  const navigated = beforeUrl !== finalUrl;
  let screenshot_url = null;
  try {
    screenshot_url = await screenshotViewport(page);
  } catch (_) {
    screenshot_url = null;
  }

  await browser.disconnect();
  return {
    success,
    executed,
    verified,
    verification_reason,
    fallback_used,
    mode,
    navigated,
    new_tab_urls,
    url: finalUrl,
    frame: frame_info,
    locator: {
      ...locator_attempt,
      used: locator_used,
      fallback_used,
      element_resolution,
    },
    before_state,
    after_state,
    target_before,
    target_after,
    point_before,
    point_after,
    screenshot_url,
    error,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _framePathDepth(framePath) {
  if (!framePath || framePath === 'root') return 0;
  return framePath.split('.').length - 1;
}

function _buildFramePathMap(page) {
  const map = new Map();
  const root = page.mainFrame();
  map.set(root, 'root');

  const queue = [root];
  while (queue.length) {
    const frame = queue.shift();
    const path = map.get(frame) || 'root';
    const children = frame.childFrames();
    children.forEach((child, index) => {
      const childPath = `${path}.${index}`;
      map.set(child, childPath);
      queue.push(child);
    });
  }

  return map;
}

function _resolveFrameByPath(page, framePath) {
  if (!framePath || framePath === 'root') {
    return page.mainFrame();
  }

  const indexes = framePath
    .split('.')
    .slice(1)
    .map((chunk) => Number.parseInt(chunk, 10));

  let current = page.mainFrame();
  for (const index of indexes) {
    const children = current.childFrames();
    if (!Number.isInteger(index) || index < 0 || index >= children.length) {
      return null;
    }
    current = children[index];
  }

  return current;
}

async function _resolveFrame(page, framePath, frameUrlContains) {
  const frameMap = _buildFramePathMap(page);

  if (framePath && framePath !== 'root') {
    const frame = _resolveFrameByPath(page, framePath);
    if (!frame) {
      throw new Error(`Could not resolve frame_path: ${framePath}`);
    }
    return {
      frame,
      frame_path: frameMap.get(frame) || framePath,
    };
  }

  if (frameUrlContains) {
    const needle = String(frameUrlContains).toLowerCase();
    const candidates = page.frames().filter((frame) => (frame.url() || '').toLowerCase().includes(needle));
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        const aPath = frameMap.get(a) || 'root';
        const bPath = frameMap.get(b) || 'root';
        return _framePathDepth(bPath) - _framePathDepth(aPath);
      });
      const frame = candidates[0];
      return {
        frame,
        frame_path: frameMap.get(frame) || 'root',
      };
    }
    throw new Error(`No frame matched frame_url_contains='${frameUrlContains}'`);
  }

  return {
    frame: page.mainFrame(),
    frame_path: 'root',
  };
}

function _orderedLocators({ selector, xpath, text, locator_strategy }) {
  const provided = [];
  if (xpath) provided.push({ kind: 'xpath', value: xpath });
  if (selector) provided.push({ kind: 'selector', value: selector });
  if (text) provided.push({ kind: 'text', value: text });

  if (!provided.length) {
    return [];
  }

  if (locator_strategy === 'strict') {
    return [provided[0]];
  }

  if (locator_strategy === 'selector_first') {
    return [
      ...(selector ? [{ kind: 'selector', value: selector }] : []),
      ...(xpath ? [{ kind: 'xpath', value: xpath }] : []),
      ...(text ? [{ kind: 'text', value: text }] : []),
    ];
  }

  if (locator_strategy === 'text_first') {
    return [
      ...(text ? [{ kind: 'text', value: text }] : []),
      ...(xpath ? [{ kind: 'xpath', value: xpath }] : []),
      ...(selector ? [{ kind: 'selector', value: selector }] : []),
    ];
  }

  return [
    ...(xpath ? [{ kind: 'xpath', value: xpath }] : []),
    ...(selector ? [{ kind: 'selector', value: selector }] : []),
    ...(text ? [{ kind: 'text', value: text }] : []),
  ];
}

async function _performCoordinateClick(page, x, y) {
  const midX = x * 0.6 + Math.random() * 40;
  const midY = y * 0.6 + Math.random() * 40;
  await page.mouse.move(midX, midY, { steps: 8 });
  await delay(40, 100);
  await page.mouse.move(x, y, { steps: 6 });
  await delay(30, 80);
  await page.mouse.click(x, y);
}

async function _resolveActionTarget(page, frame, framePath, {
  element_ref,
  selector,
  xpath,
  text,
  locator_strategy,
}) {
  const hasLocatorFallback = Boolean(selector || xpath || text);

  if (element_ref) {
    const resolvedFromRef = await resolveElementTarget(page, {
      frame_path: framePath,
      element_ref,
      selector,
      xpath,
      text,
    });

    if (resolvedFromRef.ok && resolvedFromRef.handle) {
      return {
        handle: resolvedFromRef.handle,
        used: { kind: 'element_ref' },
        frame: resolvedFromRef.frame,
        frame_path: resolvedFromRef.frame_path || framePath,
        resolution: {
          stale_ref_detected: Boolean(resolvedFromRef.stale_ref_detected),
          frame_fallback_applied: Boolean(resolvedFromRef.frame_fallback_applied),
          frame_relocated: Boolean(resolvedFromRef.frame_relocated),
          resolution_attempts: resolvedFromRef.resolution_attempts || [],
        },
      };
    }

    if (!hasLocatorFallback) {
      throw new Error(resolvedFromRef.error || 'Could not resolve element_ref target');
    }

    const resolvedFromLocator = await _resolveElement(frame, {
      selector,
      xpath,
      text,
      locator_strategy,
    });
    return {
      handle: resolvedFromLocator.handle,
      used: resolvedFromLocator.used,
      frame,
      frame_path: framePath,
      resolution: {
        stale_ref_detected: Boolean(resolvedFromRef.stale_ref_detected),
        frame_fallback_applied: Boolean(resolvedFromRef.frame_fallback_applied),
        frame_relocated: false,
        element_ref_error: resolvedFromRef.error || '',
        resolution_attempts: resolvedFromRef.resolution_attempts || [],
      },
    };
  }

  const resolved = await _resolveElement(frame, {
    selector,
    xpath,
    text,
    locator_strategy,
  });
  return {
    handle: resolved.handle,
    used: resolved.used,
    frame,
    frame_path: framePath,
    resolution: null,
  };
}

async function _isHandleInteractable(handle) {
  try {
    return await handle.evaluate((element) => {
      if (!element || !element.isConnected) return false;
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(element);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
      if (Number(style.opacity || '1') === 0) return false;
      if (typeof element.disabled === 'boolean' && element.disabled) return false;
      return true;
    });
  } catch {
    return false;
  }
}

async function _pickBestHandle(handles = []) {
  if (!handles.length) return null;

  let fallback = null;
  for (const handle of handles) {
    if (!fallback) {
      fallback = handle;
    }
    if (await _isHandleInteractable(handle)) {
      for (const other of handles) {
        if (other !== handle) {
          await other.dispose().catch(() => {});
        }
      }
      return handle;
    }
  }

  for (const other of handles) {
    if (other !== fallback) {
      await other.dispose().catch(() => {});
    }
  }
  return fallback;
}

async function _resolveElement(frame, {
  selector,
  xpath,
  text,
  locator_strategy,
}) {
  const locators = _orderedLocators({ selector, xpath, text, locator_strategy });
  if (!locators.length) {
    throw new Error('No locator provided. Supply xpath, selector, or text.');
  }

  let lastError = null;
  for (const locator of locators) {
    try {
      let handle = null;

      if (locator.kind === 'selector') {
        handle = await frame.waitForSelector(locator.value, {
          timeout: RESOLVE_TIMEOUT_MS,
          visible: true,
        });
      } else if (locator.kind === 'xpath') {
        const xpathSelector = `::-p-xpath(${locator.value})`;
        await frame.waitForSelector(xpathSelector, { timeout: RESOLVE_TIMEOUT_MS });
        const nodes = await frame.$$(xpathSelector);
        handle = await _pickBestHandle(nodes);
      } else if (locator.kind === 'text') {
        const textHandle = await frame.evaluateHandle((needle) => {
          const normalizedNeedle = String(needle || '').toLowerCase();
          const candidates = document.querySelectorAll('button, a, [role="button"], input, label, select, [onclick], [data-server], [data-source]');
          for (const element of candidates) {
            const rect = element.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) continue;
            const style = window.getComputedStyle(element);
            if (!style) continue;
            if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
            if (Number(style.opacity || '1') === 0) continue;
            const textValue = (element.innerText || element.textContent || element.value || '').trim().toLowerCase();
            if (textValue && textValue.includes(normalizedNeedle)) {
              return element;
            }
          }
          return null;
        }, locator.value);
        handle = textHandle.asElement();
        if (!handle) {
          await textHandle.dispose().catch(() => {});
        }
      }

      if (handle) {
        return {
          handle,
          used: locator,
        };
      }
      lastError = new Error(`Locator '${locator.kind}' found no element`);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message || `Could not resolve element with locator strategy '${locator_strategy}'`);
}

async function _snapshotElement(handle) {
  if (!handle) return null;
  try {
    return await handle.evaluate((element) => ({
      tag: element.tagName?.toLowerCase() || '',
      type: (element.getAttribute?.('type') || '').toLowerCase(),
      text: String(element.innerText || element.textContent || element.value || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      value: 'value' in element ? String(element.value ?? '') : null,
      checked: typeof element.checked === 'boolean' ? Boolean(element.checked) : null,
      disabled: Boolean(element.disabled),
      aria_selected: element.getAttribute?.('aria-selected') || null,
      class_name: String(element.className || '').slice(0, 120),
    }));
  } catch {
    return { detached: true };
  }
}

async function _captureState(page, frame) {
  const pageTitle = await page.title().catch(() => '');
  const frameData = await frame.evaluate(() => {
    const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const videos = Array.from(document.querySelectorAll('video'));
    const playingVideos = videos.filter((video) => !video.paused && video.readyState >= 2).length;
    return {
      frame_url: location.href,
      frame_ready_state: document.readyState,
      node_count: document.querySelectorAll('*').length,
      text_sample: text,
      text_len: text.length,
      video_count: videos.length,
      playing_videos: playingVideos,
    };
  }).catch(() => ({
    frame_url: frame.url(),
    frame_ready_state: 'unknown',
    node_count: 0,
    text_sample: '',
    text_len: 0,
    video_count: 0,
    playing_videos: 0,
  }));

  return {
    page_url: page.url(),
    page_title: pageTitle,
    ...frameData,
    text_hash: _hash(frameData.text_sample),
  };
}

function _hash(value) {
  const text = String(value || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

async function _elementAtPoint(page, x, y) {
  return page.evaluate(({ x: pointX, y: pointY }) => {
    const element = document.elementFromPoint(pointX, pointY);
    if (!element) return null;
    return {
      tag: element.tagName?.toLowerCase() || '',
      text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      selector: element.id
        ? `#${element.id}`
        : element.className
          ? `.${String(element.className).trim().split(/\s+/)[0]}`
          : element.tagName.toLowerCase(),
      x: Math.round(pointX),
      y: Math.round(pointY),
    };
  }, { x, y }).catch(() => null);
}

function _verifyInteraction({
  mode,
  value,
  option_text,
  option_value,
  checked,
  before_state,
  after_state,
  target_before,
  target_after,
  point_before,
  point_after,
  new_tab_urls,
}) {
  const navigated = before_state?.page_url !== after_state?.page_url;
  const frameMutated = (before_state?.text_hash !== after_state?.text_hash)
    || (before_state?.node_count !== after_state?.node_count)
    || (before_state?.playing_videos !== after_state?.playing_videos);
  const targetChanged = JSON.stringify(target_before || {}) !== JSON.stringify(target_after || {});
  const openedTab = (new_tab_urls || []).length > 0;

  if (mode === 'type') {
    const ok = String(target_after?.value || '').includes(String(value || ''));
    return {
      verified: ok,
      reason: ok ? 'typed value verified on target element' : 'typed value could not be verified on target element',
    };
  }

  if (mode === 'select') {
    const expectedValue = option_value || option_text || '';
    const actual = String(target_after?.value || target_after?.text || '');
    const ok = expectedValue ? actual.toLowerCase().includes(String(expectedValue).toLowerCase()) : Boolean(actual);
    return {
      verified: ok,
      reason: ok ? 'selected option verified' : 'selected option not confirmed on target element',
    };
  }

  if (mode === 'check' || mode === 'checkbox') {
    const desired = typeof checked === 'boolean' ? checked : true;
    const ok = target_after?.checked === desired;
    return {
      verified: ok,
      reason: ok ? `checkbox state verified (${desired})` : `checkbox state mismatch (expected ${desired})`,
    };
  }

  if (mode === 'radio') {
    const ok = target_after?.checked === true;
    return {
      verified: ok,
      reason: ok ? 'radio selection verified' : 'radio selection could not be verified',
    };
  }

  if (mode === 'play') {
    const playingIncreased = (after_state?.playing_videos || 0) > (before_state?.playing_videos || 0);
    const ok = playingIncreased || navigated || frameMutated || targetChanged || openedTab;
    return {
      verified: ok,
      reason: ok ? 'play action produced observable change' : 'play action had no observable player change',
    };
  }

  if (mode === 'coordinates') {
    const pointChanged = JSON.stringify(point_before || {}) !== JSON.stringify(point_after || {});
    const ok = pointChanged || navigated || frameMutated || openedTab;
    return {
      verified: ok,
      reason: ok ? 'coordinate click produced observable change' : 'coordinate click had no observable change',
    };
  }

  const ok = navigated || frameMutated || targetChanged || openedTab;
  return {
    verified: ok,
    reason: ok ? 'interaction produced observable change' : 'interaction had no observable change',
  };
}
