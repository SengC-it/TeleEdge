import crypto from 'node:crypto';
import {execFile as execFileCallback} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {artifactInterval} from './verify-backtest-data.mjs';
import {extractArchiveCsv, normalizedRowsFromCsv, parseChecksum} from './build-formal-dataset.mjs';
import {intervalToMs, timestampValue} from './backtest-data.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = path.join(APP_DIR, 'data', 'backtest');
const MANIFEST_FILE = path.join(ROOT, 'manifest.json');
const REPORT_FILE = path.join(APP_DIR, 'reports', 'formal-dataset-strict-failures.json');
const DATA_HOST = 'https://data.binance.vision';
const API_HOST = 'https://fapi.binance.com';
const execFile = promisify(execFileCallback);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArgs() {
  const args = {limit: Infinity, includeBoundary: true};
  for (const value of process.argv.slice(2)) {
    const [key, raw] = value.split('=', 2);
    if (key === '--limit' && raw) args.limit = Math.max(1, Number(raw));
    if (key === '--internal-only') args.includeBoundary = false;
  }
  return args;
}

function iso(value) {
  const timestamp = timestampValue(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function fetchBuffer(url) {
  try {
    const executable = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const result = await execFile(executable, ['-L', '--fail', '--silent', '--show-error', '--connect-timeout', '20', '--max-time', '600', url], {encoding: 'buffer', maxBuffer: 256 * 1024 * 1024});
    return result.stdout;
  } catch {
    // Fall through to the native request path when curl transport is unavailable.
  }
  const response = await fetch(url, {headers: {'user-agent': 'TeleEdge-formal-gap-repair/1.0'}});
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchJson(url) {
  try {
    const executable = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const result = await execFile(executable, ['-L', '--fail', '--silent', '--show-error', '--connect-timeout', '20', '--max-time', '120', '-H', 'user-agent: TeleEdge-formal-gap-repair/1.0', url], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    return JSON.parse(result.stdout);
  } catch {
    const response = await fetch(url, {headers: {'user-agent': 'TeleEdge-formal-gap-repair/1.0'}});
    if (!response.ok) throw new Error(`${response.status} ${url}: ${(await response.text()).slice(0, 200)}`);
    return response.json();
  }
}

async function fetchPaged(symbol, kind, startTime, endTime) {
  const isFunding = kind === 'funding';
  const interval = kind === 'price' ? '1h' : kind === 'minute' ? '1m' : null;
  const limit = isFunding ? 1000 : 1500;
  const rows = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = new URL(`${API_HOST}${isFunding ? '/fapi/v1/fundingRate' : '/fapi/v1/klines'}`);
    url.searchParams.set('symbol', symbol);
    if (interval) url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endTime));
    url.searchParams.set('limit', String(limit));
    const page = await fetchJson(url);
    if (!page.length) break;
    for (const row of page) {
      if (isFunding) {
        rows.push({t: Number(row.fundingTime), rate: Number(row.fundingRate), markPrice: Number(row.markPrice) || null, fundingIntervalHours: null});
      } else {
        rows.push({t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), q: Number(row[7])});
      }
    }
    const last = isFunding ? Number(page.at(-1).fundingTime) : Number(page.at(-1)[0]);
    if (!(last >= cursor)) throw new Error(`Non-advancing Binance page for ${symbol}/${kind}`);
    cursor = last + (isFunding ? 1 : intervalToMs(interval));
    if (page.length < limit) break;
  }
  return rows.filter(row => row.t >= startTime && row.t < endTime);
}

function dailyKeys(symbol, kind, startTime, endTime) {
  if (kind === 'funding') return [];
  const interval = kind === 'price' ? '1h' : '1m';
  const keys = [];
  let cursor = Date.UTC(new Date(startTime).getUTCFullYear(), new Date(startTime).getUTCMonth(), new Date(startTime).getUTCDate());
  while (cursor < endTime) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    const key = `data/futures/um/daily/klines/${symbol}/${interval}/${symbol}-${interval}-${day}.zip`;
    keys.push({day, key, url: `${DATA_HOST}/${key}`, checksumUrl: `${DATA_HOST}/${key}.CHECKSUM`});
    cursor += 86_400_000;
  }
  return keys;
}

async function fetchDaily(symbol, kind, startTime, endTime) {
  const rows = [];
  const sources = [];
  for (const item of dailyKeys(symbol, kind, startTime, endTime)) {
    try {
      const [archive, checksumText] = await Promise.all([fetchBuffer(item.url), fetchBuffer(item.checksumUrl)]);
      const checksum = parseChecksum(checksumText.toString('utf8')).sha256;
      const actual = sha256(archive);
      if (checksum !== actual) throw new Error(`checksum mismatch ${item.key}`);
      rows.push(...normalizedRowsFromCsv(extractArchiveCsv(archive), kind));
      sources.push({sourceType: 'binance-data-vision-daily', sourceUrl: item.url, checksumUrl: item.checksumUrl, sourceSha256: actual, day: item.day});
    } catch {
      // Missing daily files are expected for some older symbols; REST is the documented fallback.
    }
  }
  return {rows: rows.filter(row => row.t >= startTime && row.t < endTime), sources};
}

