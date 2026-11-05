import express from 'express';
import { channelIdFor, listChannels, SUPPORTED_PLATFORMS } from '../services/buffer.service.js';
import { logger } from '../src/logger.js';

const router = express.Router();

const ERROR_STATUS = {
  BUFFER_CONFIG_MISSING: 400,
  BUFFER_AUTH_FAILED: 401,
  BUFFER_RATE_LIMITED: 429
};

// Developer helper: lists connected Buffer channels so you can copy their IDs into .env. Never returns the API key.
router.get('/channels', async (req, res) => {
  try {
    const channels = await listChannels({ refresh: req.query.refresh === '1' });
    const configured = Object.fromEntries(SUPPORTED_PLATFORMS.map((platform) => {
      const id = channelIdFor(platform);
      const match = channels.find((channel) => channel.id === id);
      return [platform, {
        channelIdSet: Boolean(id),
        found: Boolean(match),
        platformMatches: match ? match.platform === platform : false,
        name: match?.name || null
      }];
    }));

    res.json({ success: true, channels, configured });
  } catch (error) {
    logger.warn('Could not list Buffer channels', { code: error.code, message: error.message });
    res.status(ERROR_STATUS[error.code] || 502).json({
      success: false,
      error: error.code || 'BUFFER_REQUEST_FAILED',
      message: error.message
    });
  }
});

export default router;
