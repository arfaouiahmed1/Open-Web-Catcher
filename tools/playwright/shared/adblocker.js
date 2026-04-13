/**
 * shared/adblocker.js - Playwright ad blocking via context.route().
 *
 * Uses @ghostery/adblocker-playwright (PlaywrightBlocker) applied at the
 * BrowserContext level so all pages and cross-origin iframes are covered.
 *
 * CDN whitelist prevents over-blocking of legitimate player resources.
 * Per-page opt-out is supported via the pageBlockingDisabled WeakSet
 * passed in from browser.js (used by auto-recovery).
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PlaywrightBlocker } from '@ghostery/adblocker-playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FILTERLIST_DIR = path.join(__dirname, 'filterlists');
const FILTERLIST_SOURCES_PATH = path.join(FILTERLIST_DIR, 'sources.json');
const CACHE_ROOT = resolveCacheRoot();
const LIST_CACHE_DIR = path.join(CACHE_ROOT, 'lists');
// Separate cache name from the Puppeteer version to avoid deserialization issues.
const ENGINE_CACHE_PATH = path.join(CACHE_ROOT, 'playwright-engine.bin');
const ENGINE_META_PATH = path.join(CACHE_ROOT, 'playwright-engine.json');
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_EXCLUDED_CATEGORIES = ['nsfw', 'gambling'];

let blockerSnapshotPromise = null;

// CDN and player resource hosts that must never be blocked
const CDN_WHITELIST = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'ajax.googleapis.com',
  'unpkg.com',
  'stackpath.bootstrapcdn.com',
  'jwpcdn.com',
  'jwplatform.com',
  'akamaihd.net',
  'akamai.net',
  'akamaized.net',
  'llnwd.net',
  'edgecastcdn.net',
  'fastly.net',
  'jwpsrv.com',
  'cloudfront.net',
  'brightcove.net',
  'brightcove.com',
  'kaltura.com',
  'vimeocdn.com',
  'vzaar.com',
  'flowplayer.com',
  'videodelivery.net',
  'cloudflare.com',
  'googleapis.com',
  'gstatic.com',
];

function resolveCacheRoot() {
  const configuredPath = process.env.OWC_ADBLOCK_CACHE_DIR;
  if (!configuredPath) return path.join(PROJECT_ROOT, 'data', 'cache', 'adblocker');
  return path.resolve(PROJECT_ROOT, configuredPath);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback = true) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseCsvSet(value) {
  return new Set(
    String(value || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
}

function normalizeHost(candidate) {
  const input = String(candidate || '').trim().toLowerCase();
  if (!input) return '';
  try { return new URL(input).hostname.replace(/^www\./, ''); }
  catch { return input.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, ''); }
}

function getAllowlistHosts() {
  const configured = process.env.OWC_ADBLOCK_ALLOWLIST_HOSTS;
  if (!configured) return new Set();
  return new Set(Array.from(parseCsvSet(configured)).map((e) => normalizeHost(e)).filter(Boolean));
}

function isAllowlistedHost(candidate) {
  const host = normalizeHost(candidate);
  if (!host) return false;

  // Always allow CDN whitelist
  if (CDN_WHITELIST.some((w) => host === w || host.endsWith(`.${w}`))) return true;

  // Check user-configured allowlist
  const allowlist = getAllowlistHosts();
  for (const allowed of allowlist) {
    if (host === allowed || host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

function getExcludedCategories() {
  const configured = process.env.OWC_ADBLOCK_EXCLUDED_CATEGORIES;
  if (!configured) return new Set(DEFAULT_EXCLUDED_CATEGORIES);
  const parsed = parseCsvSet(configured);
  return parsed.size > 0 ? parsed : new Set(DEFAULT_EXCLUDED_CATEGORIES);
}

export function isAdblockEnabled() {
  return parseBoolean(process.env.OWC_ADBLOCK_ENABLED, false);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sanitizeId(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

function getCacheTtlMs() { return parseInteger(process.env.OWC_ADBLOCK_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS); }
function getFetchTimeoutMs() { return parseInteger(process.env.OWC_ADBLOCK_FILTERLIST_FETCH_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS); }

function isFresh(timestamp, ttlMs) {
  if (!timestamp) return false;
  const lastFetched = Date.parse(timestamp);
  if (Number.isNaN(lastFetched)) return false;
  return Date.now() - lastFetched < ttlMs;
}

function getListCachePaths(listId) {
  const safeId = sanitizeId(listId);
  return {
    textPath: path.join(LIST_CACHE_DIR, `${safeId}.txt`),
    metaPath: path.join(LIST_CACHE_DIR, `${safeId}.json`),
  };
}

async function ensureCacheDirs() {
  await fs.mkdir(LIST_CACHE_DIR, { recursive: true });
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch { return fallback; }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readCachedFilterList(listId) {
  const { textPath, metaPath } = getListCachePaths(listId);
  try {
    const [text, meta] = await Promise.all([fs.readFile(textPath, 'utf8'), readJson(metaPath, null)]);
    return { text, meta, textPath, metaPath };
  } catch { return { text: null, meta: null, ...getListCachePaths(listId) }; }
}

function normalizeRemoteSource(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('Invalid filter list entry');
  if (!entry.id || !entry.url) throw new Error('Each filter list must include id and url');
  return { id: sanitizeId(entry.id), name: String(entry.name || entry.id), category: String(entry.category || '').trim().toLowerCase(), kind: 'remote', url: String(entry.url) };
}

async function loadRemoteSources() {
  const parsed = await readJson(FILTERLIST_SOURCES_PATH, []);
  if (!Array.isArray(parsed)) throw new Error(`Expected an array in ${FILTERLIST_SOURCES_PATH}`);
  const excludedCategories = getExcludedCategories();
  return parsed.filter((e) => e && e.enabled !== false).map(normalizeRemoteSource).filter((e) => !excludedCategories.has(e.category));
}

async function fetchFilterListText(url, existingMeta) {
  const timeoutMs = getFetchTimeoutMs();
  const headers = {};
  if (existingMeta?.etag) headers['If-None-Match'] = existingMeta.etag;
  else if (existingMeta?.lastModified) headers['If-Modified-Since'] = existingMeta.lastModified;

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });

  if (response.status === 304) return { text: null, notModified: true, etag: existingMeta?.etag, lastModified: existingMeta?.lastModified };
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

  const text = await response.text();
  return { text, notModified: false, etag: response.headers.get('etag') || '', lastModified: response.headers.get('last-modified') || '' };
}

async function getOrFetchFilterList(source) {
  const ttlMs = getCacheTtlMs();
  const { text: cachedText, meta: cachedMeta, textPath, metaPath } = await readCachedFilterList(source.id);

  if (cachedText && isFresh(cachedMeta?.fetchedAt, ttlMs)) return cachedText;

  try {
    const result = await fetchFilterListText(source.url, cachedMeta);
    if (result.notModified && cachedText) {
      await writeJson(metaPath, { ...cachedMeta, fetchedAt: new Date().toISOString() });
      return cachedText;
    }
    if (result.text) {
      await fs.writeFile(textPath, result.text, 'utf8');
      await writeJson(metaPath, { id: source.id, url: source.url, fetchedAt: new Date().toISOString(), etag: result.etag, lastModified: result.lastModified });
      return result.text;
    }
  } catch (err) {
    if (cachedText) return cachedText;
    throw err;
  }
  return cachedText || '';
}

async function buildCombinedFilterListText() {
  await ensureCacheDirs();
  const sources = await loadRemoteSources();
  const texts = await Promise.allSettled(sources.map((s) => getOrFetchFilterList(s)));
  return texts.filter((r) => r.status === 'fulfilled').map((r) => r.value).filter(Boolean).join('\n');
}

async function buildOrLoadBlocker() {
  const combinedText = await buildCombinedFilterListText();
  const contentSig = sha256(combinedText);

  const engineMeta = await readJson(ENGINE_META_PATH, null);
  if (engineMeta?.contentSig === contentSig) {
    try {
      const engineBytes = await fs.readFile(ENGINE_CACHE_PATH);
      const blocker = PlaywrightBlocker.deserialize(new Uint8Array(engineBytes));
      return { blocker, contentSig };
    } catch { /* cache miss — rebuild */ }
  }

  const blocker = await PlaywrightBlocker.parse(combinedText, { loadNetworkFilters: true, loadCosmeticFilters: true });
  const serialized = blocker.serialize();
  await fs.writeFile(ENGINE_CACHE_PATH, Buffer.from(serialized));
  await writeJson(ENGINE_META_PATH, { contentSig, builtAt: new Date().toISOString() });
  return { blocker, contentSig };
}

