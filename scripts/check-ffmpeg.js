import { checkFfmpeg } from '../services/ffmpeg.service.js';

const result = await checkFfmpeg();

if (result.available) {
  console.log(`OK  ${result.ffmpegVersion}`);
  console.log(`OK  ${result.ffprobeVersion}`);
} else {
  console.error(result.error);
  process.exitCode = 1;
}
