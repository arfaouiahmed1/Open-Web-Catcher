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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHALLENGE_TEXT_MARKERS = [
  'cloudflare',
  'cf-challenge',
  'challenge-platform',
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

export async function openUrl({
  url,
  wait_until = 'networkidle2',
  timeout_ms = 30000,
  challenge_wait_ms = 6000,
  retry_on_challenge = true,
  max_challenge_retries = 1,
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ browser, page }) => {
    const tabs = trackNewTabs(browser);
    const before = await capturePageSnapshot(page, 'root');
    const redirect_chain = [];
    const navigation_attempts = [];
    const retriesAllowed = Math.max(0, Number.parseInt(String(max_challenge_retries || 0), 10) || 0);
    const shouldRetryOnChallenge = Boolean(retry_on_challenge);
    let http_status = null;
    let final_error = null;
    let challengeHandling = {
      challenge_detected: false,
      waited: false,
      cleared: false,
      retries_used: 0,
      retries_allowed: retriesAllowed,
      timeout_ms: challenge_wait_ms,
    };

    const responseListener = (response) => {
      const status = response.status();
      if (!http_status) http_status = status;
      if (status >= 300 && status < 400) redirect_chain.push(response.url());
    };

    page.on('response', responseListener);
    try {
      for (let attempt = 0; attempt <= retriesAllowed; attempt += 1) {
        if (attempt > 0) {
          challengeHandling.retries_used = Math.max(challengeHandling.retries_used, attempt);
        }

        const attemptInfo = {
          attempt: attempt + 1,
          wait_until,
          timeout_ms,
          phase: attempt === 0 ? 'initial' : 'retry',
        };

        try {
          const response = await page.goto(url, { waitUntil: wait_until, timeout: timeout_ms });
          attemptInfo.http_status = response?.status?.() || null;
          attemptInfo.error = null;
          final_error = null;
          if (!http_status && response?.status) {
            http_status = response.status();
          }
        } catch (error) {
          final_error = error.message;
          attemptInfo.http_status = null;
          attemptInfo.error = error.message;
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
        challengeHandling.waited = challengeHandling.waited || waitResult.waited;
        challengeHandling.cleared = waitResult.cleared;
        challengeHandling.wait_error = waitResult.error;
        challengeHandling.retries_used = attempt;

        if (waitResult.cleared) {
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
      tabs.dispose();
    }

    const after = await capturePageSnapshot(page, 'root');
    return buildEnvelope(page, {
      frame_path: 'root',
      ok: !final_error,
      error: final_error,
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls),
      data: {
        requested_url: url,
        final_url: page.url(),
        wait_until,
        timeout_ms,
        challenge_wait_ms,
        retry_on_challenge: shouldRetryOnChallenge,
        max_challenge_retries: retriesAllowed,
        challenge_handling: challengeHandling,
        navigation_attempts,
        http_status,
        redirect_chain,
      },
    });
  });
}

export async function goBack({
  timeout_ms = 30000,
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const before = await capturePageSnapshot(page, 'root');
    let final_error = null;
    try {
      await page.goBack({ waitUntil: 'networkidle2', timeout: timeout_ms });
    } catch (error) {
      final_error = error.message;
    }
    const after = await capturePageSnapshot(page, 'root');
    return buildEnvelope(page, {
      frame_path: 'root',
      ok: !final_error,
      error: final_error,
      observed_change: makeObservedChange(before, after, []),
      data: {
        final_url: page.url(),
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
    await resolvedFrame.frame.evaluate(
      ({ scrollDelta, scrollBehavior }) => {
        window.scrollBy({ top: scrollDelta, behavior: scrollBehavior });
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
        data: { error_code: resolved.code || 'scroll_target_not_found' },
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
    const resolvedFrame = await resolveFrame(page, frame_path);

    if (!resolvedFrame.ok) {
      return buildEnvelope(page, { frame_path, ok: false, error: resolvedFrame.error });
    }

    let final_error = null;
    try {
      switch (mode) {
        case 'network_idle':
        case 'navigation_complete':
          await page.waitForNetworkIdle({ idleTime: 500, timeout: timeout_ms });
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
        case 'challenge_cleared':
          await waitForChallengeClear(resolvedFrame.frame, timeout_ms).then((result) => {
            if (!result.cleared) {
              throw new Error(result.error || `Challenge markers still present after ${timeout_ms}ms`);
            }
          });
          break;
        default:
          throw new Error(`Unknown wait mode '${mode}'`);
      }
    } catch (error) {
      final_error = error.message;
    }

    return buildEnvelope(page, {
      frame_path,
      ok: !final_error,
      error: final_error,
      data: {
        mode,
        selector,
        text,
        timeout_ms,
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
