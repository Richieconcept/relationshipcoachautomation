import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { encodeGoogleSession, decodeGoogleSession, restoreGoogleSession } from '../services/cloud-google-session.service.js';
const cookie = { name: '__Secure-1PSID', value: 'fixture-only-not-a-credential', domain: '.google.com', path: '/', expires: Date.now() / 1000 + 3600, httpOnly: true, secure: true, sameSite: 'None' };
const state = { cookies: [cookie, { ...cookie, domain: '.unrelated.example' }], origins: [{ origin: 'https://labs.google', localStorage: [{ name: 'fixture', value: 'yes' }] }, { origin: 'https://unrelated.example', localStorage: [] }] };
test('portable session contains only Google sites and preserves the selected account', () => {
 const result = decodeGoogleSession(encodeGoogleSession(state, 'account-2'));
 assert.equal(result.accountId, 'account-2'); assert.deepEqual(result.cookies, [cookie]); assert.equal(result.origins.length, 1);
});
test('expired, malformed and out-of-scope state fails without exposing credential contents', () => {
 assert.throws(() => encodeGoogleSession({ cookies: [{ ...cookie, expires: 1 }] }, 'account-2'), /no current/);
 for (const input of ['malformed-fixture', gzipSync(JSON.stringify({ version: 1, accountId: 'account-2', cookies: [cookie], origins: [{ origin: 'https://google.com.unrelated.example', localStorage: [] }] })).toString('base64')]) {
  assert.throws(() => decodeGoogleSession(input), error => error.code === 'GOOGLE_LOGIN_REQUIRED' && !error.message.includes(cookie.value));
 }
});
test('restore never seeds another account and never overwrites a refreshed profile with the same seed', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-google-fixture-')); let calls = 0; const context = { addCookies: async items => { calls++; assert.deepEqual(items, [cookie]); }, addInitScript: async (_fn, origins) => assert.equal(origins[0].origin, 'https://labs.google') };
 try {
  const encoded = encodeGoogleSession(state, 'account-2');
  assert.equal(await restoreGoogleSession(context, 'default', dir, encoded), false); assert.equal(calls, 0);
  assert.equal(await restoreGoogleSession(context, 'account-2', dir, encoded), true);
  assert.equal(await restoreGoogleSession(context, 'account-2', dir, encoded), false); assert.equal(calls, 1);
  assert.doesNotMatch(await fs.readFile(path.join(dir, '.flow-session-seeded'), 'utf8'), /fixture|SID/);
 } finally { assert.ok(dir.startsWith(path.join(os.tmpdir(), 'cloud-google-fixture-'))); await fs.rm(dir, { recursive: true, force: true }); }
});
