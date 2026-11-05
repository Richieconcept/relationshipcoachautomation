const heading=document.querySelector('.studio-page-heading');
if(heading&&!document.body.classList.contains('planner-app')){
 const panel=document.createElement('details');panel.className='panel automatic-posting-panel';panel.id='automatic-posting';
 panel.innerHTML='<summary class="section-summary"><span><strong>Automatic posting</strong><small id="posting-summary">Checking Buffer connection...</small></span><span class="schedule-badge" id="posting-badge">CHECKING</span></summary><div class="disclosure-body"><p id="buffer-connection" role="status"></p><p class="helper-text">Create now publishes after editing. Weekly scheduled videos publish at their content slot. Existing finished videos are not sent automatically.</p><form id="automatic-posting-form"><label class="check"><input type="checkbox" id="automatic-posting-enabled"> Publish new videos automatically</label><div id="buffer-destinations" class="buffer-destinations"></div><div class="content-actions"><button type="submit">Save posting settings</button><button type="button" class="secondary-button" id="reconnect-buffer">Refresh connection</button><a href="https://publish.buffer.com/settings/api" target="_blank" rel="noopener">Buffer API settings</a></div></form><p id="posting-message" role="status" aria-live="polite"></p></div>';
 if(document.body.classList.contains('video-app')){document.querySelector('.shell').before(panel);}else heading.after(panel);
 const find=selector=>panel.querySelector(selector);let current;
 async function request(method='GET',body){const response=await fetch('/api/content/publishing',{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok||!data.success)throw Error(data.message||'Could not read posting settings.');return data;}
 function updatePreference(settings){window.dispatchEvent(new CustomEvent('publishing-settings-changed',{detail:settings}));document.querySelectorAll('.posting-note').forEach(note=>note.textContent=settings.autoPublish?'Automatic posting on':'Publishing paused');}
 async function load(){
  current=await request();find('#automatic-posting-enabled').checked=Boolean(current.autoPublish);
  find('#posting-badge').textContent=current.autoPublish?'ON':'OFF';
  find('#posting-summary').textContent=current.autoPublish?'New videos will be sent to your selected channels.':'New videos stay in preview until posting is enabled.';
  find('#buffer-connection').textContent=current.connected?(current.cloudinaryReady?'Buffer connected. Select the channels to use.':'Buffer connected. Video hosting is not configured yet.'):(current.message||'Connect Buffer to activate posting.');
  const destinations=find('#buffer-destinations');destinations.replaceChildren();
  for(const platform of ['facebook','tiktok','youtube']){
   const label=document.createElement('label');label.className='buffer-destination';const check=document.createElement('input');check.type='checkbox';check.dataset.platform=platform;check.checked=current.platforms?.includes(platform)||false;
   const text=document.createElement('span');text.textContent={facebook:'Facebook',tiktok:'TikTok',youtube:'YouTube'}[platform];
   const select=document.createElement('select');select.dataset.channel=platform;select.setAttribute('aria-label',text.textContent+' channel');select.add(new Option('Choose a connected channel',''));
   for(const channel of current.channels||[])if(channel.platform===platform){const option=new Option(channel.name+(channel.isDisconnected?' (reconnect required)':channel.isLocked?' (locked)':''),channel.id);option.disabled=channel.isDisconnected||channel.isLocked;select.add(option);}
   select.value=current.channelIds?.[platform]||'';if(!select.value&&select.options.length===2&&!select.options[1].disabled)select.selectedIndex=1;
   label.append(check,text,select);destinations.append(label);
  }
  updatePreference(current);
 }
 find('#reconnect-buffer').onclick=()=>load().catch(error=>find('#posting-message').textContent=error.message);
 find('#automatic-posting-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const platforms=[...panel.querySelectorAll('[data-platform]:checked')].map(input=>input.dataset.platform);const channelIds=Object.fromEntries(platforms.map(platform=>[platform,find('[data-channel="'+platform+'"]').value]));const result=await request('PUT',{autoPublish:find('#automatic-posting-enabled').checked,platforms,channelIds});updatePreference(result.settings);find('#posting-message').textContent=result.settings.autoPublish?'Automatic posting enabled for new videos.':'Automatic posting paused.';await load();}catch(error){find('#posting-message').textContent=error.message;}finally{button.disabled=false;}};
 load().catch(error=>{find('#buffer-connection').textContent=error.message;find('#posting-summary').textContent='Open to connect Buffer and choose destinations.';find('#posting-badge').textContent='OFF';});
}
