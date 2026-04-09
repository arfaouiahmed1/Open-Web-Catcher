/**
 * shared/screenshot.js — screenshotFull / screenshotViewport / screenshotElement
 */

import { uploadImage } from './upload.js';

async function captureScrollPosition(page) {
  return page.mainFrame().evaluate(() => {
    const root = document.scrollingElement || document.documentElement || document.body;
    return {
      x: Number(window.scrollX || 0),
      y: Number(window.scrollY || 0),
      root_left: Number(root?.scrollLeft || 0),
      root_top: Number(root?.scrollTop || 0),
    };
  }).catch(() => null);
}

async function restoreScrollPosition(page, snapshot) {
  if (!snapshot) return;

  await page.mainFrame().evaluate((state) => {
    const root = document.scrollingElement || document.documentElement || document.body;
    window.scrollTo(Number(state.x || 0), Number(state.y || 0));
    if (root) {
      root.scrollLeft = Number(state.root_left || 0);
      root.scrollTop = Number(state.root_top || 0);
    }
  }, snapshot).catch(() => {});
}

/**
 * Full-page screenshot → Cloudinary URL (or base64 data URI if Cloudinary unconfigured).
 * Viewport is already enforced to 1920×1080 by getPage(); do not override here.
 */
export async function screenshotFull(page) {
  const scrollSnapshot = await captureScrollPosition(page);
  try {
    const buf = await page.screenshot({ fullPage: true, type: 'png' });
    return uploadImage(`data:image/png;base64,${buf.toString('base64')}`);
  } finally {
    await restoreScrollPosition(page, scrollSnapshot);
  }
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
