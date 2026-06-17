import {
  buildEnvelope,
  capturePageSnapshot,
  makeObservedChange,
  resolveFrame,
  resolveElementTarget,
  trackNewTabs,
  withBrowserSession,
} from '../shared/tool-runtime.js';
import { getPageNetworkDiagnostics } from '../shared/browser.js';
import { activatePlayback, getMediaRuntimeConfig as getSharedMediaRuntimeConfig } from '../shared/media-activation.js';
import { getBrowserRuntimeSettings } from '../shared/runtime-config.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function performAction(browserWsEndpoint, {
  frame_path = 'root',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  wait_ms = 1500,
  screenshot_target = true,
  execute,
}) {
  return withBrowserSession(browserWsEndpoint, async ({ browser, page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    const tabs = trackNewTabs(browser, { openerPage: page });
    const resolved = await resolveElementTarget(page, { frame_path, element_ref, selector, xpath, text });

    if (!resolved.ok) {
      tabs.dispose();
      return buildEnvelope(page, {
        frame_path: resolved.frame_path || frame_path,
        ok: false,
        error: resolved.error,
        data: {
          error_code: resolved.code || 'action_target_not_found',
          stale_ref_detected: Boolean(resolved.stale_ref_detected),
          frame_fallback_applied: Boolean(resolved.frame_fallback_applied),
          resolution_attempts: resolved.resolution_attempts || [],
        },
      });
    }

    let finalError = null;
    let resultPage = page;
    try {
      await execute({ page, frame: resolved.frame, handle: resolved.handle });
      if (wait_ms > 0) {
        await wait(wait_ms);
      }
      await page.waitForNetworkIdle({ idleTime: 300, timeout: Math.max(wait_ms, 1500) }).catch(() => {});
    } catch (error) {
      finalError = error.message;
    } finally {
      resultPage = await tabs.settle().catch(() => page) || page;
      tabs.dispose();
    }

    const popupAdopted = resultPage !== page;
    const resultFramePath = popupAdopted ? 'root' : resolved.frame_path;
    const after = await capturePageSnapshot(resultPage, resultFramePath);
    const result = await buildEnvelope(resultPage, {
      frame_path: resultFramePath,
      ok: !finalError,
      error: finalError,
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls),
      screenshotHandle: screenshot_target && !popupAdopted ? resolved.handle : null,
      data: {
        locator_used: resolved.locator_used,
        popup_adopted: popupAdopted,
        opener_url: popupAdopted ? page.url() : '',
        stale_ref_detected: Boolean(resolved.stale_ref_detected),
        frame_fallback_applied: Boolean(resolved.frame_fallback_applied),
        frame_relocated: Boolean(resolved.frame_relocated),
        resolution_attempts: resolved.resolution_attempts || [],
      },
    });
    await resolved.handle.dispose().catch(() => {});
    return result;
  });
}

export async function clickElement({
  frame_path = 'root',
  element_ref = '',
  wait_ms = 1500,
  browserWsEndpoint,
} = {}) {
  return performAction(browserWsEndpoint, {
    frame_path,
    element_ref,
    wait_ms,
    execute: async ({ handle }) => {
      await handle.click();
    },
  });
}

export async function clickCss({
  frame_path = 'root',
  selector = '',
  wait_ms = 1500,
  browserWsEndpoint,
} = {}) {
  return performAction(browserWsEndpoint, {
    frame_path,
    selector,
    wait_ms,
    execute: async ({ handle }) => {
      await handle.click();
    },
  });
}

export async function clickText({
  frame_path = 'root',
  text = '',
  wait_ms = 1500,
  browserWsEndpoint,
} = {}) {
  return performAction(browserWsEndpoint, {
    frame_path,
    text,
    wait_ms,
    execute: async ({ handle }) => {
      await handle.click();
    },
  });
}

export async function clickXpath({
  frame_path = 'root',
  xpath = '',
  wait_ms = 1500,
  browserWsEndpoint,
} = {}) {
  return performAction(browserWsEndpoint, {
    frame_path,
    xpath,
    wait_ms,
    execute: async ({ handle }) => {
      await handle.click();
    },
  });
}

export async function clickCheckbox({
  frame_path = 'root',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  checked = true,
  wait_ms = 1000,
  browserWsEndpoint,
} = {}) {
  return performAction(browserWsEndpoint, {
    frame_path,
    element_ref,
    selector,
    xpath,
    text,
    wait_ms,
    execute: async ({ handle }) => {
      const isChecked = await handle.evaluate((node) => Boolean(node.checked));
      if (checked !== isChecked) {
        await handle.click();
      }
    },
  });
}

