/**
 * tools/navigate.js — Navigate browser to a URL, go back, or reload.
 *
 * Implements the v2 browser tool contract (plan step 5):
 * - Flat inputs: action, url, wait_until, timeout_ms, challenge_policy, intent
 * - URL safety checks: rejects file:, data:, javascript:, loopback, RFC1918, metadata
 * - Proof capturing: before_screenshot_ref, after_screenshot_ref, access_state, observed_change
 * - Challenge detection: ERR_CHALLENGE_PRESENT with operator_handoff recommendation
 * - Returns v2 ToolEnvelope
 */

import { successEnvelope, errorEnvelope } from '../shared/tool-envelope.js';
import { TOOL_ERROR_CODES } from '../../shared/error-codes.js';
import { detectAccessState } from '../runtime/access-state.js';
import { defaultEvidenceStore } from '../runtime/evidence-store.js';
import { getPage } from '../shared/browser.js';

const FORBIDDEN_SCHEMES = ['file:', 'data:', 'javascript:', 'vbscript:', 'about:'];

const FORBIDDEN_HOST_PATTERNS = [
  /^localhost$/i,
  /^127(?:\.\d+){3}$/,
  /^::1$/,
  /^169\.254\./,
  /^10\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^metadata\.google\.internal$/i,
  /^instance-data$/i,
];

