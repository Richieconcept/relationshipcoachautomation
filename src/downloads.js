import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export async function ensureRuntimeFolders() {
  await Promise.all([
    fs.mkdir(config.downloadDir, { recursive: true }),
    fs.mkdir(config.browserDownloadTempDir, { recursive: true }),
    fs.mkdir(config.projectDownloadDir, { recursive: true }),
    fs.mkdir(config.uploadDir, { recursive: true }),
    fs.mkdir(config.brandDir, { recursive: true }),
    fs.mkdir(config.screenshotDir, { recursive: true }),
    fs.mkdir(config.browserProfileDir, { recursive: true }),
    fs.mkdir(config.browserProfilesDir, { recursive: true }),
    fs.mkdir(path.dirname(config.logFile), { recursive: true })
  ]);
}

export function buildVideoUrl(filename) {
  return `/downloads/videos/${filename}`;
}

export function videoPathForJob(jobId) {
  const filename = `${jobId}.mp4`;
  return {
    filename,
    fullPath: path.join(config.downloadDir, filename)
  };
}

// MP4/MOV files carry an "ftyp" box at byte offset 4; images (JPEG/PNG/WebP) never do.
export function isMp4Buffer(buffer) {
  return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
}

export async function isMp4File(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(12), 0, 12, 0);
    return isMp4Buffer(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
