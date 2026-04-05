/**
 * tools/navigate.js — Navigate to a URL, handle redirects.
 */

import { connectBrowser, getPage } from '../shared/browser.js';
import { screenshotViewport } from '../shared/screenshot.js';

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
  const page    = await getPage(browser);

  const redirectChain = [];
  let httpStatus = null;

  page.on('response', res => {
    const s = res.status();
    if (s >= 300 && s < 400) redirectChain.push(res.url());
    if (!httpStatus) httpStatus = s;
  });

  let success = false;
  let error   = null;

  try {
    await page.goto(url, { waitUntil: wait_until, timeout: timeout_ms });
    success = true;
  } catch (e) {
    error = e.message;
  }

  const finalUrl = page.url();
  const title    = await page.title().catch(() => '');

  let screenshot_url = null;
  try { screenshot_url = await screenshotViewport(page); } catch (_) {}

  // Warn if we ended up on a different domain
  const originalDomain = new URL(url).hostname.replace(/^www\./, '');
  const finalDomain    = (() => { try { return new URL(finalUrl).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
  const domain_warning = originalDomain !== finalDomain ? `Redirected to different domain: ${finalDomain}` : null;

  await browser.disconnect();

  return { success, finalUrl, title, httpStatus, redirectChain, domain_warning, screenshot_url, error };
}
