/**
 * tools/screenshot.js — Quick screenshot + video state check.
 * Lighter than inspect — no DOM scan.
 */

import { connectBrowser, getPage } from '../shared/browser.js';
import { screenshotFull, screenshotViewport, screenshotElement } from '../shared/screenshot.js';

/**
 * @param {{
 *   mode?: 'viewport'|'full'|'element',
 *   selector?: string,
 *   browserWsEndpoint?: string,
 * }} params
 */
export async function screenshot({
  mode = 'viewport',
  selector = 'video',
  browserWsEndpoint,
} = {}) {
  const browser = await connectBrowser(browserWsEndpoint);
  const page    = await getPage(browser);

  let screenshot_url;
  switch (mode) {
    case 'full':    screenshot_url = await screenshotFull(page);              break;
    case 'element': screenshot_url = await screenshotElement(page, selector); break;
    default:        screenshot_url = await screenshotViewport(page);          break;
  }

  const video_state = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return 'absent';
    if (!v.paused && v.readyState >= 2) return 'playing';
    if (v.paused && v.readyState >= 2) return 'paused';
    return 'loading';
  });

  await browser.disconnect();
  return { screenshot_url, video_state, url: page.url() };
}
