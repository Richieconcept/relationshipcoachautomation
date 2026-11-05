import {randomUUID} from 'node:crypto';
import {SLOTS,slotInfo,validateDate,parseScriptResponse,nextDate} from './content-plan.service.js';
import {scriptApprovalHash} from './script-approval.service.js';
import {generatePlannerJson,geminiConfiguration} from './gemini-planner.service.js';
import {buildPlannerSystem} from './planner-prompt.service.js';

const requestLimit=()=>Math.max(1,Math.min(100,Number(process.env.PLANNER_DAILY_REQUEST_LIMIT)||15));
const normalize=text=>String(text||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const string=(value,max,name)=>{if(typeof value!=='string'||value.length>max)throw new Error(name+' must be text within '+max+' characters.');return value.trim();};
const pacificDay=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export class ContentPlanner{
 constructor(scheduler,{generate=generatePlannerJson,now=Date.now,configured=async()=>Boolean((await geminiConfiguration()).apiKey)}={}){
  this.scheduler=scheduler;this.store=scheduler.store;this.generate=generate;this.now=now;this.configured=configured;this.active=null;this.task=Promise.resolve();
  this.store.state.drafts??={};this.store.state.plannerRuns??={};this.store.state.plannerUsage??={};
 }
 commit(patch){const previous=this.store.state;this.store.state={...previous,...patch};try{this.store.save();}catch(error){this.store.state=previous;throw error;}}
 setRun(id,patch){const run={...this.store.state.plannerRuns[id],...patch,updatedAt:new Date(this.now()).toISOString()};this.commit({plannerRuns:{...this.store.state.plannerRuns,[id]:run}});return run;}
 locked(id){const item=this.store.state.items[id];return this.scheduler.running.has(id)||item?.jobId||this.scheduler.findJob(id);}
 snapshot(){return{drafts:Object.values(this.store.state.drafts),runs:Object.values(this.store.state.plannerRuns).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20),usage:{day:pacificDay(this.now()),requests:this.store.state.plannerUsage[pacificDay(this.now())]||0,applicationDailyLimit:requestLimit()},activeRunId:this.active,profile:this.store.state.settings.plannerProfile||''};}
 saveDraft(input){
  const info=slotInfo(input.date,input.slot,this.store.state.settings.slots||SLOTS),old=this.store.state.drafts[info.id],item=this.store.state.items[info.id];
  if(this.locked(info.id))throw new Error('Production has already started for this slot. Its script is locked.');
  if(old&&input.expectedRevision!==old.revision)throw new Error('This draft changed in another window. Reload before saving.');
  if(!old&&input.expectedRevision!==undefined&&input.expectedRevision!==0)throw new Error('This draft no longer exists. Reload before saving.');
  const title=string(input.title||'',100,'Title'),script=string(input.script||'',6000,'Script');
  const draft={...old,...info,publishAt:item?.publishAt||old?.publishAt||info.publishAt,title,script,topic:string(input.topic??old?.topic??'',300,'Topic'),angle:string(input.angle??old?.angle??'',600,'Angle'),basis:input.basis||old?.basis||'owner_notes',revision:(old?.revision||0)+1,status:'draft',updatedAt:new Date(this.now()).toISOString(),createdAt:old?.createdAt||new Date(this.now()).toISOString(),history:[...(old?.history||[]),...(old?[{revision:old.revision,title:old.title,script:old.script,status:old.status,at:old.updatedAt}]:[])].slice(-20)};
  const items={...this.store.state.items};
  if(item?.plannerManaged||item?.approval?.status==='owner_approved_script')items[info.id]={...item,plannerManaged:true,status:'awaiting_approval',script:null,approval:{...item.approval,status:'withdrawn'},productionMode:'preview',error:null};
  this.commit({drafts:{...this.store.state.drafts,[info.id]:draft},items});return draft;
 }
 reschedule(id,input){
  const old=this.store.state.drafts[id];if(!old)throw new Error('Draft not found.');
  if(old.revision!==input.expectedRevision)throw new Error('This draft changed. Reload before rescheduling.');
  if(this.locked(id))throw new Error('Production has already started. This script is locked.');
  const info=slotInfo(input.date,input.slot,this.store.state.settings.slots||SLOTS);if(info.id===id)throw new Error('Choose a different date or slot.');
  if(this.store.state.drafts[info.id]||this.store.state.items[info.id]||this.locked(info.id))throw new Error('The destination slot already has content. Choose an empty slot.');
  const now=new Date(this.now()).toISOString(),draft={...old,...info,revision:1,status:'draft',createdAt:now,updatedAt:now,rescheduledFrom:id,history:[]};
  const items={...this.store.state.items};if(items[id])items[id]={...items[id],status:'awaiting_approval',script:null,productionMode:'preview',approval:{...items[id].approval,status:'withdrawn'}};
  this.commit({items,drafts:{...this.store.state.drafts,[id]:{...old,status:'rescheduled',rescheduledTo:info.id,updatedAt:now},[info.id]:draft}});return draft;
 }
 approve({records,createNow=false}){
  if(!Array.isArray(records)||!records.length||records.length>28||new Set(records.map(r=>r.id)).size!==records.length)throw new Error('Choose 1 to 28 different scripts to approve.');
  const now=this.now(),validated=records.map(record=>{
   const draft=this.store.state.drafts[record.id];if(!draft||draft.status==='rescheduled')throw new Error('A selected draft is unavailable.');
   if(draft.revision!==record.revision)throw new Error('A selected script has changed. Reload and read the latest revision before approving.');
   const existing=this.store.state.items[draft.id];
   const active=this.active&&this.store.state.plannerRuns[this.active];if(active?.targets.some(target=>target.id===draft.id)&&!active.completed.includes(draft.id)&&!active.skipped.includes(draft.id))throw new Error('This script is still being generated. Wait for it to finish before approving.');
   if(draft.status==='approved'&&existing?.approval?.draftRevision===draft.revision&&existing.approval.contentHash===scriptApprovalHash(existing))return{draft,existing,reused:true};
   if(this.locked(draft.id))throw new Error('Production has already started for '+draft.id+'.');
   if(!createNow&&Date.parse(draft.publishAt)<=now)throw new Error(draft.id+' has passed its posting time. Reschedule it, or explicitly choose Approve & create now.');
   const parsed=parseScriptResponse(JSON.stringify(draft),draft);if(/(?:^|\n)\s*(?:scene\s*\d+|stage directions?|voiceover|hook|caption|hashtags)\s*:/i.test(parsed.script))throw new Error('Remove headings and stage directions from '+draft.id+' before approving.');
   return{draft,existing,parsed};
  });
  const items={...this.store.state.items},drafts={...this.store.state.drafts};
  for(const {draft,existing,parsed,reused} of validated){if(reused)continue;const item={...existing,id:draft.id,date:draft.date,slot:draft.slot,publishAt:draft.publishAt,...parsed,plannerManaged:true,status:'script_ready',productionMode:'automatic',error:null,createdAt:existing?.createdAt||new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};item.approval={status:'owner_approved_script',draftRevision:draft.revision,approvedAt:new Date(now).toISOString(),contentHash:scriptApprovalHash(item)};items[item.id]=item;drafts[item.id]={...draft,status:'approved',approvedAt:new Date(now).toISOString()};}
  this.commit({items,drafts,settings:{...this.store.state.settings,scriptSource:'manual',enabled:createNow?this.store.state.settings.enabled:true}});
  if(createNow)for(const {draft,reused} of validated)if(!reused)this.scheduler.startVideo(draft.date,draft.slot);
  return validated.map(row=>({id:row.draft.id,reused:Boolean(row.reused)}));
 }
 assertRequestAvailable(){if((this.store.state.plannerUsage[pacificDay(this.now())]||0)>=requestLimit())throw Object.assign(new Error('Regeneration is paused: the daily application request budget is used up ('+requestLimit()+'/'+requestLimit()+'). Your script is unchanged. Resume after the Pacific-day quota reset.'),{code:'GEMINI_QUOTA_EXHAUSTED'});}
 async start({startDate,days=7,notes='',regenerateIds,expectedRevisions={},feedback=''}){
  validateDate(startDate);if(![1,7].includes(days))throw new Error('Choose one day or one week.');
  notes=string(notes,8000,'Planning notes');feedback=string(feedback,2000,'Feedback');
  if(this.active)return{run:this.store.state.plannerRuns[this.active],reused:true};
  if(!await this.configured())throw new Error('Add GEMINI_API_KEY to .env before generating drafts.');
  // Recheck after asynchronous configuration: only one planning operation owns this lane.
  if(this.active)return{run:this.store.state.plannerRuns[this.active],reused:true};
  this.assertRequestAvailable();
  const targets=[];let date=startDate;
  for(let day=0;day<days;day++,date=nextDate(date))for(const slot of Object.keys(this.store.state.settings.slots||SLOTS)){
   const info=slotInfo(date,slot,this.store.state.settings.slots||SLOTS),draft=this.store.state.drafts[info.id];
   if(regenerateIds?!regenerateIds.includes(info.id):Boolean(draft?.script||this.store.state.items[info.id]?.script))continue;
   if(this.locked(info.id))continue;
   if(regenerateIds&&draft?.revision!==expectedRevisions[info.id])throw new Error('Reload the latest script before regenerating.');
   targets.push({...info,expectedRevision:draft?.revision||0});
  }
  if(regenerateIds&&(!Array.isArray(regenerateIds)||regenerateIds.length!==targets.length))throw new Error('Selected regeneration slots are invalid or locked.');
  if(!targets.length)throw new Error('These slots already have scripts. Regenerate a selected draft or choose another week.');
  if(regenerateIds){const drafts={...this.store.state.drafts},items={...this.store.state.items};for(const target of targets){if(drafts[target.id])drafts[target.id]={...drafts[target.id],status:'draft'};if(items[target.id])items[target.id]={...items[target.id],script:null,status:'awaiting_approval',productionMode:'preview',approval:{...items[target.id].approval,status:'withdrawn'}};}this.commit({drafts,items});}
  const id='plan_'+randomUUID(),run={id,startDate,days,notes,feedback,targets,completed:[],skipped:[],status:'generating',topics:regenerateIds?targets.map(target=>{const draft=this.store.state.drafts[target.id];return{date:target.date,slot:target.slot,title:draft.title,topic:draft.topic||draft.title,angle:draft.angle||'Rewrite the same relationship situation using the saved master writing guide.'};}):null,requests:0,tokens:0,createdAt:new Date(this.now()).toISOString(),updatedAt:new Date(this.now()).toISOString(),message:'Planning topics. Drafts will require your approval.'};
  this.commit({plannerRuns:{...this.store.state.plannerRuns,[id]:run}});this.launch(id);return{run,reused:false};
 }
 resume(id){const run=this.store.state.plannerRuns[id];if(!run)throw new Error('Planning run not found.');if(this.active)return this.store.state.plannerRuns[this.active];if(run.status==='completed')return run;this.assertRequestAvailable();this.setRun(id,{status:'generating',error:null,message:'Resuming remaining slots; completed drafts are kept.'});this.launch(id);return this.store.state.plannerRuns[id];}
 launch(id){this.active=id;this.task=this.execute(id).catch(error=>{this.setRun(id,{status:error.code==='GEMINI_QUOTA_EXHAUSTED'?'paused_quota':'interrupted',error:error.message,message:error.message});}).finally(()=>{this.active=null;});}
 async call(id,args){
  const day=pacificDay(this.now()),requests=this.store.state.plannerUsage[day]||0;if(requests>=requestLimit())throw Object.assign(new Error('The application daily limit of '+requestLimit()+' Gemini requests is reached. Completed drafts are saved; resume after the Pacific-day reset.'),{code:'GEMINI_QUOTA_EXHAUSTED'});
  this.commit({plannerUsage:{...this.store.state.plannerUsage,[day]:requests+1}});this.setRun(id,{requests:this.store.state.plannerRuns[id].requests+1});
  const response=await this.generate(args);this.setRun(id,{tokens:this.store.state.plannerRuns[id].tokens+(Number(response.usage?.totalTokenCount)||0),model:response.model});return response.data;
 }
 validateRows(data,targets,script=false){
  if(!Array.isArray(data?.records)||data.records.length!==targets.length)throw new Error('Gemini returned the wrong number of slots. No approval or video generation occurred.');
  const seen=new Set();for(const row of data.records){const id=row.date+'-'+row.slot;if(seen.has(id)||!targets.some(t=>t.id===id))throw new Error('Gemini returned a duplicate or different date/slot.');seen.add(id);string(row.title,100,'Title');if(!row.title.trim())throw new Error('Gemini returned an empty title.');if(script){string(row.script,6000,'Script');if(row.script.trim().length<10)throw new Error('Gemini returned an incomplete script.');}else{string(row.topic,300,'Topic');string(row.angle,600,'Angle');}}
  return data.records;
 }
 async execute(id){
  let run=this.store.state.plannerRuns[id];
  const system=await buildPlannerSystem(this.store.state.settings.plannerProfile||'');
  const baseSchema=script=>({type:'object',properties:{records:{type:'array',items:{type:'object',properties:{date:{type:'string'},slot:{type:'string',enum:Object.keys(SLOTS)},title:{type:'string'},...(script?{script:{type:'string'}}:{topic:{type:'string'},angle:{type:'string'}})},required:script?['date','slot','title','script']:['date','slot','title','topic','angle']}}},required:['records']});
  if(!run.topics){
   const history=[...Object.values(this.store.state.items),...Object.values(this.store.state.drafts)].filter(row=>row.title).slice(-200).map(row=>({title:row.title,topic:row.topic,hook:row.script?.slice(0,180)}));
   const result=await this.call(id,{system,prompt:JSON.stringify({task:'Propose varied topics for these exact slots. Mix relatable problems, practical communication, scenarios and reflection; do not copy or repeat history.',slots:run.targets.map(({date,slot})=>({date,slot})),ownerNotes:run.notes,feedback:run.feedback,avoidRepeating:history}),schema:baseSchema(false)});
   const topics=this.validateRows(result,run.targets);if(new Set(topics.map(row=>normalize(row.topic))).size!==topics.length)throw new Error('Gemini repeated a topic. Resume to request a varied plan.');this.setRun(id,{topics});
  }
  run=this.store.state.plannerRuns[id];
  for(const date of [...new Set(run.targets.map(target=>target.date))]){
   run=this.store.state.plannerRuns[id];const targets=run.targets.filter(target=>target.date===date&&!run.completed.includes(target.id)&&!run.skipped.includes(target.id));if(!targets.length)continue;
   // A local edit or started video wins over an outstanding AI response.
   const pending=targets.filter(target=>{const draft=this.store.state.drafts[target.id];return !this.locked(target.id)&&(draft?.revision||0)===target.expectedRevision;});
   const skipped=targets.filter(target=>!pending.includes(target)).map(target=>target.id);if(skipped.length)this.setRun(id,{skipped:[...this.store.state.plannerRuns[id].skipped,...skipped]});if(!pending.length)continue;
   this.setRun(id,{message:'Writing '+date+' ('+pending.length+' scripts). Completed drafts are ready to read.'});
   const topics=run.topics.filter(topic=>pending.some(target=>target.id===topic.date+'-'+topic.slot));
   const result=await this.call(id,{system,prompt:JSON.stringify({task:'Write one complete original spoken script per supplied topic. Keep the exact dates and slots. No approval actions. Do not repeat other scripts.',topics,ownerNotes:run.notes,feedback:run.feedback,otherScripts:Object.values(this.store.state.drafts).filter(d=>d.script).slice(-40).map(d=>({title:d.title,hook:d.script.slice(0,180)}))}),schema:baseSchema(true)});
   const rows=this.validateRows(result,pending,true);if(new Set(rows.map(row=>normalize(row.script))).size!==rows.length)throw new Error('Gemini repeated a script. Resume to request different scripts.');
   for(const row of rows){const target=pending.find(t=>t.id===row.date+'-'+row.slot),current=this.store.state.drafts[target.id];if(this.locked(target.id)||(current?.revision||0)!==target.expectedRevision){this.setRun(id,{skipped:[...this.store.state.plannerRuns[id].skipped,target.id]});continue;}
    const topic=topics.find(t=>t.date===row.date&&t.slot===row.slot);this.saveDraft({...row,topic:topic.topic,angle:topic.angle,basis:run.notes?'owner_notes':'evergreen',expectedRevision:target.expectedRevision});this.setRun(id,{completed:[...this.store.state.plannerRuns[id].completed,target.id]});
   }
  }
  this.setRun(id,{status:'completed',message:'Planning finished. Read and approve scripts before production. Edited or locked slots were preserved.'});
 }
}