export async function clickRadio({
  frame_path = 'root',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  wait_ms = 1000,
  browserWsEndpoint,
} = {}) {
  return performAction(browserWsEndpoint, {
    frame_path,
    element_ref,
    selector,
    xpath,
    text,
    wait_ms,
    execute: async ({ handle }) => {
      await handle.click();
    },
  });
}

export async function typeInto({
  frame_path = 'root',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  value = '',
  wait_ms = 500,
  browserWsEndpoint,
} = {}) {
  return performAction(browserWsEndpoint, {
    frame_path,
    element_ref,
    selector,
    xpath,
    text,
    wait_ms,
    execute: async ({ handle }) => {
      await handle.click({ clickCount: 3 });
      await handle.evaluate((node) => {
        if ('value' in node) node.value = '';
      });
      await handle.type(value, { delay: 40 });
    },
  });
}

export async function selectOption({
  frame_path = 'root',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  option_text = '',
  option_value = '',
  wait_ms = 1000,
  browserWsEndpoint,
} = {}) {
  return performAction(browserWsEndpoint, {
    frame_path,
    element_ref,
    selector,
    xpath,
    text,
    wait_ms,
    execute: async ({ frame, handle }) => {
      const selectorValue = await handle.evaluate((node) => {
        if (node.id) return `#${node.id}`;
        if (node.getAttribute('name')) return `[name="${node.getAttribute('name')}"]`;
        return null;
      });

      if (selectorValue && option_value) {
        await frame.select(selectorValue, option_value);
        return;
      }

      await handle.select(option_value || '');
      if (option_text && !option_value) {
        await handle.evaluate((node, desiredText) => {
          const option = Array.from(node.options || []).find((entry) =>
            (entry.textContent || '').toLowerCase().includes(String(desiredText).toLowerCase()));
          if (!option) throw new Error(`Option not found: ${desiredText}`);
          node.value = option.value;
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }, option_text);
      }
    },
  });
}

