import { MissingSceneTracker } from './missing-scene.service.js';
import { productionWindowError } from './production-policy.service.js';
import { flowTileFailure } from './flow-result-status.service.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getAvailableAccountId,
  markAccountAvailable,
  setAccountStatus
} from '../src/accounts.js';
import { closeBrowser, finishFlowGeneration, getFlowPageForAccount } from '../src/browser.js';
import { config } from '../src/config.js';
import { buildVideoUrl, isMp4Buffer, isMp4File, videoPathForJob } from '../src/downloads.js';
import { FlowAutomationError, FLOW_SELECTORS } from '../src/flow.js';
import { logger } from '../src/logger.js';
import { updateJob } from '../src/jobs.js';
import { FlowReferenceSession, referenceAsset } from './flow-reference.service.js';
import { savedFlowProjectUrl, rememberFlowProject } from '../src/flow-workspaces.js';
import { sceneCheckpoints, sceneFingerprint, needsRecovery, recoverableScene, recoveryError, selectRecoveryTile, recoveryCandidates } from './flow-recovery.service.js';
import { validateVideo } from './video-validator.service.js';

const referenceSession = new FlowReferenceSession();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function firstVisible(page, selectors, timeout = 1500) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return locator;
    } catch {
      // Keep trying fallback selectors.
    }
  }

  return null;
}

async function clickSettingOption(page, selectors, label, required = true, openerSelectors = []) {
  const scope = await page.locator('.cdk-overlay-container').count() ? page.locator('.cdk-overlay-container') : page;
  let option = await firstVisible(scope, selectors, 200);

  if (!option && openerSelectors.length > 0) {
    const opener = await firstVisible(page, openerSelectors, 1800);
    if (opener) {
      await opener.click();
      await sleep(650);
      option = await firstVisible(scope, selectors, 800);
    }
  }

  if (option) {
    const ariaChecked = await option.getAttribute('aria-checked').catch(() => null);
    const ariaSelected = await option.getAttribute('aria-selected').catch(() => null);
    const className = await option.getAttribute('class').catch(() => '');

    if (
      ariaChecked === 'true'
      || ariaSelected === 'true'
      || /\b(selected|active|checked)\b/i.test(className || '')
    ) {
      logger.info(`Flow setting already selected: ${label}`);
      return true;
    }

    await option.click({ timeout: 5000 }).catch(async () => {
      await option.click({ force: true, timeout: 5000 });
    });
    await sleep(350);
    logger.info(`Selected Flow setting: ${label}`);
    return true;
  }

  if (required) {
    throw new FlowAutomationError(
      'FLOW_SETTING_NOT_FOUND',
      `Could not find Flow setting option: ${label}. Update FLOW_SELECTORS in src/flow.js.`
    );
  }

  logger.warn(`Flow setting option not found: ${label}`);
  return false;
}

async function clickComposerControlByText(page, patterns) {
  return page.evaluate((sources) => {
    const regexes = sources.map((source) => new RegExp(source, 'i'));
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [tabindex]'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const text = (element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();

        return {
          element,
          rect,
          text,
          visible: rect.width > 0
            && rect.height > 0
            && style.visibility !== 'hidden'
            && style.display !== 'none'
        };
      })
      .filter((candidate) => candidate.visible)
      .filter((candidate) => candidate.rect.top > window.innerHeight * 0.55)
      .filter((candidate) => regexes.some((regex) => regex.test(candidate.text)))
      .sort((a, b) => b.rect.top - a.rect.top);

    const target = candidates[0]?.element;
    if (!target) {
      return false;
    }

    target.click();
    return true;
  }, patterns);
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export async function readPromptInputText(page) {
  for (const selector of FLOW_SELECTORS.promptInputCandidates) {
    const locator = page.locator(selector).first();
    try {
      const count = await page.locator(selector).count();
      if (count === 0) {
        continue;
      }
      if (!await locator.isVisible()) continue;

      if (selector.includes('textarea')) {
        return normalizeText(await locator.inputValue({ timeout: 500 }));
      }

      // ProseMirror stores multiline prompts in separate paragraphs. textContent
      // joins adjacent paragraphs without spaces and falsely rejects a correct prompt.
      return normalizeText(await locator.innerText({ timeout: 500 }));
    } catch {
      // Keep trying fallback prompt selectors.
    }
  }

  return '';
}

