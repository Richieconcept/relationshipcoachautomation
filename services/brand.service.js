import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';

// One file per kind, stored as brand/<kind>.<ext>. Uploading a new one replaces the old one.
export const BRAND_ASSETS = {
  presenter: { label: 'Presenter image', extensions: ['.png', '.jpg', '.jpeg', '.webp'] },
  logo: { label: 'Logo', extensions: ['.png', '.webp', '.jpg', '.jpeg'] },
  music: { label: 'Background music', extensions: ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac'] }
};

export class BrandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrandError';
    this.code = code;
  }
}

export function brandAssetPath(kind) {
  const asset = BRAND_ASSETS[kind];
  if (!asset) {
    return null;
  }
  for (const extension of asset.extensions) {
    const candidate = path.join(config.brandDir, `${kind}${extension}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Optional custom fonts for captions (brand/fonts/*.ttf|otf), picked up by libass.
export function brandFontsDir() {
  const dir = path.join(config.brandDir, 'fonts');
  return existsSync(dir) ? dir : null;
}

export async function brandStatus() {
  const assets = {};
  for (const [kind, asset] of Object.entries(BRAND_ASSETS)) {
    const filePath = brandAssetPath(kind);
    const stat = filePath ? await fs.stat(filePath).catch(() => null) : null;
    assets[kind] = {
      label: asset.label,
      available: Boolean(stat),
      fileName: stat ? path.basename(filePath) : null,
      url: stat ? `/brand/${path.basename(filePath)}?v=${Math.round(stat.mtimeMs)}` : null,
      sizeBytes: stat?.size ?? null,
      accepts: asset.extensions
    };
  }
  return assets;
}

/** Moves an uploaded temp file into brand/<kind>.<ext>, removing any previous file of that kind. */
export async function saveBrandAsset(kind, uploadedPath, originalName) {
  const asset = BRAND_ASSETS[kind];
  if (!asset) {
    throw new BrandError('UNKNOWN_BRAND_ASSET', `Unknown brand asset "${kind}". Use: ${Object.keys(BRAND_ASSETS).join(', ')}.`);
  }

  const extension = path.extname(originalName || '').toLowerCase();
  if (!asset.extensions.includes(extension)) {
    throw new BrandError('UNSUPPORTED_FILE_TYPE', `${asset.label} must be one of: ${asset.extensions.join(', ')}.`);
  }

  await fs.mkdir(config.brandDir, { recursive: true });
  for (const oldExtension of asset.extensions) {
    await fs.rm(path.join(config.brandDir, `${kind}${oldExtension}`), { force: true });
  }

  const target = path.join(config.brandDir, `${kind}${extension}`);
  await fs.rename(uploadedPath, target).catch(async () => {
    // rename fails across drives; fall back to copy + delete
    await fs.copyFile(uploadedPath, target);
    await fs.rm(uploadedPath, { force: true });
  });

  logger.info(`Brand ${kind} saved`, { fileName: path.basename(target) });
  return target;
}

export async function deleteBrandAsset(kind) {
  const asset = BRAND_ASSETS[kind];
  if (!asset) {
    throw new BrandError('UNKNOWN_BRAND_ASSET', `Unknown brand asset "${kind}".`);
  }
  for (const extension of asset.extensions) {
    await fs.rm(path.join(config.brandDir, `${kind}${extension}`), { force: true });
  }
  logger.info(`Brand ${kind} removed`);
}
