// TEST 4: send one video post to one Buffer channel using a video URL you already have.
// Saved as a Buffer DRAFT by default so nothing goes live; add --live to use BUFFER_POST_MODE instead.
// Usage:
//   npm run test:buffer -- --platform facebook --video-url https://res.cloudinary.com/.../video.mp4 --text "Caption #Tag"
//   npm run test:buffer -- --platform youtube --video-url URL --title "My title" --text "Description" [--live]
import { config } from '../src/config.js';
import { channelIdFor, createVideoPost, SUPPORTED_PLATFORMS } from '../services/buffer.service.js';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const platform = arg('platform');
const videoUrl = arg('video-url');
const text = arg('text') || '';
const title = arg('title');
const live = process.argv.includes('--live');

if (!SUPPORTED_PLATFORMS.includes(platform) || !videoUrl) {
  console.error('Usage: npm run test:buffer -- --platform facebook|tiktok|youtube --video-url URL --text "..." [--title "..."] [--live]');
  process.exit(1);
}
if (platform === 'youtube' && !title) {
  console.error('YouTube needs --title.');
  process.exit(1);
}

if (!live) {
  config.buffer.postMode = 'draft';
}

const metadata = {
  facebook: { type: config.buffer.facebookPostType === 'auto' ? 'reel' : config.buffer.facebookPostType },
  tiktok: config.buffer.discloseAiGenerated ? { isAiGenerated: true } : {},
  youtube: {
    title,
    categoryId: config.buffer.youtubeCategoryId,
    privacy: config.buffer.youtubePrivacy,
    madeForKids: config.buffer.youtubeMadeForKids,
    ...(config.buffer.discloseAiGenerated ? { isAiGenerated: true } : {})
  }
}[platform];

try {
  console.log(`Sending ${platform} post (${live ? `mode ${config.buffer.postMode}` : 'draft only'})...`);
  const result = await createVideoPost({
    channelId: channelIdFor(platform),
    videoUrl,
    text,
    platform,
    platformOptions: { metadata }
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`${error.code || 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
}
