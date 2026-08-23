import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {artifactInterval, verifyBacktestManifest} from './verify-backtest-data.mjs';
import {coverageIssuesFromSummary} from './verify-backtest-data.mjs';
import {intervalToMs, timestampValue} from './backtest-data.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_MANIFEST = path.join(APP_DIR, 'data', 'backtest', 'manifest.json');
const JSON_REPORT = path.join(APP_DIR, 'reports', 'formal-dataset-strict-failures.json');
const MARKDOWN_REPORT = path.join(APP_DIR, 'reports', 'formal-dataset-strict-failures.md');

function iso(value) {
  const timestamp = timestampValue(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function issueDetails(issue, artifact, family) {
  const step = artifactInterval(artifact) ? intervalToMs(artifactInterval(artifact)) : null;
  let gapStart = null;
  let gapEnd = null;
  let missingDurationMs = null;
  let gapType = 'internal-gap';
  let firstFailureTimestamp = null;

  if (issue.reason === 'non-contiguous-timestamp') {
    gapStart = issue.expected ?? null;
    gapEnd = issue.current ?? null;
    missingDurationMs = Number.isFinite(Number(issue.current)) && Number.isFinite(Number(issue.expected))
      ? Math.max(0, Number(issue.current) - Number(issue.expected))
      : null;
    firstFailureTimestamp = issue.current ?? issue.expected ?? null;
    gapType = missingDurationMs > 0 ? 'internal-gap' : 'overlap-or-duplicate';
  } else if (issue.reason === 'active-start-not-covered' || issue.reason === 'funding-first-event-outside-window') {
    gapStart = issue.activeStart ?? artifact.activeStart ?? null;
    gapEnd = issue.first ?? null;
    missingDurationMs = Number.isFinite(Number(issue.first)) && Number.isFinite(Number(gapStart))
      ? Math.max(0, Number(issue.first) - Number(gapStart))
      : null;
    firstFailureTimestamp = issue.first ?? gapStart;
    gapType = 'boundary-gap';
  } else if (issue.reason === 'active-end-not-covered' || issue.reason === 'funding-end-window-not-covered') {
    gapStart = issue.reason === 'active-end-not-covered' && Number.isFinite(Number(issue.last)) && Number.isFinite(Number(issue.step))
      ? Number(issue.last) + Number(issue.step)
      : issue.last ?? null;
    gapEnd = issue.activeEnd ?? artifact.activeEnd ?? null;
    missingDurationMs = Number.isFinite(Number(gapEnd)) && Number.isFinite(Number(gapStart))
      ? Math.max(0, Number(gapEnd) - Number(gapStart))
      : null;
    firstFailureTimestamp = issue.last ?? gapEnd;
    gapType = 'boundary-gap';
  } else if (issue.reason === 'funding-event-after-active-end') {
    gapStart = issue.activeEnd ?? artifact.activeEnd ?? null;
    gapEnd = issue.last ?? null;
    missingDurationMs = Number.isFinite(Number(gapEnd)) && Number.isFinite(Number(gapStart))
      ? Math.max(0, Number(gapEnd) - Number(gapStart))
      : null;
    firstFailureTimestamp = issue.last ?? gapStart;
    gapType = 'boundary-overrun';
  } else {
    firstFailureTimestamp = issue.current ?? issue.first ?? issue.last ?? issue.activeStart ?? issue.activeEnd ?? null;
    gapType = family === 'coverage' ? 'boundary-gap' : 'internal-gap';
  }

  return {
    reason: issue.reason || 'unknown',
    firstFailureTimestamp: iso(firstFailureTimestamp),
    gapStart: iso(gapStart),
    gapEnd: iso(gapEnd),
    missingDurationMs,
    gapType,
    details: issue,
    stepMs: step,
  };
}

function artifactFailure(entry, artifact, family) {
  const issues = entry.issues || entry.firstIssues || [];
  const normalized = issues.map(issue => issueDetails(issue, artifact || {}, family));
  const first = normalized[0] || issueDetails({reason: 'unknown'}, artifact || {}, family);
  return {
    symbol: entry.symbol || artifact?.symbol || null,
    artifactKind: entry.kind || artifact?.kind || null,
    path: entry.path || artifact?.path || null,
    interval: entry.interval || artifact?.interval || null,
    reason: first.reason,
    firstFailureTimestamp: first.firstFailureTimestamp,
    gapStart: first.gapStart,
    gapEnd: first.gapEnd,
    missingDurationMs: first.missingDurationMs,
    gapType: first.gapType,
    issueCount: entry.issueCount ?? normalized.length,
    issues: normalized,
    source: artifact ? {
      sourceArchiveCount: artifact.sourceArchiveCount ?? null,
      sourceArchiveSha256: artifact.sourceArchiveSha256 ?? [],
      sha256: artifact.sha256 ?? null,
    } : null,
  };
}

function readIssues(manifest, result) {
  const byPath = new Map((manifest.artifacts || []).filter(item => item?.path).map(item => [item.path, item]));
  const continuityFailures = result.continuity.map(entry => artifactFailure(entry, byPath.get(entry.path), 'continuity'));
  const coverageFailures = result.coverage.map(entry => artifactFailure(entry, byPath.get(entry.path), 'coverage'));
  const detailedCoverage = coverageFailures.flatMap(failure => failure.issues.map(issue => ({
    symbol: failure.symbol,
    artifactKind: failure.artifactKind,
    path: failure.path,
    reason: issue.reason,
    firstFailureTimestamp: issue.firstFailureTimestamp,
    gapStart: issue.gapStart,
    gapEnd: issue.gapEnd,
    missingDurationMs: issue.missingDurationMs,
    gapType: issue.gapType,
    details: issue.details,
  })));
  const missing = result.missing.map(item => typeof item === 'string'
    ? {symbol: null, artifactKind: null, path: item, reason: 'required-artifact-missing'}
    : {symbol: String(item.key || '').split('|')[0] || null, artifactKind: String(item.key || '').split('|')[1] || null, path: item.path || null, reason: item.reason || 'required-artifact-missing'});
  return {
    continuityFailures,
    coverageFailures,
    fundingWindowFailures: detailedCoverage.filter(item => item.artifactKind === 'funding' && item.reason.startsWith('funding-')),
    priceBoundaryFailures: detailedCoverage.filter(item => item.artifactKind === 'price' && item.gapType.startsWith('boundary')),
    minuteBoundaryFailures: detailedCoverage.filter(item => item.artifactKind === 'minute' && item.gapType.startsWith('boundary')),
    missing,
  };
}

function markdownList(title, records) {
  const lines = [`## ${title}`, '', `Count: ${records.length}`, ''];
  if (!records.length) return [...lines, 'None.', ''];
  for (const record of records) {
    lines.push(`- ${record.symbol || '(unknown)'} | ${record.artifactKind || '(unknown)'} | ${record.reason} | first=${record.firstFailureTimestamp || 'n/a'} | gap=${record.gapStart || 'n/a'}..${record.gapEnd || 'n/a'} | missingMs=${record.missingDurationMs ?? 'n/a'} | ${record.gapType || 'n/a'} | ${record.path || 'n/a'}`);
    if (record.issues?.length > 1) {
      for (const issue of record.issues.slice(1)) lines.push(`  - ${issue.reason} | first=${issue.firstFailureTimestamp || 'n/a'} | gap=${issue.gapStart || 'n/a'}..${issue.gapEnd || 'n/a'} | missingMs=${issue.missingDurationMs ?? 'n/a'} | ${issue.gapType || 'n/a'}`);
    }
  }
  lines.push('');
  return lines;
}

function scanCompressedArtifact(file, artifact) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const source = fs.createReadStream(file);
    const gunzip = zlib.createGunzip();
    let buffer = '';
    let cursor = 0;
    let hasRows = false;
    let rowCount = 0;
    let first = null;
    let last = null;
    let firstFundingIntervalHours = null;
    let lastFundingIntervalHours = null;
    let previous = null;
    const continuity = [];
    const step = artifactInterval(artifact) ? intervalToMs(artifactInterval(artifact)) : null;
    let settled = false;

    const finish = error => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({
        sha256: hash.digest('hex'),
        hasRows,
        rowCount,
        first,
        last,
        firstFundingIntervalHours,
        lastFundingIntervalHours,
        continuity,
      });
    };
    const consume = chunk => {
      buffer += chunk.toString('utf8');
      while (true) {
        const start = buffer.indexOf('{', cursor);
        if (start < 0) {
          cursor = buffer.length;
          break;
        }
        const end = buffer.indexOf('}', start + 1);
        if (end < 0) {
          cursor = start;
          break;
        }
        const objectText = buffer.slice(start, end + 1);
        const timeMatch = objectText.match(/"t"\s*:\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
        const intervalMatch = objectText.match(/"fundingIntervalHours"\s*:\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
        const current = timeMatch ? Number(timeMatch[1]) : NaN;
        const fundingIntervalHours = intervalMatch ? Number(intervalMatch[1]) : null;
        rowCount++;
        if (!Number.isFinite(current)) {
          continuity.push({index: rowCount - 1, reason: 'invalid-timestamp', current: null});
        } else {
          if (!hasRows) {
            first = current;
            firstFundingIntervalHours = Number.isFinite(fundingIntervalHours) && fundingIntervalHours > 0 ? fundingIntervalHours : null;
            hasRows = true;
          }
          if (previous != null) {
            if (artifact.kind === 'funding') {
              if (current <= previous) continuity.push({
                index: rowCount - 1,
                reason: current === previous ? 'duplicate-timestamp' : 'non-increasing-timestamp',
                previous,
                current,
              });
            } else if (step != null && current !== previous + step) {
              continuity.push({index: rowCount - 1, reason: 'non-contiguous-timestamp', previous, current, expected: previous + step});
            }
          }
          previous = current;
          last = current;
          lastFundingIntervalHours = Number.isFinite(fundingIntervalHours) && fundingIntervalHours > 0 ? fundingIntervalHours : null;
        }
        cursor = end + 1;
        if (cursor > 1_048_576) {
          buffer = buffer.slice(cursor);
          cursor = 0;
        }
      }
      if (cursor > 1_048_576) {
        buffer = buffer.slice(cursor);
        cursor = 0;
      }
    };
    source.on('data', chunk => hash.update(chunk));
    source.on('error', finish);
    gunzip.on('data', consume);
    gunzip.on('error', finish);
    gunzip.on('end', () => finish());
    source.pipe(gunzip);
  });
}

