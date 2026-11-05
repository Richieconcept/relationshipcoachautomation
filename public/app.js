import { setupApprovedVideoStart } from './approved-video-start.js';
import { buildPostMetadata, spokenScript } from './post-metadata.js';
const accountLoginForm = document.querySelector('#account-login-form');
const accountIdInput = document.querySelector('#account-id');
const accountMessage = document.querySelector('#account-message');
const accountsList = document.querySelector('#accounts-list');
const refreshAccountsButton = document.querySelector('#refresh-accounts');

// ---------- Project form: scenes are built dynamically, any number of them ----------

const projectForm = document.querySelector('#project-form');
const titleInput = document.querySelector('#title');
const aspectRatioInput = document.querySelector('#aspectRatio');
const globalInstructionsInput = document.querySelector('#globalInstructions');
const referenceImageInput = document.querySelector('#referenceImage');
const sceneList = document.querySelector('#scene-list');
const sceneCount = document.querySelector('#scene-count');
const addSceneButton = document.querySelector('#add-scene');
const actionButtons = Array.from(document.querySelectorAll('.form-actions button[type="submit"]'));
const platformCards = Array.from(document.querySelectorAll('.platform-card'));
const modeInputs = Array.from(document.querySelectorAll('input[name="inputMode"]'));
const scriptSection = document.querySelector('#script-section');
const manualSection = document.querySelector('#manual-section');
const scriptInput = document.querySelector('#script');
const scriptStats = document.querySelector('#script-stats');
const scriptHint = document.querySelector('#script-hint');
const scriptPreview = document.querySelector('#script-preview');
const EDIT_FIELDS = { logo: 'editLogo', music: 'editMusic', captions: 'editCaptions' };

// ---------- Script mode: the server splits the script; the page shows the scenes before anything is generated ----------

let lastSplit = null;
let splitTimer = null;
let splitRequest = 0;

function currentMode() {
  return modeInputs.find((input) => input.checked)?.value || 'script';
}

function applyMode() {
  const scriptMode = currentMode() === 'script';
  scriptSection.hidden = !scriptMode;
  manualSection.hidden = scriptMode;
}

function renderScriptPreview(split, errorMessage = '') {
  scriptHint.classList.toggle('is-error', Boolean(errorMessage));
  if (errorMessage || !split) {
    scriptStats.textContent = '';
    scriptPreview.replaceChildren();
    scriptHint.textContent = errorMessage || 'Type or paste the script. It is split into scenes of 4s, 6s, 8s or 10s, cut at full stops where possible.';
    scriptHint.hidden = false;
    return;
  }

  scriptStats.textContent = `${split.scenes.length} scene${split.scenes.length === 1 ? '' : 's'} · ${split.totalWords} words · ~${Math.round(split.estimatedSeconds)}s spoken · ${split.videoSeconds}s of clips`;
  scriptHint.textContent = `Each scene gets the shortest Flow clip its words fit: ${split.clipOptions.map((option) => `${option.label} (up to ${option.maxWords} words)`).join(', ')}.`;
  scriptPreview.replaceChildren(...split.scenes.map((scene) => {
    const item = document.createElement('li');
    item.className = 'script-scene';
    const header = document.createElement('div');
    header.className = 'script-scene-header';
    const name = document.createElement('strong');
    name.textContent = `Scene ${scene.number}`;
    const info = document.createElement('span');
    info.textContent = `${scene.words} words · ~${scene.estimatedSeconds}s spoken`;
    const clip = document.createElement('span');
    clip.className = 'clip-badge';
    clip.textContent = `${scene.duration} clip`;
    const right = document.createElement('div');
    right.className = 'script-scene-meta';
    right.append(info, clip);
    header.append(name, right);
    const text = document.createElement('p');
    text.textContent = scene.text;
    item.append(header, text);
    return item;
  }));
}

async function updateScriptPreview() {
  const script = scriptInput.value.trim();
  if (!script) {
    lastSplit = null;
    renderScriptPreview(null);
    return;
  }

  // Only the newest request may update the preview (typing sends several).
  const requestId = ++splitRequest;
  try {
    const response = await fetch('/api/videos/split-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script })
    });
    const data = await response.json();
    if (requestId !== splitRequest) {
      return;
    }
    if (!response.ok) {
      lastSplit = null;
      renderScriptPreview(null, data.message || 'Could not split the script.');
      return;
    }
    lastSplit = data;
    renderScriptPreview(data);
  } catch (error) {
    if (requestId === splitRequest) {
      lastSplit = null;
      renderScriptPreview(null, `Could not reach the server: ${error.message}`);
    }
  }
}

function scheduleScriptPreview() {
  clearTimeout(splitTimer);
  splitTimer = setTimeout(() => updateScriptPreview(), 350);
}

function readEditing() {
  const editing = {};
  for (const [step, name] of Object.entries(EDIT_FIELDS)) {
    editing[step] = projectForm.querySelector(`[name="${name}"]`).checked;
  }
  return editing;
}

