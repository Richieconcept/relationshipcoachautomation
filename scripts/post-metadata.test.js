import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPostMetadata, openingHook, spokenScript, applyScriptPostMetadata } from '../services/post-metadata.service.js';
import { parseScriptResponse, slotInfo } from '../services/content-plan.service.js';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'post-metadata-'));
process.env.FLOW_JOB_STATE_DIR = path.join(directory, 'jobs');
const { createProjectJob, getJob, updateJob } = await import('../src/jobs.js');
const { publishJob, parsePublishing, buildPostText } = await import('../services/publishing.service.js');
const { generateProjectController, splitScriptController } = await import('../controllers/video.controller.js');
const { contentPublishing } = await import('../services/content-production.service.js');
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const script = 'Love cannot survive without honest communication. Listen to your partner and respect their boundaries.';

test('the first hook preserves words, punctuation, questions and quotes', () => {
  assert.equal(openingHook(script), 'Love cannot survive without honest communication.');
  assert.equal(openingHook('**Hook:** Why are you accepting disrespect? You deserve better.'), 'Why are you accepting disrespect?');
  assert.equal(openingHook('Hook:\nYour peace matters\nSet healthy boundaries.'), 'Your peace matters');
  assert.equal(openingHook('\u201cIs this love?\u201d Ask yourself today.'), '\u201cIs this love?\u201d');
  assert.equal(openingHook('Dr. Jones says money matters. Listen carefully.'), 'Dr. Jones says money matters.');
  assert.equal(openingHook('Save 2.5 hours for your partner. Quality time matters.'), 'Save 2.5 hours for your partner.');
  assert.equal(buildPostMetadata('  '), null);
  assert.ok(openingHook('word '.repeat(600)).length <= 500);
});

test('hashtags match script topics, prioritize the hook and stay unique and bounded', () => {
  const result = buildPostMetadata(script);
  assert.deepEqual(result.hashtags.slice(0, 2), ['#RelationshipCoach', '#RelationshipAdvice']);
  assert.ok(result.hashtags.includes('#HealthyCommunication'));
  assert.ok(result.hashtags.includes('#HealthyBoundaries'));
  assert.ok(!result.hashtags.includes('#MarriageAdvice'));
  const money = buildPostMetadata('Money can divide a marriage. Debt and spending need honest conversations.');
  assert.ok(money.hashtags.includes('#MoneyAndRelationships'));
  assert.ok(money.hashtags.includes('#MarriageAdvice'));
  assert.ok(money.hashtags.length <= 5);
  assert.equal(new Set(money.hashtags).size, money.hashtags.length);
  assert.ok(!money.hashtags.some(tag => /viral|fyp|nigeria/i.test(tag)));
});

test('script metadata overrides stale input without changing platform selection, title or script', () => {
  const original = { facebook: { enabled: false, caption: 'old' }, tiktok: { enabled: true, hashtags: ['#Wrong'] }, youtube: { enabled: true, title: 'Approved title', description: 'old' } };
  const actual = applyScriptPostMetadata(original, script);
  assert.equal(actual.facebook.enabled, false);
  assert.equal(actual.tiktok.enabled, true);
  assert.equal(actual.youtube.title, 'Approved title');
  assert.equal(actual.youtube.description, openingHook(script));
  assert.deepEqual(actual.tiktok.hashtags, buildPostMetadata(script).hashtags);
  assert.equal(original.facebook.caption, 'old');
  assert.equal(applyScriptPostMetadata('{bad', script), '{bad');
  assert.equal(parsePublishing(applyScriptPostMetadata('{}', script), { mode: 'generate_and_publish' }).errors.length, 1);
});

test('scene projects use quoted speech and visual-only projects retain manual post details', () => {
  assert.equal(spokenScript({ scenes: [{ prompt: 'Presenter says: "Trust takes time. Keep your promises."' }] }), 'Trust takes time. Keep your promises.');
  assert.equal(spokenScript({ scenes: ['A landscape at sunset.'] }), '');
  const manual = { facebook: { caption: 'Sunset', hashtags: ['#Nature'] } };
  assert.equal(applyScriptPostMetadata(manual, ''), manual);
});