async function fastVerifier(manifest, rootDir) {
  const missing = [];
  const mismatched = [];
  const rowCounts = [];
  const continuity = [];
  const coverage = [];
  const artifactsByKey = new Map((manifest.artifacts || []).filter(item => item?.symbol).map(item => [`${item.symbol}|${item.kind}`, item]));
  const scanAllMinute = process.argv.includes('--scan-minute');
  const scanMinuteCandidates = process.argv.includes('--scan-minute-candidates');
  const minuteCandidates = new Set((manifest.artifacts || [])
    .filter(item => item?.kind === 'minute')
    .filter(item => {
      const first = timestampValue(item.firstTimestamp);
      const last = timestampValue(item.lastTimestamp);
      const expected = Number.isFinite(first) && Number.isFinite(last) ? Math.round((last - first) / 60_000) + 1 : null;
      return expected != null && Number(item.rows) !== expected;
    })
    .map(item => item.path));
  const kinds = manifest.execution?.oneMinuteAvailable === true ? ['price', 'funding', 'minute'] : ['price', 'funding'];
  for (const symbol of manifest.universe?.symbols || []) {
    for (const kind of kinds) {
      if (!artifactsByKey.has(`${symbol}|${kind}`)) missing.push({key: `${symbol}|${kind}`, reason: 'required-artifact-missing'});
    }
  }
  for (const artifact of manifest.artifacts || []) {
    if (!artifact?.path || !['price', 'funding', 'minute'].includes(artifact.kind)) continue;
    const file = path.join(rootDir, artifact.path);
    if (!fs.existsSync(file)) {
      missing.push(artifact.path);
      continue;
    }
    const scanThisMinute = artifact.kind !== 'minute' || scanAllMinute || (scanMinuteCandidates && minuteCandidates.has(artifact.path));
    const metadataOnlyMinute = artifact.kind === 'minute' && !scanThisMinute;
    const summary = metadataOnlyMinute
      ? {
        sha256: artifact.sha256,
        hasRows: Number(artifact.rows) > 0,
        rowCount: Number(artifact.rows) || 0,
        first: artifact.firstTimestamp,
        last: artifact.lastTimestamp,
        firstFundingIntervalHours: null,
        lastFundingIntervalHours: null,
        continuity: [],
      }
      : await scanCompressedArtifact(file, artifact);
    if (artifact.sha256 && summary.sha256 !== artifact.sha256) mismatched.push({path: artifact.path, expected: artifact.sha256, actual: summary.sha256});
    if (Number(artifact.rows) !== summary.rowCount) rowCounts.push({path: artifact.path, expected: Number(artifact.rows), actual: summary.rowCount});
    if (summary.continuity.length) continuity.push({path: artifact.path, symbol: artifact.symbol, kind: artifact.kind, interval: artifactInterval(artifact) || 'event', issueCount: summary.continuity.length, issues: summary.continuity, firstIssues: summary.continuity.slice(0, 3)});
    const issues = coverageIssuesFromSummary(summary, artifact, manifest);
    if (issues.length) coverage.push({path: artifact.path, symbol: artifact.symbol, kind: artifact.kind, interval: artifact.interval || null, issueCount: issues.length, issues, firstIssues: issues.slice(0, 3)});
  }
  return {
    status: manifest.status,
    complete: false,
    missing,
    mismatched,
    rowCounts,
    continuity,
    coverage,
    contract: [],
    note: scanAllMinute
      ? 'All compressed artifacts were timestamp-scanned.'
      : scanMinuteCandidates
        ? `Only ${minuteCandidates.size} 1m artifacts with manifest row-span deficits were timestamp-scanned; other 1m boundary checks used manifest first/last/row/hash metadata.`
        : '1m continuity was not rescanned; manifest first/last/row/hash metadata was used for 1m boundary inventory. Pass --scan-minute-candidates or --scan-minute for continuity scans.',
  };
}

