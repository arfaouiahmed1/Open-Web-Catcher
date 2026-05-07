import assert from 'node:assert/strict';
import fs from 'node:fs';

import { closeEphemeralBrowser, launchEphemeralBrowser } from '../shared/browser.js';
import { getBrowserRuntimeSettings } from '../shared/runtime-config.js';

const runtime = getBrowserRuntimeSettings('playwright');
assert.equal(runtime.ubol_enabled, true, 'Playwright runtime should load persisted uBOL settings.');
assert.ok(Array.isArray(runtime.adblock_allowlist_hosts), 'Allowlist hosts should normalize to an array.');

const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH
  || process.env.PUPPETEER_EXECUTABLE_PATH
  || '/usr/local/bin/google-chrome-stable';
if (!fs.existsSync(executablePath)) {
  console.log(`Skipped Playwright uBOL launch test because Chrome is unavailable at ${executablePath}.`);
  process.exit(0);
}

const session = await launchEphemeralBrowser('ubol-test-playwright', { browserProfile: 'classification' });
try {
  assert.equal(session.launchPolicy.ubol_enabled, true, 'Standard Playwright profiles should keep uBOL enabled.');
  const page = session.context.pages()[0] || await session.context.newPage();
  await page.waitForTimeout(1000);
  const extensionWorker = session.context.serviceWorkers()
    .find((worker) => String(worker.url() || '').startsWith('chrome-extension://'));
  assert.ok(extensionWorker, 'Expected a uBOL extension service worker in Playwright isolated browser.');
} finally {
  await closeEphemeralBrowser(session);
}

console.log('Validated Playwright uBOL runtime config and isolated browser launch.');
