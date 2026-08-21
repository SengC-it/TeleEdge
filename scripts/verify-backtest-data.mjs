import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {continuityIssues} from './backtest-data.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function readGzipJson(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim();
  return text ? JSON.parse(text) : [];
}

function artifactInterval(artifact) {
  return artifact.interval
    ?? (artifact.kind === 'price' ? '1h' : artifact.kind === 'minute' ? '1m' : null);
}

export function verifyBacktestManifest(manifest, rootDir = APP_DIR) {
  const missing = [];
  const mismatched = [];
  const continuity = [];
  for (const artifact of manifest.artifacts ?? []) {
    const file = path.join(rootDir, artifact.path);
    if (!fs.existsSync(file)) {
      missing.push(artifact.path);
      continue;
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (artifact.sha256 && hash !== artifact.sha256) mismatched.push({path: artifact.path, expected: artifact.sha256, actual: hash});
    const interval = artifactInterval(artifact);
    if (!interval) continue;
    try {
      const rows = readGzipJson(file);
      const issues = continuityIssues(rows, interval);
      if (issues.length) continuity.push({path: artifact.path, interval, issueCount: issues.length, firstIssues: issues.slice(0, 3)});
    } catch (error) {
      continuity.push({path: artifact.path, interval, issueCount: 1, firstIssues: [{reason: 'artifact-read-error', message: error.message}]});
    }
  }
  const complete = manifest.status === 'COMPLETE'
    && manifest.universe?.pointInTime === true
    && manifest.universe?.historicalDelistingsResolved === true
    && manifest.execution?.preferredInterval === '1m'
    && manifest.execution?.oneMinuteAvailable === true
    && !missing.length && !mismatched.length && !continuity.length;
  return {
    status: manifest.status,
    complete,
    snapshotTimestamp: manifest.snapshotTimestamp,
    execution: manifest.execution ?? null,
    artifacts: manifest.artifacts?.length ?? 0,
    missing,
    mismatched,
    continuity,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const generatedManifestFile = path.join(APP_DIR, 'data', 'backtest', 'manifest.json');
  const manifestFile = fs.existsSync(generatedManifestFile)
    ? generatedManifestFile
    : path.join(APP_DIR, 'data', 'backtest-manifest.json');
  if (!fs.existsSync(manifestFile)) {
    console.error('M4 data manifest is absent; run npm run backtest:fetch first.');
    process.exitCode = 1;
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const result = verifyBacktestManifest(manifest, APP_DIR);
    console.log(JSON.stringify(result, null, 2));
    if (process.argv.includes('--strict') && !result.complete) process.exitCode = 1;
  }
}
