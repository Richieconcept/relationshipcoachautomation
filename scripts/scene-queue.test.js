import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('missing Flow settings fail once even when transient retries are persistent', async () => {
  const directory = await fs.mkdtemp(fileURLToPath(new URL('../tmp/queue-test-', import.meta.url)));
  process.env.FLOW_JOB_STATE_DIR = path.join(directory, 'jobs');
  const { config } = await import('../src/config.js');
  const { createProjectJob } = await import('../src/jobs.js');
  const { runProject } = await import('../services/scene-queue.service.js');
  const oldDelay = config.generationRetryDelayMs;
  const oldProjects = config.projectDownloadDir;
  config.generationRetryDelayMs = 0;
  config.projectDownloadDir = path.join(directory, 'projects');
  try {
    const job = createProjectJob({ title: 'Settings error', aspectRatio: '9:16', scenes: ['Test scene'] });
    let calls = 0;
    await runProject(job.id, { generateScene: async options => {
      calls++;
      assert.equal(options.maxRetries, 0);
      throw Object.assign(new Error('Model setting unavailable'), { automationCode: 'FLOW_SETTING_NOT_FOUND' });
    } });
    assert.equal(calls, 1);
    assert.equal(job.status, 'failed');
    assert.equal(job.scenes[0].attempts, 1);
  } finally {
    config.generationRetryDelayMs = oldDelay;
    config.projectDownloadDir = oldProjects;
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test('scene retry budget stays finite even with the legacy persistent setting enabled', async()=>{
 const {config}=await import('../src/config.js'); const {createProjectJob}=await import('../src/jobs.js');
 const {generateSceneWithRetries}=await import('../services/scene-queue.service.js');
 const {canAutoResume}=await import('../services/production-policy.service.js');
 const previous=config.retrySceneUntilSuccess; config.retrySceneUntilSuccess=true;
 try {
  const job=createProjectJob({title:'Bounded recovery',aspectRatio:'9:16',scenes:['Original scene']}); let calls=0; let closed=0; const waits=[];
  const result=await generateSceneWithRetries(job,job.scenes[0],async options=>{
   assert.equal(closed,calls); assert.equal(options.maxRetries,0); calls++;
   throw Object.assign(new Error('Temporary download failure'),{automationCode:'DOWNLOAD_FAILED'});
  },async ms=>{assert.equal(closed,calls);waits.push(ms);},Date.now,async()=>({duration:6}),async()=>{closed++;});
  assert.equal(calls,config.maxSceneRetries+1); assert.equal(closed,calls); assert.equal(waits.length,config.maxSceneRetries);
  assert.equal(result.code,'SCENE_RETRY_EXHAUSTED'); assert.match(result.error.message,/DOWNLOAD_FAILED/);
  assert.equal(canAutoResume({status:'failed',mode:'generate_only',errorCode:result.code}),false);
 } finally {config.retrySceneUntilSuccess=previous;}
});

test('unusual activity closes the browser and stops without retrying or switching accounts', async()=>{
 const {createProjectJob}=await import('../src/jobs.js'); const {generateSceneWithRetries}=await import('../services/scene-queue.service.js');
 const job=createProjectJob({title:'Account warning',scenes:['Scene']}); let closed=0; let calls=0;
 const result=await generateSceneWithRetries(job,job.scenes[0],async()=>{calls++;throw Object.assign(new Error('Google unusual activity'),{automationCode:'FLOW_UNUSUAL_ACTIVITY'});},async()=>{throw Error('No retry expected');},Date.now,async()=>{},async()=>{closed++;});
 assert.equal(calls,1);assert.equal(closed,1);assert.equal(result.code,'FLOW_UNUSUAL_ACTIVITY');
});

test('persistent retries respect scheduled deadlines', async()=>{
 const {config}=await import('../src/config.js');const {createProjectJob}=await import('../src/jobs.js');const {generateSceneWithRetries}=await import('../services/scene-queue.service.js');
 const previous=config.retrySceneUntilSuccess;config.retrySceneUntilSuccess=true;
 try{let clock=Date.parse('2026-11-05T00:00:00Z');const job=createProjectJob({title:'Deadline',aspectRatio:'9:16',productionDeadline:new Date(clock+15000).toISOString(),scenes:['Scene']});let calls=0;
 const result=await generateSceneWithRetries(job,job.scenes[0],async()=>{calls++;throw Object.assign(new Error('Temporary failure'),{automationCode:'NETWORK_ERROR'});},async ms=>{clock+=ms;},()=>clock);
 assert.equal(result.code,'PRODUCTION_WINDOW_MISSED');assert.equal(calls,2);
 }finally{config.retrySceneUntilSuccess=previous;}
});


test('missing previously completed scenes regenerate when neither the file nor checkpoint exists',async()=>{
 const {createProjectJob}=await import('../src/jobs.js');const {runProject}=await import('../services/scene-queue.service.js');
 const job=createProjectJob({title:'Missing old clip',aspectRatio:'9:16',scenes:['Original dialogue']});job.scenes[0].status='completed';job.scenes[0].videoPath='Z:/unavailable/scene.mp4';
 let calls=0;await runProject(job.id,{generateScene:async()=>{calls++;throw Object.assign(new Error('Settings unavailable'),{automationCode:'FLOW_SETTING_NOT_FOUND'});}});
 assert.equal(calls,1);assert.equal(job.errorCode,'FLOW_SETTING_NOT_FOUND');
});
