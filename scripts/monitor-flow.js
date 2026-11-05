import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { closeBrowser } from '../src/browser.js';
import { ensureRuntimeFolders } from '../src/downloads.js';
import { brandAssetPath } from '../services/brand.service.js';
import { generateFlowScene } from '../services/flow.service.js';
import { validateVideo } from '../services/video-validator.service.js';

const [projectId, sceneArgument = '1'] = process.argv.slice(2);
if (!/^vid_\d+$/.test(projectId || '') || !/^\d+$/.test(sceneArgument)) {
  throw new Error('Usage: node scripts/monitor-flow.js PROJECT_ID SCENE_NUMBER (generates one clip; uses Flow credits).');
}
await ensureRuntimeFolders();
const project = JSON.parse(await fs.readFile(path.join(config.projectDownloadDir, projectId, 'project.json'), 'utf8'));
const scene = project.scenes.find(item => item.number === Number(sceneArgument));
if (!scene) throw new Error('Scene not found in the saved project.');
const label = `${projectId}_check_scene_${scene.number}_${Date.now()}`;
const directory = path.join(config.projectDownloadDir, projectId, 'checks');
await fs.mkdir(directory, { recursive: true });
const outputPath = path.join(directory, `${label}.mp4`);
const events = [];
const startedAt = Date.now();
let outcome;
try {
  const result = await generateFlowScene({
    prompt: [project.globalInstructions, scene.prompt].filter(Boolean).join('\n\n'),
    referenceImage: brandAssetPath('presenter'),
    aspectRatio: project.aspectRatio,
    duration: scene.duration,
    outputPath,
    logLabel: label,
    screenshotPrefix: label,
    maxRetries: 0,
    onStatus(status, message, extra) {
      const event = { at: new Date().toISOString(), status, message, ...extra };
      events.push(event);
      console.log(JSON.stringify(event));
    }
  });
  outcome = { success: true, ...result, video: await validateVideo(outputPath) };
} catch (error) {
  outcome = { success: false, code: error.automationCode || error.code, message: error.message, screenshotPath: error.screenshotPath };
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(directory, `${label}.json`), JSON.stringify({
    ...outcome, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), events
  }, null, 2));
  console.log(JSON.stringify(outcome));
  await closeBrowser();
}
