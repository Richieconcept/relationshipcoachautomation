import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { getActiveAccountId } from '../src/accounts.js';
import { getFlowPageForAccount, closeBrowser } from '../src/browser.js';
import { savedFlowProjectUrl } from '../src/flow-workspaces.js';
import { brandAssetPath } from '../services/brand.service.js';
import { referenceAsset } from '../services/flow-reference.service.js';
import { sceneCheckpoints, sceneFingerprint, recoverableScene } from '../services/flow-recovery.service.js';
import { openFlow, ensureLoggedIn, readVideoTiles, readPromptInputText, generateFlowScene } from '../services/flow.service.js';
import { validateVideo } from '../services/video-validator.service.js';

const [projectId, sceneNumber = '1'] = process.argv.slice(2);
if (!/^vid_[\d_]+$/.test(projectId || '')) throw new Error('Supply a saved project ID. This check downloads an existing scene; it never submits a generation.');
const meta = JSON.parse(await fs.readFile(path.join(config.projectDownloadDir, projectId, 'project.json'), 'utf8'));
const scene = meta.scenes.find(item => item.number === Number(sceneNumber));
if (!scene) throw new Error('Scene not found.');
const accountId = getActiveAccountId();
const directory = path.join(config.projectDownloadDir, projectId, 'checks');
await fs.mkdir(directory, { recursive: true });
const options = {
  prompt: [meta.globalInstructions, scene.prompt].filter(Boolean).join('\n\n'),
  referenceImage: brandAssetPath('presenter'), aspectRatio: meta.aspectRatio,
  model: meta.model || config.defaultModel, duration: scene.duration || config.defaultDuration,
  outputPath: path.join(directory, `recovered_scene_${sceneNumber}_${Date.now()}.mp4`),
  maxRetries: 0, logLabel: 'Live download recovery check',
  onStatus: (status, message) => console.log(JSON.stringify({ status, message }))
};
try {
  const page = await getFlowPageForAccount(accountId);
  await openFlow(page, await savedFlowProjectUrl(accountId));
  await ensureLoggedIn(page);
  await page.waitForSelector('flow-video-tile', { timeout: 20000 });
  const matches = [];
  for (const tile of await readVideoTiles(page)) {
    const locator = page.locator('flow-video-tile').nth(tile.index);
    await locator.hover();
    await locator.getByRole('button', { name: 'Reuse prompt', exact: true }).click();
    await page.waitForTimeout(750);
    if (await readPromptInputText(page) === options.prompt.replace(/\s+/g, ' ').trim()) matches.push(tile);
  }
  assert.equal(matches.length, 1, 'Recovery check requires exactly one existing video with the original scene prompt.');
  const target = { src: matches[0].src, thumbnail: matches[0].thumbnail, verified: true };
  const fingerprint = sceneFingerprint(options, options.referenceImage ? (await referenceAsset(options.referenceImage)).name : null);
  await sceneCheckpoints.save(options.outputPath, {
    version: 1, fingerprint, accountId, projectUrl: page.url(), stage: 'generated',
    baseline: [], target, submittedAt: new Date().toISOString()
  });
  await assert.rejects(recoverableScene({ ...options, fingerprint, accountId }, {
    validate: validateVideo, open: async () => {}, status: () => {},
    prepare: async () => { throw new Error('Must not prepare a new generation'); },
    submit: async () => { throw new Error('Must never submit'); },
    wait: async () => target,
    download: async () => { throw new Error('Simulated download interruption'); }
  }), /Simulated download interruption/);
  assert.equal((await sceneCheckpoints.read(options.outputPath)).stage, 'generated');
  await closeBrowser();
  const recovered = await generateFlowScene(options);
  await closeBrowser();
  const local = await generateFlowScene(options);
  assert.equal(local.recovered, true);
  const report = { ...recovered, video: await validateVideo(options.outputPath), simulatedDownloadFailure: true, reopenedBrowser: true, reusedLocalFile: true };
  await fs.writeFile(`${options.outputPath}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await closeBrowser();
}
