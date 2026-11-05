import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { v2 as cloudinary } from 'cloudinary';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { PublishingError } from '../src/publishing-error.js';

// Files above this size are sent in chunks (Cloudinary's upload_large).
const CHUNK_SIZE_BYTES = 20 * 1024 * 1024;

export function cloudinaryConfigMissing() {
  const { cloudName, apiKey, apiSecret } = config.cloudinary;
  return [
    !cloudName && 'CLOUDINARY_CLOUD_NAME',
    !apiKey && 'CLOUDINARY_API_KEY',
    !apiSecret && 'CLOUDINARY_API_SECRET'
  ].filter(Boolean);
}

export function assertCloudinaryConfigured() {
  const missing = cloudinaryConfigMissing();
  if (missing.length > 0) {
    throw new PublishingError(
      'CLOUDINARY_CONFIG_MISSING',
      `Cloudinary is not configured. Set ${missing.join(', ')} in .env and restart the server.`
    );
  }
}

async function configureSdk() {
  // Reload local credentials on every attempt, including retries after an operator edits .env.
  try {
    const values = dotenv.parse(await fs.readFile(path.join(config.rootDir, '.env')));
    for (const [field, key] of Object.entries({
      cloudName: 'CLOUDINARY_CLOUD_NAME', apiKey: 'CLOUDINARY_API_KEY',
      apiSecret: 'CLOUDINARY_API_SECRET', folder: 'CLOUDINARY_FOLDER'
    })) {
      if (Object.hasOwn(values, key)) config.cloudinary[field] = values[key];
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assertCloudinaryConfigured();
  cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
    secure: true
  });
}

// upload_large streams the file in chunks and reports through its callback (it does not return a promise).
function uploadLarge(localPath, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_large(localPath, options, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
    stream?.on?.('error', reject);
  });
}

/**
 * Upload a finished MP4 as a public video. Returns { publicId, secureUrl, bytes, duration }.
 * The secure_url is a plain (unsigned) delivery URL, so it stays valid until Buffer publishes.
 */
export async function uploadVideo(localVideoPath, { publicId, folder } = {}) {
  await configureSdk();
  folder ??= config.cloudinary.folder;

  const stat = await fs.stat(localVideoPath).catch(() => null);
  if (!stat || stat.size === 0) {
    throw new PublishingError('CLOUDINARY_UPLOAD_FAILED', `Final video not found or empty: ${localVideoPath}`);
  }

  const startedAt = Date.now();
  logger.info('Uploading video to Cloudinary', { file: localVideoPath, sizeBytes: stat.size, folder, publicId });

  let result;
  try {
    result = await uploadLarge(localVideoPath, {
      resource_type: 'video',
      folder,
      public_id: publicId,
      overwrite: true,
      chunk_size: CHUNK_SIZE_BYTES
    });
  } catch (error) {
    const message = error?.error?.message || error?.message || 'Unknown Cloudinary error';
    throw new PublishingError('CLOUDINARY_UPLOAD_FAILED', `Cloudinary upload failed: ${message}`, {
      httpCode: error?.http_code || error?.error?.http_code
    });
  }

  if (!result?.secure_url) {
    throw new PublishingError('CLOUDINARY_UPLOAD_FAILED', 'Cloudinary upload finished without a secure URL.');
  }

  logger.info('Cloudinary upload complete', {
    publicId: result.public_id,
    secureUrl: result.secure_url,
    seconds: Math.round((Date.now() - startedAt) / 1000)
  });

  return {
    publicId: result.public_id,
    secureUrl: result.secure_url,
    bytes: result.bytes,
    duration: result.duration,
    format: result.format
  };
}

// Confirms a delivery URL is publicly reachable and serves video, as Buffer will need it to.
export async function verifyPublicVideoUrl(url) {
  const response = await fetch(url, { method: 'HEAD' });
  const contentType = response.headers.get('content-type') || '';
  return {
    ok: response.ok && contentType.startsWith('video/'),
    status: response.status,
    contentType,
    contentLength: Number(response.headers.get('content-length')) || null
  };
}
