import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import zlib from 'node:zlib';
import {APP_DIR, DAY, H1} from '../src/config.mjs';
import {parseEnhancedKlineCsv, parseEnhancedKlineRow} from '../src/v9/features.mjs';
import {activeWindow, loadV9Universe} from '../src/v9/universe.mjs';

const DEFAULT_START = Date.parse('2024-01-01T00:00:00Z');
const DEFAULT_END = Date.parse('2026-01-01T00:00:00Z');
const VISION_ROOT = 'https://data.binance.vision/data/futures/um/monthly';
const KIND_PATHS = Object.freeze({
  'taker-1h': 'klines',
  'premium-1h': 'premiumIndexKlines',
  'mark-1h': 'markPriceKlines',
  'index-1h': 'indexPriceKlines',
});

function cliValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function dateValue(value, fallback) {
  if (value == null) return fallback;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function atomicWrite(file, value, encoding = 'utf8') {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, value, encoding);
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if (!['EPERM', 'EXDEV'].includes(error.code)) throw error;
    fs.copyFileSync(temporary, file);
    fs.unlinkSync(temporary);
  }
}

export function atomicWriteJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function createProgressStore(file) {
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {schemaVersion: 1, symbols: {}};
  let writeQueue = Promise.resolve();
  return {
    get value() { return state; },
    update(symbol, patch) {
      writeQueue = writeQueue.then(() => {
        state = {
          ...state,
          symbols: {...(state.symbols || {}), [symbol]: {...(state.symbols?.[symbol] || {}), ...patch}},
          updatedAt: new Date().toISOString(),
        };
        atomicWriteJson(file, state);
      });
      return writeQueue;
    },
    flush() { return writeQueue; },
  };
}

function monthKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseTime(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function monthList(start, end) {
  const result = [];
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  while (cursor.getTime() < end) {
    result.push(monthKey(cursor.getTime()));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return result;
}

function archiveUrl(kind, symbol, month) {
  const folder = KIND_PATHS[kind];
  if (!folder) throw new Error(`Unsupported V9 archive kind: ${kind}`);
  return `${VISION_ROOT}/${folder}/${symbol}/1h/${symbol}-1h-${month}.zip`;
}

function extractZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    const content = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (!content) throw new Error(`Unsupported ZIP compression method ${method}`);
    entries.push({name, content});
    offset = start + compressedSize;
  }
  if (!entries.length) throw new Error('Archive has no local ZIP entries');
  return entries;
}

function archiveCsv(buffer) {
  return extractZipEntries(buffer).filter(entry => entry.name.toLowerCase().endsWith('.csv'))
    .map(entry => entry.content.toString('utf8')).join('\n');
}

function parseDerivativeKlineCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const first = lines[0]?.toLowerCase() || '';
  const hasHeader = first.includes('open_time') || first.includes('open time') || first.includes('openprice');
  return lines.slice(hasHeader ? 1 : 0).map(line => {
    const fields = line.split(',').map(value => value.trim());
    return {t: Number(fields[0]), c: Number(fields[4])};
  }).filter(row => Number.isFinite(row.t) && Number.isFinite(row.c));
}

function derivativeRows(text, kind) {
  const rows = parseDerivativeKlineCsv(text);
  return rows.map(row => kind === 'premium-1h'
    ? {t: row.t, premiumIndex: row.c}
    : kind === 'mark-1h'
      ? {t: row.t, markPrice: row.c}
      : kind === 'index-1h' ? {t: row.t, indexPrice: row.c} : parseEnhancedKlineRow(row));
}

