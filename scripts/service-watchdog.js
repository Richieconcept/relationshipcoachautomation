import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';
const port=config.port;
const healthy=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(3000)}).then(async r=>r.ok && (await r.json()).status==='ok').catch(()=>false);
if(!healthy){
 const occupied=await new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(true);});});
 if(!occupied){
  const lock=path.join(config.rootDir,'tmp','service-launch.lock');fs.mkdirSync(path.dirname(lock),{recursive:true});
  let handle;
  try { handle=fs.openSync(lock,'wx'); }
  catch(error){if(error.code!=='EEXIST')throw error; if(Date.now()-fs.statSync(lock).mtimeMs>120000){fs.unlinkSync(lock);handle=fs.openSync(lock,'wx');}}
  if(handle!==undefined){
   try {
    fs.mkdirSync(path.join(config.rootDir,'logs'),{recursive:true});
    const log=fs.openSync(path.join(config.rootDir,'logs','watchdog-server.log'),'a');
    try{const child=spawn(process.execPath,['src/server.js'],{cwd:config.rootDir,detached:true,windowsHide:true,stdio:['ignore',log,log]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();console.log('Video server started.');}
    finally{fs.closeSync(log);}
   } finally {fs.closeSync(handle);fs.unlinkSync(lock);}
  }
 }
}
