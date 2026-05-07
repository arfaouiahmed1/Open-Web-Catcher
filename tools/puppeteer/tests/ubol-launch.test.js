import assert from 'node:assert/strict';
import fs from 'node:fs';

import { closeEphemeralBrowser, launchEphemeralBrowser } from '../shared/browser.js';
import { getBrowserRuntimeSettings } from '../shared/runtime-config.js';

const runtime = getBrowserRuntimeSettings('puppeteer');
assert.equal(runtime.ubol_enabled, true, 'Puppeteer runtime should load persisted uBOL settings.');
assert.ok(Array.isArray(runtime.adblock_allowlist_hosts), 'Allowlist hosts should normalize to an array.');

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/local/bin/google-chrome-stable';
if (!fs.existsSync(executablePath)) {
  console.log(`Skipped Puppeteer uBOL launch test because Chrome is unavailable at ${executablePath}.`);
  process.exit(0);
}

const session = await launchEphemeralBrowser('ubol-test-puppeteer', { browserProfile: 'classification' });
try {
  assert.equal(session.launchPolicy.ubol_enabled, true, 'Standard Puppeteer profiles should keep uBOL enabled.');

  const httpBase = session.wsEndpoint.replace('ws://', 'http://').replace(/\/devtools\/browser\/.+$/, '');
  const targets = await fetch(`${httpBase}/json/list`).then((response) => response.json());
  const extensionTarget = targets.find((target) => String(target.url || '').startsWith('chrome-extension://'));
  assert.ok(extensionTarget, 'Expected a uBOL extension target in Puppeteer isolated browser.');
} finally {
  await closeEphemeralBrowser(session);
}

console.log('Validated Puppeteer uBOL runtime config and isolated browser launch.');
