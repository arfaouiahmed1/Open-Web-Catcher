/**
 * tools/interact.js — User interaction tool.
 *
 * Implements the v2 browser tool contract (plan step 5):
 * - Flat inputs: action, candidate_id, locator fields, value fields, expected_change, intent
 * - Resolution order: candidate_id ref, ARIA role+name, CSS, XPath, visible text, coordinates
 * - Expected change verification: "auto" | "navigation" | "dom" | "media" | "network"
 * - Returns ERR_INTERACTION_UNVERIFIED if requested change not observed
 * - Returns v2 ToolEnvelope
 */

import { successEnvelope, errorEnvelope } from '../shared/tool-envelope.js';
import { TOOL_ERROR_CODES } from '../../shared/error-codes.js';
import { LocatorEngine, LocatorError } from '../runtime/locator-engine.js';
import { detectAccessState } from '../runtime/access-state.js';
import { defaultEvidenceStore } from '../runtime/evidence-store.js';
import { getPage } from '../shared/browser.js';

const VALID_ACTIONS = new Set([
  'click',
  'fill',
  'select',
  'check',
  'press',
  'hover',
  'scroll',
  'drag',
  'play',
]);

const VALID_CHANGES = new Set(['auto', 'navigation', 'dom', 'media', 'network']);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function interact(args = {}) {
  const startTime = Date.now();
  const action = String(args.action || 'click').toLowerCase().trim();
  const expectedChange = String(args.expected_change || 'auto').toLowerCase().trim();
  const framePath = String(args.frame_path || 'root');

  // Validate action
  if (!VALID_ACTIONS.has(action)) {
    return errorEnvelope({
      tool: 'interact',
      code: TOOL_ERROR_CODES.ERR_INVALID_TOOL_INPUT,
      message: `Invalid action "${action}". Allowed: ${[...VALID_ACTIONS].join(', ')}`,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  // Validate expected_change
  if (!VALID_CHANGES.has(expectedChange)) {
    return errorEnvelope({
      tool: 'interact',
      code: TOOL_ERROR_CODES.ERR_INVALID_TOOL_INPUT,
      message: `Invalid expected_change "${expectedChange}". Allowed: ${[...VALID_CHANGES].join(', ')}`,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

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
      tool: 'interact',
      code: TOOL_ERROR_CODES.ERR_TOOL_TIMEOUT,
      message: `Could not acquire active page: ${err.message}`,
      retryable: true,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  const locatorEngine = new LocatorEngine(page, pageStateTracker);

  // 1. Capture before-screenshot and initial state baseline
  let beforeScreenshotRef = null;
  try {
    const shot = await evidenceStore.saveScreenshot(page, { scope: 'viewport' });
    beforeScreenshotRef = shot.blobref;
  } catch {}

  const initialUrl = page.url() || '';
  const initialEpoch = pageStateTracker?.domEpoch ?? 0;
  const initialNetworkCount = networkLedger?.entries?.length ?? 0;
  const initialPageState = pageStateTracker
    ? await pageStateTracker.getPageState(framePath).catch(() => null)
    : null;

  // 2. Resolve target element
  let resolved;
  try {
    resolved = await locatorEngine.resolve({
      candidate_id: args.candidate_id,
      frame_path: framePath,
      role: args.role,
      name: args.name,
      css: args.css || args.selector,
      xpath: args.xpath,
      text: args.text,
      x: args.x,
      y: args.y,
      allow_coordinate_fallback: Boolean(args.allow_coordinate_fallback),
    });
  } catch (err) {
    const errCode = err instanceof LocatorError ? err.code : TOOL_ERROR_CODES.ERR_ELEMENT_NOT_FOUND;
    return errorEnvelope({
      tool: 'interact',
      page_state: initialPageState,
      proof: { before_screenshot_ref: beforeScreenshotRef },
      code: errCode,
      message: err.message,
      retryable: errCode === TOOL_ERROR_CODES.ERR_STALE_PAGE_STATE,
      recommended_action: errCode === TOOL_ERROR_CODES.ERR_STALE_PAGE_STATE ? 're-inspect the page' : undefined,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  const { locator, coordinates, strategyUsed, attempts } = resolved;

  // 3. Execute interaction
  try {
    if (locator) {
      // Scroll into view if element is offscreen
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});

      switch (action) {
        case 'click':
          await locator.click({ timeout: 10000 });
          break;
        case 'fill':
          await locator.fill(String(args.value || ''), { timeout: 10000 });
          break;
        case 'select':
          await locator.selectOption(args.option || args.value, { timeout: 10000 });
          break;
        case 'check':
          await locator.check({ timeout: 10000 });
          break;
        case 'press':
          await locator.press(String(args.key || 'Enter'), { timeout: 10000 });
          break;
        case 'hover':
          await locator.hover({ timeout: 10000 });
          break;
        case 'scroll': {
          const direction = String(args.scroll_direction || 'down').toLowerCase();
          const amount = Number(args.scroll_amount || 400);
          const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
          const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
          await page.mouse.wheel(deltaX, deltaY);
          break;
        }
        case 'drag':
          if (args.drag_to) {
            await locator.dragTo(page.locator(args.drag_to), { timeout: 10000 });
          }
          break;
        case 'play': {
          // Play action on video element or play button
          await locator.click({ timeout: 10000 }).catch(async () => {
            await locator.evaluate((el) => {
              if (typeof el.play === 'function') el.play();
            });
          });
          break;
        }
      }
    } else if (coordinates) {
      // Coordinate fallback execution
      await page.mouse.move(coordinates.x, coordinates.y);
      await delay(50);
      if (action === 'click' || action === 'play') {
        await page.mouse.click(coordinates.x, coordinates.y);
      } else if (action === 'hover') {
        // already moved
      }
    }
  } catch (err) {
    const finalPageState = pageStateTracker
      ? await pageStateTracker.getPageState(framePath).catch(() => null)
      : initialPageState;
    return errorEnvelope({
      tool: 'interact',
      page_state: finalPageState,
      proof: { before_screenshot_ref: beforeScreenshotRef },
      code: TOOL_ERROR_CODES.ERR_TOOL_TIMEOUT,
      message: `Interaction action "${action}" failed: ${err.message}`,
      retryable: true,
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  // Small settle pause for DOM / navigation reactions
  await delay(300);

  // 4. Verify expected change
  const postUrl = page.url() || '';
  const postEpoch = pageStateTracker?.domEpoch ?? initialEpoch;
  const postNetworkCount = networkLedger?.entries?.length ?? initialNetworkCount;

  let urlChanged = postUrl !== initialUrl;
  let domChanged = postEpoch > initialEpoch;
  let networkChanged = postNetworkCount > initialNetworkCount;
  let mediaPlaying = false;

  try {
    mediaPlaying = await page.evaluate(() => {
      const v = document.querySelector('video');
      return Boolean(v && (!v.paused || v.readyState >= 3));
    }).catch(() => false);
  } catch {}

  let observedChange = null;
  if (urlChanged) observedChange = 'navigation';
  else if (domChanged) observedChange = 'dom';
  else if (mediaPlaying) observedChange = 'media';
  else if (networkChanged) observedChange = 'network';

  let changeVerified = false;
  if (expectedChange === 'auto') {
    changeVerified = urlChanged || domChanged || networkChanged || mediaPlaying;
  } else if (expectedChange === 'navigation') {
    changeVerified = urlChanged;
  } else if (expectedChange === 'dom') {
    changeVerified = domChanged;
  } else if (expectedChange === 'media') {
    changeVerified = mediaPlaying;
  } else if (expectedChange === 'network') {
    changeVerified = networkChanged;
  }

  // 5. Capture after-screenshot
  let afterScreenshotRef = null;
  try {
    const shot = await evidenceStore.saveScreenshot(page, { scope: 'viewport' });
    afterScreenshotRef = shot.blobref;
  } catch {}

  const finalPageState = pageStateTracker
    ? await pageStateTracker.getPageState(framePath).catch(() => null)
    : { id: '', dom_epoch: postEpoch, url: postUrl, title: await page.title().catch(() => ''), frame_path: framePath, captured_at: new Date().toISOString() };

  const accessState = await detectAccessState(page);

  // If expected change was NOT observed and expected_change wasn't a loose action (e.g. hover)
  if (!changeVerified && action !== 'hover' && action !== 'scroll') {
    return errorEnvelope({
      tool: 'interact',
      page_state: finalPageState,
      proof: {
        before_screenshot_ref: beforeScreenshotRef,
        after_screenshot_ref: afterScreenshotRef,
        observed_change: observedChange,
        access_state: accessState,
      },
      code: TOOL_ERROR_CODES.ERR_INTERACTION_UNVERIFIED,
      message: `Interaction "${action}" completed, but the expected change "${expectedChange}" was not observed.`,
      retryable: false,
      recommended_action: 'inspect the page to verify current element state',
      telemetry: { duration_ms: Date.now() - startTime },
    });
  }

  return successEnvelope({
    tool: 'interact',
    page_state: finalPageState,
    proof: {
      before_screenshot_ref: beforeScreenshotRef,
      after_screenshot_ref: afterScreenshotRef,
      observed_change: observedChange || 'none',
      access_state: accessState,
    },
    data: {
      action,
      strategy_used: strategyUsed,
      observed_change: observedChange || 'none',
      verified: changeVerified,
      attempts,
    },
    telemetry: {
      duration_ms: Date.now() - startTime,
      attempts: attempts.length,
    },
  });
}
