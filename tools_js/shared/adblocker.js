/**
 * shared/adblocker.js — Ghostery adblocker setup for Puppeteer pages.
 */

"use strict";

const { PuppeteerBlocker } = require("@ghostery/adblocker-puppeteer");
const fetch = require("cross-fetch");

let _blocker = null;

/**
 * Get (or lazily create) the singleton blocker instance.
 * @returns {Promise<PuppeteerBlocker>}
 */
async function getBlocker() {
  if (!_blocker) {
    _blocker = await PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch);
  }
  return _blocker;
}

/**
 * Enable ad/tracker blocking on a Puppeteer page.
 * @param {import('puppeteer-core').Page} page
 */
async function enableBlocking(page) {
  const blocker = await getBlocker();
  await blocker.enableBlockingInPage(page);
}

module.exports = { enableBlocking };
