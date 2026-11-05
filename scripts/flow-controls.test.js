import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillPrompt, readPromptInputText, startGeneration, clearReferenceAttachments, ensureReferenceImage, configureGenerationSettings, waitForSceneResult } from '../services/flow.service.js';
import { referenceAsset } from '../services/flow-reference.service.js';
import { fileURLToPath } from 'node:url';

test('Flow controls ignore hidden CAPTCHA, target Start generation, and remove only the ingredient', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <textarea name="g-recaptcha-response" style="display:none"></textarea>
      <div contenteditable="true" role="textbox"></div>
      <button onclick="window.wrongClick = true">Create collection</button>
      <button aria-label="Start generation" onclick="window.submitted = true">arrow_forward</button>
      <button aria-label="Ingredient"><div class="hover-icon-overlay" onclick="this.closest('button').remove()"><mat-icon>cancel</mat-icon></div></button>
      <button aria-label="Trash" onclick="window.wrongClick = true">Trash</button>
    `);
    await page.evaluate(() => document.addEventListener('keydown', event => {
      if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') || event.key === 'Backspace') window.destructiveShortcut = true;
    }));
    await fillPrompt(page, 'The presenter says exactly this scene.');
    assert.equal(await page.locator('[role="textbox"]').innerText(), 'The presenter says exactly this scene.');
    const multiline = 'Keep the same presenter.\n\n## Final rule\nExact dialogue.\nNo background music.';
    await fillPrompt(page, multiline);
    assert.equal(await readPromptInputText(page), multiline.replace(/\s+/g, ' ').trim());
    assert.equal(await page.evaluate(() => Boolean(window.destructiveShortcut)), false);
    await clearReferenceAttachments(page);
    assert.equal(await page.locator('[aria-label="Ingredient"]').count(), 0);
    await startGeneration(page);
    assert.equal(await page.evaluate(() => window.submitted), true);
    assert.equal(await page.evaluate(() => Boolean(window.wrongClick)), false);

    // Flow creates hidden tooltip copies of filenames; those must not mask the visible asset.
    const presenter = fileURLToPath(new URL('../brand/presenter.jpg', import.meta.url));
    const asset = await referenceAsset(presenter);
    await page.setContent(`
      <div style="display:none">${asset.name}</div>
      <button aria-label="Add ingredients to the prompt box" onclick="document.querySelector('#picker').hidden = false">+</button>
      <div id="picker" hidden>
        <button onclick="window.uploadClicked = true">Upload media</button>
        <input aria-label="Search assets">
        <flow-add-menu-asset-list><button role="option"><span>${asset.name}</span></button></flow-add-menu-asset-list>
        <flow-add-menu-detail-pane><img alt="Preview of ${asset.name}">
          <button onclick="document.querySelector('#picker').hidden = true; const chip = document.createElement('button'); chip.setAttribute('aria-label', 'Ingredient'); document.body.append(chip)">Add to prompt</button>
        </flow-add-menu-detail-pane>
      </div>
    `);
    assert.equal(await ensureReferenceImage(page, presenter), 'reused');
    assert.equal(await page.evaluate(() => Boolean(window.uploadClicked)), false);
    await page.locator('[aria-label="Ingredient"]').evaluate(element => element.remove());
    await page.locator('[role="option"]').evaluate(element => {
      element.onclick = () => {
        document.querySelector('#picker').hidden = true;
        const chip = document.createElement('button');
        chip.setAttribute('aria-label', 'Ingredient');
        document.body.append(chip);
      };
    });
    assert.equal(await ensureReferenceImage(page, presenter), 'reused');
    assert.equal(await page.evaluate(() => Boolean(window.uploadClicked)), false);
  } finally {
    await browser.close();
  }
});

test('settings use the exact mode control and selected model without clicking the Videos sidebar', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button onclick="window.wrongNav=true">Videos</button>
      <button aria-label="Settings trigger" onclick="document.querySelector('.cdk-overlay-container').hidden=false">Video · 360p · 6s · 9:16 · x1</button>
      <div class="cdk-overlay-container" hidden>
        <flow-toggles aria-label="Mode"><button role="radio" aria-checked="true">Video</button></flow-toggles>
        <button id="family" aria-label="Select model family" onclick="document.querySelector('#model-option').hidden=false">Omni 1.1 Flash</button>
        <button id="model-option" hidden onclick="document.getElementById('family').textContent='Omni 1.1 Flash';this.hidden=true">Omni 1.1 Flash</button>
        <button role="radio" aria-checked="true">9:16</button>
        <button role="radio" aria-checked="true">360p</button>
        <flow-toggles aria-label="Video duration">
          <button role="radio" aria-checked="true" onclick="this.parentElement.querySelectorAll('button').forEach(b=>b.setAttribute('aria-checked',String(b===this)))">6s</button>
          <button role="radio" aria-checked="false" onclick="this.parentElement.querySelectorAll('button').forEach(b=>b.setAttribute('aria-checked',String(b===this)))">8s</button>
        </flow-toggles>
        <button role="radio" aria-checked="true">x1</button>
      </div>
    `);
    const job = { model: 'Omni 1.1 Flash', aspectRatio: '9:16', duration: '8s' };
    await configureGenerationSettings(page, job);
    assert.equal(await page.getByRole('radio', { name: '8s', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.evaluate(() => Boolean(window.wrongNav)), false);
    await page.getByRole('button', { name: 'Select model family', exact: true }).evaluate(e => e.textContent = 'Other model');
    await configureGenerationSettings(page, { ...job, duration: '6s' });
    assert.equal(await page.getByRole('radio', { name: '6s', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.getByRole('button', { name: 'Select model family', exact: true }).innerText(), 'Omni 1.1 Flash');
    assert.equal(await page.evaluate(() => Boolean(window.wrongNav)), false);
  } finally { await browser.close(); }
});


test('recovery checks multiple candidates by prompt and selects the matching video without generating',async()=>{
 const {config}=await import('../src/config.js');const oldPoll=config.pollIntervalMs;config.pollIntervalMs=5;
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();
 await page.setContent(`<style>flow-video-tile{display:block;width:180px;height:120px}</style>
 <div contenteditable="true" role="textbox"></div>
 <button aria-label="Start generation" onclick="window.submitted=true">Generate</button>
 <flow-video-tile data-media-id="wrong"><img class="thumbnail" src="https://example.test/wrong.png"><button aria-label="Reuse prompt" onclick="window.checked=(window.checked||[]).concat('wrong');document.querySelector('[role=textbox]').innerText='Unrelated prompt';">Reuse</button></flow-video-tile>
 <flow-video-tile data-media-id="wanted"><img class="thumbnail" src="https://example.test/wanted.png"><button aria-label="Reuse prompt" onclick="window.checked=(window.checked||[]).concat('wanted');document.querySelector('[role=textbox]').innerText='Original scene dialogue';">Reuse</button></flow-video-tile>`);
 const checkpoint={baseline:[],projectUrl:'https://flow.google.com/project/original',target:null};const statuses=[];
 const target=await waitForSceneResult(page,checkpoint,'Original scene dialogue',(status,message)=>statuses.push({status,message}),async target=>{checkpoint.target=target;},true,null);
 assert.equal(target.mediaId,'wanted');assert.equal(target.verified,true);
 assert.deepEqual(await page.evaluate(()=>window.checked),['wrong','wanted']);
 assert.equal(await page.evaluate(()=>Boolean(window.submitted)),false);
 assert.ok(statuses.some(s=>/different prompt/.test(s.message)));
 }finally{config.pollIntervalMs=oldPoll;await browser.close();}
});