function restoreEditing(editing = {}) {
  for (const [step, name] of Object.entries(EDIT_FIELDS)) {
    if (step in editing) {
      projectForm.querySelector(`[name="${name}"]`).checked = Boolean(editing[step]);
    }
  }
}

function setBusy(busy) {
  document.querySelector('#start-approved-video').disabled = busy;
  document.querySelectorAll('#approved-video-start input, #approved-video-start select').forEach(input => { input.disabled = busy; });
  actionButtons.forEach((button) => {
    button.disabled = busy;
  });
}
const formError = document.querySelector('#form-error');

const DRAFT_KEY = 'flow-project-draft';
const LAST_JOB_KEY = 'flow-last-project-job';

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode); the page still works without it.
  }
}

function sceneItems() {
  return Array.from(sceneList.querySelectorAll('.scene-item'));
}

function renumberScenes() {
  const items = sceneItems();
  items.forEach((item, index) => {
    const number = index + 1;
    item.querySelector('.scene-label').textContent = `Scene ${number}`;
    item.querySelector('textarea').setAttribute('aria-label', `Scene ${number} prompt`);
    // At least one scene must always exist.
    item.querySelector('.remove-scene').disabled = items.length === 1;
  });
  sceneCount.textContent = `${items.length} scene${items.length === 1 ? '' : 's'}`;
}

function addScene(prompt = '', { focus = false } = {}) {
  const item = document.createElement('div');
  item.className = 'scene-item';

  const header = document.createElement('div');
  header.className = 'scene-item-header';

  const label = document.createElement('span');
  label.className = 'scene-label';

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'secondary-button remove-scene';
  removeButton.textContent = 'Remove';
  removeButton.addEventListener('click', () => {
    if (sceneItems().length > 1) {
      item.remove();
      renumberScenes();
      updatePostMetadata();
      saveDraft();
    }
  });

  const textarea = document.createElement('textarea');
  textarea.className = 'scene-prompt';
  textarea.rows = 5;
  textarea.placeholder = 'Describe what happens in this scene: visuals, camera movement, spoken script, on-screen text...';
  textarea.value = prompt;

  header.append(label, removeButton);
  item.append(header, textarea);
  sceneList.append(item);
  renumberScenes();

  if (focus) {
    textarea.focus();
  }
}

function readScenes() {
  return sceneItems().map((item) => item.querySelector('textarea').value.trim());
}

// Publishing fields are plain named inputs inside each .platform-card (facebookCaption, youtubeTitle, ...).
function updatePostMetadata() {
  const metadata = buildPostMetadata(currentMode() === 'script'
    ? scriptInput.value : spokenScript({ scenes: readScenes() }));
  for (const name of ['youtubeTitle', 'facebookCaption', 'tiktokCaption', 'youtubeDescription', 'facebookHashtags', 'tiktokHashtags', 'youtubeHashtags']) {
    const input = field(name);
    const wasAutomatic = input.dataset.automatic === 'true';
    input.readOnly = Boolean(metadata);
    input.dataset.automatic = String(Boolean(metadata));
    if (metadata) input.value = name === 'youtubeTitle' ? metadata.caption.slice(0, 100) : name.endsWith('Hashtags') ? metadata.hashtags.join(' ') : metadata.caption;
    else if (wasAutomatic) input.value = '';
  }
  document.querySelector('#post-metadata-hint').textContent = metadata
    ? 'YouTube title and caption: current script opening hook. Hashtags: brand and matching script topics. Edit the script to update them.'
    : 'Add a spoken script to generate the caption and hashtags automatically. Visual-only scenes use the post details you enter.';
  return metadata;
}

function publishingFieldValues() {
  const values = {};
  projectForm.querySelectorAll('.platform-card [name]').forEach((field) => {
    values[field.name] = field.type === 'checkbox' ? field.checked : field.value;
  });
  return values;
}

function restorePublishingFields(values = {}) {
  projectForm.querySelectorAll('.platform-card [name]').forEach((field) => {
    if (!(field.name in values)) {
      return;
    }
    if (field.type === 'checkbox') {
      field.checked = Boolean(values[field.name]);
    } else {
      field.value = values[field.name];
    }
  });
  syncPlatformCards();
}

function syncPlatformCards() {
  platformCards.forEach((card) => {
    card.classList.toggle('is-enabled', card.querySelector('.platform-toggle input').checked);
  });
}

function field(name) {
  return projectForm.querySelector(`[name="${name}"]`);
}

function readPublishing() {
  return {
    facebook: {
      enabled: field('facebookEnabled').checked,
      caption: field('facebookCaption').value.trim(),
      hashtags: field('facebookHashtags').value.trim()
    },
    tiktok: {
      enabled: field('tiktokEnabled').checked,
      caption: field('tiktokCaption').value.trim(),
      hashtags: field('tiktokHashtags').value.trim()
    },
    youtube: {
      enabled: field('youtubeEnabled').checked,
      title: field('youtubeTitle').value.trim(),
      description: field('youtubeDescription').value.trim(),
      hashtags: field('youtubeHashtags').value.trim()
    }
  };
}

