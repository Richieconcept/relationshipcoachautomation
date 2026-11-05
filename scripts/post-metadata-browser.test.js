import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';
import { buildPostMetadata } from '../services/post-metadata.service.js';
import { ContentStore, slotInfo } from '../services/content-plan.service.js';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'post-metadata-browser-'));
process.env.FLOW_JOB_STATE_DIR = path.join(directory, 'jobs');
const { ContentScheduler } = await import('../services/content-scheduler.service.js');
const { contentRoutes } = await import('../routes/content.routes.js');
const { splitScriptController } = await import('../controllers/video.controller.js');
const { default: multer } = await import('multer');
const root = fileURLToPath(new URL('..', import.meta.url));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('main page previews automatic metadata, replaces stale drafts and submits it even before debounce', async () => {
  const app = express(); app.use(express.json());
  app.get('/api/brand/defaults', (req, res) => res.json({ defaults: { globalInstructions: '' } }));
  app.get('/api/brand', (req, res) => res.json({ assets: {} }));
  app.get('/api/videos/accounts', (req, res) => res.json({ accounts: [] }));
  app.post('/api/videos/split-script', splitScriptController);
  let submitted;
  app.post('/api/videos/generate-project', multer().none(), (req, res) => { submitted = req.body; res.status(400).json({ message: 'Fixture: no generation or posting.' }); });
  app.use(express.static(path.join(root, 'public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    const script = 'Love needs healthy boundaries. Discuss your expectations with your partner.';
    await page.addInitScript(script => !localStorage.getItem('flow-project-draft') && localStorage.setItem('flow-project-draft', JSON.stringify({ script, title: 'He Pretended to Be Poor to Find Out Who His Real Friends Were',
      publishing: { youtubeTitle: 'He Pretended to Be Poor to Find Out Who His Real Friends Were', facebookCaption: 'Stale caption', facebookHashtags: '#Wrong' } })), script);
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => document.querySelector('[name=facebookCaption]').value.startsWith('Love needs'));
    assert.equal(await page.locator('#title').inputValue(), '');
    assert.equal(await page.locator('[name=youtubeTitle]').inputValue(), buildPostMetadata(script).caption.slice(0, 100));
    assert.equal(await page.locator('[name=facebookCaption]').inputValue(), buildPostMetadata(script).caption);
    assert.equal(await page.locator('[name=facebookHashtags]').inputValue(), buildPostMetadata(script).hashtags.join(' '));
    assert.equal(await page.locator('[name=facebookCaption]').evaluate(input => input.readOnly), true);
    await page.locator('#script').fill('Money can divide a marriage. Discuss your bills openly.');
    await page.locator('.publishing-disclosure > summary').click();
    await page.locator('[name=facebookEnabled]').check();
    await page.getByRole('button', { name: 'Generate & Publish', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#form-error').textContent.includes('Fixture:'));
    const post = JSON.parse(submitted.publishing);
    assert.equal(post.facebook.caption, 'Money can divide a marriage.');
    assert.equal(post.youtube.title, 'Money can divide a marriage.');
    assert.equal(submitted.title, '');
    assert.ok(post.facebook.hashtags.includes('#MoneyAndRelationships'));
    assert.equal(post.tiktok.enabled, false);
    assert.equal(submitted.script, 'Money can divide a marriage. Discuss your bills openly.');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[name=facebookCaption]').value.startsWith('Money can'));
    await page.locator('[name=inputMode][value=scenes]').check();
    await page.locator('.scene-prompt').fill('Presenter says: "Trust takes time. Keep your promises."');
    assert.equal(await page.locator('[name=tiktokCaption]').inputValue(), 'Trust takes time.');
    await page.locator('.scene-prompt').fill('A quiet sunset with no dialogue.');
    assert.equal(await page.locator('[name=tiktokCaption]').inputValue(), '');
    assert.equal(await page.locator('[name=tiktokCaption]').evaluate(input => input.readOnly), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('weekly script editor previews and saves derived captions without a separate metadata form',async()=>{
 const store=new ContentStore(path.join(directory,'content'));
 const item=store.ensure('2026-11-02','afternoon');store.update(item.id,{status:'script_ready',title:'Approved title',script:'Respect is essential. Set healthy boundaries.'});
 const scheduler=new ContentScheduler({store,findJob:()=>null,jobById:()=>null});const app=express();app.use(express.json());app.use('/api/content',contentRoutes(scheduler).router);app.use(express.static(path.join(root,'public')));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const browser=await chromium.launch({channel:'chrome',headless:true});try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/content.html');await page.locator('#week-start').fill('2026-11-02');await page.locator('#load-week').click();await page.waitForFunction(()=>document.querySelector('.week-slot').dataset.date==='2026-11-02');
  const card=page.locator('.week-slot[data-slot="afternoon"]').first();await card.locator(':scope > summary').click();await card.locator('.slot-meta > summary').click();assert.ok((await card.locator('.script-meta').last().innerText()).includes('Respect is essential.'));const script='Can trust survive dishonesty? Be honest with your partner.';await card.locator('textarea').fill(script);assert.ok((await card.locator('.script-meta').last().innerText()).includes('#TrustInRelationships'));await page.locator('#save-week').click();await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('scripts saved'));assert.equal(store.state.items[item.id].caption,buildPostMetadata(script).caption);assert.deepEqual(store.state.items[item.id].hashtags,buildPostMetadata(script).hashtags);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
