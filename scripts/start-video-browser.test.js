import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';
import { ContentStore } from '../services/content-plan.service.js';
import { splitScript } from '../services/script-splitter.service.js';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'start-video-ui-'));
process.env.FLOW_JOB_STATE_DIR=path.join(directory,'jobs');
const { ContentScheduler }=await import('../services/content-scheduler.service.js');
const { contentRoutes }=await import('../routes/content.routes.js');
const { createProjectJob, getJob, updateJob, updateScene }=await import('../src/jobs.js');
const { getJobController, splitScriptController }=await import('../controllers/video.controller.js');
const root=fileURLToPath(new URL('..',import.meta.url));
const delayGate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
const script='Respect should go both ways. Listen to your partner and communicate with kindness.';
let sequence=0;
test.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
async function fixture({missing=false,verification=false}={}){
 const sourceGate=delayGate(),generationGate=delayGate(),editorGate=delayGate();
 const store=new ContentStore(path.join(directory,'content-'+sequence++));
 store.settings({scriptSource:'chatgpt',projectUrl:'https://chatgpt.com/g/g-p-test/project',planningConversationUrl:'https://chatgpt.com/g/g-p-test/c/planning',autoPublish:true,platforms:['facebook']});
 const item=store.ensure('2026-11-02','afternoon');store.update(item.id,{title:'Old title',script:'A stale cached script must not bypass ChatGPT.',status:'script_ready'});
 const calls=[];let request;let settings;
 const scheduler=new ContentScheduler({store,findJob:id=>{const jobId=store.state.items[id]?.jobId;return jobId?getJob(jobId):null;},jobById:getJob,
 requestScript:async input=>{calls.push('chatgpt');request=input;if(verification)input.checkpoint({humanVerificationRequired:true,verificationPhase:'before_send'});await sourceGate.promise;if(verification)input.checkpoint({humanVerificationRequired:false,verificationPhase:null});return missing?'CONTENT_NOT_PLANNED':JSON.stringify({date:item.date,slot:item.slot,title:'Respect and communication',script});},
 createVideo:async(content,options,onCreated)=>{settings=options;calls.push('splitter');const split=splitScript(content.script);calls.push('generator');
 const job=createProjectJob({contentSlotId:content.id,title:content.title,source:'script',script:content.script,mode:'generate_only',aspectRatio:'9:16',editing:{logo:true,music:false,captions:true},scenes:split.scenes.map(scene=>({prompt:scene.text,spokenText:scene.text,duration:scene.duration}))});
 updateJob(job.id,'generating',{message:'Fixture generation running.'});onCreated(job.id);await generationGate.promise;
 for (const scene of job.scenes) updateScene(job.id, scene.number, 'completed', { message: 'Fixture clip ready.' });
 calls.push('editor');updateJob(job.id,'editing',{completedScenes:job.scenes.length,message:'Fixture editor running.'});await editorGate.promise;
 updateJob(job.id,'completed',{finalVideoUrl:'/fixture-final.mp4',finalVideoPath:'fixture-final.mp4',finalVideo:{sizeBytes:4096,duration:8,width:1080,height:1920},message:'Final video ready.'});return getJob(job.id);},
 publishVideo:()=>{throw new Error('Start Video must not publish.');}});
 const app=express();app.use(express.json());app.use('/api/content',contentRoutes(scheduler).router);
 app.get('/api/brand/defaults',(req,res)=>res.json({defaults:{globalInstructions:''}}));app.get('/api/brand',(req,res)=>res.json({assets:{}}));app.get('/api/videos/accounts',(req,res)=>res.json({accounts:[]}));
 app.get('/api/videos/jobs/:jobId',getJobController);app.post('/api/videos/split-script',splitScriptController);
 app.get('/fixture-final.mp4',(req,res)=>res.status(204).end());app.use(express.static(path.join(root,'public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 return {server,scheduler,store,calls,sourceGate,generationGate,editorGate,get request(){return request;},get settings(){return settings;},url:'http://127.0.0.1:'+server.address().port,
 async close(){sourceGate.release();generationGate.release();editorGate.release();await scheduler.queue;await new Promise(resolve=>server.close(resolve));}};
}

test('one Start Video click fetches the script and reaches generation, editing and final preview; reload never starts a second run',async()=>{
 const f=await fixture();const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(f.url);await page.locator('.saved-slot-disclosure > summary').click();await page.locator('#approved-video-date').fill('2026-11-02');await page.locator('#approved-video-slot').selectOption('afternoon');
 await page.getByRole('button',{name:'Start Video',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#approved-video-status').textContent.includes('Requesting the approved script'));
 assert.deepEqual(f.calls,['chatgpt']);assert.equal(f.request.projectUrl,'https://chatgpt.com/g/g-p-test/c/planning');
 await page.locator('#approved-video-start').evaluate(form=>form.requestSubmit());assert.equal(f.calls.length,1);
 await page.reload();await page.locator('.saved-slot-disclosure > summary').click();await page.waitForFunction(()=>document.querySelector('#approved-video-status').textContent.includes('Requesting the approved script'));
 assert.deepEqual(f.calls,['chatgpt']);assert.equal(await page.locator('#approved-video-date').inputValue(),'2026-11-02');assert.equal(await page.locator('#approved-video-slot').inputValue(),'afternoon');f.sourceGate.release();
 await page.waitForFunction(()=>document.querySelector('#job-status').textContent.startsWith('Generating'));
 assert.deepEqual(f.calls,['chatgpt','splitter','generator']);assert.equal(f.settings.autoPublish,false);assert.deepEqual(f.settings.platforms,[]);
 assert.equal(await page.locator('#approved-video-script').textContent(),script);
 f.generationGate.release();await page.waitForFunction(()=>document.querySelector('#job-status').textContent.startsWith('Editing'));
 f.editorGate.release();await page.waitForFunction(()=>!document.querySelector('#video-preview').hidden);
 assert.match(await page.locator('#video-preview').getAttribute('src'),/fixture-final\.mp4/);
 assert.equal(await page.locator('#start-approved-video').isEnabled(),true);
 assert.deepEqual(f.calls,['chatgpt','splitter','generator','editor']);assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(root,'tmp','start-video-preview.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
 }finally{await browser.close();await f.close();}
});

test('missing approval stops at ChatGPT and displays an error without generating from cache',async()=>{
 const f=await fixture({missing:true});const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.goto(f.url);await page.locator('.saved-slot-disclosure > summary').click();await page.locator('#approved-video-date').fill('2026-11-02');await page.locator('#approved-video-slot').selectOption('afternoon');
 await page.getByRole('button',{name:'Start Video',exact:true}).click();f.sourceGate.release();
 await page.waitForFunction(()=>document.querySelector('#approved-video-status').textContent.includes('could not locate approved content'));
 assert.deepEqual(f.calls,['chatgpt']);assert.equal(f.store.state.items['2026-11-02-afternoon'].script,null);assert.equal(await page.locator('#start-approved-video').isEnabled(),true);
 assert.equal(await page.locator('#video-preview').isVisible(),false);
 }finally{await browser.close();await f.close();}
});


test('Start Video displays a manual-verification pause and continues the same run afterward',async()=>{
 const f=await fixture({verification:true});const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.goto(f.url);await page.locator('.saved-slot-disclosure > summary').click();await page.locator('#approved-video-date').fill('2026-11-02');await page.locator('#approved-video-slot').selectOption('afternoon');
 await page.getByRole('button',{name:'Start Video',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#approved-video-status').textContent.includes('Complete human verification manually'));
 assert.deepEqual(f.calls,['chatgpt']);assert.equal(await page.locator('#start-approved-video').isEnabled(),false);
 f.sourceGate.release();await page.waitForFunction(()=>document.querySelector('#job-status').textContent.startsWith('Generating'));
 assert.deepEqual(f.calls,['chatgpt','splitter','generator']);
 }finally{await browser.close();await f.close();}
});
