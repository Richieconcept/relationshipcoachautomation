import { openChromeLogin } from '../src/chrome-login.js';
import { config } from '../src/config.js';
import { ensureRuntimeFolders } from '../src/downloads.js';

await ensureRuntimeFolders();

const accountId = process.argv[2] || config.flowAccount || 'default';
const result = openChromeLogin(accountId);

console.log(`Opening Chrome for manual login: ${result.chromePath}`);
console.log(`Account: ${result.accountId}`);
console.log(`Using browser profile: ${result.profileDir}`);
console.log('After signing in, close this Chrome window before running Playwright automation.');
