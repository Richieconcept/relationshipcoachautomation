import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const googleDomain = domain => /(^|\.)(google\.com|labs\.google|flow\.google|googleapis\.com|googleusercontent\.com)$/.test(String(domain).replace(/^\./, ''));
const validAuthCookie = cookie => googleDomain(cookie.domain) && /^(?:__Secure-[13]P)?SID$/.test(cookie.name)
  && cookie.value && (cookie.expires === -1 || cookie.expires > Date.now() / 1000);
const sessionError = message => Object.assign(new Error(message), { code: 'GOOGLE_LOGIN_REQUIRED' });

// Export only the dedicated Google/Flow profile state. Never write this value to Git or logs.
export function encodeGoogleSession(state, accountId) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(accountId)) throw sessionError('Invalid Google account identifier.');
  const cookies = (state.cookies || []).filter(cookie => googleDomain(cookie.domain));
  if (!cookies.some(validAuthCookie)) throw sessionError('The selected Google profile has no current signed-in session.');
  const origins = (state.origins || []).filter(entry => {
    try { const url = new URL(entry.origin); return url.protocol === 'https:' && googleDomain(url.hostname); } catch { return false; }
  }).map(entry => ({ origin: entry.origin, localStorage: entry.localStorage || [] }));
  return gzipSync(JSON.stringify({ version: 1, accountId, cookies, origins })).toString('base64');
}

export function decodeGoogleSession(encoded) {
  try {
    const state = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 1024 * 1024 }).toString('utf8'));
    if (state.version !== 1 || !/^[a-zA-Z0-9_-]{1,80}$/.test(state.accountId) || !Array.isArray(state.cookies) || !Array.isArray(state.origins)
      || state.cookies.some(cookie => !googleDomain(cookie.domain)) || !state.cookies.some(validAuthCookie)) throw Error('Invalid session');
    for (const entry of state.origins) { const url = new URL(entry.origin); if (url.protocol !== 'https:' || !googleDomain(url.hostname) || !Array.isArray(entry.localStorage)) throw Error('Invalid origin'); }
    return state;
  } catch { throw sessionError('The saved cloud Google session is invalid or expired. Sign in again before generating.'); }
}

export async function restoreGoogleSession(context, accountId, profileDir, encoded = process.env.FLOW_SESSION_STATE) {
  if (!encoded) return false;
  const state = decodeGoogleSession(encoded);
  if (state.accountId !== accountId) return false; // Never seed a different Google account.
  const fingerprint = createHash('sha256').update(encoded).digest('hex');
  const marker = path.join(profileDir, '.flow-session-seeded');
  if (await fs.readFile(marker, 'utf8').catch(() => '') === fingerprint) return false;
  await context.addCookies(state.cookies.filter(cookie => cookie.expires === -1 || cookie.expires > Date.now() / 1000));
  await context.addInitScript(origins => {
    const entry = origins.find(item => item.origin === window.location.origin);
    if (entry) for (const item of entry.localStorage) localStorage.setItem(item.name, item.value);
  }, state.origins);
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(marker, fingerprint, { mode: 0o600 }); // Marker has a digest only, never credentials.
  return true;
}
