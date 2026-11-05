import { config } from '../src/config.js';

const MAX_SCRIPT_CHARACTERS = 6000;
const MAX_SCENES = 40;

// Planning costs, in "seconds of video" so they compare with clip lengths:
// every extra scene is another Flow generation, and a cut mid-sentence sounds less natural than one at a full stop.
const SCENE_COST = 2;
const CUT_COST = { sentence: 0, clause: 1.5, words: 6 };

// Words a presenter says; stray dashes or bullets are not words.
export function countWords(text) {
  return (String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}

/**
 * The clip lengths Flow offers (FLOW_DURATIONS), shortest first, with how many words fit in each:
 * (clip seconds - SCRIPT_SPEECH_MARGIN_SECONDS) x SCRIPT_WORDS_PER_SECOND.
 */
export function clipOptions() {
  const options = config.script.durations
    .map((label) => ({ label: label.trim(), seconds: Number.parseFloat(label) }))
    .filter((option) => Number.isFinite(option.seconds) && option.seconds > 0)
    .map((option) => ({
      ...option,
      maxWords: Math.max(1, Math.floor((option.seconds - config.script.speechMarginSeconds) * config.script.wordsPerSecond))
    }))
    .sort((a, b) => a.seconds - b.seconds);

  if (options.length === 0) {
    throw new Error(`FLOW_DURATIONS has no usable clip lengths: "${config.script.durations.join(',')}".`);
  }
  return options;
}

export function scriptLimits() {
  const options = clipOptions();
  return {
    wordsPerSecond: config.script.wordsPerSecond,
    clipOptions: options,
    maxWordsPerScene: options[options.length - 1].maxWords
  };
}

function estimateSeconds(words) {
  return Math.round((words / config.script.wordsPerSecond) * 10) / 10;
}

function clipFor(words, options) {
  return options.find((option) => words <= option.maxWords) || null;
}

// Sentences, keeping their end punctuation and closing quotes. Line breaks always end a sentence.
function splitSentences(script) {
  return script
    .split(/\r?\n+/)
    .flatMap((line) => line.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g) || [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => countWords(sentence) > 0);
}

// Even word chunks, for a clause too long for any clip with no punctuation to break on.
function chunkWords(text, maxWords) {
  const words = text.split(/\s+/).filter(Boolean);
  const parts = Math.ceil(countWords(text) / maxWords);
  const size = Math.ceil(words.length / parts);
  const chunks = [];
  for (let index = 0; index < words.length; index += size) {
    chunks.push(words.slice(index, index + size).join(' '));
  }
  return chunks;
}

/**
 * The smallest pieces a scene can be built from, each tagged with how natural a cut after it is:
 * clauses (split at , ; : and dashes), ending either a sentence or just a clause.
 */
function splitUnits(script, maxWords) {
  const units = [];
  for (const sentence of splitSentences(script)) {
    const clauses = sentence.match(/[^,;:—–]+(?:[,;:—–]+|$)/g)?.map((clause) => clause.trim()).filter((clause) => countWords(clause) > 0) || [sentence];
    clauses.forEach((clause, clauseIndex) => {
      const lastClause = clauseIndex === clauses.length - 1;
      const pieces = countWords(clause) > maxWords ? chunkWords(clause, maxWords) : [clause];
      pieces.forEach((text, pieceIndex) => {
        const lastPiece = pieceIndex === pieces.length - 1;
        units.push({
          text,
          words: countWords(text),
          cutAfter: !lastPiece ? 'words' : lastClause ? 'sentence' : 'clause'
        });
      });
    });
  }
  return units;
}

/**
 * Groups consecutive units into scenes. Each scene uses the shortest clip its words fit in, and the plan
 * minimises total clip seconds + a cost per scene + a cost for each cut that is not at the end of a sentence.
 */
function planScenes(units, options) {
  const maxWords = options[options.length - 1].maxWords;
  const best = [{ cost: 0, scenes: 0, from: -1, clip: null }];

  for (let end = 1; end <= units.length; end += 1) {
    best[end] = { cost: Infinity, scenes: Infinity, from: -1, clip: null };
    let words = 0;
    for (let start = end - 1; start >= 0; start -= 1) {
      words += units[start].words;
      if (words > maxWords) {
        break;
      }
      const clip = clipFor(words, options);
      const cut = end === units.length ? 0 : CUT_COST[units[end - 1].cutAfter];
      const cost = best[start].cost + clip.seconds + SCENE_COST + cut;
      const scenes = best[start].scenes + 1;
      if (cost < best[end].cost - 1e-9 || (Math.abs(cost - best[end].cost) < 1e-9 && scenes < best[end].scenes)) {
        best[end] = { cost, scenes, from: start, clip };
      }
    }
  }

  const scenes = [];
  for (let end = units.length; end > 0; end = best[end].from) {
    const parts = units.slice(best[end].from, end);
    scenes.unshift({ text: parts.map((part) => part.text).join(' '), clip: best[end].clip });
  }
  return scenes;
}

export class ScriptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScriptError';
    this.code = 'INVALID_SCRIPT';
  }
}

/**
 * Splits a spoken script into scenes, each one Flow clip of 4s/6s/8s/10s (FLOW_DURATIONS),
 * choosing the shortest clip that fits the scene's words and cutting at full stops where possible.
 */
export function splitScript(rawScript) {
  const script = String(rawScript || '').replace(/[ \t]+/g, ' ').trim();
  if (!script) {
    throw new ScriptError('The script is empty.');
  }
  if (script.length > MAX_SCRIPT_CHARACTERS) {
    throw new ScriptError(`The script is ${script.length} characters; the limit is ${MAX_SCRIPT_CHARACTERS}.`);
  }

  const limits = scriptLimits();
  const units = splitUnits(script, limits.maxWordsPerScene);
  if (units.length === 0) {
    throw new ScriptError('The script has no words to speak.');
  }

  const scenes = planScenes(units, limits.clipOptions).map(({ text, clip }, index) => {
    const words = countWords(text);
    return {
      number: index + 1,
      text,
      words,
      estimatedSeconds: estimateSeconds(words),
      duration: clip.label,
      clipSeconds: clip.seconds
    };
  });

  if (scenes.length > MAX_SCENES) {
    throw new ScriptError(`The script needs ${scenes.length} scenes; the limit is ${MAX_SCENES}. Shorten it.`);
  }

  const totalWords = scenes.reduce((sum, scene) => sum + scene.words, 0);
  return {
    ...limits,
    totalWords,
    estimatedSeconds: estimateSeconds(totalWords),
    videoSeconds: scenes.reduce((sum, scene) => sum + scene.clipSeconds, 0),
    scenes
  };
}

// Flow prompt for one scene. Inner double quotes would end the quoted line early, so they become single quotes.
export function sceneSpeechPrompt(text) {
  const spoken = String(text).replace(/["“”]/g, "'");
  return config.script.sceneTemplate.replace('{text}', spoken);
}

// For hand-written scene prompts: the quoted words are taken as what the presenter says (used for captions).
export { extractSpokenText } from '../public/post-metadata.js';
