import { startPublicationMonitor } from '../services/publication-monitor.service.js';
import { closeChatgptBrowser } from '../services/chatgpt-browser.service.js';
import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import { ensureRuntimeFolders } from './downloads.js';
import { logger } from './logger.js';
import brandRoutes from '../routes/brand.routes.js';
import bufferRoutes from '../routes/buffer.routes.js';
import videoRoutes from '../routes/video.routes.js';
import { contentRoutes } from '../routes/content.routes.js';
import { logFfmpegStatus } from '../services/ffmpeg.service.js';
import { getBrandDefaults } from '../services/brand-defaults.service.js';
import {restorePublishingChannels} from '../services/publishing-connection.service.js';

await ensureRuntimeFolders();
await getBrandDefaults();

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/downloads/projects', express.static(config.projectDownloadDir));
app.use('/downloads', express.static(path.resolve(config.rootDir, 'downloads')));
app.use('/brand', express.static(config.brandDir));
app.use(express.static(path.resolve(config.rootDir, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/videos', videoRoutes);
app.use('/api/buffer', bufferRoutes);
app.use('/api/brand', brandRoutes);
const content = contentRoutes();
restorePublishingChannels(content.scheduler.store.state.settings);
app.use('/api/content', content.router);

app.use((err, req, res, next) => {
  logger.error('Unhandled API error', { message: err.message, stack: err.stack });
  res.status(500).json({
    success: false,
    error: 'INTERNAL_SERVER_ERROR',
    message: 'Unexpected server error.'
  });
});

let stopPublicationMonitor;
const server = app.listen(config.port, () => {
  logger.info(`Server listening on http://localhost:${config.port}`);
  logFfmpegStatus().catch((error) => logger.warn('FFmpeg check failed', { error: error.message }));
  content.scheduler.start();
  stopPublicationMonitor = startPublicationMonitor();
});


// Close the owned Chrome context on normal server shutdown so session data is flushed.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Server shutting down', { signal });
  content.scheduler.stop();
  stopPublicationMonitor?.();
  server.close();
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  try { await closeChatgptBrowser({ shutdown: true }); }
  catch (error) { logger.warn('ChatGPT browser shutdown failed', { error: error.message }); }
  clearTimeout(deadline);
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
