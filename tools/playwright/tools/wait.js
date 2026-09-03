/**
 * tools/wait.js — Wait for page state or duration.
 *
 * Implements the v2 browser tool contract (plan step 5):
 * - Flat inputs: condition, value, frame_path, timeout_ms, poll_ms, intent
 * - Replaces legacy wait_for_page_state
 * - Conditions:
 *     duration: sleep for timeout_ms
 *     text_visible: wait until text appears
 *     text_gone: wait until text disappears
 *     selector_visible: wait until selector is visible (returns matched: false on timeout, not an error)
 *     media_playing: wait until video element is playing (readyState >= 3)
 *     network_quiet: wait until in-flight requests reach 0
 * - Returns v2 ToolEnvelope
 */

import { successEnvelope, errorEnvelope } from '../shared/tool-envelope.js';
import { TOOL_ERROR_CODES } from '../../shared/error-codes.js';
import { getPage } from '../shared/browser.js';

const VALID_CONDITIONS = new Set([
  'duration',
  'text_visible',
  'text_gone',
  'selector_visible',
  'media_playing',
  'network_quiet',
]);

const consecutiveWaitCalls = new Map(); // page -> count

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function wait(args = {}) {
  const startTime = Date.now();
  const condition = String(args.condition || 'duration').toLowerCase().trim();
  const value = String(args.value || '').trim();
  const framePath = String(args.frame_path || 'root');
  const timeoutMs = Math.min(60000, Math.max(100, Number(args.timeout_ms || 10000)));
  const pollMs = Math.min(5000, Math.max(100, Number(args.poll_ms || 500)));
  const repeatedLimit = Number(args.repeated_tool_call_limit || 3);

  // Validate condition
  if (!VALID_CONDITIONS.has(condition)) {
    return errorEnvelope({
      tool: 'wait',
      code: TOOL_ERROR_CODES.ERR_INVALID_TOOL_INPUT,
      message: `Invalid condition "${condition}". Allowed: ${[...VALID_CONDITIONS].join(', ')}`,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  // Resolve page
  let page = null;
  let pageStateTracker = null;
  let networkLedger = null;

  try {
    if (args.browserSession?.page) {
      page = args.browserSession.page;
      pageStateTracker = args.browserSession.pageStateTracker;
      networkLedger = args.browserSession.networkLedger;
    } else {
      page = await getPage(args.browserSession, { browserProfile: args.browserProfile });
    }
  } catch (err) {
    return errorEnvelope({
      tool: 'wait',
      code: TOOL_ERROR_CODES.ERR_TOOL_TIMEOUT,
      message: `Could not acquire page: ${err.message}`,
      retryable: true,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  // Consecutive wait call check
  const count = (consecutiveWaitCalls.get(page) || 0) + 1;
  consecutiveWaitCalls.set(page, count);

  if (count > repeatedLimit) {
    consecutiveWaitCalls.delete(page);
    const pageState = pageStateTracker
      ? await pageStateTracker.getPageState(framePath).catch(() => null)
      : null;
    return errorEnvelope({
      tool: 'wait',
      page_state: pageState,
      code: TOOL_ERROR_CODES.ERR_TOOL_TIMEOUT,
      message: `Consecutive wait call limit (${repeatedLimit}) exceeded without page interaction.`,
      retryable: false,
      recommended_action: 'inspect_page_first',
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  let matched = false;
  const deadline = Date.now() + timeoutMs;

  // Execute wait condition
  try {
    if (condition === 'duration') {
      const waitDuration = value && !isNaN(Number(value)) ? Number(value) : timeoutMs;
      await delay(Math.min(timeoutMs, waitDuration));
      matched = true;
    } else if (condition === 'text_visible') {
      while (Date.now() < deadline) {
        const hasText = await page.evaluate((val) => {
          return document.body?.innerText?.includes(val) || false;
        }, value).catch(() => false);

        if (hasText) {
          matched = true;
          break;
        }
        await delay(pollMs);
      }
    } else if (condition === 'text_gone') {
      while (Date.now() < deadline) {
        const hasText = await page.evaluate((val) => {
          return document.body?.innerText?.includes(val) || false;
        }, value).catch(() => false);

        if (!hasText) {
          matched = true;
          break;
        }
        await delay(pollMs);
      }
    } else if (condition === 'selector_visible') {
      // Returns matched: false on timeout WITHOUT error
      while (Date.now() < deadline) {
        const isVisible = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
        }, value).catch(() => false);

        if (isVisible) {
          matched = true;
          break;
        }
        await delay(pollMs);
      }
    } else if (condition === 'media_playing') {
      while (Date.now() < deadline) {
        const isPlaying = await page.evaluate(() => {
          const v = document.querySelector('video');
          return Boolean(v && (!v.paused && v.readyState >= 3));
        }).catch(() => false);

        if (isPlaying) {
          matched = true;
          break;
        }
        await delay(pollMs);
      }
    } else if (condition === 'network_quiet') {
      let quietStreak = 0;
      while (Date.now() < deadline) {
        const inFlight = networkLedger ? networkLedger.inFlightCount : 0;
        if (inFlight === 0) {
          quietStreak += pollMs;
          if (quietStreak >= 1000) {
            matched = true;
            break;
          }
        } else {
          quietStreak = 0;
        }
        await delay(pollMs);
      }
    }
  } catch (err) {
    const pageState = pageStateTracker
      ? await pageStateTracker.getPageState(framePath).catch(() => null)
      : null;
    return errorEnvelope({
      tool: 'wait',
      page_state: pageState,
      code: TOOL_ERROR_CODES.ERR_TOOL_TIMEOUT,
      message: `Wait condition "${condition}" evaluation failed: ${err.message}`,
      retryable: true,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  const elapsedMs = Date.now() - startTime;
  const pageState = pageStateTracker
    ? await pageStateTracker.getPageState(framePath).catch(() => null)
    : { id: '', dom_epoch: 0, url: page.url() || '', title: await page.title().catch(() => ''), frame_path: framePath, captured_at: new Date().toISOString() };

  return successEnvelope({
    tool: 'wait',
    page_state: pageState,
    data: {
      condition,
      value: value || null,
      matched,
      elapsed_ms: elapsedMs,
    },
    telemetry: {
      duration_ms: elapsedMs,
      attempts: 1,
    },
  });
}
