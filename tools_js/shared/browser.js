/**
 * shared/browser.js — puppeteer.connect() wrapper.
 * All tools call connectBrowser(wsEndpoint) instead of launching a new browser.
 */

"use strict";

const puppeteer = require("puppeteer-core");

/**
 * Connect to a running browser via WebSocket endpoint.
 * @param {string} wsEndpoint  e.g. "ws://localhost:9222/..."
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function connectBrowser(wsEndpoint) {
  return puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: { width: 1280, height: 800 },
  });
}

/**
 * Get or open a page on the connected browser.
 * Reuses an existing blank page if available; otherwise opens a new one.
 * @param {import('puppeteer-core').Browser} browser
 * @returns {Promise<import('puppeteer-core').Page>}
 */
async function getPage(browser) {
  const pages = await browser.pages();
  const blank = pages.find((p) => p.url() === "about:blank");
  return blank || (await browser.newPage());
}

module.exports = { connectBrowser, getPage };
