import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {CORE_MARKETS, H1} from '../src/config.mjs';
import {continuityIssues, intervalToMs, timestampValue} from './backtest-data.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function readGzipJson(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim();
  return text ? JSON.parse(text) : [];
}

export function readArtifactRows(file, artifact) {
  if (['price', 'minute', 'funding'].includes(artifact.kind)) return readGzipJson(file);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (artifact.kind === 'universe') return parsed.symbols || [];
  if (artifact.kind === 'snapshot') return [parsed];
  return Array.isArray(parsed) ? parsed : [];
}

export function artifactInterval(artifact) {
  return artifact.interval && artifact.interval !== 'event'
    ? artifact.interval
    : artifact.kind === 'price' ? '1h' : artifact.kind === 'minute' ? '1m' : null;
}

function marketRecordsFor(manifest) {
  if (Array.isArray(manifest.markets) && manifest.markets.length) return manifest.markets;
  return Array.isArray(manifest.universe?.markets) ? manifest.universe.markets : [];
}

function universeSymbolsFor(manifest) {
  return Array.isArray(manifest.universe?.symbols) ? manifest.universe.symbols : [];
}

export function fundingIntervalInfo(artifact, manifest, row = null) {
  const source = manifest.sources?.funding || {};
  const rowHours = Number(row?.fundingIntervalHours);
  if (Number.isFinite(rowHours) && rowHours > 0) {
    return {hours: rowHours, source: 'row-metadata'};
  }
  const observedHours = Number(artifact.fundingIntervalHours ?? artifact.intervalHours);
  if (Number.isFinite(observedHours) && observedHours > 0) {
    return {hours: observedHours, source: artifact.fundingIntervalSource || 'artifact-metadata'};
  }
  const fallbackHours = Number(
    artifact.fundingIntervalFallbackHours
      ?? manifest.fundingIntervalFallbackHours
      ?? source.fundingIntervalFallbackHours,
  );
  const fallbackSource = artifact.fundingIntervalSource
    ?? manifest.fundingIntervalSource
    ?? source.fundingIntervalSource;
  if (Number.isFinite(fallbackHours) && fallbackHours > 0 && fallbackSource === 'documented-fallback') {
    return {hours: fallbackHours, source: fallbackSource};
  }
  return null;
}

export function eventStreamIssues(rows) {
  const issues = [];
  let previous = null;
  for (let index = 0; index < (rows || []).length; index++) {
    const current = timestampValue(rows[index]?.t ?? rows[index]?.fundingTime);
    if (!Number.isFinite(current)) {
      issues.push({index, reason: 'invalid-timestamp', current: rows[index]?.t ?? rows[index]?.fundingTime ?? null});
      continue;
    }
    if (previous != null && current <= previous) {
      issues.push({
        index,
        reason: current === previous ? 'duplicate-timestamp' : 'non-increasing-timestamp',
        previous,
        current,
      });
    }
    previous = current;
  }
  return issues;
}

