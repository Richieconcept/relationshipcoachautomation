import { getJob, updateJob } from '../src/jobs.js';
import { logger } from '../src/logger.js';
import { SUPPORTED_PLATFORMS } from './buffer.service.js';
import { cleanupProjectFiles } from './project-files.service.js';

const cleaning = new Map();
export function publicationConfirmed(job) {
  const platforms = SUPPORTED_PLATFORMS.filter(p => job?.publishing?.[p]?.enabled);
  return job?.type === 'project' && job.mode === 'generate_and_publish' && platforms.length > 0
    && platforms.every(p => job.publishingResults?.[p]?.postId && job.publishingResults[p].status === 'published');
}

// Only the project's media folder is removed. Brand assets, scripts, settings and post IDs stay.
export async function cleanupPublishedMedia(jobId, { removeFiles = cleanupProjectFiles } = {}) {
  if (cleaning.has(jobId)) return cleaning.get(jobId);
  const job = getJob(jobId);
  if (!publicationConfirmed(job) || job.localMediaDeletedAt) return job;
  const work = (async () => {
    try {
      await removeFiles(job.id);
      const scenes = job.scenes.map(scene => ({ ...scene, videoPath: null, normalizedPath: null, screenshotPath: null }));
      return updateJob(job.id, 'published', { scenes, finalVideoPath: null, finalVideoUrl: null,
        joinedVideoPath: null, joinedVideoUrl: null, localMediaDeletedAt: new Date().toISOString(),
        mediaCleanupError: null, error: null, errorCode: null,
        message: 'Published on every selected platform. Local video files cleared automatically.' });
    } catch (error) {
      logger.warn('Published video cleanup will be retried', { jobId, message: error.message });
      return updateJob(job.id, job.status, { mediaCleanupError: error.message,
        message: 'Published. Local video cleanup is pending and will be retried.' });
    }
  })();
  cleaning.set(jobId, work);
  try { return await work; } finally { cleaning.delete(jobId); }
}
