import fs from 'node:fs/promises';
import { getFlowPageForAccount, closeBrowser } from '../src/browser.js';
import { getActiveAccountId } from '../src/accounts.js';
import { openFlow, ensureLoggedIn, prepareGeneration, fillPrompt, ensureReferenceImage, clearReferenceAttachments, configureGenerationSettings } from '../services/flow.service.js';
import { config } from '../src/config.js';
import { ensureRuntimeFolders } from '../src/downloads.js';
import { brandAssetPath } from '../services/brand.service.js';
import { savedFlowProjectUrl, rememberFlowProject } from '../src/flow-workspaces.js';
import { buildScenePrompt } from '../services/scene-queue.service.js';

await ensureRuntimeFolders();
let page;
try {
  page = await getFlowPageForAccount(getActiveAccountId());
  await openFlow(page, await savedFlowProjectUrl(getActiveAccountId()));
  await ensureLoggedIn(page);
  await prepareGeneration(page);
  await rememberFlowProject(getActiveAccountId(), page.url());
  const promptProject = process.argv.find(value => value.startsWith('--prompt-project='))?.split('=')[1];
  if (promptProject) {
    if (!/^vid_[\d_]+$/.test(promptProject)) throw new Error('Invalid project ID');
    const meta = JSON.parse(await fs.readFile(`${config.projectDownloadDir}/${promptProject}/project.json`, 'utf8'));
    const tilesBefore = await page.locator('flow-video-tile, flow-image-tile').count();
    await fillPrompt(page, buildScenePrompt(meta.globalInstructions, meta.scenes[0].prompt));
    if (await page.locator('flow-video-tile, flow-image-tile').count() !== tilesBefore) throw new Error('Media count changed while filling prompt');
    console.log('Original multiline project prompt verified; project media unchanged. No generation submitted.');
  }
  if (process.argv.includes('--configure')) {
    await configureGenerationSettings(page, { model: config.defaultModel, aspectRatio: config.defaultAspectRatio, duration: '6s' });
    await configureGenerationSettings(page, { model: config.defaultModel, aspectRatio: config.defaultAspectRatio, duration: '8s' });
    await configureGenerationSettings(page, { model: config.defaultModel, aspectRatio: config.defaultAspectRatio, duration: '6s' });
    console.log('Settings selection verified for 6s, 8s, then 6s. No generation submitted.');
  }
  if (process.argv.includes('--reopen')) {
    await page.context().close();
    page = await getFlowPageForAccount(getActiveAccountId());
    await openFlow(page, await savedFlowProjectUrl(getActiveAccountId()));
    await ensureLoggedIn(page);
    console.log('Closed Chrome context was replaced successfully without a retry loop.');
  }
  if (process.argv.includes('--settings')) {
    await page.getByRole('button', { name: 'Settings trigger', exact: true }).click();
    await page.waitForTimeout(600);
    await fs.writeFile('tmp/flow-settings.html', await page.locator('.cdk-overlay-container').evaluateAll(elements => elements.map(e => e.outerHTML).join('\n')));
    await fs.writeFile('tmp/flow-settings.txt', await page.locator('body').innerText());
  }
  if (process.argv.includes('--tiles')) {
    await fs.writeFile('tmp/flow-tiles.json', JSON.stringify(await page.locator('flow-video-tile').evaluateAll(tiles => tiles.map(tile => ({
      attributes: [...tile.attributes].map(a => [a.name, a.value]),
      parent: tile.parentElement.outerHTML.slice(0, 1000),
      html: tile.outerHTML
    }))), null, 2));
  }
  if (process.argv.includes('--picker')) {
    await page.getByRole('button', { name: 'Add ingredients to the prompt box', exact: true }).click();
    await page.getByRole('button', { name: 'Upload media', exact: true }).waitFor({ state: 'visible' });
    await page.waitForTimeout(5000);
    await fs.writeFile('tmp/flow-picker.txt', await page.locator('body').innerText());
    await fs.writeFile('tmp/flow-picker.html', await page.locator('flow-asset-picker, [role="dialog"], .cdk-overlay-container').evaluateAll(elements => elements.map(e => e.outerHTML).join('\n')));
  }
  if (process.argv.includes('--reference')) {
    await fillPrompt(page, 'Storyboard reuse check.');
    const presenter = brandAssetPath('presenter');
    console.log('First attachment:', await ensureReferenceImage(page, presenter));
    console.log('Second attachment:', await ensureReferenceImage(page, presenter));
    await clearReferenceAttachments(page);
    console.log('Reattachment:', await ensureReferenceImage(page, presenter));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await prepareGeneration(page);
    await fillPrompt(page, 'Storyboard reuse check after reload.');
    console.log('Attachment after reload:', await ensureReferenceImage(page, presenter));
  }
  await page.screenshot({ path: 'screenshots/reuse-inspect.png' });
  await fs.writeFile('tmp/flow-dom.json', JSON.stringify(await page.evaluate(() => ({
    url: location.href,
    buttons: [...document.querySelectorAll('button')].map(b => ({
      text: b.innerText, label: b.getAttribute('aria-label'), html: b.outerHTML.slice(0, 2000)
    })),
    inputs: [...document.querySelectorAll('textarea,[contenteditable]')].map(e => e.outerHTML)
  })), null, 2));
  console.log('Inspection saved (no generation submitted).');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: 'screenshots/reuse-inspect-error.png' }).catch(() => {});
    await fs.writeFile('tmp/flow-inspect-error.txt', await page.locator('body').innerText().catch(() => '')).catch(() => {});
  }
  throw error;
} finally {
  await closeBrowser();
}
