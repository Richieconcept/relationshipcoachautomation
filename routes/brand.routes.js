import express from 'express';
import fs from 'node:fs/promises';
import multer from 'multer';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrandError, brandStatus, deleteBrandAsset, saveBrandAsset } from '../services/brand.service.js';
import { getBrandDefaults, saveBrandDefaults } from '../services/brand-defaults.service.js';

const router = express.Router();

router.get('/defaults', async (req, res) => {
  try { res.json({ success: true, defaults: await getBrandDefaults() }); }
  catch (error) { res.status(500).json({ success: false, message: error.message }); }
});
router.put('/defaults', async (req, res) => {
  try { res.json({ success: true, defaults: await saveBrandDefaults(req.body) }); }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

// Uploads land in the uploads folder first, then move into brand/<kind>.<ext>.
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename(req, file, callback) {
      callback(null, `brand_${Date.now()}${path.extname(file.originalname)}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

function sendError(res, error) {
  if (error instanceof BrandError) {
    return res.status(400).json({ success: false, error: error.code, message: error.message });
  }
  return res.status(500).json({ success: false, error: 'BRAND_SAVE_FAILED', message: error.message });
}

router.get('/', async (req, res) => {
  res.json({ success: true, assets: await brandStatus() });
});

router.post('/:kind', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'FILE_REQUIRED', message: 'Choose a file to upload.' });
  }
  try {
    await saveBrandAsset(req.params.kind, req.file.path, req.file.originalname);
    return res.json({ success: true, assets: await brandStatus() });
  } catch (error) {
    await fs.rm(req.file.path, { force: true });
    return sendError(res, error);
  }
});

router.delete('/:kind', async (req, res) => {
  try {
    await deleteBrandAsset(req.params.kind);
    return res.json({ success: true, assets: await brandStatus() });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