export function buildFailureInventory(manifest, result, rootDir = APP_DIR) {
  const failures = readIssues(manifest, result);
  return {
    generatedAt: new Date().toISOString(),
    manifest: path.relative(APP_DIR, path.join(rootDir, 'data', 'backtest', 'manifest.json')).replaceAll('\\', '/'),
    verifier: {
      status: result.status,
      complete: result.complete,
      missing: result.missing.length,
      mismatched: result.mismatched.length,
      rowCounts: result.rowCounts.length,
      continuityArtifactFailures: result.continuity.length,
      coverageArtifactFailures: result.coverage.length,
      contract: result.contract.length,
    },
    summary: {
      continuityFailures: failures.continuityFailures.length,
      continuityIssues: failures.continuityFailures.reduce((sum, item) => sum + Number(item.issueCount || 0), 0),
      coverageFailures: failures.coverageFailures.length,
      coverageIssues: failures.coverageFailures.reduce((sum, item) => sum + Number(item.issueCount || 0), 0),
      fundingWindowFailures: failures.fundingWindowFailures.length,
      priceBoundaryFailures: failures.priceBoundaryFailures.length,
      minuteBoundaryFailures: failures.minuteBoundaryFailures.length,
      missingArtifacts: failures.missing.length,
    },
    ...failures,
  };
}

