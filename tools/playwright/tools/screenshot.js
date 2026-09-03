/**
 * tools/screenshot.js — Capture viewport, full-page, or element screenshots.
 *
 * Implements the v2 browser tool contract (plan step 5):
 * - Flat inputs: scope, candidate_id, frame_path, lossless, intent
 * - WebP @ quality 80 by default; PNG when lossless=true
 * - Writes to content-addressed blob store, returns blobref:<sha256[:16]>
 * - Returns v2 ToolEnvelope
 */

import { successEnvelope, errorEnvelope } from '../shared/tool-envelope.js';
import { TOOL_ERROR_CODES } from '../../shared/error-codes.js';
import { detectAccessState } from '../runtime/access-state.js';
import { defaultEvidenceStore } from '../runtime/evidence-store.js';
import { uploadImage } from '../shared/upload.js';
import { getPage } from '../shared/browser.js';

export async function screenshot(args = {}) {
  const startTime = Date.now();
  const scope = String(args.scope || args.mode || 'viewport').toLowerCase().trim();
  const framePath = String(args.frame_path || 'root');
  const lossless = Boolean(args.lossless);
  const candidateId = args.candidate_id || args.selector;

  if (!['viewport', 'full', 'element'].includes(scope)) {
    return errorEnvelope({
      tool: 'screenshot',
      code: TOOL_ERROR_CODES.ERR_INVALID_TOOL_INPUT,
      message: `Invalid scope "${scope}". Allowed: "viewport", "full", "element".`,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  if (scope === 'element' && !candidateId) {
    return errorEnvelope({
      tool: 'screenshot',
      code: TOOL_ERROR_CODES.ERR_INVALID_TOOL_INPUT,
      message: 'When scope="element", a candidate_id or selector is required.',
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
      page = await getPage(args.browserSession, { browserProfile: args.browserProfile });
    }
  } catch (err) {
    return errorEnvelope({
      tool: 'screenshot',
      code: TOOL_ERROR_CODES.ERR_TOOL_TIMEOUT,
      message: `Could not acquire page: ${err.message}`,
      retryable: true,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  // Target element or page
  let target = page;
  if (scope === 'element' && candidateId) {
    try {
      const idOnly = String(candidateId).split('@')[0];
      const loc = page.locator(`[data-owc-id="${idOnly}"], [id="${idOnly}"], ${candidateId}`).first();
      const count = await loc.count();
      if (count === 0) {
        return errorEnvelope({
          tool: 'screenshot',
          code: TOOL_ERROR_CODES.ERR_ELEMENT_NOT_FOUND,
          message: `Target element "${candidateId}" not found for element screenshot.`,
          telemetry: { duration_ms: Date.now() - startTime },
        });
      }
      target = loc;
    } catch (err) {
      return errorEnvelope({
        tool: 'screenshot',
        code: TOOL_ERROR_CODES.ERR_ELEMENT_NOT_FOUND,
        message: `Could not resolve element "${candidateId}": ${err.message}`,
        telemetry: { duration_ms: Date.now() - startTime },
      });
    }
  }

  let captureResult;
  try {
    captureResult = await evidenceStore.saveScreenshot(target, { scope, lossless });
  } catch (err) {
    return errorEnvelope({
      tool: 'screenshot',
      code: TOOL_ERROR_CODES.ERR_TOOL_TIMEOUT,
      message: `Screenshot capture failed: ${err.message}`,
      retryable: true,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  // Dual visual proof: local blobref is the machine-verifiable pointer;
  // screenshot_url is the Cloudinary visual fallback (or the same blobref
  // when Cloudinary is unconfigured) so the agent always gets viewable proof.
  let screenshotUrl = captureResult.blobref;
  try {
    const uploaded = await uploadImage(captureResult.buffer);
    if (uploaded) screenshotUrl = uploaded;
  } catch {}

  // Read video/media state
  const mediaState = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return { present: false, state: 'absent' };
    let state = 'loading';
    if (!v.paused && v.readyState >= 2) state = 'playing';
    else if (v.paused && v.readyState >= 2) state = 'paused';
    return {
      present: true,
      state,
      current_time: v.currentTime,
      duration: v.duration,
      ready_state: v.readyState,
    };
  }).catch(() => ({ present: false, state: 'unknown' }));

  // Collect lightweight visual summary (headings / main landmarks)
  const visualSummary = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .slice(0, 5)
      .map((h) => (h.innerText || '').trim())
      .filter(Boolean);
    return {
      title: document.title || '',
      headings,
    };
  }).catch(() => ({ title: '', headings: [] }));

  const accessState = await detectAccessState(page);

  const pageState = pageStateTracker
    ? await pageStateTracker.getPageState(framePath).catch(() => null)
    : { id: '', dom_epoch: 0, url: page.url() || '', title: await page.title().catch(() => ''), frame_path: framePath, captured_at: new Date().toISOString() };

  return successEnvelope({
    tool: 'screenshot',
    page_state: pageState,
    proof: {
      before_screenshot_ref: captureResult.blobref,
      access_state: accessState,
      media_state: mediaState,
    },
    data: {
      blobref: captureResult.blobref,
      screenshot_url: screenshotUrl,
      width: captureResult.width,
      height: captureResult.height,
      format: captureResult.format,
      scope,
      access_state: accessState,
      media_state: mediaState,
      visual_summary: visualSummary,
      // Base64 payload preserved for vision-capable models adapter
      base64: captureResult.buffer.toString('base64'),
    },
    telemetry: {
      duration_ms: Date.now() - startTime,
      payload_bytes: captureResult.buffer.length,
    },
  });
}
