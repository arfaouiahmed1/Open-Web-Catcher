/**
 * shared/browser.js - Puppeteer browser helpers.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import puppeteer from 'puppeteer-core';
import { enableBlocking } from './adblocker.js';

const WS_ENDPOINT = process.env.BROWSER_WS_ENDPOINT || 'ws://chrome:3000';
const EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/local/bin/google-chrome-stable';
const DEFAULT_LAUNCH_ARGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--remote-allow-origins=*',
];

/**
 * Connect to an existing browser by WebSocket endpoint.
 */
export async function connectBrowser(wsEndpoint = WS_ENDPOINT) {
  return puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: { width: 1280, height: 800 },
  });
}

/**
 * Launch an isolated browser for one MCP session.
 */
export async function launchEphemeralBrowser(sessionId) {
  const safeSessionId = String(sessionId || 'session').replace(/[^a-zA-Z0-9_-]/g, '_');
  const userDataDir = path.join(os.tmpdir(), `owc-browser-${safeSessionId}-${Date.now()}`);
  const browser = await puppeteer.launch({
    executablePath: EXECUTABLE_PATH,
    headless: true,
    defaultViewport: { width: 1280, height: 800 },
    userDataDir,
    args: DEFAULT_LAUNCH_ARGS,
  });

  return {
    browser,
    wsEndpoint: browser.wsEndpoint(),
    userDataDir,
  };
}

/**
 * Close an isolated browser and remove its temporary profile directory.
 */
export async function closeEphemeralBrowser(session) {
  if (!session) return;

  try {
    if (session.browser) {
      await session.browser.close();
    }
  } finally {
    if (session.userDataDir) {
      await fs.rm(session.userDataDir, { recursive: true, force: true });
    }
  }
}

/**
 * Get the active page (reuse blank page or open a new one).
 */
export async function getPage(browser) {
  const pages = await browser.pages();
  const blank = pages.find((page) => page.url() === 'about:blank');
  const page = blank ?? await browser.newPage();
  await enableBlocking(page);
  return page;
}
