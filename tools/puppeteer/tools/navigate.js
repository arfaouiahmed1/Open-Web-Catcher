/**
 * tools/navigate.js — Navigate to a URL, handle redirects.
 */

import {
  connectBrowser,
  getPage,
  getIframeDiagnostics,
  getPageNetworkDiagnostics,
  retryNavigationAfterAutoRecovery,
} from '../shared/browser.js';
import { shouldRetryWithProxy, shouldRetryWithoutBlocking } from '../../shared/browser-policy.js';
import {
  classifyChromeError,
  isChromeErrorPage,
  summarizeRetryAttempts,
} from '../../shared/error-codes.js';
import { screenshotFull } from '../shared/screenshot.js';
import { detectAccessStateFromSignals, trackNewTabs } from '../shared/tool-runtime.js';

function normalizePptrWaitUntil(value) {
  if (value === 'networkidle') return 'networkidle2';
  return value;
}

function buildWaitUntilCandidates(waitUntil) {
  const ordered = [
    normalizePptrWaitUntil(waitUntil),
    'networkidle2',
    'domcontentloaded',
    'load',
  ].filter(Boolean);
  return [...new Set(ordered)];
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildChromeErrorPageMessage(finalUrl) {
  return `Navigation landed on Chrome error page: ${finalUrl || 'chrome-error://chromewebdata/'}`;
}

async function readAccessState(page) {
  const title = await page.title().catch(() => '');
  const textSample = await page.mainFrame().evaluate(() => (document.body?.innerText || '').slice(0, 1600)).catch(() => '');
  const htmlSample = await page.mainFrame().evaluate(() => (document.documentElement?.outerHTML || '').slice(0, 2000)).catch(() => '');

  return detectAccessStateFromSignals({
    title,
    textSample,
    htmlSample,
    url: page.url(),
  });
}

async function attemptGotoWithFallbackWaits(page, {
  url,
  wait_until,
  timeout_ms,
} = {}) {
  const waitCandidates = buildWaitUntilCandidates(wait_until);
  const attempts = [];
  let lastError = null;
  let lastWaitUntil = waitCandidates[waitCandidates.length - 1] || wait_until;

  for (const candidateWaitUntil of waitCandidates) {
    lastWaitUntil = candidateWaitUntil;
    let retryCount = 0;
    let retryDelayMsForAttempt = 0;

    while (true) {
      const attempt = {
        wait_until: candidateWaitUntil,
        timeout_ms,
        http_status: null,
        final_url: '',
        error: null,
        error_code: null,
        error_category: 'none',
        retry_count: retryCount,
        retry_delay_ms: retryDelayMsForAttempt,
        chrome_error_page: false,
        succeeded: false,
      };

      try {
        const response = await page.goto(url, { waitUntil: candidateWaitUntil, timeout: timeout_ms });
        attempt.http_status = response?.status?.() || null;
        attempt.final_url = page.url();
        attempt.chrome_error_page = isChromeErrorPage(attempt.final_url);
        if (attempt.chrome_error_page) {
          throw new Error(buildChromeErrorPageMessage(attempt.final_url));
        }
        attempt.succeeded = true;
        attempts.push(attempt);
        return {
          ok: true,
          attempts,
          wait_until_used: candidateWaitUntil,
          http_status: attempt.http_status,
          retry_statistics: summarizeRetryAttempts(attempts),
        };
      } catch (error) {
        const classification = classifyChromeError({
          message: error?.message || String(error),
          url: page.url(),
        });
        attempt.error = error?.message || String(error);
        attempt.final_url = page.url();
        attempt.error_code = classification.error_code;
        attempt.error_category = classification.error_category;
        attempt.chrome_error_page = classification.is_chrome_error_page;
        attempts.push(attempt);
        lastError = error;

        if (!classification.retryable || retryCount >= classification.max_retries) {
          break;
        }

        const retryDelayMs = classification.retry_delays_ms?.[retryCount] ?? 0;
        retryCount += 1;
        retryDelayMsForAttempt = retryDelayMs;
        if (retryDelayMs > 0) {
          await wait(retryDelayMs);
        }
      }
    }
  }

  return {
    ok: false,
    attempts,
    wait_until_used: lastWaitUntil,
    error: lastError?.message || `Navigation to ${url} failed`,
    retry_statistics: summarizeRetryAttempts(attempts),
  };
}

/**
 * @param {{
 *   url: string,
 *   wait_until?: string,
 *   timeout_ms?: number,
 *   browserWsEndpoint?: string,
 * }} params
 */
export async function navigate({
  url,
  wait_until = 'networkidle2',
  timeout_ms = 30_000,
  browserWsEndpoint,
  browserProfile = '',
} = {}) {
  if (!url) throw new Error('url is required');

  const browser = await connectBrowser(browserWsEndpoint);
  try {
    const page = await getPage(browser, { targetUrl: url, browserProfile });
    const tabs = trackNewTabs(browser, {
      openerPage: page,
      adopt: false,
      closeUnadopted: true,
    });
    const beforeUrl = page.url();

    const redirectChain = [];
    let httpStatus = null;
    let wait_until_used = wait_until;
    let goto_attempts = [];

    const responseListener = (res) => {
      const request = res.request?.();
      if (!request?.isNavigationRequest?.()) return;
      if (res.frame?.() !== page.mainFrame()) return;

      const status = res.status();
      if (status >= 300 && status < 400) redirectChain.push(res.url());
      if (!httpStatus) httpStatus = status;
    };
    page.on('response', responseListener);

    let success = false;
    let error = null;
    let retry_statistics = summarizeRetryAttempts([]);

    try {
      const gotoResult = await attemptGotoWithFallbackWaits(page, {
        url,
        wait_until,
        timeout_ms,
      });
      success = gotoResult.ok;
      error = gotoResult.ok ? null : gotoResult.error;
      wait_until_used = gotoResult.wait_until_used || wait_until;
      goto_attempts = gotoResult.attempts || [];
      retry_statistics = gotoResult.retry_statistics || summarizeRetryAttempts(goto_attempts);
      if (!httpStatus && gotoResult.http_status) {
        httpStatus = gotoResult.http_status;
      }
    } finally {
      page.off('response', responseListener);
    }

    const recovery_attempt = await retryNavigationAfterAutoRecovery(page, {
      url,
      waitUntil: wait_until_used || wait_until,
      timeoutMs: timeout_ms,
    });

    if (recovery_attempt.attempted && recovery_attempt.succeeded) {
      success = true;
      error = null;
    }

    await tabs.settle().catch(() => page);
    tabs.dispose();

    const finalUrl = page.url();
    const navigated = beforeUrl !== finalUrl;
    const title = await page.title().catch(() => '');
    const access_state = await readAccessState(page);
    const network_diagnostics = getPageNetworkDiagnostics(page, { limit: 10 });
    const iframe_diagnostics = await getIframeDiagnostics(page, { limit: 24 });
    const retry_recommendations = {
      retry_without_blocking: shouldRetryWithoutBlocking({
        criticalResourceFailures: network_diagnostics.critical_resource_failures,
        renderGapSignals: network_diagnostics.render_gap_signals,
      }),
      retry_with_proxy: shouldRetryWithProxy({
        policy: network_diagnostics.effective_policy,
        manifestFailure: network_diagnostics.manifest_failure,
        criticalResourceFailures: network_diagnostics.critical_resource_failures,
      }),
    };
    const navigation_attempt_summary = {
      ...retry_statistics,
      wait_candidates_tried: [...new Set(goto_attempts.map((attempt) => attempt.wait_until).filter(Boolean))],
      final_wait_until: wait_until_used,
      succeeded: success,
    };

    let screenshot_url = null;
    try {
      screenshot_url = await screenshotFull(page);
    } catch (_) {
      screenshot_url = null;
    }

    const originalDomain = (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();
    const finalDomain = (() => {
      try {
        return new URL(finalUrl).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();
    const domain_warning = originalDomain && finalDomain && originalDomain !== finalDomain
      ? `Redirected to different domain: ${finalDomain}`
      : null;

    return {
      success,
      finalUrl,
      navigated,
      title,
      httpStatus,
      redirectChain,
      domain_warning,
      screenshot_url,
      error,
      wait_until_used,
      goto_attempts,
      attempts: goto_attempts,
      retry_statistics,
      navigation_attempt_summary,
      access_state,
      opened_targets: tabs.opened_targets,
      blocked_popup_attempts: tabs.blocked_popup_attempts,
      selected_target: tabs.selected_target,
      target_decision: tabs.target_decision,
      active_page_url: tabs.active_page_url,
      opener_url: tabs.opener_url,
      effective_policy: network_diagnostics.effective_policy,
      effective_runtime: network_diagnostics.effective_runtime,
      critical_resource_failures: network_diagnostics.critical_resource_failures,
      render_gap_signals: network_diagnostics.render_gap_signals,
      manifest_failure: network_diagnostics.manifest_failure,
      retry_recommendations,
      network_diagnostics,
      iframe_diagnostics,
      recovery_attempt,
    };
  } finally {
    await browser.disconnect();
  }
}
