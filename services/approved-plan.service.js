import { parseScriptResponse, slotInfo } from './content-plan.service.js';

// Validate the complete batch before committing it. Importing never queues external work.
export function importApprovedPlan(scheduler, { records, sourceUrl = '' } = {}) {
  if (!Array.isArray(records) || !records.length || records.length > 28) {
    throw new Error('Provide 1 to 28 approved dated script records.');
  }
  if (typeof sourceUrl !== 'string' || sourceUrl.length > 2000) throw new Error('Invalid source URL.');
  if (sourceUrl) {
    const url = new URL(sourceUrl);
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password) throw new Error('Use a ChatGPT source URL.');
  }
  const seen = new Set();
  const validated = records.map(record => {
    const info = slotInfo(record?.date, record?.slot, scheduler.store.state.settings.slots);
    if (seen.has(info.id)) throw new Error('The plan contains a duplicate date and slot: ' + info.id);
    seen.add(info.id);
    const existing = scheduler.store.state.items[info.id];
    if(scheduler.store.state.drafts?.[info.id]&&scheduler.store.state.drafts[info.id].status!=='rescheduled')throw new Error('This slot has a planner draft. Edit and approve it in Drafts & review: '+info.id);
    if (scheduler.running.has(info.id) || existing?.jobId || scheduler.findJob(info.id)
      || ['queued', 'fetching_script', 'awaiting_verification', 'creating_job', 'producing', 'publishing', 'ready', 'published', 'publishing_failed', 'missed'].includes(existing?.status)) {
      throw new Error('Cannot replace a slot with active work or an existing video: ' + info.id);
    }
    if(existing?.publishAt)info.publishAt=existing.publishAt;
    if(existing?.plannerManaged)throw new Error('Edit and approve this AI planner script in Drafts & review: '+info.id);
    const parsed = parseScriptResponse(JSON.stringify(record), info);
    return { info, parsed, existing };
  });
  const now = new Date().toISOString();
  const store = scheduler.store;
  const previousState = store.state;
  const items = { ...previousState.items };
  for (const { info, parsed, existing } of validated) {
    items[info.id] = { ...existing, ...info, ...parsed, status: 'script_ready', error: null, rawResponse: null, requestState: null, humanVerificationRequired: false, productionMode: existing?.productionMode === 'preview' ? 'preview' : 'automatic',
      createdAt: existing?.createdAt || now, updatedAt: now,
      approval: { status: 'owner_approved_script', sourceUrl, importedAt: now } };
  }
  store.state = { ...previousState, items };
  try { store.save(); } catch (error) { store.state = previousState; throw error; }
  return validated.map(({ info }) => items[info.id]);
}
