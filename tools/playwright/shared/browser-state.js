import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

function normalizeComponent(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '');
}

/**
 * Resolve the persistent browser state directory for one
 * (profile, target-host) pair: <root>/<stable-hex-hash>/.
 *
 * The root is OWC_BROWSER_STATE_DIR when set, otherwise the repository's
 * data/browser-state directory. The hash is a stable cryptographic digest of
 * only the normalized profile and target host — no timestamps, no randomness —
 * so identical inputs always resolve to the identical absolute directory.
 *
 * Pure resolution only: this never creates or deletes directories.
 */
export function resolveBrowserStateDir({ profile, targetHost } = {}) {
  const normalizedProfile = normalizeComponent(profile);
  const normalizedHost = normalizeComponent(targetHost);

  const hash = crypto
    .createHash('sha256')
    .update(`${normalizedProfile}\n${normalizedHost}`, 'utf8')
    .digest('hex')
    .slice(0, 32);

  const configuredRoot = String(process.env.OWC_BROWSER_STATE_DIR || '').trim();
  const root = configuredRoot || path.join(PROJECT_ROOT, 'data', 'browser-state');
  return path.join(path.resolve(root), hash);
}
