import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { planPacing, planSceneSpeeds } from '../services/pacing.service.js';
import { detectSpeechActivity, buildCaptionsAss, timeWords } from '../services/captions.service.js';
import { normalizeClip, concatenateClips } from '../services/video-assembler.service.js';
import { runFfmpeg, runFfprobeJson } from '../services/ffmpeg.service.js';
import { validateVideo } from '../services/video-validator.service.js';
import { getBrandDefaults, saveBrandDefaults, resolveGlobalInstructions } from '../services/brand-defaults.service.js';

test('pacing keeps short natural pauses and speech guards, and does not cut an all-silent or unreliable clip', () => {
  const plan = planPacing([{ start: 0.8, end: 2 }, { start: 2.4, end: 3 }, { start: 5, end: 6 }], 8);
  assert.equal(plan.ranges.length, 2);
  assert.ok(plan.ranges[0].start < 0.8 && plan.ranges[0].end > 3);
  assert.ok(plan.ranges[1].start < 5 && plan.ranges[1].end > 6);
  assert.equal(planPacing([], 8).removedSeconds, 0);
  assert.equal(planPacing([{ start: 0, end: 8 }], 8).removedSeconds, 0);
});

test('saved instructions persist, blank input uses the default, and an override does not replace it', async () => {
  const directory = await fs.mkdtemp(fileURLToPath(new URL('../tmp/defaults-test-', import.meta.url)));
  const previous = config.brandDir;
  config.brandDir = directory;
  try {
    await saveBrandDefaults({ globalInstructions: 'Same presenter and Nigerian voice.' });
    assert.equal((await getBrandDefaults()).globalInstructions, 'Same presenter and Nigerian voice.');
    assert.equal(await resolveGlobalInstructions('  '), 'Same presenter and Nigerian voice.');
    assert.equal(await resolveGlobalInstructions('A one-video change'), 'A one-video change');
    assert.equal((await getBrandDefaults()).globalInstructions, 'Same presenter and Nigerian voice.');
  } finally { config.brandDir = previous; await fs.rm(directory, { recursive: true, force: true }); }
});

test('pace matching only speeds reliable slow scenes, caps changes, and ignores normal pauses and outliers', () => {
  const words = 'one two three four five six seven eight nine ten eleven twelve';
  const scene = seconds => ({ spokenText: words, activity: { reliable: true, segments: [{ start: 0, end: seconds }] } });
  const settings = { matchScenePace: true, maxSceneSpeed: 1.10, scenePaceTolerance: 0.10 };
  const result = planSceneSpeeds([scene(6), scene(4), scene(4), scene(2.4), { spokenText: 'Hi there', activity: { reliable: true, segments: [{ start: 0, end: 1 }] } }], settings);
  assert.equal(result.referenceWordsPerSecond, 3);
  assert.deepEqual(result.scenes.map(s => s.speedFactor), [1.10, 1, 1, 1, 1]);
  assert.equal(planSceneSpeeds([scene(4.4), scene(4), scene(4)], settings).scenes[0].speedFactor, 1);
  assert.ok(planSceneSpeeds([scene(6), scene(4)], settings).scenes.every(s => s.speedFactor === 1));
  assert.ok(planSceneSpeeds([scene(6), scene(4), scene(4)], { ...settings, matchScenePace: false }).scenes.every(s => s.speedFactor === 1));
  const unreliable = { ...scene(8), activity: { reliable: false, segments: [{ start: 0, end: 8 }] } };
  assert.equal(planSceneSpeeds([unreliable, scene(4), scene(4), scene(4)], settings).scenes[0].speedFactor, 1);
  // A long pause does not lower the speech rate: only active speech time is compared.
  const paused = { spokenText: words, activity: { reliable: true, segments: [{ start: 0, end: 2 }, { start: 8, end: 10 }] } };
  assert.equal(planSceneSpeeds([paused, scene(4), scene(4)], settings).scenes[0].speedFactor, 1);
});

