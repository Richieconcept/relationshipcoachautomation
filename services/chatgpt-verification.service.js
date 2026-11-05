// Human-verification checks are observed only. The operator must complete them.
const CHALLENGES = 'iframe[src*="challenges.cloudflare.com"]:visible, iframe[title*="challenge" i]:visible, iframe[title*="recaptcha" i]:visible, #challenge-form:visible, #cf-challenge-running:visible';
export async function needsHumanVerification(page, composerSelector) {
  if (page.isClosed()) return false;
  if (await page.locator(CHALLENGES).count().catch(() => 0)) return true;
  // A script or old chat mentioning a CAPTCHA must not be treated as a challenge.
  if (await page.locator(composerSelector).first().isVisible().catch(() => false)) return false;
  const body = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  const title = await page.title().catch(() => '');
  return /verify (?:that )?you are (?:a )?human|verify (?:you(?:'|\u2019)?re|your humanity)|(?:i(?:'|\u2019)?m|i am) not a robot|checking your browser|performing security verification|human verification/i.test(body.slice(0, 6000))
    || /just a moment/i.test(title) && /cloudflare|security|verification/i.test(body);
}
export async function waitForHumanVerification(page, { composerSelector, phase, timeoutMs = 600000, checkpoint = () => {} }) {
  if (!await needsHumanVerification(page, composerSelector)) return 0;
  const started = Date.now();
  checkpoint({ humanVerificationRequired: true, verificationPhase: phase, conversationUrl: page.url() });
  await page.bringToFront().catch(() => {});
  while (await needsHumanVerification(page, composerSelector)) {
    if (page.isClosed() || Date.now() - started >= timeoutMs) {
      throw Object.assign(new Error('Complete the human-verification check manually in the open ChatGPT Chrome window, then retry. No verification checkbox was clicked by automation.'), { code: 'CHATGPT_HUMAN_VERIFICATION_REQUIRED' });
    }
    await page.waitForTimeout(500);
  }
  if (page.isClosed()) throw new Error('ChatGPT browser was closed while waiting for manual verification.');
  checkpoint({ humanVerificationRequired: false, verificationPhase: null, conversationUrl: page.url() });
  return Date.now() - started;
}