export function isSafeNavigationUrl(urlLike) {
  let parsed;
  try {
    parsed = new URL(String(urlLike || '').trim());
  } catch {
    return { safe: false, reason: 'Malformed URL' };
  }

  if (FORBIDDEN_SCHEMES.includes(parsed.protocol.toLowerCase())) {
    return { safe: false, reason: `Disallowed URL scheme: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();
  for (const pattern of FORBIDDEN_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      return { safe: false, reason: `Disallowed destination host: ${hostname}` };
    }
  }

  return { safe: true, url: parsed.href };
}

function normalizeWaitUntil(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'commit') return 'commit';
  if (v === 'load') return 'load';
  if (v === 'networkidle' || v === 'networkidle0' || v === 'networkidle2') return 'networkidle';
  return 'domcontentloaded'; // Safe default
}

export async function navigate(args = {}) {
  const startTime = Date.now();
  const action = String(args.action || 'goto').toLowerCase().trim();
  const timeoutMs = Math.min(60000, Math.max(1000, Number(args.timeout_ms || 30000)));
  const challengePolicy = String(args.challenge_policy || 'detect').toLowerCase();
  const waitUntil = normalizeWaitUntil(args.wait_until);
  const targetUrl = String(args.url || '').trim();

  // Validate action
  if (!['goto', 'back', 'reload'].includes(action)) {
    return errorEnvelope({
      tool: 'navigate',
      code: TOOL_ERROR_CODES.ERR_INVALID_TOOL_INPUT,
      message: `Invalid action "${action}". Must be "goto", "back", or "reload".`,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  // Validate destination URL for "goto"
  if (action === 'goto') {
    if (!targetUrl) {
      return errorEnvelope({
        tool: 'navigate',
        code: TOOL_ERROR_CODES.ERR_INVALID_TOOL_INPUT,
        message: 'A destination "url" is required when action="goto".',
        telemetry: { duration_ms: Date.now() - startTime },
      });
    }

    const check = isSafeNavigationUrl(targetUrl);
    if (!check.safe) {
      return errorEnvelope({
        tool: 'navigate',
        code: TOOL_ERROR_CODES.ERR_INVALID_TOOL_INPUT,
        message: `Unsafe navigation target: ${check.reason}`,
        telemetry: { duration_ms: Date.now() - startTime },
      });
    }
  }

  // Resolve active page
  let page = null;
  let pageStateTracker = null;
  let evidenceStore = defaultEvidenceStore;

  try {
    if (args.browserSession?.page) {
      page = args.browserSession.page;
      pageStateTracker = args.browserSession.pageStateTracker;
      if (args.browserSession.evidenceStore) evidenceStore = args.browserSession.evidenceStore;
    } else {
      page = await getPage(args.browserSession, { targetUrl, browserProfile: args.browserProfile });
    }
  } catch (err) {
    return errorEnvelope({
      tool: 'navigate',
      code: TOOL_ERROR_CODES.ERR_TOOL_TIMEOUT,
      message: `Could not acquire active browser page: ${err.message}`,
      retryable: true,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  // 1. Capture before-proof and initial page state
  let beforeScreenshotRef = null;
  try {
    const shot = await evidenceStore.saveScreenshot(page, { scope: 'viewport' });
    beforeScreenshotRef = shot.blobref;
  } catch {}

  const initialPageState = pageStateTracker
    ? await pageStateTracker.getPageState().catch(() => null)
    : null;

  // 2. Perform navigation action
  let navigationResponse = null;
  try {
    if (action === 'goto') {
      navigationResponse = await page.goto(targetUrl, { waitUntil, timeout: timeoutMs });
    } else if (action === 'back') {
      navigationResponse = await page.goBack({ waitUntil, timeout: timeoutMs });
    } else if (action === 'reload') {
      navigationResponse = await page.reload({ waitUntil, timeout: timeoutMs });
    }
  } catch (err) {
    const finalUrl = page.url() || '';
    const errPageState = pageStateTracker ? await pageStateTracker.getPageState().catch(() => null) : null;
    return errorEnvelope({
      tool: 'navigate',
      page_state: errPageState || initialPageState,
      proof: { before_screenshot_ref: beforeScreenshotRef },
      code: TOOL_ERROR_CODES.ERR_TOOL_TIMEOUT,
      message: `Navigation action "${action}" failed: ${err.message}`,
      retryable: true,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  // 3. Detect access state
  let accessState = await detectAccessState(page);

  // If challenge detected and policy is "wait_once", poll briefly for resolution
  if (accessState === 'challenge' && challengePolicy === 'wait_once') {
    const pollDeadline = Date.now() + 15000;
    while (Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 1000));
      accessState = await detectAccessState(page);
      if (accessState !== 'challenge') break;
    }
  }

  // 4. Capture after-proof and post-navigation page state
  let afterScreenshotRef = null;
  try {
    const shot = await evidenceStore.saveScreenshot(page, { scope: 'viewport' });
    afterScreenshotRef = shot.blobref;
  } catch {}

  const finalPageState = pageStateTracker
    ? await pageStateTracker.getPageState().catch(() => null)
    : { id: '', dom_epoch: 0, url: page.url() || '', title: await page.title().catch(() => ''), frame_path: 'root', captured_at: new Date().toISOString() };

  // 5. If challenge is still present, return ERR_CHALLENGE_PRESENT
  if (accessState === 'challenge') {
    return errorEnvelope({
      tool: 'navigate',
      page_state: finalPageState,
      proof: {
        before_screenshot_ref: beforeScreenshotRef,
        after_screenshot_ref: afterScreenshotRef,
        access_state: 'challenge',
        observed_change: 'navigation',
      },
      code: TOOL_ERROR_CODES.ERR_CHALLENGE_PRESENT,
      message: `Bot-detection challenge (Turnstile/CAPTCHA/DDoS-Guard) detected on ${page.url()}.`,
      retryable: false,
      recommended_action: 'operator_handoff',
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  // 6. Gather redirects
  const redirects = [];
  try {
    let req = navigationResponse?.request();
    while (req?.redirectedFrom()) {
      req = req.redirectedFrom();
      redirects.unshift(req.url());
    }
  } catch {}

  const finalUrl = page.url() || '';
  const title = await page.title().catch(() => '');

  return successEnvelope({
    tool: 'navigate',
    page_state: finalPageState,
    proof: {
      before_screenshot_ref: beforeScreenshotRef,
      after_screenshot_ref: afterScreenshotRef,
      access_state: accessState,
      observed_change: 'navigation',
    },
    data: {
      action,
      url: targetUrl || finalUrl,
      final_url: finalUrl,
      title,
      http_status: navigationResponse?.status() || 200,
      redirects,
      access_state: accessState,
    },
    telemetry: {
      duration_ms: Date.now() - startTime,
      attempts: 1,
    },
  });
}
