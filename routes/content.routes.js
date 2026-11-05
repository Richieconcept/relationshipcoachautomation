import { config } from '../src/config.js';
import { importApprovedPlan } from '../services/approved-plan.service.js';
import express from 'express';
import {ContentPlanner} from '../services/content-planner.service.js';
import {geminiConfiguration,checkGemini} from '../services/gemini-planner.service.js';
import {publishingConnection,configureAutomaticPublishing} from '../services/publishing-connection.service.js';
import { ContentScheduler } from '../services/content-scheduler.service.js';
import { openChatgptLogin } from '../services/chatgpt-browser.service.js';
import { parseScriptResponse } from '../services/content-plan.service.js';

export function contentRoutes(scheduler = new ContentScheduler(), planner = new ContentPlanner(scheduler)) {
  const router = express.Router();
  // Browser profiles and automation controls belong to the local operator.
  router.use((req, res, next) => {
    const ip = req.socket.remoteAddress;
    if (!config.allowRemoteControls && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ success: false, message: 'Content automation controls are available on this computer only.' });
    if (req.get('origin') && req.get('origin') !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ success: false, message: 'Cross-origin automation requests are blocked.' });
    next();
  });
  const action = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) { res.status(400).json({ success: false, message: error.message }); }
  };
  router.get('/', action(async (req, res) => res.json({ success: true, ...scheduler.snapshot() })));
  router.get('/planner',action(async(req,res)=>{const gemini=await geminiConfiguration();res.json({success:true,...planner.snapshot(),slots:scheduler.store.state.settings.slots,timezone:'Africa/Lagos',gemini:{configured:Boolean(gemini.apiKey),model:gemini.model}});}));
  router.post('/planner/check',action(async(req,res)=>res.json({success:true,...await checkGemini()})));
  router.post('/planner/generate',action(async(req,res)=>res.status(202).json({success:true,...await planner.start(req.body)})));
  router.post('/planner/runs/:id/resume',action(async(req,res)=>res.status(202).json({success:true,run:planner.resume(req.params.id)})));
  router.put('/planner/drafts',action(async(req,res)=>res.json({success:true,draft:planner.saveDraft(req.body)})));
  router.post('/planner/reschedule',action(async(req,res)=>res.json({success:true,draft:planner.reschedule(req.body.id,req.body)})));
  router.post('/planner/approve',action(async(req,res)=>res.json({success:true,approved:planner.approve({...req.body,createNow:req.body.createNow===true})})));
  router.get('/publishing',action(async(req,res)=>res.json({success:true,...await publishingConnection(scheduler.store.state.settings)})));
  router.put('/publishing',action(async(req,res)=>res.json({success:true,settings:await configureAutomaticPublishing(scheduler.store,req.body)})));
  router.put('/settings', action(async (req, res) => {
    // Turning posting on always verifies destinations; ordinary schedule saves preserve it.
    if(req.body.slots&&planner.active)throw new Error('Wait for the current planning run to finish before changing posting times.');
    if(req.body.autoPublish===true)throw new Error('Use Automatic posting to verify and enable Buffer destinations.');
    if(req.body.bufferChannelIds!==undefined)throw new Error('Choose destinations in Automatic posting.');
    res.json({success:true,settings:scheduler.store.settings(req.body)});
  }));
  router.post('/login', action(async (req, res) => {
    if (scheduler.running.size) throw new Error('Wait for queued content preparation to finish before opening Login.');
    res.json({ success: true, ...await openChatgptLogin(scheduler.store.state.settings.planningConversationUrl || scheduler.store.state.settings.projectUrl) });
  }));
  router.post('/scripts', action(async (req, res) => {
    const records = req.body.records;
    if (!Array.isArray(records)) throw new Error('Provide dated spoken scripts.');
    const items = importApprovedPlan(scheduler, { records: records.map(record => ({ ...record,
      title: record?.title?.trim() || (typeof record?.script === 'string' ? record.script.trim().split(/\n/)[0].slice(0, 100) : '') })) });
    res.json({ success: true, imported: items.length, ids: items.map(item => item.id) });
  }));
  router.post('/start-saved', action(async (req, res) => {
    const ids = req.body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 28 || new Set(ids).size !== ids.length) throw new Error('Select 1 to 28 saved scripts.');
    const items = ids.map(id => Object.hasOwn(scheduler.store.state.items, id) ? scheduler.store.state.items[id] : null);
    if (items.some(item => !item?.script)) throw new Error('Every selected slot must have a saved spoken script.');
    if (scheduler.store.state.settings.scriptSource !== 'manual') throw new Error('Select manual scripts before starting saved content.');
    const runs = items.map(item => scheduler.startVideo(item.date, item.slot));
    res.status(202).json({ success: true, ids: runs.map(run => run.item.id) });
  }));
  router.post('/import-approved', action(async (req, res) => {
    const items = importApprovedPlan(scheduler, req.body);
    res.json({ success: true, imported: items.length, ids: items.map(item => item.id) });
  }));
  router.post('/start-video', action(async (req, res) => {
    const { item, reused } = scheduler.startVideo(req.body.date, req.body.slot);
    res.status(reused ? 200 : 202).json({ success: true, itemId: item.id, jobId: item.jobId || null, reused, mode: scheduler.store.state.settings.autoPublish ? 'generate_and_publish' : 'generate_only' });
  }));
  router.get('/items/:id', action(async (req, res) => {
    if (!Object.hasOwn(scheduler.store.state.items, req.params.id)) return res.status(404).json({ success: false, message: 'Content slot not found.' });
    const item = scheduler.snapshot().items.find(item => item.id === req.params.id);
    res.json({ success: true, item });
  }));
  router.post('/prepare', action(async (req, res) => {
    const items = scheduler.prepare(req.body.date, req.body.slots, { retry: req.body.retry === true, scriptOnly: req.body.scriptOnly === true });
    res.status(202).json({ success: true, ids: items.map(item => item.id) });
  }));
  router.post('/items/:id/retry', action(async (req, res) => {
    const item = Object.hasOwn(scheduler.store.state.items, req.params.id) ? scheduler.store.state.items[req.params.id] : null;
    if (!item) throw new Error('Content slot not found.');
    if (scheduler.running.has(item.id) || item.jobId || scheduler.findJob(item.id)) throw new Error('This slot already has a queued request or video job. Resume the existing job instead.');
    if (req.body.rerequest === true) scheduler.store.update(item.id, { rawResponse: null, script: null });
    scheduler.prepare(item.date, [item.slot], { retry: true, scriptOnly: req.body.scriptOnly === true });
    res.status(202).json({ success: true });
  }));
  router.put('/items/:id/script', action(async (req, res) => {
    const item = Object.hasOwn(scheduler.store.state.items, req.params.id) ? scheduler.store.state.items[req.params.id] : null;
    if (!item) throw new Error('Content slot not found.');
    if (scheduler.running.has(item.id) || item.jobId || scheduler.findJob(item.id)) throw new Error('Cannot change a script after video production has started.');
    const parsed = parseScriptResponse(JSON.stringify({ ...req.body, date: item.date, slot: item.slot }), item);
    const draft=planner.saveDraft({...parsed,date:item.date,slot:item.slot,expectedRevision:req.body.expectedRevision});
    res.json({success:true,draft,message:'Saved as a draft. Approve the new revision before production.'});
  }));
  return { router, scheduler, planner };
}
