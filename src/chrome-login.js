import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getAccountProfileDir } from './accounts.js';
import { config } from './config.js';

export function findChromePath() {
  const chromeCandidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ].filter(Boolean);

  return chromeCandidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export function openChromeLogin(accountId = 'default') {
  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error('Google Chrome was not found. Install Chrome or set CHROME_PATH in .env.');
  }

  const profileDir = getAccountProfileDir(accountId);
  const targetUrl = config.flowProjectUrl || config.flowUrl;
  const args = [
    `--user-data-dir=${profileDir}`,
    '--profile-directory=Default',
    targetUrl
  ];

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore'
  });

  child.unref();

  return {
    accountId,
    chromePath,
    profileDir,
    targetUrl
  };
}
