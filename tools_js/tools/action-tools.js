import {
  buildEnvelope,
  capturePageSnapshot,
  makeObservedChange,
  resolveElementTarget,
  trackNewTabs,
  withBrowserSession,
} from '../shared/tool-runtime.js';

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
  return withBrowserSession(browserWsEndpoint, async ({ browser, page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    const tabs = trackNewTabs(browser);
    const resolved = await resolveElementTarget(page, { frame_path, element_ref, selector, xpath, text });

    if (!resolved.ok) {
      tabs.dispose();
      return buildEnvelope(page, {
        frame_path: resolved.frame_path || frame_path,
        ok: false,
        error: resolved.error,
        data: { error_code: resolved.code || 'action_target_not_found' },
      });
    }

    let finalError = null;
    try {
      await execute({ page, frame: resolved.frame, handle: resolved.handle });
      if (wait_ms > 0) {
        await wait(wait_ms);
      }
      await page.waitForNetworkIdle({ idleTime: 300, timeout: Math.max(wait_ms, 1500) }).catch(() => {});
    } catch (error) {
      finalError = error.message;
    } finally {
      tabs.dispose();
    }

    const after = await capturePageSnapshot(page, resolved.frame_path);
    const result = await buildEnvelope(page, {
      frame_path: resolved.frame_path,
      ok: !finalError,
      error: finalError,
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls),
      screenshotHandle: screenshot_target ? resolved.handle : null,
      data: {
        locator_used: resolved.locator_used,
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
      const selectorValue = await handle.evaluate((node) => {
        if (node.id) return `#${node.id}`;
        if (node.getAttribute('name')) return `[name="${node.getAttribute('name')}"]`;
        return null;
      });

      if (selectorValue && option_value) {
        await frame.select(selectorValue, option_value);
        return;
      }

      await handle.select(option_value || '');
      if (option_text && !option_value) {
        await handle.evaluate((node, desiredText) => {
          const option = Array.from(node.options || []).find((entry) =>
            (entry.textContent || '').toLowerCase().includes(String(desiredText).toLowerCase()));
          if (!option) throw new Error(`Option not found: ${desiredText}`);
          node.value = option.value;
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }, option_text);
      }
    },
  });
}

export async function playMedia({
  frame_path = 'root',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  wait_ms = 1500,
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
      if (handle) {
        await handle.click().catch(async () => {
          await handle.evaluate((node) => node.play?.());
        });
      } else {
        await frame.evaluate(() => document.querySelector('video')?.play?.());
      }
    },
  });
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
  return withBrowserSession(browserWsEndpoint, async ({ browser, page }) => {
    const before = await capturePageSnapshot(page, frame_path);
    const tabs = trackNewTabs(browser);
    let finalError = null;
    try {
      await page.mouse.move(x, y, { steps: 8 });
      await page.mouse.click(x, y);
      if (wait_ms > 0) await wait(wait_ms);
      await page.waitForNetworkIdle({ idleTime: 300, timeout: Math.max(wait_ms, 1500) }).catch(() => {});
    } catch (error) {
      finalError = error.message;
    } finally {
      tabs.dispose();
    }
    const after = await capturePageSnapshot(page, frame_path);
    return buildEnvelope(page, {
      frame_path,
      ok: !finalError,
      error: finalError,
      observed_change: makeObservedChange(before, after, tabs.new_tab_urls),
      data: {
        coordinates: { x, y },
      },
    });
  });
}
