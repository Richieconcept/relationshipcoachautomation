import fs from 'node:fs/promises';
import { logger } from './logger.js';

// Container memory includes Chromium and other child processes, unlike process.memoryUsage().
export async function logMemory(stage) {
  const nodeRssBytes = process.memoryUsage().rss;
  let containerBytes = null;
  for (const file of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
    try {
      const value = Number((await fs.readFile(file, 'utf8')).trim());
      if (Number.isFinite(value)) { containerBytes = value; break; }
    } catch { /* cgroup memory accounting is not available on every host */ }
  }
  logger.info('Memory sample', { stage, nodeRssBytes, containerBytes });
}

export function startMemoryMonitor(stage, intervalMs = 5000) {
  let running = false;
  const sample = async () => {
    if (running) return;
    running = true;
    try { await logMemory(stage); } catch { /* diagnostics must not disrupt a job */ }
    finally { running = false; }
  };
  void sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
