import { timingSafeEqual } from 'node:crypto';
import { enqueueFlowWork } from '../src/flow-lane.js';
import { checkCloudGoogleSession, checkCloudServices } from '../services/cloud-readiness.service.js';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { listAccountStatuses, markAccountAvailable, setAccountStatus } from '../src/accounts.js';
import { closeBrowser } from '../src/browser.js';
import { openChromeLogin } from '../src/chrome-login.js';
import { config } from '../src/config.js';
import { hasActiveGeneration } from '../src/jobs.js';
import {
  generateProjectController,
  generateVideoController,
  getJobController,
  listJobsController,
  retryPublishingController,
  resumeJobController,
  splitScriptController,
  systemCheckController
} from '../controllers/video.controller.js';

const router = express.Router();

const storage = multer.diskStorage({
  destination: config.uploadDir,
  filename(req, file, callback) {
    const extension = path.extname(file.originalname) || '.png';
    callback(null, `reference_${Date.now()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

function privateCloudSetup(req, res, next) {
  const expected = process.env.CLOUD_SETUP_TOKEN || '';
  const provided = String(req.get('authorization') || '').replace(/^Bearer /, '');
  const left = Buffer.from(expected); const right = Buffer.from(provided);
  if (!expected || left.length !== right.length || !timingSafeEqual(left, right)) return res.status(403).json({ success: false, message: 'Private cloud setup check.' });
  next();
}

router.post('/cloud/check-services', privateCloudSetup, async (req, res) => {
  const result = await checkCloudServices();
  res.json({ success: result.buffer && result.cloudinary, ...result });
});

router.post('/cloud/check-google', privateCloudSetup, async (req, res) => {
  if (hasActiveGeneration()) return res.status(409).json({ success: false, message: 'Wait for the current video job to finish.' });
  const result = await enqueueFlowWork(checkCloudGoogleSession);
  return res.json({ success: result.ready, ...result });
});

router.post('/generate', upload.single('referenceImage'), generateVideoController);
router.post('/generate-project', upload.single('referenceImage'), generateProjectController);
router.post('/split-script', splitScriptController);
router.get('/system-check', systemCheckController);
router.get('/accounts', (req, res) => {
  res.json({
    success: true,
    activeAccount: config.flowAccount || null,
    accounts: listAccountStatuses()
  });
});
router.post('/accounts/login', async (req, res) => {
  const accountId = String(req.body?.accountId || '').trim();
  if (!accountId) {
    return res.status(400).json({
      success: false,
      error: 'ACCOUNT_ID_REQUIRED',
      message: 'accountId is required.'
    });
  }

  // Opening a login window closes the automation browser, which would break a running job.
  if (hasActiveGeneration()) {
    return res.status(409).json({
      success: false,
      error: 'GENERATION_RUNNING',
      message: 'A video job is running. Wait for it to finish before opening a login window.'
    });
  }

  try {
    await closeBrowser().catch(() => {});
    const result = openChromeLogin(accountId);
    return res.json({
      success: true,
      message: `Chrome opened for ${accountId}. Sign in manually, confirm Flow works, then close Chrome.`,
      accountId: result.accountId,
      profileDir: result.profileDir
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'OPEN_CHROME_FAILED',
      message: error.message
    });
  }
});
router.post('/accounts/:accountId/simulate-limit', (req, res) => {
  const accountId = String(req.params.accountId || '').trim();
  const status = setAccountStatus(
    accountId,
    'daily_limit_reached',
    'Simulated daily limit for rotation testing.'
  );

  res.json({
    success: true,
    activeAccount: config.flowAccount || null,
    account: status,
    accounts: listAccountStatuses()
  });
});
router.post('/accounts/:accountId/reset', (req, res) => {
  const accountId = String(req.params.accountId || '').trim();
  const status = markAccountAvailable(accountId, 'Account manually reset.');

  res.json({
    success: true,
    activeAccount: config.flowAccount || null,
    account: status,
    accounts: listAccountStatuses()
  });
});
router.get('/jobs', listJobsController);
router.get('/jobs/:jobId', getJobController);
router.post('/jobs/:jobId/publish', retryPublishingController);
router.post('/jobs/:jobId/resume', resumeJobController);

export default router;
