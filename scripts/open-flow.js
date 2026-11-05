import { ensureRuntimeFolders } from '../src/downloads.js';
import { getFlowPage } from '../src/browser.js';
import { openFlow, ensureLoggedIn } from '../services/flow.service.js';
import { logger } from '../src/logger.js';

await ensureRuntimeFolders();

const page = await getFlowPage();
await openFlow(page);

try {
  await ensureLoggedIn(page);
  logger.info('Google Flow opened with an authenticated-looking session');
} catch (error) {
  logger.warn(error.message);
}

logger.info('Leave this browser open for manual login or Flow inspection. Press Ctrl+C to stop the script.');