export function coverageIssuesFromSummary(summary, artifact, manifest) {
  const issues = [];
  const activeStart = timestampValue(artifact.activeStart);
  const activeEnd = timestampValue(artifact.activeEnd);
  if (!Number.isFinite(activeStart) || !Number.isFinite(activeEnd) || !(activeEnd > activeStart)) {
    issues.push({reason: 'invalid-active-window', activeStart: artifact.activeStart ?? null, activeEnd: artifact.activeEnd ?? null});
    return issues;
  }
  if (!summary?.hasRows) {
    issues.push({reason: 'empty-artifact'});
    return issues;
  }
  const first = timestampValue(summary.first);
  const last = timestampValue(summary.last);
  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    issues.push({reason: 'invalid-artifact-timestamp'});
    return issues;
  }
  const interval = artifactInterval(artifact);
  if (artifact.kind === 'funding') {
    const firstFundingInterval = fundingIntervalInfo(artifact, manifest, {fundingIntervalHours: summary.firstFundingIntervalHours});
    const lastFundingInterval = fundingIntervalInfo(artifact, manifest, {fundingIntervalHours: summary.lastFundingIntervalHours});
    if (!firstFundingInterval) {
      issues.push({reason: 'funding-start-interval-metadata-missing'});
    }
    if (!lastFundingInterval) {
      issues.push({reason: 'funding-end-interval-metadata-missing'});
    }
    if (!firstFundingInterval || !lastFundingInterval) {
      return issues;
    }
    const startWindow = firstFundingInterval.hours * H1;
    const endWindow = lastFundingInterval.hours * H1;
    if (first < activeStart || first > activeStart + startWindow) {
      issues.push({
        reason: 'funding-first-event-outside-window',
        first,
        activeStart,
        windowHours: firstFundingInterval.hours,
        intervalSource: firstFundingInterval.source,
      });
    }
    if (last >= activeEnd) issues.push({reason: 'funding-event-after-active-end', last, activeEnd});
    if (last < activeEnd - endWindow) {
      issues.push({
        reason: 'funding-end-window-not-covered',
        last,
        activeEnd,
        windowHours: lastFundingInterval.hours,
        intervalSource: lastFundingInterval.source,
      });
    }
    return issues;
  }
  if (interval) {
    const step = intervalToMs(interval);
    if (first > activeStart) issues.push({reason: 'active-start-not-covered', first, activeStart});
    if (last + step < activeEnd) issues.push({reason: 'active-end-not-covered', last, activeEnd, step});
  }
  return issues;
}

export function coverageIssues(rows, artifact, manifest) {
  return coverageIssuesFromSummary({
    hasRows: Array.isArray(rows) && rows.length > 0,
    first: rows?.[0]?.t ?? rows?.[0]?.fundingTime,
    last: rows?.at(-1)?.t ?? rows?.at(-1)?.fundingTime,
    firstFundingIntervalHours: rows?.[0]?.fundingIntervalHours,
    lastFundingIntervalHours: rows?.at(-1)?.fundingIntervalHours,
  }, artifact, manifest);
}

function requiredArtifactKeys(manifest) {
  const symbols = universeSymbolsFor(manifest);
  const kinds = requiredArtifactKinds(manifest);
  const keys = [];
  for (const symbol of symbols) {
    for (const kind of kinds) keys.push(`${symbol}|${kind}`);
  }
  return keys;
}

function requiredArtifactKinds(manifest) {
  return manifest.execution?.oneMinuteAvailable === true
    ? ['price', 'funding', 'minute']
    : ['price', 'funding'];
}