// Mirrors the server's checks so mistakes show before anything is submitted; the server re-validates.
function publishingProblems(publishing) {
  const problems = [];
  if (!publishing.facebook.enabled && !publishing.tiktok.enabled && !publishing.youtube.enabled) {
    problems.push('Enable at least one platform to publish, or use Generate Only.');
  }
  if (publishing.facebook.enabled && !publishing.facebook.caption) {
    problems.push('Facebook: caption is required.');
  }
  if (publishing.tiktok.enabled && !publishing.tiktok.caption) {
    problems.push('TikTok: caption is required.');
  }
  if (publishing.youtube.enabled && !publishing.youtube.title) {
    problems.push('YouTube: title is required.');
  }
  return problems;
}

function saveDraft() {
  syncPlatformCards();
  storageSet(DRAFT_KEY, JSON.stringify({
    aspectRatio: aspectRatioInput.value,
    globalInstructionsOverride: globalInstructionsInput.value,
    inputMode: currentMode(),
    script: scriptInput.value,
    editing: readEditing(),
    scenes: sceneItems().map((item) => item.querySelector('textarea').value),
    publishing: publishingFieldValues()
  }));
}

function loadDraft() {
  let draft = null;
  try {
    draft = JSON.parse(storageGet(DRAFT_KEY) || 'null');
  } catch {
    draft = null;
  }

  // A project label from an earlier video must never become the next video's title.
  titleInput.value = '';
  aspectRatioInput.value = draft?.aspectRatio || '9:16';
  globalInstructionsInput.value = draft?.globalInstructionsOverride || '';
  scriptInput.value = draft?.script || '';
  const mode = draft?.inputMode === 'scenes' ? 'scenes' : 'script';
  modeInputs.forEach((input) => {
    input.checked = input.value === mode;
  });
  applyMode();
  restoreEditing(draft?.editing);

  const scenes = Array.isArray(draft?.scenes) && draft.scenes.length > 0 ? draft.scenes : [''];
  scenes.forEach((prompt) => addScene(prompt));
  restorePublishingFields(draft?.publishing);
  updateScriptPreview();
}

function showFormError(message) {
  formError.textContent = message;
  formError.hidden = !message;
}

addSceneButton.addEventListener('click', () => {
  addScene('', { focus: true });
  saveDraft();
});

projectForm.addEventListener('input', () => { updatePostMetadata(); saveDraft(); });
projectForm.addEventListener('change', saveDraft);
scriptInput.addEventListener('input', scheduleScriptPreview);
modeInputs.forEach((input) => input.addEventListener('change', () => { applyMode(); updatePostMetadata(); }));

// ---------- Progress display: rendered from the job's scenes array ----------

const jobIdEl = document.querySelector('#job-id');
const jobTitleEl = document.querySelector('#job-title');
const jobStatusEl = document.querySelector('#job-status');
const jobOverallEl = document.querySelector('#job-overall');
const jobProgressEl = document.querySelector('#job-progress');
const jobMessageEl = document.querySelector('#job-message');
const errorRow = document.querySelector('#error-row');
const jobErrorEl = document.querySelector('#job-error');
const sceneProgress = document.querySelector('#scene-progress');
const phaseMessage = document.querySelector('#phase-message');
const videoPreview = document.querySelector('#video-preview');
const downloadLink = document.querySelector('#download-link');
const joinedLink = document.querySelector('#joined-link');
const editingSummary = document.querySelector('#editing-summary');

const EDIT_STEP_NAMES = { logo: 'Logo', music: 'Music', captions: 'Captions' };

// "Logo ✓ · Music ✓ · Captions ✓", plus the reason for any step that was skipped.
function editingText(job) {
  const result = job.editingResult;
  if (!result) {
    return '';
  }
  const parts = Object.entries(EDIT_STEP_NAMES).map(([step, name]) => {
    if (result.applied?.[step]) {
      return `${name} ✓`;
    }
    return job.editing?.[step] ? `${name} skipped` : `${name} off`;
  });
  const reasons = Object.values(result.skipped || {});
  const adjustedScenes = (job.pacing?.scenes || []).filter(scene => scene.speedFactor > 1);
  if (adjustedScenes.length) {
    reasons.push(`Pace matched: ${adjustedScenes.map(scene => `scene ${scene.scene} at ${scene.speedFactor.toFixed(2)}x`).join(', ')}.`);
  }
  return `${parts.join(' · ')}${reasons.length ? `. ${reasons.join(' ')}` : ''}`;
}

