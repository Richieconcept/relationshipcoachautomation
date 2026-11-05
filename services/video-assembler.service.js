import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { runFfmpeg } from './ffmpeg.service.js';
import { validateVideo, VideoValidationError } from './video-validator.service.js';

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_BITRATE = '192k';
// Broadcast-style loudness target so scenes play at a similar volume (no music, dialogue untouched).
const LOUDNORM_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11';

function blendSegments(filters, segments, requested, fps = config.outputFps) {
  if (segments.length === 1) return { ...segments[0], overlap: 0 };
  const overlap = Math.max(0, Math.min(requested, ...segments.map(segment => segment.duration / 4)));
  if (!overlap) {
    filters.push(`${segments.map(s => `[${s.video}][${s.audio}]`).join('')}concat=n=${segments.length}:v=1:a=1[joinv][joina]`);
    return { video: 'joinv', audio: 'joina', duration: segments.reduce((sum, s) => sum + s.duration, 0), overlap: 0 };
  }
  let result = segments[0];
  segments.slice(1).forEach((next, index) => {
    const offset = Math.max(0, result.duration - overlap);
    const video = `blendv${index}`, audio = `blenda${index}`;
    filters.push(`[${result.video}][${next.video}]xfade=transition=fade:duration=${overlap}:offset=${offset},fps=${fps},settb=AVTB[${video}]`);
    filters.push(`[${result.audio}][${next.audio}]acrossfade=d=${overlap}:c1=tri:c2=tri[${audio}]`);
    result = { video, audio, duration: result.duration + next.duration - overlap };
  });
  return { ...result, overlap };
}

export function outputDimensions(aspectRatio) {
  return aspectRatio === '16:9'
    ? { width: 1920, height: 1080 }
    : { width: 1080, height: 1920 };
}

/**
 * Re-encode one clip to the project standard: fixed resolution (scaled to fit, padded, never stretched),
 * constant frame rate, H.264 + AAC 48 kHz stereo, loudness-normalised audio trimmed/padded to the video length.
 * Clips without audio get a silent track so every clip can be concatenated.
 * trimTo (seconds) cuts the clip short, e.g. to drop the silence after the presenter's last word.
 */
