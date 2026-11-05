import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('a real process restart restores the job, scene progress, original inputs, and resume eligibility', async () => {
  const directory = await fs.mkdtemp(fileURLToPath(new URL('../tmp/job-test-', import.meta.url)));
  function run(source) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, FLOW_JOB_STATE_DIR: directory }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  }
  try {
    const original = run(`
      import {createProjectJob,updateScene,updateJob} from './src/jobs.js';
      const job=createProjectJob({ title:'Recovery test',globalInstructions:'Keep the original presenter',referenceImage:'saved-reference.jpg',model:'original-model',aspectRatio:'9:16',scenes:[{prompt:'Scene one',duration:'6s'},{prompt:'Scene two',duration:'8s'}] });
      updateScene(job.id,1,'completed',{videoPath:'scene-one.mp4'});
      updateJob(job.id,'generating',{currentScene:2});
      console.log(JSON.stringify({id:job.id}));
    `);
    const resumed = run(`
      import {getJob,canResumeJob,hasActiveGeneration,updateJob} from './src/jobs.js';
      import {getJobController} from './controllers/video.controller.js';
      const job=getJob('${original.id}');
      let api; getJobController({params:{jobId:job.id}},{json(value){api=value;}});
      console.log(JSON.stringify({job,api,canResume:canResumeJob(job),busy:hasActiveGeneration()}));
    `);
    assert.equal(resumed.job.status, 'interrupted');
    assert.equal(resumed.job.scenes[0].status, 'completed');
    assert.equal(resumed.job.scenes[1].prompt, 'Scene two');
    assert.equal(resumed.job.globalInstructions, 'Keep the original presenter');
    assert.equal(resumed.job.referenceImage, 'saved-reference.jpg');
    assert.equal(resumed.job.model, 'original-model');
    assert.equal(resumed.canResume, true);
    assert.equal(resumed.api.canResume, true);
    assert.equal(resumed.api.jobId, original.id);
    assert.equal(resumed.busy, false);
    const queued = run(`
      import {getJob,canResumeJob,updateJob} from './src/jobs.js';
      import {resumeJobController} from './controllers/video.controller.js';
      const job=updateJob('${original.id}','queued');
      let status; resumeJobController({params:{jobId:job.id}},{status(value){status=value;return this;},json(){}});
      console.log(JSON.stringify({canResume:canResumeJob(job),status}));
    `);
    assert.equal(queued.canResume, false);
    assert.equal(queued.status, 409);
  } finally {
    await fs.rm(path.resolve(directory), { recursive: true, force: true });
  }
});
