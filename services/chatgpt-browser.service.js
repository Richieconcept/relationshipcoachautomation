import { waitForHumanVerification } from './chatgpt-verification.service.js';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../src/config.js';
import { persistentBrowserSession } from './persistent-browser-session.service.js';
import { projectIdentity, validateProjectUrl } from './content-plan.service.js';

// Separate from Flow so logging into ChatGPT never closes the generation browser.
const profileDir = path.join(config.rootDir, 'browser-profiles', 'chatgpt-content');
export const CHATGPT_COMPOSER = '#prompt-textarea, textarea[data-testid="prompt-textarea"], [role="textbox"][contenteditable="true"][data-composer-markdown]';
const session = persistentBrowserSession(() => chromium.launchPersistentContext(profileDir, {
  channel: 'chrome', headless: false, chromiumSandbox: config.chromiumSandbox,
  viewport: { width: 1440, height: 1000 }
}));
let busy = false;
const getContext = () => session.get();
export async function closeChatgptBrowser({ shutdown = false } = {}) {
  if (busy && !shutdown) throw new Error('A ChatGPT script request is running.');
  await session.close();
}
export async function openChatgptLogin(projectUrl, { contextFactory = getContext } = {}) {
  if (busy) throw new Error('A ChatGPT script request is running.');
  const target = projectUrl ? validateProjectUrl(projectUrl) : 'https://chatgpt.com/';
  busy = true;
  try {
    const ctx = await contextFactory();
    const page = ctx.pages()[0] || await ctx.newPage();
    if (page.url().replace(/\/$/, '') !== target.replace(/\/$/, '')) {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await page.bringToFront();
    return { message: 'Sign into ChatGPT manually and check your Project. Leave this Chrome window open; script requests will reuse this same session. Complete any human-verification check yourself.' };
  } finally { busy = false; }
}

// UI locators are centralized here. Fail closed when login, a challenge or a changed UI prevents extraction.
export async function requestChatgptScript({ projectUrl, prompt, checkpoint = () => {}, timeoutMs = 720000, verificationTimeoutMs = 600000, contextFactory = getContext }) {
  if (busy) throw new Error('Another ChatGPT request is already running.');
  busy = true;
  try {
    const ctx = await contextFactory();
    const page = ctx.pages()[0] || await ctx.newPage();
    const target = validateProjectUrl(projectUrl);
    if (page.url().replace(/\/$/, '') !== target.replace(/\/$/, '')) {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    const composer = page.locator(CHATGPT_COMPOSER).first();
    let verificationSpent = 0;
    const pauseForHuman = async phase => {
      const elapsed = await waitForHumanVerification(page, { composerSelector: CHATGPT_COMPOSER, phase,
        timeoutMs: Math.max(0, verificationTimeoutMs - verificationSpent), checkpoint });
      verificationSpent += elapsed; return elapsed;
    };
    let composerDeadline = Date.now() + 30000;
    while (!await composer.isVisible().catch(() => false)) {
      if (page.isClosed()) throw new Error('ChatGPT browser was closed during script retrieval.');
      composerDeadline += await pauseForHuman('before_send');
      if (Date.now() >= composerDeadline) throw new Error('ChatGPT composer unavailable. Open ChatGPT Login, complete sign-in, confirm Project access, and leave that Chrome window open.');
      await page.waitForTimeout(500);
    }
    await pauseForHuman('before_send');
    const expectedProject = projectIdentity(target);
    const actual = new URL(page.url());
    if (actual.origin !== 'https://chatgpt.com' || projectIdentity(actual.href) !== expectedProject) throw new Error('ChatGPT did not open the configured Project. Check access and the Project URL.');
    const expectedPath = new URL(target).pathname.replace(/\/$/, '');
    if (expectedPath.includes('/c/') && actual.pathname.split('/')[4] !== expectedPath.split('/')[4]) {
      throw new Error('ChatGPT did not open the configured planning conversation. Check the conversation URL and access before retrying.');
    }
    const assistant = page.locator('[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]');
    // Long planning chats virtualize older messages; total message counts are not stable.
    await composer.fill(prompt);
    const send = page.locator('[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"][type="submit"]').first();
    await send.waitFor({ state: 'visible', timeout: 10000 });
    if (await pauseForHuman('before_send')) {
      await composer.fill(prompt);
      await send.waitFor({ state: 'visible', timeout: 10000 });
    }
    checkpoint({ requestState: 'sending', conversationUrl: page.url() });
    await send.click({ timeout: 10000 });
    checkpoint({ requestState: 'sent', conversationUrl: page.url() });
    let deadline = Date.now() + timeoutMs;
    let previous = ''; let stableSince = Date.now();
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error('ChatGPT browser was closed during script retrieval.');
      deadline += await pauseForHuman('waiting_reply');
      const count = await assistant.count();
      const lastUser = await page.locator('[data-message-author-role="user"], [data-content-search-unit-key$=":user"]').last().innerText().catch(() => '');
      const matchingUser = lastUser.replace(/^You said:\s*/, '').trim() === prompt.trim();
      const isCurrentReply = count > 0 && matchingUser && await assistant.last().evaluate(element => {
        const users = document.querySelectorAll('[data-message-author-role="user"], [data-content-search-unit-key$=":user"]');
        const user = users[users.length - 1];
        return Boolean(user && (user.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
      });
      const raw = isCurrentReply ? await assistant.last().innerText() : '';
      if (raw !== previous) { previous = raw; stableSince = Date.now(); }
      const stopping = await page.locator('[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[aria-label="Stop"]').count();
      // A completed answer has response actions; text stability alone is not sufficient during a stalled stream.
      const turn = isCurrentReply ? page.locator('article').filter({ has: assistant.last() }) : null;
      const actions = turn ? turn.locator('[data-testid="copy-turn-action-button"], button[aria-label*="Copy"]') : null;
      const modernTurn = isCurrentReply ? assistant.last().locator('xpath=ancestor::*[@data-talvt-turn-state][1]') : null;
      const hasModernTurn = modernTurn && await modernTurn.count() > 0;
      const completed = hasModernTurn
        ? await modernTurn.getAttribute('data-talvt-turn-state') === 'complete'
        : actions && await actions.count() > 0;
      if (raw && !stopping && completed && Date.now() - stableSince >= 5000) {
        checkpoint({ requestState: 'received', conversationUrl: page.url(), rawResponse: raw });
        return raw;
      }
      await page.waitForTimeout(1000);
    }
    throw new Error('Timed out waiting for a complete ChatGPT response. Inspect the conversation before retrying.');
  } finally { busy = false; }
}
