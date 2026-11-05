import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// Windows scanners can briefly lock a destination during atomic replacement.
export function writeAtomicJson(file, data, { io = fs, wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
 io.mkdirSync(path.dirname(file), { recursive: true });
 const temporary = file + '.' + randomUUID() + '.tmp';
 try {
  io.writeFileSync(temporary, JSON.stringify(data, null, 2));
  for(let attempt=0;;attempt++) {
   try { io.renameSync(temporary, file); return; }
   catch(error) { if(!['EPERM','EACCES','EBUSY'].includes(error.code) || attempt>=6) throw error; wait(25*(attempt+1)); }
  }
 } catch(error) { try { io.unlinkSync(temporary); } catch {} throw error; }
}
