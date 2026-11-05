import { generationFailureDetails } from './flow-result-status.service.js';
import { config } from '../src/config.js';
import {assertApprovedScript} from './script-approval.service.js';
import { canAutoResume, generationStartsAt, contentResultStatus } from './production-policy.service.js';
import { updateJob } from '../src/jobs.js';
import { submitProject } from './scene-queue.service.js';
import { buildPostMetadata } from './post-metadata.service.js';
import { ContentStore, SLOTS, slotInfo, lagosClock, nextDate, scriptRequest, parseScriptResponse } from './content-plan.service.js';
import { requestChatgptScript } from './chatgpt-browser.service.js';
import { createContentVideo, findContentJob, publishContentVideo } from './content-production.service.js';
import { getJob } from '../src/jobs.js';
import { logger } from '../src/logger.js';

export class ContentScheduler {
  constructor({ store = new ContentStore(), requestScript = requestChatgptScript, createVideo = createContentVideo,
    findJob = findContentJob, jobById = getJob, publishVideo = publishContentVideo, resumeVideo = async job => { updateJob(job.id, 'queued', { error: null, errorCode: null, failedScene: null, message: 'Automatically recovering saved scenes.' }); await submitProject(job); return getJob(job.id); } } = {}) {
    Object.assign(this, { store, requestScript, createVideo, findJob, jobById, publishVideo, resumeVideo });
    this.running = new Set(); this.queue = Promise.resolve(); this.ticking = false; this.lastTickAt = null;
  }
  snapshot() {
    const items = Object.values(this.store.state.items).sort((a, b) => b.publishAt.localeCompare(a.publishAt));
    return { scheduler: { lastTickAt: this.lastTickAt, intervalSeconds: 5 }, settings: this.store.state.settings, timezone: 'Africa/Lagos', slots: this.store.state.settings.slots || SLOTS,
      items: items.map(item => ({ ...item, generationStartsAt: generationStartsAt(item, this.store.state.settings), ...(!item.jobId && item.script ? buildPostMetadata(item.script) : {}), job: item.jobId ? this.jobSummary(this.jobById(item.jobId)) : null })) };
  }
  jobSummary(job) { return job ? { id: job.id, status: job.status, message: job.message, errorCode: job.errorCode || null, failure: job.status === 'failed' ? generationFailureDetails(job.errorCode, job.providerMessage) : null, currentScene: job.currentScene, totalScenes: job.scenes?.length || 0, completedScenes: job.completedScenes || 0, scenes: (job.scenes || []).map(scene => ({ number: scene.number, status: scene.status, attempts: scene.attempts, retryAt: scene.retryAt || null, message: scene.message })), pacing: job.pacing || null, videoUrl: job.finalVideoUrl, canResume: ['failed', 'interrupted'].includes(job.status) } : null; }
  startVideo(date, slot) {
    const info = slotInfo(date, slot, this.store.state.settings.slots);

    const item = this.store.ensure(date, slot);
    assertApprovedScript(item);
    const existing = (item.jobId && this.jobById(item.jobId)) || this.findJob(item.id);
    if (item.jobId && !existing) throw new Error('This slot has a saved video job that is unavailable. Review it before starting another generation.');
    if (existing) {
      this.store.update(item.id, { jobId: existing.id });
      return { item, reused: true };
    }
    if (this.running.has(info.id)) return { item, reused: true };
    if (this.store.state.settings.scriptSource === 'manual') {
      if (!item.script) throw new Error('Add a spoken script for this date and slot in Weekly Scripts first.');
      this.prepare(date, [slot], { retry: true, generateOnly: !this.store.state.settings.autoPublish, scheduled: false });
      return { item, reused: false };
    }
    if (['sending', 'sent'].includes(item.requestState) && !item.rawResponse) {
      throw new Error('The previous ChatGPT request may still be unfinished. Inspect its conversation before starting another request.');
    }
    this.prepare(date, [slot], { retry: true, freshScript: true, generateOnly: true });
    return { item, reused: false };
  }
  prepare(date, slots = Object.keys(this.store.state.settings.slots || SLOTS), { retry = false, scriptOnly = false, freshScript = false, generateOnly = false, scheduled = true } = {}) {
    const manual = this.store.state.settings.scriptSource === 'manual';
    if (manual && !this.store.state.settings.autoPublish) generateOnly = true;
    if (!manual && !this.store.state.settings.projectUrl) throw new Error('Set your ChatGPT Project URL first.');
    if (!Array.isArray(slots) || !slots.length || slots.some(slot => !Object.hasOwn(SLOTS, slot))) throw new Error('Choose valid content slots.');
    if (manual && slots.some(slot => !this.store.state.items[slotInfo(date, slot, this.store.state.settings.slots).id]?.script)) throw new Error('Add scripts for the selected slots before starting videos.');
    if (manual && freshScript) throw new Error('Manual scripts cannot be replaced by a ChatGPT request.');
    const items = slots.map(slot => this.store.ensure(date, slot));
    for (const item of items) assertApprovedScript(item);
    for (const item of items) {
      if (this.running.has(item.id) || item.jobId || ['ready', 'published', 'publishing', 'publishing_failed', 'missed'].includes(item.status)) continue;
      if (!['planned', 'script_ready'].includes(item.status) && !retry) continue;
      if (item.productionMode === 'preview' && !retry) continue;
      // An explicit retry must re-query a completed negative answer after the plan is fixed.
      // Keep ambiguous or malformed responses for review instead of silently resubmitting them.
      if (retry && item.rawResponse?.trim() === 'CONTENT_NOT_PLANNED') {
        this.store.update(item.id, { rawResponse: null, requestState: null });
      }
      this.running.add(item.id);
      this.store.update(item.id, { status: 'queued', error: null, productionMode: scriptOnly ? 'preview' : 'automatic', scheduledRun: scheduled });
      this.queue = this.queue.then(() => this.run(item, scriptOnly, { freshScript, generateOnly, scheduled })).catch(error => {
        this.store.update(item.id, { status: 'needs_review', error: error.message });
      }).finally(() => this.running.delete(item.id));
    }
    return items;
  }
  async run(item, scriptOnly, { freshScript = false, generateOnly = false, scheduled = false } = {}) {
    try {
      const settings = { ...this.store.state.settings, platforms: [...this.store.state.settings.platforms] };
      settings.productionDeadline = scheduled ? item.publishAt : null;
      if (generateOnly) { settings.autoPublish = false; settings.platforms = []; }
      const existing = this.findJob(item.id);
      if (existing) { this.store.update(item.id, { jobId: existing.id, status: 'producing' }); return; }
      if (freshScript) {
        const previousApprovedScript = item.script ? {
          title: item.title, script: item.script, caption: item.caption, hashtags: item.hashtags,
          savedAt: item.updatedAt || item.createdAt
        } : item.previousApprovedScript;
        this.store.update(item.id, { previousApprovedScript, script: null, rawResponse: null, requestState: null,
          caption: null, hashtags: [], postMetadata: null });
      }
      if (!item.script && settings.scriptSource === 'manual') throw new Error('No saved script for this slot. Add it in Weekly Scripts.');
      if (!item.script) {
        const sourceUrl = settings.planningConversationUrl || settings.projectUrl;
        const fromConversation = new URL(sourceUrl).pathname.split('/')[3] === 'c';
        const prompt = scriptRequest(item, { fromConversation });
        this.store.update(item.id, { status: 'fetching_script', prompt, projectUrl: sourceUrl, retrievalSource: fromConversation ? 'planning_conversation' : 'project_sources' });
        const raw = item.rawResponse || await this.requestScript({ projectUrl: sourceUrl, prompt,
          checkpoint: patch => this.store.update(item.id, { ...patch,
            ...(typeof patch.humanVerificationRequired === 'boolean'
              ? { status: patch.humanVerificationRequired ? 'awaiting_verification' : 'fetching_script', error: null } : {}) }) });
        this.store.update(item.id, { rawResponse: raw });
        this.store.update(item.id, { ...parseScriptResponse(raw, item), status: 'script_ready' });
      }
      assertApprovedScript(item);
      if (scriptOnly) { this.store.update(item.id, { status: 'script_ready' }); return; }
      this.store.update(item.id, { status: 'creating_job', autoPublish: settings.autoPublish, platforms: settings.platforms, postWhenReady: !scheduled && settings.autoPublish });
      const job = await this.createVideo(item, settings, jobId => this.store.update(item.id, { jobId, status: 'producing' }));
      this.store.update(item.id, { jobId: job.id, status: contentResultStatus(job), error: job.status === 'completed' ? null : job.message });
      if(job.status==='completed' && item.postWhenReady && settings.autoPublish)await this.postReadyItem(item);
    } catch (error) {
      this.store.update(item.id, { status: error.code === 'CONTENT_NOT_PLANNED' ? 'content_not_planned' : 'needs_review', error: error.message });
    }
  }
  async postReadyItem(item){
    if(item.status!=='ready'||!item.autoPublish||!this.store.state.settings.autoPublish)return;
    this.store.update(item.id,{status:'publishing'});
    try{const result=await this.publishVideo(item);this.store.update(item.id,{status:result?.status==='published'?'published':'publishing_failed',error:result?.error||null});}
    catch(error){this.store.update(item.id,{status:'publishing_failed',error:error.message});}
  }
  queueRecovery(item, job, now) {
    if (this.running.has(item.id) || !canAutoResume(job, now.getTime()) || (!config.retrySceneUntilSuccess && (item.recoveryAttempts || 0) >= 3)) return;
    if (!item.nextRetryAt) {
      this.store.update(item.id, { status: 'retry_wait', nextRetryAt: new Date(now.getTime() + 10000).toISOString(), error: null });
      return;
    }
    if (Date.parse(item.nextRetryAt) > now.getTime()) return;
    this.running.add(item.id);
    this.store.update(item.id, { status: 'producing', nextRetryAt: null, recoveryAttempts: (item.recoveryAttempts || 0) + 1 });
    this.queue = this.queue.then(async () => {
      const result = await this.resumeVideo(job);
      this.store.update(item.id, { status: contentResultStatus(result), error: result.status === 'completed' ? null : result.message });
    }).catch(error => this.store.update(item.id, { status: 'needs_review', error: error.message })).finally(() => this.running.delete(item.id));
  }
  async tick(now = new Date()) {
    if (this.ticking) return;
    this.ticking = true; this.lastTickAt = now.toISOString();
    try {
      const settings = this.store.state.settings;
      const clock = lagosClock(now);
      const tomorrow = nextDate(clock.date);
      for (const item of Object.values(this.store.state.items)) {
        const job = item.jobId ? this.jobById(item.jobId) : this.findJob(item.id);
        if (job && !item.jobId) this.store.update(item.id, { jobId: job.id, status: 'producing' });
        if (job && ['producing', 'needs_review', 'retry_wait'].includes(item.status)) {
          if (job.status === 'completed') this.store.update(item.id, { status: 'ready', error: null });
          else if (job.status === 'published') this.store.update(item.id, { status: 'published', error: null });
          else if (['publishing_failed', 'partially_published'].includes(job.status)) this.store.update(item.id, { status: 'publishing_failed', error: job.message });
          else if (['failed', 'interrupted'].includes(job.status)) this.store.update(item.id, { status: contentResultStatus(job), error: job.message });
        }
        if (job?.productionDeadline && Date.parse(job.productionDeadline)<=now.getTime() && ['failed','interrupted'].includes(job.status)) { this.store.update(item.id,{status:'skipped',nextRetryAt:null,error:'This content slot has passed. Remaining generation is skipped; later videos continue.'}); continue; }
        if (settings.enabled && item.productionMode !== 'preview' && ['needs_review','producing','retry_wait'].includes(item.status) && canAutoResume(job, now.getTime())) this.queueRecovery(item, job, now);
        // A saved approved script is already past retrieval: hand it to production on
        // the next tick, without waiting for the daily retrieval hour or another click.
        // Limit automatic work to today/tomorrow and retain explicit preview holds.
        if (settings.enabled && settings.scriptSource === 'manual' && item.status === 'script_ready' && Date.parse(item.publishAt) <= now.getTime()) this.store.update(item.id, {status:'skipped',error:'This content slot has passed. Automatic generation was skipped; later slots continue. You can still create it manually.'});
        if (settings.enabled && item.status === 'script_ready' && item.script
          && item.productionMode !== 'preview' && (settings.scriptSource === 'manual' ? Date.parse(generationStartsAt(item, settings)) <= now.getTime() : [clock.date, tomorrow].includes(item.date))
          && Date.parse(item.publishAt) > now.getTime()) {
          this.prepare(item.date, [item.slot], { generateOnly: !settings.autoPublish, scheduled: true });
        }
        if (!settings.autoPublish || !item.autoPublish || item.status !== 'ready' || (!settings.enabled && !item.postWhenReady)) continue;
        if(item.postWhenReady){await this.postReadyItem(item);continue;}
        const late = now.getTime() - Date.parse(item.publishAt);
        if (late < 0) continue;
        // Do not dump missed posts into the feed after a long outage.
        if (late > 15 * 60000) { this.store.update(item.id, { status: 'missed', error: 'Posting window missed. Video retained for manual review.' }); continue; }
        this.store.update(item.id, { status: 'publishing' });
        try {
          const result = await this.publishVideo(item);
          this.store.update(item.id, { status: result?.status === 'published' ? 'published' : 'publishing_failed', error: result?.error || null });
        } catch (error) { this.store.update(item.id, { status: 'publishing_failed', error: error.message }); }
      }
      if (settings.enabled && settings.scriptSource !== 'manual' && clock.hour >= settings.prepareHour) this.prepare(nextDate(clock.date));
    } finally { this.ticking = false; }
  }
  start() {
    if (this.timer) return;
    const run = () => this.tick().catch(error => logger.error('Content scheduler error', { message: error.message }));
    this.timer = setInterval(run, 5000); this.timer.unref(); run();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}