function runtimeSetting(key) {
  return getBrowserRuntimeSettings('puppeteer')?.[key];
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function parseIntegerList(value, fallback = []) {
  const rows = Array.isArray(value) ? value : fallback;
  const normalized = rows
    .map((item) => Number.parseInt(String(item ?? '').trim(), 10))
    .filter((item) => Number.isFinite(item) && item >= 0);
  return normalized.length ? normalized : fallback;
}

function getMediaRuntimeConfig() {
  const configuredAttempts = Number.parseInt(String(runtimeSetting('media_retry_count') ?? '3'), 10);
  return {
    total_attempts: Math.max(1, Number.isFinite(configuredAttempts) ? configuredAttempts : 3),
    retry_backoff_ms: parseIntegerList(runtimeSetting('media_retry_backoff_ms'), [1000, 2000, 4000]),
    verify_playback: parseBoolean(runtimeSetting('media_playback_verification_enabled'), true),
    verification_timeout_ms: 5000,
  };
}

async function primeMediaProbe(frame, { mute = false } = {}) {
  return frame.evaluate((shouldMute) => {
    const stateKey = '__owc_media_probe__';
    const state = globalThis[stateKey] || { events: [], media_error_code: null, media_error_message: '' };
    globalThis[stateKey] = state;
    const video = document.querySelector('video');
    if (!video) {
      state.has_video = false;
      return { has_video: false };
    }

    if (!video.__owcMediaProbeAttached) {
      Object.defineProperty(video, '__owcMediaProbeAttached', { value: true, configurable: true });
      const push = (name) => {
        state.events = Array.isArray(state.events) ? state.events : [];
        state.events.push(name);
        state.events = state.events.slice(-20);
      };
      ['play', 'playing', 'pause', 'waiting', 'stalled', 'loadedmetadata', 'canplay'].forEach((eventName) => {
        video.addEventListener(eventName, () => push(eventName), { passive: true });
      });
      video.addEventListener('error', () => {
        push('error');
        state.media_error_code = video.error?.code ?? null;
        state.media_error_message = video.error?.message || '';
      }, { passive: true });
    }

    if (shouldMute) {
      video.muted = true;
    }
    state.has_video = true;
    state.media_error_code = video.error?.code ?? state.media_error_code ?? null;
    state.media_error_message = video.error?.message || state.media_error_message || '';

    return {
      has_video: true,
      paused: Boolean(video.paused),
      ready_state: Number(video.readyState || 0),
      current_time: Number(video.currentTime || 0),
    };
  }, mute).catch(() => ({ has_video: false }));
}

async function readMediaProbe(frame) {
  return frame.evaluate(() => {
    const state = globalThis.__owc_media_probe__ || {};
    const video = document.querySelector('video');
    return {
      has_video: Boolean(video),
      paused: video ? Boolean(video.paused) : null,
      ready_state: Number(video?.readyState || 0),
      current_time: Number(video?.currentTime || 0),
      events: Array.isArray(state.events) ? [...state.events] : [],
      media_error_code: state.media_error_code ?? video?.error?.code ?? null,
      media_error_message: state.media_error_message || video?.error?.message || '',
    };
  }).catch(() => ({
    has_video: false,
    paused: null,
    ready_state: 0,
    current_time: 0,
    events: [],
    media_error_code: null,
    media_error_message: '',
  }));
}

function mediaProbeShowsPlayback(probe = {}) {
  return Boolean(
    (probe.events || []).includes('play')
    || (probe.events || []).includes('playing')
    || (probe.has_video && probe.paused === false && (probe.ready_state >= 2 || probe.current_time > 0)),
  );
}

async function waitForPlayback(frame, timeoutMs) {
  const startedAt = Date.now();
  let probe = await readMediaProbe(frame);
  while ((Date.now() - startedAt) < timeoutMs) {
    if (mediaProbeShowsPlayback(probe)) {
      return { started: true, probe };
    }
    await wait(250);
    probe = await readMediaProbe(frame);
  }
  return { started: mediaProbeShowsPlayback(probe), probe };
}

async function invokeMediaPlayback(frame, handle, { mute = false } = {}) {
  let clickSuccessful = false;
  let clickError = null;

  if (handle) {
    try {
      await handle.click();
      clickSuccessful = true;
    } catch (error) {
      clickError = error?.message || String(error);
    }
  }

  const playResult = await frame.evaluate(async ({ shouldMute, allowDeferred }) => {
    const video = document.querySelector('video');
    if (!video) {
      return {
        ok: Boolean(allowDeferred),
        deferred: Boolean(allowDeferred),
        error: allowDeferred ? '' : 'No video element found',
      };
    }
    if (shouldMute) {
      video.muted = true;
    }
    try {
      const result = video.play?.();
      if (result && typeof result.then === 'function') {
        await result;
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error?.message || String(error),
        name: error?.name || 'Error',
      };
    }
  }, { shouldMute: mute, allowDeferred: clickSuccessful }).catch((error) => ({
    ok: false,
    error: error?.message || String(error),
    name: error?.name || 'Error',
  }));

  return {
    click_successful: clickSuccessful,
    click_error: clickError,
    play_result: playResult,
  };
}

async function runPlaybackPreflight(frame) {
  return frame.evaluate(() => {
    const overlaySelectors = [
      '[class*="cookie"]',
      '[class*="consent"]',
      '[class*="modal"]',
      '[class*="overlay"]',
      '[class*="popup"]',
      '[class*="banner"]',
      '[id*="cookie"]',
      '[id*="consent"]',
      '[role="dialog"]',
    ];
    const actionKeywords = ['accept', 'agree', 'continue', 'close', 'dismiss', 'skip', 'ok', 'allow', 'got it'];
    const candidates = Array.from(document.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]'));
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const overlays = Array.from(document.querySelectorAll(overlaySelectors.join(',')))
      .filter(visible)
      .slice(0, 12)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          text: (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          covers_center: rect.left <= centerX && rect.right >= centerX && rect.top <= centerY && rect.bottom >= centerY,
        };
      });
    const actions = [];

    for (const node of candidates) {
      if (!visible(node)) continue;
      const label = `${node.innerText || node.textContent || node.getAttribute('aria-label') || node.value || ''}`.replace(/\s+/g, ' ').trim();
      const normalized = label.toLowerCase();
      if (!normalized || !actionKeywords.some((keyword) => normalized.includes(keyword))) continue;
      const rect = node.getBoundingClientRect();
      const overlapsCenter = rect.left <= centerX && rect.right >= centerX && rect.top <= centerY && rect.bottom >= centerY;
      const nearOverlay = overlays.some((overlay) => overlay.covers_center);
      if (!overlapsCenter && !nearOverlay) continue;
      try {
        node.click();
        actions.push(label.slice(0, 120));
      } catch {
        // ignore
      }
      if (actions.length >= 4) break;
    }

    return {
      overlays_detected: overlays.length,
      overlays,
      actions,
      clicked: actions.length > 0,
    };
  }).catch(() => ({
    overlays_detected: 0,
    overlays: [],
    actions: [],
    clicked: false,
  }));
}

