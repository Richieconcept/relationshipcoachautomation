import { writeAtomicJson } from '../src/atomic-json.js';
import { buildPostMetadata } from './post-metadata.service.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

export const SLOTS = { morning: '06:00', afternoon: '12:00', late_afternoon: '16:00', evening: '20:00' };
export const SLOT_LABELS={morning:'Morning',afternoon:'Noon',late_afternoon:'Late afternoon',evening:'Evening'};
export const TIMEZONE = 'Africa/Lagos';
export function validateDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Use a valid date in YYYY-MM-DD format.');
  return date;
}
export function slotInfo(date, slot, slots = SLOTS) {
  validateDate(date);
  if (!Object.hasOwn(slots, slot)) throw new Error('Choose a configured content slot.');
  return { id: `${date}-${slot}`, date, slot, publishAt: new Date(`${date}T${slots[slot]}:00+01:00`).toISOString() };
}
export function lagosClock(now = new Date()) {
  const local = new Date(now.getTime() + 3600000);
  return { date: local.toISOString().slice(0, 10), hour: local.getUTCHours(), minute: local.getUTCMinutes() };
}
export function nextDate(date) { return new Date(Date.parse(`${validateDate(date)}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); }
export function validateProjectUrl(value) {
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port || url.username || url.password
    || !/^\/g\/g-[a-zA-Z0-9-]+\/(?:project|c\/[a-zA-Z0-9-]+)\/?$/.test(url.pathname)) {
    throw new Error('Use a ChatGPT Project URL (https://chatgpt.com/g/g-…/project) or a conversation inside that Project.');
  }
  url.search = ''; url.hash = '';
  return url.toString();
}
// Slugs can change while the underlying Project ID remains the same.
export function projectIdentity(value) {
  const segment = new URL(value).pathname.split('/')[2] || ''; 
  return segment.match(/^g-p-[a-f0-9]{32}(?=-|$)/i)?.[0].toLowerCase() || segment;
}
export function validatePlanningConversation(value, projectUrl) {
  if (!value) return '';
  const target = validateProjectUrl(value);
  if (new URL(target).pathname.split('/')[3] !== 'c') {
    throw new Error('Use the original planning conversation URL inside the Project, not the Project home or a share link.');
  }
  if (projectUrl && projectIdentity(target) !== projectIdentity(projectUrl)) {
    throw new Error('The planning conversation must belong to the configured ChatGPT Project.');
  }
  return target;
}
export function scriptRequest(item, { fromConversation = false } = {}) {
  const source = fromConversation
    ? 'Owner policy: use approved content in this planning conversation. Explicit owner approval in this chat is valid; no separate Project Source or complete 21-item week is required.'
    : 'Use the approved weekly content plan in this Project.';
  return source + ' Retrieve the ' + item.slot.toUpperCase() + ' content for ' + item.date
    + ', posting at ' + SLOTS[item.slot] + ' ' + TIMEZONE + '. Use the latest complete spoken script explicitly approved for this exact publication date and slot. Topic-only approval, drafts and QA samples do not count. Preserve approved wording. Do not invent, research, rewrite or substitute another date/slot. If the approved script is missing, inaccessible, withdrawn or ambiguous, return CONTENT_NOT_PLANNED only. Otherwise return ONLY one JSON object: date (' + item.date + '), slot (' + item.slot + '), title (short video title), script (complete spoken words only, no headings or notes), caption (opening hook copied exactly), hashtags (array of relevant topic tags). No markdown or explanation.';
}
export function parseScriptResponse(raw, item) {
  const text = String(raw || '').trim();
  if (text === 'CONTENT_NOT_PLANNED') throw Object.assign(new Error('ChatGPT could not locate approved content for this date and slot. Check the planning conversation or saved approved source, then retry.'), { code: 'CONTENT_NOT_PLANNED' });
  const clean = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '').trim();
  let data;
  try { data = JSON.parse(clean); } catch { throw new Error('ChatGPT response is not valid JSON. Review the saved response before retrying.'); }
  if (data.date !== item.date || data.slot !== item.slot) throw new Error('ChatGPT returned a different date or content slot.');
  if (typeof data.script !== 'string' || data.script.trim().length < 10 || data.script.length > 6000
    || /CONTENT_NOT_PLANNED|```/.test(data.script)) throw new Error('Script is empty, too long or contains an invalid response.');
  if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 100) {
    throw new Error('ChatGPT response needs a title within 100 characters.');
  }
  const postMetadata = buildPostMetadata(data.script);
  if (!postMetadata) throw new Error('Script needs a spoken opening hook.');
  return { title: data.title.trim(), script: data.script.trim(), caption: postMetadata.caption,
    hashtags: postMetadata.hashtags, postMetadata };
}
export class ContentStore {
  constructor(directory = process.env.CONTENT_STATE_DIR || path.join(config.rootDir, 'tmp', 'content')) {
    this.directory = directory;
    this.file = path.join(directory, 'state.json');
    fs.mkdirSync(directory, { recursive: true });
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Content state cannot be read; repair state.json before starting automation.');
      this.state = { version: 1, settings: { enabled: false, scriptSource: 'manual', projectUrl: '', planningConversationUrl: '', prepareHour: 18, autoPublish: false, platforms: [] }, items: {} };
    }
    this.state.settings.scriptSource ??= 'manual';
    this.state.settings.slots ??= {...SLOTS};
    this.state.drafts ??= {};
    this.state.plannerRuns ??= {};
    this.state.plannerUsage ??= {};
    for(const run of Object.values(this.state.plannerRuns))if(run.status==='generating'){run.status='interrupted';run.message='Planning stopped when the server restarted. Resume to keep completed drafts and finish the remaining slots.';}
    this.state.settings.generationLeadMinutes ??= 120;
    for (const item of Object.values(this.state.items)) {
      if (['queued', 'fetching_script', 'awaiting_verification', 'creating_job', 'publishing'].includes(item.status)) {
        item.status = 'needs_review'; item.error = 'App restarted during an external action. Inspect the saved response/job before retrying.';
      }
    }
    this.save();
  }
  save() {
    writeAtomicJson(this.file, this.state);
  }
  settings(input) {
    if (!input || typeof input !== 'object') throw new Error('Settings are required.');
    const settings = { ...this.state.settings };
    for (const key of ['enabled', 'autoPublish']) if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
      settings[key] = input[key];
    }
    if (input.scriptSource !== undefined) {
      if (!['manual', 'chatgpt'].includes(input.scriptSource)) throw new Error('Choose manual or ChatGPT scripts.');
      settings.scriptSource = input.scriptSource;
    }
    if (input.projectUrl !== undefined) settings.projectUrl = validateProjectUrl(input.projectUrl);
    if (input.planningConversationUrl !== undefined) {
      if (typeof input.planningConversationUrl !== 'string') throw new Error('Planning conversation URL must be text.');
      settings.planningConversationUrl = input.planningConversationUrl.trim();
    }
    settings.planningConversationUrl = validatePlanningConversation(settings.planningConversationUrl || '', settings.projectUrl);
    if(input.plannerProfile!==undefined){if(typeof input.plannerProfile!=='string'||input.plannerProfile.length>5000)throw new Error('Planner profile must be within 5,000 characters.');settings.plannerProfile=input.plannerProfile.trim();}
    if(input.slots!==undefined){
      if(!input.slots||typeof input.slots!=='object'||Array.isArray(input.slots)||Object.keys(input.slots).length!==4||Object.keys(SLOTS).some(slot=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.slots[slot]||'')))throw new Error('Set four valid posting times.');
      if(new Set(Object.values(input.slots)).size!==4)throw new Error('Posting times must be different.');
      settings.slots=Object.fromEntries(Object.keys(SLOTS).map(slot=>[slot,input.slots[slot]]));
    }
    if (input.generationLeadMinutes !== undefined) {
      if (!Number.isInteger(input.generationLeadMinutes) || input.generationLeadMinutes < 0 || input.generationLeadMinutes > 1440) throw new Error('Generation lead time must be 0 to 1440 minutes.');
      settings.generationLeadMinutes = input.generationLeadMinutes;
    }
    if (input.prepareHour !== undefined) {
      if (!Number.isInteger(input.prepareHour) || input.prepareHour < 0 || input.prepareHour > 23) throw new Error('Preparation hour must be 0–23.');
      settings.prepareHour = input.prepareHour;
    }
    if (input.platforms !== undefined) {
      if (!Array.isArray(input.platforms) || input.platforms.some(p => !['facebook', 'tiktok', 'youtube'].includes(p))) throw new Error('Choose supported publishing platforms.');
      settings.platforms = [...new Set(input.platforms)];
    }
    if (settings.enabled && settings.scriptSource === 'chatgpt' && !settings.projectUrl) throw new Error('Set a Project URL before enabling automation.');
    if(input.bufferChannelIds!==undefined){
      if(!input.bufferChannelIds||typeof input.bufferChannelIds!=='object'||Array.isArray(input.bufferChannelIds))throw new Error('Invalid Buffer channels.');
      settings.bufferChannelIds={...settings.bufferChannelIds};
      for(const [platform,id] of Object.entries(input.bufferChannelIds)){
        if(!['facebook','tiktok','youtube'].includes(platform)||typeof id!=='string'||id.length>200)throw new Error('Invalid Buffer channel.');
        settings.bufferChannelIds[platform]=id;
      }
    }
    if (settings.autoPublish && !settings.platforms.length) throw new Error('Choose at least one publishing platform.');
    this.state.settings = settings; this.save(); return settings;
  }
  ensure(date, slot) {
    const info = slotInfo(date, slot, this.state.settings.slots);
    if (!this.state.items[info.id]) { this.state.items[info.id] = { ...info, status: 'planned', createdAt: new Date().toISOString() }; this.save(); }
    return this.state.items[info.id];
  }
  update(id, patch) {
    const item = Object.hasOwn(this.state.items, id) ? this.state.items[id] : null;
    if (!item) throw new Error('Content slot not found.');
    Object.assign(item, patch, { updatedAt: new Date().toISOString() }); this.save(); return item;
  }
}
