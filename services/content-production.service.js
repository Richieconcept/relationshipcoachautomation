import {assertApprovedScript} from './script-approval.service.js';
import { buildPostMetadata } from './post-metadata.service.js';
import { getAvailableAccountId } from '../src/accounts.js';
import { config } from '../src/config.js';
import { createProjectJob, getJob, listJobs, updateJob } from '../src/jobs.js';
import { checkFfmpeg } from './ffmpeg.service.js';
import { resolveGlobalInstructions } from './brand-defaults.service.js';
import { brandAssetPath } from './brand.service.js';
import { splitScript, sceneSpeechPrompt } from './script-splitter.service.js';
import { submitProject } from './scene-queue.service.js';
import { initialPublishingResults, parsePublishing, preflightPublishing, publishJob, PUBLISH_MODE } from './publishing.service.js';

export function contentPublishing(item, platforms) {
  const metadata = buildPostMetadata(item.script);
  if (!metadata) throw new Error('Script needs a spoken opening hook before publishing.');
  const data = {};
  for (const platform of ['facebook', 'tiktok', 'youtube']) data[platform] = {
    enabled: platforms.includes(platform), caption: metadata.caption, description: metadata.caption,
    title: item.title, hashtags: metadata.hashtags
  };
  const parsed = parsePublishing(data, { mode: PUBLISH_MODE });
  if (parsed.errors.length) throw new Error(parsed.errors.join(' '));
  return parsed.publishing;
}
export function findContentJob(id) { return listJobs().find(job => job.contentSlotId === id) || null; }
export async function createContentVideo(item, settings, onCreated) {
  assertApprovedScript(item);
  const existing = findContentJob(item.id);
  if (existing) { onCreated(existing.id); return existing; }
  const ffmpeg = await checkFfmpeg();
  if (!ffmpeg.available) throw new Error(ffmpeg.error || 'FFmpeg is unavailable.');
  if (!getAvailableAccountId()) throw new Error('No available Flow account.');
  if (settings.autoPublish) await preflightPublishing(contentPublishing(item, settings.platforms));
  const split = splitScript(item.script);
  const job = createProjectJob({
    productionDeadline: settings.productionDeadline || null,
    contentSlotId: item.id, postMetadata: buildPostMetadata(item.script), title: item.title, script: item.script, source: 'script', mode: 'generate_only',
    aspectRatio: config.defaultAspectRatio, model: config.defaultModel,
    globalInstructions: await resolveGlobalInstructions(), referenceImage: brandAssetPath('presenter'),
    editing: { logo: true, music: false, captions: true },
    scenes: split.scenes.map(scene => ({ prompt: sceneSpeechPrompt(scene.text), spokenText: scene.text, duration: scene.duration }))
  });
  // Job already contains contentSlotId on disk, allowing recovery if the content checkpoint write fails.
  onCreated(job.id);
  await submitProject(job);
  return getJob(job.id);
}
export async function publishContentVideo(item) {
  const job = getJob(item.jobId);
  if (!job || !['completed','publishing_failed','partially_published'].includes(job.status) || !job.finalVideoPath) throw new Error('Video is not ready for publishing.');
  const publishing = contentPublishing(item, item.platforms);
  await preflightPublishing(publishing);
  updateJob(job.id, job.status, { mode: PUBLISH_MODE, postMetadata: buildPostMetadata(item.script), publishing, publishingResults: job.publishingResults || initialPublishingResults(publishing), bufferPostMode: 'shareNow' });
  return publishJob(job.id);
}
