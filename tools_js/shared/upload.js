/**
 * shared/upload.js — Cloudinary upload with timeout.
 */

import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Upload a base64 data-URI or Buffer to Cloudinary.
 * @param {string|Buffer} imageData
 * @param {{ timeoutMs?: number, folder?: string }} opts
 * @returns {Promise<string>} public secure URL
 */
export async function uploadImage(imageData, { timeoutMs = DEFAULT_TIMEOUT_MS, folder = 'owc' } = {}) {
  const upload = new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      imageData,
      { folder, resource_type: 'image' },
      (err, result) => err ? reject(err) : resolve(result.secure_url),
    );
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Cloudinary upload timed out after ${timeoutMs}ms`)), timeoutMs),
  );
  return Promise.race([upload, timeout]);
}
