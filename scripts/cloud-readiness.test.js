import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-readiness-fixture-'));
process.env.FLOW_JOB_STATE_DIR = path.join(directory, 'jobs');
const { default: routes } = await import('../routes/video.routes.js');
test('private setup checks reject missing or incorrect tokens and report missing Google sign-in without opening Chrome', async () => {
 const previousToken = process.env.CLOUD_SETUP_TOKEN; const previousState = process.env.FLOW_SESSION_STATE;
 process.env.CLOUD_SETUP_TOKEN = 'fixture-private-token'; delete process.env.FLOW_SESSION_STATE;
 const app = express(); app.use('/api/videos', routes); const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
 const base = 'http://127.0.0.1:' + server.address().port + '/api/videos/cloud';
 try {
  for (const endpoint of ['/check-services', '/check-google']) {
   assert.equal((await fetch(base + endpoint, { method: 'POST' })).status, 403);
   assert.equal((await fetch(base + endpoint, { method: 'POST', headers: { authorization: 'Bearer wrong-fixture-token' } })).status, 403);
  }
  const response = await fetch(base + '/check-google', { method: 'POST', headers: { authorization: 'Bearer fixture-private-token' } });
  assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.ready, false); assert.equal(data.code, 'GOOGLE_LOGIN_REQUIRED'); assert.ok(!JSON.stringify(data).includes('fixture-private-token'));
  delete process.env.CLOUD_SETUP_TOKEN;
  assert.equal((await fetch(base + '/check-google', { method: 'POST' })).status, 403);
 } finally { await new Promise(r => server.close(r)); if (previousToken === undefined) delete process.env.CLOUD_SETUP_TOKEN; else process.env.CLOUD_SETUP_TOKEN = previousToken; if (previousState === undefined) delete process.env.FLOW_SESSION_STATE; else process.env.FLOW_SESSION_STATE = previousState; }
});
test.after(async () => { assert.ok(directory.startsWith(path.join(os.tmpdir(), 'cloud-readiness-fixture-'))); await fs.rm(directory, { recursive: true, force: true }); });
