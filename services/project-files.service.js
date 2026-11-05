import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';

// downloads/projects/<jobId>/{raw,normalized,final}/ — one folder per project so cleanup can remove it whole.
export function projectPaths(jobId) {
  const root = path.join(config.projectDownloadDir, jobId);
  return {
    root,
    rawDir: path.join(root, 'raw'),
    normalizedDir: path.join(root, 'normalized'),
    finalDir: path.join(root, 'final')
  };
}

export function sceneFileName(sceneNumber) {
  return `scene_${String(sceneNumber).padStart(3, '0')}.mp4`;
}

export function rawScenePath(jobId, sceneNumber) {
  return path.join(projectPaths(jobId).rawDir, sceneFileName(sceneNumber));
}

export function normalizedScenePath(jobId, sceneNumber) {
  return path.join(projectPaths(jobId).normalizedDir, sceneFileName(sceneNumber));
}

export function finalVideoPath(jobId) {
  return path.join(projectPaths(jobId).finalDir, `${jobId}_final.mp4`);
}

// The scenes joined together before editing (no logo, music or captions). Kept so editing can be re-run.
export function joinedVideoPath(jobId) {
  return path.join(projectPaths(jobId).finalDir, `${jobId}_joined.mp4`);
}

// project.json: what was asked for (spoken words, aspect ratio, edit options), so files on disk can be re-edited later.
export function projectMetaPath(jobId) {
  return path.join(projectPaths(jobId).root, 'project.json');
}

export async function writeProjectMeta(job) {
  const meta = {
    jobId: job.id,
    title: job.title,
    aspectRatio: job.aspectRatio,
    model: job.model,
    globalInstructions: job.globalInstructions,
    referenceImage: job.referenceImage,
    mode: job.mode,
    source: job.source,
    script: job.script || null,
    editing: job.editing,
    scenes: job.scenes.map((scene) => ({
      number: scene.number,
      duration: scene.duration || '',
      prompt: scene.prompt,
      spokenText: scene.spokenText || ''
    })),
    createdAt: job.createdAt
  };
  await fs.mkdir(projectPaths(job.id).root, { recursive: true });
  await fs.writeFile(projectMetaPath(job.id), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

export async function readProjectMeta(jobId) {
  const text = await fs.readFile(projectMetaPath(jobId), 'utf8').catch(() => null);
  return text ? JSON.parse(text) : null;
}

// Public URL for a file under PROJECT_DOWNLOAD_DIR (served at /downloads/projects).
export function projectFileUrl(filePath) {
  if (!filePath) {
    return null;
  }
  const relative = path.relative(config.projectDownloadDir, filePath).split(path.sep).join('/');
  return `/downloads/projects/${relative}`;
}

export async function ensureProjectFolders(jobId) {
  const paths = projectPaths(jobId);
  await Promise.all([
    fs.mkdir(paths.rawDir, { recursive: true }),
    fs.mkdir(paths.normalizedDir, { recursive: true }),
    fs.mkdir(paths.finalDir, { recursive: true })
  ]);
  return paths;
}

/**
 * Deletes every local file for a project (raw, normalized and final).
 *
 * Called automatically only after every selected social platform confirms publication.
 */
export async function cleanupProjectFiles(jobId) {
  if (!/^vid_[\d_]+$/.test(jobId)) throw new Error('Invalid project ID for cleanup.');
  const { root } = projectPaths(jobId);
  const resolvedRoot = path.resolve(root);
  if (!resolvedRoot.startsWith(path.resolve(config.projectDownloadDir) + path.sep)) {
    throw new Error(`Refusing to delete outside the project download folder: ${resolvedRoot}`);
  }

  await fs.rm(resolvedRoot, { recursive: true, force: true });
  logger.info(`Project ${jobId}: local files deleted`, { root: resolvedRoot });
}
