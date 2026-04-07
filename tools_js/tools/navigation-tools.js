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

export async function openUrl({
  url,
  wait_until = 'networkidle2',
  timeout_ms = 30000,
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ browser, page }) => {
    const tabs = trackNewTabs(browser);
    const before = await capturePageSnapshot(page, 'root');
    const redirect_chain = [];
    let http_status = null;
    let final_error = null;

    const responseListener = (response) => {
      const status = response.status();
      if (!http_status) http_status = status;
      if (status >= 300 && status < 400) redirect_chain.push(response.url());
    };

    page.on('response', responseListener);
    try {
      await page.goto(url, { waitUntil: wait_until, timeout: timeout_ms });
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
          await resolvedFrame.frame.waitForFunction(
            (patterns) => {
              const bodyText = (document.body?.innerText || '').toLowerCase();
              const html = (document.documentElement?.outerHTML || '').toLowerCase();
              const title = (document.title || '').toLowerCase();
              const haystack = `${title}\n${bodyText}\n${html}`;
              return !patterns.some((pattern) => haystack.includes(pattern));
            },
            { timeout: timeout_ms },
            [
              'cloudflare',
              'cf-challenge',
              'challenge-platform',
              'just a moment',
              'checking your browser',
              'verify you are human',
              'security check',
              'captcha',
              'attention required',
            ],
          );
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
