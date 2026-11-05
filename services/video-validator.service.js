import fs from 'node:fs/promises';
import path from 'node:path';
import { runFfprobeJson } from './ffmpeg.service.js';

export class VideoValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'VideoValidationError';
    this.code = 'VIDEO_INVALID';
    this.automationCode = 'VIDEO_INVALID';
    this.details = details;
  }
}

const IMAGE_CODECS = new Set(['mjpeg', 'png', 'webp', 'gif', 'bmp', 'tiff']);
const MIN_DURATION_SECONDS = 0.5;

function parseFrameRate(value) {
  const [numerator, denominator] = String(value || '').split('/').map(Number);
  if (!numerator || !denominator) {
    return null;
  }
  return Math.round((numerator / denominator) * 100) / 100;
}

/**
 * Checks a clip with ffprobe and returns its properties.
 * Throws VideoValidationError if the file is missing, empty, unreadable, has no video stream, or has no duration.
 */
export async function validateVideo(filePath) {
  const name = path.basename(filePath);

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    throw new VideoValidationError(`${name} does not exist.`);
  }
  if (stat.size === 0) {
    throw new VideoValidationError(`${name} is empty (0 bytes).`);
  }

  let probe;
  try {
    probe = await runFfprobeJson(filePath);
  } catch (error) {
    if (error.code === 'FFMPEG_NOT_AVAILABLE') {
      throw error;
    }
    throw new VideoValidationError(`${name} could not be read as a video: ${error.message}`);
  }

  const streams = probe.streams || [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (!video) {
    throw new VideoValidationError(`${name} has no video stream.`);
  }

  // ffprobe reports a still image as a one-frame "video"; a Flow download that is really the reference image must fail.
  const formatName = probe.format?.format_name || '';
  if (IMAGE_CODECS.has(video.codec_name) || /image2|_pipe/.test(formatName)) {
    throw new VideoValidationError(`${name} is an image (${video.codec_name}), not a video.`);
  }

  const duration = Number(probe.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration < MIN_DURATION_SECONDS) {
    throw new VideoValidationError(`${name} has no playable duration (${Number.isFinite(duration) ? duration : 'unknown'}s).`);
  }

  return {
    sizeBytes: stat.size,
    duration: Math.round(duration * 1000) / 1000,
    width: video.width,
    height: video.height,
    fps: parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate),
    videoCodec: video.codec_name,
    pixelFormat: video.pix_fmt,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name || null,
    audioSampleRate: audio ? Number(audio.sample_rate) : null,
    audioChannels: audio?.channels || null
  };
}
