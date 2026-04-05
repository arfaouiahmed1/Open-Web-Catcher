/**
 * tools/interact.js — Click / play / type / select / coordinates / check.
 * Anti-bot evasion via human-like delays + bezier mouse movement.
 */

import { connectBrowser, getPage } from '../shared/browser.js';

const delay = (min = 80, max = 300) =>
  new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

/**
 * @param {{
 *   mode: 'click'|'play'|'type'|'select'|'coordinates'|'check',
 *   selector?: string,
 *   xpath?: string,
 *   text?: string,
 *   value?: string,
 *   option_text?: string,
 *   x?: number,
 *   y?: number,
 *   wait_ms?: number,
 *   browserWsEndpoint?: string,
 * }} params
 */
export async function interact({
  mode = 'click',
  selector = '',
  xpath = '',
  text = '',
  value = '',
  option_text = '',
  x,
  y,
  wait_ms = 3000,
  browserWsEndpoint,
} = {}) {
  const browser = await connectBrowser(browserWsEndpoint);
  const page    = await getPage(browser);

  let success = false;
  let error   = null;
  const new_tab_urls = [];

  // Capture new tabs (usually ad popups — record but ignore)
  browser.on('targetcreated', async target => {
    if (target.type() === 'page') {
      const p = await target.page();
      new_tab_urls.push(p.url());
      await p.close().catch(() => {});
    }
  });

  try {
    switch (mode) {
      case 'click': {
        const el = await _resolveElement(page, selector, xpath, text);
        await delay();
        await el.click();
        success = true;
        break;
      }

      case 'play': {
        // Try explicit element first, then fallback to video.play()
        if (selector || xpath || text) {
          try {
            const el = await _resolveElement(page, selector, xpath, text);
            await delay(50, 150);
            await el.click();
            success = true;
            break;
          } catch (_) { /* fall through to JS fallback */ }
        }
        await page.evaluate(() => document.querySelector('video')?.play());
        success = true;
        break;
      }

      case 'type': {
        const el = await _resolveElement(page, selector, xpath, text);
        await el.click();
        await delay(50, 100);
        await el.type(value, { delay: 50 + Math.random() * 80 });
        success = true;
        break;
      }

      case 'select': {
        await page.select(selector, option_text);
        success = true;
        break;
      }

      case 'coordinates': {
        if (x == null || y == null) throw new Error('x and y are required for coordinates mode');
        // Bezier-like movement: move to midpoint first, then target
        const midX = x * 0.6 + Math.random() * 40;
        const midY = y * 0.6 + Math.random() * 40;
        await page.mouse.move(midX, midY, { steps: 8 });
        await delay(40, 100);
        await page.mouse.move(x, y, { steps: 6 });
        await delay(30, 80);
        await page.mouse.click(x, y);
        success = true;
        break;
      }

      case 'check': {
        const el = await _resolveElement(page, selector, xpath, text);
        await el.click();
        success = true;
        break;
      }

      default:
        throw new Error(`Unknown interact mode: ${mode}`);
    }

    // Wait for network to settle
    await page.waitForNetworkIdle({ idleTime: 500, timeout: wait_ms }).catch(() => {});
  } catch (e) {
    error = e.message;
  }

  const navigated = !page.url().startsWith('about') && page.url() !== (await getPage(browser).catch(() => page)).url();

  await browser.disconnect();
  return {
    success,
    mode,
    navigated,
    new_tab_urls,
    url:   page.url(),
    error,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _resolveElement(page, selector, xpath, text) {
  // Priority: selector → xpath → text content
  if (selector) {
    return page.waitForSelector(selector, { timeout: 8000 });
  }
  if (xpath) {
    await page.waitForSelector(`::-p-xpath(${xpath})`, { timeout: 8000 });
    const [el] = await page.$$(`::-p-xpath(${xpath})`);
    if (el) return el;
  }
  if (text) {
    // Find by visible text
    const el = await page.evaluateHandle(t => {
      for (const el of document.querySelectorAll('button, a, [role="button"], input[type="button"]')) {
        if ((el.innerText || el.textContent || '').trim().toLowerCase().includes(t.toLowerCase())) return el;
      }
      return null;
    }, text);
    if (el.asElement()) return el.asElement();
  }
  throw new Error(`Could not resolve element: selector=${selector} xpath=${xpath} text=${text}`);
}
