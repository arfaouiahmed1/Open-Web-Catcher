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
import {
  getMediaRuntimeConfig,
  invokeMediaPlayback,
  primeMediaProbe,
  readMediaProbe,
  runPlaybackPreflight,
  waitForPlayback,
} from '../shared/media-activation.js';

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
    const tabs = trackNewTabs(context, { openerPage: page });
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
      await page.waitForLoadState('networkidle', { timeout: Math.max(wait_ms, 1500) }).catch(() => {});
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
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls, tabs),
      screenshotHandle: screenshot_target && !popupAdopted ? resolved.handle : null,
      data: {
        locator_used: resolved.locator_used,
        popup_adopted: popupAdopted,
        opener_url: tabs.opener_url,
        opened_targets: tabs.opened_targets,
        blocked_popup_attempts: tabs.blocked_popup_attempts,
        selected_target: tabs.selected_target,
        target_decision: tabs.target_decision,
        active_page_url: tabs.active_page_url,
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

// Media activation helpers: primeMediaProbe / readMediaProbe / waitForPlayback /
// invokeMediaPlayback / runPlaybackPreflight / getMediaRuntimeConfig now live in
// shared/media-activation.js ([TOOL-DUP] dedupe, plan T20-f). The former local
// copies drifted from the puppeteer shared pipeline and were removed; the
// single-video probe shape was replaced by the shared multi-video probe
// (max_ready_state / max_current_time) which play_media below consumes.
async function inspectActivationCandidates(frame, framePath = 'root', limit = 8) {
  return frame.evaluate(({ framePathValue, candidateLimit }) => {
    const normalize = (value, max = 140) =>
      String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const visible = (node) => {
      if (!(node instanceof Element)) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const reasonFor = (entry) => {
      const haystack = `${entry.kind || ''} ${entry.text || ''} ${entry.selector || ''}`.toLowerCase();
      if (entry.kind === 'video') return 'visible video element';
      if (/(play|watch|start|resume|unmute|go live)/.test(haystack)) return 'explicit play-like control';
      if (/(player|poster|overlay|control|video-js|jwplayer|plyr)/.test(haystack)) return 'player surface or overlay';
      return 'candidate from player/media region';
    };
    const selectorFor = (node) => {
      if (node.id) return `#${CSS.escape(node.id)}`;
      if (node.getAttribute('name')) return `[name="${CSS.escape(node.getAttribute('name'))}"]`;
      const className = String(node.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      return className ? `${node.tagName.toLowerCase()}.${className}` : node.tagName.toLowerCase();
    };
    const rows = Array.from(document.querySelectorAll(
      "video,button,a,[role='button'],[onclick],.vjs-big-play-button,.jw-icon-playback,.plyr__control,[class*='play'],[class*='player'],[class*='overlay'],[class*='poster'],iframe",
    ))
      .filter(visible)
      .map((node, index) => {
        const rect = node.getBoundingClientRect();
        const tag = node.tagName.toLowerCase();
        const text = normalize(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('src') || '');
        const row = {
          index,
          kind: tag === 'video' ? 'video' : tag === 'iframe' ? 'iframe' : 'control',
          tag,
          text,
          selector: selectorFor(node),
          xpath: '',
          frame_path: framePathValue,
          geometry: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            center_x: Math.round(rect.x + rect.width / 2),
            center_y: Math.round(rect.y + rect.height / 2),
          },
          requires_agent_choice: true,
        };
        row.activation_reason = reasonFor(row);
        return row;
      })
      .slice(0, candidateLimit);
    return {
      frame_path: framePathValue,
      frame_url: location.href,
      needs_agent_choice: true,
      activation_candidates: rows,
      candidate_summary: {
        video_count: rows.filter((row) => row.kind === 'video').length,
        top_candidates: rows,
      },
    };
  }, { framePathValue: framePath, candidateLimit: limit }).catch(() => ({
    frame_path: framePath,
    frame_url: frame.url(),
    needs_agent_choice: true,
    activation_candidates: [],
    candidate_summary: { video_count: 0, top_candidates: [] },
  }));
}


export async function playMedia({
  frame_path = 'root',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  x,
  y,
  wait_ms = 1500,
  browserWsEndpoint,
  browserProfile = '',
} = {}) {
  const mediaRuntime = getMediaRuntimeConfig();

  return withBrowserSession(browserWsEndpoint, async ({ context, page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    const tabs = trackNewTabs(context, { openerPage: page });
    const hasLocator = Boolean(element_ref || selector || xpath || text);
    const hasCoordinates = Number.isFinite(Number(x)) && Number.isFinite(Number(y));
    let resolved = hasLocator
      ? await resolveElementTarget(page, { frame_path, element_ref, selector, xpath, text })
      : { ok: false, frame_path, error: 'no_locator', code: 'no_locator' };

    if (!hasLocator && !hasCoordinates) {
      const frameState = await capturePageSnapshot(page, frame_path);
      const frameResolution = await resolveFrame(page, frame_path);
      const frame = frameResolution.ok ? frameResolution.frame : page.mainFrame();
      const candidateFramePath = frameResolution.ok ? frameResolution.frame_path : 'root';
      const candidateInspection = await inspectActivationCandidates(frame, candidateFramePath, mediaRuntime.candidate_limit || 8);
      await tabs.settle().catch(() => page);
      tabs.dispose();
      return buildEnvelope(page, {
        frame_path: candidateFramePath,
        ok: true,
        error: null,
        observed_change: makeObservedChange(before, frameState, tabs.new_tab_urls, tabs),
        data: {
          locator_used: {},
          popup_adopted: false,
          opener_url: tabs.opener_url,
          opened_targets: tabs.opened_targets,
          blocked_popup_attempts: tabs.blocked_popup_attempts,
          selected_target: tabs.selected_target,
          target_decision: tabs.target_decision,
          active_page_url: tabs.active_page_url,
          stale_ref_detected: false,
          frame_fallback_applied: false,
          frame_relocated: candidateFramePath !== frame_path,
          resolution_attempts: [],
          needs_agent_choice: true,
          playback_started: false,
          playback_ready: false,
          playback_current_time: 0,
          playback_events: [],
          attempts: [],
          media_error_code: null,
          final_error: null,
          activation_candidates: candidateInspection.activation_candidates,
          candidate_summary: candidateInspection.candidate_summary,
          frame_url: candidateInspection.frame_url,
        },
      });
    }

    if (!resolved.ok && hasCoordinates) {
      resolved = {
        ok: true,
        frame: page.mainFrame(),
        handle: null,
        frame_path,
        locator_used: { kind: 'coordinates', x: Number(x), y: Number(y) },
        stale_ref_detected: false,
        frame_fallback_applied: false,
        frame_relocated: false,
        resolution_attempts: [],
      };
    }

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

    const preflight = await runPlaybackPreflight(resolved.frame, mediaRuntime, { clickBlockers: false });
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
    let resultPage = page;
    let finalProbe = { events: [], media_error_code: null, media_error_message: '' };

    try {
      for (let attemptIndex = 0; attemptIndex < mediaRuntime.total_attempts; attemptIndex += 1) {
        const muteForAttempt = attemptIndex >= 1;
        await primeMediaProbe(resolved.frame, { mute: muteForAttempt });
        const probeBefore = await readMediaProbe(resolved.frame);
        const baselineEventCount = (probeBefore.events || []).length;

        const execution = await invokeMediaPlayback(resolved.frame, resolved.handle, { mute: muteForAttempt });
        if (hasCoordinates && !execution.click_successful) {
          await page.mouse.click(Number(x), Number(y)).catch(() => {});
        }
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
      resultPage = await tabs.settle().catch(() => page) || page;
      tabs.dispose();
    }

    const popupAdopted = resultPage !== page;
    const resultFramePath = popupAdopted ? 'root' : resolved.frame_path;
    const after = await capturePageSnapshot(resultPage, resultFramePath);
    const network_diagnostics = getPageNetworkDiagnostics(resultPage, { limit: 12 });
    const result = await buildEnvelope(resultPage, {
      frame_path: resultFramePath,
      ok: playbackStarted || (!mediaRuntime.verify_playback && !finalError),
      error: playbackStarted ? null : finalError,
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls, tabs),
      screenshotHandle: popupAdopted ? null : resolved.handle,
      data: {
        locator_used: resolved.locator_used,
        popup_adopted: popupAdopted,
        opener_url: tabs.opener_url,
        opened_targets: tabs.opened_targets,
        blocked_popup_attempts: tabs.blocked_popup_attempts,
        selected_target: tabs.selected_target,
        target_decision: tabs.target_decision,
        active_page_url: tabs.active_page_url,
        stale_ref_detected: Boolean(resolved.stale_ref_detected),
        frame_fallback_applied: Boolean(resolved.frame_fallback_applied),
        frame_relocated: Boolean(resolved.frame_relocated),
        resolution_attempts: resolved.resolution_attempts || [],
        preflight,
        playback_started: playbackStarted,
        playback_ready: Number(finalProbe.max_ready_state || 0) >= 2,
        playback_current_time: Number(finalProbe.max_current_time || 0),
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
    const tabs = trackNewTabs(context, { openerPage: page });
    let finalError = null;
    let resultPage = page;
    try {
      await page.mouse.move(x, y, { steps: 8 });
      await page.mouse.click(x, y);
      if (wait_ms > 0) await wait(wait_ms);
      await page.waitForLoadState('networkidle', { timeout: Math.max(wait_ms, 1500) }).catch(() => {});
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
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls, tabs),
      data: {
        coordinates: { x, y },
        popup_adopted: popupAdopted,
        opener_url: tabs.opener_url,
        opened_targets: tabs.opened_targets,
        blocked_popup_attempts: tabs.blocked_popup_attempts,
        selected_target: tabs.selected_target,
        target_decision: tabs.target_decision,
        active_page_url: tabs.active_page_url,
      },
    });
  });
}
