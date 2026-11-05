import { buildPostMetadata } from './post-metadata.js';
const $ = selector => document.querySelector(selector);
const SLOTS = { morning: 'Morning', afternoon: 'Noon', late_afternoon:'Late afternoon', evening: 'Evening' };
let TIMES = { morning: '6:00 AM', afternoon: '12:00 PM', late_afternoon:'4:00 PM', evening: '8:00 PM' };
let state; let weekStart; let dirty = false; let busy = false; let libraryFilter = 'all';
const today = () => new Date(Date.now() + 3600000).toISOString().slice(0, 10);
const dayAfter = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const DRAFT_KEY = 'flow-weekly-script-draft';
const formatTime = value => new Intl.DateTimeFormat('en', { timeZone:'Africa/Lagos',month:'short',day:'numeric',hour:'numeric',minute:'2-digit' }).format(new Date(value));
const labels = { skipped:'Slot skipped',policy_blocked:'Script needs revision', retry_wait:'Retry scheduled',awaiting_approval:'Awaiting approval',script_ready:'Approved / scheduled',creating_job:'Preparing',queued:'Queued',producing:'In production',ready:'Ready to review',needs_review:'Needs attention',planned:'Add a script',content_not_planned:'Add a script',published:'Sent to Buffer',publishing_failed:'Needs attention',missed:'Missed slot' };
function node(tag,text,className){const el=document.createElement(tag);if(text)el.textContent=text;if(className)el.className=className;return el;}
async function api(url,method='GET',body){const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok||!data.success)throw new Error(data.message||'Request failed.');return data;}
function message(text,error=false){$('#message').textContent=text;$('#message').dataset.error=String(error);}
async function action(work){try{await work();}catch(error){message(error.message,true);}}
function isLocked(item){return item&&(item.plannerManaged||item.jobId||['queued','fetching_script','awaiting_verification','creating_job','producing','publishing','ready','published','publishing_failed','missed'].includes(item.status));}
function cards(){return [...document.querySelectorAll('.week-slot')];}
function drafts(){return cards().filter(card=>!card.dataset.locked).map(card=>({date:card.dataset.date,slot:card.dataset.slot,title:card.querySelector('input').value,script:card.querySelector('textarea').value}));}
function stash(){try{localStorage.setItem(DRAFT_KEY,JSON.stringify({start:weekStart,records:drafts()}));}catch{}}
function wordCount(script){return script.trim()?script.trim().split(/\s+/).length:0;}
function renderWeek(records){
 const grid=$('#week-grid');const openDays=new Set([...grid.querySelectorAll('.week-day[open]')].map(el=>el.dataset.date));const openSlots=new Set([...grid.querySelectorAll('.week-slot[open]')].map(el=>el.dataset.date+'-'+el.dataset.slot));const hadDays=grid.childElementCount>0;const changedWeek=grid.firstElementChild?.dataset.date!==weekStart;grid.replaceChildren();
 for(let d=0;d<7;d++){
  const date=dayAfter(weekStart,d);const day=node('details','','week-day');day.dataset.date=date;day.open=changedWeek?d===0:openDays.has(date)||(!hadDays&&d===0);
  const dateObj=new Date(date+'T12:00:00Z');const summary=node('summary','','day-summary');const label=node('span',new Intl.DateTimeFormat('en',{weekday:'long',timeZone:'Africa/Lagos'}).format(dateObj),'day-label');label.append(node('small',new Intl.DateTimeFormat('en',{month:'short',day:'numeric',timeZone:'Africa/Lagos'}).format(dateObj)));const count=node('span','','day-count');summary.append(node('span',date.slice(-2),'day-number'),label,count);day.append(summary);
  const row=node('div','','week-day-slots');
  for(const [slot,label]of Object.entries(SLOTS)){
   const item=state.items.find(i=>i.id===date+'-'+slot);const draft=records?.find(r=>r.date===date&&r.slot===slot);const card=node('details','','week-slot');card.dataset.date=date;card.dataset.slot=slot;card.open=openSlots.has(date+'-'+slot);const locked=Boolean(isLocked(item));if(locked)card.dataset.locked='true';
   const slotSummary=node('summary','','slot-summary');const summaryMain=node('span','','slot-summary-main');const summaryTitle=node('span','','slot-title');const summaryCaption=node('span','','slot-caption');summaryMain.append(node('span',label+' / '+TIMES[slot],'slot-eyebrow'),summaryTitle,summaryCaption);slotSummary.append(summaryMain);card.append(slotSummary);
   const body=node('div','','slot-body');const titleLabel=node('label','Video title');const title=node('input');title.maxLength=100;title.placeholder='Optional title';title.value=draft?.title??item?.title??'';title.disabled=locked;titleLabel.append(title);const scriptLabel=node('label','Spoken script');const script=node('textarea');script.rows=7;script.maxLength=6000;script.value=draft?.script??item?.script??'';script.disabled=locked;script.placeholder='Paste the exact words your presenter should say...';scriptLabel.append(script);const words=node('span','','word-counter');
   const startTime=new Date(Date.parse(date+'T'+state.settings.slots[slot]+':00+01:00')-(state.settings.generationLeadMinutes??120)*60000);const meta=node('p','','script-meta');const metaDetails=node('details','','slot-meta');metaDetails.append(node('summary','Caption & hashtags'),meta);
   const preview=()=>{const result=buildPostMetadata(script.value);summaryTitle.textContent=title.value.trim()||(script.value.trim()?script.value.trim().split(/\s+/).slice(0,8).join(' '):'Add a spoken script');summaryCaption.textContent=locked?'Video linked - view production below':script.value.trim()?wordCount(script.value)+' words / click to edit':'Click to write or paste';words.textContent=wordCount(script.value)+' words';meta.textContent=result?result.caption+'\n\n'+result.hashtags.join(' '):'Your opening hook becomes the caption. Topic tags are added automatically.';};
   card.addEventListener('input',()=>{dirty=true;preview();count.textContent=[...row.querySelectorAll('textarea')].filter(el=>el.value.trim()).length+' / 4 scripts';stash();});preview();body.append(titleLabel,scriptLabel,words,node('p','Starts '+formatTime(startTime),'script-meta'),metaDetails);if(locked)body.append(node('p',item?.plannerManaged&&!item?.jobId?'Approved planner script. Edit it in Drafts & review; changes will require approval again.':'This script is linked to a video. Open its production row below to view or resume it.','helper-text'));card.append(body);row.append(card);
  }
  count.textContent=[...row.querySelectorAll('textarea')].filter(el=>el.value.trim()).length+' / 4 scripts';day.append(row);grid.append(day);
 }
}
function button(text,work){const el=node('button',text,'secondary-button');el.type='button';el.onclick=()=>action(async()=>{el.disabled=true;try{await work();await refresh();}finally{el.disabled=false;}});return el;}
function dateItems(){const start=weekStart||today();return state.items.filter(item=>item.status!=='awaiting_approval').filter(item=>$('#all-dates').checked||(item.date>=start&&item.date<=dayAfter(start,6)));}
function friendlyIssue(item){if(item.job?.failure)return item.job.failure.title+'. '+item.job.failure.nextAction;const raw=item.error||item.job?.message||'';if(item.job?.errorCode==='GENERATION_REJECTED')return 'The provider rejected this script. This video is held for revision; other scheduled videos can continue.';if(item.job?.errorCode==='SCENE_RESULT_MISSING')return 'The scene could not be relocated after repeated checks. Automatic recovery will submit a fresh replacement while keeping completed clips.';if(/More than one new|FLOW_RECOVERY_REQUIRED/i.test(raw))return 'Several results could not be identified. Resume this video to recheck them and automatically replace the scene if needed.';if(/BUFFER_|Buffer.*channel/i.test(raw))return 'Check the Buffer connection and destinations in Automatic posting. Your saved script and video are retained.';if(/ChatGPT|composer|CONTENT_NOT_PLANNED/i.test(raw))return item.script?'An earlier script lookup failed. Your saved script is available for a manual run.':'This slot needs a spoken script. Add it in the weekly planner to continue.';if(/EPERM|EACCES|rename/i.test(raw))return 'The run stopped while saving progress. Resume the existing video to recover saved scenes.';return item.error||(['failed','interrupted'].includes(item.job?.status)?item.job.message:'');}
function renderLibrary(){
 const all=dateItems();const summary=$('#planner-summary');summary.replaceChildren();for(const[label,count]of [['Scripts this week',all.filter(i=>i.script).length],['In production',all.filter(i=>['queued','creating_job','producing','retry_wait'].includes(i.status)).length],['Ready to review',all.filter(i=>i.status==='ready').length],['Need attention',all.filter(i=>['needs_review','content_not_planned','policy_blocked'].includes(i.status)).length]]){const metric=node('div','','metric-card');metric.append(node('strong',String(count)),node('span',label));summary.append(metric);}
 const root=$('#items');const opened=new Set([...root.querySelectorAll('details[open][data-disclosure]')].map(el=>el.dataset.disclosure));root.replaceChildren();const selected=all.filter(item=>libraryFilter==='all'||(libraryFilter==='ready'?item.status==='ready':libraryFilter==='attention'?['needs_review','content_not_planned','publishing_failed','skipped','policy_blocked'].includes(item.status):['queued','creating_job','producing','retry_wait'].includes(item.status)));
 if(!selected.length)root.append(node('p',libraryFilter==='all'?'Your saved videos will appear here. Add a script to your week to get started.':'No content matches this filter.','library-empty'));
 for(const item of selected){
  const card=node('details','','content-item');card.dataset.disclosure=item.id;card.open=opened.has(item.id);const header=node('summary','','content-row-summary');const date=node('span','','content-date');date.append(node('strong',new Intl.DateTimeFormat('en',{month:'short',day:'numeric',timeZone:'Africa/Lagos'}).format(new Date(item.date+'T12:00:00Z'))),node('span',SLOTS[item.slot]));const title=node('span',item.title||'Untitled script','content-row-title');title.append(node('small',item.job?.totalScenes?item.job.completedScenes+' of '+item.job.totalScenes+' scenes complete':item.script?wordCount(item.script)+' words / starts '+formatTime(item.generationStartsAt):'Waiting for a script'));const status=node('span',labels[item.status]||item.status.replaceAll('_',' '),'status-badge');status.dataset.tone=item.status==='ready'?'success':['needs_review','content_not_planned','publishing_failed','skipped','policy_blocked'].includes(item.status)?'attention':['producing','queued','retry_wait','creating_job'].includes(item.status)?'active':'neutral';header.append(date,title,status);card.append(header);
  const body=node('div','','content-item-body');body.append(node('p','Generation: '+formatTime(item.generationStartsAt)+(state.settings.enabled?'':' / schedule paused')));
  if(item.nextRetryAt){const retry=node('p','','retry-countdown');retry.dataset.retryAt=item.nextRetryAt;body.append(retry);}
  const issue=friendlyIssue(item);if(issue)body.append(node('p',issue,'notice'));
  if(item.job?.totalScenes){const progress=node('details');progress.dataset.disclosure=item.id+'-scenes';progress.open=opened.has(progress.dataset.disclosure);progress.append(node('summary','Scene progress - '+item.job.completedScenes+' / '+item.job.totalScenes));for(const scene of item.job.scenes){const line=node('p','Scene '+scene.number+': '+scene.status.replaceAll('_',' ')+' / attempt '+scene.attempts);if(scene.retryAt){const retry=node('span','','retry-countdown');retry.dataset.retryAt=scene.retryAt;line.append(retry);}progress.append(line);}body.append(progress);}
  if(item.script){const details=node('details');details.dataset.disclosure=item.id+'-script';details.open=opened.has(details.dataset.disclosure);details.append(node('summary','View spoken script'),node('pre',item.script));body.append(details);const metadata=buildPostMetadata(item.script);if(metadata){const post=node('details');post.dataset.disclosure=item.id+'-post';post.open=opened.has(post.dataset.disclosure);post.append(node('summary','Caption & hashtags'),node('p',metadata.caption));const tags=node('div','','tag-list');for(const tag of metadata.hashtags)tags.append(node('span',tag));post.append(tags);body.append(post);}}
  if(item.job?.pacing){const adjusted=item.job.pacing.scenes.filter(scene=>scene.speedFactor>1);body.append(node('p',adjusted.length?'Pace matched in '+adjusted.length+' scene(s). Audio pitch and video timing are preserved.':'Automatic pacing checked. Speech rates are already consistent.'));}
  if(item.error||(['failed','interrupted'].includes(item.job?.status)&&item.job.message)){const diagnostic=node('details','','diagnostics');diagnostic.append(node('summary','Technical details'),node('pre',item.error||item.job.message));body.append(diagnostic);}
  const controls=node('div','','content-actions');if(item.script&&!item.jobId&&!['queued','creating_job','producing','fetching_script','awaiting_verification'].includes(item.status))controls.append(button('Create video',async()=>{await api('/api/content/start-video','POST',{date:item.date,slot:item.slot});message('Video queued. Follow production in the library.');await refresh();renderWeek(drafts());}));if(item.job?.canResume)controls.append(button('Resume video',()=>api('/api/videos/jobs/'+item.jobId+'/resume','POST',{})));const studio=node('a',item.jobId?'Open video progress':'Open video studio','button-link secondary-button');studio.href=item.jobId?'/?job='+encodeURIComponent(item.jobId):'/';controls.append(studio);if(item.job?.videoUrl){const link=node('a','Watch final video','button-link');link.href=item.job.videoUrl;link.target='_blank';link.rel='noopener';controls.append(link);}body.append(controls);card.append(body);root.append(card);
 }
}
async function refresh(){state=await api('/api/content');state.settings.slots??=state.slots||{morning:'06:00',afternoon:'12:00',late_afternoon:'16:00',evening:'20:00'};TIMES=Object.fromEntries(Object.entries(state.settings.slots).map(([slot,time])=>[slot,new Intl.DateTimeFormat('en',{hour:'numeric',minute:'2-digit',timeZone:'Africa/Lagos'}).format(new Date('2000-01-02T'+time+':00+01:00'))]));$('#scheduler-health').textContent=(state.settings.enabled?'Schedule is active. ':'Schedule is paused. ')+(state.scheduler?.lastTickAt?'Last check '+formatTime(state.scheduler.lastTickAt)+'.':'The worker checks automatically while the server runs.');$('#schedule-badge').textContent=state.settings.enabled?'AUTOMATIC':'PAUSED';document.querySelectorAll('.posting-note').forEach(note=>note.textContent=state.settings.autoPublish?'Automatic posting on':'Publishing paused');renderLibrary();}
function setBusy(value){busy=value; $('#week-form').inert=value; $('#save-week').disabled=value;$('#save-create').disabled=value;}
async function saveWeek(create){
 if(busy)return;
 const records=drafts().filter(record=>record.script.trim() || record.title.trim());
 if(!records.length)throw new Error('Paste at least one spoken script into an editable slot.');
 for(const record of records)if(record.script.trim().length<10)throw new Error(record.date+' '+record.slot+': add the complete spoken script (at least 10 characters).');
 setBusy(true);
 try {
  // Select manual input explicitly, without altering automatic-production consent.
  await api('/api/content/settings','PUT',{scriptSource:'manual'});
  const result=await api('/api/content/scripts','POST',{records});
  dirty=false;try{localStorage.removeItem(DRAFT_KEY);}catch{}
  if(!create){await api('/api/content/settings','PUT',{scriptSource:'manual',enabled:true,generationLeadMinutes:Number($('#lead-minutes').value)});$('#enabled').checked=true;}
  if(create){await api('/api/content/start-saved','POST',{ids:result.ids});message(result.imported+' scripts saved and queued. '+(state.settings.autoPublish?'They will publish after editing.':'Posting is off.'));}
  else message(result.imported+' scripts saved. Scheduled production is enabled. Each video starts '+$('#lead-minutes').value+' minutes before its slot.');
  await refresh();renderWeek();
 }finally{setBusy(false);}
}
$('#week-form').onsubmit=e=>{e.preventDefault();action(()=>saveWeek(false));};
$('#save-create').onclick=()=>action(()=>saveWeek(true));
$('#load-week').onclick=()=>action(async()=>{
 if(!$('#week-start').checkValidity())throw new Error('Choose a valid first day.');
 if(dirty && !confirm('Switch weeks and discard the unsaved changes shown here?'))return;
 weekStart=$('#week-start').value;dirty=false;try{localStorage.removeItem(DRAFT_KEY);}catch{}await refresh();renderWeek();
});
$('#settings').onsubmit=e=>{e.preventDefault();action(async()=>{await api('/api/content/settings','PUT',{scriptSource:'manual',enabled:$('#enabled').checked,generationLeadMinutes:Number($('#lead-minutes').value)});message('Production schedule saved.');await refresh();});};
$('#refresh').onclick=()=>action(()=>refresh());
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
await action(async()=>{await refresh();$('#enabled').checked=state.settings.enabled;$('#lead-minutes').value=String(state.settings.generationLeadMinutes ?? 120);let draft;try{draft=JSON.parse(localStorage.getItem(DRAFT_KEY));}catch{}weekStart=/^\d{4}-\d{2}-\d{2}$/.test(draft?.start||'')?draft.start:today();$('#week-start').value=weekStart;renderWeek(draft?.records);if(draft?.records){dirty=true;message('Unsaved scripts restored from this browser. Save them to add them to your schedule.');}});
setInterval(()=>action(()=>refresh()),10000);

