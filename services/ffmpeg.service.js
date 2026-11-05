import { spawn } from 'node:child_process';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';

export const FFMPEG_REQUIRED_MESSAGE = 'FFmpeg is required for multi-scene video assembly. '
  + 'Install FFmpeg (https://www.gyan.dev/ffmpeg/builds/ on Windows), make sure ffmpeg and ffprobe are on PATH, '
  + 'or set FFMPEG_PATH and FFPROBE_PATH in .env, then restart the server.';

export class FfmpegError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FfmpegError';
    this.code = code;
    this.details = details;
  }
}

// Runs a binary with an argument array (no shell, so paths with spaces are safe).
// cwd lets filters reference files by bare name (FFmpeg filter syntax needs Windows drive colons escaped otherwise).
function run(binary, args, { timeoutMs = 10 * 60 * 1000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let child;

    try {
      child = spawn(binary, args, { windowsHide: true, ...(cwd ? { cwd } : {}) });
    } catch (error) {
      reject(new FfmpegError('FFMPEG_NOT_AVAILABLE', `${FFMPEG_REQUIRED_MESSAGE} (${error.message})`));
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new FfmpegError('FFMPEG_TIMEOUT', `${binary} did not finish within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (error) => {
      clearTimeout(timer);
      const code = error.code === 'ENOENT' ? 'FFMPEG_NOT_AVAILABLE' : 'FFMPEG_FAILED';
      const message = code === 'FFMPEG_NOT_AVAILABLE'
        ? `${FFMPEG_REQUIRED_MESSAGE} (could not run "${binary}")`
        : `${binary} could not start: ${error.message}`;
      reject(new FfmpegError(code, message));
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) {
        resolve({ stdout, stderr });
        return;
      }

      // FFmpeg prints its banner first; the last lines carry the actual error.
      const tail = stderr.trim().split(/\r?\n/).slice(-18).join('\n');
      reject(new FfmpegError('FFMPEG_FAILED', `${binary} exited with code ${exitCode}: ${tail}`, { args }));
    });
  });
}

export function runFfmpeg(args, options) {
  return run(config.ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], options);
}

export async function runFfprobeJson(filePath) {
  const { stdout } = await run(config.ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ], { timeoutMs: 60 * 1000 });

  return JSON.parse(stdout || '{}');
}

let cachedCheck = null;

// Confirms ffmpeg and ffprobe can run. Cached after the first success.
export async function checkFfmpeg({ force = false } = {}) {
  if (cachedCheck?.available && !force) {
    return cachedCheck;
  }

  const versionOf = async (binary) => {
    const { stdout } = await run(binary, ['-version'], { timeoutMs: 15000 });
    return stdout.split(/\r?\n/)[0].trim();
  };

  try {
    const [ffmpegVersion, ffprobeVersion] = await Promise.all([
      versionOf(config.ffmpegPath),
      versionOf(config.ffprobePath)
    ]);
    cachedCheck = { available: true, ffmpegVersion, ffprobeVersion };
  } catch (error) {
    cachedCheck = {
      available: false,
      error: error.code === 'FFMPEG_NOT_AVAILABLE' ? FFMPEG_REQUIRED_MESSAGE : error.message
    };
  }

  return cachedCheck;
}

export async function requireFfmpeg() {
  const check = await checkFfmpeg();
  if (!check.available) {
    throw new FfmpegError('FFMPEG_NOT_AVAILABLE', check.error);
  }
  return check;
}

export async function logFfmpegStatus() {
  const check = await checkFfmpeg();
  if (check.available) {
    logger.info('FFmpeg available', { ffmpeg: check.ffmpegVersion, ffprobe: check.ffprobeVersion });
  } else {
    logger.warn(check.error);
  }
  return check;
}
