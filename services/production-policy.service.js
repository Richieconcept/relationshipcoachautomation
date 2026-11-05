export const RETRYABLE_SCENE_CODES = new Set(['SCENE_RESULT_MISSING','NETWORK_ERROR','BROWSER_CLOSED','GENERATION_FAILED','GENERATION_TIMEOUT','REFERENCE_UPLOAD_FAILED','DOWNLOAD_FAILED','VIDEO_INVALID']);
export function canAutoRetry(code) { return RETRYABLE_SCENE_CODES.has(code) || ['FFMPEG_TIMEOUT','FFMPEG_FAILED','PERSISTENCE_BUSY'].includes(code); }
export function generationStartsAt(item, settings) {
 return new Date(Date.parse(item.publishAt) - (settings.generationLeadMinutes ?? 120) * 60000).toISOString();
}
export function canAutoResume(job, now=Date.now()) {
 if (job?.productionDeadline && productionWindowError(job.productionDeadline, now)) return false;
 if (!job || job.mode !== 'generate_only' || job.finalVideoPath || Object.values(job.publishingResults || {}).some(result=>result.postId)) return false;
 if (job.status === 'failed') return canAutoRetry(job.errorCode) || (['FLOW_RECOVERY_REQUIRED','UNKNOWN_ERROR'].includes(job.errorCode) && /The saved scene could not be found in its original Flow project\.|More than one new Flow video matches this scene\.|The candidate video has a different prompt\. No new generation was submitted\./.test(job.message || job.error || ''));
 return job.status === 'interrupted' && ['queued','generating','validating','normalizing','assembling','editing'].includes(job.interruptedStatus) && job.errorCode !== 'OPERATOR_STOPPED';
}

export function productionWindowError(deadline, now=Date.now()) {
 if(!deadline||!Number.isFinite(Date.parse(deadline))||now<Date.parse(deadline))return null;
 return Object.assign(new Error('This content slot has passed before the video could finish. Remaining generation is skipped; later scheduled videos can continue.'),{code:'PRODUCTION_WINDOW_MISSED',automationCode:'PRODUCTION_WINDOW_MISSED'});
}

export function contentResultStatus(job){if(job.status==='completed')return 'ready';if(job.errorCode==='GENERATION_REJECTED')return 'policy_blocked';if(job.errorCode==='PRODUCTION_WINDOW_MISSED')return 'skipped';return 'needs_review';}