export async function normalizeClip(inputPath, outputPath, options) {
  const {
    width,
    height,
    fps = config.outputFps,
    clipInfo,
    trimTo = null,
    keepRanges = null,
    blendSeconds = 0,
    speedFactor = 1
  } = options;
  const info = clipInfo || await validateVideo(inputPath);
  if (!Number.isFinite(speedFactor) || speedFactor < 1 || speedFactor > 1.25) throw new Error('Scene speed must be between 1x and 1.25x.');
  const duration = trimTo ? Math.min(info.duration, trimTo) : info.duration;

  const videoFilter = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${fps}`,
    'format=yuv420p'
  ].join(',');

  const args = ['-filter_complex_threads', '1', '-i', inputPath];
  let audioFilter;
  let audioInput;

  if (info.hasAudio) {
    audioInput = '0:a:0';
    audioFilter = `${LOUDNORM_FILTER},aresample=${AUDIO_SAMPLE_RATE},apad`;
  } else {
    args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SAMPLE_RATE}`);
    audioInput = '1:a:0';
    audioFilter = 'apad';
  }

  const ranges = keepRanges || [{ start: 0, end: duration }];
  const filters = [`[0:v:0]${videoFilter},settb=AVTB[basev]`, `[${audioInput}]${audioFilter}[basea]`];
  if (ranges.length > 1) {
    filters.push(`[basev]split=${ranges.length}${ranges.map((_, i) => `[inv${i}]`).join('')}`);
    filters.push(`[basea]asplit=${ranges.length}${ranges.map((_, i) => `[ina${i}]`).join('')}`);
  }
  const segments = ranges.map((range, index) => {
    filters.push(`[${ranges.length > 1 ? `inv${index}` : 'basev'}]trim=start=${range.start}:end=${range.end},setpts=PTS-STARTPTS,fps=${fps},settb=AVTB[rangev${index}]`);
    filters.push(`[${ranges.length > 1 ? `ina${index}` : 'basea'}]atrim=start=${range.start}:end=${range.end},asetpts=PTS-STARTPTS[rangea${index}]`);
    return { video: `rangev${index}`, audio: `rangea${index}`, duration: range.end - range.start };
  });
  const result = blendSegments(filters, segments, blendSeconds, fps);
  filters.push(`[${result.video}]setpts=(PTS-STARTPTS)/${speedFactor},fps=${fps},format=yuv420p[vout]`);
  filters.push(`[${result.audio}]atempo=${speedFactor},apad,atrim=duration=${result.duration / speedFactor},asetpts=PTS-STARTPTS[aout]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    // Audio is padded above and cut here, so audio and video end together and long projects never drift.
    '-t', String(result.duration / speedFactor),
    '-c:v', config.outputVideoCodec,
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', config.outputAudioCodec,
    '-b:a', AUDIO_BITRATE,
    '-ar', String(AUDIO_SAMPLE_RATE),
    '-ac', '2',
    '-movflags', '+faststart',
    outputPath
  );

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runFfmpeg(args);
  return validateVideo(outputPath);
}

// True when stream-copy concatenation is safe without re-encoding.
export function clipsAreCompatible(clipInfos) {
  const [first] = clipInfos;
  return clipInfos.every((info) => info.hasAudio
    && info.width === first.width
    && info.height === first.height
    && info.fps === first.fps
    && info.videoCodec === first.videoCodec
    && info.pixelFormat === first.pixelFormat
    && info.audioCodec === first.audioCodec
    && info.audioSampleRate === first.audioSampleRate
    && info.audioChannels === first.audioChannels);
}

function concatListLine(filePath) {
  const normalized = path.resolve(filePath).split(path.sep).join('/').replace(/'/g, "'\\''");
  return `file '${normalized}'`;
}

/**
 * Join clips with straight cuts in the exact order given (the scene array order, not filesystem order).
 * Clips must already share encoding parameters (see normalizeClip / clipsAreCompatible).
 */
export async function concatenateClips(clipPaths, outputPath, { transitionSeconds = 0, clips = [] } = {}) {
  if (clipPaths.length === 0) {
    throw new Error('No clips to assemble.');
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (clipPaths.length > 1 && transitionSeconds > 0) {
    if (clips.length !== clipPaths.length) throw new Error('Scene durations are required for smooth transitions.');
    const filters = [];
    const segments = clips.map((clip, index) => {
      filters.push(`[${index}:v]setpts=PTS-STARTPTS,fps=${config.outputFps},settb=AVTB[v${index}]`);
      filters.push(`[${index}:a]aresample=48000,asetpts=PTS-STARTPTS[a${index}]`);
      return { video: `v${index}`, audio: `a${index}`, duration: clip.duration };
    });
    const result = blendSegments(filters, segments, transitionSeconds);
    await runFfmpeg([
      '-filter_complex_threads', '1', ...clipPaths.flatMap(file => ['-i', file]),
      '-filter_complex', filters.join(';'), '-map', `[${result.video}]`, '-map', `[${result.audio}]`,
      '-t', String(result.duration), '-c:v', config.outputVideoCodec, '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', config.outputAudioCodec, '-b:a', AUDIO_BITRATE, '-ar', '48000', '-ac', '2', '-movflags', '+faststart', outputPath
    ]);
    return outputPath;
  }
  const listPath = path.join(path.dirname(outputPath), 'concat-list.txt');
  await fs.writeFile(listPath, `${clipPaths.map(concatListLine).join('\n')}\n`, 'utf8');

  await runFfmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    outputPath
  ]);

  return listPath;
}

/**
 * Validate the assembled file and check its length roughly matches the sum of the clips,
 * so a silently dropped scene is caught before the project is marked completed.
 */
export async function validateFinalVideo(outputPath, expectedDuration) {
  const info = await validateVideo(outputPath);
  const tolerance = Math.max(1.5, expectedDuration * 0.1);

  if (expectedDuration > 0 && Math.abs(info.duration - expectedDuration) > tolerance) {
    throw new VideoValidationError(
      `Final video is ${info.duration}s but the scenes add up to ${expectedDuration}s.`,
      { duration: info.duration, expectedDuration }
    );
  }

  logger.info('Final video validated', { outputPath, duration: info.duration, expectedDuration });
  return info;
}
