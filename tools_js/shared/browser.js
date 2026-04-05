/**
 * shared/browser.js — Puppeteer connect() wrapper.
 *
 * Tools never launch their own browser. They connect to the shared
 * headless Chrome instance via its WebSocket endpoint (provided by the
 * BROWSER_WS_ENDPOINT environment variable or the session context).
 */

import puppeteer from 'puppeteer-core';

const WS_ENDPOINT = process.env.BROWSER_WS_ENDPOINT || 'ws://chrome:3000';

/**
 * Connect to the shared browser. Returns a Browser instance.
 * Always call browser.disconnect() when done — never browser.close().
 */
export async function connectBrowser(wsEndpoint = WS_ENDPOINT) {
  return puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: { width: 1280, height: 800 },
  });
}

/**
 * Get the active page (reuse blank page or open a new one).
 */
export async function getPage(browser) {
  const pages = await browser.pages();
  const blank = pages.find(p => p.url() === 'about:blank');
  return blank ?? browser.newPage();
}
