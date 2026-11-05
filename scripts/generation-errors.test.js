import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { flowTileFailure, generationFailureDetails } from '../services/flow-result-status.service.js';

test('policy rejection asks for script revision and retains the exact provider message',()=>{
 const raw='Failed: this prompt may violate our content policies';
 const error=flowTileFailure({statusText:raw});const detail=generationFailureDetails(error.code,error.providerMessage);
 assert.equal(detail.code,'GENERATION_REJECTED');assert.equal(detail.scriptNeedsRevision,true);assert.match(detail.nextAction,/Edit the script/);assert.equal(detail.providerMessage,raw);
});
test('unusual activity is account attention rather than a script policy failure',()=>{
 const error=flowTileFailure({statusText:'Failed We noticed some unusual activity. Please visit the Help Center.'});
 const detail=generationFailureDetails(error.code,error.providerMessage);
 assert.equal(detail.code,'FLOW_UNUSUAL_ACTIVITY');assert.equal(detail.scriptNeedsRevision,false);assert.match(detail.nextAction,/affected Google account/);assert.match(detail.nextAction,/Changing the script is not required/);
});
test('network errors are temporary and unknown failures are not presented as policy rejection',()=>{
 assert.match(generationFailureDetails('NETWORK_ERROR').nextAction,/retry automatically/);
 assert.equal(generationFailureDetails('GENERATION_FAILED'),null);
 assert.equal(generationFailureDetails('UNKNOWN_ERROR'),null);
});
test('failed job API exposes the action and failed-scene details, then clears guidance on resume',async()=>{
 const directory=await fs.mkdtemp(fileURLToPath(new URL('../tmp/error-guidance-',import.meta.url)));
 process.env.FLOW_JOB_STATE_DIR=directory;
 try{
 const {createProjectJob,updateJob,updateScene}=await import('../src/jobs.js');
 const {getJobController}=await import('../controllers/video.controller.js');
 const job=createProjectJob({title:'Error guidance fixture',scenes:['Original scene']});
 const raw='This prompt may violate our content policies';
 updateScene(job.id,1,'failed',{error:'GENERATION_REJECTED',providerMessage:raw});
 updateJob(job.id,'failed',{errorCode:'GENERATION_REJECTED',providerMessage:raw,failedScene:1});
 let response;getJobController({params:{jobId:job.id}},{json(value){response=value;}});
 assert.equal(response.failure.scriptNeedsRevision,true);assert.equal(response.failure.providerMessage,raw);assert.equal(response.scenes[0].failure.providerMessage,raw);
 updateJob(job.id,'queued');getJobController({params:{jobId:job.id}},{json(value){response=value;}});assert.equal(response.failure,null);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
