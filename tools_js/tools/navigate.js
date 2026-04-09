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
import { screenshotFull } from '../shared/screenshot.js';
import { detectAccessStateFromSignals } from '../shared/tool-runtime.js';

function buildWaitUntilCandidates(waitUntil) {
  const ordered = [
    waitUntil,
    'networkidle2',
    'domcontentloaded',
    'load',
  ].filter(Boolean);
  return [...new Set(ordered)];
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

  for (const candidateWaitUntil of waitCandidates) {
    const attempt = {
      wait_until: candidateWaitUntil,
      timeout_ms,
      http_status: null,
      final_url: '',
      error: null,
      succeeded: false,
    };

    try {
      const response = await page.goto(url, { waitUntil: candidateWaitUntil, timeout: timeout_ms });
      attempt.http_status = response?.status?.() || null;
      attempt.final_url = page.url();
      attempt.succeeded = true;
      attempts.push(attempt);
      return {
        ok: true,
        attempts,
        wait_until_used: candidateWaitUntil,
        http_status: attempt.http_status,
      };
    } catch (error) {
      attempt.error = error.message;
      attempt.final_url = page.url();
      attempts.push(attempt);
      lastError = error;
    }
  }

  return {
    ok: false,
    attempts,
    wait_until_used: waitCandidates[waitCandidates.length - 1] || wait_until,
    error: lastError?.message || `Navigation to ${url} failed`,
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
} = {}) {
  if (!url) throw new Error('url is required');

  const browser = await connectBrowser(browserWsEndpoint);
  try {
    const page = await getPage(browser, { targetUrl: url });
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

    const finalUrl = page.url();
    const navigated = beforeUrl !== finalUrl;
    const title = await page.title().catch(() => '');
    const access_state = await readAccessState(page);
    const network_diagnostics = getPageNetworkDiagnostics(page, { limit: 40 });
    const iframe_diagnostics = await getIframeDiagnostics(page, { limit: 24 });

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
      access_state,
      network_diagnostics,
      iframe_diagnostics,
      recovery_attempt,
    };
  } finally {
    await browser.disconnect();
  }
}
