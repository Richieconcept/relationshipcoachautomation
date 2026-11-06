import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../src/config.js';
import { setTimeout as delay } from 'node:timers/promises';

export function recoveryError(message, code = 'FLOW_RECOVERY_REQUIRED') {
  return Object.assign(new Error(message), { code, automationCode: code });
}

export class SceneCheckpointStore {
  constructor(directory = path.join(config.rootDir, 'tmp', 'flow-scenes')) { this.directory = directory; }
  file(outputPath) {
    return path.join(this.directory, `${createHash('sha256').update(path.resolve(outputPath)).digest('hex')}.json`);
  }
  async read(outputPath) {
    try {
      const checkpoint = JSON.parse(await fs.readFile(this.file(outputPath), 'utf8'));
      const stages = ['submitting', 'submitted', 'generated', 'downloaded', 'generation_failed', 'result_missing'];
      if (!checkpoint || checkpoint.version !== 1 || typeof checkpoint.fingerprint !== 'string'
        || typeof checkpoint.accountId !== 'string' || typeof checkpoint.projectUrl !== 'string'
        || !Array.isArray(checkpoint.baseline) || !stages.includes(checkpoint.stage)
        || (['generated', 'downloaded'].includes(checkpoint.stage) && !checkpoint.target?.thumbnail && !checkpoint.target?.src)) {
        throw new Error('Invalid checkpoint structure');
      }
      const project = new URL(checkpoint.projectUrl);
      if (project.protocol !== 'https:' || !['flow.google.com', 'labs.google'].includes(project.hostname)) throw new Error('Invalid Flow project');
      return checkpoint;
    }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw recoveryError('The saved scene checkpoint is unreadable. Inspect it before generating again.');
    }
  }
  async save(outputPath, checkpoint) {
    await fs.mkdir(this.directory, { recursive: true });
    const file = this.file(outputPath);
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() }, null, 2));
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(`${file}.tmp`, file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        await delay(25 * (attempt + 1));
      }
    }
  }
}

export const sceneCheckpoints = new SceneCheckpointStore();
export function sceneFingerprint(options, referenceName = null) {
  return createHash('sha256').update(JSON.stringify({
    prompt: options.prompt, referenceName, model: options.model,
    aspectRatio: options.aspectRatio, duration: options.duration
  })).digest('hex');
}

export const needsRecovery = checkpoint => checkpoint && ['submitting', 'submitted', 'generated', 'downloaded'].includes(checkpoint.stage);

function mediaKey(value) {
 if (!value) return '';
 try { const url = new URL(value); for(const key of [...url.searchParams.keys()]) if (/^(x-goog-|x-amz-|signature$|expires$|googleaccessid$)/i.test(key)) url.searchParams.delete(key); if (url.hostname === 'flow.google.com' && url.pathname.startsWith('/asb/')) url.pathname = url.pathname.replace(/=mm,.*$/, ''); return url.href; }
 catch { return value; }
}
function sameMedia(a,b) {
 if (a.mediaId && b.mediaId) return a.mediaId === b.mediaId;
 return Boolean((a.mediaId && b.mediaId && a.mediaId === b.mediaId)
  || (a.thumbnail && b.thumbnail && mediaKey(a.thumbnail) === mediaKey(b.thumbnail))
  || (a.src && b.src && mediaKey(a.src) === mediaKey(b.src))
  || ([a.thumbnail, a.src].filter(Boolean).some(value => [b.thumbnail, b.src].filter(Boolean).some(other => mediaKey(value) === mediaKey(other)))));
}
export function recoveryCandidates(tiles, checkpoint, rejectedCandidates = []) {
 return tiles.filter((tile, index, all) => !all.slice(0, index).some(old => sameMedia(old, tile)))
  .filter(tile => !rejectedCandidates.some(rejected => sameMedia(rejected, tile))
   && !(checkpoint.baseline || []).some(old => sameMedia(old, tile)
    || (!old.thumbnail && !old.src && !old.mediaId && old.text === tile.text)));
}
export function selectRecoveryTile(tiles, checkpoint, rejectedCandidates = []) {
 const target = checkpoint.target;
 // Flow can render the same asset in more than one DOM tile.
 tiles = tiles.filter((tile,index,all) => !all.slice(0,index).some(old => sameMedia(old,tile)));
 const exact = target && tiles.filter(tile => sameMedia(target,tile));
 if(exact?.length === 1) return { tile: exact[0], exact: true };
 if(target?.thumbnail || target?.mediaId) return null;
 const candidates = recoveryCandidates(tiles, checkpoint, rejectedCandidates);
 if(candidates.length > 1) throw recoveryError('Several different Flow results need verification before replacement.', 'FLOW_RESULT_AMBIGUOUS');
 return candidates.length === 1 ? { tile:candidates[0], exact:false } : null;
}

