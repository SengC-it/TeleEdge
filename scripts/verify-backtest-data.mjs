import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const generatedManifestFile = path.join(APP_DIR, 'data', 'backtest', 'manifest.json');
const manifestFile = fs.existsSync(generatedManifestFile)
  ? generatedManifestFile
  : path.join(APP_DIR, 'data', 'backtest-manifest.json');
if (!fs.existsSync(manifestFile)) {
  console.error('M4 data manifest is absent; run npm run backtest:fetch first.');
  process.exitCode = 1;
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const missing = [];
  const mismatched = [];
  for (const artifact of manifest.artifacts ?? []) {
    const file = path.join(APP_DIR, artifact.path);
    if (!fs.existsSync(file)) {
      missing.push(artifact.path);
      continue;
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (hash !== artifact.sha256) mismatched.push({path: artifact.path, expected: artifact.sha256, actual: hash});
  }
  const complete = manifest.status === 'COMPLETE'
    && manifest.universe?.pointInTime === true
    && manifest.universe?.historicalDelistingsResolved === true
    && !missing.length && !mismatched.length;
  console.log(JSON.stringify({status: manifest.status, complete, snapshotTimestamp: manifest.snapshotTimestamp, artifacts: manifest.artifacts?.length ?? 0, missing, mismatched}, null, 2));
  if (process.argv.includes('--strict') && !complete) process.exitCode = 1;
}
