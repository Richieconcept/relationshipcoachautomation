import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContentStore, slotInfo, nextDate, lagosClock, validateProjectUrl, parseScriptResponse } from '../services/content-plan.service.js';

// The job module normally recovers persisted jobs on import. Tests must never touch real job state.
const jobDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'content-jobs-test-'));
process.env.FLOW_JOB_STATE_DIR = jobDirectory;
const { ContentScheduler } = await import('../services/content-scheduler.service.js');
const { contentPublishing } = await import('../services/content-production.service.js');
const { contentRoutes } = await import('../routes/content.routes.js');
const { default: express } = await import('express');
const { createProjectJob, getJob, updateJob } = await import('../src/jobs.js');
const projectUrl = 'https://chatgpt.com/g/g-p-test/project';
const response = item => JSON.stringify({ date: item.date, slot: item.slot, title: 'Useful title', script: 'This is the complete spoken script for the planned content.', caption: 'Useful post caption', hashtags: ['#Learning'] });
const directories = [jobDirectory];
function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'content-test-')); directories.push(directory);
  const store = new ContentStore(directory); store.settings({ scriptSource: 'chatgpt', projectUrl });
  const jobs = new Map(); let requests = 0; let productions = 0; let publications = 0;
  const scheduler = new ContentScheduler({ store,
    requestScript: async ({ prompt }) => { requests++; const match = prompt.match(/(\d{4}-\d{2}-\d{2})/); const slot = prompt.match(/the (MORNING|AFTERNOON|LATE_AFTERNOON|EVENING) content/)[1].toLowerCase(); return response({ date: match[1], slot }); },
    createVideo: async (item, settings, created) => { productions++; const job = { id: `job-${item.id}`, contentSlotId: item.id, status: 'completed', finalVideoPath: 'test.mp4' }; jobs.set(job.id, job); created(job.id); return job; },
    findJob: id => [...jobs.values()].find(job => job.contentSlotId === id), jobById: id => jobs.get(id),
    publishVideo: async () => { publications++; return { status: 'published' }; }, ...overrides });
  return { store, scheduler, jobs, counts: () => ({ requests, productions, publications }) };
}
test.after(() => { for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true }); });