function validRows(rows, kind, start, end) {
  const byTime = new Map();
  for (const row of rows) {
    const t = Number(row.t);
    if (!Number.isFinite(t) || t < start || t >= end) continue;
    if (kind === 'taker-1h' && !(Number(row.o) > 0 && Number(row.h) > 0 && Number(row.l) > 0 && Number(row.c) > 0)) continue;
    if (kind !== 'taker-1h') {
      const value = Number(row[kind === 'premium-1h' ? 'premiumIndex' : kind === 'mark-1h' ? 'markPrice' : 'indexPrice']);
      if (kind === 'premium-1h' ? !Number.isFinite(value) : !(value > 0)) continue;
    }
    byTime.set(t, row);
  }
  return [...byTime.values()].sort((a, b) => Number(a.t) - Number(b.t));
}

async function fetchArchive(url, cacheFile, {rateGate, retries = 4} = {}) {
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 0) {
    return {buffer: fs.readFileSync(cacheFile), reused: true, status: 200};
  }
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await rateGate.wait();
      const response = await fetch(url, {redirect: 'follow'});
      if (response.status === 404) return {buffer: null, reused: false, status: 404};
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      atomicWrite(cacheFile, buffer, null);
      return {buffer, reused: false, status: response.status};
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, 250 * (attempt + 1) ** 2)));
    }
  }
  throw new Error(`Failed ${url}: ${lastError?.message || 'unknown error'}`);
}

class RateGate {
  constructor(delayMs) {
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.nextAt = 0;
    this.lock = Promise.resolve();
  }

  async wait() {
    let release;
    const previous = this.lock;
    this.lock = new Promise(resolve => { release = resolve; });
    await previous;
    const delay = Math.max(0, this.nextAt - Date.now());
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    this.nextAt = Date.now() + this.delayMs;
    release();
  }
}

function inheritedArtifacts(baseManifest, symbols) {
  return (baseManifest.artifacts || []).filter(item => symbols.includes(item.symbol) && ['price', 'minute', 'funding'].includes(item.kind))
    .map(item => ({...item, inheritedFrom: 'data/backtest/manifest.json'}));
}

function lifecycleRecord(market, symbol) {
  return {
    symbol, core: Boolean(market.core), activeStart: market.activeStart ?? market.eligibleStart ?? null,
    activeEnd: market.activeEnd ?? market.eligibleEnd ?? null,
    listingTime: market.listingTime ?? market.onboardTime ?? market.activeStart ?? null,
    deliveryTime: market.deliveryTime ?? market.delistTime ?? market.activeEnd ?? null,
  };
}

function actualArchiveMonths(index, symbol, start, end) {
  const values = index.actualArchiveKeysBySymbol?.[symbol]?.klines || [];
  return values.map(value => value.match(/(\d{4}-\d{2})/)?.[1]).filter(Boolean)
    .filter(value => value >= monthKey(start) && value <= monthKey(end - 1)).sort();
}

