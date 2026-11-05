const PENDING_KEY = 'flow-approved-video-slot';
const ITEM_ID = /^\d{4}-\d{2}-\d{2}-(morning|afternoon|late_afternoon|evening)$/;
const FAILED = ['needs_review', 'content_not_planned', 'publishing_failed', 'missed'];
const LABELS = { queued: 'Waiting to start the saved script...', fetching_script: 'Requesting the approved script from ChatGPT...', awaiting_verification: 'Complete human verification manually in the open ChatGPT Chrome window. This run will continue automatically afterward.', script_ready: 'Saved script ready. Starting production...', creating_job: 'Splitting the script and creating the video job...', producing: 'Generating and editing the video...', ready: 'Final video ready.' };

export function setupApprovedVideoStart({ renderJob, startPolling, setBusy, clearPreviousJob = () => {} }) {
  const form = document.querySelector('#approved-video-start');
  const button = document.querySelector('#start-approved-video');
  const date = document.querySelector('#approved-video-date');
  const slot = document.querySelector('#approved-video-slot');
  const status = document.querySelector('#approved-video-status');
  const script = document.querySelector('#approved-video-script');
  const details = document.querySelector('#approved-script-details');
  date.value = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  let timer; let currentItem; let activeJobId; let posting = false;
  const read = () => { try { return localStorage.getItem(PENDING_KEY); } catch { return null; } };
  const save = value => { try { if (value) localStorage.setItem(PENDING_KEY, value); else localStorage.removeItem(PENDING_KEY); } catch {} };
  function busy(value) { button.disabled = value; setBusy(value); }
  function fail(message) { status.textContent = message; clearTimeout(timer); currentItem = null; save(null); busy(false); }
  async function pollItem() {
    const id = currentItem;
    if (!id) return;
    try {
      const response = await fetch('/api/content/items/' + encodeURIComponent(id));
      const data = await response.json();
      if (currentItem !== id) return;
      if (!response.ok) { fail(data.message || 'Could not read this content run.'); return; }
      const item = data.item;
      status.textContent = item.error || LABELS[item.status] || item.status;
      if (item.script) { script.textContent = item.script; details.hidden = false; }
      if (item.jobId) {
        clearTimeout(timer); currentItem = null; save(null);
        status.textContent = item.job?.status === 'completed' ? 'Final video ready in the preview.' : 'Script received. Follow scene generation and editing in the video progress panel.';
        activeJobId = item.jobId;
        await startPolling(item.jobId);
        return;
      }
      if (FAILED.includes(item.status)) { fail(item.error || 'The run needs review before it can continue.'); return; }
      renderJob({ title: item.title || 'Approved content', status: 'queued', message: LABELS[item.status] || item.status, scenes: [] });
      timer = setTimeout(pollItem, 1500);
    } catch (error) {
      if (currentItem !== id) return;
      status.textContent = 'Connection interrupted. Reconnecting to the same run; no new request is being submitted.';
      timer = setTimeout(pollItem, 3000);
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (posting || currentItem || button.disabled) return;
    clearPreviousJob();
    posting = true; busy(true); clearTimeout(timer); details.hidden = true; script.textContent = '';
    status.textContent = 'Starting your saved script-to-video workflow...';
    renderJob({ title: 'Approved content', status: 'queued', message: status.textContent, scenes: [] });
    try {
      const response = await fetch('/api/content/start-video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: date.value, slot: slot.value }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Could not start the video workflow.');
      if (!ITEM_ID.test(data.itemId)) throw new Error('Server returned an invalid content slot.');
      currentItem = data.itemId; save(currentItem);
      await pollItem();
    } catch (error) { fail(error.message); }
    finally { posting = false; }
  });
  return { jobUpdated(job) {
    if (!activeJobId && ITEM_ID.test(job.contentSlotId || '')) {
      activeJobId = job.jobId; date.value = job.contentSlotId.slice(0, 10); slot.value = job.contentSlotId.slice(11);
    }
    if (job.jobId !== activeJobId) return;
    if (job.status === 'completed') status.textContent = 'Final video ready in the preview.';
    else if (job.status === 'failed') status.textContent = job.message || job.error || 'Video production needs attention.';
    else if (job.status === 'interrupted') status.textContent = 'This run is interrupted. Use Resume to recover the existing scene without creating a duplicate.';
  }, restorePending() {
    const id = read();
    if (!id || !ITEM_ID.test(id)) return false;
    date.value = id.slice(0, 10); slot.value = id.slice(11);
    currentItem = id; busy(true); status.textContent = 'Reconnecting to the saved content run...';
    pollItem(); return true;
  } };
}
