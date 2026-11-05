import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';
import { ContentStore, slotInfo } from '../services/content-plan.service.js';
import { requestChatgptScript, openChatgptLogin } from '../services/chatgpt-browser.service.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'content-browser-test-'));
process.env.FLOW_JOB_STATE_DIR = path.join(directory, 'jobs');
const { ContentScheduler } = await import('../services/content-scheduler.service.js');
const { contentRoutes } = await import('../routes/content.routes.js');
const projectUrl = 'https://chatgpt.com/g/g-p-fixture/project';
const root = fileURLToPath(new URL('..', import.meta.url));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('browser worker reads only a new completed answer and checkpoints it', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext(); const checkpoints = [];
    // All ChatGPT requests are fulfilled locally; no real account or network is used.
    await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
      <article><div data-message-author-role="assistant">Old unrelated response</div><button aria-label="Copy response">Copy</button></article>
      <div role="textbox" contenteditable="true" data-composer-markdown aria-label="New chat in video automation"></div><button type="submit" aria-label="Send" onclick="send()">Send</button>
      <script>function send(){
        const u=document.createElement('div');u.dataset.contentSearchUnitKey='fixture-turn-0:0:user';u.textContent=document.querySelector('[role="textbox"]').textContent;document.body.append(u);
        const a=document.createElement('div');a.dataset.talvtTurnState='streaming';a.innerHTML='<div data-markdown-text-style="assistant-message">Partial</div>';document.body.append(a);
        const stop=document.createElement('button');stop.dataset.testid='stop-button';document.body.append(stop);
        setTimeout(()=>{a.firstChild.textContent='Complete planned script response';a.dataset.talvtTurnState='complete';stop.remove();const copy=document.createElement('button');copy.setAttribute('aria-label','Copy response');a.append(copy);},300);
      }</script></body></html>` }));
    const response = await requestChatgptScript({ projectUrl, prompt: 'Retrieve tomorrow morning script', contextFactory: async () => ctx, timeoutMs: 15000, checkpoint: patch => checkpoints.push(patch) });
    assert.equal(response, 'Complete planned script response');
    assert.deepEqual(checkpoints.map(patch => patch.requestState), ['sending', 'sent', 'received']);
    assert.equal(checkpoints.at(-1).rawResponse, response);
    await ctx.close();
  } finally { await browser.close(); }
});
test('browser worker refuses partial output while streaming even if a copy button exists', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext(); let received = false;
    await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
      <textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="send()">Send</button>
      <script>function send(){const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.textContent=document.querySelector('textarea').value;document.body.append(u);const a=document.createElement('article');a.innerHTML='<div data-message-author-role="assistant">Partial response</div><button aria-label="Copy response">Copy</button><button data-testid="stop-button">Stop</button>';document.body.append(a);}</script>
      </body></html>` }));
    await assert.rejects(requestChatgptScript({ projectUrl, prompt: 'Retrieve afternoon script', contextFactory: async () => ctx, timeoutMs: 6500, checkpoint: patch => { if (patch.requestState === 'received') received = true; } }), /Timed out/);
    assert.equal(received, false); await ctx.close();
  } finally { await browser.close(); }
});
test('browser worker refuses a redirect to another Project before sending a prompt', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext(); let submitted = false;
    await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<textarea id="prompt-textarea"></textarea><script>history.replaceState(null,"","/g/g-p-other/project");</script>' }));
    await assert.rejects(requestChatgptScript({ projectUrl, prompt: 'Retrieve morning script', contextFactory: async () => ctx,
      checkpoint: () => { submitted = true; } }), /did not open the configured Project/);
    assert.equal(submitted, false); await ctx.close();
  } finally { await browser.close(); }
});
test('browser worker refuses to substitute another chat in the same Project', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext(); let submitted = false;
    await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<textarea id="prompt-textarea"></textarea><script>history.replaceState(null,"","/g/g-p-fixture/c/wrong-conversation");</script>' }));
    await assert.rejects(requestChatgptScript({ projectUrl: 'https://chatgpt.com/g/g-p-fixture/c/approved-planning-conversation', prompt: 'Retrieve morning script', contextFactory: async () => ctx,
      checkpoint: () => { submitted = true; } }), /configured planning conversation/);
    assert.equal(submitted, false); await ctx.close();
  } finally { await browser.close(); }
});


