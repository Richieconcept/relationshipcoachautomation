import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright';

test('manual workspace follows delayed publication and hides deleted local downloads', async () => {
  const app = express(); let cleared = false; let reads = 0;
  app.get('/api/brand/defaults', (_req, res) => res.json({ defaults: {} }));
  app.get('/api/brand', (_req, res) => res.json({ assets: {} }));
  app.get('/api/videos/accounts', (_req, res) => res.json({ accounts: [] }));
  app.get('/api/content', (_req, res) => res.json({ success: true, settings: { enabled: false, scriptSource: 'manual', autoPublish: false, platforms: ['youtube'] }, items: [] }));
  app.get('/api/videos/jobs/vid_123', (_req, res) => { reads++; res.json({ success: true, type: 'project', jobId: 'vid_123', mode: 'generate_and_publish', status: 'published', title: 'Fixture', message: cleared ? 'Published. Local video files cleared automatically.' : 'Sent to Buffer.', totalScenes: 1, completedScenes: 1, scenes: [],
    finalVideoUrl: cleared ? null : '/fixture.mp4', joinedVideoUrl: cleared ? null : '/fixture.mp4',
    localMediaDeletedAt: cleared ? new Date().toISOString() : null, publishing: { youtube: { status: cleared ? 'published' : 'publishing', postId: 'fixture' } } }); });
  app.get('/fixture.mp4', (_req, res) => res.status(204).end());
  app.use(express.static(path.resolve(import.meta.dirname, '../public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('flow-last-project-job', 'vid_123'));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => !document.querySelector('#video-preview').hidden);
    assert.equal(await page.getByRole('button', { name: 'Generate & Publish', exact: true }).isEnabled(), true);
    cleared = true;
    await page.waitForFunction(() => document.querySelector('#phase-message').textContent.includes('local video files cleared'), { timeout: 10000 });
    assert.equal(await page.locator('#video-preview').isVisible(), false);
    assert.equal(await page.locator('#video-preview').getAttribute('src'), null);
    assert.ok(reads >= 2); assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
});
