/**
 * browser-driver.js — Unified driver abstraction for Playwright / Patchright.
 *
 * Callers import the `chromium` launcher from whichever driver is active
 * without knowing which one it is. The driver is selected at startup via
 * OWC_BROWSER_DRIVER; it never switches mid-run because that changes the
 * browser persona.
 *
 * Supported driver names:
 *   "playwright"  — official @playwright/test chromium
 *   "patchright"  — engine-level patched chromium (stealth)
 *
 * Default: "playwright" — only promoted to "patchright" after the explicit
 * three-run parity / improvement gate passes (plan step 2, step 11).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SUPPORTED_DRIVERS = new Set(['playwright', 'patchright']);
const DEFAULT_DRIVER = 'playwright';

let _cached = null;

/**
 * Load the browser driver by name.
 *
 * @param {string} [name] - "playwright" or "patchright". Defaults to
 *   OWC_BROWSER_DRIVER env var, then DEFAULT_DRIVER.
 * @returns {{ chromium: import('playwright').BrowserType, driverName: string, version: string }}
 */
export async function loadBrowserDriver(name) {
  const driverName = (name ?? process.env.OWC_BROWSER_DRIVER ?? DEFAULT_DRIVER).toLowerCase().trim();

  if (!SUPPORTED_DRIVERS.has(driverName)) {
    throw new Error(
      `Unsupported OWC_BROWSER_DRIVER "${driverName}". Must be one of: ${[...SUPPORTED_DRIVERS].join(', ')}.`
    );
  }

  if (_cached && _cached.driverName === driverName) {
    return _cached;
  }

  let mod;
  try {
    mod = await import(driverName);
  } catch (err) {
    throw new Error(
      `Failed to import browser driver "${driverName}": ${err.message}. ` +
      `Is it listed in package.json dependencies and installed?`
    );
  }

  // Both playwright and patchright export { chromium, firefox, webkit }
  const { chromium } = mod;
  if (!chromium) {
    throw new Error(`Driver "${driverName}" does not export a "chromium" launcher.`);
  }

  // Resolve package versions without relying on import-assertion syntax,
  // which differs between Node 22 and Node 24.
  let version = 'unknown';
  try {
    version = require(`${driverName}/package.json`).version ?? 'unknown';
  } catch {
    // Version unavailable — not fatal.
  }

  _cached = { chromium, driverName, version };

  console.log(`[browser-driver] Loaded driver="${driverName}" version="${version}"`);
  return _cached;
}

/**
 * Return the cached driver record without re-loading.
 * Throws if loadBrowserDriver() has not been called yet.
 */
export function getLoadedDriver() {
  if (!_cached) {
    throw new Error('Browser driver not yet loaded. Call loadBrowserDriver() first.');
  }
  return _cached;
}

/**
 * Clear the cached driver (test use only).
 */
export function _resetDriverCache() {
  _cached = null;
}