// Inspect saved progress before resubmission. Only confirmed failure or a stable
// unavailable result permits a bounded replacement; persist that decision first.
export async function recoverableScene({ outputPath, fingerprint, accountId }, adapter, store = sceneCheckpoints) {
  let checkpoint = await store.read(outputPath);
  if (checkpoint && checkpoint.fingerprint !== fingerprint) {
    throw recoveryError('This scene has saved progress for different inputs. Resume the original scene or create a new project.', 'SCENE_INPUTS_CHANGED');
  }
  try {
    const video = await adapter.validate(outputPath);
    return { videoPath: outputPath, accountId: checkpoint?.accountId || accountId, recovered: true, video };
  } catch (error) {
    if (error.code !== 'VIDEO_INVALID') throw error;
  }

  const recovering = needsRecovery(checkpoint);
  if (!recovering && checkpoint && (checkpoint.generationCount || 1) >= config.maxSceneReplacements + 1) {
    throw recoveryError('The scene replacement limit was reached. Saved progress is retained; review the failure before generating again.', 'SCENE_RETRY_EXHAUSTED');
  }
  await adapter.open(recovering ? checkpoint : null);
  if (!recovering) {
    await adapter.prepare();
    checkpoint = {
      version: 1, fingerprint, accountId, stage: 'submitting',
      projectUrl: adapter.projectUrl(), baseline: await adapter.baseline(),
      submittedAt: new Date().toISOString(), target: null,
      downloadFailures: 0,
      generationCount: checkpoint ? (checkpoint.generationCount || 1) + 1 : 1,
      replacementCount: checkpoint?.replacementCount || 0,
      replacementHistory: checkpoint?.replacementHistory || []
    };
    await store.save(outputPath, checkpoint); // Must succeed before any click that could spend credits.
    await adapter.submit();
    checkpoint.stage = 'submitted';
    await store.save(outputPath, checkpoint);
  } else {
    adapter.status('recovering', 'Checking this scene’s existing Flow generation. No new generation is being submitted.');
  }

  const rememberTarget = async target => {
    checkpoint.target = target;
    await store.save(outputPath, checkpoint);
  };
  let target;
  try {
    target = await adapter.wait(checkpoint, rememberTarget);
  } catch (error) {
    if (error.confirmedMissingScene && error.automationCode === 'SCENE_RESULT_MISSING') {
      checkpoint.replacementHistory = [...(checkpoint.replacementHistory || []), { projectUrl: checkpoint.projectUrl, target: checkpoint.target, submittedAt: checkpoint.submittedAt, replacedAt: new Date().toISOString(), reason: error.replacementReason || 'Result unavailable after repeated checks' }];
      checkpoint.replacementCount = (checkpoint.replacementCount || 0) + 1;
      checkpoint.stage = 'result_missing';
      await store.save(outputPath, checkpoint);
      adapter.status('retrying', 'No identifiable scene was available after repeated checks. Generating a fresh replacement on the next attempt; completed scenes are kept.');
    }
    if (error.confirmedSceneFailure) {
      checkpoint.stage = 'generation_failed';
      await store.save(outputPath, checkpoint);
    }
    throw error;
  }
  checkpoint = { ...checkpoint, stage: 'generated', target };
  await store.save(outputPath, checkpoint); // A failed download cannot lose the remote result.
  adapter.status('downloading', recovering ? 'Downloading the existing generated scene.' : 'Downloading generated video.');
  const partialPath = `${outputPath}.part.mp4`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await adapter.download(partialPath, target);
    await adapter.validate(partialPath);
  } catch (error) {
    const code = error.automationCode || error.code;
    if (['DOWNLOAD_FAILED', 'VIDEO_INVALID'].includes(code)) {
      checkpoint.downloadFailures = (checkpoint.downloadFailures || 0) + 1;
      if (checkpoint.downloadFailures >= (config.maxDownloadRecoveryAttempts || 3)) {
        checkpoint.replacementHistory = [...(checkpoint.replacementHistory || []), { projectUrl: checkpoint.projectUrl, target: checkpoint.target, submittedAt: checkpoint.submittedAt, replacedAt: new Date().toISOString(), reason: 'Existing video could not be downloaded after repeated attempts' }];
        checkpoint.replacementCount = (checkpoint.replacementCount || 0) + 1;
        checkpoint.stage = 'result_missing';
        await store.save(outputPath, checkpoint);
        throw Object.assign(recoveryError('The old video could not be downloaded after repeated attempts. A fresh replacement will be generated on the next retry.', 'SCENE_RESULT_MISSING'), { confirmedMissingScene: true });
      }
      await store.save(outputPath, checkpoint);
    }
    throw error;
  }
  await fs.rename(partialPath, outputPath);
  await store.save(outputPath, { ...checkpoint, stage: 'downloaded', downloadFailures: 0 });
  return { videoPath: outputPath, accountId: checkpoint.accountId, recovered: Boolean(recovering) };
}
