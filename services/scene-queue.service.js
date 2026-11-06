import { RETRYABLE_SCENE_CODES, productionWindowError } from './production-policy.service.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeBrowser, finishFlowGeneration } from '../src/browser.js';
import { config } from '../src/config.js';
import { enqueueFlowWork, flowLaneLength } from '../src/flow-lane.js';
import { getJob, updateJob, updateScene } from '../src/jobs.js';
import { logger } from '../src/logger.js';
import { requireFfmpeg } from './ffmpeg.service.js';
import { automationErrorCode, generateFlowScene } from './flow.service.js';
import { sceneCheckpoints, recoveryError } from './flow-recovery.service.js';
import { publishJob, PUBLISH_MODE } from './publishing.service.js';
import {
  ensureProjectFolders,
  finalVideoPath,
  joinedVideoPath,
  normalizedScenePath,
  projectFileUrl,
  rawScenePath,
  writeProjectMeta
} from './project-files.service.js';
import { prepareSceneClips } from './pacing.service.js';
import { editVideo, planEditing } from './video-editor.service.js';
import {
  concatenateClips,
  validateFinalVideo
} from './video-assembler.service.js';
import { validateVideo } from './video-validator.service.js';

// Retrying these would fail the same way (or burn credits on a rejected prompt), so the project stops.
const NON_RETRYABLE_SCENE_CODES = [
  'GENERATION_REJECTED',
  'INSUFFICIENT_CREDITS',
  'NO_AVAILABLE_FLOW_ACCOUNT',
  'FLOW_DAILY_LIMIT_REACHED',
  'GOOGLE_LOGIN_REQUIRED',
  'GENERATION_NOT_STARTED',
  'GENERATE_BUTTON_NOT_FOUND',
  'PROMPT_INPUT_FAILED',
  'FLOW_SETTING_NOT_FOUND',
  'FLOW_UNUSUAL_ACTIVITY',
  'PROMPT_INPUT_NOT_FOUND',
  'PROJECT_NOT_FOUND',
  'FLOW_RECOVERY_REQUIRED',
  'SCENE_INPUTS_CHANGED',
  'SCENE_BUSY',
  'FFMPEG_NOT_AVAILABLE'
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function normalizeForCompare(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Global instructions first, then the scene-specific prompt. Skips the global block if the scene already contains it.
export function buildScenePrompt(globalInstructions, scenePrompt) {
  const globalText = String(globalInstructions || '').trim();
  const sceneText = String(scenePrompt || '').trim();

  if (!globalText || normalizeForCompare(sceneText).includes(normalizeForCompare(globalText))) {
    return sceneText;
  }

  return `${globalText}\n\n${sceneText}`;
}

function errorCodeOf(error) {
  if (error?.automationCode) {
    return error.automationCode;
  }
  if (['VIDEO_INVALID', 'FFMPEG_NOT_AVAILABLE', 'FFMPEG_FAILED', 'FFMPEG_TIMEOUT', 'EDITING_FAILED', 'PERSISTENCE_BUSY'].includes(error?.code)) {
    return error.code;
  }
  if (['EPERM','EACCES','EBUSY'].includes(error?.code)) return 'PERSISTENCE_BUSY';
  return automationErrorCode(error);
}

// Keep a clip that failed validation for debugging instead of overwriting it on the next attempt.
async function quarantineInvalidClip(filePath, attempt) {
  const target = filePath.replace(/\.mp4$/i, `_attempt_${pad(attempt, 2)}_invalid.mp4`);
  await fs.rename(filePath, target).catch(() => {});
}

export async function generateSceneWithRetries(job, scene, generateScene, wait = sleep, now = Date.now, validateClip = validateVideo, resetBrowser = closeBrowser) {
  const total = job.scenes.length;
  const maxAttempts = config.maxSceneRetries + 1;
  const attemptSuffix = ` of ${maxAttempts}`;
  const previousAttempts = scene.attempts || 0;
  const prompt = buildScenePrompt(job.globalInstructions, scene.prompt);
  const outputPath = rawScenePath(job.id, scene.number);
  const logLabel = `Project ${job.id} scene ${scene.number}/${total}`;
  let lastError = null;
  let lastCode = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const expired = productionWindowError(job.productionDeadline, now());
    if (expired) { lastError = expired; lastCode = expired.code; break; }
    updateScene(job.id, scene.number, 'opening_flow', {
      attempts: previousAttempts + attempt,
      error: null,
      providerMessage: null,
      retryAt: null,
      startedAt: scene.startedAt || new Date().toISOString(),
      message: `Attempt ${previousAttempts + attempt}${attemptSuffix}.`
    });

    try {
      await generateScene({
        prompt,
        referenceImage: job.referenceImage,
        aspectRatio: job.aspectRatio,
        model: job.model || config.defaultModel,
        duration: scene.duration || config.defaultDuration,
        outputPath,
        productionDeadline: job.productionDeadline || null,
        maxRetries: 0, // This queue owns the retry budget; do not nest 21 browser retries inside each scene attempt.
        logLabel,
        screenshotPrefix: `${job.id}_scene_${pad(scene.number, 3)}_attempt_${pad(attempt, 2)}`,
        onStatus: (status, message, extra = {}) => {
          updateScene(job.id, scene.number, status, {
            message,
            ...(extra.screenshotPath ? { screenshotPath: extra.screenshotPath } : {})
          });
        }
      });
      logger.info(`${logLabel} downloaded`, { outputPath });

      updateScene(job.id, scene.number, 'validating', { message: 'Checking the downloaded clip.' });
      const clip = await validateClip(outputPath);
      logger.info(`${logLabel} validated`, clip);

      updateScene(job.id, scene.number, 'completed', {
        videoPath: outputPath,
        clip,
        error: null,
        completedAt: new Date().toISOString(),
        message: `Completed: ${clip.duration}s, ${clip.width}x${clip.height}.`
      });
      return { ok: true };
    } catch (error) {
      lastError = error;
      lastCode = errorCodeOf(error);
      await resetBrowser().catch(() => {});

      if (lastCode === 'VIDEO_INVALID') {
        await quarantineInvalidClip(outputPath, attempt);
      }

      const canRetry = RETRYABLE_SCENE_CODES.has(lastCode) && !NON_RETRYABLE_SCENE_CODES.includes(lastCode) && attempt < maxAttempts;
      if (!canRetry) {
        if (RETRYABLE_SCENE_CODES.has(lastCode) && attempt >= maxAttempts) {
          lastError = recoveryError('Scene recovery stopped after ' + maxAttempts + ' attempts. Last failure (' + lastCode + '): ' + error.message + ' Review the failure before resuming.', 'SCENE_RETRY_EXHAUSTED');
          lastError.cause = error;
          lastError.screenshotPath = error.screenshotPath;
          lastError.providerMessage = error.providerMessage;
          lastCode = 'SCENE_RETRY_EXHAUSTED';
        }
        break;
      }

      const retryDelayMs = Math.min(60000, config.sceneRetryDelayMs * Math.min(attempt, 6));
      const delaySeconds = Math.round(retryDelayMs / 1000);
      updateScene(job.id, scene.number, 'retrying', {
        error: lastCode,
        retryAt: new Date(now() + retryDelayMs).toISOString(),
        screenshotPath: error.screenshotPath || scene.screenshotPath,
        message: `Attempt ${previousAttempts + attempt} failed (${lastCode}): ${error.message} Retrying in ${delaySeconds}s (attempt ${previousAttempts + attempt + 1}${attemptSuffix}).`
      });
      await wait(job.productionDeadline ? Math.min(retryDelayMs, Math.max(0, Date.parse(job.productionDeadline)-now())) : retryDelayMs);
    }
  }

  updateScene(job.id, scene.number, 'failed', {
    error: lastCode,
    providerMessage: lastError?.providerMessage || null,
    retryAt: null,
    screenshotPath: lastError?.screenshotPath || scene.screenshotPath,
    message: lastError?.message || 'Scene generation failed.'
  });
  return { ok: false, code: lastCode, error: lastError, attempts: scene.attempts };
}

export async function assembleProject(job) {
  const total = job.scenes.length;
  const incomplete = job.scenes.filter((scene) => scene.status !== 'completed' || !scene.videoPath);
  if (incomplete.length > 0) {
    throw new Error(`Cannot assemble: scene(s) ${incomplete.map((scene) => scene.number).join(', ')} are not completed.`);
  }

  updateJob(job.id, 'validating', { currentScene: null, message: `Re-checking all ${total} clips before assembly.` });
  const prepared = await prepareSceneClips(job, message => updateJob(job.id, 'normalizing', { message }));
  const clipPaths = prepared.clips.map(clip => clip.path);

  const plan = planEditing(job.editing, { hasSpokenText: job.scenes.some((scene) => scene.spokenText) });
  const outputPath = finalVideoPath(job.id);
  // With editing, the plain joined video is kept separately so editing can be re-run without regenerating.
  const joinedPath = plan.any ? joinedVideoPath(job.id) : outputPath;

  updateJob(job.id, 'assembling', { message: `Joining ${total} clip${total === 1 ? '' : 's'} in scene order.` });
  logger.info(`Project ${job.id}: assembling final video`, { clips: clipPaths.map((clip) => path.basename(clip)) });
  await concatenateClips(clipPaths, joinedPath, prepared);

  updateJob(job.id, 'validating', { message: 'Validating the joined video.' });
  const expectedDuration = prepared.expectedDuration;
  let finalVideo = await validateFinalVideo(joinedPath, expectedDuration);

  if (plan.any) {
    const steps = [plan.logoPath && 'logo', plan.musicPath && 'background music', plan.captions && 'captions'].filter(Boolean);
    updateJob(job.id, 'editing', {
      joinedVideoPath: joinedPath,
      joinedVideoUrl: projectFileUrl(joinedPath),
      message: `Editing: adding ${steps.join(', ')}.`
    });

    const clips = prepared.clips;
    const result = await editVideo({ inputPath: joinedPath, outputPath, clips, plan });
    job.editingResult = { applied: result.applied, skipped: plan.skipped, captionLines: result.captions?.lines ?? 0 };

    updateJob(job.id, 'validating', { message: 'Validating the edited video.' });
    finalVideo = await validateFinalVideo(outputPath, expectedDuration);
  } else {
    job.editingResult = { applied: { logo: false, music: false, captions: false }, skipped: plan.skipped, captionLines: 0 };
  }

  // Generate & Publish continues into publishing; Generate Only ends here.
  const publishing = job.mode === PUBLISH_MODE;
  updateJob(job.id, publishing ? 'completed_generation' : 'completed', {
    finalVideoPath: outputPath,
    finalVideoUrl: projectFileUrl(outputPath),
    finalVideo,
    pacing: prepared.pacing,
    message: `Final video ready: ${finalVideo.duration}s, ${finalVideo.width}x${finalVideo.height}.`
  });
  logger.info(`Project ${job.id} ${publishing ? 'generation completed' : 'completed'}`, { finalVideoPath: outputPath });
}

// generateScene is injectable so the queue, retries and assembly can be tested without spending Flow credits.
export async function runProject(jobId, { generateScene = generateFlowScene, wait = sleep, now = Date.now } = {}) {
  const job = getJob(jobId);
  if (!job) {
    return;
  }

  const total = job.scenes.length;

  try {
    // Fail before spending any Flow credits if the clips could never be assembled.
    await requireFfmpeg();
    await ensureProjectFolders(job.id);
    await writeProjectMeta(job).catch((error) => logger.warn(`Project ${job.id}: could not write project.json`, { error: error.message }));
    updateJob(job.id, 'generating', { message: `Generating ${total} scene${total === 1 ? '' : 's'} one at a time.` });

    for (let index = 0; index < job.scenes.length; index += 1) {
      const scene = job.scenes[index];
      if (scene.status === 'completed') {
        try {
          await validateVideo(scene.videoPath || rawScenePath(job.id, scene.number));
          continue;
        } catch (error) {
          if (error.code !== 'VIDEO_INVALID') throw error;
          if (!await sceneCheckpoints.read(rawScenePath(job.id, scene.number))) {
            updateScene(job.id, scene.number, 'queued', { videoPath: null, clip: null, message: 'The old scene file and recovery checkpoint are unavailable. Regenerating this scene.' });
          }
        }
      }

      updateJob(job.id, 'generating', {
        currentScene: scene.number,
        message: `Generating scene ${scene.number} of ${total}.`
      });
      logger.info(`Project ${job.id}: scene ${scene.number}/${total} starting`);

      const result = await generateSceneWithRetries(job, scene, generateScene, wait, now);
      if (!result.ok) {
        const attemptsText = `${result.attempts} attempt${result.attempts === 1 ? '' : 's'}`;
        for (const later of job.scenes.slice(index + 1)) {
          updateScene(job.id, later.number, 'queued', { message: `Not started because scene ${scene.number} failed.` });
        }
        updateJob(job.id, 'failed', {
          failedScene: scene.number,
          error: `Scene ${scene.number}: ${result.error?.message || result.code}`,
          providerMessage: result.error?.providerMessage || null,
          errorCode: result.code,
          retryable: RETRYABLE_SCENE_CODES.has(result.code),
          message: `Scene ${scene.number} failed after ${attemptsText} (${result.code}): ${result.error?.message || 'unknown error'}`
        });
        return;
      }
    }

    logger.info(`Project ${job.id}: all ${total} scenes completed`);
    await finishFlowGeneration().catch(error => logger.warn('Could not close the completed Flow tab', { message: error.message }));
    await assembleProject(job);
  } catch (error) {
    logger.error(`Project ${job.id} failed`, { message: error.message, stack: error.stack });
    updateJob(job.id, 'failed', {
      error: error.message,
      errorCode: errorCodeOf(error),
      message: error.message
    });
  }
}

// Queue the whole project behind any running Flow work; scenes inside it always run sequentially.
// Publishing does not use the browser, so it runs after the project leaves the Flow lane.
export function submitProject(job, { publish = publishJob } = {}) {
  const ahead = flowLaneLength();
  if (ahead > 0) {
    updateJob(job.id, 'queued', {
      message: `Waiting for ${ahead} earlier job${ahead === 1 ? '' : 's'} to finish before starting.`
    });
  }

  return enqueueFlowWork(() => runProject(job.id)).then(async () => {
    const current = getJob(job.id);
    if (current?.mode === PUBLISH_MODE && current.status === 'completed_generation') {
      await publish(job.id).catch((error) => {
        logger.error(`Project ${job.id} publishing crashed`, { message: error.message, stack: error.stack });
        updateJob(job.id, 'publishing_failed', { error: error.message, errorCode: error.code || 'PUBLISHING_FAILED', message: error.message });
      });
    }
  });
}