const SCENE_STATUS = {
  recovering: { icon: '↻', label: 'Recovering existing scene' },
  queued: { icon: '⏳', label: 'Queued' },
  opening_flow: { icon: '🔄', label: 'Opening Flow' },
  uploading_reference: { icon: '🔄', label: 'Preparing storyboard' },
  submitting: { icon: '🔄', label: 'Submitting' },
  generating: { icon: '🔄', label: 'Generating' },
  downloading: { icon: '🔄', label: 'Downloading' },
  validating: { icon: '🔄', label: 'Validating' },
  retrying: { icon: '🔁', label: 'Retrying' },
  completed: { icon: '✅', label: 'Completed' },
  failed: { icon: '❌', label: 'Failed' }
};

const PROJECT_STATUS_LABEL = {
  interrupted: 'Interrupted — ready to resume',
  queued: 'Queued',
  generating: 'Generating scenes',
  validating: 'Validating',
  normalizing: 'Normalizing clips',
  assembling: 'Assembling video',
  editing: 'Editing video',
  completed: 'Completed',
  failed: 'Failed',
  completed_generation: 'Video ready, preparing to publish',
  uploading_to_cloudinary: 'Uploading to Cloudinary',
  ready_to_publish: 'Ready to publish',
  publishing: 'Publishing',
  published: 'Sent to Buffer',
  partially_published: 'Partially published',
  publishing_failed: 'Publishing failed'
};

const FINISHED_STATUSES = ['completed', 'failed', 'interrupted', 'published', 'partially_published', 'publishing_failed'];
const GENERATION_DONE_STATUSES = ['completed', 'completed_generation', 'uploading_to_cloudinary', 'ready_to_publish', 'publishing', 'published', 'partially_published', 'publishing_failed'];

const PLATFORM_STATUS = {
  pending: { icon: '⏳', label: 'Waiting', tone: 'queued' },
  publishing: { icon: '🔄', label: 'Publishing', tone: 'generating' },
  queued: { icon: '✅', label: 'Queued', tone: 'completed' },
  scheduled: { icon: '✅', label: 'Scheduled', tone: 'completed' },
  published: { icon: '✅', label: 'Published', tone: 'completed' },
  draft: { icon: '✅', label: 'Saved as draft', tone: 'completed' },
  failed: { icon: '❌', label: 'Failed', tone: 'failed' }
};
const PLATFORM_NAMES = { facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube' };

const pipelineProgress = document.querySelector('#pipeline-progress');
const cloudinaryRow = document.querySelector('#cloudinary-row');
const cloudinaryLink = document.querySelector('#cloudinary-link');
const copyCloudinaryButton = document.querySelector('#copy-cloudinary');
const retryPublishingButton = document.querySelector('#retry-publishing');
const resumeJobButton = document.querySelector('#resume-job');

let pollTimer = null;
let currentJobId = null;

function renderSceneProgress(scenes) {
  sceneProgress.replaceChildren(...scenes.map((scene) => {
    const info = SCENE_STATUS[scene.status] || { icon: '🔄', label: scene.status };
    const item = document.createElement('li');
    item.className = `scene-row scene-${scene.status}`;

    const main = document.createElement('div');
    main.className = 'scene-row-main';
    const name = document.createElement('strong');
    name.textContent = `Scene ${scene.scene}${scene.clipLength ? ` · ${scene.clipLength}` : ''}${scene.trimmedTo ? ` → ${scene.trimmedTo}s` : ''}`;
    const state = document.createElement('span');
    state.textContent = `${info.icon} ${info.label}${scene.attempts > 1 ? ` (attempt ${scene.attempts})` : ''}`;
    main.append(name, state);
    item.append(main);

    if (scene.message && !['completed', 'queued'].includes(scene.status)) {
      const detail = document.createElement('small');
      detail.textContent = scene.failure ? `${scene.failure.title}. ${scene.failure.nextAction}${scene.failure.providerMessage ? ` Flow says: ${scene.failure.providerMessage}` : ''}` : scene.message;
      item.append(detail);
    }

    if (scene.clipUrl) {
      const clipLink = document.createElement('a');
      clipLink.href = scene.clipUrl;
      clipLink.target = '_blank';
      clipLink.rel = 'noopener';
      clipLink.textContent = 'View clip';
      item.append(clipLink);
    }

    return item;
  }));
}

function pipelineRow(label, icon, state, detail, tone) {
  const item = document.createElement('li');
  item.className = `scene-row scene-${tone}`;
  const main = document.createElement('div');
  main.className = 'scene-row-main';
  const name = document.createElement('strong');
  name.textContent = label;
  const value = document.createElement('span');
  value.textContent = `${icon} ${state}`;
  main.append(name, value);
  item.append(main);
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    item.append(small);
  }
  return item;
}

