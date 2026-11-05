import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { detectSpeechActivity } from './captions.service.js';
import { validateVideo } from './video-validator.service.js';
import { normalizeClip, outputDimensions, clipsAreCompatible } from './video-assembler.service.js';
import { rawScenePath, normalizedScenePath, projectPaths } from './project-files.service.js';
import { countWords } from './script-splitter.service.js';

const round = value => Math.round(value * 1000) / 1000;

// Approximate English syllables avoid treating "relationship" like "a".
// This is a pacing estimate, not speech recognition or a transcript verifier.
function speechUnits(text) {
 return (String(text || '').match(/[a-z]+(?:'[a-z]+)?/gi) || []).reduce((sum, word) => {
  const stem = word.toLowerCase().replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  return sum + Math.max(1, (stem.match(/[aeiouy]+/g) || []).length);
 }, 0);
}
const medianOf = values => {const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length ? (sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2) : null;};

export function planSceneSpeeds(scenes, options = config.editor) {
  const metrics = scenes.map(scene => {
    const words = countWords(scene.spokenText);
    // Count only valid, non-overlapping detected speech, never quiet gaps.
    const segments = scene.activity?.reliable && Array.isArray(scene.activity.segments)
      ? scene.activity.segments.filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end > segment.start).sort((a,b)=>a.start-b.start) : [];
    let speechSeconds = 0; let previousEnd = 0;
    for (const segment of segments) { speechSeconds += Math.max(0, segment.end - Math.max(previousEnd, segment.start)); previousEnd = Math.max(previousEnd, segment.end); }
    const rate = speechSeconds > 0 ? words / speechSeconds : 0;
    const units = speechUnits(scene.spokenText);
    const retainedSeconds = Number.isFinite(scene.retainedSeconds) && scene.retainedSeconds >= speechSeconds ? scene.retainedSeconds : speechSeconds;
    return { words, speechUnits: units, speechSeconds: round(speechSeconds), retainedSeconds: round(retainedSeconds), syllablesPerSecond: speechSeconds > 0 ? units / speechSeconds : 0, deliverySyllablesPerSecond: retainedSeconds > 0 ? units / retainedSeconds : 0, wordsPerSecond: round(rate), eligible: words >= 6 && speechSeconds >= 2 && rate >= 0.8 && rate <= 5.5 };
  });
  const rates = metrics.filter(metric => metric.eligible).map(metric => metric.wordsPerSecond).sort((a, b) => a - b);
  const median = medianOf(rates);
  const eligible = metrics.filter(metric=>metric.eligible);
  const speechReference = medianOf(eligible.map(metric=>metric.syllablesPerSecond));
  const deliveryReference = medianOf(eligible.map(metric=>metric.deliverySyllablesPerSecond));
  const limit = Math.max(1, Math.min(1.25, Number(options.maxSceneSpeed) || 1.20));
  const tolerance = Math.max(0.05, Math.min(0.3, Number(options.scenePaceTolerance) || 0.05));
  return {
    referenceWordsPerSecond: median === null ? null : round(median),
    referenceSyllablesPerSecond: speechReference === null ? null : round(speechReference),
    referenceDeliverySyllablesPerSecond: deliveryReference === null ? null : round(deliveryReference),
    scenes: metrics.map(metric => {
      const ratio = metric.eligible ? Math.max(speechReference / metric.syllablesPerSecond, deliveryReference / metric.deliverySyllablesPerSecond) : 1;
      const slower = options.matchScenePace && rates.length >= 3 && metric.eligible && ratio > 1 / (1 - tolerance);
      const speedFactor = slower ? round(Math.min(limit, ratio)) : 1;
      const desiredSpeedFactor = slower ? round(ratio) : 1;
      const limited = desiredSpeedFactor > limit;
      const reviewRecommended = slower && ratio / speedFactor > 1 / (1 - tolerance);
      return { ...metric, speedFactor, desiredSpeedFactor, limited, reviewRecommended, reason: speedFactor > 1 ? (limited ? 'Slower speech; safe acceleration limit applied' : 'Matched speech and retained pauses to project delivery pace') : !options.matchScenePace ? 'Pace matching disabled' : !metric.eligible || rates.length < 3 ? 'Insufficient reliable speech for comparison' : 'Already within the natural pace range' };
    })
  };
}

