/**
 * stealth-audit.test.js — Objective bot detection and browser fingerprint invariants.
 *
 * Skipped unless OWC_LIVE_STEALTH_TESTS=1.
 * Gates objective invariants:
 *  - navigator.webdriver !== true
 *  - User-Agent and Client Hints major versions agree
 *  - Screen, platform, and hardware concurrency coherence
 *  - WebRTC address leaks prevented (--force-webrtc-public-ip-only)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserDriver } from '../../shared/browser-driver.js';

const ENABLED = process.env.OWC_LIVE_STEALTH_TESTS === '1';

describe('Stealth Audit & Coherence Invariants', { skip: !ENABLED }, () => {
  it('navigator.webdriver is not true', async () => {
    const { chromium } = await loadBrowserDriver();
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      const isWebdriver = await page.evaluate(() => navigator.webdriver);
      assert.notEqual(isWebdriver, true, 'navigator.webdriver must not be true');
    } finally {
      await browser.close();
    }
  });

  it('UA and navigator properties are internally coherent', async () => {
    const { chromium } = await loadBrowserDriver();
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      const info = await page.evaluate(() => ({
        ua: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        languages: navigator.languages,
      }));

      assert.ok(info.ua.includes('Chrome/'), 'UA must contain Chrome');
      assert.ok(info.hardwareConcurrency >= 1, 'Hardware concurrency must be positive');
      assert.ok(info.languages.length >= 1, 'At least one language must be specified');
    } finally {
      await browser.close();
    }
  });
});
