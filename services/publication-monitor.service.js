import { listJobs } from '../src/jobs.js';
import { refreshPublishingStatus } from './publishing.service.js';
import { logger } from '../src/logger.js';

// Runs while the server is awake, independently of automatic script scheduling.
// Restarts resume read-only confirmation for persisted posts; no duplicate submissions.
export function startPublicationMonitor({ jobs = listJobs, refresh = refreshPublishingStatus, intervalMs = 60000 } = {}) {
  let busy = false;
  let stopped = false;
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const job of jobs()) {
        if (stopped) break;
        if (job.mode !== 'generate_and_publish' || job.localMediaDeletedAt
          || !['published', 'partially_published', 'publishing_failed', 'interrupted'].includes(job.status)
          || !Object.values(job.publishingResults || {}).some(result => result.postId)) continue;
        try { await refresh(job.id); }
        catch (error) { logger.warn('Publication monitor will retry', { jobId: job.id, message: error.message }); }
      }
    } finally { busy = false; }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  void run();
  return () => { stopped = true; clearInterval(timer); };
}
