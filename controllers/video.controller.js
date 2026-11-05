import { generationFailureDetails } from '../services/flow-result-status.service.js';
import { buildPostMetadata, spokenScript, applyScriptPostMetadata } from '../services/post-metadata.service.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAvailableAccountId } from '../src/accounts.js';
import { config, supportedAspectRatios } from '../src/config.js';
import { enqueueFlowWork } from '../src/flow-lane.js';
import { canResumeJob, createJob, createProjectJob, getJob, hasActiveGeneration, listJobs, updateJob } from '../src/jobs.js';
import { checkFfmpeg } from '../services/ffmpeg.service.js';
import { generateVideo } from '../services/flow.service.js';
import { projectFileUrl } from '../services/project-files.service.js';
import {
  canRetryPublishing,
  GENERATE_ONLY_MODE,
  initialPublishingResults,
  parsePublishing,
  preflightPublishing,
  publishJob,
  PUBLISH_MODE
} from '../services/publishing.service.js';
import { submitProject } from '../services/scene-queue.service.js';
import { brandAssetPath } from '../services/brand.service.js';
import { resolveGlobalInstructions } from '../services/brand-defaults.service.js';
import { extractSpokenText, sceneSpeechPrompt, ScriptError, splitScript } from '../services/script-splitter.service.js';
import { parseEditingOptions, planEditing } from '../services/video-editor.service.js';
import { PublishingError } from '../src/publishing-error.js';

function serializeSingleJob(job) {
  const response = {
    success: job.status !== 'failed',
    type: 'single',
    jobId: job.id,
    accountId: job.accountId,
    status: job.status,
    message: job.message
  };

  if (job.videoUrl) {
    response.videoUrl = job.videoUrl;
  }

  if (job.screenshotPath) {
    response.screenshotPath = job.screenshotPath;
  }

  if (job.error) {
    response.success = false;
    response.error = job.error;
  }

  return response;
}

function serializeProjectJob(job) {
  const totalScenes = job.scenes.length;
  const response = {
    success: job.status !== 'failed',
    type: 'project',
    jobId: job.id,
    title: job.title,
    contentSlotId: job.contentSlotId || null,
    mode: job.mode,
    status: job.status,
    message: job.message,
    aspectRatio: job.aspectRatio,
    totalScenes,
    completedScenes: job.completedScenes,
    currentScene: job.currentScene,
    progressPercent: totalScenes > 0 ? Math.round((job.completedScenes / totalScenes) * 100) : 0,
    source: job.source,
    postMetadata: job.postMetadata || null,
    localMediaDeletedAt: job.localMediaDeletedAt || null,
    mediaCleanupError: job.mediaCleanupError || null,
    editing: job.editing,
    editingResult: job.editingResult,
    pacing: job.pacing || null,
    scenes: job.scenes.map((scene) => ({
      scene: scene.number,
      status: scene.status,
      attempts: scene.attempts,
      retryAt: scene.retryAt || null,
      message: scene.message,
      error: scene.error,
      failure: scene.status === 'failed' ? generationFailureDetails(scene.error, scene.providerMessage) : null,
      spokenText: scene.spokenText || '',
      clipLength: scene.duration || config.defaultDuration,
      trimmedTo: scene.trimmedTo ?? null,
      clipUrl: projectFileUrl(scene.videoPath),
      duration: scene.clip?.duration ?? null,
      screenshotPath: scene.screenshotPath
    })),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };

  if (job.finalVideoUrl) {
    response.finalVideoUrl = job.finalVideoUrl;
    response.finalVideo = job.finalVideo;
  }

  if (job.joinedVideoUrl) {
    response.joinedVideoUrl = job.joinedVideoUrl;
  }

  if (job.mode === PUBLISH_MODE) {
    // Results only: captions stay server-side, and no credentials are ever included.
    response.cloudinaryUrl = job.cloudinary?.secureUrl || null;
    response.cloudinary = job.cloudinary
      ? { publicId: job.cloudinary.publicId, secureUrl: job.cloudinary.secureUrl }
      : null;
    response.publishing = job.publishingResults;
    response.canRetryPublishing = canRetryPublishing(job);
  }

  if (['failed', 'publishing_failed', 'partially_published'].includes(job.status)) {
    response.success = job.status === 'partially_published';
    response.failedScene = job.failedScene;
    response.error = job.error;
    response.errorCode = job.errorCode;
  }

  return response;
}

function serializeJob(job) {
  const serialized = job.type === 'project' ? serializeProjectJob(job) : serializeSingleJob(job);
  return { ...serialized, failure: job.status === 'failed' ? generationFailureDetails(job.errorCode, job.providerMessage) : null, canResume: canResumeJob(job) };
}

