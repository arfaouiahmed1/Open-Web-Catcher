import {
  buildEnvelope,
  capturePageSnapshot,
  detectAccessStateFromSignals,
  makeObservedChange,
  resolveElementTarget,
  resolveFrame,
  trackNewTabs,
  withBrowserSession,
} from '../shared/tool-runtime.js';
import {
  getIframeDiagnostics,
  getPageNetworkDiagnostics,
  retryNavigationAfterAutoRecovery,
} from '../shared/browser.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHALLENGE_TEXT_MARKERS = [
  'cf-challenge',
  'challenge-platform',
  'cdn-cgi/challenge',
  'just a moment',
  'checking your browser',
  'verify you are human',
  'security check',
  'captcha',
  'attention required',
];

async function readAccessState(page, frame) {
  return detectAccessStateFromSignals({
    title: await page.title().catch(() => ''),
    textSample: await frame.evaluate(() => (document.body?.innerText || '').slice(0, 1600)).catch(() => ''),
    htmlSample: await frame.evaluate(() => (document.documentElement?.outerHTML || '').slice(0, 2000)).catch(() => ''),
    url: page.url(),
  });
}

async function waitForChallengeClear(frame, timeoutMs) {
  if (!(timeoutMs > 0)) {
    return { waited: false, cleared: false, timeout_ms: timeoutMs, error: null };
  }

  try {
    await frame.waitForFunction(
      (patterns) => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const html = (document.documentElement?.outerHTML || '').toLowerCase();
        const title = (document.title || '').toLowerCase();
        const haystack = `${title}\n${bodyText}\n${html}`;
        return !patterns.some((pattern) => haystack.includes(pattern));
      },
      { timeout: timeoutMs },
      CHALLENGE_TEXT_MARKERS,
    );

    return { waited: true, cleared: true, timeout_ms: timeoutMs, error: null };
  } catch (error) {
    return {
      waited: true,
      cleared: false,
      timeout_ms: timeoutMs,
      error: error.message,
    };
  }
}

function normalizePwWaitUntil(value) {
  if (value === 'networkidle0' || value === 'networkidle2') return 'networkidle';
  return value;
}

function buildWaitUntilCandidates(waitUntil) {
  const ordered = [
    normalizePwWaitUntil(waitUntil),
    'networkidle',
    'domcontentloaded',
    'load',
  ].filter(Boolean);
  return [...new Set(ordered)];
}