export async function playMedia({
  frame_path = 'root',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  wait_ms = 1500,
  browserWsEndpoint,
  browserProfile = '',
} = {}) {
  const mediaRuntime = getSharedMediaRuntimeConfig('puppeteer');

  return withBrowserSession(browserWsEndpoint, async ({ browser, page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    const tabs = trackNewTabs(browser, { openerPage: page });
    const hasLocator = Boolean(element_ref || selector || xpath || text);
    let resolved = hasLocator
      ? await resolveElementTarget(page, { frame_path, element_ref, selector, xpath, text })
      : { ok: false, frame_path, error: 'no_locator', code: 'no_locator' };
    let activeFrame = null;
    let activeFramePath = frame_path;
    let preferredHandle = null;
    let resolutionPayload = {
      locator_used: {},
      stale_ref_detected: false,
      frame_fallback_applied: false,
      frame_relocated: false,
      resolution_attempts: [],
      error_code: '',
      error: '',
    };

    if (resolved.ok) {
      activeFrame = resolved.frame;
      activeFramePath = resolved.frame_path || frame_path;
      preferredHandle = resolved.handle || null;
      resolutionPayload = {
        locator_used: resolved.locator_used || {},
        stale_ref_detected: Boolean(resolved.stale_ref_detected),
        frame_fallback_applied: Boolean(resolved.frame_fallback_applied),
        frame_relocated: Boolean(resolved.frame_relocated),
        resolution_attempts: resolved.resolution_attempts || [],
        error_code: '',
        error: '',
      };
    } else {
      const frameResolution = await resolveFrame(page, frame_path);
      if (!frameResolution.ok) {
        tabs.dispose();
        return buildEnvelope(page, {
          frame_path: resolved.frame_path || frame_path,
          ok: false,
          error: hasLocator ? resolved.error : frameResolution.error,
          data: {
            error_code: hasLocator ? (resolved.code || 'action_target_not_found') : 'frame_not_found',
            stale_ref_detected: Boolean(resolved.stale_ref_detected),
            frame_fallback_applied: Boolean(resolved.frame_fallback_applied),
            resolution_attempts: resolved.resolution_attempts || [],
          },
        });
      }
      activeFrame = frameResolution.frame;
      activeFramePath = frameResolution.frame_path || frame_path;
      resolutionPayload = {
        locator_used: {},
        stale_ref_detected: Boolean(resolved.stale_ref_detected),
        frame_fallback_applied: Boolean(resolved.frame_fallback_applied),
        frame_relocated: false,
        resolution_attempts: resolved.resolution_attempts || [],
        error_code: resolved.code || (hasLocator ? 'action_target_not_found' : ''),
        error: resolved.error || '',
      };
    }

    let activation = null;
    let resultPage = page;

    try {
      activation = await activatePlayback({
        page,
        frame: activeFrame,
        handle: preferredHandle,
        framePath: activeFramePath,
        waitMs: wait_ms,
        browserId: 'puppeteer',
      });

      if (wait_ms > 0) await wait(wait_ms);
      await page.waitForNetworkIdle({ idleTime: 300, timeout: Math.max(wait_ms, 1500) }).catch(() => {});
    } catch (error) {
      activation = {
        runtime: mediaRuntime,
        preflight: { overlays_detected: 0, overlays: [], actions: [], clicked: false },
        candidate_summary: { frame_url: activeFrame?.url?.() || page.url(), video_count: 0, playable_video_count: 0, top_candidates: [], videos: [], player_shell_detected: false },
        strategies_attempted: [],
        frame_path: activeFramePath,
        frame_url: activeFrame?.url?.() || page.url(),
        frame_relocated: false,
        playback_started: false,
        media_confirmed: false,
        verification_signal: '',
        playback_probe: { events: [], media_error_code: null, media_error_message: '' },
        final_error: error?.message || String(error),
      };
    } finally {
      resultPage = await tabs.settle().catch(() => page) || page;
      tabs.dispose();
    }

    const popupAdopted = resultPage !== page;
    const resultFramePath = popupAdopted ? 'root' : activeFramePath;
    const after = await capturePageSnapshot(resultPage, resultFramePath);
    const network_diagnostics = getPageNetworkDiagnostics(resultPage, { limit: 12 });
    const result = await buildEnvelope(resultPage, {
      frame_path: resultFramePath,
      ok: Boolean(activation?.playback_started),
      error: activation?.playback_started ? null : activation?.final_error,
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls),
      screenshotHandle: popupAdopted ? null : preferredHandle,
      data: {
        locator_used: resolutionPayload.locator_used,
        popup_adopted: popupAdopted,
        opener_url: popupAdopted ? page.url() : '',
        stale_ref_detected: resolutionPayload.stale_ref_detected,
        frame_fallback_applied: resolutionPayload.frame_fallback_applied,
        frame_relocated: Boolean(resolutionPayload.frame_relocated || activation?.frame_relocated),
        resolution_attempts: resolutionPayload.resolution_attempts || [],
        locator_resolution_error: resolutionPayload.error || '',
        preflight: activation?.preflight || { overlays_detected: 0, overlays: [], actions: [], clicked: false },
        candidate_summary: activation?.candidate_summary || { frame_url: activeFrame?.url?.() || page.url(), video_count: 0, playable_video_count: 0, top_candidates: [], videos: [], player_shell_detected: false },
        strategies_attempted: activation?.strategies_attempted || [],
        playback_started: Boolean(activation?.playback_started),
        media_confirmed: Boolean(activation?.media_confirmed),
        verification_signal: activation?.verification_signal || '',
        playback_ready: Number(activation?.playback_probe?.max_ready_state || 0) >= 2,
        playback_current_time: Number(activation?.playback_probe?.max_current_time || 0),
        playback_events: activation?.playback_probe?.events || [],
        attempts: activation?.strategies_attempted || [],
        media_error_code: activation?.playback_probe?.media_error_code ?? null,
        final_error: activation?.playback_started ? null : (activation?.final_error || null),
        effective_policy: network_diagnostics.effective_policy,
        effective_runtime: network_diagnostics.effective_runtime,
        critical_resource_failures: network_diagnostics.critical_resource_failures,
        render_gap_signals: network_diagnostics.render_gap_signals,
        manifest_failure: network_diagnostics.manifest_failure,
        network_diagnostics,
      },
    });
    await preferredHandle?.dispose?.().catch(() => {});
    return result;
  }, { browserProfile });
}

