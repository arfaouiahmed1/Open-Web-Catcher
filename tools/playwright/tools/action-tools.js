import {
  buildEnvelope,
  capturePageSnapshot,
  makeObservedChange,
  resolveElementTarget,
  trackNewTabs,
  withBrowserSession,
} from '../shared/tool-runtime.js';
import { getPageNetworkDiagnostics } from '../shared/browser.js';
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
  return withBrowserSession(browserWsEndpoint, async ({ browser, context, page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    const tabs = trackNewTabs(context);
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
    try {
      await execute({ page, frame: resolved.frame, handle: resolved.handle });
      if (wait_ms > 0) {
        await wait(wait_ms);
      }
      await page.waitForLoadState('networkidle', { timeout: Math.max(wait_ms, 1500) }).catch(() => {});
    } catch (error) {
      finalError = error.message;
    } finally {
      tabs.dispose();
    }

    const after = await capturePageSnapshot(page, resolved.frame_path);
    const result = await buildEnvelope(page, {
      frame_path: resolved.frame_path,
      ok: !finalError,
      error: finalError,
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls),
      screenshotHandle: screenshot_target ? resolved.handle : null,
      data: {
        locator_used: resolved.locator_used,
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
      if (!option_value && !option_text) {
        throw new Error('Either option_value or option_text is required');
      }

      const selectorValue = await handle.evaluate((node) => {
        if (node.id) return `#${node.id}`;
        if (node.getAttribute('name')) return `[name="${node.getAttribute('name')}"]`;
        return null;
      });

      if (selectorValue && option_value) {
        await frame.locator(selectorValue).selectOption({ value: option_value });
        return;
      }

      if (option_value) {
        await handle.selectOption({ value: option_value });
        return;
      }

      if (option_text) {
        await handle.selectOption({ label: option_text }).catch(async () => {
          await handle.selectOption({ value: option_text });
        });
        await handle.evaluate((node, desiredText) => {
          const option = Array.from(node.options || []).find((entry) =>
            (entry.textContent || '').toLowerCase().includes(String(desiredText).toLowerCase()));
          if (!option) throw new Error(`Option not found: ${desiredText}`);
          node.value = option.value;
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }, option_text);
        return;
      }
    },
  });
}

function runtimeSetting(key) {
  return getBrowserRuntimeSettings('playwright')?.[key];
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
  const mediaRuntime = getMediaRuntimeConfig();

  return withBrowserSession(browserWsEndpoint, async ({ context, page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    const tabs = trackNewTabs(context);
    let resolved = await resolveElementTarget(page, { frame_path, element_ref, selector, xpath, text });

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

    const preflight = await runPlaybackPreflight(resolved.frame);
    if (preflight.clicked) {
      await wait(350);
      const refreshed = await resolveElementTarget(page, { frame_path, element_ref, selector, xpath, text });
      if (refreshed.ok) {
        await resolved.handle.dispose().catch(() => {});
        resolved = refreshed;
      }
    }

    const attempts = [];
    let finalError = null;
    let playbackStarted = false;
    let finalProbe = { events: [], media_error_code: null, media_error_message: '' };

    try {
      for (let attemptIndex = 0; attemptIndex < mediaRuntime.total_attempts; attemptIndex += 1) {
        const muteForAttempt = attemptIndex >= 1;
        await primeMediaProbe(resolved.frame, { mute: muteForAttempt });
        const probeBefore = await readMediaProbe(resolved.frame);
        const baselineEventCount = (probeBefore.events || []).length;

        const execution = await invokeMediaPlayback(resolved.frame, resolved.handle, { mute: muteForAttempt });
        let verification = { started: false, probe: await readMediaProbe(resolved.frame) };
        if (mediaRuntime.verify_playback) {
          verification = await waitForPlayback(resolved.frame, mediaRuntime.verification_timeout_ms);
        } else {
          await wait(Math.min(wait_ms, 750));
          verification = { started: true, probe: await readMediaProbe(resolved.frame) };
        }

        const probeAfter = verification.probe || await readMediaProbe(resolved.frame);
        const attemptEvents = (probeAfter.events || []).slice(baselineEventCount);
        const attemptError = execution.play_result?.error || execution.click_error || probeAfter.media_error_message || '';
        const attemptOk = mediaRuntime.verify_playback ? verification.started : !attemptError;

        attempts.push({
          attempt: attemptIndex + 1,
          click_successful: execution.click_successful,
          play_started: verification.started,
          playback_events: attemptEvents,
          muted_retry: muteForAttempt,
          error: attemptOk ? null : (attemptError || 'Playback did not start'),
          media_error_code: probeAfter.media_error_code,
        });

        finalProbe = probeAfter;
        if (attemptOk) {
          playbackStarted = verification.started;
          finalError = null;
          break;
        }

        finalError = attempts[attempts.length - 1].error;
        const backoffMs = mediaRuntime.retry_backoff_ms[attemptIndex]
          ?? mediaRuntime.retry_backoff_ms[mediaRuntime.retry_backoff_ms.length - 1]
          ?? 0;
        if (attemptIndex < mediaRuntime.total_attempts - 1 && backoffMs > 0) {
          await wait(backoffMs);
        }
      }

      if (wait_ms > 0) {
        await wait(wait_ms);
      }
      await page.waitForLoadState('networkidle', { timeout: Math.max(wait_ms, 1500) }).catch(() => {});
    } catch (error) {
      finalError = error?.message || String(error);
    } finally {
      tabs.dispose();
    }

    const after = await capturePageSnapshot(page, resolved.frame_path);
    const network_diagnostics = getPageNetworkDiagnostics(page, { limit: 12 });
    const result = await buildEnvelope(page, {
      frame_path: resolved.frame_path,
      ok: playbackStarted || (!mediaRuntime.verify_playback && !finalError),
      error: playbackStarted ? null : finalError,
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls),
      screenshotHandle: resolved.handle,
      data: {
        locator_used: resolved.locator_used,
        stale_ref_detected: Boolean(resolved.stale_ref_detected),
        frame_fallback_applied: Boolean(resolved.frame_fallback_applied),
        frame_relocated: Boolean(resolved.frame_relocated),
        resolution_attempts: resolved.resolution_attempts || [],
        preflight,
        playback_started: playbackStarted,
        playback_events: finalProbe.events || [],
        attempts,
        media_error_code: finalProbe.media_error_code,
        final_error: playbackStarted ? null : finalError,
        effective_policy: network_diagnostics.effective_policy,
        effective_runtime: network_diagnostics.effective_runtime,
        critical_resource_failures: network_diagnostics.critical_resource_failures,
        render_gap_signals: network_diagnostics.render_gap_signals,
        manifest_failure: network_diagnostics.manifest_failure,
        network_diagnostics,
      },
    });
    await resolved.handle.dispose().catch(() => {});
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
  return withBrowserSession(browserWsEndpoint, async ({ browser, context, page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    const tabs = trackNewTabs(context);
    let finalError = null;
    try {
      await page.mouse.move(x, y, { steps: 8 });
      await page.mouse.click(x, y);
      if (wait_ms > 0) await wait(wait_ms);
      await page.waitForLoadState('networkidle', { timeout: Math.max(wait_ms, 1500) }).catch(() => {});
    } catch (error) {
      finalError = error.message;
    } finally {
      tabs.dispose();
    }
    const after = await capturePageSnapshot(page, frame_path);
    return buildEnvelope(page, {
      frame_path,
      ok: !finalError,
      error: finalError,
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls),
      data: {
        coordinates: { x, y },
      },
    });
  });
}
