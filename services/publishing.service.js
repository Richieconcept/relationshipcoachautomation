import { applyScriptPostMetadata, buildPostMetadata, spokenScript } from './post-metadata.service.js';
import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { getJob, updateJob } from '../src/jobs.js';
import { logger } from '../src/logger.js';
import { PublishingError } from '../src/publishing-error.js';
import {
  assertBufferConfigured,
  channelIdFor,
  createVideoPost,
  getVideoPost,
  SUPPORTED_PLATFORMS,
  verifyChannels
} from './buffer.service.js';
import { cleanupPublishedMedia } from './published-media.service.js';
import { assertCloudinaryConfigured, uploadVideo } from './cloudinary.service.js';

export const PUBLISH_MODE = 'generate_and_publish';
export const GENERATE_ONLY_MODE = 'generate_only';

// Character limits as Buffer counts them (UTF-16 code units). See developers.buffer.com/guides/character-limits
const LIMITS = {
  facebookText: 5000,
  tiktokText: 2200, // TikTok with a video attached
  youtubeTitle: 100,
  youtubeDescription: 5000
};

const PLATFORM_LABEL = { facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube' };
const SUCCESS_STATUSES = ['queued', 'scheduled', 'published', 'publishing', 'draft', 'pending'];

// "#Business #Nigeria, Technology" -> ["#Business", "#Nigeria", "#Technology"] (deduplicated, order kept)
export function normalizeHashtags(input) {
  const parts = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const seen = new Set();
  const tags = [];

  for (const part of parts) {
    const word = String(part || '').trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (!word || seen.has(word.toLowerCase())) {
      continue;
    }
    seen.add(word.toLowerCase());
    tags.push(`#${word}`);
  }

  return tags;
}

// Caption and hashtags are stored separately and only joined here, at posting time.
export function buildPostText(body, hashtags = []) {
  const text = String(body || '').trim();
  const tags = hashtags.join(' ');
  return [text, tags].filter(Boolean).join('\n\n');
}

function isEnabled(value) {
  return value === true || ['true', 'on', '1', 'yes'].includes(String(value).toLowerCase());
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize and validate the publishing block from a request.
 * Returns { publishing, errors } where errors is a list of readable messages.
 */
export function parsePublishing(raw, { mode }) {
  let source = raw;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source || '{}');
    } catch {
      return { publishing: null, errors: ['publishing must be a JSON object.'] };
    }
  }
  source = source || {};

  const publishing = {
    facebook: {
      enabled: isEnabled(source.facebook?.enabled),
      caption: text(source.facebook?.caption),
      hashtags: normalizeHashtags(source.facebook?.hashtags)
    },
    tiktok: {
      enabled: isEnabled(source.tiktok?.enabled),
      caption: text(source.tiktok?.caption),
      hashtags: normalizeHashtags(source.tiktok?.hashtags)
    },
    youtube: {
      enabled: isEnabled(source.youtube?.enabled),
      title: text(source.youtube?.title),
      description: text(source.youtube?.description),
      hashtags: normalizeHashtags(source.youtube?.hashtags)
    }
  };

  if (mode !== PUBLISH_MODE) {
    return { publishing, errors: [] };
  }

  const errors = [];
  const enabled = enabledPlatforms(publishing);
  if (enabled.length === 0) {
    errors.push('Enable at least one platform (Facebook, TikTok or YouTube) to publish.');
  }

  const { facebook, tiktok, youtube } = publishing;
  if (facebook.enabled) {
    if (!facebook.caption) {
      errors.push('Facebook: caption is required.');
    }
    const length = buildPostText(facebook.caption, facebook.hashtags).length;
    if (length > LIMITS.facebookText) {
      errors.push(`Facebook: caption plus hashtags is ${length} characters; the limit is ${LIMITS.facebookText}.`);
    }
  }

  if (tiktok.enabled) {
    if (!tiktok.caption) {
      errors.push('TikTok: caption is required.');
    }
    const length = buildPostText(tiktok.caption, tiktok.hashtags).length;
    if (length > LIMITS.tiktokText) {
      errors.push(`TikTok: caption plus hashtags is ${length} characters; the limit for video posts is ${LIMITS.tiktokText}.`);
    }
  }

  if (youtube.enabled) {
    if (!youtube.title) {
      errors.push('YouTube: title is required.');
    } else if (youtube.title.length > LIMITS.youtubeTitle) {
      errors.push(`YouTube: title is ${youtube.title.length} characters; the limit is ${LIMITS.youtubeTitle}.`);
    }
    // YouTube rejects angle brackets in titles and descriptions.
    if (/[<>]/.test(youtube.title) || /[<>]/.test(youtube.description)) {
      errors.push('YouTube: title and description cannot contain < or >.');
    }
    const length = buildPostText(youtube.description, youtube.hashtags).length;
    if (length > LIMITS.youtubeDescription) {
      errors.push(`YouTube: description plus hashtags is ${length} characters; the limit is ${LIMITS.youtubeDescription}.`);
    }
  }

  return { publishing, errors };
}

