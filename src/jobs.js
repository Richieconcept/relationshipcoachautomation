import { logger } from './logger.js';
import { loadJobs, saveJob } from './job-store.js';

const jobs = new Map();

// Generate-only projects end at completed/failed; Generate & Publish projects end at a publishing outcome.
const FINISHED_STATUSES = ['completed', 'failed', 'published', 'partially_published', 'publishing_failed'];

for (const job of loadJobs()) {
  if (!FINISHED_STATUSES.includes(job.status) && job.status !== 'interrupted') {
    job.interruptedStatus = job.status;
    job.status = 'interrupted';
    job.message = 'The app restarted. Resume this job to recover existing scenes before generating anything new.';
    saveJob(job);
  }
  jobs.set(job.id, job);
}

export function canResumeJob(job) {
  return Boolean(job && ['failed', 'interrupted'].includes(job.status)
    && !job.finalVideoPath && !Object.values(job.publishingResults || {}).some(result => ['published', 'sent', 'scheduled'].includes(result.status))
    && !['publishing', 'uploading_to_cloudinary', 'ready_to_publish'].includes(job.interruptedStatus));
}

function newJobId() {
  // Two jobs created in the same millisecond must not collide.
  let id = `vid_${Date.now()}`;
  while (jobs.has(id)) {
    id = `vid_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  }
  return id;
}

export function createJob(data) {
  const id = newJobId();
  const now = new Date().toISOString();
  const job = {
    id,
    type: 'single',
    prompt: data.prompt,
    aspectRatio: data.aspectRatio,
    referenceImage: data.referenceImage || null,
    accountId: data.accountId || 'default',
    projectName: data.projectName || '',
    model: data.model || '',
    status: 'queued',
    message: 'Job queued.',
    createdAt: now,
    updatedAt: now,
    videoPath: null,
    videoUrl: null,
    screenshotPath: null,
    error: null
  };

  jobs.set(id, job);
  saveJob(job);
  logger.info(`Job ${id} created`);
  return job;
}

/**
 * Multi-scene project. The scene count always comes from data.scenes.length;
 * scenes keep the order they were submitted in and are numbered 1..n.
 * Each scene is a prompt string or { prompt, spokenText, duration } (spokenText drives the captions;
 * duration is the Flow clip length such as '6s', empty for the FLOW_DEFAULT_DURATION).
 */
export function createProjectJob(data) {
  const id = newJobId();
  const now = new Date().toISOString();
  const scenes = data.scenes.map((entry, index) => ({
    number: index + 1,
    prompt: typeof entry === 'string' ? entry : entry.prompt,
    spokenText: typeof entry === 'string' ? '' : entry.spokenText || '',
    duration: typeof entry === 'string' ? '' : entry.duration || '',
    status: 'queued',
    message: 'Waiting for earlier scenes.',
    attempts: 0,
    videoPath: null,
    normalizedPath: null,
    clip: null,
    error: null,
    screenshotPath: null,
    startedAt: null,
    completedAt: null
  }));

  const job = {
    id,
    type: 'project',
    contentSlotId: data.contentSlotId || null,
    productionDeadline: data.productionDeadline || null,
    title: data.title,
    mode: data.mode || 'generate_only',
    aspectRatio: data.aspectRatio,
    model: data.model || '',
    globalInstructions: data.globalInstructions || '',
    referenceImage: data.referenceImage || null,
    // 'script' = split automatically from a written script; 'scenes' = prompts written by hand
    source: data.source || 'scenes',
    script: data.script || null,
    postMetadata: data.postMetadata || null,
    // Requested edit steps ({ logo, music, captions }) and, after editing, what was applied or skipped
    editing: data.editing || { logo: false, music: false, captions: false },
    editingResult: null,
    joinedVideoPath: null,
    joinedVideoUrl: null,
    status: 'queued',
    message: 'Project queued.',
    totalScenes: scenes.length,
    completedScenes: 0,
    currentScene: null,
    failedScene: null,
    scenes,
    finalVideoPath: null,
    finalVideoUrl: null,
    finalVideo: null,
    // Publishing (Generate & Publish only). Caption and hashtags stay separate until posting.
    publishing: data.publishing || null,
    publishingResults: data.publishingResults || null,
    cloudinary: null,
    error: null,
    createdAt: now,
    updatedAt: now
  };

  jobs.set(id, job);
  saveJob(job);
  logger.info(`Project ${id} created with ${scenes.length} scene${scenes.length === 1 ? '' : 's'}`, { title: job.title });
  return job;
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function listJobs() {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateJob(jobId, status, updates = {}) {
  const job = getJob(jobId);
  if (!job) {
    return null;
  }

  Object.assign(job, updates, {
    status,
    updatedAt: new Date().toISOString()
  });
  saveJob(job);

  logger.info(`${job.type === 'project' ? 'Project' : 'Job'} ${jobId} ${status}`, updates.message ? { message: updates.message } : undefined);
  return job;
}

export function updateScene(jobId, sceneNumber, status, updates = {}) {
  const job = getJob(jobId);
  const scene = job?.scenes?.find((item) => item.number === sceneNumber);
  if (!scene) {
    return null;
  }

  const previousStatus = scene.status;
  Object.assign(scene, updates, { status });
  job.completedScenes = job.scenes.filter((item) => item.status === 'completed').length;
  job.updatedAt = new Date().toISOString();
  saveJob(job);

  // Progress ticks ("generating 45%") update the message without flooding the log.
  if (status !== previousStatus || status === 'retrying') {
    logger.info(`Project ${jobId} scene ${sceneNumber}/${job.totalScenes} ${status}`, updates.message ? { message: updates.message } : undefined);
  }
  return scene;
}

export function hasActiveGeneration() {
  return listJobs().some((job) => job.status !== 'interrupted' && !FINISHED_STATUSES.includes(job.status));
}

export function isFinished(job) {
  return FINISHED_STATUSES.includes(job.status);
}