// Scenes -> Assembly -> Cloudinary -> one row per enabled platform (Generate & Publish only).
function renderPipeline(job) {
  if (job.mode !== 'generate_and_publish') {
    pipelineProgress.hidden = true;
    pipelineProgress.replaceChildren();
    return;
  }

  const rows = [];
  const scenesDone = job.totalScenes > 0 && job.completedScenes === job.totalScenes;
  const generationDone = GENERATION_DONE_STATUSES.includes(job.status);
  const generationFailed = job.status === 'failed';

  if (scenesDone) {
    rows.push(pipelineRow('Scenes', '✅', 'Complete', '', 'completed'));
  } else if (generationFailed) {
    rows.push(pipelineRow('Scenes', '❌', 'Failed', '', 'failed'));
  } else {
    rows.push(pipelineRow('Scenes', '🔄', `${job.completedScenes || 0} / ${job.totalScenes || 0}`, '', 'generating'));
  }

  if (generationDone) {
    rows.push(pipelineRow('Assembly', '✅', 'Complete', '', 'completed'));
  } else if (scenesDone && generationFailed) {
    rows.push(pipelineRow('Assembly', '❌', 'Failed', '', 'failed'));
  } else if (scenesDone) {
    rows.push(pipelineRow('Assembly', '🔄', PROJECT_STATUS_LABEL[job.status] || job.status, '', 'generating'));
  } else {
    rows.push(pipelineRow('Assembly', '⏳', 'Waiting', '', 'queued'));
  }

  if (job.cloudinaryUrl) {
    rows.push(pipelineRow('Cloudinary', '✅', 'Uploaded', '', 'completed'));
  } else if (job.status === 'uploading_to_cloudinary') {
    rows.push(pipelineRow('Cloudinary', '🔄', 'Uploading', '', 'generating'));
  } else if (job.status === 'publishing_failed' && job.errorCode?.startsWith('CLOUDINARY')) {
    rows.push(pipelineRow('Cloudinary', '❌', 'Failed', job.error, 'failed'));
  } else {
    rows.push(pipelineRow('Cloudinary', '⏳', 'Waiting', '', 'queued'));
  }

  for (const [platform, result] of Object.entries(job.publishing || {})) {
    if (!result || result.status === 'disabled') {
      continue;
    }
    const info = PLATFORM_STATUS[result.status] || { icon: '🔄', label: result.status, tone: 'generating' };
    let detail = result.status === 'pending' ? '' : result.message;
    if (result.status === 'failed') {
      detail = `${result.error || 'Failed.'}${result.errorCode ? ` (${result.errorCode})` : ''}`;
    }
    rows.push(pipelineRow(PLATFORM_NAMES[platform] || platform, info.icon, info.label, detail, info.tone));
  }

  pipelineProgress.replaceChildren(...rows);
  pipelineProgress.hidden = false;
}

function phaseText(job) {
  if (job.localMediaDeletedAt) return 'Published ✅ — local video files cleared automatically.';
  if (job.status === 'completed') {
    return 'Final video ready ✅';
  }
  if (job.status === 'published') {
    return 'Final video ready and sent to Buffer ✅';
  }
  if (['partially_published', 'publishing_failed'].includes(job.status)) {
    return job.finalVideoUrl ? 'Final video ready ✅ (publishing needs attention)' : '';
  }
  if (job.totalScenes > 0 && job.completedScenes === job.totalScenes && job.status !== 'failed') {
    return `All scenes generated ✅ — ${PROJECT_STATUS_LABEL[job.status] || job.status}...`;
  }
  return '';
}