function qualityReport(manifest, root) {
  const rows = manifest.artifacts || [];
  const selected = manifest.universe?.symbols || [];
  const required = rows.filter(row => ['taker-1h', 'price', 'minute', 'funding'].includes(row.kind));
  const missing = selected.flatMap(symbol => ['taker-1h', 'price', 'minute', 'funding']
    .filter(kind => !required.some(row => row.symbol === symbol && row.kind === kind))
    .map(kind => ({symbol, kind})));
  const bytes = rows.reduce((sum, row) => {
    const file = path.join(root, row.path || '');
    return sum + (fs.existsSync(file) ? fs.statSync(file).size : 0);
  }, 0);
  const activeByYear = {};
  for (const market of manifest.universe?.markets || []) {
    const start = parseTime(market.activeStart);
    const end = parseTime(market.activeEnd);
    if (!(start < end)) continue;
    for (let year = new Date(start).getUTCFullYear(); year <= new Date(end - 1).getUTCFullYear(); year++) {
      const yearStart = Date.parse(`${year}-01-01T00:00:00Z`);
      const yearEnd = Date.parse(`${year + 1}-01-01T00:00:00Z`);
      if (start < yearEnd && end > yearStart) activeByYear[year] = (activeByYear[year] || 0) + 1;
    }
  }
  return {
    reportVersion: 'v9-data-quality-1', generatedAt: new Date().toISOString(), status: manifest.status,
    totalSymbols: selected.length, currentSymbols: manifest.universe?.markets?.filter(row => !row.deliveryTime || parseTime(row.deliveryTime) >= Date.parse(manifest.snapshotEnd)).length || 0,
    coreSymbols: selected.filter(symbol => manifest.universe.markets.find(row => row.symbol === symbol)?.core).length,
    expandedSymbols: selected.filter(symbol => !manifest.universe.markets.find(row => row.symbol === symbol)?.core).length,
    historicalDelistedSymbols: manifest.universe?.markets?.filter(row => parseTime(row.deliveryTime) > 0 && parseTime(row.deliveryTime) < Date.parse(manifest.snapshotEnd)).length || 0,
    activeSymbolsByYear: activeByYear,
    rowsByKind: Object.fromEntries([...new Set(rows.map(row => row.kind))].sort().map(kind => [kind, rows.filter(row => row.kind === kind).reduce((sum, row) => sum + Number(row.rows || 0), 0)])),
    bytes, missingRequiredArtifacts: missing,
    lifecycleEvidenceCoverage: manifest.universe?.lifecycleEvidenceCoverage || null,
    verifier: {status: 'INCOMPLETE', reason: 'V9 dataset inherits M4 point-in-time and lifecycle evidence blockers; strict formal verifier not run by this builder'},
  };
}

function qualityMarkdown(report) {
  const missing = report.missingRequiredArtifacts.length ? report.missingRequiredArtifacts.map(row => `- ${row.symbol} / ${row.kind}`).join('\n') : '- none';
  const years = Object.entries(report.activeSymbolsByYear).map(([year, count]) => `| ${year} | ${count} |`).join('\n');
  return `# V9 Formal Development Dataset Quality\n\nStatus: **${report.status}**; this is a data-build report only. No strategy or Holdout was run.\n\n- Total symbols: ${report.totalSymbols}; core: ${report.coreSymbols}; expanded: ${report.expandedSymbols}; historical delisted: ${report.historicalDelistedSymbols}\n- Data size: ${report.bytes} bytes\n- Verifier: **${report.verifier.status}** (${report.verifier.reason})\n\n## Active symbols by year\n\n| Year | Active symbols |\n|---|---:|\n${years}\n\n## Rows by kind\n\n${Object.entries(report.rowsByKind).map(([kind, rows]) => `- ${kind}: ${rows}`).join('\n')}\n\n## Missing required artifacts\n\n${missing}\n`;
}

async function processSymbol(symbol, context) {
  const {universe, baseManifest, sourceIndex, root, kinds, start, end, rateGate, progress} = context;
  const market = universe.markets.get(symbol);
  const window = activeWindow(market, start, end);
  const lifecycle = lifecycleRecord(market, symbol);
  const months = monthList(window.activeStart, window.activeEnd);
  const actualMonths = actualArchiveMonths(sourceIndex, symbol, window.activeStart, window.activeEnd);
  const artifacts = [];
  const availability = {};
  for (const kind of kinds) {
    const rows = [];
    const sourceArchives = [];
    for (const month of months) {
      const url = archiveUrl(kind, symbol, month);
      const cacheFile = path.join(root, 'source-cache', KIND_PATHS[kind], symbol, `${symbol}-1h-${month}.zip`);
      const result = await fetchArchive(url, cacheFile, {rateGate});
      if (!result.buffer) {
        availability[kind] = {...availability[kind], [month]: 'not-found'};
        continue;
      }
      const raw = archiveCsv(result.buffer);
      rows.push(...(kind === 'taker-1h' ? parseEnhancedKlineCsv(raw) : derivativeRows(raw, kind)));
      sourceArchives.push({month, url, sha256: sha256(result.buffer), reused: result.reused});
    }
    const normalized = validRows(rows, kind, window.activeStart, window.activeEnd);
    const relativePath = path.join(kind, `${symbol}.json.gz`).replaceAll('\\', '/');
    const file = path.join(root, relativePath);
    atomicWrite(file, zlib.gzipSync(Buffer.from(JSON.stringify(normalized))), null);
    const artifact = {
      symbol, kind, interval: '1h', activeStart: new Date(window.activeStart).toISOString(), activeEnd: new Date(window.activeEnd).toISOString(),
      rows: normalized.length, firstObserved: normalized[0]?.t ?? null, lastObserved: normalized.at(-1)?.t ?? null,
      path: relativePath, sha256: sha256(fs.readFileSync(file)), sourceArchives, actualArchiveMonths: actualMonths,
    };
    artifacts.push(artifact);
    availability[kind] = normalized.length ? 'complete' : 'missing';
  }
  await progress.update(symbol, {status: 'complete', lifecycle, actualFirstArchiveMonth: actualMonths[0] || null, actualLastArchiveMonth: actualMonths.at(-1) || null, completedKinds: kinds, availability});
  return {symbol, lifecycle, artifacts, availability, actualMonths};
}