export function planPacing(segments, duration, options = config.editor) {
  const full = [{ start: 0, end: duration }];
  if (!options.smartPacing || !segments.length) return { ranges: full, removedSeconds: 0 };
  const speech = segments.filter(s => s.start >= 0 && s.end > s.start && s.end <= duration + 0.05);
  if (!speech.length) return { ranges: full, removedSeconds: 0 };
  const lead = Math.max(0.08, options.speechLeadSeconds);
  const tail = Math.max(0.12, options.speechTailSeconds);
  const pause = Math.max(0.24, options.keptPauseSeconds);
  let start = speech[0].start > 0.3 ? Math.max(0, speech[0].start - lead) : 0;
  const end = duration - speech.at(-1).end > 0.3 ? Math.min(duration, speech.at(-1).end + tail) : duration;
  const ranges = [];
  for (let index = 0; index < speech.length - 1; index++) {
    const gap = speech[index + 1].start - speech[index].end;
    if (gap <= Math.max(options.longPauseSeconds, pause + 0.2)) continue;
    ranges.push({ start: round(start), end: round(speech[index].end + pause / 2) });
    start = speech[index + 1].start - pause / 2;
  }
  ranges.push({ start: round(start), end: round(end) });
  const kept = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  if (kept < 1.5 || duration - kept < 0.2) return { ranges: full, removedSeconds: 0 };
  return { ranges, removedSeconds: round(duration - kept) };
}

export async function prepareSceneClips(job, onStatus = () => {}) {
  const infos = [];
  const plans = [];
  const activities = [];
  for (const scene of job.scenes) {
    scene.videoPath ||= rawScenePath(job.id, scene.number);
    const info = await validateVideo(scene.videoPath);
    infos.push(info);
    const activity = info.hasAudio && scene.spokenText && (config.editor.smartPacing || config.editor.matchScenePace)
      ? await detectSpeechActivity(scene.videoPath, info.duration) : null;
    activities.push(activity);
    plans.push(activity?.reliable ? planPacing(activity.segments, info.duration) : { ranges: [{ start: 0, end: info.duration }], removedSeconds: 0 });
  }
  const speeds = planSceneSpeeds(job.scenes.map((scene, index) => ({ spokenText: scene.spokenText, activity: activities[index], retainedSeconds: plans[index].ranges.reduce((sum,range)=>sum+range.end-range.start,0) - Math.max(0,plans[index].ranges.length-1) * (config.editor.smartPacing ? config.editor.cutBlendSeconds : 0) })));
  const normalize = config.normalizeVideo || !clipsAreCompatible(infos) || plans.some(p => p.removedSeconds > 0) || speeds.scenes.some(scene => scene.speedFactor > 1);
  const clips = [];
  const report = [];
  for (const [index, scene] of job.scenes.entries()) {
    const plan = plans[index];
    const speed = speeds.scenes[index];
    onStatus(`Preparing scene ${scene.number}: ${plan.removedSeconds ? `shortening ${plan.removedSeconds}s of excess silence` : 'keeping natural pauses'}${speed.speedFactor > 1 ? `; gently increasing speech pace to ${speed.speedFactor}x` : ''}.`);
    const output = normalize ? normalizedScenePath(job.id, scene.number) : scene.videoPath;
    const info = normalize ? await normalizeClip(scene.videoPath, output, {
      ...outputDimensions(job.aspectRatio), clipInfo: infos[index], keepRanges: plan.ranges,
      blendSeconds: config.editor.smartPacing ? config.editor.cutBlendSeconds : 0,
      speedFactor: speed.speedFactor
    }) : infos[index];
    scene.normalizedPath = output;
    clips.push({ path: output, duration: info.duration, spokenText: scene.spokenText || '', info });
    report.push({ scene: scene.number, originalSeconds: infos[index].duration, editedSeconds: info.duration, ranges: plan.ranges, ...speed });
  }
  const transitionSeconds = config.editor.smartPacing && clips.length > 1
    ? Math.max(0, Math.min(config.editor.cutBlendSeconds, ...clips.map(c => c.duration / 4))) : 0;
  clips.forEach((clip, index) => { clip.overlapWithNext = index < clips.length - 1 ? transitionSeconds : 0; });
  const expectedDuration = clips.reduce((sum, clip) => sum + clip.duration - clip.overlapWithNext, 0);
  const pacing = { originalSeconds: infos.reduce((sum, info) => sum + info.duration, 0), editedSeconds: round(expectedDuration), transitionSeconds, referenceWordsPerSecond: speeds.referenceWordsPerSecond, referenceSyllablesPerSecond: speeds.referenceSyllablesPerSecond, referenceDeliverySyllablesPerSecond: speeds.referenceDeliverySyllablesPerSecond, scenes: report };
  await fs.mkdir(projectPaths(job.id).root, { recursive: true });
  await fs.writeFile(path.join(projectPaths(job.id).root, 'pacing.json'), JSON.stringify(pacing, null, 2));
  return { clips, expectedDuration, transitionSeconds, pacing };
}
