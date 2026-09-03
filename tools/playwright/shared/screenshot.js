/**
 * shared/screenshot.js — Local blobref screenshot helpers.
 */

import { writeBlobBuffer } from '../runtime/evidence-store.js';

async function captureScrollPosition(page) {
  return page.mainFrame().evaluate(() => {
    return { x: window.scrollX, y: window.scrollY };
  });
}

async function restoreScrollPosition(page, { x, y } = {}) {
  await page.mainFrame().evaluate(({ x, y }) => {
    window.scrollTo(x, y);
  }, { x, y }).catch(() => {});
}

/** Full-page screenshot → blobref */
export async function screenshotFull(page) {
  const scrollSnapshot = await captureScrollPosition(page);
  try {
    const buf = await page.screenshot({ fullPage: true, type: 'webp', quality: 80 });
    return writeBlobBuffer(buf);
  } finally {
    await restoreScrollPosition(page, scrollSnapshot);
  }
}

/** Viewport screenshot → blobref */
export async function screenshotViewport(page) {
  const buf = await page.screenshot({ fullPage: false, type: 'webp', quality: 80 });
  return writeBlobBuffer(buf);
}

/** Element screenshot → blobref */
export async function screenshotElement(el) {
  const buf = await el.screenshot({ type: 'webp', quality: 80 });
  return writeBlobBuffer(buf);
}