export async function buildV9DevelopmentDataset({dataRoot, outputRoot, appDir = APP_DIR, start = DEFAULT_START, end = DEFAULT_END, maxSymbols = 150, kinds = Object.keys(KIND_PATHS), concurrency = 6, rateLimitMs = 100, resume = false} = {}) {
  const universe = loadV9Universe(dataRoot, appDir, {start, end, limit: maxSymbols});
  fs.mkdirSync(outputRoot, {recursive: true});
  const progressFile = path.join(outputRoot, 'progress.json');
  const progress = createProgressStore(progressFile);
  const baseManifest = universe.manifest;
  const existingManifestFile = path.join(outputRoot, 'manifest.json');
  const existingManifest = resume && fs.existsSync(existingManifestFile) ? JSON.parse(fs.readFileSync(existingManifestFile, 'utf8')) : null;
  const sourceIndexFile = path.join(dataRoot, 'source', 'archive-index.json');
  const sourceIndex = fs.existsSync(sourceIndexFile) ? JSON.parse(fs.readFileSync(sourceIndexFile, 'utf8')) : {};
  const context = {universe, baseManifest, sourceIndex, root: outputRoot, kinds, start, end, rateGate: new RateGate(rateLimitMs), progress};
  const results = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= universe.symbols.length) return;
      const symbol = universe.symbols[index];
      const prior = progress.value.symbols?.[symbol];
      if (resume && prior?.status === 'complete' && kinds.every(kind => prior.completedKinds?.includes(kind))) {
        results.push({symbol, lifecycle: prior.lifecycle, artifacts: (existingManifest?.artifacts || []).filter(row => row.symbol === symbol && kinds.includes(row.kind)), availability: prior.availability || {}, actualMonths: []});
        continue;
      }
      results.push(await processSymbol(symbol, context));
    }
  }
  await Promise.all(Array.from({length: Math.max(1, Math.min(concurrency, universe.symbols.length))}, () => worker()));
  await progress.flush();
  const lifecycleMarkets = universe.symbols.map(symbol => ({...universe.markets.get(symbol), symbol}));
  const generatedArtifacts = results.flatMap(result => result.artifacts);
  const inherited = inheritedArtifacts(baseManifest, universe.symbols);
  const manifest = {
    schemaVersion: 1, dataset: 'teleedge-v9-development', status: 'M4-INCOMPLETE', generatedAt: new Date().toISOString(),
    snapshotTimestamp: new Date().toISOString(), snapshotEnd: new Date(end).toISOString(), hashAlgorithm: 'SHA-256',
    developmentWindow: {start: new Date(start).toISOString(), end: new Date(end).toISOString()},
    universe: {
      source: universe.source, sourceEvidence: baseManifest.universe?.sourceEvidence || null, sourceEvidenceSha256: baseManifest.universe?.sourceEvidenceSha256 || null,
      pointInTime: false, historicalDelistingsResolved: false, expandedNonCoreCovered: universe.symbols.some(symbol => !universe.markets.get(symbol)?.core),
      symbols: universe.symbols, symbolsHash: universe.symbolsHash, expectedSymbolsHash: universe.expectedHash,
      markets: lifecycleMarkets, lifecycleEvidenceCoverage: {exact: 0, unresolved: universe.symbols.length, source: 'inherited data/backtest manifest; formal PIT evidence remains incomplete'},
    },
    dataAvailability: {
      takerBuyVolume: {available: generatedArtifacts.some(row => row.kind === 'taker-1h' && row.rows > 0), source: 'Binance Data Vision klines'},
      premiumIndex: {available: generatedArtifacts.some(row => row.kind === 'premium-1h' && row.rows > 0), source: 'Binance Data Vision premiumIndexKlines'},
      markPrice: {available: generatedArtifacts.some(row => row.kind === 'mark-1h' && row.rows > 0), source: 'Binance Data Vision markPriceKlines'},
      indexPrice: {available: generatedArtifacts.some(row => row.kind === 'index-1h' && row.rows > 0), source: 'Binance Data Vision indexPriceKlines'},
      historicalOpenInterest: {available: false, reason: 'public endpoint is recent-only for this development window; no proxy used'},
      historicalLongShortRatios: {available: false, reason: 'public endpoint is recent-only for this development window; no proxy used'},
    },
    artifacts: [...inherited, ...generatedArtifacts],
    sources: [{name: 'Binance Data Vision', url: VISION_ROOT, publicNoAuth: true}, {name: 'Inherited execution data', path: path.relative(appDir, dataRoot).replaceAll('\\', '/')}],
    execution: {executionProxy: false, decisionLatencyMinutes: 20, fillInterval: '1m', settlementInterval: '1m', feesFundingModeled: true},
    note: 'M4-INCOMPLETE: this builder records actual archive observations and does not infer PIT lifecycle from expected archive months.',
  };
  atomicWriteJson(path.join(outputRoot, 'manifest.json'), manifest);
  const manifestReportPath = path.join(appDir, 'reports', 'v9-data-manifest.json');
  atomicWriteJson(manifestReportPath, manifest);
  const quality = qualityReport(manifest, outputRoot);
  atomicWriteJson(path.join(appDir, 'reports', 'v9-data-quality.json'), quality);
  atomicWrite(path.join(appDir, 'reports', 'v9-data-quality.md'), qualityMarkdown(quality));
  return {manifest, quality, outputRoot, progressFile};
}