function renderJob(job) {
  currentJobId = job.jobId || currentJobId;
  jobIdEl.textContent = job.jobId || '-';
  jobTitleEl.textContent = job.title || '-';
  jobStatusEl.textContent = PROJECT_STATUS_LABEL[job.status] || job.status || '-';
  jobMessageEl.textContent = job.failure ? `${job.failure.title}. ${job.failure.nextAction}${job.failure.providerMessage ? ` Flow says: ${job.failure.providerMessage}` : ''}` : job.message || '-';

  const total = job.totalScenes || 0;
  const completed = job.completedScenes || 0;
  jobOverallEl.textContent = total ? `${completed} / ${total} scenes completed` : '-';
  jobProgressEl.style.width = `${job.progressPercent || 0}%`;

  const errorText = job.error ? `${job.error}${job.errorCode ? ` (${job.errorCode})` : ''}` : '';
  jobErrorEl.textContent = errorText || '-';
  errorRow.hidden = !errorText;

  renderSceneProgress(job.scenes || []);
  renderPipeline(job);

  const phase = phaseText(job);
  phaseMessage.textContent = phase;
  phaseMessage.hidden = !phase;

  if (job.finalVideoUrl) {
    const version = job.finalVideo?.sizeBytes;
    const previewUrl = version ? `${job.finalVideoUrl}${job.finalVideoUrl.includes('?') ? '&' : '?'}v=${version}` : job.finalVideoUrl;
    if (videoPreview.getAttribute('src') !== previewUrl) {
      videoPreview.src = previewUrl;
    }
    videoPreview.hidden = false;
    downloadLink.href = previewUrl;
    downloadLink.hidden = false;
  } else {
    videoPreview.hidden = true;
    videoPreview.removeAttribute('src');
    downloadLink.hidden = true;
  }

  // The unedited join stays downloadable, including when editing itself failed.
  joinedLink.hidden = !job.joinedVideoUrl;
  if (job.joinedVideoUrl) {
    joinedLink.href = job.joinedVideoUrl;
  }

  const pacingReport = document.querySelector('#pacing-report');
  const pacingBody = document.querySelector('#pacing-report-body');
  pacingReport.hidden = !job.pacing;
  if (job.pacing) {
    pacingBody.replaceChildren();
    const overview = document.createElement('p');
    overview.textContent = 'Speech rate is compared across reliable scenes. Long pauses are shortened and slow clips are gently accelerated with pitch preserved.';
    pacingBody.append(overview);
    for (const scene of job.pacing.scenes || []) {
      const line = document.createElement('p');
      line.textContent = 'Scene ' + scene.scene + ': ' + (scene.speedFactor > 1 ? scene.speedFactor.toFixed(2) + 'x pace' : 'Original pace') + (scene.reviewRecommended ? ' - still slower after the safe adjustment; review recommended.' : '.');
      pacingBody.append(line);
    }
  }
  const editing = editingText(job);
  editingSummary.textContent = editing;
  editingSummary.hidden = !editing;

  cloudinaryRow.hidden = !job.cloudinaryUrl;
  if (job.cloudinaryUrl) {
    cloudinaryLink.href = job.cloudinaryUrl;
    cloudinaryLink.textContent = job.cloudinaryUrl;
  }
  retryPublishingButton.hidden = !job.canRetryPublishing;
  resumeJobButton.hidden = !job.canResume;
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function pollJob(jobId) {
  const response = await fetch(`/api/videos/jobs/${encodeURIComponent(jobId)}`);
  const data = await response.json();

  if (response.status === 404) {
    stopPolling();
    setBusy(false);
    jobMessageEl.textContent = 'This job is no longer known to the server (it may have restarted).';
    return;
  }

  renderJob(data);
  approvedVideoStart.jobUpdated(data);

  if (FINISHED_STATUSES.includes(data.status)) {
    setBusy(false);
    const awaitingPublication = data.status === 'published' && !data.localMediaDeletedAt
      && Object.values(data.publishing || {}).some(result => ['publishing', 'queued', 'scheduled'].includes(result.status));
    if (!awaitingPublication) stopPolling();
  }
}

function startPolling(jobId) {
  stopPolling();
  storageSet(LAST_JOB_KEY, jobId);
  pollTimer = setInterval(() => pollJob(jobId).catch(console.error), 3000);
  return pollJob(jobId);
}

copyCloudinaryButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(cloudinaryLink.href);
    copyCloudinaryButton.textContent = 'Copied';
  } catch {
    copyCloudinaryButton.textContent = 'Copy failed';
  }
  setTimeout(() => {
    copyCloudinaryButton.textContent = 'Copy';
  }, 1500);
});

retryPublishingButton.addEventListener('click', async () => {
  if (!currentJobId) {
    return;
  }
  retryPublishingButton.disabled = true;
  try {
    const response = await fetch(`/api/videos/jobs/${encodeURIComponent(currentJobId)}/publish`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || data.error || 'Could not retry publishing.');
    }
    setBusy(true);
    await startPolling(currentJobId);
  } catch (error) {
    jobMessageEl.textContent = error.message;
  } finally {
    retryPublishingButton.disabled = false;
  }
});

