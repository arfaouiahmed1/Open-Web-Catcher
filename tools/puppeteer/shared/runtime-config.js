import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_CONFIG_PATH = String(
  process.env.OWC_BROWSER_RUNTIME_CONFIG || path.join(PROJECT_ROOT, 'data', 'browser.runtime.json'),
).trim();

let cachedMtimeMs = -1;
let cachedPayload = {};

function readRuntimePayload() {
  try {
    const stat = fs.statSync(RUNTIME_CONFIG_PATH);
    if (stat.mtimeMs === cachedMtimeMs && cachedPayload && typeof cachedPayload === 'object') {
      return cachedPayload;
    }
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8'));
    cachedMtimeMs = stat.mtimeMs;
    cachedPayload = parsed && typeof parsed === 'object' ? parsed : {};
    return cachedPayload;
  } catch {
    return cachedPayload && typeof cachedPayload === 'object' ? cachedPayload : {};
  }
}

export function getBrowserRuntimeSettings(browserId) {
  const payload = readRuntimePayload();
  const container = payload?.browser_runtime && typeof payload.browser_runtime === 'object'
    ? payload.browser_runtime
    : payload;
  const settings = container?.[browserId];
  return settings && typeof settings === 'object' ? settings : {};
}