async function attemptPageGotoWithFallbackWaits(page, {
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
      const response = await page.goto(url, {
        waitUntil: candidateWaitUntil,
        timeout: timeout_ms,
      });
      attempt.http_status = response?.status?.() || null;
      attempt.final_url = page.url();
      attempt.succeeded = true;
      attempts.push(attempt);
      return {
        ok: true,
        attempts,
        http_status: attempt.http_status,
        wait_until_used: candidateWaitUntil,
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

export async function openUrl({
  url,
  wait_until = 'networkidle',
  timeout_ms = 30000,
  challenge_wait_ms = 6000,
  retry_on_challenge = true,
  max_challenge_retries = 1,
  browserWsEndpoint,
  browserProfile = '',
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ browser, context, page }) => {
    const tabs = trackNewTabs(context, {
      openerPage: page,
      adopt: false,
      closeUnadopted: true,
    });
    const before = await capturePageSnapshot(page, 'root');
    const redirect_chain = [];
    const navigation_attempts = [];
    const retriesAllowed = Math.max(0, Number.parseInt(String(max_challenge_retries || 0), 10) || 0);
    const shouldRetryOnChallenge = Boolean(retry_on_challenge);
    let http_status = null;
    let final_error = null;
    const challengeHandling = {
      challenge_detected: false,
      waited: false,
      cleared: false,
      retries_used: 0,
      retries_allowed: retriesAllowed,
      timeout_ms: challenge_wait_ms,
      wait_error: null,
    };

    const responseListener = (response) => {
      const request = response.request?.();
      if (!request?.isNavigationRequest?.()) return;
      if (response.frame?.() !== page.mainFrame()) return;
      const status = response.status();
      if (!http_status) http_status = status;
      if (status >= 300 && status < 400) redirect_chain.push(response.url());
    };

    page.on('response', responseListener);
    try {
      for (let attempt = 0; attempt <= retriesAllowed; attempt += 1) {
        challengeHandling.retries_used = Math.max(challengeHandling.retries_used, attempt);

        const attemptInfo = {
          attempt: attempt + 1,
          wait_until,
          timeout_ms,
          phase: attempt === 0 ? 'initial' : 'retry',
          wait_until_used: wait_until,
          goto_attempts: [],
          challenge_wait: null,
        };

        const gotoResult = await attemptPageGotoWithFallbackWaits(page, {
          url,
          wait_until,
          timeout_ms,
        });
        attemptInfo.goto_attempts = gotoResult.attempts || [];
        attemptInfo.wait_until_used = gotoResult.wait_until_used || wait_until;
        attemptInfo.http_status = gotoResult.http_status || null;
        attemptInfo.error = gotoResult.ok ? null : gotoResult.error;
        final_error = gotoResult.ok ? null : gotoResult.error;
        if (!http_status && gotoResult.http_status) {
          http_status = gotoResult.http_status;
        }

        const accessState = await readAccessState(page, page.mainFrame());
        attemptInfo.access_state = accessState;
        navigation_attempts.push(attemptInfo);

        if (!accessState.challenge_detected) {
          challengeHandling.challenge_detected = challengeHandling.challenge_detected || accessState.challenge_detected;
          break;
        }

        challengeHandling.challenge_detected = true;
        if (!shouldRetryOnChallenge) {
          break;
        }

        const waitResult = await waitForChallengeClear(page.mainFrame(), challenge_wait_ms);
        attemptInfo.challenge_wait = waitResult;
        challengeHandling.waited = challengeHandling.waited || waitResult.waited;
        challengeHandling.cleared = waitResult.cleared;
        challengeHandling.wait_error = waitResult.error;
        challengeHandling.retries_used = Math.max(challengeHandling.retries_used, attempt);

        if (waitResult.cleared) {
          await page.waitForLoadState('networkidle', { timeout: Math.max(1200, Math.floor(timeout_ms / 2)) }).catch(() => {});
          final_error = null;
          break;
        }

        if (attempt >= retriesAllowed) {
          break;
        }
      }
    } catch (error) {
      final_error = error.message;
    } finally {
      page.off('response', responseListener);
      await tabs.settle().catch(() => page);
      tabs.dispose();
    }

    const recovery_attempt = await retryNavigationAfterAutoRecovery(page, {
      url,
      waitUntil: wait_until,
      timeoutMs: timeout_ms,
    });
    if (recovery_attempt.attempted && recovery_attempt.succeeded) {
      final_error = null;
    }

    const network_diagnostics = getPageNetworkDiagnostics(page, { limit: 40 });
    const iframe_diagnostics = await getIframeDiagnostics(page, { limit: 24 });
    const final_access_state = await readAccessState(page, page.mainFrame());

    const after = await capturePageSnapshot(page, 'root');
    return buildEnvelope(page, {
      frame_path: 'root',
      screenshotMode: 'full',
      ok: !final_error,
      error: final_error,
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls, tabs),
      data: {
        requested_url: url,
        final_url: page.url(),
        opened_targets: tabs.opened_targets,
        blocked_popup_attempts: tabs.blocked_popup_attempts,
        selected_target: tabs.selected_target,
        target_decision: tabs.target_decision,
        active_page_url: tabs.active_page_url,
        opener_url: tabs.opener_url,
        wait_until,
        timeout_ms,
        challenge_wait_ms,
        retry_on_challenge: shouldRetryOnChallenge,
        max_challenge_retries: retriesAllowed,
        challenge_handling: challengeHandling,
        navigation_attempts,
        http_status,
        redirect_chain,
        wait_fallback_used: navigation_attempts.some((entry) => entry.wait_until_used && entry.wait_until_used !== wait_until),
        effective_policy: network_diagnostics.effective_policy,
        effective_runtime: network_diagnostics.effective_runtime,
        critical_resource_failures: network_diagnostics.critical_resource_failures,
        render_gap_signals: network_diagnostics.render_gap_signals,
        manifest_failure: network_diagnostics.manifest_failure,
        network_diagnostics,
        iframe_diagnostics,
        final_access_state,
        recovery_attempt,
      },
    });
  }, { targetUrl: url, browserProfile });
}

