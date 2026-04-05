/**
 * shared/screenshot.js — screenshotFull / screenshotViewport / screenshotPlayer
 */

"use strict";

const { uploadImage } = require("./upload");

/**
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string>} Cloudinary URL
 */
async function screenshotFull(page) {
  const buffer = await page.screenshot({ fullPage: true, type: "png" });
  const dataUri = `data:image/png;base64,${buffer.toString("base64")}`;
  return uploadImage(dataUri);
}

/**
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string>} Cloudinary URL
 */
async function screenshotViewport(page) {
  const buffer = await page.screenshot({ fullPage: false, type: "png" });
  const dataUri = `data:image/png;base64,${buffer.toString("base64")}`;
  return uploadImage(dataUri);
}

/**
 * Screenshot a specific element (e.g. a video player).
 * @param {import('puppeteer-core').Page} page
 * @param {string} selector  CSS selector for the player element
 * @returns {Promise<string>} Cloudinary URL
 */
async function screenshotPlayer(page, selector) {
  const el = await page.$(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  const buffer = await el.screenshot({ type: "png" });
  const dataUri = `data:image/png;base64,${buffer.toString("base64")}`;
  return uploadImage(dataUri);
}

module.exports = { screenshotFull, screenshotViewport, screenshotPlayer };