export function verifyBacktestManifest(manifest, rootDir = APP_DIR) {
  const missing = [];
  const mismatched = [];
  const continuity = [];
  const rowCounts = [];
  const coverage = [];
  const contract = [];
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const universeSymbols = universeSymbolsFor(manifest);
  const universeSymbolSet = new Set(universeSymbols);
  const marketRecords = marketRecordsFor(manifest);
  const artifactByKey = new Map();
  const artifactKeyCounts = new Map();

  if (Number(manifest.schemaVersion) < 2) contract.push({reason: 'manifest-schema-too-old'});
  if (!manifest.snapshotTimestamp) contract.push({reason: 'snapshot-timestamp-missing'});
  if (manifest.hashAlgorithm !== 'SHA-256') contract.push({reason: 'sha256-manifest-algorithm-required', value: manifest.hashAlgorithm ?? null});
  if (!universeSymbols.length) contract.push({reason: 'universe-symbols-empty'});
  if (universeSymbols.some(symbol => typeof symbol !== 'string' || !symbol.trim())) contract.push({reason: 'invalid-universe-symbol'});
  if (new Set(universeSymbols).size !== universeSymbols.length) contract.push({reason: 'duplicate-universe-symbol'});
  if (!marketRecords.length) {
    contract.push({reason: 'market-lifecycle-records-missing'});
  }
  const marketSymbolCounts = new Map();
  for (const record of marketRecords) {
    const market = record && typeof record === 'object' ? record : {};
    marketSymbolCounts.set(market.symbol, (marketSymbolCounts.get(market.symbol) || 0) + 1);
    const activeStart = timestampValue(market.activeStart ?? market.eligibleStart);
    const activeEnd = timestampValue(market.activeEnd ?? market.eligibleEnd);
    if (!market.symbol || !Number.isFinite(activeStart) || !Number.isFinite(activeEnd) || !(activeEnd > activeStart)) {
      contract.push({symbol: market.symbol ?? null, reason: 'invalid-market-lifecycle-record'});
    }
    if (market.symbol && !universeSymbolSet.has(market.symbol)) {
      contract.push({symbol: market.symbol, reason: 'lifecycle-symbol-not-in-universe'});
    }
    if (market.historicalDelisted === true) {
      const requiredEvidence = [
        ['listingEvidenceTimestamp', market.listingEvidenceTimestamp],
        ['listingEvidenceSource', market.listingEvidenceSource],
        ['listingEvidenceSha256', market.listingEvidenceSha256],
        ['delistEvidenceTimestamp', market.delistEvidenceTimestamp],
        ['delistEvidenceSource', market.delistEvidenceSource],
        ['delistEvidenceSha256', market.delistEvidenceSha256],
      ];
      const hasListingRef = Boolean(market.listingEvidenceUrl || market.listingEvidencePath);
      const hasDelistRef = Boolean(market.delistEvidenceUrl || market.delistEvidencePath);
      if (!hasListingRef) requiredEvidence.push(['listingEvidenceUrl/path', null]);
      if (!hasDelistRef) requiredEvidence.push(['delistEvidenceUrl/path', null]);
      for (const [field, value] of requiredEvidence) {
        if (value == null || value === '') contract.push({symbol: market.symbol ?? null, reason: `historical-${field}-missing`});
      }
      for (const field of ['listingEvidenceSha256', 'delistEvidenceSha256']) {
        if (market[field] != null && !/^[a-f0-9]{64}$/i.test(String(market[field]))) {
          contract.push({symbol: market.symbol ?? null, reason: `historical-${field}-invalid`});
        }
      }
      const listingEvidenceTimestamp = timestampValue(market.listingEvidenceTimestamp);
      const firstObserved = timestampValue(market.firstObserved);
      const delistEvidenceTimestamp = timestampValue(market.delistEvidenceTimestamp);
      const lastObserved = timestampValue(market.lastObserved);
      const lifecycleConflicts = [];
      const hasPositiveTimestamp = value => Number.isFinite(value) && value > 0;
      if (hasPositiveTimestamp(listingEvidenceTimestamp) && hasPositiveTimestamp(firstObserved) && listingEvidenceTimestamp > firstObserved) lifecycleConflicts.push('listing-after-first-observed');
      if (hasPositiveTimestamp(delistEvidenceTimestamp) && hasPositiveTimestamp(lastObserved) && lastObserved >= delistEvidenceTimestamp) lifecycleConflicts.push('delist-at-or-before-last-observed');
      if (hasPositiveTimestamp(listingEvidenceTimestamp) && hasPositiveTimestamp(delistEvidenceTimestamp) && listingEvidenceTimestamp >= delistEvidenceTimestamp) lifecycleConflicts.push('listing-not-before-delist');
      for (const reason of lifecycleConflicts) contract.push({symbol: market.symbol ?? null, reason: `historical-lifecycle-${reason}`});
      if (lifecycleConflicts.length || market.lifecycleExact !== true) contract.push({symbol: market.symbol ?? null, reason: 'historical-lifecycle-not-exact'});
    }
  }
  for (const symbol of universeSymbols) {
    const count = marketSymbolCounts.get(symbol) || 0;
    if (count === 0) contract.push({symbol, reason: 'universe-symbol-missing-lifecycle'});
    if (count > 1) contract.push({symbol, reason: 'duplicate-market-lifecycle-symbol'});
  }

  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object') {
      contract.push({reason: 'invalid-artifact-record'});
      continue;
    }
    if (artifact.symbol) {
      const key = `${artifact.symbol}|${artifact.kind}`;
      artifactKeyCounts.set(key, (artifactKeyCounts.get(key) || 0) + 1);
      if (!artifactByKey.has(key)) artifactByKey.set(key, artifact);
      if (!universeSymbolSet.has(artifact.symbol)) {
        contract.push({path: artifact.path ?? null, symbol: artifact.symbol, reason: 'artifact-symbol-not-in-universe'});
      }
    }
  }
  for (const [key, count] of artifactKeyCounts) {
    if (count > 1) contract.push({key, reason: 'duplicate-artifact-key'});
  }
  for (const key of requiredArtifactKeys(manifest)) {
    if (!artifactByKey.has(key)) missing.push({key, reason: 'required-artifact-missing'});
  }

  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object') continue;
    if (['price', 'funding', 'minute'].includes(artifact.kind)) {
      for (const field of ['symbol', 'kind', 'interval', 'activeStart', 'activeEnd', 'rows', 'sha256']) {
        if (artifact[field] == null || artifact[field] === '') contract.push({path: artifact.path ?? null, reason: `artifact-${field}-missing`});
      }
    }
    if (!artifact.path) {
      contract.push({path: null, reason: 'artifact-path-missing'});
      continue;
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
      if (issues.length) continuity.push({path: artifact.path, symbol: artifact.symbol ?? null, kind: artifact.kind ?? null, interval, issueCount: issues.length, firstIssues: issues.slice(0, 3), issues});
    }
    if (artifact.kind === 'funding') {
      const issues = eventStreamIssues(rows);
      if (issues.length) continuity.push({path: artifact.path, symbol: artifact.symbol ?? null, kind: artifact.kind, interval: 'event', issueCount: issues.length, firstIssues: issues.slice(0, 3), issues});
    }
    if (['price', 'minute', 'funding'].includes(artifact.kind)) {
      const issues = coverageIssues(rows, artifact, manifest);
      if (issues.length) coverage.push({path: artifact.path, symbol: artifact.symbol ?? null, kind: artifact.kind, interval: artifact.interval ?? null, issueCount: issues.length, firstIssues: issues.slice(0, 3), issues});
    }
  }

  const artifactProblemPaths = new Set([
    ...missing.filter(item => typeof item === 'string').map(item => item),
    ...mismatched.map(item => item.path),
    ...rowCounts.map(item => item.path),
    ...continuity.map(item => item.path),
    ...coverage.map(item => item.path),
    ...contract.filter(item => item.path).map(item => item.path),
  ]);
  const requiredArtifactsComplete = symbol => requiredArtifactKinds(manifest).every(kind => {
    const artifact = artifactByKey.get(`${symbol}|${kind}`);
    return Boolean(artifact?.path) && !artifactProblemPaths.has(artifact.path);
  });
  const expandedSymbols = universeSymbols.filter(symbol => !CORE_MARKETS.has(symbol));
  const expandedSymbolsWithCompleteArtifacts = expandedSymbols.filter(requiredArtifactsComplete);
  if (!expandedSymbols.length) {
    contract.push({reason: 'expanded-non-core-market-missing'});
  } else if (expandedSymbolsWithCompleteArtifacts.length !== expandedSymbols.length) {
    contract.push({
      symbols: expandedSymbols.filter(symbol => !expandedSymbolsWithCompleteArtifacts.includes(symbol)),
      reason: 'expanded-non-core-artifacts-incomplete',
    });
  }

  const complete = manifest.status === 'COMPLETE'
    && manifest.universe?.pointInTime === true
    && manifest.universe?.historicalDelistingsResolved === true
    && manifest.hashAlgorithm === 'SHA-256'
    && manifest.execution?.preferredInterval === '1m'
    && manifest.execution?.oneMinuteAvailable === true
    && universeSymbols.length > 0
    && marketRecords.length > 0
    && !missing.length && !mismatched.length && !rowCounts.length
    && !continuity.length && !coverage.length && !contract.length;
  return {
    status: manifest.status,
    complete,
    snapshotTimestamp: manifest.snapshotTimestamp,
    execution: manifest.execution ?? null,
    artifacts: artifacts.length,
    universe: {
      symbols: universeSymbols,
      lifecycleRecords: marketRecords.length,
      expandedSymbols,
      expandedSymbolsWithCompleteArtifacts,
    },
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