export async function getBlockerSnapshot() {
  if (!blockerSnapshotPromise) {
    blockerSnapshotPromise = buildOrLoadBlocker().catch((err) => {
      blockerSnapshotPromise = null;
      throw err;
    });
  }
  return blockerSnapshotPromise;
}

/**
 * Attach route-based ad blocking to a Playwright BrowserContext.
 * All pages (including cross-origin iframes) created in this context
 * will have their network requests screened against the filter lists.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {{ pageBlockingDisabled: WeakSet }} options
 */
export async function attachAdBlocker(context, { pageBlockingDisabled } = {}) {
  if (!isAdblockEnabled()) return;

  let blocker;
  try {
    ({ blocker } = await getBlockerSnapshot());
  } catch (err) {
    console.warn('[owc-pw] adblocker build failed, skipping:', err?.message || err);
    return;
  }

  await context.route('**/*', async (route, request) => {
    const page = request.frame()?.page?.();

    // Per-page opt-out (used by auto-recovery)
    if (page && pageBlockingDisabled?.has(page)) {
      return route.continue();
    }

    const url = request.url();
    let host = '';
    try { host = new URL(url).hostname; } catch { /* ignore */ }

    // Always allow CDN / player resources
    if (isAllowlistedHost(host)) return route.continue();

    // Let PlaywrightBlocker decide
    try {
      const shouldBlock = blocker.match(request);
      if (shouldBlock) return route.abort();
    } catch { /* on any error, allow */ }

    return route.continue();
  });
}

/**
 * No-op for Playwright — blocking is applied at context level in attachAdBlocker.
 * Kept for API compatibility with tool files that import enableBlocking.
 */
export async function enableBlocking(_page, _opts) {
  // Context-level blocking is set up once in attachAdBlocker; nothing to do per-page.
}

/**
 * Mark a page as exempt from blocking (used by auto-recovery).
 * In Playwright the route handler checks pageBlockingDisabled before blocking.
 */
export async function disableBlocking(page) {
  // The WeakSet is managed in browser.js; this function signature is here for
  // tool-file compatibility. The actual opt-out is done in browser.js directly.
  return false;
}
