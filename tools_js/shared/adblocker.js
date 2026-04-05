/**
 * shared/adblocker.js — Ghostery adblocker (singleton).
 */

import { PuppeteerBlocker } from '@ghostery/adblocker-puppeteer';
import fetch from 'cross-fetch';

let _blocker = null;

export async function getBlocker() {
  if (!_blocker) {
    _blocker = await PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch);
  }
  return _blocker;
}

export async function enableBlocking(page) {
  const blocker = await getBlocker();
  await blocker.enableBlockingInPage(page);
}
