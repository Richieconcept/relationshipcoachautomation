import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import multer from 'multer';
import { chromium } from 'playwright';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-platforms-fixture-'));
process.env.FLOW_JOB_STATE_DIR = path.join(directory, 'jobs');
const { splitScriptController } = await import('../controllers/video.controller.js');
const script = 'Trust grows through honest communication. Listen carefully to your partner.';
test.after(async () => { assert.ok(directory.startsWith(path.join(os.tmpdir(), 'manual-platforms-fixture-'))); await fs.rm(directory, { recursive: true, force: true }); });
async function fixture(run) {
 const app = express(); app.use(express.json()); let submitted = null; let settingsWrites = 0; let release;
 app.get('/api/brand/defaults', (_req, res) => res.json({ defaults: { globalInstructions: '' } }));
 app.get('/api/brand', (_req, res) => res.json({ assets: {} }));
 app.get('/api/videos/accounts', (_req, res) => res.json({ accounts: [] }));
 app.post('/api/videos/split-script', splitScriptController);
 app.get('/api/content', async (_req, res) => { if (run.delayed) await new Promise(resolve => { release = resolve; }); res.json({ success: true, settings: { enabled: false, autoPublish: false, platforms: [] }, publishingDefaults: { platforms: run.defaults || ['facebook', 'youtube'] } }); });
 app.put('/api/content/settings', (_req, res) => { settingsWrites++; res.json({ success: true }); });
 app.post('/api/videos/generate-project', multer().none(), (req, res) => { submitted = req.body; res.status(400).json({ message: 'Fixture submit only; no video or post created.' }); });
 app.use(express.static(path.resolve(import.meta.dirname, '../public')));
 const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
 const browser = await chromium.launch({ channel: 'chrome', headless: true });
 try {
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  if (run.draft) await page.addInitScript(draft => { if (!localStorage.getItem('flow-project-draft')) localStorage.setItem('flow-project-draft', JSON.stringify(draft)); }, { script, ...run.draft });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.locator('.publishing-disclosure > summary').click();
  await run.check({ page, submitted: () => submitted, release: () => release(), requests: () => settingsWrites });
  assert.equal(settingsWrites, 0); assert.deepEqual(errors, []);
 } finally { release?.(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
test('legacy empty manual draft restores only preferred Facebook/YouTube destinations and submits them to a fixture', async () => fixture({
 draft: { publishing: { facebookEnabled: false, youtubeEnabled: false, tiktokEnabled: false } },
 check: async ({ page, submitted }) => {
  await page.waitForFunction(() => document.querySelector('[name=facebookEnabled]').checked && document.querySelector('[name=youtubeEnabled]').checked);
  assert.equal(await page.locator('[name=tiktokEnabled]').isChecked(), false);
  assert.equal(await page.locator('#generate-only-button').innerText(), 'Generate Only');
  assert.equal(await page.locator('#script').inputValue(), script);
  await page.getByRole('button', { name: 'Generate & Publish', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#form-error').textContent.includes('Fixture submit only'));
  const publishing = JSON.parse(submitted().publishing);
  assert.equal(publishing.facebook.enabled, true); assert.equal(publishing.youtube.enabled, true); assert.equal(publishing.tiktok.enabled, false);
  assert.equal(submitted().mode, 'generate_and_publish');
 }
}));
test('saved explicit choices survive defaults; intentionally deselecting all remains valid for Generate Only', async () => fixture({
 draft: { publishing: { facebookEnabled: false, youtubeEnabled: true, tiktokEnabled: false } },
 check: async ({ page, submitted }) => {
  await page.waitForFunction(() => document.querySelector('#project-form').dataset.automaticPosting === 'false');
  assert.equal(await page.locator('[name=facebookEnabled]').isChecked(), false);
  await page.locator('[name=youtubeEnabled]').uncheck(); await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-form').dataset.automaticPosting === 'false');
  assert.equal(await page.locator('[name=facebookEnabled]').isChecked(), false); assert.equal(await page.locator('[name=youtubeEnabled]').isChecked(), false);
  await page.getByRole('button', { name: 'Generate & Publish', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#form-error').textContent.includes('Enable at least one platform'));
  assert.equal(await page.locator('.publishing-disclosure').evaluate(node => node.open), true); assert.equal(submitted(), null);
 }
}));
test('choosing a platform while settings load is preserved', async () => fixture({
 delayed: true, draft: { publishing: { facebookEnabled: false, youtubeEnabled: false, tiktokEnabled: false } },
 check: async ({ page, release }) => {
  await page.locator('[name=youtubeEnabled]').check(); release();
  await page.waitForFunction(() => document.querySelector('#project-form').dataset.automaticPosting === 'false');
  assert.equal(await page.locator('[name=facebookEnabled]').isChecked(), false); assert.equal(await page.locator('[name=youtubeEnabled]').isChecked(), true);
 }
}));