async function main() {
  const dataRoot = path.resolve(cliValue('--data-root', path.join(APP_DIR, 'data', 'backtest')));
  const outputRoot = path.resolve(cliValue('--output-root', path.join(APP_DIR, 'data', 'v9-development')));
  const start = dateValue(cliValue('--start', null), DEFAULT_START);
  const end = dateValue(cliValue('--end', null), DEFAULT_END);
  const maxSymbols = Number(cliValue('--max-symbols', 150)) || 150;
  const concurrency = Number(cliValue('--concurrency', 6)) || 6;
  const rateLimitMs = Number(cliValue('--rate-limit-ms', 100)) || 0;
  const kinds = String(cliValue('--kinds', Object.keys(KIND_PATHS).join(','))).split(',').map(value => value.trim()).filter(value => KIND_PATHS[value]);
  const result = await buildV9DevelopmentDataset({dataRoot, outputRoot, start, end, maxSymbols, kinds, concurrency, rateLimitMs, resume: process.argv.includes('--resume')});
  console.log(JSON.stringify({status: result.manifest.status, symbols: result.manifest.universe.symbols.length, symbolsHash: result.manifest.universe.symbolsHash, quality: result.quality}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

export {archiveUrl, extractZipEntries, monthList, validRows, qualityReport};