function readRows(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

function writeRows(file, rows) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, zlib.gzipSync(JSON.stringify(rows)));
  fs.renameSync(temporary, file);
}

function mergeRows(existing, additions) {
  const byTimestamp = new Map(existing.map(row => [Number(row.t), row]));
  for (const row of additions) if (Number.isFinite(Number(row.t))) byTimestamp.set(Number(row.t), row);
  return [...byTimestamp.values()].sort((a, b) => a.t - b.t);
}

function rangesForReport(report, includeBoundary) {
  const ranges = new Map();
  const add = (entry, start, end, reason) => {
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) return;
    const key = `${entry.symbol}|${entry.artifactKind}`;
    if (!ranges.has(key)) ranges.set(key, {symbol: entry.symbol, kind: entry.artifactKind, ranges: []});
    ranges.get(key).ranges.push({start, end, reason});
  };
  for (const entry of report.continuityFailures || []) {
    for (const issue of entry.issues || []) {
      if (issue.reason === 'non-contiguous-timestamp') add(entry, timestampValue(issue.gapStart), timestampValue(issue.gapEnd), 'internal-gap');
    }
  }
  if (includeBoundary) {
    for (const entry of report.coverageFailures || []) {
      for (const issue of entry.issues || []) {
        if (issue.reason === 'active-start-not-covered' || issue.reason === 'funding-first-event-outside-window') add(entry, timestampValue(issue.gapStart), timestampValue(issue.gapEnd), issue.reason);
        if (issue.reason === 'active-end-not-covered' || issue.reason === 'funding-end-window-not-covered') add(entry, timestampValue(issue.gapStart), timestampValue(issue.gapEnd), issue.reason);
      }
    }
  }
  return [...ranges.values()];
}

async function main() {
  const args = parseArgs();
  if (!fs.existsSync(MANIFEST_FILE) || !fs.existsSync(REPORT_FILE)) throw new Error('manifest and failure inventory are required');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
  const candidates = rangesForReport(report, args.includeBoundary).slice(0, args.limit);
  const patchRoot = path.join(ROOT, 'source', 'gap-patches');
  fs.mkdirSync(patchRoot, {recursive: true});
  const applied = [];
  for (const candidate of candidates) {
    const artifact = (manifest.artifacts || []).find(item => item.symbol === candidate.symbol && item.kind === candidate.kind);
    if (!artifact?.path) continue;
    const artifactFile = path.join(APP_DIR, artifact.path);
    if (!fs.existsSync(artifactFile)) continue;
    const existing = readRows(artifactFile);
    let additions = [];
    const sourceRecords = [];
    for (const range of candidate.ranges) {
      const daily = await fetchDaily(candidate.symbol, candidate.kind, range.start, range.end);
      additions.push(...daily.rows);
      sourceRecords.push(...daily.sources);
      if (!daily.rows.length) {
        const restRows = await fetchPaged(candidate.symbol, candidate.kind, range.start, range.end);
        additions.push(...restRows);
        sourceRecords.push({sourceType: 'binance-usdm-rest', sourceUrl: `${API_HOST}${candidate.kind === 'funding' ? '/fapi/v1/fundingRate' : '/fapi/v1/klines'}`, requestedStart: iso(range.start), requestedEnd: iso(range.end), payloadSha256: sha256(Buffer.from(JSON.stringify(restRows))), rows: restRows.length});
      }
    }
    if (!additions.length) continue;
    const merged = mergeRows(existing, additions);
    writeRows(artifactFile, merged);
    artifact.rows = merged.length;
    artifact.sha256 = sha256(fs.readFileSync(artifactFile));
    artifact.firstTimestamp = merged[0]?.t ? new Date(merged[0].t).toISOString() : null;
    artifact.lastTimestamp = merged.at(-1)?.t ? new Date(merged.at(-1).t).toISOString() : null;
    const patchRecord = {symbol: candidate.symbol, kind: candidate.kind, ranges: candidate.ranges.map(range => ({...range, start: iso(range.start), end: iso(range.end)})), sources: sourceRecords, rowsAdded: additions.length, generatedAt: new Date().toISOString()};
    const patchFile = path.join(patchRoot, `${candidate.symbol}-${candidate.kind}-${Date.now()}.json`);
    fs.writeFileSync(patchFile, `${JSON.stringify(patchRecord, null, 2)}\n`);
    patchRecord.path = path.relative(APP_DIR, patchFile).replaceAll('\\', '/');
    patchRecord.sha256 = sha256(fs.readFileSync(patchFile));
    applied.push(patchRecord);
    console.log(`${candidate.symbol}/${candidate.kind}: added=${additions.length} rows=${merged.length}`);
  }
  manifest.sources = manifest.sources || {};
  manifest.sources.gapPatches = [...(manifest.sources.gapPatches || []), ...applied];
  manifest.retrievedAt = new Date().toISOString();
  const temporary = `${MANIFEST_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temporary, MANIFEST_FILE);
  console.log(JSON.stringify({candidates: candidates.length, applied: applied.length}, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
