import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { brandAssetPath, brandFontsDir } from './brand.service.js';
import { buildCaptionsAss, detectSpeechSegments, timeWords } from './captions.service.js';
import { runFfmpeg } from './ffmpeg.service.js';
import { validateVideo } from './video-validator.service.js';

export const EDIT_STEPS = ['logo', 'music', 'captions'];

export class EditingError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EditingError';
    this.code = 'EDITING_FAILED';
    this.automationCode = 'EDITING_FAILED';
    this.details = details;
  }
}

// Accepts { logo, music, captions } booleans, a JSON string of that, or nothing (everything on).
export function parseEditingOptions(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  const options = {};
  for (const step of EDIT_STEPS) {
    const flag = value?.[step];
    options[step] = flag === undefined ? true : flag === true || flag === 'true' || flag === 'on' || flag === '1';
  }
  return options;
}

/**
 * Decides which edit steps will actually run: a step needs to be switched on and have what it needs
 * (a logo file, a music file, spoken words). Skipped steps come back with a reason instead of failing the video.
 */
export function planEditing(options, { hasSpokenText }) {
  const logoPath = options.logo ? brandAssetPath('logo') : null;
  const musicPath = options.music ? brandAssetPath('music') : null;
  const captions = Boolean(options.captions && hasSpokenText);

  const skipped = {};
  if (options.logo && !logoPath) {
    skipped.logo = 'No logo uploaded (Brand panel).';
  }
  if (options.music && !musicPath) {
    skipped.music = 'No background music uploaded (Brand panel).';
  }
  if (options.captions && !hasSpokenText) {
    skipped.captions = 'No spoken words known for these scenes. Use Script mode or put the spoken line in "quotes".';
  }

  return {
    logoPath,
    musicPath,
    captions,
    any: Boolean(logoPath || musicPath || captions),
    skipped
  };
}

function logoOverlayPosition(position, margin) {
  const x = position.endsWith('left') ? `${margin}` : `W-w-${margin}`;
  const y = position.startsWith('bottom') ? `H-h-${margin}` : `${margin}`;
  return `${x}:${y}`;
}

// A relative fontsdir avoids escaping Windows drive colons inside the filter string.
function fontsDirOption(cwd) {
  const fontsDir = brandFontsDir();
  if (!fontsDir) {
    return '';
  }
  const relative = path.relative(cwd, fontsDir).split(path.sep).join('/');
  if (relative.includes(':')) {
    logger.warn('brand/fonts is on a different drive from the project folder; using system fonts for captions');
    return '';
  }
  return `:fontsdir=${relative}`;
}

/**
 * Builds word timings for the whole video from each clip's spoken text.
 * clips: [{ path, duration, spokenText }] in playback order.
 */
export async function timeCaptionWords(clips) {
  const timed = [];
  let offset = 0;
  for (const clip of clips) {
    if (clip.spokenText) {
      const segments = await detectSpeechSegments(clip.path, clip.duration);
      timed.push(...timeWords(clip.spokenText, segments, offset));
    }
    offset += clip.duration - (clip.overlapWithNext || 0);
  }
  return timed;
}

/**
 * One FFmpeg pass over the assembled video: logo overlay, background music mixed under the voice
 * (ducked while the presenter talks, faded in/out, looped if short), and burned-in word-by-word captions.
 */
export async function editVideo({ inputPath, outputPath, clips, plan }) {
  const input = await validateVideo(inputPath);
  const { width, height, duration } = input;
  const workDir = path.dirname(outputPath);
  await fs.mkdir(workDir, { recursive: true });

  const applied = { logo: false, music: false, captions: false };
  const args = ['-i', path.resolve(inputPath)];
  const filters = [];
  let nextInput = 1;
  let videoLabel = '0:v';

  if (plan.logoPath) {
    const logoInput = nextInput++;
    args.push('-i', path.resolve(plan.logoPath));
    const logoWidth = Math.max(2, Math.round((width * config.editor.logoWidthPercent) / 100 / 2) * 2);
    const opacity = Math.min(1, Math.max(0, config.editor.logoOpacity));
    filters.push(`[${logoInput}:v]scale=${logoWidth}:-1,format=rgba,colorchannelmixer=aa=${opacity}[logo]`);
    filters.push(`[${videoLabel}][logo]overlay=${logoOverlayPosition(config.editor.logoPosition, config.editor.logoMarginPx)}:format=auto[vlogo]`);
    videoLabel = 'vlogo';
    applied.logo = true;
  }

  let captionsInfo = null;
  if (plan.captions) {
    const timed = await timeCaptionWords(clips);
    if (timed.length > 0) {
      const { ass, lines, words } = buildCaptionsAss(timed, { width, height });
      const captionsPath = path.join(workDir, 'captions.ass');
      await fs.writeFile(captionsPath, ass, 'utf8');
      filters.push(`[${videoLabel}]ass=captions.ass${fontsDirOption(workDir)}[vcap]`);
      videoLabel = 'vcap';
      applied.captions = true;
      captionsInfo = { path: captionsPath, lines, words };
    }
  }

  filters.push(`[${videoLabel}]format=yuv420p[vout]`);

  let audioMap = input.hasAudio ? '0:a:0' : null;
  if (plan.musicPath) {
    const musicInput = nextInput++;
    // Loop the track forever; it is trimmed to the video length below.
    args.push('-stream_loop', '-1', '-i', path.resolve(plan.musicPath));
    const fade = Math.max(0, Math.min(config.editor.musicFadeSeconds, duration / 4));
    const fadeOutStart = Math.max(0, duration - fade);
    // Loudness-levelled first (same target as the voice), so MUSIC_VOLUME sounds the same whatever the track.
    filters.push(
      `[${musicInput}:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo,volume=${config.editor.musicVolume},`
      + `atrim=0:${duration},afade=t=in:st=0:d=${fade},afade=t=out:st=${fadeOutStart}:d=${fade}[music]`
    );

    if (input.hasAudio && config.editor.musicDucking) {
      filters.push('[0:a:0]asplit=2[voice][voicekey]');
      filters.push('[music][voicekey]sidechaincompress=threshold=0.04:ratio=4:attack=20:release=450[ducked]');
      filters.push('[voice][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]');
    } else if (input.hasAudio) {
      filters.push('[0:a:0][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]');
    } else {
      filters.push('[music]anull[aout]');
    }
    audioMap = '[aout]';
    applied.music = true;
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    ...(audioMap ? ['-map', audioMap] : []),
    '-t', String(duration),
    '-c:v', config.outputVideoCodec,
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    ...(audioMap ? ['-c:a', config.outputAudioCodec, '-b:a', '192k', '-ar', '48000', '-ac', '2'] : []),
    '-movflags', '+faststart',
    path.resolve(outputPath)
  );

  logger.info('Editing video', { inputPath, outputPath, applied });
  try {
    await runFfmpeg(args, { cwd: workDir, timeoutMs: 20 * 60 * 1000 });
  } catch (error) {
    throw new EditingError(`Editing failed: ${error.message}`, { applied });
  }

  return { applied, captions: captionsInfo };
}