resumeJobButton.addEventListener('click', async () => {
  if (!currentJobId) return;
  resumeJobButton.disabled = true;
  try {
    const response = await fetch(`/api/videos/jobs/${encodeURIComponent(currentJobId)}/resume`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Could not resume this job.');
    setBusy(true);
    await startPolling(currentJobId);
  } catch (error) {
    jobMessageEl.textContent = error.message;
  } finally {
    resumeJobButton.disabled = false;
  }
});

projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showFormError('');
  const mode = (event.submitter?.value || (projectForm.dataset.automaticPosting==='true'?'generate_and_publish':'generate_only')) === 'generate_and_publish' ? 'generate_and_publish' : 'generate_only';
  const scriptMode = currentMode() === 'script';
  const script = scriptInput.value.trim();

  const scenes = readScenes();
  if (scriptMode) {
    if (!script) {
      showFormError('Write the script first.');
      scriptInput.focus();
      return;
    }
  } else {
    const emptyIndex = scenes.findIndex((prompt) => !prompt);
    if (scenes.length === 0) {
      showFormError('Add at least one scene.');
      return;
    }
    if (emptyIndex >= 0) {
      showFormError(`Scene ${emptyIndex + 1} is empty. Write a prompt or remove it.`);
      sceneItems()[emptyIndex].querySelector('textarea').focus();
      return;
    }
  }

  updatePostMetadata();
  const publishing = readPublishing();
  if (!publishing.youtube.title) publishing.youtube.title = titleInput.value.trim() || buildPostMetadata(scriptMode ? script : spokenScript({ scenes }))?.caption.slice(0, 100) || '';
  if (mode === 'generate_and_publish') {
    const problems = publishingProblems(publishing);
    if (problems.length > 0) {
      showFormError(problems.join(' '));
      return;
    }
  }

  const formData = new FormData();
  formData.append('title', titleInput.value.trim());
  formData.append('mode', mode);
  formData.append('aspectRatio', aspectRatioInput.value);
  formData.append('globalInstructions', globalInstructionsInput.value.trim());
  if (scriptMode) {
    formData.append('script', script);
  } else {
    formData.append('scenes', JSON.stringify(scenes.map((prompt, index) => ({ scene: index + 1, prompt }))));
  }
  formData.append('editing', JSON.stringify(readEditing()));
  if (mode === 'generate_and_publish') {
    formData.append('publishing', JSON.stringify(publishing));
  }
  if (referenceImageInput.files[0]) {
    formData.append('referenceImage', referenceImageInput.files[0]);
  }

  setBusy(true);
  renderJob({ title: titleInput.value.trim() || '-', status: 'queued', message: 'Submitting project...', scenes: [] });

  try {
    const response = await fetch('/api/videos/generate-project', { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || data.error || 'Could not create the project.');
    }

    await startPolling(data.jobId);
    if (data.warnings?.length) {
      showFormError(data.warnings.join(' '));
    }
  } catch (error) {
    setBusy(false);
    showFormError(error.message);
    renderJob({ status: 'failed', message: error.message, scenes: [] });
  }
});

loadDraft();
updatePostMetadata();

// Resume showing the last project after a page reload.
const approvedVideoStart = setupApprovedVideoStart({ renderJob, startPolling, setBusy, clearPreviousJob: () => storageSet(LAST_JOB_KEY, '') });
const linkedJobId = new URLSearchParams(location.search).get('job');
const validLinkedJob = /^vid_[a-zA-Z0-9_-]+$/.test(linkedJobId || '') ? linkedJobId : null;
const restoringApprovedRun = validLinkedJob ? false : approvedVideoStart.restorePending();
const lastJobId = validLinkedJob || storageGet(LAST_JOB_KEY);
if (validLinkedJob) storageSet(LAST_JOB_KEY, validLinkedJob);
if (lastJobId && !restoringApprovedRun) {
  setBusy(true);
  startPolling(lastJobId).catch(() => {
    setBusy(false);
  });
}

// ---------- Brand assets: presenter image, logo and music, saved once and used for every video ----------

const brandRows = Array.from(document.querySelectorAll('.brand-row'));
const brandMessage = document.querySelector('#brand-message');
const defaultInstructionsInput = document.querySelector('#default-global-instructions');
const defaultsMessage = document.querySelector('#defaults-message');
const saveDefaultsButton = document.querySelector('#save-default-instructions');

async function loadDefaults() {
  const response = await fetch('/api/brand/defaults');
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Could not load video defaults.');
  defaultInstructionsInput.value = data.defaults.globalInstructions;
  defaultsMessage.textContent = data.defaults.globalInstructions ? 'Saved instructions are applied automatically to new scripts.' : 'Add your global instructions once, then save.';
}
saveDefaultsButton.addEventListener('click', async () => {
  saveDefaultsButton.disabled = true;
  try {
    const response = await fetch('/api/brand/defaults', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ globalInstructions: defaultInstructionsInput.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Could not save instructions.');
    defaultsMessage.textContent = 'Saved. These instructions will be used for every new script.';
  } catch (error) { defaultsMessage.textContent = error.message; }
  finally { saveDefaultsButton.disabled = false; }
});
loadDefaults().catch(error => { defaultsMessage.textContent = error.message; });

function formatBytes(bytes) {
  if (!bytes) {
    return '';
  }
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function renderBrand(assets) {
  brandRows.forEach((row) => {
    const asset = assets[row.dataset.kind];
    const state = row.querySelector('.brand-state');
    const preview = row.querySelector('.brand-preview');
    const removeButton = row.querySelector('.brand-remove');

    row.classList.toggle('is-ready', Boolean(asset?.available));
    removeButton.hidden = !asset?.available;
    state.textContent = asset?.available
      ? `${asset.fileName} · ${formatBytes(asset.sizeBytes)}`
      : 'Not set. Upload a file.';

    if (!asset?.available) {
      preview.replaceChildren();
      return;
    }
    if (preview.dataset.url === asset.url) {
      return;
    }
    preview.dataset.url = asset.url;
    if (row.dataset.kind === 'music') {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = asset.url;
      preview.replaceChildren(audio);
    } else {
      const image = document.createElement('img');
      image.src = asset.url;
      image.alt = asset.label;
      preview.replaceChildren(image);
    }
  });
}

async function loadBrand() {
  const response = await fetch('/api/brand');
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || 'Could not load brand assets.');
  }
  renderBrand(data.assets);
}

