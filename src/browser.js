import { chromium } from 'playwright';
import { getActiveAccountId, getAccountProfileDir } from './accounts.js';
import { config } from './config.js';
import { logger } from './logger.js';

let contextPromise;
let contextAccountId;
let flowPage;

export async function getBrowserContext(accountId = getActiveAccountId()) {
  if (contextPromise && contextAccountId !== accountId) {
    await closeBrowser();
  }

  if (!contextPromise) {
    contextAccountId = accountId;
    const profileDir = getAccountProfileDir(contextAccountId);

    logger.info('Opening Chrome', { accountId: contextAccountId, profileDir });
    contextPromise = chromium.launchPersistentContext(profileDir, {
      headless: config.headless,
      acceptDownloads: true,
      downloadsPath: config.browserDownloadTempDir,
      chromiumSandbox: config.chromiumSandbox,
      channel: 'chrome',
      viewport: { width: 1440, height: 1000 }
    }).catch(async (error) => {
      logger.warn('Installed Chrome was not available, falling back to bundled Chromium', {
        error: error.message
      });

      return chromium.launchPersistentContext(profileDir, {
        headless: config.headless,
        acceptDownloads: true,
        downloadsPath: config.browserDownloadTempDir,
        chromiumSandbox: config.chromiumSandbox,
        viewport: { width: 1440, height: 1000 }
      });
    });
    const launched = contextPromise;
    const reset = () => {
      if (contextPromise === launched) {
        contextPromise = null;
        contextAccountId = null;
        flowPage = null;
      }
    };
    launched.then(context => context.on('close', reset), reset);
  }

  return contextPromise;
}

export async function getFlowPage() {
  return getFlowPageForAccount(getActiveAccountId());
}

export async function getFlowPageForAccount(accountId) {
  const context = await getBrowserContext(accountId);
  if (flowPage && !flowPage.isClosed() && flowPage.context() === context) return flowPage;
  const pages = context.pages();
  flowPage = pages.find(page => {
    try { return ['flow.google.com', 'labs.google'].includes(new URL(page.url()).hostname); }
    catch { return false; }
  }) || pages.find(page => page.url() === 'about:blank') || await context.newPage();
  return flowPage;
}

// Close only the tab used by generation, after the downloads are safely saved.
export async function closeFlowTab() {
  const page = flowPage;
  flowPage = null;
  if (page && !page.isClosed()) await page.close();
}

export async function closeBrowser() {
  if (!contextPromise) {
    return;
  }

  flowPage = null;
  const closing = contextPromise;
  contextPromise = null;
  contextAccountId = null;
  const context = await closing.catch(() => null);
  if (context) await context.close();
}
