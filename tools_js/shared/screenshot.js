/**
 * shared/screenshot.js — screenshotFull / screenshotViewport / screenshotElement
 */

import { uploadImage } from './upload.js';

/**
 * Full-page screenshot → Cloudinary URL (or base64 data URI if Cloudinary unconfigured).
 * Viewport is already enforced to 1920×1080 by getPage(); do not override here.
 */
export async function screenshotFull(page) {
  const buf = await page.screenshot({ fullPage: true, type: 'png' });
  return uploadImage(`data:image/png;base64,${buf.toString('base64')}`);
}

/**
 * Viewport screenshot (1920×1080, 16:9) → Cloudinary URL or base64 data URI.
 * Viewport is already enforced to 1920×1080 by getPage(); do not override here.
 */
export async function screenshotViewport(page) {
  const buf = await page.screenshot({ fullPage: false, type: 'png' });
  return uploadImage(`data:image/png;base64,${buf.toString('base64')}`);
}

/** Element screenshot → Cloudinary URL */
export async function screenshotElement(page, selector) {
  const el = await page.$(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  const buf = await el.screenshot({ type: 'png' });
  return uploadImage(`data:image/png;base64,${buf.toString('base64')}`);
}
