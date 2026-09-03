import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

export const BLOB_REF_PREFIX = 'blobref:';

/**
 * Resolve the blobs directory on disk.
 */
export function getBlobStoreDir() {
  const envDir = process.env.BLOB_STORE_DIR || process.env.OWC_BLOB_STORE_DIR;
  if (envDir) return path.resolve(envDir);
  return path.join(PROJECT_ROOT, 'data', 'blobs');
}

/**
 * Write a buffer to the content-addressed blob store.
 * Returns the blobref string: "blobref:<sha256[:16]>".
 *
 * Matches src/storage/blob_store.py:
 *   path = directory / f"{digest[:16]}.blob"
 *   return f"{BLOB_REF_PREFIX}{digest[:16]}"
 */
export async function writeBlobBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const key = digest.slice(0, 16);
  const dir = getBlobStoreDir();
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${key}.blob`);
  try {
    // Check if already exists (content-addressed store)
    await fsp.access(filePath);
  } catch {
    await fsp.writeFile(filePath, buffer);
  }
  return `${BLOB_REF_PREFIX}${key}`;
}

/**
 * Read blob bytes given a blobref pointer.
 */
export async function readBlobBuffer(ref) {
  if (!ref || !String(ref).startsWith(BLOB_REF_PREFIX)) {
    return null;
  }
  const key = String(ref).slice(BLOB_REF_PREFIX.length).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  if (!key) return null;
  const filePath = path.join(getBlobStoreDir(), `${key}.blob`);
  try {
    return await fsp.readFile(filePath);
  } catch (err) {
    return null;
  }
}

/**
 * EvidenceStore class for saving screenshots and other artifacts.
 */
export class EvidenceStore {
  constructor({ blobDir } = {}) {
    this.blobDir = blobDir || getBlobStoreDir();
  }

  /**
   * Capture a screenshot from a Playwright Page, ElementHandle, or Frame.
   *
   * @param {import('playwright').Page|import('playwright').ElementHandle} target
   * @param {object} opts
   * @param {'viewport'|'full'|'element'} [opts.scope='viewport']
   * @param {boolean} [opts.lossless=false] - If true, saves PNG for OCR; otherwise WebP @ quality 80
   * @returns {Promise<{ blobref: string, buffer: Buffer, format: 'webp'|'png', width: number, height: number }>}
   */
  async saveScreenshot(target, { scope = 'viewport', lossless = false } = {}) {
    const format = lossless ? 'png' : 'webp';
    const screenshotOptions = {
      type: format,
      ...(format === 'webp' ? { quality: 80 } : {}),
      ...(scope === 'full' ? { fullPage: true } : {}),
    };

    let buffer;
    if (typeof target.screenshot === 'function') {
      buffer = await target.screenshot(screenshotOptions);
    } else {
      throw new Error('Target does not support screenshot()');
    }

    const blobref = await writeBlobBuffer(buffer);

    // Get approximate viewport dimensions from page if available
    let width = 1365;
    let height = 768;
    try {
      if (typeof target.viewportSize === 'function') {
        const size = target.viewportSize();
        if (size) {
          width = size.width;
          height = size.height;
        }
      } else if (target.page && typeof target.page().viewportSize === 'function') {
        const size = target.page().viewportSize();
        if (size) {
          width = size.width;
          height = size.height;
        }
      }
    } catch {
      // Use defaults
    }

    return {
      blobref,
      buffer,
      format,
      width,
      height,
    };
  }

  /**
   * Save a textual or JSON snapshot to the blob store.
   */
  async saveTextSnapshot(text) {
    const buffer = Buffer.from(String(text || ''), 'utf8');
    return writeBlobBuffer(buffer);
  }
}

export const defaultEvidenceStore = new EvidenceStore();
