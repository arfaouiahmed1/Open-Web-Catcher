/**
 * shared/upload.js — Cloudinary upload with timeout.
 */

import { v2 as cloudinary } from 'cloudinary';

const CLOUDINARY_UPLOAD_PRESET = (process.env.CLOUDINARY_UPLOAD_PRESET || '').trim();
const unsignedModeEnv = String(process.env.CLOUDINARY_UNSIGNED_UPLOAD || '').toLowerCase();
const CLOUDINARY_UNSIGNED_UPLOAD =
  unsignedModeEnv === 'true' || (CLOUDINARY_UPLOAD_PRESET && unsignedModeEnv !== 'false');

const CLOUDINARY_CONFIGURED = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_CLOUD_NAME !== 'your_cloud_name',
);

const cloudinaryConfig = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  upload_preset: CLOUDINARY_UPLOAD_PRESET || undefined,
};

if (!CLOUDINARY_UNSIGNED_UPLOAD) {
  cloudinaryConfig.api_key = process.env.CLOUDINARY_API_KEY;
  cloudinaryConfig.api_secret = process.env.CLOUDINARY_API_SECRET;
}

cloudinary.config(cloudinaryConfig);

const DEFAULT_TIMEOUT_MS = 15_000;

function sanitizeCloudinaryError(error) {
  const raw = error?.message || String(error || 'Cloudinary upload failed');
  return raw.replace(/api_key\s+[^\s]+/gi, 'api_key <redacted>');
}

/**
 * Upload a base64 data-URI or Buffer to Cloudinary.
 * @param {string|Buffer} imageData
 * @param {{ timeoutMs?: number, folder?: string }} opts
 * @returns {Promise<string>} public secure URL
 */
export async function uploadImage(imageData, { timeoutMs = DEFAULT_TIMEOUT_MS, folder = 'owc' } = {}) {
  // If Cloudinary is not configured, return the image as a data URI so tool
  // results still carry a usable screenshot instead of an empty string.
  if (!CLOUDINARY_CONFIGURED) {
    if (typeof imageData === 'string' && imageData.startsWith('data:')) {
      return imageData;
    }
    if (Buffer.isBuffer(imageData)) {
      return `data:image/png;base64,${imageData.toString('base64')}`;
    }
    return imageData;
  }

  const baseOptions = {
    folder,
    resource_type: 'image',
  };

  async function uploadWithOptions(uploadOptions) {
    const upload = new Promise((resolve, reject) => {
      if (uploadOptions.unsigned && uploadOptions.upload_preset) {
        const { upload_preset: uploadPreset, unsigned: _unsigned, ...unsignedOptions } = uploadOptions;
        cloudinary.uploader.unsigned_upload(
          imageData,
          uploadPreset,
          unsignedOptions,
          (err, result) => err ? reject(err) : resolve(result.secure_url),
        );
        return;
      }

      cloudinary.uploader.upload(imageData, uploadOptions, (err, result) =>
        err ? reject(err) : resolve(result.secure_url)
      );
    });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Cloudinary upload timed out after ${timeoutMs}ms`)), timeoutMs),
    );
    try {
      return await Promise.race([upload, timeout]);
    } catch (error) {
      throw new Error(sanitizeCloudinaryError(error));
    }
  }

  if (CLOUDINARY_UPLOAD_PRESET) {
    const unsignedOptions = {
      ...baseOptions,
      upload_preset: CLOUDINARY_UPLOAD_PRESET,
      unsigned: true,
    };

    try {
      return await uploadWithOptions(unsignedOptions);
    } catch (unsignedError) {
      if (CLOUDINARY_UNSIGNED_UPLOAD) {
        throw unsignedError;
      }
      const signedPresetOptions = {
        ...baseOptions,
        upload_preset: CLOUDINARY_UPLOAD_PRESET,
      };
      try {
        return await uploadWithOptions(signedPresetOptions);
      } catch {
        // Final fallback: allow signed upload without preset for accounts
        // where preset name is invalid but API credentials are valid.
        return uploadWithOptions(baseOptions);
      }
    }
  }

  const signedOptions = {
    ...baseOptions,
  };
  return uploadWithOptions(signedOptions);
}