export function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Saves screenshots/<prefix>_<label>.png, e.g. vid_123_scene_003_attempt_02_error.png
async function saveScreenshot(page, prefix, label, logLabel = prefix) {
  if (!page) {
    return null;
  }

  try {
    const filePath = path.join(config.screenshotDir, `${prefix}_${label}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    logger.info(`${logLabel}: saved ${label} screenshot`, { filePath });
    return filePath;
  } catch (error) {
    logger.warn(`${logLabel}: could not save ${label} screenshot`, { error: error.message });
    return null;
  }
}

function errorText(error) {
  return [
    error?.message,
    error?.stack,
    error?.cause?.message,
    error?.cause?.stack
  ].filter(Boolean).join('\n');
}

function isLikelyNetworkError(error) {
  return /net::|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_TIMED_OUT|ERR_TUNNEL_CONNECTION_FAILED|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|page\.goto: Timeout/i.test(errorText(error));
}

function isLikelyTransientBrowserError(error) {
  return /Target page, context or browser has been closed|frame was detached|browserContext\.newPage/i.test(errorText(error));
}

function publicError(error) {
  // Recovery errors are plain Errors with explicit codes, not FlowAutomationError instances.
  if (error?.automationCode) return error.automationCode;
  if (['FLOW_RECOVERY_REQUIRED','SCENE_INPUTS_CHANGED','SCENE_BUSY'].includes(error?.code)) return error.code;
  if (isLikelyNetworkError(error)) {
    return 'NETWORK_ERROR';
  }

  if (isLikelyTransientBrowserError(error)) {
    return 'BROWSER_CLOSED';
  }

  if (error instanceof FlowAutomationError) {
    return error.code;
  }

  return 'UNKNOWN_ERROR';
}

function canRotateAccount(errorCode) {
  return ['FLOW_DAILY_LIMIT_REACHED', 'GOOGLE_LOGIN_REQUIRED', 'INSUFFICIENT_CREDITS'].includes(errorCode);
}

// Flow-side failures where trying the same prompt again is reasonable.
export const GENERATION_RETRY_CODES = [
  'GENERATION_FAILED',
  'GENERATION_TIMEOUT',
  'REFERENCE_UPLOAD_FAILED'
];

function retryMessage(errorCode, attempt, accountId, maxRetries = config.maxGenerationRetries) {
  const delaySeconds = Math.round(config.generationRetryDelayMs / 1000);
  const nextAttempt = attempt + 1;
  const totalAttempts = maxRetries + 1;

  if (errorCode === 'NETWORK_ERROR') {
    return `Network or Flow connection problem. Waiting ${delaySeconds}s, then retrying ${nextAttempt} of ${totalAttempts} with ${accountId}.`;
  }

  if (errorCode === 'REFERENCE_UPLOAD_FAILED') {
    return `Flow did not accept the reference image upload. Waiting ${delaySeconds}s, then retrying ${nextAttempt} of ${totalAttempts} with ${accountId}.`;
  }

  if (errorCode === 'BROWSER_CLOSED') {
    return `Chrome closed or reloaded during automation. Waiting ${delaySeconds}s, then retrying ${nextAttempt} of ${totalAttempts} with ${accountId}.`;
  }

  return `Flow generation failed. Waiting ${delaySeconds}s, then retrying ${nextAttempt} of ${totalAttempts} with ${accountId}.`;
}

async function pageLooksOffline(page) {
  return page.evaluate(() => /no internet|this site can.?t be reached|check your internet connection|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(document.body?.innerText || '')).catch(() => false);
}

export async function openFlow(page, savedProjectUrl = null) {
  const targetUrl = config.flowProjectUrl || savedProjectUrl || config.flowUrl;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  try {
    await page.waitForLoadState('networkidle', { timeout: 20000 });
  } catch {
    logger.warn('Flow page did not reach networkidle before continuing');
  }
}

export async function ensureLoggedIn(page) {
  if (/accounts\.google\.com/i.test(page.url())) {
    throw new FlowAutomationError(
      'GOOGLE_LOGIN_REQUIRED',
      'Google login is required. Sign in manually in the opened browser, then retry.'
    );
  }

  const loginIndicator = await firstVisible(page, FLOW_SELECTORS.loginIndicators, 1000);
  if (loginIndicator) {
    throw new FlowAutomationError(
      'GOOGLE_LOGIN_REQUIRED',
      'Google login is required. Sign in manually in the opened browser, then retry.'
    );
  }
}

export async function openProject(page) {
  if (!config.flowProjectUrl) {
    return;
  }

  if (page.url() !== config.flowProjectUrl) {
    await page.goto(config.flowProjectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
}

export async function prepareGeneration(page) {
  const existingPromptInput = await firstVisible(page, FLOW_SELECTORS.promptInputCandidates, 800);
  if (existingPromptInput) {
    return;
  }

  const newProjectButton = await firstVisible(page, FLOW_SELECTORS.newProjectButtonCandidates, 2500);
  if (!newProjectButton) {
    if (await pageLooksOffline(page)) {
      throw new FlowAutomationError(
        'NETWORK_ERROR',
        'Network connection is unavailable or Flow could not be reached. The job will wait and retry.'
      );
    }

    throw new FlowAutomationError(
      'PROJECT_NOT_FOUND',
      'Could not find an open project or the New project control in Google Flow.'
    );
  }

  await newProjectButton.click();

  const promptInput = await firstVisible(page, FLOW_SELECTORS.promptInputCandidates, 15000);
  if (!promptInput) {
    throw new FlowAutomationError(
      'PROMPT_INPUT_NOT_FOUND',
      'Opened a new Flow project, but could not find the prompt input. Update FLOW_SELECTORS in src/flow.js.'
    );
  }
}

const REFERENCE_PROCESSING_TIMEOUT_MS = 180000;

async function openAssetPicker(page) {
  const uploadMediaButton = await firstVisible(page, FLOW_SELECTORS.uploadMediaButtonCandidates, 800);
  if (uploadMediaButton) {
    return uploadMediaButton;
  }

  // The "+" button toggles the picker, so only click it while the picker is closed.
  const addIngredientsButton = await firstVisible(page, FLOW_SELECTORS.addIngredientsButtonCandidates, 5000);
  if (!addIngredientsButton) {
    throw new FlowAutomationError(
      'REFERENCE_UPLOAD_FAILED',
      'Could not find the composer "+" (Add ingredients) button in Google Flow. Update FLOW_SELECTORS in src/flow.js.'
    );
  }

  await addIngredientsButton.click({ timeout: 5000 });
  const opened = await firstVisible(page, FLOW_SELECTORS.uploadMediaButtonCandidates, 8000);
  if (!opened) {
    throw new FlowAutomationError(
      'REFERENCE_UPLOAD_FAILED',
      'Opened the Flow asset picker, but could not find the "Upload media" button. Update FLOW_SELECTORS in src/flow.js.'
    );
  }

  return opened;
}

async function sendFileToAssetPicker(page, uploadMediaButton, referenceImage) {
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
  await uploadMediaButton.click({ timeout: 5000 });
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(referenceImage);
    return;
  }

  // Fallback: Flow may render a hidden file input instead of opening a native picker.
  const fileInput = page.locator(FLOW_SELECTORS.uploadInput).first();
  if (await fileInput.count() > 0) {
    await fileInput.setInputFiles(referenceImage);
    return;
  }

  throw new FlowAutomationError(
    'REFERENCE_UPLOAD_FAILED',
    'Clicked "Upload media" in Google Flow, but no file picker opened.'
  );
}

async function readAssetPreviewTitle(page) {
  const preview = page.locator('flow-add-menu-detail-pane img[alt^="Preview of "]').first();
  if (await preview.count() > 0) {
    return normalizeText((await preview.getAttribute('alt')).replace(/^Preview of /, ''));
  }
  const title = page.locator(FLOW_SELECTORS.assetPreviewTitle).first();
  if (await title.count() === 0) {
    return '';
  }

  return normalizeText(await title.textContent({ timeout: 1000 }).catch(() => ''));
}

const REFERENCE_UPLOAD_APPEAR_TIMEOUT_MS = 30000;
const REFERENCE_UPLOAD_MAX_RESENDS = 2;

async function waitForUploadedAssetReady(page, fileName, resendFile) {
  const startedAt = Date.now();
  let selectedOurAsset = false;
  let sentAt = Date.now();
  let resends = 0;
  let assetSeen = false;

  while (Date.now() - startedAt < REFERENCE_PROCESSING_TIMEOUT_MS) {
    if (!assetSeen) {
      assetSeen = await page.getByText(fileName, { exact: true }).count().catch(() => 0) > 0;
    }

    // Flow occasionally accepts the file chooser but never starts the upload; send the file again.
    if (!assetSeen && Date.now() - sentAt > REFERENCE_UPLOAD_APPEAR_TIMEOUT_MS && resends < REFERENCE_UPLOAD_MAX_RESENDS) {
      resends += 1;
      logger.warn(`${fileName} did not appear in the Flow asset picker; sending it again (${resends}/${REFERENCE_UPLOAD_MAX_RESENDS})`);
      await resendFile();
      sentAt = Date.now();
      continue;
    }

    const addToPromptButton = await firstVisible(page, FLOW_SELECTORS.addToPromptButtonCandidates, 1000);
    const previewTitle = await readAssetPreviewTitle(page);

    // Flow normally auto-selects a fresh upload; if another asset is previewed, pick ours from the list.
    if (previewTitle && previewTitle !== fileName && !selectedOurAsset) {
      const assetRow = page.getByText(fileName, { exact: true }).and(page.locator(':visible')).first();
      if (await assetRow.isVisible().catch(() => false)) {
        await assetRow.click({ timeout: 3000 }).catch(() => {});
        selectedOurAsset = true;
        await sleep(1000);
        continue;
      }
    }

    if (addToPromptButton && await addToPromptButton.isEnabled().catch(() => false)) {
      if (!previewTitle || previewTitle === fileName) {
        return addToPromptButton;
      }
    }

    await sleep(2000);
  }

  throw new FlowAutomationError(
    'REFERENCE_UPLOAD_FAILED',
    `Uploaded ${fileName} to Google Flow, but it was not ready to add to the prompt within ${Math.round(REFERENCE_PROCESSING_TIMEOUT_MS / 1000)}s.`
  );
}

export async function uploadReferenceImage(page, referenceImage) {
  const fileName = typeof referenceImage === 'string' ? path.basename(referenceImage) : referenceImage.name;

  try {
    const chipsBefore = await page.locator(FLOW_SELECTORS.ingredientChip).count();
    if (chipsBefore > 0) {
      logger.warn(`Flow composer already has ${chipsBefore} ingredient(s) before uploading ${fileName}`);
    }

    const uploadMediaButton = await openAssetPicker(page);
    await sendFileToAssetPicker(page, uploadMediaButton, referenceImage);
    logger.info(`Reference image sent to Flow: ${fileName}. Waiting for processing.`);

    const addToPromptButton = await waitForUploadedAssetReady(page, fileName, async () => {
      const button = await openAssetPicker(page);
      await sendFileToAssetPicker(page, button, referenceImage);
    });
    await addToPromptButton.click({ timeout: 5000 });

    const chip = page.locator(FLOW_SELECTORS.ingredientChip);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
      if (await chip.count() > chipsBefore) {
        logger.info(`Reference image attached to Flow prompt: ${fileName}`);
        return;
      }
      await sleep(500);
    }

    throw new FlowAutomationError(
      'REFERENCE_UPLOAD_FAILED',
      `Clicked "Add to prompt" for ${fileName}, but the image did not appear in the Flow composer.`
    );
  } catch (error) {
    if (error instanceof FlowAutomationError) {
      throw error;
    }

    throw new FlowAutomationError(
      'REFERENCE_UPLOAD_FAILED',
      'Could not upload the reference image.',
      error
    );
  }
}

export async function clearReferenceAttachments(page) {
  const chips = page.locator(FLOW_SELECTORS.ingredientChip);
  // The remove control must belong to an ingredient chip; never click a project media tile.
  for (let remaining = await chips.count(); remaining > 0; remaining -= 1) {
    const chip = chips.first();
    await chip.hover();
    const remove = chip.locator('button[aria-label*="remove" i], [role="button"][aria-label*="remove" i], [aria-label*="close" i], .hover-icon-overlay:has(mat-icon:text-is("cancel"))');
    if (await remove.count() === 0) {
      throw new FlowAutomationError('REFERENCE_UPLOAD_FAILED', 'An existing ingredient could not be safely removed. Clear the composer image and retry.');
    }
    await remove.first().click();
    await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length < count,
      { selector: FLOW_SELECTORS.ingredientChip, count: remaining }, { timeout: 5000 });
  }
}

async function selectExistingReference(page, fileName) {
  await openAssetPicker(page);
  logger.info('Looking for the saved storyboard in the Flow asset picker');
  const search = page.getByRole('textbox', { name: 'Search assets', exact: true });
  if (await search.isVisible().catch(() => false)) await search.fill(fileName);
  const asset = page.locator('flow-add-menu-asset-list').getByText(fileName, { exact: true }).and(page.locator(':visible')).first();
  try {
    await asset.waitFor({ state: 'visible', timeout: 20000 });
  } catch {
    return false;
  }
  await asset.click({ timeout: 5000 });
  logger.info('Selected saved storyboard; checking the composer attachment');
  const add = page.locator('flow-add-menu-detail-pane button').filter({ hasText: 'Add to prompt' }).first();
  const chip = page.locator(FLOW_SELECTORS.ingredientChip).first();
  // Current Flow attaches an existing asset immediately on row click. Other versions
  // show a preview and require Add to prompt. Support both without sending the file again.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await chip.isVisible().catch(() => false)) return true;
    if (await add.isVisible().catch(() => false)) break;
    await sleep(250);
  }
  const title = await readAssetPreviewTitle(page);
  if (title !== fileName) {
    throw new FlowAutomationError('REFERENCE_UPLOAD_FAILED', 'The selected Flow asset preview does not match the storyboard. Nothing was submitted.');
  }
  await add.click({ timeout: 5000 });
  await chip.waitFor({ state: 'visible', timeout: 15000 });
  return true;
}

export async function ensureReferenceImage(page, referenceImage) {
  const asset = await referenceAsset(referenceImage);
  return referenceSession.ensure(page, asset, {
    isAttached: async () => await page.locator(FLOW_SELECTORS.ingredientChip).count() === 1,
    clearAttachments: () => clearReferenceAttachments(page),
    selectExisting: (name) => selectExistingReference(page, name),
    upload: (file) => uploadReferenceImage(page, file)
  });
}

export async function fillPrompt(page, prompt) {
  await page.keyboard.press('Escape');
  await sleep(500);

  const promptInput = await firstVisible(page, FLOW_SELECTORS.promptInputCandidates, 2500);
  if (!promptInput) {
    throw new FlowAutomationError(
      'PROMPT_INPUT_NOT_FOUND',
      'Could not find the Google Flow prompt input. Update FLOW_SELECTORS in src/flow.js.'
    );
  }

  // Fill only the editor. Global Ctrl+A/Backspace can reach Flow's media-grid
  // shortcuts and move selected project assets to Trash.
  await promptInput.fill(prompt);
  if (await readPromptInputText(page) !== normalizeText(prompt)) {
    throw new FlowAutomationError('PROMPT_INPUT_FAILED', 'The text in the Flow composer does not match the scene prompt. Nothing was submitted.');
  }
}

export async function configureAspectRatio(page, aspectRatio) {
  const selectors = FLOW_SELECTORS.aspectRatioCandidates[aspectRatio] || [];
  if (selectors.length > 0) {
    await clickSettingOption(
      page,
      selectors,
      `aspect ratio ${aspectRatio}`,
      true,
      FLOW_SELECTORS.settingOpeners.settings
    );
  }
}

export async function configureModel(page, model) {
  const settingsTrigger = page.getByRole('button', { name: 'Settings trigger', exact: true });
  if (await settingsTrigger.isVisible().catch(() => false)) {
    let family = page.getByRole('button', { name: 'Select model family', exact: true });
    if (!await family.isVisible().catch(() => false)) await settingsTrigger.click();
    const videoMode = page.locator('flow-toggles[aria-label="Mode"]').getByRole('radio', { name: 'Video', exact: true });
    await videoMode.waitFor({ state: 'visible', timeout: 8000 });
    if (await videoMode.getAttribute('aria-checked') !== 'true') await videoMode.click();
    await family.waitFor({ state: 'visible', timeout: 8000 });
    const selected = normalizeText(await family.innerText()).replace(/\s*arrow_drop_down\s*$/, '').trim();
    if (selected === normalizeText(model)) {
      logger.info(`Flow setting already selected: model ${model}`);
      return;
    }
    await family.click();
    const option = page.locator('.cdk-overlay-container').getByText(model, { exact: true }).and(page.locator(':visible')).first();
    try { await option.click({ timeout: 8000 }); }
    catch (cause) {
      throw new FlowAutomationError('FLOW_SETTING_NOT_FOUND', `Flow does not offer the configured model: ${model}.`, cause);
    }
    await family.waitFor({ state: 'visible', timeout: 5000 });
    if (!normalizeText(await family.innerText()).includes(normalizeText(model))) {
      throw new FlowAutomationError('FLOW_SETTING_NOT_FOUND', `Flow did not select model ${model}.`);
    }
    logger.info(`Selected Flow setting: model ${model}`);
    return;
  }
  const selectors = FLOW_SELECTORS.modelCandidates[model] || [];
  if (selectors.length === 0) {
    return;
  }

  let option = await firstVisible(page, selectors, 1000);
  if (!option) {
    await page.keyboard.press('Escape');
    await sleep(250);
    const opened = await clickComposerControlByText(page, [
      'Nano\\s*Banana',
      'Omni',
      'Veo'
    ]);

    if (!opened) {
      const opener = await firstVisible(page, FLOW_SELECTORS.settingOpeners.model, 1500);
      if (opener) {
        await opener.click();
      }
    }

    await sleep(900);
    const videoMode = await firstVisible(page, FLOW_SELECTORS.videoModeCandidates, 2000);
    if (videoMode) {
      await videoMode.click();
      await sleep(900);
      logger.info('Selected Flow setting: Video mode');
    }

    option = await firstVisible(page, selectors, 1800);
  }

  if (!option) {
    const modelDropdown = await firstVisible(page, FLOW_SELECTORS.modelDropdownCandidates, 2000);
    if (modelDropdown) {
      await modelDropdown.click();
      await sleep(900);
    }

    option = await firstVisible(page, selectors, 3000);
  }

  if (!option) {
    throw new FlowAutomationError(
      'FLOW_SETTING_NOT_FOUND',
      `Could not find Flow setting option: model ${model}. Open the model chip manually once and update FLOW_SELECTORS in src/flow.js if the label differs.`
    );
  }

  await option.click();
  await sleep(700);
  logger.info(`Selected Flow setting: model ${model}`);
}

export async function configureResolution(page, resolution) {
  const selectors = FLOW_SELECTORS.resolutionCandidates[resolution] || [];
  if (selectors.length > 0) {
    await clickSettingOption(
      page,
      selectors,
      `resolution ${resolution}`,
      true,
      FLOW_SELECTORS.settingOpeners.settings
    );
  }
}

export async function configureDuration(page, duration) {
  const selectors = FLOW_SELECTORS.durationCandidates[duration] || [];
  if (selectors.length > 0) {
    await clickSettingOption(
      page,
      selectors,
      `duration ${duration}`,
      true,
      FLOW_SELECTORS.settingOpeners.settings
    );
  }
}

export async function configureOutputCount(page, outputCount) {
  const selectors = FLOW_SELECTORS.outputCountCandidates[outputCount] || [];
  if (selectors.length > 0) {
    await clickSettingOption(
      page,
      selectors,
      `output count x${outputCount}`,
      true,
      FLOW_SELECTORS.settingOpeners.outputCount
    );
  }
}

export async function configureGenerationSettings(page, job) {
  await configureModel(page, job.model || config.defaultModel);
  await configureAspectRatio(page, job.aspectRatio || config.defaultAspectRatio);
  await configureResolution(page, config.defaultResolution);
  await configureDuration(page, job.duration || config.defaultDuration);
  await configureOutputCount(page, config.defaultOutputCount);
}

export async function startGeneration(page) {
  const generateButton = await firstVisible(page, FLOW_SELECTORS.generateButtonCandidates, 2500);
  if (generateButton) {
    await generateButton.click({ timeout: 10000 });
    return;
  }

  throw new FlowAutomationError('GENERATE_BUTTON_NOT_FOUND', 'Could not identify the Flow Generate button safely. No positional click was attempted.');
}

const GENERATION_START_TIMEOUT_MS = 45000;

// Waits for proof that Flow accepted the prompt: a new video tile in the grid.
// Throws straight away if Flow shows an error instead (e.g. "Not enough credits").
async function waitForNewVideoTile(page, existingVideoSources, timeoutMs) {
  const known = new Set(existingVideoSources);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const failure = await detectGenerationFailure(page);
    if (failure) {
      throw failure;
    }

    const tiles = await readVideoTiles(page);
    if (tiles.some((tile) => !tile.src || !known.has(tile.src))) {
      return true;
    }

    await sleep(2000);
  }

  return false;
}

export async function ensureGenerationStarted(page, prompt, logLabel = 'Flow', existingVideoSources = []) {
  await sleep(2000);

  if (await waitForNewVideoTile(page, existingVideoSources, GENERATION_START_TIMEOUT_MS)) {
    return;
  }

  throw new FlowAutomationError(
    'GENERATION_NOT_STARTED',
    `Flow did not confirm generation within ${GENERATION_START_TIMEOUT_MS / 1000}s. Submission was not repeated because it may already have been accepted. Inspect the saved diagnostics.`
  );
}

async function findVisibleErrorText(page) {
  return page.evaluate(({ patterns, ignoreSelector }) => {
    const regexes = patterns.map((source) => new RegExp(source, 'i'));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.textContent.replace(/\s+/g, ' ').trim();
      // Real Flow error messages are short; long text nodes are prompts or descriptions.
      if (!value || value.length > 200) {
        continue;
      }

      const element = node.parentElement;
      if (!element || element.closest(ignoreSelector)) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
        continue;
      }

      if (regexes.some((regex) => regex.test(value))) {
        return value;
      }
    }

    return null;
  }, {
    patterns: FLOW_SELECTORS.errorTextPatterns,
    ignoreSelector: FLOW_SELECTORS.errorTextIgnoreContainers.join(', ')
  }).catch(() => null);
}

export async function detectGenerationFailure(page) {
  const text = await findVisibleErrorText(page);
  if (!text) {
    return null;
  }

  // Checked first: "upgrade for more credits" must not be mistaken for anything else.
  if (/insufficient credits|not enough credits|more credits|out of credits/i.test(text)) {
    return new FlowAutomationError('INSUFFICIENT_CREDITS', `Google Flow account is out of credits: "${text.trim()}"`);
  }

  if (/daily limit|limit reached|generation limit|usage limit|quota|try again tomorrow|come back tomorrow|reached.*limit|too many|maximum/i.test(text)) {
    return new FlowAutomationError(
      'FLOW_DAILY_LIMIT_REACHED',
      text.trim() || 'Flow daily generation limit appears to be reached.'
    );
  }

  if (/rejected|policy/i.test(text)) {
    return new FlowAutomationError('GENERATION_REJECTED', 'Flow rejected the prompt or reference image.');
  }

  return new FlowAutomationError('GENERATION_FAILED', text.trim() || 'Flow reported a generation failure.');
}

export async function readVideoTiles(page) {
  return page.evaluate(({ tileSelector, mediaSelector }) => {
    return Array.from(document.querySelectorAll(tileSelector)).map((tile, index) => {
      const video = tile.querySelector(mediaSelector);
      const src = video ? (video.currentSrc || video.getAttribute('src') || '') : '';
      const text = (tile.innerText || '').replace(/\s+/g, ' ').trim();
      const label = tile.closest('[aria-label]')?.getAttribute('aria-label') || '';
      const thumbnail = tile.querySelector('img.thumbnail, img[alt="Generated video thumbnail"]')?.getAttribute('src') || '';
      const status = tile.cloneNode(true);
      status.querySelectorAll('flow-tile-hover-footer, .footer-title').forEach(element => element.remove());
      const pending = !src && !thumbnail && !/failed|error|rejected/i.test(status.textContent || '');
      return { index, src, text, label, thumbnail, pending, mediaId: tile.getAttribute('data-media-id') || tile.getAttribute('data-asset-id') || tile.id || '', statusText: status.textContent || '' };
    });
  }, {
    tileSelector: FLOW_SELECTORS.videoTile,
    mediaSelector: FLOW_SELECTORS.videoTileMedia
  }).catch(() => []);
}

export async function listExistingVideoSources(page) {
  const tiles = await readVideoTiles(page);
  return tiles.map((tile) => tile.src).filter(Boolean);
}

function tileProgressPercent(tile) {
  const match = tile.text.match(/(\d{1,3})\s*%/);
  return match ? Number(match[1]) : null;
}

// Only a new <flow-video-tile> whose <video> has a real source and no progress % counts as done.
// Uploaded reference images render as <flow-image-tile> and are never considered.
export async function waitForGeneration(page, existingVideoSources = [], onProgress = () => {}) {
  const startedAt = Date.now();
  const knownSources = new Set(existingVideoSources);
  let candidateSrc = null;
  let lastProgress = null;
  let sawNewTile = false;

  while (Date.now() - startedAt < config.generationTimeoutMs) {
    await ensureLoggedIn(page);

    const failure = await detectGenerationFailure(page);
    if (failure) {
      throw failure;
    }

    const tiles = await readVideoTiles(page);
    const newTiles = tiles.filter((tile) => !tile.src || !knownSources.has(tile.src));

    if (newTiles.length > 0 && !sawNewTile) {
      sawNewTile = true;
      logger.info('New Flow video tile detected', { tile: newTiles[0].text.slice(0, 120) });
    }

    const inProgress = newTiles.find((tile) => !tile.src || tileProgressPercent(tile) !== null);
    if (inProgress) {
      const progress = tileProgressPercent(inProgress);
      if (progress !== null && progress !== lastProgress) {
        lastProgress = progress;
        onProgress(progress);
      }
    }

    const finished = newTiles.find((tile) => /^https?:/i.test(tile.src) && tileProgressPercent(tile) === null);
    if (finished) {
      // Require the same source on two consecutive polls so a briefly-rendered preview is not taken as final.
      if (candidateSrc === finished.src) {
        logger.info('Flow generated video is ready', { elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) });
        return { videoSrc: finished.src };
      }
      candidateSrc = finished.src;
    } else {
      candidateSrc = null;
    }

    await sleep(config.pollIntervalMs);
  }

  throw new FlowAutomationError(
    'GENERATION_TIMEOUT',
    `Timed out after ${Math.round(config.generationTimeoutMs / 1000)}s waiting for Google Flow to finish the video.`
  );
}

async function dismissTransientToasts(page) {
  const dismissButton = await firstVisible(page, [
    'button:has-text("Dismiss")',
    '[role="button"]:has-text("Dismiss")'
  ], 700);

  if (dismissButton) {
    await dismissButton.click({ timeout: 2000 }).catch(() => {});
  }
}

async function openGeneratedVideoTile(page, videoSrc, savedTarget = null) {
  await dismissTransientToasts(page);

  const tiles = await readVideoTiles(page);
  const target = tiles.find((tile) => (savedTarget?.thumbnail && tile.thumbnail === savedTarget.thumbnail)
    || (videoSrc && tile.src === videoSrc));
  if (!target) {
    throw new FlowAutomationError(
      'DOWNLOAD_FAILED',
      'Could not find the generated video tile in the Flow project grid.'
    );
  }

  await page.locator(FLOW_SELECTORS.videoTile).nth(target.index).click({ timeout: 5000 });
  await sleep(1500);
}

async function downloadViaFlowUi(page, videoSrc, target = null) {
  await openGeneratedVideoTile(page, videoSrc, target);

  const downloadButton = await firstVisible(page, FLOW_SELECTORS.downloadButtonCandidates, 10000);
  if (!downloadButton) {
    throw new FlowAutomationError(
      'DOWNLOAD_FAILED',
      'Opened the generated video, but could not find the Google Flow download button. Update FLOW_SELECTORS in src/flow.js.'
    );
  }

  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  downloadPromise.catch(() => {}); // A click failure must not leave a later unhandled rejection.
  await downloadButton.click({ timeout: 5000 }).catch(async () => {
    await downloadButton.click({ force: true, timeout: 5000 });
  });

  const firstDownloadStep = await Promise.race([
    downloadPromise.then((download) => ({ type: 'download', download })),
    firstVisible(page, FLOW_SELECTORS.downloadQualityCandidates, 5000)
      .then((downloadQuality) => ({ type: 'quality', downloadQuality }))
  ]);

  let download = firstDownloadStep.type === 'download' ? firstDownloadStep.download : null;
  if (firstDownloadStep.downloadQuality) {
    await firstDownloadStep.downloadQuality.click({ timeout: 5000 }).catch(async () => {
      await firstDownloadStep.downloadQuality.click({ force: true, timeout: 5000 });
    });
  }

  if (!download) {
    download = await downloadPromise;
  }

  const downloadFailure = await download.failure();
  if (downloadFailure) {
    throw new FlowAutomationError('DOWNLOAD_FAILED', `Google Flow download failed: ${downloadFailure}`);
  }

  return download;
}

export async function downloadGeneratedVideo(page, outputPath, videoSrc, logLabel = 'Flow', target = null) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  try {
    const download = await downloadViaFlowUi(page, videoSrc, target);
    const tempPath = await download.path();

    if (tempPath && await isMp4File(tempPath)) {
      await download.saveAs(outputPath);
      await download.delete().catch(() => {});
      logger.info(`${logLabel}: saved generated video`, { outputPath, source: 'flow-download' });
      return { videoPath: outputPath };
    }

    await download.delete().catch(() => {});
    logger.warn(`${logLabel}: Flow download was not an MP4 video; falling back to the video source URL`, {
      suggestedFilename: download.suggestedFilename()
    });
  } catch (error) {
    logger.warn(`${logLabel}: Flow UI download failed; falling back to the video source URL`, { error: error.message });
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
  }

  // Fallback: fetch the tile's <video> source with the logged-in browser session.
  if (!/^https?:/i.test(videoSrc || '')) {
    throw new FlowAutomationError('DOWNLOAD_FAILED', 'The existing Flow video could not be downloaded. Its checkpoint is saved; resume to retry downloading without generating again.');
  }
  const response = await page.context().request.get(videoSrc, { timeout: 120000 }).catch((error) => {
    throw new FlowAutomationError('DOWNLOAD_FAILED', `Could not fetch the generated video: ${error.message}`, error);
  });
  if (!response.ok()) {
    throw new FlowAutomationError('DOWNLOAD_FAILED', `Fetching the generated video returned HTTP ${response.status()}.`);
  }

  const body = await response.body();
  if (!isMp4Buffer(body)) {
    throw new FlowAutomationError(
      'DOWNLOAD_FAILED',
      `The downloaded file is not an MP4 video (content-type: ${response.headers()['content-type'] || 'unknown'}).`
    );
  }

  await fs.writeFile(outputPath, body);
  logger.info(`${logLabel}: saved generated video`, { outputPath, source: 'video-src' });
  return { videoPath: outputPath };
}

export async function waitForSceneResult(page, checkpoint, prompt, onStatus, rememberTarget, recovering, productionDeadline) {
  const startedAt = Date.now();
  let readyKey = null;
  let progress = null;
  let confirmed = false;
  const missing = new MissingSceneTracker();
  const rejectedCandidates = [];
  while (Date.now() - startedAt < config.generationTimeoutMs) {
    await ensureLoggedIn(page);
    const expired = productionWindowError(productionDeadline);
    if (expired) throw expired;
    const tiles = await readVideoTiles(page);
    let selected = null;
    let ambiguous = false;
    try { selected = selectRecoveryTile(tiles, checkpoint, rejectedCandidates); }
    catch (error) {
      if (error.code !== 'FLOW_RESULT_AMBIGUOUS') throw error;
      ambiguous = true;
      const candidate = recoveryCandidates(tiles, checkpoint, rejectedCandidates)
        .find(tile => (tile.src || tile.thumbnail) && tileProgressPercent(tile) === null);
      if (candidate) selected = { tile: candidate, exact: false };
    }
    if (!selected) {
      if (!recovering && !checkpoint.target) {
        const rejection = await detectGenerationFailure(page);
        if (rejection && (canRotateAccount(rejection.code) || rejection.code === 'GENERATION_REJECTED')) {
          // A visible rejection on this fresh submission, with no accepted tile,
          // permits the normal account-limit rotation. Recovery never assumes this.
          throw Object.assign(rejection, { confirmedSceneFailure: true });
        }
      }
      if (recovering || ambiguous) {
        const composerReady = Boolean(await firstVisible(page, FLOW_SELECTORS.promptInputCandidates, 200));
        const challenge = await page.locator('iframe[src*="challenges.cloudflare.com"]:visible, iframe[src*="recaptcha"]:visible, #challenge-form:visible').count().catch(()=>0);
        const blocked = Boolean(challenge) || tiles.some(tile=>/unusual activity/i.test((tile.statusText||'')+' '+(tile.text||'')));
        if (missing.observe({ projectUrl: page.url(), expectedProjectUrl: checkpoint.projectUrl, composerReady, blocked, tiles })) {
          throw Object.assign(recoveryError('The saved scene is still unavailable after repeated checks. A fresh replacement will be generated after the retry delay.', 'SCENE_RESULT_MISSING'), {confirmedMissingScene:true, replacementReason: ambiguous ? 'Multiple different results remained unidentifiable after repeated checks' : 'Result unavailable after repeated checks'});
        }
      }
      if (Date.now() - startedAt > (recovering ? 90000 : GENERATION_START_TIMEOUT_MS)) {
        if(!recovering) throw new FlowAutomationError('GENERATION_TIMEOUT','Flow has not shown the submitted result. The next attempt will check it again before replacing it.');
        throw recoveryError('The original project is not ready to verify this scene. Restore access before resuming; other videos can continue.');
      }
      await sleep(2000);
      continue;
    }
    const tile = selected.tile;
    const failure = flowTileFailure(tile);
    if (failure) throw failure;
    const percent = tileProgressPercent(tile);
    const ready = Boolean(tile.src || tile.thumbnail) && percent === null;
    let verified = Boolean(selected.exact && checkpoint.target?.verified);
    if (ready && !verified) {
      // Verify every unidentified ready result, including fresh submissions and
      // each ambiguous candidate, before saving it as this scene's result.
      const locator = page.locator(FLOW_SELECTORS.videoTile).nth(tile.index);
      await locator.hover();
      await locator.getByRole('button', { name: 'Reuse prompt', exact: true }).click({ timeout: 5000 });
      await sleep(750);
      verified = await readPromptInputText(page) === normalizeText(prompt);
      if (!verified) {
        rejectedCandidates.push(tile);
        readyKey = null;
        onStatus('recovering', 'Ignoring a video with a different prompt. Checking for the correct scene before generating a replacement.');
        continue;
      }
    }
    if (!confirmed && (percent !== null || (ready && verified))) {
      confirmed = true;
      logger.info('Flow scene confirmed by video result', { accountId: checkpoint.accountId, evidence: percent !== null ? 'progress' : 'verified-result', recovering });
      onStatus('generating', recovering ? 'Existing Flow scene confirmed; checking its result.' : 'Flow confirmed the scene through video progress or a matching result.');
    }
    missing.reset();
    if (!checkpoint.target || checkpoint.target.src !== tile.src || checkpoint.target.thumbnail !== tile.thumbnail || checkpoint.target.verified !== verified) {
      const target = { src: tile.src, thumbnail: tile.thumbnail, mediaId: tile.mediaId, text: tile.text, verified };
      await rememberTarget(target);
      checkpoint.target = target;
    }
    if (percent !== null && percent !== progress) {
      progress = percent;
      onStatus('generating', `Waiting for the existing Flow generation (${percent}%).`, { progress: percent });
    }
    if (ready) {
      const key = tile.thumbnail || tile.src;
      if (key === readyKey) return { ...checkpoint.target, src: tile.src, thumbnail: tile.thumbnail };
      readyKey = key;
    } else readyKey = null;
    await sleep(config.pollIntervalMs);
  }
  throw new FlowAutomationError('GENERATION_TIMEOUT', 'The existing generation is still unfinished. Resume this scene to check it again without regenerating.');
}

// The checkpoint separates submission, rendering and downloading across retries/restarts.
async function runFlowSceneAttempt(options, accountId) {
  const {
    prompt,
    referenceImage,
    aspectRatio,
    model,
    duration,
    outputPath,
    logLabel,
    screenshotPrefix,
    onStatus, productionDeadline
  } = options;
  let page = null;
  const startedAt = Date.now();
  const networkFailures = [];
  const submissionResponses = [];
  let generateClickAttempted = false;
  const recordResponse = (response) => {
    if (!['xhr', 'fetch'].includes(response.request().resourceType())) return;
    const url = new URL(response.url());
    if (generateClickAttempted && ['POST', 'PUT', 'PATCH'].includes(response.request().method())) {
      const outcome = { method: response.request().method(), status: response.status(), endpoint: url.origin + url.pathname };
      submissionResponses.push(outcome);
      if (submissionResponses.length > 30) submissionResponses.shift();
      logger.info('Flow network response during submission attempt', outcome);
    }
    if (response.status() < 400) return;
    networkFailures.push({ status: response.status(), endpoint: `${url.origin}${url.pathname}` });
    if (networkFailures.length > 30) networkFailures.shift();
  };
  const recordRequestFailure = (request) => {
    if (!['xhr', 'fetch'].includes(request.resourceType())) return;
    const url = new URL(request.url());
    networkFailures.push({ error: request.failure()?.errorText, endpoint: `${url.origin}${url.pathname}` });
    if (networkFailures.length > 30) networkFailures.shift();
  };

  try {
    onStatus('opening_flow', `Opening Chrome and Google Flow (${accountId}).`, { accountId });
    page = await getFlowPageForAccount(accountId);
    page.on('response', recordResponse);
    page.on('requestfailed', recordRequestFailure);
    let recovering = false;
    return await recoverableScene({ outputPath, fingerprint: options.fingerprint, accountId }, {
      validate: validateVideo,
      status: onStatus,
      projectUrl: () => page.url(),
      open: async checkpoint => {
        recovering = Boolean(checkpoint);
        if (checkpoint) {
          // Recovery must return to the original project, even if .env now points elsewhere.
          await page.goto(checkpoint.projectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForSelector(FLOW_SELECTORS.videoTile, { timeout: 20000 }).catch(() => {});
        } else if (!referenceSession.canReuseProject(page)) {
          await openFlow(page, await savedFlowProjectUrl(accountId));
          await openProject(page);
        }
        await ensureLoggedIn(page);
        await page.keyboard.press('Escape');
      },
      prepare: async () => {
        await prepareGeneration(page);
        referenceSession.rememberProject(page);
        await rememberFlowProject(accountId, page.url());
        const failure = await detectGenerationFailure(page);
        if (failure && canRotateAccount(failure.code)) throw failure;
        onStatus('submitting', 'Preparing this scene in Google Flow.');
        await configureGenerationSettings(page, { model, aspectRatio, duration });
        await fillPrompt(page, prompt);
        if (referenceImage) {
          onStatus('uploading_reference', 'Checking the saved storyboard in Flow; uploading only if missing.');
          const action = await ensureReferenceImage(page, referenceImage);
          logger.info(`${logLabel}: storyboard ${action}`, { accountId });
        } else await clearReferenceAttachments(page);
      },
      baseline: () => readVideoTiles(page),
      submit: async () => {
        const expired = productionWindowError(productionDeadline);
        if (expired) throw expired;
        onStatus('submitting', 'Submitting the scene once; progress is saved before clicking Generate.');
        generateClickAttempted = true;
        await startGeneration(page);
        const screenshotPath = await saveScreenshot(page, screenshotPrefix(), 'after-submit', logLabel);
        onStatus('submitting', 'Generate was clicked. Waiting for Flow to confirm video generation.', { screenshotPath });
      },
      wait: (checkpoint, rememberTarget) => waitForSceneResult(page, checkpoint, prompt, onStatus, rememberTarget, recovering, productionDeadline),
      download: (partialPath, target) => downloadGeneratedVideo(page, partialPath, target.src, logLabel, target)
    });
  } catch (error) {
    const errorPrefix = screenshotPrefix();
    const screenshotPath = await saveScreenshot(page, errorPrefix, 'error', logLabel);
    const code = publicError(error);
    if (page && !page.isClosed()) {
      const controls = await page.locator('button:visible').evaluateAll(buttons => buttons.map(button => ({
        label: button.getAttribute('aria-label'), text: (button.textContent || '').trim().slice(0, 100),
        disabled: button.disabled || button.getAttribute('aria-disabled') === 'true'
      }))).catch(() => []);
      await fs.writeFile(path.join(config.screenshotDir, `${errorPrefix}_diagnostics.json`), JSON.stringify({
        accountId, code, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        generateClickAttempted, submissionResponses, networkFailures, controls
      }, null, 2)).catch(() => {});
    }

    logger.error(`${logLabel}: Flow attempt failed`, {
      code,
      message: error.message,
      stack: error.stack,
      screenshotPath
    });

    if (code === 'INSUFFICIENT_CREDITS') {
      setAccountStatus(accountId, 'out_of_credits', error.message);
    }

    if (code === 'FLOW_DAILY_LIMIT_REACHED') {
      setAccountStatus(accountId, 'daily_limit_reached', error.message);
    }

    if (code === 'GOOGLE_LOGIN_REQUIRED') {
      setAccountStatus(accountId, 'login_required', error.message);
    }

    throw Object.assign(error, {
      automationCode: code,
      screenshotPath
    });
  } finally {
    page?.off('response', recordResponse);
    page?.off('requestfailed', recordRequestFailure);
  }
}

export const INFRASTRUCTURE_ERROR_CODES = ['NETWORK_ERROR', 'BROWSER_CLOSED'];

export function automationErrorCode(error) {
  return error?.automationCode || publicError(error);
}

/**
 * Generate one Flow clip and save it to outputPath. Reused by single jobs and multi-scene projects.
 *
 * Handles account rotation (daily limit / login) and waits out errors listed in retryableCodes
 * (by default only network/browser problems). Any other failure is thrown with automationCode
 * and screenshotPath attached so the caller can decide whether to retry.
 */
const activeScenes = new Set();
export async function generateFlowScene(options) {
  const key = path.resolve(options.outputPath);
  if (activeScenes.has(key)) throw recoveryError('This scene is already running.', 'SCENE_BUSY');
  activeScenes.add(key);
  try { return await generateFlowSceneUnlocked(options); }
  finally { activeScenes.delete(key); }
}

async function generateFlowSceneUnlocked({
  prompt,
  referenceImage = null,
  aspectRatio = config.defaultAspectRatio,
  model = config.defaultModel,
  duration = config.defaultDuration,
  outputPath,
  logLabel = 'Flow',
  screenshotPrefix = () => `flow_${safeTimestamp()}`,
  onStatus = () => {},
  retryableCodes = INFRASTRUCTURE_ERROR_CODES,
  maxRetries = config.maxGenerationRetries,
  productionDeadline = null
}) {
  const options = {
    prompt,
    referenceImage,
    aspectRatio,
    model,
    duration,
    outputPath,
    logLabel,
    screenshotPrefix: typeof screenshotPrefix === 'function' ? screenshotPrefix : () => screenshotPrefix,
    onStatus, productionDeadline
  };
  options.fingerprint = sceneFingerprint(options, referenceImage ? (await referenceAsset(referenceImage)).name : null);
  const saved = await sceneCheckpoints.read(outputPath);
  if (saved && saved.fingerprint !== options.fingerprint) {
    throw recoveryError('The saved scene has different inputs. Resume its original inputs or create a new project.', 'SCENE_INPUTS_CHANGED');
  }
  try {
    await validateVideo(outputPath);
    onStatus('validating', 'Reusing the scene already downloaded and validated.');
    return { videoPath: outputPath, accountId: saved?.accountId || 'default', recovered: true };
  } catch (error) {
    if (error.code !== 'VIDEO_INVALID') throw error;
  }
  const attemptedAccountIds = new Set();
  let lastError = null;

  while (true) {
    const checkpoint = await sceneCheckpoints.read(outputPath);
    const accountId = needsRecovery(checkpoint) ? checkpoint.accountId : getAvailableAccountId(attemptedAccountIds);
    if (attemptedAccountIds.has(accountId)) throw recoveryError('The original scene account is unavailable. Resume after restoring access; no replacement video was generated.');
    if (!accountId) {
      break;
    }
    attemptedAccountIds.add(accountId);

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      try {
        const result = await runFlowSceneAttempt(options, accountId);
        markAccountAvailable(accountId, 'Last generation completed successfully.');
        return result;
      } catch (error) {
        lastError = error;
        const code = automationErrorCode(error);

        if (retryableCodes.includes(code) && attempt <= maxRetries) {
          await closeBrowser().catch(() => {});
          onStatus('retrying', retryMessage(code, attempt, accountId, maxRetries), {
            error: code,
            screenshotPath: error.screenshotPath
          });
          await sleep(config.generationRetryDelayMs);
          continue;
        }

        if (!canRotateAccount(code)) {
          throw error;
        }
        if (needsRecovery(await sceneCheckpoints.read(outputPath))) {
          throw recoveryError(`The scene may already exist on ${accountId}. Restore access to that account and resume downloading instead of generating on another account.`);
        }

        await closeBrowser().catch(() => {});
        onStatus('retrying', `${accountId} returned ${code}. Trying the next available Flow account.`, { error: code });
        break;
      }
    }
  }

  const lastCode = lastError ? automationErrorCode(lastError) : null;
  throw Object.assign(
    new FlowAutomationError(
      'NO_AVAILABLE_FLOW_ACCOUNT',
      lastCode
        ? `No available Flow account remains after ${lastCode}: ${lastError.message}`
        : 'No configured Flow account is currently available.'
    ),
    {
      automationCode: 'NO_AVAILABLE_FLOW_ACCOUNT',
      screenshotPath: lastError?.screenshotPath || null
    }
  );
}

// Single-prompt job (POST /api/videos/generate). Kept for backwards compatibility.
export async function generateVideo(job) {
  const { filename, fullPath } = videoPathForJob(job.id);

  try {
    const { accountId } = await generateFlowScene({
      prompt: job.prompt,
      referenceImage: job.referenceImage,
      aspectRatio: job.aspectRatio,
      model: job.model,
      outputPath: fullPath,
      logLabel: `Job ${job.id}`,
      screenshotPrefix: () => `${job.id}_${safeTimestamp()}`,
      onStatus: (status, message, extra = {}) => updateJob(job.id, status, { message, ...extra }),
      retryableCodes: [...INFRASTRUCTURE_ERROR_CODES, ...GENERATION_RETRY_CODES]
    });

    await finishFlowGeneration().catch(error => logger.warn('Could not close the completed Flow tab', { message: error.message }));
    updateJob(job.id, 'completed', {
      accountId,
      message: 'Video generation completed.',
      videoPath: fullPath,
      videoUrl: buildVideoUrl(filename)
    });
  } catch (error) {
    await closeBrowser().catch(() => {});
    updateJob(job.id, 'failed', {
      message: error.message || 'Video generation failed.',
      error: automationErrorCode(error),
      screenshotPath: error.screenshotPath || null
    });
  }
}
