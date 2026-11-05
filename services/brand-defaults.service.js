import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';

function defaultsPath() { return path.join(config.brandDir, 'defaults.json'); }

async function previousInstructions() {
  const directory = path.join(config.rootDir, 'tmp', 'jobs');
  const names = await fs.readdir(directory).catch(() => []);
  const jobs = await Promise.all(names.filter(name => /^vid_[\d_]+\.json$/.test(name)).map(async name => {
    try { return JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')); } catch { return null; }
  }));
  return jobs.filter(job => job?.globalInstructions?.trim()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.globalInstructions || '';
}

export async function getBrandDefaults() {
  try { return JSON.parse(await fs.readFile(defaultsPath(), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return saveBrandDefaults({ globalInstructions: await previousInstructions() });
  }
}

export async function saveBrandDefaults({ globalInstructions }) {
  if (typeof globalInstructions !== 'string' || globalInstructions.length > 30000) {
    throw new Error('Global instructions must be text, up to 30,000 characters.');
  }
  const defaults = { version: 1, globalInstructions: globalInstructions.trim(), updatedAt: new Date().toISOString() };
  await fs.mkdir(config.brandDir, { recursive: true });
  const target = defaultsPath();
  await fs.writeFile(`${target}.tmp`, JSON.stringify(defaults, null, 2));
  await fs.rename(`${target}.tmp`, target);
  return defaults;
}

export async function resolveGlobalInstructions(override) {
  const text = typeof override === 'string' ? override.trim() : '';
  return text || (await getBrandDefaults()).globalInstructions;
}
