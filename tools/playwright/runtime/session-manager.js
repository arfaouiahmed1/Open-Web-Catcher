import path from 'node:path';
import { loadBrowserDriver } from '../shared/browser-driver.js';
import { createTempScopeDir, mergeBackToHostJar } from '../shared/browser-state.js';
import { PageStateTracker } from './page-state.js';
import { NetworkLedger } from './network-ledger.js';
import { PopupLedger } from './popup-ledger.js';
import { LocatorEngine } from './locator-engine.js';
import { EvidenceStore, defaultEvidenceStore } from './evidence-store.js';

export function makeScopeKey(runId = '', profile = '', browserScopeId = '') {
  return `${runId || 'default'}::${profile || 'general'}::${browserScopeId || 'default'}`;
}

export class SessionManager {
  constructor() {
    this.sessions = new Map(); // scopeKey -> sessionRecord
    this.inFlightLaunches = new Map(); // scopeKey -> Promise<sessionRecord>
  }

  /**
   * Acquire a browser session for a given runId, profile, and browserScopeId.
   * Concurrent requests for the same scope join the same in-flight launch promise.
   */
  async acquireSession({
    runId,
    profile,
    browserScopeId,
    targetHost,
    targetUrl,
    headless = null,
    launchTimeoutMs = 30000,
  } = {}) {
    const key = makeScopeKey(runId, profile, browserScopeId);

    // 1. Existing active session
    const existing = this.sessions.get(key);
    if (existing && !existing.isClosed()) {
      existing.refCount += 1;
      existing.lastUsedAt = Date.now();
      return existing;
    }

    // 2. In-flight acquisition deduplication
    if (this.inFlightLaunches.has(key)) {
      const session = await this.inFlightLaunches.get(key);
      session.refCount += 1;
      session.lastUsedAt = Date.now();
      return session;
    }

    // 3. Launch new isolated session
    const launchPromise = this._launchIsolatedSession({
      runId,
      profile,
      browserScopeId,
      targetHost,
      targetUrl,
      headless,
      launchTimeoutMs,
    });

    this.inFlightLaunches.set(key, launchPromise);
    try {
      const session = await launchPromise;
      this.sessions.set(key, session);
      return session;
    } finally {
      this.inFlightLaunches.delete(key);
    }
  }

  async _launchIsolatedSession({
    runId,
    profile,
    browserScopeId,
    targetHost,
    targetUrl,
    headless,
    launchTimeoutMs,
  }) {
    const key = makeScopeKey(runId, profile, browserScopeId);
    const { chromium, driverName } = await loadBrowserDriver();

    // Determine headless mode: env override or default
    const isHeadless =
      headless !== null
        ? headless
        : String(process.env.OWC_BROWSER_HEADLESS || 'false').toLowerCase() === 'true';

    // Create unique temp scope directory seeded from canonical host jar
    const { dir: tempDir, seedState, cleanup: cleanupTempDir } = await createTempScopeDir({
      profile,
      targetHost,
      browserScopeId,
    });

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--force-webrtc-public-ip-only',
      '--window-size=1365,768',
    ];

    // Under patchright, avoid automation flags; under playwright, standard launch.
    if (driverName !== 'patchright') {
      launchArgs.push('--disable-blink-features=AutomationControlled');
    }

    // The pinned uBOL extension is retained for headless fixture runs. Chrome
    // 151 currently fails to expose headed CDP when this unpacked extension is
    // injected under Xvfb; operators can explicitly opt into that benchmark.
    const ubolEnabled = String(process.env.OWC_UBOL_ENABLED || 'true').toLowerCase() !== 'false';
    const headedUbolEnabled = String(process.env.OWC_UBOL_HEADED_ENABLED || 'false').toLowerCase() === 'true';
    const useUbol = ubolEnabled && (isHeadless || headedUbolEnabled);
    const ubolDir = process.env.OWC_UBOL_EXTENSION_DIR || '/app/tools/playwright/extensions/ubol';
    let extensionArgs = [];
    if (useUbol) {
      extensionArgs = [
        `--disable-extensions-except=${ubolDir}`,
        `--load-extension=${ubolDir}`,
      ];
    }

    let context;
    try {
      context = await chromium.launchPersistentContext(tempDir, {
        headless: isHeadless,
        args: [...launchArgs, ...extensionArgs],
        viewport: isHeadless ? { width: 1365, height: 768 } : null,
        timeout: launchTimeoutMs,
      });
    } catch (err) {
      await cleanupTempDir().catch(() => {});
      throw err;
    }

    // If we have seeded storage state, apply cookies into the context
    if (seedState?.cookies?.length) {
      try {
        await context.addCookies(seedState.cookies);
      } catch (err) {
        // Safe to continue if individual cookies fail to restore
      }
    }

    // Get the initial page or create one
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // Attach runtime modules
    const pageStateTracker = new PageStateTracker(page);
    await pageStateTracker.install().catch(() => {});

    const networkLedger = new NetworkLedger(page);
    networkLedger.start();

    const popupLedger = new PopupLedger(context, page);
    popupLedger.start();

    const locatorEngine = new LocatorEngine(page, pageStateTracker);
    const evidenceStore = defaultEvidenceStore;

    const session = {
      key,
      runId,
      profile,
      browserScopeId,
      targetHost,
      context,
      page,
      pageStateTracker,
      networkLedger,
      popupLedger,
      locatorEngine,
      evidenceStore,
      tempDir,
      refCount: 1,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      isClosed: () => {
        try {
          return page.isClosed() || !context;
        } catch {
          return true;
        }
      },
      close: async () => {
        try {
          networkLedger.stop();
          popupLedger.stop();
          await popupLedger.closeAll().catch(() => {});

          // Merge back first-party storage state to canonical jar
          if (profile && targetHost) {
            await mergeBackToHostJar({ profile, targetHost, context }).catch(() => {});
          }

          await context.close().catch(() => {});
        } finally {
          await cleanupTempDir().catch(() => {});
        }
      },
    };

    return session;
  }

  /**
   * Release a session reference. When refCount reaches 0, the session is closed.
   */
  async releaseSession(key) {
    const session = this.sessions.get(key);
    if (!session) return;

    session.refCount -= 1;
    if (session.refCount <= 0) {
      this.sessions.delete(key);
      await session.close().catch(() => {});
    }
  }

  /**
   * Get an existing session by key.
   */
  getSession(key) {
    return this.sessions.get(key) || null;
  }

  /**
   * Close all active sessions.
   */
  async closeAll() {
    const all = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(all.map((s) => s.close().catch(() => {})));
  }
}

export const defaultSessionManager = new SessionManager();