test('planning conversation survives a canonical Project slug change while retaining exact chat identity', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext();
    const id = '0123456789abcdef0123456789abcdef';
    await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="send()">Send</button><script>history.replaceState(null,"","/g/g-p-' + id + '-renamed/c/approved-plan");function send(){const u=document.createElement("div");u.dataset.messageAuthorRole="user";u.textContent=document.querySelector("textarea").value;document.body.append(u);const a=document.createElement("article");a.innerHTML=\'<div data-message-author-role="assistant">Approved exact script</div><button aria-label="Copy response">Copy</button>\';document.body.append(a);}</script>' }));
    const result = await requestChatgptScript({ projectUrl: 'https://chatgpt.com/g/g-p-' + id + '/c/approved-plan', prompt: 'Retrieve approved script', contextFactory: async () => ctx, timeoutMs: 15000 });
    assert.equal(result, 'Approved exact script'); await ctx.close();
  } finally { await browser.close(); }
});


test('planning-chat retrieval follows the new user message even when old history is virtualized away', async () => {
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const ctx=await browser.newContext();
    await ctx.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<article class="old"><div data-message-author-role="assistant">Old response 1</div></article><article class="old"><div data-message-author-role="assistant">Old response 2</div></article><textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="send()">Send</button><script>function send(){document.querySelectorAll(".old").forEach(e=>e.remove());const u=document.createElement("div");u.dataset.messageAuthorRole="user";u.textContent=document.querySelector("textarea").value;document.body.append(u);const a=document.createElement("article");a.innerHTML=\'<div data-message-author-role="assistant">Fresh approved response</div><button aria-label="Copy response">Copy</button>\';document.body.append(a);}</script>'}));
    const result=await requestChatgptScript({projectUrl:'https://chatgpt.com/g/g-p-fixture/c/planning',prompt:'Retrieve the approved morning script',contextFactory:async()=>ctx,timeoutMs:15000});
    assert.equal(result,'Fresh approved response');await ctx.close();
  }finally{await browser.close();}
});


test('human verification before sending pauses for manual completion and never clicks the checkbox', async () => {
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const ctx=await browser.newContext();const checkpoints=[];
    await ctx.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<div id="challenge"><h1>Verify you are human</h1><button id="captcha" onclick="window.checkboxClicked=true">I am not a robot</button></div><div id="normal" hidden><textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="send()">Send</button></div><script>window.sent=0;function send(){window.sent++;const u=document.createElement("div");u.dataset.messageAuthorRole="user";u.textContent=document.querySelector("textarea").value;document.body.append(u);const a=document.createElement("article");a.innerHTML=\'<div data-message-author-role="assistant">Approved response after manual completion</div><button aria-label="Copy response">Copy</button>\';document.body.append(a);}</script>'}));
    const answer=await requestChatgptScript({projectUrl,prompt:'Retrieve approved script',contextFactory:async()=>ctx,timeoutMs:15000,verificationTimeoutMs:5000,
      checkpoint:patch=>{checkpoints.push(patch);if(patch.humanVerificationRequired){
        // Simulate a human finishing a fake fixture; no real challenge or service is used.
        setTimeout(()=>ctx.pages()[0].evaluate(()=>{document.querySelector('#challenge').remove();document.querySelector('#normal').hidden=false;}),150);
      }}});
    assert.equal(answer,'Approved response after manual completion');
    assert.equal(await ctx.pages()[0].evaluate(()=>Boolean(window.checkboxClicked)),false);
    assert.equal(await ctx.pages()[0].evaluate(()=>window.sent),1);
    assert.deepEqual(checkpoints.filter(p=>typeof p.humanVerificationRequired==='boolean').map(p=>p.humanVerificationRequired),[true,false]);
    assert.equal(checkpoints.find(p=>p.humanVerificationRequired).verificationPhase,'before_send');await ctx.close();
  }finally{await browser.close();}
});

