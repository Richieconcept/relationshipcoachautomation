// Re-runs the editor (logo, music, captions) on a project already on disk. No Flow credits are used.
//
//   npm run edit:project -- <jobId>
//   npm run edit:project -- <jobId> --script my-script.txt    spoken words for older projects without project.json
//   npm run edit:project -- <jobId> --no-music --no-logo       switch steps off
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { requireFfmpeg } from '../services/ffmpeg.service.js';
import { finalVideoPath, joinedVideoPath, projectPaths, readProjectMeta } from '../services/project-files.service.js';
import { splitScript } from '../services/script-splitter.service.js';
import { validateVideo } from '../services/video-validator.service.js';
import { editVideo, parseEditingOptions, planEditing } from '../services/video-editor.service.js';
import { prepareSceneClips } from '../services/pacing.service.js';
import { concatenateClips } from '../services/video-assembler.service.js';
import { getJob, updateJob } from '../src/jobs.js';

const args = process.argv.slice(2);
const scriptIndex = args.indexOf('--script');
const scriptFile = scriptIndex >= 0 ? args[scriptIndex + 1] : null;
const jobId = args.find((arg, index) => !arg.startsWith('--') && (scriptIndex < 0 || index !== scriptIndex + 1));

if (!jobId) {
  console.error('Usage: npm run edit:project -- <jobId> [--script file.txt] [--no-logo] [--no-music] [--no-captions]');
  process.exit(1);
}

await requireFfmpeg();
const paths = projectPaths(jobId);
if (!existsSync(paths.root)) {
  console.error(`No project folder at ${paths.root}`);
  process.exit(1);
}

// Normalized clips have the exact timing of the joined video; raw clips are the fallback.
const clipDir = args.includes('--rebuild') ? paths.rawDir : existsSync(paths.normalizedDir) ? paths.normalizedDir : paths.rawDir;
const clipFiles = (await fs.readdir(clipDir)).filter((name) => /^scene_\d{3}\.mp4$/.test(name)).sort();
if (clipFiles.length === 0) {
  console.error(`No scene clips in ${clipDir}`);
  process.exit(1);
}

let spokenTexts = [];
if (scriptFile) {
  const { scenes } = splitScript(await fs.readFile(scriptFile, 'utf8'));
  spokenTexts = scenes.map((scene) => scene.text);
  if (scenes.length !== clipFiles.length) {
    console.warn(`Warning: the script splits into ${scenes.length} scenes but the project has ${clipFiles.length} clips; captions are matched by order.`);
  }
} else {
  const meta = await readProjectMeta(jobId);
  spokenTexts = meta?.scenes?.map((scene) => scene.spokenText || '') || [];
  if (!meta) {
    console.warn('No project.json: captions need --script <file> with the spoken words.');
  }
}

let clips = [];
let pacingReport = null;
for (const [index, name] of clipFiles.entries()) {
  const clipPath = path.join(clipDir, name);
  const info = await validateVideo(clipPath);
  clips.push({ path: clipPath, duration: info.duration, spokenText: spokenTexts[index] || '' });
}

// Projects made before editing existed only have <id>_final.mp4 (unedited); keep it as the joined input.
const joinedPath = joinedVideoPath(jobId);
const outputPath = finalVideoPath(jobId);
if (args.includes('--rebuild')) {
  const meta = await readProjectMeta(jobId);
  if (!meta?.scenes?.length) throw new Error('Rebuilding pacing requires the saved scene metadata.');
  const job = { id: jobId, aspectRatio: meta.aspectRatio, scenes: meta.scenes.map(scene => ({ ...scene })) };
  const prepared = await prepareSceneClips(job, console.log);
  clips = prepared.clips;
  pacingReport = prepared.pacing;
  await concatenateClips(clips.map(clip => clip.path), joinedPath, prepared);
} else {
  const pacing = await fs.readFile(path.join(paths.root, 'pacing.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (pacing) clips.forEach((clip, index) => { clip.overlapWithNext = index < clips.length - 1 ? pacing.transitionSeconds : 0; });
}
if (!existsSync(joinedPath)) {
  if (!existsSync(outputPath)) {
    console.error(`No joined or final video in ${paths.finalDir}`);
    process.exit(1);
  }
  await fs.copyFile(outputPath, joinedPath);
  console.log(`Kept the unedited video as ${path.basename(joinedPath)}`);
}

const options = parseEditingOptions({
  logo: !args.includes('--no-logo'),
  music: !args.includes('--no-music'),
  captions: !args.includes('--no-captions')
});
const plan = planEditing(options, { hasSpokenText: clips.some((clip) => clip.spokenText) });
for (const reason of Object.values(plan.skipped)) {
  console.warn(`Skipped: ${reason}`);
}
if (!plan.any) {
  console.error('Nothing to do: no edit step can run.');
  process.exit(1);
}

const started = Date.now();
const result = await editVideo({ inputPath: joinedPath, outputPath, clips, plan });
const final = await validateVideo(outputPath);
const savedJob = getJob(jobId);
if (savedJob) updateJob(jobId, savedJob.status, {
  finalVideo: final,
  pacing: pacingReport || savedJob.pacing,
  editingResult: { applied: result.applied, skipped: plan.skipped, captionLines: result.captions?.lines ?? 0 },
  message: `Updated video ready: ${final.duration}s, ${final.width}x${final.height}.`
});
console.log(`Edited in ${Math.round((Date.now() - started) / 1000)}s:`, result.applied);
if (result.captions) {
  console.log(`Captions: ${result.captions.words} words in ${result.captions.lines} lines (${result.captions.path})`);
}
console.log(`Final video: ${outputPath} (${final.duration}s, ${final.width}x${final.height})`);