export function enabledPlatforms(publishing) {
  return SUPPORTED_PLATFORMS.filter((platform) => publishing?.[platform]?.enabled);
}

export function initialPublishingResults(publishing) {
  return Object.fromEntries(SUPPORTED_PLATFORMS.map((platform) => [
    platform,
    publishing?.[platform]?.enabled
      ? { status: 'pending', message: 'Waiting for the final video.' }
      : { status: 'disabled' }
  ]));
}

/**
 * Checks done when a Generate & Publish request arrives, before Flow credits are spent:
 * Cloudinary and Buffer credentials exist, and each enabled platform has a valid, connected channel.
 */
export async function preflightPublishing(publishing) {
  assertCloudinaryConfigured();
  assertBufferConfigured();
  return verifyChannels(enabledPlatforms(publishing));
}

function resolveFacebookType(job) {
  const configured = config.buffer.facebookPostType;
  if (['reel', 'post', 'story'].includes(configured)) {
    return configured;
  }
  // Facebook Reels must be vertical and at most 90 seconds; anything else goes out as a normal video post.
  const duration = job.finalVideo?.duration ?? 0;
  return job.aspectRatio === '9:16' && duration > 0 && duration <= 90 ? 'reel' : 'post';
}

// The platform-specific part of each Buffer post. Everything else is shared in createVideoPost.
function buildPlatformPost(platform, job) {
  const settings = job.publishing[platform];
  const disclose = config.buffer.discloseAiGenerated;

  if (platform === 'facebook') {
    return {
      text: buildPostText(settings.caption, settings.hashtags),
      metadata: { type: resolveFacebookType(job) }
    };
  }

  if (platform === 'tiktok') {
    // TikTok's title field only applies to photo posts, so the caption carries everything for video.
    return {
      text: buildPostText(settings.caption, settings.hashtags),
      metadata: disclose ? { isAiGenerated: true } : {}
    };
  }

  // YouTube: Buffer takes the title separately; the post text becomes the video description.
  return {
    text: buildPostText(settings.description, settings.hashtags),
    metadata: {
      title: settings.title,
      categoryId: config.buffer.youtubeCategoryId,
      privacy: config.buffer.youtubePrivacy,
      madeForKids: config.buffer.youtubeMadeForKids,
      ...(disclose ? { isAiGenerated: true } : {})
    }
  };
}

function setPlatformResult(job, platform, result) {
  job.publishingResults = { ...job.publishingResults, [platform]: result };
  job.updatedAt = new Date().toISOString();
}

/**
 * Upload the final video to Cloudinary (once) and post it to every enabled platform that has not
 * already succeeded. Each platform is independent: one failure never undoes another's success,
 * and the Cloudinary URL is kept whatever happens.
 *
 * Services are injectable so the flow can be tested without real credentials.
 */