test('Lagos slots, midnight, and year boundaries are independent of host timezone', () => {
  assert.equal(slotInfo('2026-11-02', 'morning').publishAt, '2026-11-02T05:00:00.000Z');
  assert.equal(slotInfo('2026-11-02', 'afternoon').publishAt, '2026-11-02T11:00:00.000Z');
  assert.equal(slotInfo('2026-11-02', 'evening').publishAt, '2026-11-02T19:00:00.000Z');
  assert.deepEqual(lagosClock(new Date('2026-12-31T23:30:00Z')), { date: '2027-01-01', hour: 0, minute: 30 });
  assert.equal(nextDate('2026-12-31'), '2027-01-01');
  assert.throws(() => slotInfo('2026-02-30', 'morning'));
  assert.throws(() => slotInfo('2026-01-01', '__proto__'));
});
test('only actual ChatGPT Project destinations are accepted', () => {
  assert.equal(validateProjectUrl(projectUrl), projectUrl);
  assert.equal(validateProjectUrl('https://chatgpt.com/g/g-p-test/c/abc'), 'https://chatgpt.com/g/g-p-test/c/abc');
  for (const url of ['https://chatgpt.com.evil.test/g/g-p-test/project', 'http://chatgpt.com/g/g-p-test/project', 'https://chatgpt.com/c/abc', 'https://user:password@chatgpt.com/g/g-p-test/project', 'https://chatgpt.com:444/g/g-p-test/project']) assert.throws(() => validateProjectUrl(url));
});
test('responses must match date/slot, contain spoken script and required post metadata', () => {
  const item = slotInfo('2026-11-02', 'morning');
  assert.equal(parseScriptResponse(response(item), item).title, 'Useful title');
  assert.equal(parseScriptResponse('```json\n' + response(item) + '\n```', item).hashtags[0], '#RelationshipCoach');
  assert.throws(() => parseScriptResponse('CONTENT_NOT_PLANNED', item), { code: 'CONTENT_NOT_PLANNED' });
  assert.throws(() => parseScriptResponse(response({ ...item, slot: 'evening' }), item), /different date/);
  assert.throws(() => parseScriptResponse('Here is your script', item), /valid JSON/);
  assert.throws(() => parseScriptResponse(JSON.stringify({ date: item.date, slot: item.slot, script: 'hi' }), item));
});
test('preparing duplicate slots concurrently or after completion creates one script and one video', async () => {
  const f = fixture();
  f.scheduler.prepare('2026-11-02', ['morning']); f.scheduler.prepare('2026-11-02', ['morning'], { retry: true });
  await f.scheduler.queue;
  f.scheduler.prepare('2026-11-02', ['morning'], { retry: true }); await f.scheduler.queue;
  assert.deepEqual(f.counts(), { requests: 1, productions: 1, publications: 0 });
  assert.equal(f.store.state.items['2026-11-02-morning'].status, 'ready');
});
test('script preview persists without creating a video; later production reuses that script', async () => {
  const f = fixture();
  f.scheduler.prepare('2026-11-02', ['afternoon'], { scriptOnly: true }); await f.scheduler.queue;
  assert.equal(f.store.state.items['2026-11-02-afternoon'].status, 'script_ready');
  assert.equal(f.counts().productions, 0);
  f.scheduler.prepare('2026-11-02', ['afternoon'], { retry: true }); await f.scheduler.queue;
  assert.equal(f.counts().requests, 1); assert.equal(f.counts().productions, 1);
});
test('missing content and mismatched responses never enter video production', async () => {
  for (const raw of ['CONTENT_NOT_PLANNED', response({ date: '2026-01-01', slot: 'morning' })]) {
    const f = fixture({ requestScript: async () => raw });
    f.scheduler.prepare('2026-11-02', ['morning']); await f.scheduler.queue;
    assert.equal(f.counts().productions, 0);
    assert.ok(['needs_review', 'content_not_planned'].includes(f.store.state.items['2026-11-02-morning'].status));
    await f.scheduler.tick(new Date('2026-11-01T18:00:00Z')); await f.scheduler.queue;
    assert.equal(f.counts().productions, 0);
  }
});
test('daily scheduler prepares all four tomorrow slots once after 6 pm Lagos', async () => {
  const f = fixture(); f.store.settings({ enabled: true });
  await f.scheduler.tick(new Date('2026-11-01T16:59:00Z')); assert.equal(Object.keys(f.store.state.items).length, 0);
  await f.scheduler.tick(new Date('2026-11-01T17:00:00Z')); await f.scheduler.queue;
  await f.scheduler.tick(new Date('2026-11-01T19:00:00Z')); await f.scheduler.queue;
  assert.deepEqual(f.counts(), { requests: 4, productions: 4, publications: 0 });
  assert.ok(Object.values(f.store.state.items).every(item => item.date === '2026-11-02'));
});
test('publishing happens only at its Lagos slot and is never repeated', async () => {
  const f = fixture(); f.store.settings({ enabled: true, autoPublish: true, platforms: ['facebook'] });
  f.scheduler.prepare('2026-11-02', ['morning']); await f.scheduler.queue;
  await f.scheduler.tick(new Date('2026-11-02T04:59:59Z')); assert.equal(f.counts().publications, 0);
  await f.scheduler.tick(new Date('2026-11-02T05:00:00Z'));
  await f.scheduler.tick(new Date('2026-11-02T05:00:15Z'));
  assert.equal(f.counts().publications, 1);
});
test('paused automation never publishes, and missed posting windows are held', async () => {
  const f = fixture(); f.store.settings({ autoPublish: true, platforms: ['facebook'] });
  f.scheduler.prepare('2026-11-02', ['morning']); await f.scheduler.queue;
  await f.scheduler.tick(new Date('2026-11-02T05:01:00Z')); assert.equal(f.counts().publications, 0);
  f.store.settings({ enabled: true }); await f.scheduler.tick(new Date('2026-11-02T05:16:00Z'));
  assert.equal(f.counts().publications, 0); assert.equal(f.store.state.items['2026-11-02-morning'].status, 'missed');
});
test('ambiguous requests after restart require review and saved job identity prevents regeneration', async () => {
  const f = fixture(); const item = f.store.ensure('2026-11-02', 'morning');
  f.store.update(item.id, { status: 'fetching_script' });
  const reopened = new ContentStore(f.store.directory); assert.equal(reopened.state.items[item.id].status, 'needs_review');
  const job = { id: 'already-created', contentSlotId: item.id, status: 'completed' }; f.jobs.set(job.id, job);
  await f.scheduler.tick(new Date('2026-11-01T17:00:00Z'));
  assert.equal(item.jobId, job.id); assert.equal(item.status, 'ready');
  f.scheduler.prepare(item.date, [item.slot], { retry: true }); await f.scheduler.queue;
  assert.equal(f.counts().productions, 0);
});
test('corrupt state fails closed and interrupted publishing is not automatically repeated', () => {
  const f = fixture(); const item = f.store.ensure('2026-11-02', 'morning'); f.store.update(item.id, { status: 'publishing' });
  assert.equal(new ContentStore(f.store.directory).state.items[item.id].status, 'needs_review');
  fs.writeFileSync(f.store.file, 'broken json'); assert.throws(() => new ContentStore(f.store.directory), /cannot be read/);
});
test('publishing metadata uses configured destinations and validates captions', () => {
  const item = parseScriptResponse(response(slotInfo('2026-11-02', 'morning')), slotInfo('2026-11-02', 'morning'));
  const publishing = contentPublishing(item, ['youtube']); assert.equal(publishing.youtube.enabled, true); assert.equal(publishing.facebook.enabled, false);
  assert.equal(publishing.youtube.description, item.caption);
  assert.equal(contentPublishing({ ...item, caption: 'x'.repeat(2300), hashtags: ['#Wrong'] }, ['tiktok']).tiktok.caption, item.script);
});
test('real jobs persist content-slot association for crash recovery', () => {
  const job = createProjectJob({ contentSlotId: '2026-11-02-morning', title: 'Recovery', scenes: [{ prompt: 'Test' }] });
  assert.equal(getJob(job.id).contentSlotId, '2026-11-02-morning');
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobDirectory, `${job.id}.json`))).contentSlotId, '2026-11-02-morning');
  updateJob(job.id, 'failed');
});
test('local API validates input, blocks cross-origin actions and preserves scripts', async () => {
  const f = fixture(); const app = express(); app.use(express.json()); app.use('/api/content', contentRoutes(f.scheduler).router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/content`;
  try {
    let result = await fetch(base); assert.equal(result.status, 200); assert.equal((await result.json()).timezone, 'Africa/Lagos');
    result = await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' }, body: '{}' }); assert.equal(result.status, 403);
    result = await fetch(`${base}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '../escape', slots: ['morning'] }) }); assert.equal(result.status, 400);
    result = await fetch(`${base}/items/__proto__/script`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: response(slotInfo('2026-11-02', 'morning')) }); assert.equal(result.status, 400);
    result = await fetch(`${base}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-11-02', slots: ['morning'], scriptOnly: true }) }); assert.equal(result.status, 202);
    await f.scheduler.queue;
    result = await fetch(base); const data = await result.json(); assert.equal(data.items[0].status, 'script_ready'); assert.ok(data.items[0].script);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('an explicit retry re-queries a negative answer, but automatic ticks do not', async () => {
  const f = fixture(); const item = f.store.ensure('2026-11-02', 'morning');
  f.store.update(item.id, { status: 'content_not_planned', rawResponse: 'CONTENT_NOT_PLANNED', requestState: 'received' });
  f.store.settings({ enabled: true });
  await f.scheduler.tick(new Date('2026-11-01T18:00:00Z')); await f.scheduler.queue;
  assert.equal(f.counts().requests, 3); // Only the other three tomorrow slots are prepared.
  assert.equal(item.rawResponse, 'CONTENT_NOT_PLANNED');
  f.scheduler.prepare(item.date, [item.slot], { retry: true, scriptOnly: true }); await f.scheduler.queue;
  assert.equal(f.counts().requests, 4);
  assert.equal(item.status, 'script_ready');
  assert.notEqual(item.rawResponse, 'CONTENT_NOT_PLANNED');
});

test('an explicit retry preserves an ambiguous saved answer for review', async () => {
  const f = fixture(); const item = f.store.ensure('2026-11-02', 'afternoon');
  f.store.update(item.id, { status: 'needs_review', rawResponse: 'Incomplete response needing inspection.' });
  f.scheduler.prepare(item.date, [item.slot], { retry: true, scriptOnly: true }); await f.scheduler.queue;
  assert.equal(f.counts().requests, 0);
  assert.equal(item.status, 'needs_review');
  assert.equal(item.rawResponse, 'Incomplete response needing inspection.');
});


test('approved partial-week import survives restart and production reuses it without ChatGPT', async () => {
  const { importApprovedPlan } = await import('../services/approved-plan.service.js');
  const f = fixture(); const info = slotInfo('2026-11-02', 'morning');
  f.store.ensure(info.date, info.slot);
  f.store.update(info.id, { status: 'content_not_planned', rawResponse: 'CONTENT_NOT_PLANNED' });
  const record = JSON.parse(response(info));
  const imported = importApprovedPlan(f.scheduler, { records: [record], sourceUrl: 'https://chatgpt.com/share/approved-fixture' });
  assert.equal(imported[0].status, 'script_ready');
  assert.equal(imported[0].script, record.script);
  assert.equal(imported[0].caption, record.script);
  assert.deepEqual(f.counts(), { requests: 0, productions: 0, publications: 0 });
  const restored = new ContentStore(f.store.directory);
  assert.equal(restored.state.items[info.id].script, record.script);
  assert.equal(restored.state.items[info.id].approval.sourceUrl, 'https://chatgpt.com/share/approved-fixture');
  f.scheduler.prepare(info.date, [info.slot], { retry: true }); await f.scheduler.queue;
  assert.deepEqual(f.counts(), { requests: 0, productions: 1, publications: 0 });
});

test('approved imports validate the complete batch before changing state', async () => {
  const { importApprovedPlan } = await import('../services/approved-plan.service.js');
  const f = fixture(); const a = JSON.parse(response(slotInfo('2026-11-02', 'morning')));
  const b = JSON.parse(response(slotInfo('2026-11-02', 'afternoon')));
  const before = fs.readFileSync(f.store.file, 'utf8');
  for (const records of [[a, { ...b, script: 'bad' }], [a, a], [{ ...a, date: '2026-02-30' }], [], Array(22).fill(a)]) {
    assert.throws(() => importApprovedPlan(f.scheduler, { records }));
    assert.equal(fs.readFileSync(f.store.file, 'utf8'), before);
    assert.equal(Object.keys(f.store.state.items).length, 0);
  }
  assert.throws(() => importApprovedPlan(f.scheduler, { records: [a], sourceUrl: 'javascript:alert(1)' }));
  const item = f.store.ensure(b.date, b.slot);
  f.store.update(item.id, { jobId: 'existing-job', status: 'producing' });
  assert.throws(() => importApprovedPlan(f.scheduler, { records: [a, b] }), /existing video/);
  assert.equal(f.store.state.items[slotInfo(a.date, a.slot).id], undefined);
});

test('failed import persistence restores the previous in-memory calendar', async () => {
  const { importApprovedPlan } = await import('../services/approved-plan.service.js');
  const f = fixture(); const original = f.store.state;
  f.store.save = () => { throw new Error('Disk unavailable'); };
  assert.throws(() => importApprovedPlan(f.scheduler, { records: [JSON.parse(response(slotInfo('2026-11-02', 'morning')))] }), /Disk unavailable/);
  assert.equal(f.store.state, original);
  assert.equal(Object.keys(f.store.state.items).length, 0);
});

test('approved import endpoint is local-only and never queues videos', async () => {
  const f = fixture(); const app = express(); app.use(express.json()); app.use('/api/content', contentRoutes(f.scheduler).router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/content/import-approved';
  const record = JSON.parse(response(slotInfo('2026-11-02', 'morning')));
  try {
    let result = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' }, body: JSON.stringify({ records: [record] }) });
    assert.equal(result.status, 403);
    result = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [record] }) });
    assert.equal(result.status, 200); assert.equal((await result.json()).imported, 1);
    assert.deepEqual(f.counts(), { requests: 0, productions: 0, publications: 0 });
    assert.equal(f.store.state.items['2026-11-02-morning'].status, 'script_ready');
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('daily automatic preparation produces locally imported scripts without retrieving them again', async () => {
  const { importApprovedPlan } = await import('../services/approved-plan.service.js');
  const f = fixture({ requestScript: async () => { throw new Error('Imported scripts must not be requested again.'); } });
  f.store.settings({ enabled: true });
  importApprovedPlan(f.scheduler, { records: ['morning', 'afternoon', 'late_afternoon', 'evening'].map(slot => JSON.parse(response(slotInfo('2026-11-02', slot)))) });
  await f.scheduler.tick(new Date('2026-11-01T17:00:00Z')); await f.scheduler.queue;
  assert.deepEqual(f.counts(), { requests: 0, productions: 4, publications: 0 });
  assert.ok(Object.values(f.store.state.items).every(item => item.status === 'ready'));
  await f.scheduler.tick(new Date('2026-11-01T18:00:00Z')); await f.scheduler.queue;
  assert.equal(f.counts().productions, 4);
});


test('planning source settings persist and reject share links, Project home and another Project', async () => {
  const { validatePlanningConversation, projectIdentity } = await import('../services/content-plan.service.js');
  const f = fixture(); const conversation = 'https://chatgpt.com/g/g-p-test/c/approved-plan';
  f.store.settings({ planningConversationUrl: conversation });
  assert.equal(new ContentStore(f.store.directory).state.settings.planningConversationUrl, conversation);
  assert.equal(validatePlanningConversation(conversation, projectUrl), conversation);
  for (const source of [projectUrl, 'https://chatgpt.com/share/snapshot', 'https://chatgpt.com/g/g-p-other/c/approved-plan']) {
    assert.throws(() => f.store.settings({ planningConversationUrl: source }));
    assert.equal(f.store.state.settings.planningConversationUrl, conversation);
  }
  assert.throws(() => f.store.settings({ scriptSource: 'chatgpt', projectUrl: 'https://chatgpt.com/g/g-p-other/project' }));
  assert.equal(projectIdentity('https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-old-name/project'), projectIdentity('https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-new-name/c/chat'));
});

test('retrieval policy explicitly accepts approved scripts in chat and blocks drafts or invented replacements', async () => {
  const { scriptRequest } = await import('../services/content-plan.service.js');
  const prompt = scriptRequest(slotInfo('2026-11-03', 'morning'), { fromConversation: true });
  assert.match(prompt, /Explicit owner approval in this chat is valid/);
  assert.match(prompt, /no separate Project Source or complete 21-item week is required/);
  assert.match(prompt, /Topic-only approval, drafts and QA samples do not count/);
  assert.match(prompt, /2026-11-03/);
  assert.match(prompt, /CONTENT_NOT_PLANNED/);
  assert.ok(prompt.length < 1300, 'Keep the prompt short enough to avoid collapsed user text in the browser.');
});

test('scheduler retrieves missing scripts from the planning conversation and preserves saved scripts', async () => {
  const conversation = 'https://chatgpt.com/g/g-p-test/c/approved-plan'; let request;
  const f = fixture({ requestScript: async input => { request = input; return response(slotInfo('2026-11-03', 'morning')); } });
  f.store.settings({ planningConversationUrl: conversation });
  f.scheduler.prepare('2026-11-03', ['morning'], { scriptOnly: true }); await f.scheduler.queue;
  assert.equal(request.projectUrl, conversation);
  assert.match(request.prompt, /Explicit owner approval in this chat is valid/);
  assert.equal(f.store.state.items['2026-11-03-morning'].retrievalSource, 'planning_conversation');
  const saved = f.store.state.items['2026-11-03-morning'].script; request = null;
  f.scheduler.prepare('2026-11-03', ['morning'], { retry: true }); await f.scheduler.queue;
  assert.equal(request, null);
  assert.equal(f.store.state.items['2026-11-03-morning'].script, saved);
  assert.equal(f.counts().productions, 1);
});

test('a planning-chat missing-content reply never creates a video', async () => {
  const f = fixture({ requestScript: async () => 'CONTENT_NOT_PLANNED' });
  f.store.settings({ planningConversationUrl: 'https://chatgpt.com/g/g-p-test/c/approved-plan' });
  f.scheduler.prepare('2026-11-03', ['afternoon']); await f.scheduler.queue;
  assert.equal(f.store.state.items['2026-11-03-afternoon'].status, 'content_not_planned');
  assert.equal(f.counts().productions, 0);
});


test('saved approved scripts enter production automatically before the daily retrieval hour', async () => {
  const { importApprovedPlan } = await import('../services/approved-plan.service.js');
  const f = fixture();
  importApprovedPlan(f.scheduler, { records: [JSON.parse(response(slotInfo('2026-11-02', 'morning')))] });
  await f.scheduler.tick(new Date('2026-11-01T09:00:00Z')); await f.scheduler.queue;
  assert.equal(f.counts().productions, 0, 'Disabled automation must not start live work.');
  f.store.settings({ enabled: true, autoPublish: false });
  await f.scheduler.tick(new Date('2026-11-01T09:00:00Z')); await f.scheduler.queue;
  assert.deepEqual(f.counts(), { requests: 0, productions: 1, publications: 0 });
  assert.equal(f.store.state.items['2026-11-02-morning'].status, 'ready');
  await f.scheduler.tick(new Date('2026-11-01T09:00:15Z')); await f.scheduler.queue;
  assert.equal(f.counts().productions, 1, 'Repeated scheduler ticks must not create duplicate videos.');
});

test('explicit preview-only scripts stay held across ticks and restarts until released', async () => {
  const f = fixture();
  f.scheduler.prepare('2026-11-02', ['morning', 'afternoon', 'late_afternoon', 'evening'], { scriptOnly: true }); await f.scheduler.queue;
  f.store.settings({ enabled: true });
  const restored = new ContentStore(f.store.directory);
  f.scheduler.store = restored;
  await f.scheduler.tick(new Date('2026-11-01T17:00:00Z')); await f.scheduler.queue;
  assert.equal(f.counts().productions, 0);
  assert.ok(Object.values(restored.state.items).every(item => item.productionMode === 'preview' && item.status === 'script_ready'));
  f.scheduler.prepare('2026-11-02', ['morning'], { retry: true }); await f.scheduler.queue;
  assert.equal(f.counts().requests, 4, 'Releasing a saved script must not request it from ChatGPT again.');
  assert.equal(f.counts().productions, 1);
  assert.equal(restored.state.items['2026-11-02-morning'].productionMode, 'automatic');
  assert.equal(restored.state.items['2026-11-02-afternoon'].productionMode, 'preview');
});

test('automatic ready-script handoff holds past slots, distant dates and interrupted jobs', async () => {
  const { importApprovedPlan } = await import('../services/approved-plan.service.js');
  const f = fixture(); f.store.settings({ enabled: true });
  importApprovedPlan(f.scheduler, { records: [JSON.parse(response(slotInfo('2026-11-01', 'morning'))), JSON.parse(response(slotInfo('2026-11-04', 'afternoon')))] });
  const interrupted = f.store.ensure('2026-11-02', 'morning');
  f.store.update(interrupted.id, { status: 'needs_review', script: 'An interrupted script must wait for an explicit resume.', jobId: 'interrupted-job' });
  f.jobs.set('interrupted-job', { id: 'interrupted-job', status: 'interrupted', contentSlotId: interrupted.id });
  await f.scheduler.tick(new Date('2026-11-01T09:00:00Z')); await f.scheduler.queue;
  assert.deepEqual(f.counts(), { requests: 0, productions: 0, publications: 0 });
  assert.equal(interrupted.status, 'needs_review');
});


test('Start Video always fetches a fresh approved script, continues production and disables publishing', async () => {
  let requested; let productionSettings;
  const f = fixture({ createVideo: async (item, settings, created) => {
    productionSettings = settings;
    const job = { id: 'started-video', contentSlotId: item.id, status: 'completed', finalVideoPath: 'fixture.mp4' };
    f.jobs.set(job.id, job); created(job.id); return job;
  } });
  f.store.settings({ autoPublish: true, platforms: ['facebook'], planningConversationUrl: 'https://chatgpt.com/g/g-p-test/c/approved-plan' });
  const info = slotInfo('2026-11-02', 'afternoon'); const cached = JSON.parse(response(info)); cached.script = 'This is a stale cached approved script.';
  f.store.ensure(info.date, info.slot); f.store.update(info.id, { ...parseScriptResponse(JSON.stringify(cached), info), status: 'script_ready' });
  const fresh = JSON.parse(response(info)); fresh.script = 'This is the latest approved script from the planning conversation.';
  f.scheduler.requestScript = async input => { requested = input; return JSON.stringify(fresh); };
  const first = f.scheduler.startVideo(info.date, info.slot);
  const doubleClick = f.scheduler.startVideo(info.date, info.slot);
  assert.equal(first.reused, false); assert.equal(doubleClick.reused, true);
  await f.scheduler.queue;
  assert.equal(requested.projectUrl, f.store.state.settings.planningConversationUrl);
  assert.equal(f.store.state.items[info.id].script, fresh.script);
  assert.equal(f.store.state.items[info.id].previousApprovedScript.script, cached.script);
  assert.equal(f.store.state.items[info.id].status, 'ready');
  assert.equal(productionSettings.autoPublish, false);
  assert.deepEqual(productionSettings.platforms, []);
  assert.equal(f.store.state.items[info.id].autoPublish, false);
  assert.equal(f.store.state.settings.autoPublish, true, 'A generate-only run must not rewrite global scheduling settings.');
  requested = null; assert.equal(f.scheduler.startVideo(info.date, info.slot).reused, true);
  await f.scheduler.queue; assert.equal(requested, null);
});

test('fresh retrieval failure never generates from a stale cached script', async () => {
  const f = fixture({ requestScript: async () => 'CONTENT_NOT_PLANNED' });
  const info = slotInfo('2026-11-02', 'afternoon');
  const item = f.store.ensure(info.date, info.slot);
  f.store.update(item.id, { script: 'Previously approved but no longer confirmed.', title: 'Old title', status: 'script_ready' });
  f.scheduler.startVideo(info.date, info.slot); await f.scheduler.queue;
  assert.equal(item.status, 'content_not_planned');
  assert.equal(item.script, null);
  assert.equal(item.previousApprovedScript.script, 'Previously approved but no longer confirmed.');
  assert.equal(f.counts().productions, 0);
});

test('Start Video attaches to an interrupted job and never submits a replacement', async () => {
  const f = fixture(); const item = f.store.ensure('2026-11-02', 'morning');
  f.jobs.set('saved-job', { id: 'saved-job', contentSlotId: item.id, status: 'interrupted' });
  const result = f.scheduler.startVideo(item.date, item.slot);
  assert.equal(result.reused, true); assert.equal(result.item.jobId, 'saved-job');
  await f.scheduler.queue;
  assert.deepEqual(f.counts(), { requests: 0, productions: 0, publications: 0 });
});

test('Start Video API returns a trackable slot, and status endpoint exposes the resulting job', async () => {
  const f = fixture(); const app = express(); app.use(express.json()); app.use('/api/content', contentRoutes(f.scheduler).router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/content';
  try {
    let response = await fetch(base + '/start-video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-11-02', slot: 'evening' }) });
    assert.equal(response.status, 202); const started = await response.json();
    assert.equal(started.mode, 'generate_only'); assert.equal(started.itemId, '2026-11-02-evening');
    await f.scheduler.queue;
    response = await fetch(base + '/items/' + started.itemId); const status = await response.json();
    assert.equal(status.item.status, 'ready'); assert.equal(status.item.job.id, status.item.jobId);
    response = await fetch(base + '/start-video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-11-02', slot: 'evening' }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).reused, true);
    assert.equal(f.counts().requests, 1); assert.equal(f.counts().productions, 1);
    response = await fetch(base + '/items/__proto__'); assert.equal(response.status, 404);
    response = await fetch(base + '/start-video', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' }, body: '{}' });
    assert.equal(response.status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('verification status is visible and preserves whether the ChatGPT prompt was already sent', async () => {
  const f=fixture({requestScript:async({checkpoint})=>{
    checkpoint({requestState:'sent'});checkpoint({humanVerificationRequired:true,verificationPhase:'waiting_reply'});
    const item=f.store.state.items['2026-11-02-afternoon'];
    assert.equal(item.status,'awaiting_verification');assert.equal(item.requestState,'sent');
    assert.equal(f.scheduler.snapshot().items[0].humanVerificationRequired,true);
    const restored=new ContentStore(f.store.directory);
    assert.equal(restored.state.items[item.id].status,'needs_review');
    assert.equal(restored.state.items[item.id].requestState,'sent');
    checkpoint({humanVerificationRequired:false,verificationPhase:null});
    assert.equal(item.status,'fetching_script');return response(item);
  }});
  f.scheduler.prepare('2026-11-02',['afternoon'],{scriptOnly:true});await f.scheduler.queue;
  assert.equal(f.store.state.items['2026-11-02-afternoon'].status,'script_ready');
  assert.equal(f.counts().productions,0);
});