export async function goBack({
  timeout_ms = 30000,
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const before = await capturePageSnapshot(page, 'root');
    let final_error = null;
    let no_history = false;
    let wait_until_used = 'networkidle';
    const attempts = [];

    for (const waitMode of ['networkidle', 'domcontentloaded']) {
      wait_until_used = waitMode;
      try {
        const response = await page.goBack({ waitUntil: waitMode, timeout: timeout_ms });
        const http_status = response?.status?.() || null;
        no_history = response == null;
        attempts.push({ wait_until: waitMode, http_status, no_history, error: null });
        final_error = null;
        break;
      } catch (error) {
        final_error = error.message;
        attempts.push({ wait_until: waitMode, http_status: null, no_history: false, error: error.message });
      }

      if (no_history) break;
    }

    const after = await capturePageSnapshot(page, 'root');
    return buildEnvelope(page, {
      frame_path: 'root',
      ok: !final_error && !no_history,
      error: final_error || (no_history ? 'No browser history entry to go back to.' : null),
      observed_change: makeObservedChange(before, after, []),
      data: {
        final_url: page.url(),
        no_history,
        wait_until_used,
        attempts,
      },
    });
  });
}

export async function scrollPage({
  frame_path = 'root',
  direction = 'down',
  amount = 600,
  behavior = 'auto',
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    const resolvedFrame = await resolveFrame(page, frame_path);
    if (!resolvedFrame.ok) {
      return buildEnvelope(page, { frame_path, ok: false, error: resolvedFrame.error });
    }

    const delta = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
    const scroll_result = await resolvedFrame.frame.evaluate(
      ({ scrollDelta, scrollBehavior }) => {
        const scrollRoot = document.scrollingElement || document.documentElement || document.body;
        const beforeWindowY = Number(window.scrollY || 0);
        const beforeRootTop = Number(scrollRoot?.scrollTop || 0);

        window.scrollBy({ top: scrollDelta, behavior: scrollBehavior });

        const afterWindowY = Number(window.scrollY || 0);
        const afterRootTop = Number(scrollRoot?.scrollTop || 0);
        let actualDelta = afterRootTop - beforeRootTop;
        let target = 'window';

        if (Math.abs(actualDelta) < 2) {
          const scrollable = Array.from(document.querySelectorAll('*'))
            .map((node) => ({
              node,
              style: window.getComputedStyle(node),
            }))
            .filter(({ node, style }) => {
              const overflow = `${style.overflowY} ${style.overflow}`;
              const canScroll = /(auto|scroll)/.test(overflow);
              return canScroll && (node.scrollHeight - node.clientHeight) > 20;
            })
            .sort((a, b) => (b.node.clientHeight * b.node.clientWidth) - (a.node.clientHeight * a.node.clientWidth));

          const fallback = scrollable[0]?.node || null;
          if (fallback) {
            const beforeFallbackTop = Number(fallback.scrollTop || 0);
            fallback.scrollBy({ top: scrollDelta, behavior: scrollBehavior });
            const afterFallbackTop = Number(fallback.scrollTop || 0);
            actualDelta = afterFallbackTop - beforeFallbackTop;

            if (fallback.id) {
              target = `#${fallback.id}`;
            } else if (fallback.className) {
              const classBits = String(fallback.className)
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .join('.');
              target = classBits ? `${fallback.tagName.toLowerCase()}.${classBits}` : fallback.tagName.toLowerCase();
            } else {
              target = fallback.tagName.toLowerCase();
            }
          }
        }

        return {
          target,
          requested_delta: scrollDelta,
          actual_delta: actualDelta,
          before_window_y: beforeWindowY,
          after_window_y: afterWindowY,
        };
      },
      { scrollDelta: delta, scrollBehavior: behavior },
    );
    await wait(200);
    const after = await capturePageSnapshot(page, frame_path);
    return buildEnvelope(page, {
      frame_path,
      observed_change: makeObservedChange(before, after, []),
      data: {
        direction,
        amount: Math.abs(amount),
        behavior,
        scroll_result,
      },
    });
  });
}