export async function publishJob(jobId, { upload = uploadVideo, createPost = createVideoPost } = {}) {
  const job = getJob(jobId);
  if (!job) {
    return null;
  }

  if (job.localMediaDeletedAt) return job;

  const script = spokenScript(job);
  const postMetadata = buildPostMetadata(script);
  if (postMetadata) {
    const derived = applyScriptPostMetadata(job.publishing, script, { title: job.title });
    // Accepted posts are immutable; retries only refresh platforms still waiting to be sent.
    for (const platform of SUPPORTED_PLATFORMS) {
      const previous = job.publishingResults?.[platform];
      if (previous?.postId && SUCCESS_STATUSES.includes(previous.status)) derived[platform] = job.publishing[platform];
    }
    const { publishing, errors } = parsePublishing(derived, { mode: PUBLISH_MODE });
    if (errors.length) {
      return updateJob(job.id, 'publishing_failed', { error: errors.join(' '), errorCode: 'PUBLISHING_VALIDATION_FAILED' });
    }
    updateJob(job.id, job.status, { publishing, postMetadata });
  }
  const platforms = enabledPlatforms(job.publishing);
  const label = `Project ${job.id}`;

  try {
    if (!job.cloudinary?.secureUrl) {
      const stat = job.finalVideoPath ? await fs.stat(job.finalVideoPath).catch(() => null) : null;
      if (!stat?.isFile()) {
        throw new PublishingError('CLOUDINARY_UPLOAD_FAILED', 'The final video file is missing, so it cannot be uploaded.');
      }
      updateJob(job.id, 'uploading_to_cloudinary', { message: 'Uploading the final video to Cloudinary.' });
      const result = await upload(job.finalVideoPath, { publicId: job.id });
      updateJob(job.id, 'uploading_to_cloudinary', {
        cloudinary: { publicId: result.publicId, secureUrl: result.secureUrl, uploadedAt: new Date().toISOString() }
      });
    } else {
      logger.info(`${label}: reusing existing Cloudinary upload`, { publicId: job.cloudinary.publicId });
    }

    updateJob(job.id, 'ready_to_publish', { message: 'Video uploaded. Sending posts to Buffer.' });
  } catch (error) {
    const code = error.code || 'CLOUDINARY_UPLOAD_FAILED';
    logger.error(`${label}: Cloudinary upload failed`, { code, message: error.message });
    for (const platform of platforms) {
      if (!SUCCESS_STATUSES.includes(job.publishingResults?.[platform]?.status)) {
        setPlatformResult(job, platform, { status: 'pending', message: 'Not sent: the video could not be uploaded to Cloudinary.' });
      }
    }
    updateJob(job.id, 'publishing_failed', {
      error: error.message,
      errorCode: code,
      message: `Video generated, but the Cloudinary upload failed: ${error.message}`
    });
    return getJob(job.id);
  }

  updateJob(job.id, 'publishing', { message: `Publishing to ${platforms.map((p) => PLATFORM_LABEL[p]).join(', ')}.` });

  for (const platform of platforms) {
    const previous = job.publishingResults?.[platform];
    if (previous && SUCCESS_STATUSES.includes(previous.status) && previous.postId) {
      continue; // Already accepted by Buffer on an earlier run; never post twice.
    }

    setPlatformResult(job, platform, { status: 'publishing', message: 'Sending to Buffer.' });
    try {
      const post = buildPlatformPost(platform, job);
      const result = await createPost({
        channelId: channelIdFor(platform),
        videoUrl: job.cloudinary.secureUrl,
        text: post.text,
        platform,
        postMode: job.bufferPostMode,
        platformOptions: { metadata: post.metadata }
      });
      setPlatformResult(job, platform, {
        status: result.status,
        postId: result.postId,
        bufferStatus: result.bufferStatus,
        dueAt: result.dueAt,
        externalLink: result.externalLink,
        message: platformSuccessMessage(result)
      });
      updateJob(job.id, 'publishing', { publishingResults: job.publishingResults });
      logger.info(`${label}: ${PLATFORM_LABEL[platform]} ${result.status}`, { postId: result.postId });
    } catch (error) {
      const errorCode = `${platform.toUpperCase()}_POST_FAILED`;
      setPlatformResult(job, platform, {
        status: 'failed',
        errorCode,
        cause: error.code || 'BUFFER_POST_FAILED',
        error: error.message,
        message: error.message
      });
      logger.error(`${label}: ${PLATFORM_LABEL[platform]} post failed`, { errorCode, cause: error.code, message: error.message });
    }
  }

  const results = platforms.map((platform) => job.publishingResults[platform]);
  const succeeded = results.filter((result) => SUCCESS_STATUSES.includes(result.status)).length;
  const failedPlatforms = platforms.filter((platform) => job.publishingResults[platform].status === 'failed');

  if (failedPlatforms.length === 0) {
    updateJob(job.id, 'published', {
      error: null,
      errorCode: null,
      message: `Sent to Buffer for ${platforms.map((p) => PLATFORM_LABEL[p]).join(', ')}.`
    });
  } else if (succeeded > 0) {
    updateJob(job.id, 'partially_published', {
      errorCode: 'PUBLISHING_PARTIAL_FAILURE',
      error: `${failedPlatforms.map((p) => PLATFORM_LABEL[p]).join(', ')} failed; the other platforms were sent.`,
      message: `Partially published: ${failedPlatforms.map((p) => PLATFORM_LABEL[p]).join(', ')} failed.`
    });
  } else {
    updateJob(job.id, 'publishing_failed', {
      errorCode: job.publishingResults[failedPlatforms[0]].cause || 'BUFFER_POST_FAILED',
      error: 'No platform accepted the post. The video is still available on Cloudinary.',
      message: 'Publishing failed for every platform. The video is still available on Cloudinary.'
    });
  }

  await cleanupPublishedMedia(job.id);
  return getJob(job.id);
}