test('human verification after sending resumes the same reply without sending the prompt twice', async () => {
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const ctx=await browser.newContext();const checkpoints=[];
    await ctx.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<div id="normal"><textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="send()">Send</button></div><div id="challenge" hidden><h1>Verify you are human</h1><button onclick="window.checkboxClicked=true">I am not a robot</button></div><script>window.sent=0;function send(){window.sent++;const u=document.createElement("div");u.dataset.messageAuthorRole="user";u.textContent=document.querySelector("textarea").value;document.body.append(u);document.querySelector("#normal").hidden=true;document.querySelector("#challenge").hidden=false;}</script>'}));
    const answer=await requestChatgptScript({projectUrl,prompt:'Retrieve approved script',contextFactory:async()=>ctx,timeoutMs:15000,verificationTimeoutMs:5000,
      checkpoint:patch=>{checkpoints.push(patch);if(patch.humanVerificationRequired)setTimeout(()=>ctx.pages()[0].evaluate(()=>{document.querySelector('#challenge').remove();document.querySelector('#normal').hidden=false;const a=document.createElement('article');a.innerHTML='<div data-message-author-role="assistant">The original completed reply</div><button aria-label="Copy response">Copy</button>';document.body.append(a);}),150);}});
    assert.equal(answer,'The original completed reply');assert.equal(await ctx.pages()[0].evaluate(()=>window.sent),1);
    assert.equal(await ctx.pages()[0].evaluate(()=>Boolean(window.checkboxClicked)),false);
    assert.deepEqual(checkpoints.map(p=>p.requestState).filter(Boolean),['sending','sent','received']);
    assert.equal(checkpoints.find(p=>p.humanVerificationRequired).verificationPhase,'waiting_reply');await ctx.close();
  }finally{await browser.close();}
});

test('unfinished human verification stops with an actionable error and no prompt submission', async () => {
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const ctx=await browser.newContext();const checkpoints=[];
    await ctx.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<h1>Verify you are human</h1><button onclick="window.checkboxClicked=true">I am not a robot</button>'}));
    await assert.rejects(requestChatgptScript({projectUrl,prompt:'Retrieve approved script',contextFactory:async()=>ctx,timeoutMs:1000,verificationTimeoutMs:300,checkpoint:patch=>checkpoints.push(patch)}),{code:'CHATGPT_HUMAN_VERIFICATION_REQUIRED'});
    assert.equal(checkpoints.some(p=>p.requestState==='sending'),false);
    assert.equal(await ctx.pages()[0].evaluate(()=>Boolean(window.checkboxClicked)),false);await ctx.close();
  }finally{await browser.close();}
});

// Local fixture only: login and extraction retain the same DOM and conversation.
test('login leaves its context open and retrieval reuses the already open page', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext(); let navigations = 0;
    await ctx.route('**/*', route => {
      navigations++;
      return route.fulfill({ contentType: 'text/html', body: `<textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="send()">Send</button><script>
      function send(){const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.textContent=document.querySelector('textarea').value;document.body.append(u);const a=document.createElement('div');a.dataset.talvtTurnState='complete';a.innerHTML='<div data-markdown-text-style="assistant-message">Approved fixture script</div>';document.body.append(a);}
      </script>` });
    });
    const result = await openChatgptLogin(projectUrl, { contextFactory: async () => ctx });
    assert.match(result.message, /Leave this Chrome window open/);
    await openChatgptLogin(projectUrl, { contextFactory: async () => ctx });
    assert.equal(navigations, 1);
    const response = await requestChatgptScript({ projectUrl, prompt: 'Get approved fixture', contextFactory: async () => ctx, timeoutMs: 10000 });
    assert.equal(response, 'Approved fixture script'); assert.equal(navigations, 1);
    assert.equal(ctx.pages()[0].isClosed(), false); await ctx.close();
  } finally { await browser.close(); }
});
