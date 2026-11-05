// Shared by the server and previews so the displayed post matches the published post.
const TOPICS = [
  ['HealthyCommunication', /\b(communicat\w*|listen\w*|conversation\w*|silent treatment|talk(?:ing)? to|express(?:ing)? feelings)\b/gi],
  ['HealthyBoundaries', /\b(boundar\w*|personal space|say(?:ing)? no|control(?:ling)?|privacy)\b/gi],
  ['TrustInRelationships', /\b(trust\w*|cheat\w*|infidel\w*|dishonest\w*|honest\w*|betray\w*|lying|lies)\b/gi],
  ['MoneyAndRelationships', /\b(money|financ\w*|debt\w*|bills?|budget\w*|salary|spending)\b/gi],
  ['MarriageAdvice', /\b(marri\w*|marry\w*|husband|wife|spouse\w*|wedding\w*)\b/gi],
  ['BreakupHealing', /\b(breakups?|break(?:ing)? up|heartbreak\w*|moving on|ex partner|ex-partner|after a split)\b/gi],
  ['LongDistanceLove', /\b(long[ -]distance|living apart|miles apart|different time zones)\b/gi],
  ['EmotionalSupport', /\b(emotional support|feel(?:ing)? safe|support(?:ive)? partner|comfort\w*|reassur\w*|vulnerab\w*)\b/gi],
  ['ConflictResolution', /\b(conflict\w*|argu\w*|disagree\w*|fight\w*|resent\w*|apolog\w*|forgiv\w*)\b/gi],
  ['MutualRespect', /\b(respect\w*|disrespect\w*|belittl\w*|humiliat\w*)\b/gi],
  ['DatingAdvice', /\b(dating|dates?|situationship\w*|first impression|red flags?|love bombing)\b/gi],
  ['Commitment', /\b(commit\w*|consisten\w*|exclusive|loyal\w*|future together)\b/gi],
  ['LoveAndAppreciation', /\b(appreciat\w*|gratitude|thank\w*|affection\w*|quality time|love language\w*)\b/gi],
  ['SelfWorth', /\b(self[ -](?:worth|love|esteem)|worthless|deserve better|losing yourself)\b/gi]
];

export function extractSpokenText(prompt) {
  const quoted = String(prompt || '').match(/["\u201c]([^"\u201d]{2,})["\u201d]/g) || [];
  return quoted.map(part => part.slice(1, -1).trim()).filter(Boolean).join(' ');
}

export function spokenScript(project = {}) {
  return (typeof project.script === 'string' && project.script.trim())
    || (Array.isArray(project.scenes) ? project.scenes.map(scene =>
      typeof scene === 'string' ? extractSpokenText(scene)
        : (scene.spokenText || extractSpokenText(scene.prompt))).filter(Boolean).join(' ') : '');
}

export function openingHook(script) {
  const lines = String(script || '').trim().split(/\r?\n/).map(line => line.trim()
    .replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '')
    .replace(/^(?:hook|opening hook|script)\s*:\s*/i, '').trim()).filter(Boolean);
  const line = lines[0] || '';
  // Keep sentence-ending quotes. Ignore decimals, common abbreviations and initials.
  let hook = line;
  for (const match of line.matchAll(/[.!?]+["\u201d\u2019']*(?=\s|$)/g)) {
    const end = match.index + match[0].length;
    const prefix = line.slice(0, end).replace(/["\u201d\u2019']+$/, '');
    if (match[0][0] === '.' && /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)|\b[A-Z]|\b(?:e\.g|i\.e))\.$/i.test(prefix)) continue;
    hook = line.slice(0, end); break;
  }
  if (hook.length > 500) hook = hook.slice(0, 497).replace(/\s+\S*$/, '').trimEnd() + '\u2026';
  return /[\p{L}\p{N}]/u.test(hook) ? hook : '';
}

export function buildPostMetadata(script) {
  const caption = openingHook(script);
  if (!caption) return null;
  const ranked = TOPICS.map(([tag, pattern], order) => ({ tag, order,
    score: [...String(script).matchAll(pattern)].length + 2 * [...caption.matchAll(pattern)].length
  })).filter(topic => topic.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
  return { version: 1, source: 'script_hook', caption,
    hashtags: ['#RelationshipCoach', '#RelationshipAdvice', ...ranked.slice(0, 3).map(topic => '#' + topic.tag)] };
}

// Preserve platform selection and YouTube titles. Malformed input is left to the existing validator.
export function applyScriptPostMetadata(raw, script, { title = '' } = {}) {
  const metadata = buildPostMetadata(script);
  if (!metadata) return raw;
  let source = raw;
  if (typeof source === 'string') { try { source = JSON.parse(source || '{}'); } catch { return raw; } }
  source = source || {};
  return Object.fromEntries(['facebook', 'tiktok', 'youtube'].map(platform => [platform, {
    ...source[platform], hashtags: [...metadata.hashtags],
    ...(platform === 'youtube'
      ? { description: metadata.caption, title: source.youtube?.title || title || metadata.caption.slice(0, 100) }
      : { caption: metadata.caption })
  }]));
}