export function writeFailureInventory(inventory, jsonFile = JSON_REPORT, markdownFile = MARKDOWN_REPORT) {
  fs.mkdirSync(path.dirname(jsonFile), {recursive: true});
  fs.writeFileSync(jsonFile, `${JSON.stringify(inventory, null, 2)}\n`);
  const lines = [
    '# Formal Dataset Strict Failure Inventory', '',
    `Generated: ${inventory.generatedAt}`, '',
    '| verifier field | count |', '| --- | ---: |',
    `| missing artifacts | ${inventory.summary.missingArtifacts} |`,
    `| continuity artifact failures | ${inventory.summary.continuityFailures} |`,
    `| continuity issue records | ${inventory.summary.continuityIssues} |`,
    `| coverage artifact failures | ${inventory.summary.coverageFailures} |`,
    `| coverage issue records | ${inventory.summary.coverageIssues} |`,
    `| funding window failures | ${inventory.summary.fundingWindowFailures} |`,
    `| price boundary failures | ${inventory.summary.priceBoundaryFailures} |`,
    `| 1m boundary failures | ${inventory.summary.minuteBoundaryFailures} |`, '',
  ];
  lines.push(...markdownList('Missing required artifacts', inventory.missing));
  lines.push(...markdownList('Continuity failures', inventory.continuityFailures));
  lines.push(...markdownList('Coverage failures', inventory.coverageFailures));
  lines.push(...markdownList('Funding window failures', inventory.fundingWindowFailures));
  lines.push(...markdownList('Price boundary failures', inventory.priceBoundaryFailures));
  lines.push(...markdownList('1m boundary failures', inventory.minuteBoundaryFailures));
  fs.writeFileSync(markdownFile, `${lines.join('\n')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const manifestFile = process.argv.find(value => value.startsWith('--manifest='))?.slice('--manifest='.length) || DEFAULT_MANIFEST;
  if (!fs.existsSync(manifestFile)) {
    console.error(`Formal dataset manifest is absent: ${manifestFile}`);
    process.exitCode = 1;
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const result = await fastVerifier(manifest, APP_DIR);
    const inventory = buildFailureInventory(manifest, result, APP_DIR);
    writeFailureInventory(inventory);
    console.log(JSON.stringify({
      json: path.relative(APP_DIR, JSON_REPORT).replaceAll('\\', '/'),
      markdown: path.relative(APP_DIR, MARKDOWN_REPORT).replaceAll('\\', '/'),
      summary: inventory.summary,
      complete: result.complete,
    }, null, 2));
    if (process.argv.includes('--strict') && !result.complete) process.exitCode = 1;
  }
}
