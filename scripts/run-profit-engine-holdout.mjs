import fs from 'node:fs';
import path from 'node:path';
import {APP_DIR} from '../src/config.mjs';

const lockFile = path.join(APP_DIR, 'reports', 'profit-engine-holdout-lock.json');
const authorized = process.argv.includes('--holdout-authorized');
const lock = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : null;
if (!authorized || lock?.status !== 'HOLDOUT_NOT_RUN') {
  throw new Error('Holdout refused: requires --holdout-authorized and a Development lock with HOLDOUT_NOT_RUN');
}
throw new Error('Holdout runner is intentionally not enabled in this Development task; obtain separate human release authorization.');
