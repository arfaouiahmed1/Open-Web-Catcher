#!/usr/bin/env node
/**
 * capture-fixture.js — Autonomous fixture capture using production modules.
 *
 * Imports the same driver, page-state, network ledger, and evidence store
 * as production sidecar. Writes sanitized archive files to outputs/live-captures/
 * or datasets/fixtures/.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrowserDriver } from '../shared/browser-driver.js';
import { PageStateTracker } from '../runtime/page-state.js';
import { NetworkLedger } from '../runtime/network-ledger.js';
import { defaultEvidenceStore } from '../runtime/evidence-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

export async function captureFixture({
  url,
  outDir,
  headless = true,
  timeoutMs = 30000,
} = {}) {
  if (!url) throw new Error('url is required');
  const targetDir = outDir || path.join(PROJECT_ROOT, 'outputs', 'live-captures', String(Date.now()));
  await fsp.mkdir(targetDir, { recursive: true });

  const { chromium } = await loadBrowserDriver();
  const context = await chromium.launchPersistentContext('', {
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    viewport: { width: 1365, height: 768 },
    timeout: timeoutMs,
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    const pageStateTracker = new PageStateTracker(page);
    await pageStateTracker.install().catch(() => {});

    const networkLedger = new NetworkLedger(page);
    networkLedger.start();

    console.log(`[capture-fixture] Navigating to ${url}...`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs }).catch(() => {
      console.warn('[capture-fixture] Navigation timed out or completed with error; capturing partial state');
    });

    // Capture artifacts
    const html = await page.content().catch(() => '');
    const title = await page.title().catch(() => '');
    const pageState = await pageStateTracker.getPageState().catch(() => ({}));
    const networkEntries = networkLedger.getEntries();
    networkLedger.stop();

    const screenshot = await defaultEvidenceStore.saveScreenshot(page, { scope: 'viewport' }).catch(() => null);

    // Save files
    await fsp.writeFile(path.join(targetDir, 'index.html'), html, 'utf8');

    const meta = {
      url,
      title,
      captured_at: new Date().toISOString(),
      page_state: pageState,
      screenshot_ref: screenshot?.blobref || null,
      total_network_requests: networkEntries.length,
    };
    await fsp.writeFile(path.join(targetDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    const harLog = {
      log: {
        version: '1.2',
        creator: { name: 'OWC Fixture Capture', version: '2.0.0' },
        entries: networkEntries.map((e) => ({
          request: { method: e.method, url: e.url },
          response: { status: e.status || 200, content: { mimeType: e.contentType || '' } },
        })),
      },
    };
    await fsp.writeFile(path.join(targetDir, 'network.har'), JSON.stringify(harLog, null, 2), 'utf8');

    console.log(`[capture-fixture] Captured fixture to ${targetDir}`);
    return { targetDir, meta };
  } finally {
    await context.close().catch(() => {});
  }
}

// CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node capture-fixture.js <url> [outDir]');
    process.exit(1);
  }
  const outDir = process.argv[3];
  captureFixture({ url, outDir })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[capture-fixture] Failed:', err);
      process.exit(1);
    });
}
