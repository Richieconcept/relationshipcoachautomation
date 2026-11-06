import { config } from '../src/config.js';
import { getActiveAccountId } from '../src/accounts.js';
import { getFlowPageForAccount, closeBrowser } from '../src/browser.js';
import { FLOW_SELECTORS } from '../src/flow.js';
import { openFlow, ensureLoggedIn } from './flow.service.js';

// Visits Flow only. It never creates a project, submits a prompt, generates or publishes.
export async function checkCloudGoogleSession() {
  const accountId = getActiveAccountId();
  if (!process.env.FLOW_SESSION_STATE) return { ready: false, accountId, code: 'GOOGLE_LOGIN_REQUIRED', message: 'No Google session has been configured for the cloud browser.' };
  try {
    const page = await getFlowPageForAccount(accountId);
    await openFlow(page);
    await ensureLoggedIn(page);
    const text = await page.locator('body').innerText({ timeout: 10000 });
    if (/unusual activity|verify (?:it.s|your identity)|confirm (?:it.s|your identity)|captcha/i.test(text)) {
      return { ready: false, accountId, code: 'GOOGLE_VERIFICATION_REQUIRED', message: 'Google requires account verification on the cloud browser.' };
    }
    const selectors = [...FLOW_SELECTORS.promptInputCandidates, ...FLOW_SELECTORS.newProjectButtonCandidates];
    for (const selector of selectors) if (await page.locator(selector).first().isVisible().catch(() => false)) return { ready: true, accountId, message: 'Google Flow is signed in and its workspace is accessible.' };
    return { ready: false, accountId, code: 'FLOW_NOT_READY', message: 'The cloud browser opened, but the Flow workspace is not available yet.' };
  } catch (error) {
    return { ready: false, accountId, code: error.code || 'CLOUD_BROWSER_UNAVAILABLE', message: error.code === 'GOOGLE_LOGIN_REQUIRED' ? 'Google requires a fresh sign-in before cloud generation can work.' : 'The cloud browser could not complete the readiness check. Review the server log.' };
  } finally { await closeBrowser().catch(() => {}); }
}

export async function checkCloudServices() {
  const [{ verifyChannels, channelIdFor }, { verifyCloudinaryConnection }, { checkGemini }] = await Promise.all([
    import('./buffer.service.js'), import('./cloudinary.service.js'), import('./gemini-planner.service.js')
  ]);
  const platforms = ['facebook', 'youtube'].filter(platform => channelIdFor(platform));
  const results = await Promise.allSettled([verifyChannels(platforms), verifyCloudinaryConnection(), checkGemini()]);
  return { buffer: results[0].status === 'fulfilled', cloudinary: results[1].status === 'fulfilled' && results[1].value === true,
    gemini: results[2].status === 'fulfilled' && results[2].value.configured === true, platforms,
    errors: results.map((result, index) => result.status === 'rejected' ? { service: ['buffer', 'cloudinary', 'gemini'][index], code: result.reason.code || 'CONNECTION_FAILED' } : null).filter(Boolean) };
}
