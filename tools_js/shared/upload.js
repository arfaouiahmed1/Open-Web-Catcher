/**
 * shared/upload.js — Cloudinary upload with timeout.
 */

"use strict";

const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Upload a base64-encoded image (data URI or raw buffer) to Cloudinary.
 * @param {string|Buffer} imageData  data URI or Buffer
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.folder]
 * @returns {Promise<string>}  public URL
 */
async function uploadImage(imageData, { timeoutMs = DEFAULT_TIMEOUT_MS, folder = "owc" } = {}) {
  const uploadPromise = new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      imageData,
      { folder, resource_type: "image" },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
  });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Cloudinary upload timed out after ${timeoutMs}ms`)), timeoutMs)
  );

  return Promise.race([uploadPromise, timeoutPromise]);
}

module.exports = { uploadImage };
