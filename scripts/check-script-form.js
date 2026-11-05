import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://localhost:3000');
  await page.waitForFunction(() => document.querySelector('#default-global-instructions')?.value.length > 0);
  assert.equal(await page.locator('#globalInstructions').inputValue(), '');
  assert.equal(await page.locator('.video-overrides').getAttribute('open'), null);
  const defaults = await page.locator('#default-global-instructions').inputValue();
  await page.locator('.brand-panel > summary').click();
  await page.locator('#save-default-instructions').click();
  await page.locator('#defaults-message').filter({ hasText: 'Saved.' }).waitFor();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#default-global-instructions')?.value.length > 0);
  assert.equal(await page.locator('#default-global-instructions').inputValue(), defaults);
  let submitted = '';
  await page.route('**/api/videos/generate-project', async route => {
    submitted = route.request().postData() || '';
    await route.fulfill({ status: 202, json: { success: true, jobId: 'vid_ui_check', status: 'queued' } });
  });
  await page.route('**/api/videos/jobs/vid_ui_check', route => route.fulfill({ json: {
    success: true, jobId: 'vid_ui_check', type: 'project', title: 'UI check', status: 'completed',
    message: 'Form verification only; no generation submitted.', scenes: [], totalScenes: 0, completedScenes: 0
  } }));
  await page.locator('#script').fill('Your peace matters. Choose people who respect you.');
  await page.locator('button[value="generate_only"]').click();
  await page.waitForFunction(() => document.querySelector('#job-id')?.textContent === 'vid_ui_check');
  assert.ok(submitted.includes('Your peace matters.'));
  assert.ok(!submitted.includes(defaults.slice(0, 100)));
  assert.ok(!submitted.includes('filename='));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'screenshots/script-only-form.png', fullPage: true });
  console.log('Script-only form, persistent defaults, and saved-instructions UI verified. No generation request reached the server.');
} finally { await browser.close(); }