export async function swipeRegion({
  frame_path = 'root',
  x = 0,
  y = 0,
  delta_x = 0,
  delta_y = 0,
  steps = 10,
  wait_ms = 500,
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    let finalError = null;
    try {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + delta_x, y + delta_y, { steps });
      await page.mouse.up();
      if (wait_ms > 0) await wait(wait_ms);
    } catch (error) {
      finalError = error.message;
    }
    const after = await capturePageSnapshot(page, frame_path);
    return buildEnvelope(page, {
      frame_path,
      ok: !finalError,
      error: finalError,
      observed_change: makeObservedChange(before, after, []),
      data: {
        swipe: { x, y, delta_x, delta_y, steps },
      },
    });
  });
}

export async function clickCoordinates({
  frame_path = 'root',
  x = 0,
  y = 0,
  wait_ms = 1500,
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ browser, page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    const tabs = trackNewTabs(browser, { openerPage: page });
    let finalError = null;
    let resultPage = page;
    try {
      await page.mouse.move(x, y, { steps: 8 });
      await page.mouse.click(x, y);
      if (wait_ms > 0) await wait(wait_ms);
      await page.waitForNetworkIdle({ idleTime: 300, timeout: Math.max(wait_ms, 1500) }).catch(() => {});
    } catch (error) {
      finalError = error.message;
    } finally {
      resultPage = await tabs.settle().catch(() => page) || page;
      tabs.dispose();
    }
    const popupAdopted = resultPage !== page;
    const resultFramePath = popupAdopted ? 'root' : frame_path;
    const after = await capturePageSnapshot(resultPage, resultFramePath);
    return buildEnvelope(resultPage, {
      frame_path: resultFramePath,
      ok: !finalError,
      error: finalError,
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls),
      data: {
        coordinates: { x, y },
        popup_adopted: popupAdopted,
        opener_url: popupAdopted ? page.url() : '',
      },
    });
  });
}