test('real FFmpeg trims long silence, blends the cuts, and preserves audio/video timing', async () => {
  const directory = await fs.mkdtemp(fileURLToPath(new URL('../tmp/editor-test-', import.meta.url)));
  try {
    const raw = path.join(directory, 'raw.mp4'), edited = path.join(directory, 'edited.mp4'), joined = path.join(directory, 'joined.mp4');
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x284:r=30:d=6', '-f', 'lavfi', '-i',
      'aevalsrc=if(between(t\\,0.5\\,1.5)+between(t\\,3\\,4.5)\\,0.25*sin(2*PI*440*t)\\,0):s=48000:d=6',
      '-c:v', 'libx264', '-c:a', 'aac', '-ac', '2', '-shortest', raw]);
    const activity = await detectSpeechActivity(raw, 6);
    assert.equal(activity.reliable, true);
    const plan = planPacing(activity.segments, 6);
    assert.ok(plan.removedSeconds > 2);
    const clip = await normalizeClip(raw, edited, { width: 160, height: 284, keepRanges: plan.ranges, blendSeconds: 0.08 });
    assert.ok(clip.duration < 3.5 && clip.duration > 2.5);
    assert.equal(clip.hasAudio, true);
    await concatenateClips([edited, edited], joined, { transitionSeconds: 0.08, clips: [clip, clip] });
    const final = await validateVideo(joined);
    assert.ok(Math.abs(final.duration - (clip.duration * 2 - 0.08)) < 0.12);
    assert.equal(final.hasAudio, true);
    const fastPath = path.join(directory, 'faster.mp4');
    const faster = await normalizeClip(raw, fastPath, { width: 160, height: 284, keepRanges: plan.ranges, blendSeconds: 0.08, speedFactor: 1.20 });
    assert.ok(Math.abs(faster.duration - clip.duration / 1.20) < 0.08);
    const probe = await runFfprobeJson(fastPath);
    const videoDuration = Number(probe.streams.find(s => s.codec_type === 'video').duration);
    const audioDuration = Number(probe.streams.find(s => s.codec_type === 'audio').duration);
    assert.ok(Math.abs(videoDuration - audioDuration) < 0.08, `Video ${videoDuration}s and audio ${audioDuration}s must end together`);
    const fastSpeech = await detectSpeechActivity(fastPath, faster.duration);
    const captionWords = timeWords('One two three four five six', fastSpeech.segments);
    assert.ok(captionWords.at(-1).end <= faster.duration + 0.01);
    const wavePath = path.join(directory, 'pitch.wav');
    await runFfmpeg(['-i', fastPath, '-ss', '0.35', '-t', '0.35', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wavePath]);
    const wave = await fs.readFile(wavePath);
    let dataStart = 0, dataLength = 0;
    for (let cursor = 12; cursor + 8 <= wave.length;) {
      const size = wave.readUInt32LE(cursor + 4);
      if (wave.toString('ascii', cursor, cursor + 4) === 'data') { dataStart = cursor + 8; dataLength = size; break; }
      cursor += 8 + size + (size % 2);
    }
    assert.ok(dataLength > 0);
    let crossings = 0;
    for (let cursor = dataStart + 2; cursor < dataStart + dataLength; cursor += 2) {
      if (wave.readInt16LE(cursor - 2) <= 0 && wave.readInt16LE(cursor) > 0) crossings++;
    }
    const frequency = crossings / (dataLength / 2 / 48000);
    assert.ok(Math.abs(frequency - 440) < 10, `Pitch changed to ${frequency}Hz`);
    const { ass } = buildCaptionsAss([{ word: 'Hello', start: 0.4, end: 0.8 }], { width: 1080, height: 1920 });
    assert.match(ass, /Caption,Bangers,124,&H00FFFFFF/);
    assert.match(ass, /\\c&H0066FF66\\fscx108\\fscy108\\t\(0,\d+,\\fscx140\\fscy140\)/);
    assert.match(ass, /\\t\(\d+,180,\\fscx118\\fscy118\)/);
    assert.match(ass, /HELLO\{\\c&H00FFFFFF\\fscx100\\fscy100\}/);
    assert.match(ass, /,384,1/);
    await fs.writeFile(path.join(directory, 'captions.ass'), ass);
    const fontCheck = await runFfmpeg(['-i', joined, '-ss', '0.5', '-vf', 'ass=captions.ass:fontsdir=../../brand/fonts', '-frames:v', '1', '-f', 'null', '-'], { cwd: directory });
    assert.match(fontCheck.stderr, /fontselect: .*Bangers.*-> Bangers-Regular/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('very slow scenes receive a bounded adjustment and overlapping detection never double-counts speech',()=>{
 const words='one two three four five six seven eight nine ten eleven twelve';const scene=seconds=>({spokenText:words,activity:{reliable:true,segments:[{start:0,end:seconds}]}});const result=planSceneSpeeds([scene(8),scene(4),scene(4)],{matchScenePace:true,maxSceneSpeed:1.2,scenePaceTolerance:0.1});assert.equal(result.scenes[0].speedFactor,1.2);assert.equal(result.scenes[0].limited,true);assert.equal(result.scenes[0].reviewRecommended,true);assert.equal(result.scenes[1].speedFactor,1);const overlapping={spokenText:words,activity:{reliable:true,segments:[{start:0,end:3},{start:2,end:4},{start:-2,end:2},{start:NaN,end:5}]}};assert.equal(planSceneSpeeds([overlapping,scene(4),scene(4)],{matchScenePace:true}).scenes[0].speechSeconds,4);
});

test('retained pauses expose a slow opening even when its active word rate looks normal',()=>{const words='Ladies, you can correct your man without making him feel like he is nothing.';const scene=(seconds,retained)=>({spokenText:words,activity:{reliable:true,segments:[{start:0,end:seconds}]},retainedSeconds:retained});const result=planSceneSpeeds([scene(4,5.5),scene(4,4.5),scene(4,4.5)],{matchScenePace:true,maxSceneSpeed:1.2,scenePaceTolerance:0.05});assert.equal(result.scenes[0].speedFactor,1.2);assert.equal(result.scenes[1].speedFactor,1);});
test('word complexity affects delivery comparisons and tight tolerance catches a six percent slowdown',()=>{const scene=(text,seconds)=>({spokenText:text,activity:{reliable:true,segments:[{start:0,end:seconds}]}});const short='one one one one one one one one';const long='relationship relationship relationship relationship relationship relationship relationship relationship';const result=planSceneSpeeds([scene(short,4),scene(long,4),scene(long,4)],{matchScenePace:true,maxSceneSpeed:1.2,scenePaceTolerance:0.05});assert.equal(result.scenes[0].speedFactor,1.2);assert.equal(result.scenes[1].speedFactor,1);const tight=planSceneSpeeds([scene(short,4.26),scene(short,4),scene(short,4)],{matchScenePace:true,maxSceneSpeed:1.2,scenePaceTolerance:0.05});assert.ok(tight.scenes[0].speedFactor>1.05);});
