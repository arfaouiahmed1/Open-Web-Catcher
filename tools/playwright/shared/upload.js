/**
 * shared/upload.js — Cloudinary upload with local blob fallback.
 *
 * When Cloudinary credentials are provided, uploads to Cloudinary and returns
 * the public secure URL for visual proof and inspection.
 * When Cloudinary is not configured or upload fails, falls back cleanly to the
 * local content-addressed blob store, returning "blobref:<sha256[:16]>".
 */

import { writeBlobBuffer } from '../runtime/evidence-store.js';

const CLOUDINARY_CLOUD_NAME = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUDINARY_UPLOAD_PRESET = String(process.env.CLOUDINARY_UPLOAD_PRESET || '').trim();
const CLOUDINARY_API_KEY = String(process.env.CLOUDINARY_API_KEY || '').trim();
const CLOUDINARY_API_SECRET = String(process.env.CLOUDINARY_API_SECRET || '').trim();

const IS_CONFIGURED = Boolean(
  CLOUDINARY_CLOUD_NAME &&
  CLOUDINARY_CLOUD_NAME !== 'your_cloud_name' &&
  (CLOUDINARY_UPLOAD_PRESET || (CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET)),
);

let _cloudinary = null;
async function getCloudinary() {
  if (_cloudinary) return _cloudinary;
  try {
    const mod = await import('cloudinary');
    _cloudinary = mod.v2 ?? mod.default?.v2 ?? mod.default;
    _cloudinary.config({
      cloud_name: CLOUDINARY_CLOUD_NAME,
      api_key: CLOUDINARY_API_KEY || undefined,
      api_secret: CLOUDINARY_API_SECRET || undefined,
    });
    return _cloudinary;
  } catch {
    return null;
  }
}

/**
 * Upload image buffer or data URI.
 * Returns Cloudinary secure URL if configured, otherwise persists locally to
 * content-addressed blob store and returns a blobref pointer.
 *
 * @param {string|Buffer} imageData
 * @param {{ timeoutMs?: number, folder?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function uploadImage(imageData, { timeoutMs = 15000, folder = 'owc' } = {}) {
  // If not configured, store locally via blob store
  if (!IS_CONFIGURED) {
    if (Buffer.isBuffer(imageData)) {
      return writeBlobBuffer(imageData);
    }
    const dataUriMatch = String(imageData || '').match(/^data:[^;,]+;base64,(.+)$/s);
    if (dataUriMatch) {
      const buf = Buffer.from(dataUriMatch[1], 'base64');
      return writeBlobBuffer(buf);
    }
    return writeBlobBuffer(Buffer.from(String(imageData), 'utf8'));
  }

  // Cloudinary upload with timeout
  try {
    const uploadPromise = new Promise((resolve, reject) => {
      const options = {
        folder,
        resource_type: 'image',
        ...(CLOUDINARY_UPLOAD_PRESET ? { upload_preset: CLOUDINARY_UPLOAD_PRESET } : {}),
      };

      getCloudinary().then((cloudinary) => {
        if (!cloudinary) {
          reject(new Error('Cloudinary SDK unavailable'));
          return;
        }
        if (CLOUDINARY_UPLOAD_PRESET) {
          cloudinary.uploader.unsigned_upload(imageData, CLOUDINARY_UPLOAD_PRESET, options, (err, res) => {
            if (err) reject(err);
            else resolve(res.secure_url);
          });
        } else {
          cloudinary.uploader.upload(imageData, options, (err, res) => {
            if (err) reject(err);
            else resolve(res.secure_url);
          });
        }
      }).catch(reject);
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Cloudinary upload timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    return await Promise.race([uploadPromise, timeoutPromise]);
  } catch (err) {
    console.warn('[upload] Cloudinary upload failed; falling back to local blob store:', err.message);
    const buf = Buffer.isBuffer(imageData) ? imageData : Buffer.from(String(imageData), 'utf8');
    return writeBlobBuffer(buf);
  }
}