export async function scrollToElement({
  frame_path = 'root',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    const resolved = await resolveElementTarget(page, { frame_path, element_ref, selector, xpath, text });
    if (!resolved.ok) {
      return buildEnvelope(page, {
        frame_path: resolved.frame_path || frame_path,
        ok: false,
        error: resolved.error,
        data: {
          error_code: resolved.code || 'scroll_target_not_found',
          stale_ref_detected: Boolean(resolved.stale_ref_detected),
          frame_fallback_applied: Boolean(resolved.frame_fallback_applied),
          resolution_attempts: resolved.resolution_attempts || [],
        },
      });
    }

    try {
      await resolved.handle.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }));
      const after = await capturePageSnapshot(page, resolved.frame_path);
      return buildEnvelope(page, {
        frame_path: resolved.frame_path,
        screenshotHandle: resolved.handle,
        observed_change: makeObservedChange(before, after, []),
        data: {
          locator_used: resolved.locator_used,
          stale_ref_detected: Boolean(resolved.stale_ref_detected),
          frame_fallback_applied: Boolean(resolved.frame_fallback_applied),
          frame_relocated: Boolean(resolved.frame_relocated),
          resolution_attempts: resolved.resolution_attempts || [],
        },
      });
    } catch (error) {
      const after = await capturePageSnapshot(page, resolved.frame_path);
      return buildEnvelope(page, {
        frame_path: resolved.frame_path,
        ok: false,
        error: error.message,
        observed_change: makeObservedChange(before, after, []),
        data: {
          error_code: 'scroll_target_action_failed',
          locator_used: resolved.locator_used,
          stale_ref_detected: Boolean(resolved.stale_ref_detected),
          frame_fallback_applied: Boolean(resolved.frame_fallback_applied),
          frame_relocated: Boolean(resolved.frame_relocated),
          resolution_attempts: resolved.resolution_attempts || [],
        },
      });
    } finally {
      await resolved.handle.dispose().catch(() => {});
    }
  });
}

export async function waitForPageState({
  frame_path = 'root',
  mode = 'network_idle',
  selector = '',
  text = '',
  timeout_ms = 10000,
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    const resolvedFrame = await resolveFrame(page, frame_path);

    if (!resolvedFrame.ok) {
      return buildEnvelope(page, { frame_path, ok: false, error: resolvedFrame.error });
    }

    if (mode === 'selector' && !String(selector || '').trim()) {
      return buildEnvelope(page, {
        frame_path,
        ok: false,
        error: 'selector is required when mode="selector"',
        observed_change: makeObservedChange(before, before, []),
      });
    }

    if (mode === 'text' && !String(text || '').trim()) {
      return buildEnvelope(page, {
        frame_path,
        ok: false,
        error: 'text is required when mode="text"',
        observed_change: makeObservedChange(before, before, []),
      });
    }

    let final_error = null;
    const wait_details = {
      mode,
      timeout_ms,
      strategy: 'primary',
      challenge_wait: null,
    };

    try {
      switch (mode) {
        case 'network_idle':
        case 'navigation_complete':
          await page.waitForLoadState('networkidle', { timeout: timeout_ms });
          break;
        case 'selector':
          await resolvedFrame.frame.waitForSelector(selector, { timeout: timeout_ms });
          break;
        case 'text':
          await resolvedFrame.frame.waitForFunction(
            (needle) => (document.body?.innerText || '').toLowerCase().includes(String(needle).toLowerCase()),
            { timeout: timeout_ms },
            text,
          );
          break;
        case 'video_ready':
          await resolvedFrame.frame.waitForFunction(
            () => Array.from(document.querySelectorAll('video')).some((video) => video.readyState >= 2),
            { timeout: timeout_ms },
          );
          break;
        case 'challenge_cleared': {
          const challengeResult = await waitForChallengeClear(resolvedFrame.frame, timeout_ms);
          wait_details.challenge_wait = challengeResult;
          if (!challengeResult.cleared) {
            throw new Error(challengeResult.error || `Challenge markers still present after ${timeout_ms}ms`);
          }
          break;
        }
        default:
          throw new Error(`Unknown wait mode '${mode}'`);
      }
    } catch (error) {
      if ((mode === 'network_idle' || mode === 'navigation_complete') && /timeout/i.test(String(error.message || ''))) {
        try {
          await resolvedFrame.frame.waitForFunction(
            () => document.readyState === 'complete' || document.readyState === 'interactive',
            { timeout: Math.max(1000, Math.floor(timeout_ms / 2)) },
          );
          wait_details.strategy = 'ready_state_fallback';
        } catch (fallbackError) {
          final_error = `${error.message}; fallback failed: ${fallbackError.message}`;
        }
      } else {
        final_error = error.message;
      }
    }

    const after = await capturePageSnapshot(page, frame_path);

    return buildEnvelope(page, {
      frame_path,
      ok: !final_error,
      error: final_error,
      observed_change: makeObservedChange(before, after, []),
      data: {
        mode,
        selector,
        text,
        timeout_ms,
        wait_details,
        access_state_after_wait: detectAccessStateFromSignals({
          title: await page.title().catch(() => ''),
          textSample: await resolvedFrame.frame.evaluate(() => (document.body?.innerText || '').slice(0, 1600)).catch(() => ''),
          htmlSample: await resolvedFrame.frame.evaluate(() => (document.documentElement?.outerHTML || '').slice(0, 2000)).catch(() => ''),
          url: page.url(),
        }),
      },
    });
  });
}
