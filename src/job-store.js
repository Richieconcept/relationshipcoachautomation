import { writeAtomicJson } from './atomic-json.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const directory = process.env.FLOW_JOB_STATE_DIR || path.join(config.rootDir, 'tmp', 'jobs');

export function saveJob(job) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${job.id}.json`);
  writeAtomicJson(file, job);
}

export function loadJobs() {
  fs.mkdirSync(directory, { recursive: true });
  return fs.readdirSync(directory).filter(name => /^vid_[\d_]+\.json$/.test(name)).map(name => {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (job.id !== name.slice(0, -5)) return null;
      return job;
    } catch {
      // Retain a damaged file for inspection. Never silently turn it into a new job.
      return null;
    }
  }).filter(Boolean);
}
