import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const directory = await fs.mkdtemp(path.join(root, 'tmp', 'publication-test-'));
process.env.FLOW_JOB_STATE_DIR = path.join(directory, 'jobs');
const { config } = await import('../src/config.js');
config.projectDownloadDir = path.join(directory, 'projects');
const { createProjectJob, updateJob } = await import('../src/jobs.js');
const { ensureProjectFolders, rawScenePath, finalVideoPath, cleanupProjectFiles } = await import('../services/project-files.service.js');
const { cleanupPublishedMedia, publicationConfirmed } = await import('../services/published-media.service.js');
const { publishJob, refreshPublishingStatus, canRetryPublishing } = await import('../services/publishing.service.js');
const { startPublicationMonitor } = await import('../services/publication-monitor.service.js');
const { getVideoPost } = await import('../services/buffer.service.js');
test.after(async () => {
  assert.ok(directory.startsWith(path.join(root, 'tmp') + path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
async function fixture(statuses = ['published', 'published'], mode = 'generate_and_publish') {
  const job = createProjectJob({ title: 'Fixture', scenes: ['A landscape'], mode,
    publishing: { facebook: { enabled: true, caption: 'Landscape' }, youtube: { enabled: true, title: 'Landscape', description: 'Landscape' } } });
  await ensureProjectFolders(job.id);
  await fs.writeFile(rawScenePath(job.id, 1), 'raw fixture');
  await fs.writeFile(finalVideoPath(job.id), 'final fixture');
  return updateJob(job.id, 'published', { finalVideoPath: finalVideoPath(job.id), finalVideoUrl: '/local/final.mp4', joinedVideoPath: '/local/joined.mp4', joinedVideoUrl: '/local/joined.mp4',
    scenes: job.scenes.map(scene => ({ ...scene, videoPath: rawScenePath(job.id, scene.number), normalizedPath: 'fixture-normalized' })),
    publishingResults: Object.fromEntries(['facebook', 'youtube'].map((platform, i) => [platform, { status: statuses[i], postId: platform + '-' + job.id }])),
    cloudinary: { secureUrl: 'https://example.test/video.mp4', publicId: job.id } });
}
const exists = file => fs.access(file).then(() => true, () => false);

test('only confirmed posts delete raw, normalized and final media; brand assets remain', async () => {
  const brand = path.join(directory, 'brand'); await fs.mkdir(brand); await fs.writeFile(path.join(brand, 'presenter.png'), 'presenter'); await fs.writeFile(path.join(brand, 'music.mp3'), 'music');
  const job = await fixture(); const video = job.finalVideoPath;
  await cleanupPublishedMedia(job.id);
  assert.equal(await exists(video), false);
  assert.equal(await exists(path.dirname(path.dirname(video))), false);
  assert.ok(job.localMediaDeletedAt); assert.equal(job.finalVideoUrl, null); assert.equal(job.joinedVideoUrl, null);
  assert.equal(job.scenes[0].videoPath, null); assert.equal(job.scenes[0].normalizedPath, null);
  assert.ok(job.publishingResults.youtube.postId); assert.ok(job.cloudinary.secureUrl);
  assert.equal(await fs.readFile(path.join(brand, 'presenter.png'), 'utf8'), 'presenter');
  assert.equal(await fs.readFile(path.join(brand, 'music.mp3'), 'utf8'), 'music');
  let calls = 0; await cleanupPublishedMedia(job.id, { removeFiles: async () => { calls++; } }); assert.equal(calls, 0);
});

test('queued, sending, failed, draft, approval and generate-only videos are retained', async () => {
  for (const status of ['queued', 'scheduled', 'publishing', 'failed', 'draft', 'pending']) {
    const job = await fixture(['published', status]); await cleanupPublishedMedia(job.id);
    assert.equal(publicationConfirmed(job), false); assert.equal(await exists(job.finalVideoPath), true);
  }
  const job = await fixture(undefined, 'generate_only'); await cleanupPublishedMedia(job.id); assert.equal(await exists(job.finalVideoPath), true);
  const empty = await fixture(); empty.publishing = {}; await cleanupPublishedMedia(empty.id); assert.equal(await exists(empty.finalVideoPath), true);
});

test('cleanup failures keep media references and can be retried', async () => {
  const job = await fixture(); const video = job.finalVideoPath;
  await cleanupPublishedMedia(job.id, { removeFiles: async () => { throw new Error('File is locked'); } });
  assert.equal(job.localMediaDeletedAt, undefined); assert.match(job.mediaCleanupError, /locked/); assert.equal(job.finalVideoPath, video);
  await cleanupPublishedMedia(job.id); assert.ok(job.localMediaDeletedAt); assert.equal(job.mediaCleanupError, null);
});

test('concurrent cleanup requests share one deletion', async () => {
  const job = await fixture(); let calls = 0;
  await Promise.all([1,2,3].map(() => cleanupPublishedMedia(job.id, { removeFiles: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); } })));
  assert.equal(calls, 1);
});

test('Buffer delayed publication triggers cleanup without submitting another post', async () => {
  const job = await fixture(['published', 'publishing']); let calls = 0;
  await refreshPublishingStatus(job.id, { getPost: async postId => { calls++; return { postId, status: 'published', bufferStatus: 'sent', externalLink: 'https://example.test/published' }; } });
  assert.equal(calls, 1); assert.ok(job.localMediaDeletedAt); assert.equal(job.publishingResults.youtube.externalLink, 'https://example.test/published');
});

test('unknown remote status retains files; confirmed remote error is surfaced', async () => {
  const job = await fixture(['published', 'publishing']); const video = job.finalVideoPath;
  await refreshPublishingStatus(job.id, { getPost: async () => { throw new Error('Network unavailable'); } });
  assert.equal(job.publishingResults.youtube.status, 'publishing'); assert.equal(await exists(video), true);
  await refreshPublishingStatus(job.id, { getPost: async postId => ({ postId, status: 'failed', bufferStatus: 'error' }) });
  assert.equal(job.status, 'partially_published'); assert.equal(await exists(video), true); assert.ok(canRetryPublishing(job));
});

test('publisher cleans immediately after all platforms confirm sent and does not repost on repeat', async () => {
  const job = await fixture(['pending', 'pending']); let calls = 0;
  job.publishingResults = {}; const options = { createPost: async () => ({ postId: 'confirmed-' + ++calls, status: 'published', bufferStatus: 'sent' }), upload: async () => { throw Error('Must reuse upload'); } };
  await publishJob(job.id, options); assert.ok(job.localMediaDeletedAt); assert.equal(calls, 2);
  await publishJob(job.id, options); assert.equal(calls, 2); assert.equal(job.status, 'published');
});

test('cleanup rejects traversal and malformed IDs', async () => {
  for (const id of ['..', '../brand', 'vid_1/../../brand', 'vid_1/../vid_2', '']) await assert.rejects(cleanupProjectFiles(id), /Invalid project/);
});

test('monitor checks persisted posts independently of script scheduling', async () => {
  const job = await fixture(['published', 'publishing']); let resolve; const done = new Promise(r => { resolve = r; });
  const stop = startPublicationMonitor({ jobs: () => [job], refresh: async id => { assert.equal(id, job.id); resolve(); }, intervalMs: 60000 });
  await done; stop();
});

test('Buffer status lookup uses a read-only query and maps sent to published', async () => {
  const original = globalThis.fetch; const key = config.buffer.apiKey; config.buffer.apiKey = 'fixture-key';
  globalThis.fetch = async (_url, options) => { const body = JSON.parse(options.body); assert.match(body.query, /query GetPost/); assert.doesNotMatch(body.query, /mutation/); assert.deepEqual(body.variables, { input: { id: 'fixture-post' } });
    return { ok: true, status: 200, json: async () => ({ data: { post: { id: 'fixture-post', status: 'sent', externalLink: 'https://example.test/posted' } } }) }; };
  try { const post = await getVideoPost('fixture-post'); assert.equal(post.status, 'published'); assert.equal(post.externalLink, 'https://example.test/posted'); }
  finally { globalThis.fetch = original; config.buffer.apiKey = key; }
});