export function generateVideoController(req, res) {
  const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) {
    return res.status(400).json({
      success: false,
      error: 'PROMPT_REQUIRED',
      message: 'prompt is required.'
    });
  }

  if (hasActiveGeneration()) {
    return res.status(409).json({
      success: false,
      status: 'busy',
      message: 'Another Flow generation is currently running.'
    });
  }

  const requestedAspectRatio = req.body.aspectRatio || config.defaultAspectRatio;
  const aspectRatio = supportedAspectRatios.has(requestedAspectRatio)
    ? requestedAspectRatio
    : config.defaultAspectRatio;

  const accountId = getAvailableAccountId();
  if (!accountId) {
    return res.status(503).json({
      success: false,
      error: 'NO_AVAILABLE_FLOW_ACCOUNT',
      message: 'No configured Flow account is currently available.'
    });
  }

  const job = createJob({
    prompt,
    aspectRatio,
    referenceImage: req.file ? path.resolve(req.file.path) : null,
    accountId,
    projectName: req.body.projectName || config.defaultProject,
    model: req.body.model || config.defaultModel
  });

  enqueueFlowWork(() => generateVideo(job));

  return res.status(202).json({
    success: true,
    jobId: job.id,
    status: job.status
  });
}

// Accepts scenes as a JSON array (application/json) or a JSON string field (multipart/form-data).
// Each entry may be a prompt string or an object with a "prompt" field. Array order is the scene order.
function parseScenes(rawScenes) {
  let scenes = rawScenes;

  if (typeof scenes === 'string') {
    try {
      scenes = JSON.parse(scenes);
    } catch {
      return { error: 'scenes must be a JSON array.' };
    }
  }

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return { error: 'scenes must be a non-empty array.' };
  }

  const prompts = [];
  for (const [index, entry] of scenes.entries()) {
    const prompt = typeof entry === 'string' ? entry : entry?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { error: `Scene ${index + 1} needs a non-empty prompt.` };
    }
    prompts.push(prompt.trim());
  }

  return { prompts };
}

// Preview only: how a script will be split into scenes. Nothing is generated.
export function splitScriptController(req, res) {
  try {
    return res.json({ success: true, ...splitScript(req.body?.script), postMetadata: buildPostMetadata(req.body?.script) });
  } catch (error) {
    if (error instanceof ScriptError) {
      return res.status(400).json({ success: false, error: error.code, message: error.message });
    }
    throw error;
  }
}

/**
 * Script mode: the script is split into scenes and each becomes "presenter says: <words>".
 * Scene mode: prompts are used as written; any "quoted" words are taken as the spoken line for captions.
 */
function buildProjectScenes(body) {
  const script = typeof body.script === 'string' ? body.script.trim() : '';
  if (script) {
    const split = splitScript(script);
    return {
      source: 'script',
      script,
      scenes: split.scenes.map((scene) => ({
        prompt: sceneSpeechPrompt(scene.text),
        spokenText: scene.text,
        duration: scene.duration
      }))
    };
  }

  const { prompts, error } = parseScenes(body.scenes);
  if (error) {
    throw new ScriptError(error);
  }
  return {
    source: 'scenes',
    script: null,
    scenes: prompts.map((prompt) => ({ prompt, spokenText: extractSpokenText(prompt) }))
  };
}

