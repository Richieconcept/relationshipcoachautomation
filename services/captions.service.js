import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { runFfmpeg } from './ffmpeg.service.js';

// Pauses quieter than this, for at least this long, separate spoken phrases.
const SILENCE_NOISE = '-40dB';
const SILENCE_MIN_SECONDS = 0.25;
const MIN_SPEECH_SEGMENT_SECONDS = 0.12;
// A caption stays up through a short pause instead of flickering off and on.
const HOLD_GAP_SECONDS = 0.35;
const MAX_CAPTION_CHARACTERS = 18;

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Finds when the presenter is talking in one clip, using FFmpeg's silence detection.
 * Returns [{ start, end }] in clip time. Falls back to (almost) the whole clip if detection fails.
 */
export async function detectSpeechActivity(clipPath, duration) {
  const fallback = [{ start: Math.min(0.2, duration / 4), end: Math.max(duration - 0.3, duration / 2) }];

  let stderr;
  try {
    ({ stderr } = await runFfmpeg([
      '-i', clipPath,
      '-map', '0:a:0',
      '-af', `silencedetect=noise=${SILENCE_NOISE}:d=${SILENCE_MIN_SECONDS}`,
      '-f', 'null', '-'
    ], { timeoutMs: 2 * 60 * 1000 }));
  } catch (error) {
    logger.warn('Speech detection failed; captions will be spread over the whole clip', { clipPath, error: error.message });
    return { segments: fallback, reliable: false };
  }

  const silences = [];
  let openStart = null;
  for (const match of stderr.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const time = Math.max(0, Number(match[2]));
    if (match[1] === 'start') {
      openStart = time;
    } else if (openStart !== null) {
      silences.push({ start: openStart, end: time });
      openStart = null;
    }
  }
  if (openStart !== null) {
    silences.push({ start: openStart, end: duration });
  }

  const speech = [];
  let cursor = 0;
  for (const silence of silences) {
    if (silence.start - cursor >= MIN_SPEECH_SEGMENT_SECONDS) {
      speech.push({ start: round3(cursor), end: round3(Math.min(silence.start, duration)) });
    }
    cursor = Math.max(cursor, silence.end);
  }
  if (duration - cursor >= MIN_SPEECH_SEGMENT_SECONDS) {
    speech.push({ start: round3(cursor), end: round3(duration) });
  }

  return { segments: speech, reliable: true };
}

export async function detectSpeechSegments(clipPath, duration) {
  const activity = await detectSpeechActivity(clipPath, duration);
  return activity.segments.length ? activity.segments : [{ start: 0, end: duration }];
}

// Longer words take longer to say; a comma or full stop adds a short beat.
function wordWeight(word) {
  const letters = (word.match(/[\p{L}\p{N}]/gu) || []).length;
  const pause = /[.!?…]["'”’)]*$/.test(word) ? 1.5 : /[,;:—–]$/.test(word) ? 0.75 : 0;
  return Math.max(2, letters + 1) + pause;
}

// Position along the joined speech segments -> real clip time (pauses are skipped).
function speechTimeToClipTime(position, segments) {
  let remaining = position;
  for (const segment of segments) {
    const length = segment.end - segment.start;
    if (remaining <= length) {
      return segment.start + remaining;
    }
    remaining -= length;
  }
  return segments[segments.length - 1].end;
}

/**
 * Spreads the scene's words over the time the presenter is actually talking.
 * This is an estimate from the script, not speech recognition: if Flow changes the words, captions show the script.
 */
export function timeWords(text, segments, offset = 0) {
  const words = String(text || '').split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (words.length === 0) {
    return [];
  }

  const weights = words.map(wordWeight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const speechSeconds = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);

  let consumed = 0;
  return words.map((word, index) => {
    const start = speechTimeToClipTime((consumed / totalWeight) * speechSeconds, segments);
    consumed += weights[index];
    const end = speechTimeToClipTime((consumed / totalWeight) * speechSeconds, segments);
    return { word, start: round3(offset + start), end: round3(offset + end) };
  });
}

// Short caption lines: a few words, broken after punctuation so phrases stay together.
export function groupCaptionWords(timedWords, maxWords = config.editor.captionMaxWords) {
  const groups = [];
  let current = [];

  for (const item of timedWords) {
    const text = [...current, item].map((entry) => entry.word).join(' ');
    if (current.length > 0 && (current.length >= maxWords || text.length > MAX_CAPTION_CHARACTERS)) {
      groups.push(current);
      current = [];
    }
    current.push(item);
    if (/[.!?…,;:—–]["'”’)]*$/.test(item.word)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

// '#RRGGBB' -> ASS '&H00BBGGRR'
function assColor(hex, fallback) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const value = match ? match[1] : fallback;
  return `&H00${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}`.toUpperCase();
}

function assTime(seconds) {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const secs = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

// Braces and backslashes are ASS override syntax; they must not come from the script.
function assText(word) {
  const clean = word.replace(/[{}\\]/g, '');
  return config.editor.captionUppercase ? clean.toLocaleUpperCase() : clean;
}

/**
 * Builds an .ass subtitle file: each caption line shows a few words and highlights the word being spoken.
 * timedWords: [{ word, start, end }] in final-video time.
 */
export function buildCaptionsAss(timedWords, { width, height }) {
  const editor = config.editor;
  const portrait = height > width;
  const fontSize = editor.captionFontSize > 0 ? editor.captionFontSize : Math.round(portrait ? width * 0.115 : height * 0.105);
  const outline = Math.max(3, Math.round(fontSize * 0.06));
  // Portrait videos keep captions above the platform buttons and description; landscape sits near the bottom.
  const marginV = Math.round(height * (portrait ? editor.captionBottomPercent : 10) / 100);
  const baseColor = assColor(editor.captionColor, 'FFFFFF');
  const highlightColor = assColor(editor.captionHighlightColor, '66FF66');

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${editor.captionFont},${fontSize},${baseColor},${baseColor},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},2,2,${Math.round(width * 0.08)},${Math.round(width * 0.08)},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];

  const groups = groupCaptionWords(timedWords);
  const events = [];

  groups.forEach((group, groupIndex) => {
    const nextStart = groups[groupIndex + 1]?.[0].start;
    const lastEnd = group[group.length - 1].end;
    const groupEnd = nextStart !== undefined && nextStart - lastEnd < HOLD_GAP_SECONDS ? nextStart : lastEnd;

    group.forEach((item, wordIndex) => {
      const start = item.start;
      const end = wordIndex < group.length - 1 ? group[wordIndex + 1].start : groupEnd;
      if (end - start < 0.01) {
        return;
      }
      const durationMs = Math.max(1, Math.floor((end - start) * 1000));
      // Give every active word a visible overshoot and settle, then hold it large
      // and green until the next word. Reset inline overrides for surrounding text.
      const popMs = Math.min(180, Math.max(2, Math.floor(durationMs * 0.8)));
      const peakMs = Math.max(1, Math.floor(popMs * 0.35));
      const bounce = editor.captionAnimation
        ? `\\fscx108\\fscy108\\t(0,${peakMs},\\fscx140\\fscy140)\\t(${peakMs},${popMs},\\fscx118\\fscy118)` : '';
      const text = group
        .map((entry, index) => (index === wordIndex
          ? `{\\c${highlightColor}${bounce}}${assText(entry.word)}{\\c${baseColor}\\fscx100\\fscy100}`
          : assText(entry.word)))
        .join(' ');
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`);
    });
  });

  return { ass: `${[...header, ...events].join('\n')}\n`, lines: groups.length, words: timedWords.length };
}
