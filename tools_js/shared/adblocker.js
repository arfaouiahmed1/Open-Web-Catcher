/**
 * shared/adblocker.js - Ghostery-backed adblocker with cached filterlists.
 *
 * Behaves like uBlock Origin: filter lists drive both network request blocking
 * AND cosmetic filtering (element hiding). No separate toggles — the lists
 * contain both types of rules and PuppeteerBlocker applies them all.
 *
 * Filter sources:
 *   - Remote lists defined in ./filterlists/sources.json  (enabled: true)
 *   - Optional local *.txt files dropped into ./filterlists/
 *
 * Cache:
 *   - Raw list text in data/cache/adblocker/lists/
 *   - Serialised engine snapshot in data/cache/adblocker/ghostery-engine.bin
 *   - Engine is rebuilt only when the combined list content changes (sha256 sig)
 *   - Individual lists are re-fetched after OWC_ADBLOCK_CACHE_TTL_MS (default 24 h)
 *     using ETag / If-Modified-Since for bandwidth efficiency
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PuppeteerBlocker } from '@ghostery/adblocker-puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FILTERLIST_DIR = path.join(__dirname, 'filterlists');
const FILTERLIST_SOURCES_PATH = path.join(FILTERLIST_DIR, 'sources.json');
const CACHE_ROOT = resolveCacheRoot();
const LIST_CACHE_DIR = path.join(CACHE_ROOT, 'lists');
const ENGINE_CACHE_PATH = path.join(CACHE_ROOT, 'ghostery-engine.bin');
const ENGINE_META_PATH = path.join(CACHE_ROOT, 'ghostery-engine.json');
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
// Tracks which pages already have blocking enabled so we don't attach twice.
const enabledPages = new WeakSet();

let blockerSnapshotPromise = null;

function resolveCacheRoot() {
  const configuredPath = process.env.OWC_ADBLOCK_CACHE_DIR;
  if (!configuredPath) {
    return path.join(PROJECT_ROOT, 'data', 'cache', 'adblocker');
  }

  return path.resolve(PROJECT_ROOT, configuredPath);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sanitizeId(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

function getCacheTtlMs() {
  return parseInteger(process.env.OWC_ADBLOCK_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
}

function getFetchTimeoutMs() {
  return parseInteger(
    process.env.OWC_ADBLOCK_FILTERLIST_FETCH_TIMEOUT_MS,
    DEFAULT_FETCH_TIMEOUT_MS,
  );
}

function isFresh(timestamp, ttlMs) {
  if (!timestamp) {
    return false;
  }

  const lastFetched = Date.parse(timestamp);
  if (Number.isNaN(lastFetched)) {
    return false;
  }

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
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readCachedFilterList(listId) {
  const { textPath, metaPath } = getListCachePaths(listId);

  try {
    const [text, meta] = await Promise.all([
      fs.readFile(textPath, 'utf8'),
      readJson(metaPath, null),
    ]);

    return { text, meta, textPath, metaPath };
  } catch (_) {
    return { text: null, meta: null, textPath, metaPath };
  }
}

function normalizeRemoteSource(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Invalid filter list entry in sources.json');
  }

  if (!entry.id || !entry.url) {
    throw new Error('Each remote filter list must include id and url');
  }

  return {
    id: sanitizeId(entry.id),
    name: String(entry.name || entry.id),
    kind: 'remote',
    url: String(entry.url),
  };
}

async function loadRemoteSources() {
  const parsed = await readJson(FILTERLIST_SOURCES_PATH, []);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array in ${FILTERLIST_SOURCES_PATH}`);
  }

  return parsed
    .filter((entry) => entry && entry.enabled !== false)
    .map(normalizeRemoteSource);
}

async function loadLocalSources() {
  const entries = await fs.readdir(FILTERLIST_DIR, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
    .map((entry) => {
      const filePath = path.join(FILTERLIST_DIR, entry.name);
      const listId = sanitizeId(path.basename(entry.name, '.txt'));

      return {
        id: listId,
        name: entry.name,
        kind: 'local',
        filePath,
      };
    })
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}

async function fetchRemoteList(source, cachedMeta) {
  const headers = {};

  if (cachedMeta?.etag) {
    headers['If-None-Match'] = cachedMeta.etag;
  }

  if (cachedMeta?.lastModified) {
    headers['If-Modified-Since'] = cachedMeta.lastModified;
  }

  const response = await fetch(source.url, {
    headers,
    signal: AbortSignal.timeout(getFetchTimeoutMs()),
  });

  if (response.status === 304) {
    return { notModified: true };
  }

  if (!response.ok) {
    throw new Error(`${source.url} returned HTTP ${response.status}`);
  }

  const text = await response.text();
  return {
    text,
    meta: {
      id: source.id,
      name: source.name,
      kind: source.kind,
      source: source.url,
      fetchedAt: nowIso(),
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      sha256: sha256(text),
      bytes: Buffer.byteLength(text),
    },
  };
}

async function loadRemoteFilterList(source) {
  const cached = await readCachedFilterList(source.id);
  const cacheFresh = cached.text && isFresh(cached.meta?.fetchedAt, getCacheTtlMs());
  if (cacheFresh) {
    return {
      id: source.id,
      name: source.name,
      kind: source.kind,
      source: source.url,
      text: cached.text,
      meta: {
        ...cached.meta,
        cacheStatus: 'fresh',
      },
    };
  }

  try {
    const fetched = await fetchRemoteList(source, cached.meta);

    if (fetched.notModified) {
      const refreshedMeta = {
        ...(cached.meta || {}),
        id: source.id,
        name: source.name,
        kind: source.kind,
        source: source.url,
        fetchedAt: nowIso(),
        cacheStatus: 'revalidated',
      };

      await writeJson(cached.metaPath, refreshedMeta);

      return {
        id: source.id,
        name: source.name,
        kind: source.kind,
        source: source.url,
        text: cached.text || '',
        meta: refreshedMeta,
      };
    }

    await Promise.all([
      fs.writeFile(cached.textPath, fetched.text, 'utf8'),
      writeJson(cached.metaPath, {
        ...fetched.meta,
        cacheStatus: 'downloaded',
      }),
    ]);

    return {
      id: source.id,
      name: source.name,
      kind: source.kind,
      source: source.url,
      text: fetched.text,
      meta: {
        ...fetched.meta,
        cacheStatus: 'downloaded',
      },
    };
  } catch (error) {
    if (cached.text) {
      return {
        id: source.id,
        name: source.name,
        kind: source.kind,
        source: source.url,
        text: cached.text,
        meta: {
          ...(cached.meta || {}),
          id: source.id,
          name: source.name,
          kind: source.kind,
          source: source.url,
          fetchedAt: cached.meta?.fetchedAt || null,
          lastError: error.message,
          lastErrorAt: nowIso(),
          cacheStatus: 'stale-fallback',
        },
      };
    }

    throw new Error(`Failed to fetch ${source.name}: ${error.message}`);
  }
}

async function loadLocalFilterList(source) {
  const text = await fs.readFile(source.filePath, 'utf8');

  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    source: source.filePath,
    text,
    meta: {
      id: source.id,
      name: source.name,
      kind: source.kind,
      source: source.filePath,
      fetchedAt: nowIso(),
      sha256: sha256(text),
      bytes: Buffer.byteLength(text),
      cacheStatus: 'local',
    },
  };
}

async function loadFilterLists() {
  await ensureCacheDirs();

  const [remoteSources, localSources] = await Promise.all([
    loadRemoteSources(),
    loadLocalSources(),
  ]);

  const [remoteLists, localLists] = await Promise.all([
    Promise.all(remoteSources.map(loadRemoteFilterList)),
    Promise.all(localSources.map(loadLocalFilterList)),
  ]);

  const filterLists = [...remoteLists, ...localLists].filter((entry) => entry.text.trim());
  if (filterLists.length === 0) {
    throw new Error('No adblock filter lists are available');
  }

  return filterLists;
}

function buildEngineSignature(filterLists) {
  const payload = filterLists.map((entry) => ({
    id: entry.id,
    source: entry.source,
    sha256: entry.meta.sha256,
  }));

  return sha256(JSON.stringify(payload));
}

async function tryLoadCachedEngine(signature) {
  const [meta, buffer] = await Promise.all([
    readJson(ENGINE_META_PATH, null),
    fs.readFile(ENGINE_CACHE_PATH).catch(() => null),
  ]);

  if (!meta || !buffer || meta.signature !== signature) {
    return null;
  }

  return {
    blocker: PuppeteerBlocker.deserialize(buffer),
    meta,
  };
}

async function writeEngineCache(blocker, signature, filterLists) {
  await Promise.all([
    fs.writeFile(ENGINE_CACHE_PATH, Buffer.from(blocker.serialize())),
    writeJson(ENGINE_META_PATH, {
      signature,
      createdAt: nowIso(),
      filterLists: filterLists.map((entry) => ({
        id: entry.id,
        name: entry.name,
        source: entry.source,
        sha256: entry.meta.sha256,
        cacheStatus: entry.meta.cacheStatus,
      })),
    }),
  ]);
}

function buildCombinedFilterText(filterLists) {
  return filterLists
    .map((entry) => `! --- ${entry.name} (${entry.id}) ---\n${entry.text.trim()}`)
    .join('\n\n');
}

async function createBlockerSnapshot() {
  const filterLists = await loadFilterLists();
  const signature = buildEngineSignature(filterLists);
  const cachedEngine = await tryLoadCachedEngine(signature);

  if (cachedEngine) {
    return {
      blocker: cachedEngine.blocker,
      filterLists,
      signature,
      engineCacheStatus: 'hit',
    };
  }

  const blocker = PuppeteerBlocker.parse(buildCombinedFilterText(filterLists));
  await writeEngineCache(blocker, signature, filterLists);

  return {
    blocker,
    filterLists,
    signature,
    engineCacheStatus: 'miss',
  };
}

async function getBlockerSnapshot() {
  if (!blockerSnapshotPromise) {
    blockerSnapshotPromise = createBlockerSnapshot().catch((error) => {
      blockerSnapshotPromise = null;
      throw error;
    });
  }

  return blockerSnapshotPromise;
}

/**
 * Returns metadata for all active filter lists (for diagnostics / UI display).
 */
export async function getFilterLists() {
  const snapshot = await getBlockerSnapshot();
  return snapshot.filterLists.map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    source: entry.source,
    sha256: entry.meta.sha256,
    cacheStatus: entry.meta.cacheStatus,
    fetchedAt: entry.meta.fetchedAt || null,
    bytes: entry.meta.bytes || Buffer.byteLength(entry.text),
  }));
}

/**
 * Attach the blocker to a Puppeteer page.
 * Applies both network blocking and cosmetic filtering (element hiding)
 * from the filter lists — same behaviour as uBlock Origin.
 * Safe to call multiple times on the same page; attaches only once.
 */
export async function enableBlocking(page) {
  if (enabledPages.has(page)) return;
  const { blocker } = await getBlockerSnapshot();
  await blocker.enableBlockingInPage(page);
  enabledPages.add(page);
}
