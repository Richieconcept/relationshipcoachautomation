import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function booleanFromEnv(value, defaultValue = false) {
  if (value === undefined) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function numberFromEnv(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function listFromEnv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  rootDir,
  allowRemoteControls: booleanFromEnv(process.env.ALLOW_REMOTE_CONTROLS, false),
  trustProxy: booleanFromEnv(process.env.TRUST_PROXY, false),
  port: numberFromEnv(process.env.PORT, 3000),
  flowUrl: process.env.FLOW_URL || 'https://labs.google/fx/tools/flow',
  flowProjectUrl: process.env.FLOW_PROJECT_URL || '',
  headless: booleanFromEnv(process.env.HEADLESS, false),
  closeBrowserAfterGeneration: booleanFromEnv(process.env.CLOSE_BROWSER_AFTER_GENERATION, false),
  chromiumSandbox: booleanFromEnv(process.env.CHROMIUM_SANDBOX, true),
  flowAccount: process.env.FLOW_ACCOUNT || '',
  flowAccounts: listFromEnv(process.env.FLOW_ACCOUNTS),
  browserProfilesDir: resolveFromRoot(process.env.BROWSER_PROFILES_DIR || './browser-profiles'),
  downloadDir: resolveFromRoot(process.env.DOWNLOAD_DIR || './downloads/videos'),
  browserDownloadTempDir: resolveFromRoot(process.env.BROWSER_DOWNLOAD_TEMP_DIR || './tmp/browser-downloads'),
  uploadDir: resolveFromRoot(process.env.UPLOAD_DIR || './uploads/references'),
  screenshotDir: resolveFromRoot(process.env.SCREENSHOT_DIR || './screenshots'),
  browserProfileDir: resolveFromRoot(process.env.BROWSER_PROFILE_DIR || './browser-profile'),
  logFile: resolveFromRoot(process.env.LOG_FILE || './logs/app.log'),
  generationTimeoutMs: numberFromEnv(process.env.GENERATION_TIMEOUT_MS, 900000),
  maxGenerationRetries: numberFromEnv(process.env.FLOW_GENERATION_RETRIES, 20),
  generationRetryDelayMs: numberFromEnv(process.env.FLOW_GENERATION_RETRY_DELAY_MS, 60000),
  pollIntervalMs: numberFromEnv(process.env.POLL_INTERVAL_MS, 5000),
  defaultAspectRatio: process.env.FLOW_DEFAULT_ASPECT_RATIO || '9:16',
  defaultProject: process.env.FLOW_DEFAULT_PROJECT || '',
  defaultModel: process.env.FLOW_DEFAULT_MODEL || 'Omni 1.1 Flash',
  defaultResolution: process.env.FLOW_DEFAULT_RESOLUTION || '360p',
  defaultDuration: process.env.FLOW_DEFAULT_DURATION || '10s',
  defaultOutputCount: process.env.FLOW_DEFAULT_OUTPUT_COUNT || '1',

  // Multi-scene projects
  projectDownloadDir: resolveFromRoot(process.env.PROJECT_DOWNLOAD_DIR || './downloads/projects'),
  maxSceneRetries: numberFromEnv(process.env.MAX_SCENE_RETRIES, 5),
  retrySceneUntilSuccess: booleanFromEnv(process.env.RETRY_SCENE_UNTIL_SUCCESS, true),
  maxDownloadRecoveryAttempts: Math.max(1, numberFromEnv(process.env.MAX_DOWNLOAD_RECOVERY_ATTEMPTS, 3)),
  sceneRetryDelayMs: 10000,
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  normalizeVideo: booleanFromEnv(process.env.NORMALIZE_VIDEO, true),
  outputVideoCodec: process.env.OUTPUT_VIDEO_CODEC || 'libx264',
  outputAudioCodec: process.env.OUTPUT_AUDIO_CODEC || 'aac',
  outputFps: numberFromEnv(process.env.OUTPUT_FPS, 30),

  // Script mode: a written script is split into scenes that fit one Flow clip each
  script: {
    // Clip lengths Flow offers; each scene uses the shortest one its words fit in
    durations: listFromEnv(process.env.FLOW_DURATIONS || '4s,6s,8s,10s'),
    wordsPerSecond: numberFromEnv(process.env.SCRIPT_WORDS_PER_SECOND, 2.5),
    // Seconds left unspoken in every clip so the presenter is never cut off mid-word
    speechMarginSeconds: numberFromEnv(process.env.SCRIPT_SPEECH_MARGIN_SECONDS, 1.5),
    // Cut the silence after the presenter's last word so scenes flow without dead air
    trimTrailingSilence: booleanFromEnv(process.env.TRIM_TRAILING_SILENCE, true),
    trimTailSeconds: numberFromEnv(process.env.TRIM_TAIL_SECONDS, 0.4),
    // {text} is replaced by the scene's spoken words
    sceneTemplate: process.env.SCRIPT_SCENE_TEMPLATE
      || 'The presenter looks directly into the camera and says, word for word, exactly this and nothing else: "{text}"'
  },

  // Brand assets (presenter image, logo, background music) live in BRAND_DIR
  brandDir: resolveFromRoot(process.env.BRAND_DIR || './brand'),

  // Editor: one FFmpeg pass after assembly adds logo, background music and captions
  editor: {
    logoPosition: process.env.LOGO_POSITION || 'top-right',
    logoWidthPercent: numberFromEnv(process.env.LOGO_WIDTH_PERCENT, 26),
    logoMarginPx: numberFromEnv(process.env.LOGO_MARGIN_PX, 48),
    logoOpacity: numberFromEnv(process.env.LOGO_OPACITY, 1),
    // Relative to the voice: 0.18 sits about 15 dB under the presenter
    musicVolume: numberFromEnv(process.env.MUSIC_VOLUME, 0.18),
    // Lowers the music while the presenter talks, lets it come back up in pauses
    musicDucking: booleanFromEnv(process.env.MUSIC_DUCKING, true),
    musicFadeSeconds: numberFromEnv(process.env.MUSIC_FADE_SECONDS, 1.5),
    captionFont: process.env.CAPTION_FONT || 'Bangers',
    captionFontSize: numberFromEnv(process.env.CAPTION_FONT_SIZE, 0),
    captionColor: process.env.CAPTION_COLOR || '#FFFFFF',
    captionHighlightColor: process.env.CAPTION_HIGHLIGHT_COLOR || '#66FF66',
    captionAnimation: booleanFromEnv(process.env.CAPTION_ANIMATION, true),
    captionMaxWords: numberFromEnv(process.env.CAPTION_MAX_WORDS, 3),
    captionUppercase: booleanFromEnv(process.env.CAPTION_UPPERCASE, true),
    // Distance of the caption baseline from the bottom edge, as a percent of video height
    captionBottomPercent: numberFromEnv(process.env.CAPTION_BOTTOM_PERCENT, 20),
    smartPacing: booleanFromEnv(process.env.SMART_PACING, true),
    longPauseSeconds: numberFromEnv(process.env.LONG_PAUSE_SECONDS, 0.75),
    keptPauseSeconds: numberFromEnv(process.env.KEPT_PAUSE_SECONDS, 0.30),
    speechLeadSeconds: numberFromEnv(process.env.SPEECH_LEAD_SECONDS, 0.12),
    speechTailSeconds: numberFromEnv(process.env.SPEECH_TAIL_SECONDS, 0.18),
    cutBlendSeconds: numberFromEnv(process.env.CUT_BLEND_SECONDS, 0.08),
    matchScenePace: booleanFromEnv(process.env.MATCH_SCENE_PACE, true),
    maxSceneSpeed: numberFromEnv(process.env.MAX_SCENE_SPEED, 1.20),
    scenePaceTolerance: numberFromEnv(process.env.SCENE_PACE_TOLERANCE, 0.05)
  },

  // Publishing (server-side only: never send these values to the frontend or logs)
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
    folder: process.env.CLOUDINARY_FOLDER || 'flow-social-automation'
  },
  buffer: {
    apiUrl: process.env.BUFFER_API_URL || 'https://api.buffer.com',
    apiKey: process.env.BUFFER_API_KEY || '',
    channelIds: {
      facebook: process.env.BUFFER_FACEBOOK_CHANNEL_ID || '',
      tiktok: process.env.BUFFER_TIKTOK_CHANNEL_ID || '',
      youtube: process.env.BUFFER_YOUTUBE_CHANNEL_ID || ''
    },
    // addToQueue (next free slot), shareNow, shareNext, or draft (saved in Buffer, never published)
    postMode: process.env.BUFFER_POST_MODE || 'addToQueue',
    // auto = reel for vertical videos up to 90s, otherwise a normal video post
    facebookPostType: process.env.BUFFER_FACEBOOK_POST_TYPE || 'auto',
    youtubeCategoryId: process.env.BUFFER_YOUTUBE_CATEGORY_ID || '22',
    youtubePrivacy: process.env.BUFFER_YOUTUBE_PRIVACY || 'public',
    youtubeMadeForKids: booleanFromEnv(process.env.BUFFER_YOUTUBE_MADE_FOR_KIDS, false),
    discloseAiGenerated: booleanFromEnv(process.env.BUFFER_DISCLOSE_AI_GENERATED, true)
  }
};

export const supportedAspectRatios = new Set(['9:16', '16:9']);
