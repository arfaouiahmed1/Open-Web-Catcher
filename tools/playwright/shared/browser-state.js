import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// In-memory mutex map for per-jar locking during merge
const jarLocks = new Map();

async function withJarLock(key, fn) {
  while (jarLocks.has(key)) {
    await jarLocks.get(key);
  }
  let resolveLock;
  const lockPromise = new Promise((res) => {
    resolveLock = res;
  });
  jarLocks.set(key, lockPromise);
  try {
    return await fn();
  } finally {
    jarLocks.delete(key);
    resolveLock();
  }
}

function normalizeComponent(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '');
}

/**
 * Return the stable hash for a (profile, targetHost) pair.
 */
export function getHostHash(profile, targetHost) {
  const normalizedProfile = normalizeComponent(profile);
  const normalizedHost = normalizeComponent(targetHost);
  return crypto
    .createHash('sha256')
    .update(`${normalizedProfile}\n${normalizedHost}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * Resolve the root browser state directory.
 */
export function getBrowserStateRoot() {
  const configuredRoot = String(process.env.OWC_BROWSER_STATE_DIR || '').trim();
  const root = configuredRoot || path.join(PROJECT_ROOT, 'data', 'browser-state');
  return path.resolve(root);
}

/**
 * Resolve the persistent browser state directory for one
 * (profile, target-host) pair: <root>/<stable-hex-hash>/.
 */
export function resolveBrowserStateDir({ profile, targetHost } = {}) {
  const hash = getHostHash(profile, targetHost);
  return path.join(getBrowserStateRoot(), hash);
}

/**
 * Get the canonical storageState.json path for a host jar.
 */
export function getHostJarPath({ profile, targetHost } = {}) {
  const dir = resolveBrowserStateDir({ profile, targetHost });
  return path.join(dir, 'storageState.json');
}

/**
 * Load the host jar storageState, or null if not yet present.
 */
export async function loadHostJar({ profile, targetHost } = {}) {
  const filePath = getHostJarPath({ profile, targetHost });
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.warn(`[browser-state] Failed to load host jar at ${filePath}:`, err.message);
    return null;
  }
}

/**
 * Tokens/patterns that indicate transient authentication/session credentials
 * that must NOT be persisted in the host jar.
 */
const FORBIDDEN_TOKEN_NAMES = /^(?:authorization|jwt|token|access_token|id_token|session_token)$/i;

/**
 * Third-party / advertising tracker domains to strip on merge-back.
 */
const TRACKER_DOMAINS = [
  'google-analytics.com',
  'doubleclick.net',
  'googlesyndication.com',
  'facebook.com',
  'adnxs.com',
  'criteo.com',
  'amazon-adsystem.com',
  'rubiconproject.com',
  'pubmatic.com',
  'taboola.com',
  'outbrain.com',
];

/**
 * Check whether a cookie belongs to third-party ad networks.
 */
function isThirdPartyTrackerCookie(cookie, targetHost) {
  const domain = String(cookie?.domain || '').toLowerCase().replace(/^\./, '');
  if (!domain) return false;
  if (TRACKER_DOMAINS.some((tracker) => domain.includes(tracker))) {
    return true;
  }
  // Check if foreign domain completely unrelated to targetHost
  if (targetHost) {
    const normalizedTarget = normalizeComponent(targetHost);
    if (!domain.includes(normalizedTarget) && !normalizedTarget.includes(domain)) {
      // Third party
      return true;
    }
  }
  return false;
}

/**
 * Sanitize a storageState object before saving it to the canonical jar.
 */
export function sanitizeStorageState(storageState, targetHost) {
  if (!storageState || typeof storageState !== 'object') {
    return { cookies: [], origins: [] };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  // Filter cookies
  const cookies = (storageState.cookies || []).filter((cookie) => {
    // 1. Expired cookies
    if (cookie.expires && cookie.expires > 0 && cookie.expires <= nowSeconds) {
      return false;
    }
    // 2. Sensitive auth tokens
    if (FORBIDDEN_TOKEN_NAMES.test(cookie.name || '')) {
      return false;
    }
    // 3. Third-party advertising cookies
    if (isThirdPartyTrackerCookie(cookie, targetHost)) {
      return false;
    }
    return true;
  });

  // Filter origins / localStorage
  const origins = (storageState.origins || []).filter((originEntry) => {
    const origin = String(originEntry.origin || '').toLowerCase();
    if (targetHost) {
      const normalizedTarget = normalizeComponent(targetHost);
      if (!origin.includes(normalizedTarget)) {
        // Exclude foreign localStorage
        return false;
      }
    }
    return true;
  }).map((originEntry) => {
    // Strip forbidden tokens from localStorage items
    const localStorage = (originEntry.localStorage || []).filter((item) => {
      return !FORBIDDEN_TOKEN_NAMES.test(item.name || '');
    });
    return {
      origin: originEntry.origin,
      localStorage,
    };
  });

  return { cookies, origins };
}

/**
 * Merge cookies and localStorage back into the canonical host jar on context close.
 * Under per-jar lock.
 */
export async function mergeBackToHostJar({ profile, targetHost, context } = {}) {
  if (!context || !profile || !targetHost) return null;

  const jarKey = getHostHash(profile, targetHost);
  return withJarLock(jarKey, async () => {
    try {
      // Read current context storage state
      let currentContextState;
      try {
        currentContextState = await context.storageState();
      } catch (err) {
        // Context might already be closed
        return null;
      }

      const sanitized = sanitizeStorageState(currentContextState, targetHost);

      // Load existing canonical jar
      const existingJar = (await loadHostJar({ profile, targetHost })) || { cookies: [], origins: [] };

      // Merge cookies by (name, domain, path) key
      const cookieMap = new Map();
      for (const c of existingJar.cookies || []) {
        const key = `${c.name}::${c.domain}::${c.path}`;
        cookieMap.set(key, c);
      }
      for (const c of sanitized.cookies) {
        const key = `${c.name}::${c.domain}::${c.path}`;
        cookieMap.set(key, c);
      }

      // Merge origins by origin URL
      const originsMap = new Map();
      for (const o of existingJar.origins || []) {
        originsMap.set(o.origin, o);
      }
      for (const o of sanitized.origins) {
        originsMap.set(o.origin, o);
      }

      const merged = {
        cookies: Array.from(cookieMap.values()),
        origins: Array.from(originsMap.values()),
      };

      const jarDir = resolveBrowserStateDir({ profile, targetHost });
      await fsp.mkdir(jarDir, { recursive: true });
      const jarPath = getHostJarPath({ profile, targetHost });
      await fsp.writeFile(jarPath, JSON.stringify(merged, null, 2), 'utf8');

      return merged;
    } catch (err) {
      console.warn(`[browser-state] Failed to merge back to host jar:`, err.message);
      return null;
    }
  });
}

/**
 * Create a temporary user-data directory for one active browser scope.
 * Optionally seeded with storageState from canonical host jar.
 */
export async function createTempScopeDir({ profile, targetHost, browserScopeId } = {}) {
  const root = getBrowserStateRoot();
  const tmpScopesRoot = path.join(root, 'tmp-scopes');
  await fsp.mkdir(tmpScopesRoot, { recursive: true });

  const scopeHash = crypto
    .createHash('sha256')
    .update(`${profile || ''}::${targetHost || ''}::${browserScopeId || ''}::${Date.now()}::${Math.random()}`, 'utf8')
    .digest('hex')
    .slice(0, 16);

  const scopeDir = path.join(tmpScopesRoot, `scope-${scopeHash}`);
  await fsp.mkdir(scopeDir, { recursive: true });

  // Check if canonical host jar exists to seed from
  let seedState = null;
  if (profile && targetHost) {
    seedState = await loadHostJar({ profile, targetHost });
  }

  const cleanup = async () => {
    try {
      await fsp.rm(scopeDir, { recursive: true, force: true });
    } catch (err) {
      // Best-effort cleanup
    }
  };

  return {
    dir: scopeDir,
    seedState,
    cleanup,
  };
}
