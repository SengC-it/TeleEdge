import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CORE_MARKETS} from '../src/config.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = path.join(APP_DIR, 'data', 'backtest');
const MANIFEST_FILE = path.join(ROOT, 'manifest.json');
const FAILURE_FILE = path.join(APP_DIR, 'reports', 'formal-dataset-strict-failures.json');
const JSON_FILE = path.join(APP_DIR, 'reports', 'fast-oos-universe.json');
const MARKDOWN_FILE = path.join(APP_DIR, 'reports', 'fast-oos-universe.md');
const OOS_START = Date.parse('2025-01-01T00:00:00Z');
const ENGINE_SNAPSHOT_END = Date.parse('2026-07-15T00:00:00Z');
const OOS_DURATION = ENGINE_SNAPSHOT_END - OOS_START;

function timestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : NaN;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function artifactMap(manifest) {
  return new Map((manifest.artifacts || []).map(item => [`${item.symbol}|${item.kind}`, item]));
}

function activeDurationBand(durationMs) {
  if (durationMs >= OOS_DURATION * 0.66) return 'long-history';
  if (durationMs >= OOS_DURATION * 0.33) return 'medium-history';
  return 'recent-listing';
}

function selectExecutionRecords(records, maxSymbols) {
  if (!Number.isFinite(maxSymbols) || records.length <= maxSymbols) return records;
  const buckets = new Map();
  for (const record of records) {
    const key = `${record.tier}|${record.durationBand}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }
  for (const rows of buckets.values()) rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const quota = Math.floor(maxSymbols / 6);
  const chosen = new Map();
  for (const key of [...buckets.keys()].sort()) {
    const rows = buckets.get(key);
    const take = Math.min(quota, rows.length);
    for (let index = 0; index < take; index++) {
      const row = rows[Math.min(rows.length - 1, Math.floor(index * rows.length / take))];
      chosen.set(row.symbol, row);
    }
  }
  const remaining = records
    .filter(record => !chosen.has(record.symbol))
    .sort((a, b) => b.durationMs - a.durationMs || a.tier.localeCompare(b.tier) || a.symbol.localeCompare(b.symbol));
  for (const row of remaining) {
    if (chosen.size >= maxSymbols) break;
    chosen.set(row.symbol, row);
  }
  const btc = records.find(record => record.symbol === 'BTCUSDT');
  if (btc && !chosen.has(btc.symbol)) {
    const replace = [...chosen.values()].sort((a, b) => a.durationMs - b.durationMs || b.symbol.localeCompare(a.symbol))[0];
    if (replace) chosen.delete(replace.symbol);
    chosen.set(btc.symbol, btc);
  }
  return [...chosen.values()].slice(0, maxSymbols);
}

function main() {
  if (!fs.existsSync(MANIFEST_FILE) || !fs.existsSync(FAILURE_FILE)) throw new Error('manifest and strict failure inventory are required');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const failure = JSON.parse(fs.readFileSync(FAILURE_FILE, 'utf8'));
  const maxSymbolsArg = process.argv.find(value => value.startsWith('--max-symbols='));
  const maxSymbols = maxSymbolsArg ? Math.max(2, Number(maxSymbolsArg.slice('--max-symbols='.length))) : Infinity;
  const artifacts = artifactMap(manifest);
  const failureBySymbol = new Map();
  const addFailure = (symbol, reason, kind = null, pathValue = null) => {
    if (!failureBySymbol.has(symbol)) failureBySymbol.set(symbol, []);
    failureBySymbol.get(symbol).push({reason, artifactKind: kind, path: pathValue});
  };
  for (const item of failure.continuityFailures || []) addFailure(item.symbol, `continuity:${item.reason}`, item.artifactKind, item.path);
  for (const item of failure.coverageFailures || []) addFailure(item.symbol, `coverage:${item.reason}`, item.artifactKind, item.path);
  for (const item of failure.missing || []) addFailure(item.symbol, item.reason || 'required-artifact-missing', item.artifactKind, item.path);
  const requiredKinds = ['price', 'funding', 'minute'];
  const records = [];
  for (const symbol of manifest.universe?.symbols || []) {
    const market = (manifest.universe?.markets || []).find(item => item.symbol === symbol);
    const reasons = [...(failureBySymbol.get(symbol) || [])];
    if (!market?.lifecycleExact) reasons.push({reason: 'lifecycle-not-exact', artifactKind: null, path: null});
    for (const kind of requiredKinds) {
      const artifact = artifacts.get(`${symbol}|${kind}`);
      if (!artifact) reasons.push({reason: `artifact-missing:${kind}`, artifactKind: kind, path: null});
      else {
        if (!(Number(artifact.rows) > 0)) reasons.push({reason: `artifact-empty:${kind}`, artifactKind: kind, path: artifact.path});
        if (!artifact.sha256) reasons.push({reason: `artifact-hash-missing:${kind}`, artifactKind: kind, path: artifact.path});
        if (!fs.existsSync(path.join(APP_DIR, artifact.path))) reasons.push({reason: `artifact-file-missing:${kind}`, artifactKind: kind, path: artifact.path});
      }
    }
    const eligibleStart = timestamp(market?.eligibleStart ?? market?.activeStart);
    const eligibleEnd = timestamp(market?.eligibleEnd ?? market?.activeEnd);
    const overlapsOos = Number.isFinite(eligibleStart) && Number.isFinite(eligibleEnd)
      && eligibleStart < ENGINE_SNAPSHOT_END
      && eligibleEnd > Math.max(eligibleStart, OOS_START);
    if (!overlapsOos) reasons.push({reason: 'no-oos-window', artifactKind: null, path: null});
    const durationMs = overlapsOos
      ? Math.max(0, Math.min(eligibleEnd, ENGINE_SNAPSHOT_END) - Math.max(eligibleStart, OOS_START))
      : 0;
    records.push({
      symbol,
      tier: CORE_MARKETS.has(symbol) ? 'core' : 'expanded',
      durationMs,
      durationBand: activeDurationBand(durationMs),
      eligibleStart: Number.isFinite(eligibleStart) ? new Date(eligibleStart).toISOString() : null,
      eligibleEnd: Number.isFinite(eligibleEnd) ? new Date(eligibleEnd).toISOString() : null,
      lifecycleExact: market?.lifecycleExact === true,
      reasons: [...new Map(reasons.map(item => [JSON.stringify(item), item])).values()],
    });
  }
  const eligible = records.filter(item => item.reasons.length === 0);
  const excluded = records.filter(item => item.reasons.length > 0);
  const executionSelectionRecords = selectExecutionRecords(eligible, maxSymbols);
  const executionSymbols = executionSelectionRecords.map(item => item.symbol);
  const yearCoverage = {};
  for (const item of eligible) {
    let cursor = Math.max(OOS_START, timestamp(item.eligibleStart));
    const end = Math.min(timestamp(item.eligibleEnd), ENGINE_SNAPSHOT_END);
    while (cursor < end) {
      const year = String(new Date(cursor).getUTCFullYear());
      yearCoverage[year] = (yearCoverage[year] || 0) + 1;
      const next = Date.UTC(new Date(cursor).getUTCFullYear() + 1, 0, 1);
      cursor = Math.min(next, end);
    }
  }
  const reasonBreakdown = {};
  for (const item of excluded) for (const reason of item.reasons) reasonBreakdown[reason.reason] = (reasonBreakdown[reason.reason] || 0) + 1;
  const report = {
    generatedAt: new Date().toISOString(),
    status: eligible.length >= 50 && eligible.some(item => item.tier === 'core') && eligible.some(item => item.tier === 'expanded') ? 'READY_FOR_FAST_OOS' : 'INCONCLUSIVE_UNIVERSE',
    snapshotTimestamp: manifest.snapshotTimestamp,
    oosWindow: {start: new Date(OOS_START).toISOString(), end: new Date(ENGINE_SNAPSHOT_END).toISOString()},
    datasetSnapshotTimestamp: manifest.snapshotTimestamp,
    sourceManifest: 'data/backtest/manifest.json',
    sourceFailureInventory: 'reports/formal-dataset-strict-failures.json',
    verifierBasis: failure.verifier,
    requiredArtifacts: requiredKinds,
    executionModel: {scanCadenceHours: 4, decisionLatencyMinutes: 20, fillInterval: '1m', settlementInterval: '1m', executionProxy: false, sameMinuteTpSl: 'sl', feesFundingSlippage: true},
    eligibleSymbols: eligible.map(item => item.symbol),
    executionSymbols,
    executionSelection: Number.isFinite(maxSymbols) && eligible.length > maxSymbols
      ? `deterministic ${maxSymbols}-symbol active-duration stratified subset: long-history/medium-history/recent-listing × core/expanded with BTCUSDT context anchor; ties by duration/tier/symbol; no minuteRows selection`
      : 'all eligible symbols',
    excludedSymbols: excluded,
    coreCount: eligible.filter(item => item.tier === 'core').length,
    expandedCount: eligible.filter(item => item.tier === 'expanded').length,
    yearCoverage,
    reasonBreakdown,
  };
  fs.writeFileSync(JSON_FILE, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    '# Fast OOS Clean Universe', '',
    `Status: **${report.status}**`, '',
    `Snapshot: ${report.snapshotTimestamp}`, `Eligible symbols: **${eligible.length}**`, `Core: **${report.coreCount}**`, `Expanded/non-core: **${report.expandedCount}**`, '',
    `Execution symbols: **${executionSymbols.length}**`, `Selection: ${report.executionSelection}`, '',
    '## Year coverage', '', '| Year | Eligible symbol windows |', '|---|---:|',
    ...Object.entries(yearCoverage).sort().map(([year, count]) => `| ${year} | ${count} |`), '',
    '## Eligible symbols', '', eligible.map(item => `- ${item.symbol} (${item.tier}) ${item.eligibleStart} → ${item.eligibleEnd}`).join('\n') || 'None.', '',
    '## Excluded symbols', '', '| Symbol | Reasons |', '|---|---|',
    ...excluded.map(item => `| ${item.symbol} | ${item.reasons.map(reason => reason.reason).join('; ')} |`), '',
    '## Gate notes', '',
    '- Eligibility requires exact lifecycle, price/funding/1m artifacts, valid manifest metadata, and no continuity or active-window coverage failure in the verifier inventory.',
    '- This report does not upgrade M4; it is a clean subset for fast research OOS only.',
  ];
  fs.writeFileSync(MARKDOWN_FILE, `${lines.join('\n')}\n`);
  console.log(JSON.stringify({json: path.relative(APP_DIR, JSON_FILE).replaceAll('\\', '/'), markdown: path.relative(APP_DIR, MARKDOWN_FILE).replaceAll('\\', '/'), eligible: eligible.length, core: report.coreCount, expanded: report.expandedCount, status: report.status}, null, 2));
}

main();
