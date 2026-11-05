import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.logFile), { recursive: true });

function timestamp() {
  return new Date().toTimeString().slice(0, 8);
}

function write(level, message, meta) {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  const line = `[${timestamp()}] ${level.toUpperCase()} ${message}${suffix}`;

  console.log(line);
  fs.appendFileSync(config.logFile, `${line}\n`);
}

export const logger = {
  info(message, meta) {
    write('info', message, meta);
  },
  warn(message, meta) {
    write('warn', message, meta);
  },
  error(message, meta) {
    write('error', message, meta);
  }
};