export async function generateProjectController(req, res) {
  const uploadedFile = req.file ? path.resolve(req.file.path) : null;
  const reject = async (status, error, message) => {
    if (uploadedFile) {
      await fs.unlink(uploadedFile).catch(() => {});
    }
    return res.status(status).json({ success: false, error, message });
  };

  let project;
  try {
    project = buildProjectScenes(req.body);
  } catch (error) {
    if (error instanceof ScriptError) {
      return reject(400, req.body.script ? 'INVALID_SCRIPT' : 'INVALID_SCENES', error.message);
    }
    throw error;
  }

  const editing = parseEditingOptions(req.body.editing);
  const { skipped: editingSkipped } = planEditing(editing, {
    hasSpokenText: project.scenes.some((scene) => scene.spokenText)
  });

  const aspectRatio = req.body.aspectRatio || config.defaultAspectRatio;
  if (!supportedAspectRatios.has(aspectRatio)) {
    return reject(400, 'INVALID_ASPECT_RATIO', `aspectRatio must be one of: ${[...supportedAspectRatios].join(', ')}.`);
  }

  const mode = req.body.mode || GENERATE_ONLY_MODE;
  if (![GENERATE_ONLY_MODE, PUBLISH_MODE].includes(mode)) {
    return reject(400, 'INVALID_MODE', `mode must be "${GENERATE_ONLY_MODE}" or "${PUBLISH_MODE}".`);
  }

  const postMetadata = buildPostMetadata(spokenScript(project));
  const { publishing, errors: publishingErrors } = parsePublishing(
    applyScriptPostMetadata(req.body.publishing, spokenScript(project), { title: req.body.title }), { mode });
  if (publishingErrors.length > 0) {
    return reject(400, 'PUBLISHING_VALIDATION_FAILED', publishingErrors.join(' '));
  }

  let warnings = [];
  if (mode === PUBLISH_MODE) {
    // Fail now, not after minutes of Flow generation, if the video could never be published.
    try {
      ({ warnings } = await preflightPublishing(publishing));
    } catch (error) {
      if (!(error instanceof PublishingError)) {
        throw error;
      }
      const status = ['CLOUDINARY_CONFIG_MISSING', 'BUFFER_CONFIG_MISSING', 'BUFFER_CHANNEL_NOT_FOUND'].includes(error.code) ? 400 : 502;
      return reject(status, error.code, error.message);
    }
  }

  const ffmpeg = await checkFfmpeg();
  if (!ffmpeg.available) {
    return reject(503, 'FFMPEG_NOT_AVAILABLE', ffmpeg.error);
  }

  if (!getAvailableAccountId()) {
    return reject(503, 'NO_AVAILABLE_FLOW_ACCOUNT', 'No configured Flow account is currently available.');
  }

  const title = typeof req.body.title === 'string' && req.body.title.trim()
    ? req.body.title.trim()
    : project.script ? project.script.replace(/\s+/g, ' ').trim().slice(0, 80) : `Untitled project ${new Date().toLocaleString()}`;
  let globalInstructions;
  try { globalInstructions = await resolveGlobalInstructions(req.body.globalInstructions); }
  catch (error) { return reject(500, 'DEFAULTS_UNAVAILABLE', error.message); }

  const job = createProjectJob({
    title,
    mode,
    publishing: mode === PUBLISH_MODE ? publishing : null,
    publishingResults: mode === PUBLISH_MODE ? initialPublishingResults(publishing) : null,
    aspectRatio,
    globalInstructions,
    postMetadata,
    scenes: project.scenes,
    source: project.source,
    script: project.script,
    editing,
    // An image uploaded with this project wins; otherwise the saved brand presenter is used.
    referenceImage: uploadedFile || brandAssetPath('presenter'),
    model: req.body.model || config.defaultModel
  });

  submitProject(job);

  // Missing logo/music is not an error: the video is still made, without that step.
  warnings = [...warnings, ...Object.values(editingSkipped)];

  return res.status(202).json({
    success: true,
    jobId: job.id,
    mode,
    status: job.status,
    totalScenes: job.scenes.length,
    ...(warnings.length ? { warnings } : {})
  });
}

// Re-send only the platforms that failed, reusing the existing final video and Cloudinary upload.
export function retryPublishingController(req, res) {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'JOB_NOT_FOUND', message: 'Job not found.' });
  }
  if (!canRetryPublishing(job)) {
    return res.status(409).json({
      success: false,
      error: 'NOTHING_TO_RETRY',
      message: 'Publishing can only be retried for a Generate & Publish project that partly or fully failed to publish.'
    });
  }

  publishJob(job.id).catch((error) => {
    updateJob(job.id, 'publishing_failed', { error: error.message, errorCode: error.code || 'PUBLISHING_FAILED', message: error.message });
  });
  return res.status(202).json({ success: true, jobId: job.id, status: 'publishing' });
}

export function resumeJobController(req, res) {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'JOB_NOT_FOUND', message: 'Job not found.' });
  if (!canResumeJob(job)) return res.status(409).json({ success: false, error: 'JOB_NOT_RESUMABLE', message: 'This job is already running, finished, or requires publishing review.' });
  updateJob(job.id, 'queued', { ...(req.body?.generateOnly === true ? { mode: 'generate_only' } : {}), productionDeadline: null, error: null, errorCode: null, failedScene: null, message: 'Resuming saved scenes; existing generations will be checked before any new submission.' });
  const task = job.type === 'project' ? submitProject(job) : enqueueFlowWork(() => generateVideo(job));
  task.catch(error => updateJob(job.id, 'failed', { error: error.message, message: error.message }));
  return res.status(202).json({ success: true, jobId: job.id, status: 'queued' });
}

export function getJobController(req, res) {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      success: false,
      error: 'JOB_NOT_FOUND',
      message: 'Job not found.'
    });
  }

  return res.json(serializeJob(job));
}

export function listJobsController(req, res) {
  return res.json({
    success: true,
    jobs: listJobs().map(serializeJob)
  });
}

export async function systemCheckController(req, res) {
  const ffmpeg = await checkFfmpeg({ force: req.query.refresh === '1' });
  return res.status(ffmpeg.available ? 200 : 503).json({
    success: ffmpeg.available,
    ffmpeg
  });
}