test('scheduled retrieval and content publishing derive metadata even when AI omits or invents it', () => {
  const slot = slotInfo('2026-11-02', 'afternoon');
  const item = parseScriptResponse(JSON.stringify({ ...slot, title: 'Approved title', script }), slot);
  assert.equal(item.caption, openingHook(script));
  const publishing = contentPublishing({ ...item, caption: 'Unrelated caption', hashtags: ['#Viral'] }, ['facebook', 'youtube']);
  assert.equal(publishing.facebook.caption, openingHook(script));
  assert.equal(publishing.tiktok.enabled, false);
  assert.equal(publishing.youtube.title, 'Approved title');
  assert.deepEqual(publishing.youtube.hashtags, item.hashtags);
});

test('script preview API supplies the same post metadata as the publisher', () => {
  let payload;
  splitScriptController({ body: { script } }, { json: data => { payload = data; } });
  assert.deepEqual(payload.postMetadata, buildPostMetadata(script));
});

test('manual project publishing uses the hook before validation and before credits are spent', async () => {
  let payload;
  const res = { status(code) { this.code = code; return this; }, json(data) { payload = data; } };
  await generateProjectController({ body: { script, mode: 'generate_and_publish', publishing: JSON.stringify({ facebook: { enabled: true }, youtube: { enabled: true, title: '<invalid>' } }) } }, res);
  assert.equal(res.code, 400);
  assert.equal(payload.error, 'PUBLISHING_VALIDATION_FAILED');
  assert.match(payload.message, /angle|cannot contain/);
  assert.doesNotMatch(payload.message, /caption is required/);
});

test('actual publisher sends hook and tags once, persists metadata, retries only failed platforms', async () => {
  const video = path.join(directory, 'video.mp4'); fs.writeFileSync(video, 'fixture video');
  const job = createProjectJob({ title: 'Approved title', source: 'script', script, scenes: [{ prompt: script }], mode: 'generate_and_publish',
    publishing: { facebook: { enabled: true, caption: 'old' }, tiktok: { enabled: true, caption: 'old' }, youtube: { enabled: true, title: 'Approved title', description: 'old' } } });
  updateJob(job.id, 'completed', { finalVideoPath: video });
  const calls = []; let uploads = 0; let fail = true;
  const options = { upload: async () => { uploads++; return { publicId: 'fixture', secureUrl: 'https://example.test/video.mp4' }; },
    createPost: async input => { calls.push(input); if (input.platform === 'tiktok' && fail) throw new Error('Mock failure'); return { status: 'queued', postId: 'fixture-' + input.platform }; } };
  await publishJob(job.id, options);
  assert.equal(getJob(job.id).status, 'partially_published');
  for (const post of calls) assert.equal(post.text, buildPostText(openingHook(script), buildPostMetadata(script).hashtags));
  assert.equal(calls.find(post => post.platform === 'youtube').platformOptions.metadata.title, 'Approved title');
  const acceptedFacebook = structuredClone(getJob(job.id).publishing.facebook);
  updateJob(job.id, 'partially_published', { script: 'Money should not control your marriage. Discuss bills together.' });
  fail = false; await publishJob(job.id, options);
  assert.deepEqual(calls.map(post => post.platform), ['facebook', 'tiktok', 'youtube', 'tiktok']);
  assert.equal(uploads, 1);
  assert.deepEqual(getJob(job.id).publishing.facebook, acceptedFacebook);
  assert.equal(calls.at(-1).text, buildPostText(openingHook(getJob(job.id).script), buildPostMetadata(getJob(job.id).script).hashtags));
  assert.equal(getJob(job.id).status, 'published');
  assert.deepEqual(getJob(job.id).postMetadata, buildPostMetadata(getJob(job.id).script));
});
