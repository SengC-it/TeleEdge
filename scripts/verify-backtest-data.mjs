import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {continuityIssues, intervalToMs, timestampValue} from './backtest-data.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function readGzipJson(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim();
  return text ? JSON.parse(text) : [];
}

function readArtifactRows(file, artifact) {
  if (['price', 'minute', 'funding'].includes(artifact.kind)) return readGzipJson(file);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (artifact.kind === 'universe') return parsed.symbols || [];
  if (artifact.kind === 'snapshot') return [parsed];
  return Array.isArray(parsed) ? parsed : [];
}

function artifactInterval(artifact) {
  return artifact.interval && artifact.interval !== 'event'
    ? artifact.interval
    : artifact.kind === 'price' ? '1h' : artifact.kind === 'minute' ? '1m' : null;
}

function coverageIssues(rows, artifact) {
  const issues = [];
  const activeStart = timestampValue(artifact.activeStart);
  const activeEnd = timestampValue(artifact.activeEnd);
  if (!Number.isFinite(activeStart) || !Number.isFinite(activeEnd) || !(activeEnd > activeStart)) {
    issues.push({reason: 'invalid-active-window', activeStart: artifact.activeStart ?? null, activeEnd: artifact.activeEnd ?? null});
    return issues;
  }
  if (!Array.isArray(rows) || !rows.length) {
    issues.push({reason: 'empty-artifact'});
    return issues;
  }
  const first = timestampValue(rows[0]?.t ?? rows[0]?.fundingTime);
  const last = timestampValue(rows.at(-1)?.t ?? rows.at(-1)?.fundingTime);
  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    issues.push({reason: 'invalid-artifact-timestamp'});
    return issues;
  }
  const interval = artifactInterval(artifact);
  if (interval) {
    const step = intervalToMs(interval);
    if (first > activeStart) issues.push({reason: 'active-start-not-covered', first, activeStart});
    if (last + step < activeEnd) issues.push({reason: 'active-end-not-covered', last, activeEnd, step});
  } else if (artifact.kind === 'funding') {
    // Funding is an event stream rather than a candle series. The final event
    // must still be inside the last expected 8-hour funding window.
    if (first > activeStart) issues.push({reason: 'active-start-not-covered', first, activeStart});
    if (last + 8 * 3_600_000 < activeEnd) issues.push({reason: 'active-end-not-covered', last, activeEnd});
  }
  return issues;
}

function requiredArtifactKeys(manifest) {
  const markets = manifest.markets || manifest.universe?.markets || [];
  const keys = [];
  for (const market of markets) {
    for (const kind of ['price', 'funding']) keys.push(`${market.symbol}|${kind}`);
    if (manifest.execution?.oneMinuteAvailable === true) keys.push(`${market.symbol}|minute`);
  }
  return keys;
}

export function verifyBacktestManifest(manifest, rootDir = APP_DIR) {
  const missing = [];
  const mismatched = [];
  const continuity = [];
  const rowCounts = [];
  const coverage = [];
  const contract = [];
  const artifacts = manifest.artifacts || [];
  const artifactByKey = new Map(artifacts.filter(artifact => artifact.symbol && artifact.kind).map(artifact => [`${artifact.symbol}|${artifact.kind}`, artifact]));

  if (Number(manifest.schemaVersion) < 2) contract.push({reason: 'manifest-schema-too-old'});
  if (!manifest.snapshotTimestamp) contract.push({reason: 'snapshot-timestamp-missing'});
  if (manifest.hashAlgorithm !== 'SHA-256') contract.push({reason: 'sha256-manifest-algorithm-required', value: manifest.hashAlgorithm ?? null});
  const marketRecords = manifest.markets || manifest.universe?.markets || [];
  if ((manifest.universe?.symbols || []).length && !marketRecords.length) {
    contract.push({reason: 'market-lifecycle-records-missing'});
  }
  for (const market of marketRecords) {
    const activeStart = timestampValue(market.activeStart ?? market.eligibleStart);
    const activeEnd = timestampValue(market.activeEnd ?? market.eligibleEnd);
    if (!market.symbol || !Number.isFinite(activeStart) || !Number.isFinite(activeEnd) || !(activeEnd > activeStart)) {
      contract.push({symbol: market.symbol ?? null, reason: 'invalid-market-lifecycle-record'});
    }
  }
  if (manifest.universe?.expandedNonCoreCovered !== true) contract.push({reason: 'expanded-non-core-coverage-missing'});
  for (const key of requiredArtifactKeys(manifest)) {
    if (!artifactByKey.has(key)) missing.push({key, reason: 'required-artifact-missing'});
  }

  for (const artifact of artifacts) {
    if (['price', 'funding', 'minute'].includes(artifact.kind)) {
      for (const field of ['symbol', 'kind', 'interval', 'activeStart', 'activeEnd', 'rows', 'sha256']) {
        if (artifact[field] == null || artifact[field] === '') contract.push({path: artifact.path ?? null, reason: `artifact-${field}-missing`});
      }
    }
    const file = path.join(rootDir, artifact.path);
    if (!fs.existsSync(file)) {
      missing.push(artifact.path);
      continue;
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (!artifact.sha256 || hash !== artifact.sha256) {
      mismatched.push({path: artifact.path, expected: artifact.sha256 ?? null, actual: hash});
    }
    let rows;
    try {
      rows = readArtifactRows(file, artifact);
      if (Number(artifact.rows) !== rows.length) rowCounts.push({path: artifact.path, expected: Number(artifact.rows), actual: rows.length});
    } catch (error) {
      contract.push({path: artifact.path, reason: 'artifact-read-error', message: error.message});
      continue;
    }
    const interval = artifactInterval(artifact);
    if (interval) {
      const issues = continuityIssues(rows, interval);
      if (issues.length) continuity.push({path: artifact.path, interval, issueCount: issues.length, firstIssues: issues.slice(0, 3)});
    }
    if (['price', 'minute', 'funding'].includes(artifact.kind)) {
      const issues = coverageIssues(rows, artifact);
      if (issues.length) coverage.push({path: artifact.path, issueCount: issues.length, firstIssues: issues.slice(0, 3)});
    }
  }

  const complete = manifest.status === 'COMPLETE'
    && manifest.universe?.pointInTime === true
    && manifest.universe?.historicalDelistingsResolved === true
    && manifest.universe?.expandedNonCoreCovered === true
    && manifest.hashAlgorithm === 'SHA-256'
    && manifest.execution?.preferredInterval === '1m'
    && manifest.execution?.oneMinuteAvailable === true
    && marketRecords.length >= (manifest.universe?.symbols || []).length
    && !missing.length && !mismatched.length && !rowCounts.length
    && !continuity.length && !coverage.length && !contract.length;
  return {
    status: manifest.status,
    complete,
    snapshotTimestamp: manifest.snapshotTimestamp,
    execution: manifest.execution ?? null,
    artifacts: artifacts.length,
    missing,
    mismatched,
    rowCounts,
    continuity,
    coverage,
    contract,
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