async function brandRequest(kind, options, busyMessage) {
  brandMessage.textContent = busyMessage;
  const response = await fetch(`/api/brand/${encodeURIComponent(kind)}`, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || data.error || 'Request failed.');
  }
  renderBrand(data.assets);
}

brandRows.forEach((row) => {
  const kind = row.dataset.kind;
  const fileInput = row.querySelector('input[type="file"]');
  const label = row.querySelector('strong').textContent;

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) {
      return;
    }
    const formData = new FormData();
    formData.append('file', file);
    try {
      await brandRequest(kind, { method: 'POST', body: formData }, `Uploading ${label.toLowerCase()}...`);
      brandMessage.textContent = `${label} saved. It will be used for every new video.`;
    } catch (error) {
      brandMessage.textContent = error.message;
    } finally {
      fileInput.value = '';
    }
  });

  row.querySelector('.brand-remove').addEventListener('click', async () => {
    try {
      await brandRequest(kind, { method: 'DELETE' }, `Removing ${label.toLowerCase()}...`);
      brandMessage.textContent = `${label} removed.`;
    } catch (error) {
      brandMessage.textContent = error.message;
    }
  });
});

loadBrand().catch((error) => {
  brandMessage.textContent = error.message;
});

function renderAccounts(accounts, activeAccount) {
  if (!accounts?.length) {
    accountsList.innerHTML = '<p class="empty-state">No configured accounts yet.</p>';
    return;
  }

  accountsList.innerHTML = accounts.map((account) => `
    <div class="account-row" data-account-id="${account.accountId}">
      <div class="account-main">
        <div>
          <strong>${account.accountId}</strong>
          <span>${account.accountId === activeAccount ? 'active' : account.status}</span>
        </div>
        <div class="account-actions">
          <button class="secondary-button account-action" type="button" data-action="simulate-limit">
            Simulate Limit
          </button>
          <button class="secondary-button account-action" type="button" data-action="reset">
            Reset
          </button>
        </div>
      </div>
      <small>${account.message || '-'}</small>
    </div>
  `).join('');
}

async function loadAccounts() {
  const response = await fetch('/api/videos/accounts');
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || data.error || 'Could not load accounts.');
  }

  renderAccounts(data.accounts, data.activeAccount);
}

accountLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const accountId = accountIdInput.value.trim();
  if (!accountId) {
    return;
  }

  accountMessage.textContent = 'Opening Chrome...';

  try {
    const response = await fetch('/api/videos/accounts/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || data.error || 'Could not open Chrome.');
    }

    accountMessage.textContent = data.message;
    await loadAccounts();
  } catch (error) {
    accountMessage.textContent = error.message;
  }
});

refreshAccountsButton.addEventListener('click', () => {
  loadAccounts().catch((error) => {
    accountMessage.textContent = error.message;
  });
});

accountsList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) {
    return;
  }

  const row = button.closest('[data-account-id]');
  const accountId = row?.dataset.accountId;
  const action = button.dataset.action;
  const endpoint = action === 'simulate-limit'
    ? `/api/videos/accounts/${encodeURIComponent(accountId)}/simulate-limit`
    : `/api/videos/accounts/${encodeURIComponent(accountId)}/reset`;

  button.disabled = true;
  accountMessage.textContent = action === 'simulate-limit'
    ? `Marking ${accountId} as limited...`
    : `Resetting ${accountId}...`;

  try {
    const response = await fetch(endpoint, { method: 'POST' });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || data.error || 'Could not update account.');
    }

    accountMessage.textContent = data.account.message;
    renderAccounts(data.accounts, data.activeAccount);
  } catch (error) {
    accountMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

loadAccounts().catch((error) => {
  accountMessage.textContent = error.message;
});

function applyAutomaticPosting(settings){
 const primary=document.querySelector('#generate-only-button');const secondary=document.querySelector('#generate-publish-button');
 const enabled=Boolean(settings.autoPublish);primary.value=enabled?'generate_and_publish':'generate_only';primary.textContent=enabled?'Create & publish':'Generate Only';secondary.hidden=enabled;
 if(enabled)for(const platform of ['facebook','tiktok','youtube']){const input=projectForm.elements[platform+'Enabled'];if(input){input.checked=settings.platforms.includes(platform);input.dispatchEvent(new Event('change',{bubbles:true}));}}
 projectForm.dataset.automaticPosting=String(enabled);
}
window.addEventListener('publishing-settings-changed',event=>applyAutomaticPosting(event.detail));
fetch('/api/content').then(response=>response.json()).then(data=>{if(data.success)applyAutomaticPosting(data.settings);}).catch(()=>{});
