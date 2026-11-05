import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
const root = path.resolve(import.meta.dirname, '..');
const directory = await fs.mkdtemp(path.join(root, 'tmp', 'hosted-controls-'));
process.env.FLOW_JOB_STATE_DIR = path.join(directory, 'jobs');
const { config } = await import('../src/config.js');
const { ContentStore } = await import('../services/content-plan.service.js');
const { ContentScheduler } = await import('../services/content-scheduler.service.js');
const { contentRoutes } = await import('../routes/content.routes.js');
test('hosted mode supports same-origin proxy requests; local mode and cross-origin controls remain restricted', async () => {
  const original = config.allowRemoteControls;
  const store = new ContentStore(path.join(directory, 'content'));
  let scripts = 0;
  const scheduler = new ContentScheduler({ store, requestScript: async () => { scripts++; throw Error('No scheduled scripts expected'); }, findJob: () => null, jobById: () => null });
  const app = express(); app.set('trust proxy', 1);
  app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.2', configurable: true }); next(); });
  app.use('/api/content', contentRoutes(scheduler).router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    config.allowRemoteControls = false;
    assert.equal((await fetch(url + '/api/content')).status, 403);
    config.allowRemoteControls = true;
    const response = await fetch(url + '/api/content', { headers: { origin: url.replace('http:', 'https:'), 'x-forwarded-proto': 'https' } });
    assert.equal(response.status, 200); const data = await response.json();
    assert.equal(data.settings.enabled, false); assert.equal(data.settings.scriptSource, 'manual');
    assert.equal((await fetch(url + '/api/content', { headers: { origin: 'https://unrelated.example' } })).status, 403);
    await scheduler.tick(new Date('2026-11-05T19:00:00Z')); assert.equal(scripts, 0);
  } finally { config.allowRemoteControls = original; await new Promise(r => server.close(r)); }
});
test.after(async () => { assert.ok(directory.startsWith(path.join(root, 'tmp') + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
