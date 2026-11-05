import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { getBrowserContext, getFlowPageForAccount, closeFlowTab, closeBrowser } from '../src/browser.js';

test('completed generation closes its tab, preserves other tabs, and can open a new Flow tab',async()=>{
 const dir=await fs.mkdtemp(fileURLToPath(new URL('../tmp/tab-cleanup-',import.meta.url)));
 const previous={headless:config.headless,browserProfilesDir:config.browserProfilesDir,browserDownloadTempDir:config.browserDownloadTempDir};
 Object.assign(config,{headless:true,browserProfilesDir:dir,browserDownloadTempDir:dir});
 try{
 const context=await getBrowserContext('cleanup-test');const page=await getFlowPageForAccount('cleanup-test');
 await page.route('https://flow.google.com/**',route=>route.fulfill({contentType:'text/html',body:'Flow fixture'}));
 await page.goto('https://flow.google.com/project/test');
 const other=await context.newPage();await other.goto('data:text/html,Keep this tab');
 assert.equal(await getFlowPageForAccount('cleanup-test'),page);
 await closeFlowTab();assert.equal(page.isClosed(),true);assert.equal(other.isClosed(),false);
 await closeFlowTab();assert.equal(other.isClosed(),false);
 const next=await getFlowPageForAccount('cleanup-test');assert.notEqual(next,other);assert.equal(next.isClosed(),false);
 await closeFlowTab();assert.equal(next.isClosed(),true);assert.equal(other.isClosed(),false);
 }finally{await closeBrowser();Object.assign(config,previous);await fs.rm(dir,{recursive:true,force:true});}
});