function updateCountdowns(){document.querySelectorAll('.retry-countdown').forEach(el=>{const seconds=Math.max(0,Math.ceil((Date.parse(el.dataset.retryAt)-Date.now())/1000));el.textContent=seconds?' Retrying automatically in '+seconds+'s.':' Retry queued; waiting for the video worker.';});}
setInterval(updateCountdowns,1000);

function showScheduleTimes(){const minutes=Number($('#lead-minutes').value);const times=Object.values(state?.settings.slots||{morning:'06:00',afternoon:'12:00',late_afternoon:'16:00',evening:'20:00'}).map(time=>new Intl.DateTimeFormat('en',{timeZone:'Africa/Lagos',hour:'numeric',minute:'2-digit'}).format(new Date(Date.parse('2000-01-02T'+time+':00+01:00')-minutes*60000)));$('#schedule-times').textContent='Generation starts at '+times.join(', ')+' Lagos time. Temporary scene failures retry after 10 seconds. Existing clips are kept during recovery.';}
$('#lead-minutes').addEventListener('change',showScheduleTimes);showScheduleTimes();

for(const el of document.querySelectorAll('[data-filter]'))el.onclick=()=>{libraryFilter=el.dataset.filter;document.querySelectorAll('[data-filter]').forEach(button=>button.setAttribute('aria-pressed',String(button===el)));renderLibrary();};$('#all-dates').onchange=renderLibrary;

window.addEventListener('publishing-settings-changed',event=>{if(state){state.settings.autoPublish=event.detail.autoPublish;state.settings.platforms=event.detail.platforms||[];}});
