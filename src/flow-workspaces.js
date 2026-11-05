import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const workspaceFile = path.join(config.rootDir, 'tmp', 'flow-workspaces.json');

function isProjectUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      (url.hostname === 'flow.google.com' && url.pathname.startsWith('/project/'))
      || (url.hostname === 'labs.google' && url.pathname.startsWith('/fx/tools/flow/project/'))
    );
  } catch { return false; }
}

async function readWorkspaces() {
  try { return JSON.parse((await fs.readFile(workspaceFile, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

export async function savedFlowProjectUrl(accountId) {
  const saved = (await readWorkspaces())[accountId];
  return isProjectUrl(saved) ? saved : null;
}

export async function rememberFlowProject(accountId, url) {
  if (!isProjectUrl(url)) return;
  const workspaces = await readWorkspaces();
  if (workspaces[accountId] === url) return;
  // The Flow lane serializes callers. Rename prevents partial JSON after interruption.
  await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
  await fs.writeFile(`${workspaceFile}.tmp`, JSON.stringify({ ...workspaces, [accountId]: url }, null, 2));
  await fs.rename(`${workspaceFile}.tmp`, workspaceFile);
}