function platformSuccessMessage(result) {
  switch (result.status) {
    case 'queued':
      return result.dueAt ? `Queued in Buffer for ${result.dueAt}.` : 'Queued in Buffer.';
    case 'scheduled':
      return result.dueAt ? `Scheduled for ${result.dueAt}.` : 'Scheduled in Buffer.';
    case 'published':
      return 'Published.';
    case 'publishing':
      return 'Buffer is publishing now.';
    case 'draft':
      return 'Saved as a draft in Buffer (BUFFER_POST_MODE=draft).';
    case 'pending':
      return 'Waiting for approval in Buffer.';
    default:
      return `Buffer status: ${result.bufferStatus}.`;
  }
}

// Retry only the platforms that failed (or never ran), reusing the existing Cloudinary upload.
export function canRetryPublishing(job) {
  return job?.mode === PUBLISH_MODE
    && ['publishing_failed', 'partially_published'].includes(job.status)
    && Boolean(job.finalVideoPath || job.cloudinary?.secureUrl);
}

// Updates existing posts only; this never submits a new post or spends generation credits.
export async function refreshPublishingStatus(jobId, { getPost = getVideoPost, cleanup = cleanupPublishedMedia } = {}) {
  const job = getJob(jobId);
  if (!job || job.mode !== PUBLISH_MODE || job.localMediaDeletedAt) return job;
  let changed = false;
  for (const platform of enabledPlatforms(job.publishing)) {
    const previous = job.publishingResults?.[platform];
    if (!previous?.postId || ['published', 'failed'].includes(previous.status)) continue;
    try {
      const result = await getPost(previous.postId, { postMode: job.bufferPostMode });
      setPlatformResult(job, platform, { ...previous, ...result,
        ...(result.status === 'failed' ? { error: 'Buffer reported that this post failed. Check the post in Buffer.', errorCode: platform.toUpperCase() + '_POST_FAILED' } : {}),
        message: result.status === 'failed' ? 'Buffer could not publish this post.' : platformSuccessMessage(result) });
      changed = true;
    } catch (error) {
      // Unknown status must retain the media; a network/authorization error is not a failed post.
      logger.warn('Buffer publication confirmation unavailable', { jobId, platform, message: error.message });
    }
  }
  if (changed) {
    const platforms = enabledPlatforms(job.publishing);
    const failed = platforms.filter(p => job.publishingResults?.[p]?.status === 'failed');
    const allPublished = platforms.length > 0 && platforms.every(p => job.publishingResults?.[p]?.status === 'published');
    const status = allPublished ? 'published' : failed.length === platforms.length ? 'publishing_failed'
      : failed.length ? 'partially_published' : job.status;
    updateJob(job.id, status, {
      publishingResults: job.publishingResults,
      ...(failed.length ? { errorCode: 'PUBLISHING_PARTIAL_FAILURE', error: 'Publishing needs attention in Buffer. Local video kept for recovery.' } : {}),
      ...(allPublished ? { error: null, errorCode: null, message: 'Published on every selected platform.' } : {})
    });
  }
  await cleanup(job.id);
  return getJob(job.id);
}
