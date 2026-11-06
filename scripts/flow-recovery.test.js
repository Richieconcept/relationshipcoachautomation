import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneCheckpointStore, recoverableScene, selectRecoveryTile } from '../services/flow-recovery.service.js';

async function fixture(run) {
  const directory = await fs.mkdtemp(fileURLToPath(new URL('../tmp/recovery-test-', import.meta.url)));
  const outputPath = path.join(directory, 'scene.mp4');
  const store = new SceneCheckpointStore(path.join(directory, 'checkpoints'));
  const request = { outputPath, fingerprint: 'original-inputs', accountId: 'account-1' };
  const calls = { submit: 0, download: 0, open: 0, checkpoints: [] };
  const adapter = {
    async validate(file) {
      if ((await fs.readFile(file).catch(() => '')).toString() !== 'valid-video') {
        throw Object.assign(new Error('invalid file'), { code: 'VIDEO_INVALID' });
      }
      return { duration: 6 };
    },
    async open(checkpoint) { calls.open++; calls.checkpoints.push(checkpoint); },
    async prepare() {}, projectUrl: () => 'https://flow.google.com/project/original',
    async baseline() { return [{ thumbnail: 'old-video' }]; },
    async submit() { calls.submit++; },
    async wait(checkpoint, remember) {
      const target = { thumbnail: 'exact-scene', src: 'fresh-source', verified: true };
      await remember(target);
      return target;
    },
    async download(file) { calls.download++; await fs.writeFile(file, 'valid-video'); },
    status() {}
  };
  try { await run({ directory, outputPath, store, request, calls, adapter }); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('download failure and process restart recover the exact saved generation without resubmission', () => fixture(async f => {
  await assert.rejects(recoverableScene(f.request, { ...f.adapter, download: async () => { throw new Error('download disconnected'); } }, f.store), /disconnected/);
  assert.equal((await f.store.read(f.outputPath)).stage, 'generated');
  const restartedStore = new SceneCheckpointStore(f.store.directory);
  const result = await recoverableScene({ ...f.request, accountId: 'account-2' }, f.adapter, restartedStore);
  assert.equal(f.calls.submit, 1);
  assert.equal(result.accountId, 'account-1');
  assert.equal(f.calls.checkpoints.at(-1).projectUrl, 'https://flow.google.com/project/original');
}));

test('interrupted Generate click is treated as uncertain and never clicked again', () => fixture(async f => {
  await assert.rejects(recoverableScene(f.request, { ...f.adapter, submit: async () => { f.calls.submit++; throw new Error('browser closed after click'); } }, f.store));
  assert.equal((await f.store.read(f.outputPath)).stage, 'submitting');
  await recoverableScene(f.request, f.adapter, f.store);
  assert.equal(f.calls.submit, 1);
}));

test('render timeout resumes waiting for the original generation', () => fixture(async f => {
  await assert.rejects(recoverableScene(f.request, { ...f.adapter, wait: async () => { throw new Error('timeout'); } }, f.store));
  await recoverableScene(f.request, f.adapter, f.store);
  assert.equal(f.calls.submit, 1);
}));

test('partial/corrupt downloads are retried, and valid local scenes skip the browser', () => fixture(async f => {
  await assert.rejects(recoverableScene(f.request, { ...f.adapter, download: file => fs.writeFile(file, 'truncated') }, f.store), /invalid/);
  await recoverableScene(f.request, f.adapter, f.store);
  const opened = f.calls.open;
  await recoverableScene(f.request, f.adapter, f.store);
  assert.equal(f.calls.open, opened);
  assert.equal(f.calls.submit, 1);
  await fs.writeFile(f.outputPath, 'corrupt');
  await recoverableScene(f.request, f.adapter, f.store);
  assert.equal(f.calls.submit, 1);
}));

test('preparation failure can retry, but failed checkpoint writes prevent submission', () => fixture(async f => {
  await assert.rejects(recoverableScene(f.request, { ...f.adapter, prepare: async () => { throw new Error('not ready'); } }, f.store));
  assert.equal(f.calls.submit, 0);
  await assert.rejects(recoverableScene(f.request, f.adapter, { read: () => null, save: async () => { throw new Error('disk full'); } }));
  assert.equal(f.calls.submit, 0);
  await recoverableScene(f.request, f.adapter, f.store);
  assert.equal(f.calls.submit, 1);
}));

test('only an explicitly confirmed scene failure permits regeneration', () => fixture(async f => {
  await assert.rejects(recoverableScene(f.request, { ...f.adapter, wait: async () => { throw Object.assign(new Error('Flow rejected this generation'), { confirmedSceneFailure: true }); } }, f.store));
  assert.equal((await f.store.read(f.outputPath)).stage, 'generation_failed');
  await recoverableScene(f.request, f.adapter, f.store);
  assert.equal(f.calls.submit, 2);
}));

test('changed scene inputs and damaged checkpoint files stop safely', () => fixture(async f => {
  await recoverableScene(f.request, f.adapter, f.store);
  await assert.rejects(recoverableScene({ ...f.request, fingerprint: 'changed' }, f.adapter, f.store), { code: 'SCENE_INPUTS_CHANGED' });
  await fs.writeFile(f.store.file(f.outputPath), '{broken');
  await assert.rejects(recoverableScene(f.request, f.adapter, f.store), { code: 'FLOW_RECOVERY_REQUIRED' });
  await fs.writeFile(f.store.file(f.outputPath), 'null');
  await assert.rejects(recoverableScene(f.request, f.adapter, f.store), { code: 'FLOW_RECOVERY_REQUIRED' });
  assert.equal(f.calls.submit, 1);
}));

test('remote selection never substitutes latest/unrelated videos for a saved result', () => {
  const existing = { thumbnail: 'old', src: 'old-src' }, target = { thumbnail: 'wanted', src: 'fresh-src' };
  const checkpoint = { baseline: [existing], target: { thumbnail: 'wanted', src: 'expired-src' } };
  assert.equal(selectRecoveryTile([existing, target, { thumbnail: 'unrelated' }], checkpoint).tile, target);
  assert.equal(selectRecoveryTile([existing, { thumbnail: 'unrelated' }], checkpoint), null);
  assert.throws(() => selectRecoveryTile([existing, target, { thumbnail: 'unrelated' }], { baseline: [existing] }), { code: 'FLOW_RESULT_AMBIGUOUS' });
});


test('Flow unusual-activity failure is surfaced immediately instead of waiting for a render timeout', async () => {
  const { flowTileFailure } = await import('../services/flow-result-status.service.js');
  const failure = flowTileFailure({ statusText: 'warning Failed We noticed some unusual activity. Note that browser extensions that modify the page may cause issues. Please visit the Help Center for more information.' });
  assert.equal(failure.code, 'FLOW_UNUSUAL_ACTIVITY');
  assert.equal(failure.confirmedSceneFailure, true);
  assert.match(failure.message, /Open Flow manually/);
  assert.match(failure.message, /Automatic resubmission is disabled/);
  assert.equal(flowTileFailure({ statusText: 'play_circle 360p', text: 'The presenter discusses a failed relationship.' }), null);
  assert.equal(flowTileFailure({ statusText: 'warning Failed' }).code, 'GENERATION_FAILED');
});

function missingError(){return Object.assign(new Error('Result unavailable'),{code:'SCENE_RESULT_MISSING',automationCode:'SCENE_RESULT_MISSING',confirmedMissingScene:true});}
test('a missing result is replaced on the next attempt and preserves original recovery history',()=>fixture(async f=>{
 await assert.rejects(recoverableScene(f.request,{...f.adapter,download:async()=>{throw Error('Download unavailable');}},f.store));assert.equal(f.calls.submit,1);
 await assert.rejects(recoverableScene(f.request,{...f.adapter,wait:async()=>{throw missingError();}},f.store),{code:'SCENE_RESULT_MISSING'});const saved=await f.store.read(f.outputPath);assert.equal(saved.stage,'result_missing');assert.equal(saved.replacementCount,1);assert.equal(saved.replacementHistory[0].target.thumbnail,'exact-scene');
 await recoverableScene(f.request,f.adapter,new SceneCheckpointStore(f.store.directory));assert.equal(f.calls.submit,2);const done=await f.store.read(f.outputPath);assert.equal(done.stage,'downloaded');assert.equal(done.fingerprint,'original-inputs');assert.equal(done.replacementCount,1);assert.equal(done.replacementHistory.length,1);
}));
test('replacement limit survives process restarts and stops further Generate clicks',()=>fixture(async f=>{
 const adapter={...f.adapter,wait:async()=>{throw missingError();}};
 await assert.rejects(recoverableScene(f.request,adapter,new SceneCheckpointStore(f.store.directory)),{code:'SCENE_RESULT_MISSING'});
 await assert.rejects(recoverableScene(f.request,adapter,new SceneCheckpointStore(f.store.directory)),{code:'SCENE_RESULT_MISSING'});
 await assert.rejects(recoverableScene(f.request,f.adapter,new SceneCheckpointStore(f.store.directory)),{code:'SCENE_RETRY_EXHAUSTED'});
 assert.equal(f.calls.submit,2);assert.equal((await f.store.read(f.outputPath)).generationCount,2);
}));

test('missing-result confirmation waits for a loaded original project and repeated stable checks',async()=>{
 const {MissingSceneTracker}=await import('../services/missing-scene.service.js');const tracker=new MissingSceneTracker();const state={projectUrl:'https://flow.google.com/project/original',expectedProjectUrl:'https://flow.google.com/project/original',composerReady:true,tiles:[]};assert.equal(tracker.observe({...state,now:0}),false);assert.equal(tracker.observe({...state,now:10000}),false);assert.equal(tracker.observe({...state,now:20000}),true);tracker.reset();assert.equal(tracker.observe({...state,now:0}),false);assert.equal(tracker.observe({...state,now:20000,blocked:true}),false);assert.equal(tracker.observe({...state,now:30000}),false);assert.equal(tracker.observe({...state,now:40000,tiles:[{statusText:'Generating 40%'}]}),false);assert.equal(tracker.observe({...state,now:50000,composerReady:false}),false);assert.equal(tracker.observe({...state,now:60000,projectUrl:'https://flow.google.com/project/other'}),false);
});
test('selected-scene policy rejection is permanent for this video, not a generic retryable failure',async()=>{const {flowTileFailure}=await import('../services/flow-result-status.service.js');assert.equal(flowTileFailure({statusText:'Failed: this prompt may violate our content policies'}).code,'GENERATION_REJECTED');});

test('duplicate DOM tiles of the same media do not become ambiguous results',()=>{const first={thumbnail:'https://example.com/clip',mediaId:'same'};const selected=selectRecoveryTile([first,{...first,index:1}],{baseline:[]});assert.equal(selected.tile,first);});

test('different media IDs sharing a placeholder remain distinct',()=>{assert.throws(()=>selectRecoveryTile([{mediaId:'one',thumbnail:'placeholder'},{mediaId:'two',thumbnail:'placeholder'}],{baseline:[]}),{code:'FLOW_RESULT_AMBIGUOUS'});});


test('prompt-mismatched candidates are skipped while a matching result can still recover', () => {
  const unrelated = { mediaId: 'wrong', thumbnail: 'wrong-thumb', src: 'wrong-src' };
  const wanted = { mediaId: 'wanted', thumbnail: 'wanted-thumb' };
  const checkpoint = { baseline: [] };
  assert.equal(selectRecoveryTile([unrelated], checkpoint, [unrelated]), null);
  assert.equal(selectRecoveryTile([unrelated, wanted], checkpoint, [unrelated]).tile, wanted);
  assert.equal(selectRecoveryTile([unrelated, wanted], { baseline: [], target: wanted }, [unrelated]).exact, true);
});

test('a previously blocked prompt mismatch can auto-resume within its production window', async () => {
  const { canAutoResume } = await import('../services/production-policy.service.js');
  const job = { mode: 'generate_only', status: 'failed', errorCode: 'FLOW_RECOVERY_REQUIRED', message: 'The candidate video has a different prompt. No new generation was submitted.' };
  assert.equal(canAutoResume(job), true);
  assert.equal(canAutoResume({ ...job, productionDeadline: '2020-01-01T00:00:00Z' }), false);
  assert.equal(canAutoResume({ ...job, message: 'The original project is not ready to verify this scene.' }), false);
});


test('three failed downloads survive restarts and cause regeneration, then download succeeds',()=>fixture(async f=>{
 const broken={...f.adapter,download:async()=>{throw Object.assign(new Error('Old video is unavailable'),{code:'DOWNLOAD_FAILED'});}};
 for(let i=1;i<=3;i++){
  await assert.rejects(recoverableScene(f.request,broken,new SceneCheckpointStore(f.store.directory)),{code:i===3?'SCENE_RESULT_MISSING':'DOWNLOAD_FAILED'});
  const saved=await f.store.read(f.outputPath);assert.equal(saved.downloadFailures,i);assert.equal(saved.stage,i===3?'result_missing':'generated');
  assert.equal(f.calls.submit,1);
 }
 await recoverableScene(f.request,f.adapter,new SceneCheckpointStore(f.store.directory));
 assert.equal(f.calls.submit,2);const saved=await f.store.read(f.outputPath);assert.equal(saved.stage,'downloaded');assert.equal(saved.downloadFailures,0);assert.equal(saved.replacementHistory.length,1);
}));

test('corrupt downloads trigger replacement but filesystem failures do not discard the remote video',()=>fixture(async f=>{
 const corrupt={...f.adapter,download:file=>fs.writeFile(file,'corrupt')};
 for(let i=0;i<3;i++)await assert.rejects(recoverableScene(f.request,corrupt,f.store));
 assert.equal((await f.store.read(f.outputPath)).stage,'result_missing');
 const denied={...f.adapter,download:async()=>{throw Object.assign(new Error('File is locked'),{code:'EPERM'});}};
 await assert.rejects(recoverableScene(f.request,denied,f.store),{code:'EPERM'});
 const saved=await f.store.read(f.outputPath);assert.equal(saved.stage,'generated');assert.equal(saved.downloadFailures,0);
 await recoverableScene(f.request,f.adapter,f.store);assert.equal(f.calls.submit,2);
}));

test('Flow thumbnail and playback URL refer to the same media when hovering changes their format',()=>{
 const thumbnail='https://flow.google.com/asb/clip-123';
 const selected=selectRecoveryTile([{src:thumbnail+'=mm,18,15'}],{target:{thumbnail},baseline:[]});
 assert.equal(selected.exact,true);
 assert.equal(selectRecoveryTile([{src:thumbnail+'=mm,18,15'}],{baseline:[{thumbnail}]}),null);
});

test('pending placeholders prevent regeneration even without visible percentage text',async()=>{
 const {MissingSceneTracker}=await import('../services/missing-scene.service.js');
 const tracker=new MissingSceneTracker();const state={projectUrl:'https://flow.google.com/project/original',expectedProjectUrl:'https://flow.google.com/project/original',composerReady:true,tiles:[{pending:true}]};
 for(const now of [0,10000,30000,60000])assert.equal(tracker.observe({...state,now}),false);
});
