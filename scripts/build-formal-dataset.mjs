import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {execFile as execFileCallback} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import {promisify} from 'node:util';
import {CORE_MARKETS} from '../src/config.mjs';
import {verifyBacktestManifest} from './verify-backtest-data.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_ROOT = path.join(APP_DIR, 'data', 'backtest');
const DATA_HOST = 'https://data.binance.vision';
const S3_HOST = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';
const SOURCE_PREFIXES = Object.freeze({
  price: 'data/futures/um/monthly/klines',
  minute: 'data/futures/um/monthly/klines',
  funding: 'data/futures/um/monthly/fundingRate',
});
const FUNDING_INTERVAL_FALLBACK_HOURS = 8;
const DEFAULT_START = Date.parse('2021-01-01T00:00:00Z');
const DEFAULT_RETRIES = 4;
const DEFAULT_RATE_LIMIT_MS = 250;
const execFile = promisify(execFileCallback);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function xmlUnescape(value) {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'");
}

export function parseS3List(xml) {
  const values = (tag) => [...String(xml).matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))]
    .map(match => xmlUnescape(match[1]));
  return {
    keys: values('Key'),
    prefixes: values('Prefix'),
    isTruncated: /<IsTruncated>true<\/IsTruncated>/.test(String(xml)),
    nextContinuationToken: values('NextContinuationToken')[0] || null,
  };
}

export function parseChecksum(text) {
  const match = String(text).trim().match(/^([a-f0-9]{64})\s+(?:\*?)([^\s]+)$/i);
  if (!match) throw new Error(`Unrecognised Binance checksum: ${String(text).trim().slice(0, 160)}`);
  return {sha256: match[1].toLowerCase(), filename: match[2]};
}

export function isUsdtPerpetualArchiveSymbol(symbol) {
  return /^[A-Z0-9]+USDT$/.test(String(symbol || ''));
}

function monthValue(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})$/);
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
}

function timeValue(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function monthKeys(start, end) {
  const result = [];
  let cursor = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1);
  const final = Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), 1);
  while (cursor < final) {
    result.push(`${new Date(cursor).getUTCFullYear()}-${String(new Date(cursor).getUTCMonth() + 1).padStart(2, '0')}`);
    cursor = Date.UTC(new Date(cursor).getUTCFullYear(), new Date(cursor).getUTCMonth() + 1, 1);
  }
  return result;
}

export function parseArchiveKey(key) {
  const parts = String(key).split('/');
  const root = parts.slice(0, 5).join('/');
  if (root === 'data/futures/um/monthly/klines' && parts.length >= 8) {
    const symbol = parts[5];
    const interval = parts[6];
    const match = parts[7].match(new RegExp(`^${symbol}-(1m|1h)-(\\d{4}-\\d{2})\\.zip$`));
    if (match) return {key, symbol, kind: interval === '1m' ? 'minute' : interval === '1h' ? 'price' : null, interval, month: match[2]};
  }
  if (root === 'data/futures/um/monthly/fundingRate' && parts.length >= 7) {
    const symbol = parts[5];
    const match = parts[6].match(new RegExp(`^${symbol}-fundingRate-(\\d{4}-\\d{2})\\.zip$`));
    if (match) return {key, symbol, kind: 'funding', interval: 'event', month: match[1]};
  }
  return null;
}

function sourceUrl(key) {
  return `${DATA_HOST}/${key}`;
}

export function normalizedRowsFromCsv(text, kind) {
  const lines = String(text).split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const first = lines[0].replace(/^\uFEFF/, '').split(',').map(value => value.trim().toLowerCase());
  const hasHeader = first.some(value => /time|price|rate|symbol|open/.test(value)) && !Number.isFinite(Number(first[0]));
  const header = hasHeader ? first : null;
  const data = hasHeader ? lines.slice(1) : lines;
  const indexOf = names => header ? names.map(name => header.indexOf(name)).find(index => index >= 0) : -1;
  const rows = [];
  for (const line of data) {
    const fields = line.split(',').map(value => value.trim());
    if (kind === 'funding') {
      const timeIndex = indexOf(['calc_time', 'fundingtime', 'funding_time', 'timestamp']);
      const intervalIndex = indexOf(['funding_interval_hours', 'fundingintervalhours', 'interval_hours']);
      const markIndex = indexOf(['mark_price', 'markprice', 'mark']);
      const rateIndex = indexOf(['last_funding_rate', 'funding_rate', 'fundingrate', 'rate']);
      const t = Number(fields[timeIndex >= 0 ? timeIndex : 0]);
      if (!Number.isFinite(t)) continue;
      const rate = Number(fields[rateIndex >= 0 ? rateIndex : 2]);
      if (!Number.isFinite(rate)) continue;
      const fundingIntervalHours = intervalIndex >= 0 ? Number(fields[intervalIndex]) : null;
      const markPrice = markIndex >= 0 ? Number(fields[markIndex]) : null;
      rows.push({
        t,
        rate,
        fundingIntervalHours: Number.isFinite(fundingIntervalHours) && fundingIntervalHours > 0 ? fundingIntervalHours : null,
        markPrice: Number.isFinite(markPrice) && markPrice > 0 ? markPrice : null,
      });
    } else {
      const t = Number(fields[0]);
      if (!Number.isFinite(t)) continue;
      rows.push({
        t,
        o: Number(fields[1]),
        h: Number(fields[2]),
        l: Number(fields[3]),
        c: Number(fields[4]),
        q: Number(fields[7]),
      });
    }
  }
  return rows;
}

function zipEntries(buffer) {
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = buffer.lastIndexOf(eocdSignature);
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record missing');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  while (cursor < centralEnd && entries.length < count) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP central-directory entry missing');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP local header missing for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (!content || content.length !== uncompressedSize) throw new Error(`Unsupported or corrupt ZIP entry ${name}`);
    entries.push({name, content});
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function extractArchiveCsv(buffer) {
  const entry = zipEntries(buffer).find(item => item.name.toLowerCase().endsWith('.csv'));
  if (!entry) throw new Error('ZIP contains no CSV entry');
  return entry.content.toString('utf8');
}

class RequestGate {
  constructor(delayMs) {
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.nextAt = 0;
    this.queue = Promise.resolve();
  }

  async wait() {
    let release;
    const previous = this.queue;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    const delay = Math.max(0, this.nextAt - Date.now());
    if (delay) await sleep(delay);
    this.nextAt = Date.now() + this.delayMs;
    release();
  }
}

async function fetchResponse(url, {gate, retries = DEFAULT_RETRIES, headers = {}} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (gate) await gate.wait();
      const response = await fetch(url, {headers: {'user-agent': 'teleedge-formal-dataset/1.0', ...headers}});
      if (response.ok) return response;
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const message = `${response.status} ${url}`;
      if (!retryable) throw new Error(message);
      lastError = new Error(message);
      if (attempt === retries) break;
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 2 ** attempt * 1000);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(2 ** attempt * 1000);
    }
  }
  throw lastError || new Error(`Request failed: ${url}`);
}

async function curlBuffer(url, {gate, retries = DEFAULT_RETRIES, headers = {}} = {}) {
  const executable = process.platform === 'win32' ? 'curl.exe' : 'curl';
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (gate) await gate.wait();
      const args = ['-L', '--fail', '--silent', '--show-error', '--connect-timeout', '20', '--max-time', '600'];
      for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`);
      args.push(url);
      const result = await execFile(executable, args, {encoding: 'buffer', maxBuffer: 128 * 1024 * 1024});
      return result.stdout;
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(2 ** attempt * 1000);
    }
  }
  throw lastError || new Error(`curl failed: ${url}`);
}

async function powershellBuffer(url, {gate, retries = DEFAULT_RETRIES} = {}) {
  if (process.platform !== 'win32') throw new Error('PowerShell transport is only available on Windows');
  const escapedUrl = String(url).replaceAll("'", "''");
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (gate) await gate.wait();
      const command = `$ProgressPreference='SilentlyContinue'; $body=(Invoke-WebRequest -UseBasicParsing -Uri '${escapedUrl}').Content; if($body -is [byte[]]){[Console]::Write([Text.Encoding]::UTF8.GetString($body))}else{[Console]::Write([string]$body)}`;
      const result = await execFile('powershell.exe', ['-NoProfile', '-Command', command], {encoding: 'buffer', maxBuffer: 128 * 1024 * 1024});
      return result.stdout;
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(2 ** attempt * 1000);
    }
  }
  throw lastError || new Error(`PowerShell request failed: ${url}`);
}

async function fetchText(url, options = {}) {
  const isBinanceS3 = String(url).startsWith(S3_HOST);
  const isBinanceApi = String(url).startsWith('https://fapi.binance.com');
  if (process.platform === 'win32' && (isBinanceS3 || isBinanceApi || process.env.FORMAL_DATA_USE_CURL !== '1')) {
    try {
      return (await powershellBuffer(url, options)).toString('utf8');
    } catch (error) {
      if (process.env.FORMAL_DATA_USE_CURL === '0') throw error;
    }
  }
  if (process.env.FORMAL_DATA_USE_CURL !== '0') {
    try {
      return (await curlBuffer(url, options)).toString('utf8');
    } catch (error) {
      if (process.env.FORMAL_DATA_USE_CURL === '1') throw error;
    }
  }
  return (await fetchResponse(url, options)).text();
}

async function fetchJson(url, options = {}) {
  return JSON.parse(await fetchText(url, options));
}

async function listS3Keys(prefix, {gate, retries, maxKeys = 1000} = {}) {
  const keys = [];
  let continuationToken = null;
  do {
    const url = new URL(S3_HOST);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('max-keys', String(maxKeys));
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken);
    const page = parseS3List(await fetchText(url, {gate, retries}));
    keys.push(...page.keys);
    continuationToken = page.isTruncated ? page.nextContinuationToken : null;
    if (page.isTruncated && !continuationToken) throw new Error(`S3 listing truncated without continuation token: ${prefix}`);
  } while (continuationToken);
  return keys;
}

async function listS3Prefixes(prefix, {gate, retries, maxKeys = 1000} = {}) {
  const prefixes = [];
  let continuationToken = null;
  do {
    const url = new URL(S3_HOST);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('delimiter', '/');
    url.searchParams.set('max-keys', String(maxKeys));
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken);
    const page = parseS3List(await fetchText(url, {gate, retries}));
    prefixes.push(...page.prefixes);
    continuationToken = page.isTruncated ? page.nextContinuationToken : null;
    if (page.isTruncated && !continuationToken) throw new Error(`S3 prefix listing truncated without continuation token: ${prefix}`);
  } while (continuationToken);
  return prefixes;
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replaceAll("'", "''");
}

async function discoverActualArchiveKeysBatch(symbols, {rateLimitMs = DEFAULT_RATE_LIMIT_MS, retries = DEFAULT_RETRIES} = {}) {
  if (process.platform !== 'win32') throw new Error('PowerShell batch archive discovery is only available on Windows');
  const symbolJson = escapePowerShellSingleQuoted(JSON.stringify(symbols));
  const s3Host = escapePowerShellSingleQuoted(S3_HOST);
  const command = `$ProgressPreference='SilentlyContinue'; $symbols=ConvertFrom-Json '${symbolJson}'; $s3='${s3Host}'; $delay=${Math.max(0, Number(rateLimitMs) || 0)}; $retries=${Math.max(0, Number(retries) || 0)}; function Get-Keys([string]$prefix,[string]$symbol){ $uri=$s3+'?list-type=2&prefix='+[uri]::EscapeDataString($prefix+'/'+$symbol+'/')+'&max-keys=1000'; for($attempt=0;$attempt -le $retries;$attempt++){ try { $response=Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 120; $keys=@([regex]::Matches($response.Content,'<Key>(.*?)</Key>') | ForEach-Object { [System.Net.WebUtility]::HtmlDecode($_.Groups[1].Value) }); if($delay -gt 0){Start-Sleep -Milliseconds $delay}; return $keys } catch { if($attempt -ge $retries){ throw }; Start-Sleep -Seconds ([math]::Pow(2,$attempt)) } } }; $rows=@(); foreach($symbol in $symbols){ $rows += [pscustomobject]@{symbol=$symbol; klines=@(Get-Keys 'data/futures/um/monthly/klines' $symbol); funding=@(Get-Keys 'data/futures/um/monthly/fundingRate' $symbol)} }; $rows | ConvertTo-Json -Compress -Depth 5`;
  const result = await execFile('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const rows = JSON.parse(result.stdout || '[]');
  const values = Array.isArray(rows) ? rows : [rows];
  return Object.fromEntries(values.map(row => [row.symbol, {
    klines: (row.klines || []).filter(key => {
      const record = parseArchiveKey(key);
      return record?.kind === 'price' || record?.kind === 'minute';
    }),
    funding: (row.funding || []).filter(key => parseArchiveKey(key)?.kind === 'funding'),
  }]));
}

async function discoverActualArchiveKeys(symbols, {gate, retries, concurrency = 2, rateLimitMs = DEFAULT_RATE_LIMIT_MS} = {}) {
  if (process.platform === 'win32' && symbols.length) {
    const batchSize = 25;
    const batches = [];
    for (let index = 0; index < symbols.length; index += batchSize) batches.push(symbols.slice(index, index + batchSize));
    const batchResults = await mapConcurrent(batches, Math.min(8, Math.max(1, concurrency * 4)), batch => discoverActualArchiveKeysBatch(batch, {rateLimitMs, retries}));
    return Object.assign({}, ...batchResults);
  }
  const result = Object.fromEntries(symbols.map(symbol => [symbol, {klines: [], funding: []}]));
  await mapConcurrent(symbols, concurrency, async symbol => {
    const [klineKeys, fundingKeys] = await Promise.all([
      listS3Keys(`${SOURCE_PREFIXES.price}/${symbol}/`, {gate, retries}),
      listS3Keys(`${SOURCE_PREFIXES.funding}/${symbol}/`, {gate, retries}),
    ]);
    result[symbol] = {
      klines: klineKeys.filter(key => {
        const record = parseArchiveKey(key);
        return record?.kind === 'price' || record?.kind === 'minute';
      }),
      funding: fundingKeys.filter(key => parseArchiveKey(key)?.kind === 'funding'),
    };
  });
  return result;
}

async function writeText(file, value) {
  await fs.promises.mkdir(path.dirname(file), {recursive: true});
  await fs.promises.writeFile(file, value);
}

async function writeJson(file, value) {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
  return {path: file, sha256: sha256File(file)};
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  try {
    await writeText(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await fs.promises.rm(file, {force: true});
    await fs.promises.rename(temporary, file);
  } finally {
    await fs.promises.rm(temporary, {force: true});
  }
  return {path: file, sha256: sha256File(file)};
}

export function createSerializedProgressWriter(file, initial = {}) {
  let state = {...initial};
  let tail = Promise.resolve();
  const update = patch => {
    const next = tail.then(async () => {
      state = {...state, ...patch};
      await writeJsonAtomic(file, state);
      return {...state};
    });
    tail = next.catch(() => {});
    return next;
  };
  return {
    update,
    flush: () => tail,
    snapshot: () => ({...state}),
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = {
    start: DEFAULT_START,
    end: Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    root: DEFAULT_ROOT,
    symbols: null,
    maxSymbols: null,
    discoverOnly: false,
    keepSourceArchives: false,
    lifecycleEvidence: null,
    concurrency: 2,
    rateLimitMs: DEFAULT_RATE_LIMIT_MS,
    retries: DEFAULT_RETRIES,
  };
  const value = name => {
    const inline = argv.find(arg => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const date = (name, fallback) => {
    const raw = value(name);
    if (raw == null) return fallback;
    const parsed = Number.isFinite(Number(raw)) ? Number(raw) : Date.parse(raw);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}: ${raw}`);
    return parsed;
  };
  result.start = date('--start', result.start);
  result.end = date('--snapshot-end', result.end);
  result.root = path.resolve(value('--root') || result.root);
  const symbols = value('--symbols');
  result.symbols = symbols ? symbols.split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean) : null;
  const maxSymbols = value('--max-symbols');
  result.maxSymbols = maxSymbols == null ? null : Number(maxSymbols);
  result.discoverOnly = argv.includes('--discover-only');
  result.keepSourceArchives = argv.includes('--keep-source-archives');
  result.lifecycleEvidence = value('--historical-lifecycle-evidence');
  result.concurrency = Number(value('--concurrency') || result.concurrency);
  result.rateLimitMs = Number(value('--rate-limit-ms') || result.rateLimitMs);
  result.retries = Number(value('--retries') || result.retries);
  if (!(result.end > result.start)) throw new Error('snapshot-end must be after start');
  if (new Date(result.start).getUTCDate() !== 1 || new Date(result.start).getUTCHours() !== 0) throw new Error('Formal dataset start must be a UTC month boundary');
  if (new Date(result.end).getUTCDate() !== 1 || new Date(result.end).getUTCHours() !== 0) throw new Error('Formal dataset snapshot-end must be a UTC month boundary');
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 32) throw new Error('--concurrency must be an integer from 1 to 32');
  if (!Number.isFinite(result.maxSymbols) || result.maxSymbols < 1) result.maxSymbols = null;
  return result;
}

function symbolFromPrefix(prefix) {
  const parts = String(prefix).split('/').filter(Boolean);
  return parts.at(-1) || null;
}

export function archivesFromKeys(keys, start, end) {
  const startMonth = monthValue(`${new Date(start).getUTCFullYear()}-${String(new Date(start).getUTCMonth() + 1).padStart(2, '0')}`);
  const endMonth = monthValue(`${new Date(end).getUTCFullYear()}-${String(new Date(end).getUTCMonth() + 1).padStart(2, '0')}`);
  const values = Array.isArray(keys) ? keys : String(keys || '').split('\n');
  return values
    .map(value => value.trim())
    .filter(Boolean)
    .map(parseArchiveKey)
    .filter(record => record && monthValue(record.month) >= startMonth && monthValue(record.month) < endMonth)
    .sort((a, b) => monthValue(a.month) - monthValue(b.month) || a.key.localeCompare(b.key));
}

export function archivesBySymbolFromKeys(keysBySymbol, symbols, start, end) {
  const bySymbol = new Map(symbols.map(symbol => [symbol, {price: [], minute: [], funding: []}]));
  for (const symbol of symbols) {
    const archives = bySymbol.get(symbol);
    const actual = keysBySymbol?.[symbol] || {};
    const klineKeys = actual.klines || actual.price || [];
    archives.price = archivesFromKeys(klineKeys, start, end).filter(record => record.kind === 'price');
    archives.minute = archivesFromKeys(klineKeys, start, end).filter(record => record.kind === 'minute');
    archives.funding = archivesFromKeys(actual.funding || [], start, end).filter(record => record.kind === 'funding');
  }
  return bySymbol;
}

function currentPerpetualSymbols(exchangeInfo) {
  return new Map((exchangeInfo.symbols || [])
    .filter(item => item.quoteAsset === 'USDT' && item.contractType === 'PERPETUAL')
    .map(item => [item.symbol, item]));
}

function archiveWindow(archives, start, end) {
  const months = [...archives].sort((a, b) => monthValue(a.month) - monthValue(b.month));
  return {
    firstMonth: months[0]?.month || null,
    lastMonth: months.at(-1)?.month || null,
    firstMonthStart: months[0] ? monthValue(months[0].month) : null,
    lastMonthEnd: months.at(-1) ? Date.UTC(Number(months.at(-1).month.slice(0, 4)), Number(months.at(-1).month.slice(5)) , 1) : null,
    activeStart: start,
    activeEnd: end,
  };
}

export function lifecycleFromEvidence(symbol, {start, end, currentMarket, priceSummary, archiveWindowValue, lifecycleEvidence}) {
  const external = lifecycleEvidence?.[symbol] || {};
  const firstObserved = timeValue(priceSummary?.firstTimestamp);
  const lastObserved = timeValue(priceSummary?.lastTimestamp);
  const externalListingTime = timeValue(external.onboardTime ?? external.listingTime);
  const externalDeliveryTime = timeValue(external.deliveryTime);
  const externalDelistTime = timeValue(external.delistTime ?? externalDeliveryTime);
  const exchangeListingTime = timeValue(currentMarket?.onboardDate);
  const exchangeDeliveryTime = timeValue(currentMarket?.deliveryDate);
  const listingEvidenceTimestamp = Number.isFinite(externalListingTime)
    ? externalListingTime
    : exchangeListingTime;
  const hasListingEvidence = Number.isFinite(listingEvidenceTimestamp) && listingEvidenceTimestamp > 0;
  const listingEvidenceSource = hasListingEvidence
    ? (external.listingEvidenceSource || external.source || (currentMarket ? 'current-exchangeInfo.onboardDate' : 'historical-lifecycle-evidence-file'))
    : null;
  const delistEvidenceTimestamp = Number.isFinite(externalDelistTime)
    ? externalDelistTime
    : Number.isFinite(exchangeDeliveryTime) && exchangeDeliveryTime > 0 && exchangeDeliveryTime < end
      ? exchangeDeliveryTime
      : null;
  const hasDelistEvidence = Number.isFinite(delistEvidenceTimestamp) && delistEvidenceTimestamp > 0;
  const delistEvidenceSource = hasDelistEvidence
    ? (external.delistEvidenceSource || external.source || (currentMarket ? 'current-exchangeInfo.deliveryDate' : 'historical-lifecycle-evidence-file'))
    : currentMarket
      ? 'snapshot-active-through-end'
      : null;
  const inferredListing = Number.isFinite(firstObserved) ? firstObserved : archiveWindowValue.firstMonthStart;
  const inferredDelist = Number.isFinite(lastObserved)
    ? lastObserved + 3_600_000
    : archiveWindowValue.lastMonthEnd;
  const listingTime = Number.isFinite(listingEvidenceTimestamp) && listingEvidenceTimestamp > 0
    ? listingEvidenceTimestamp
    : inferredListing;
  const delistTime = Number.isFinite(delistEvidenceTimestamp) && delistEvidenceTimestamp > 0
    ? delistEvidenceTimestamp
    : !currentMarket ? inferredDelist : NaN;
  const historicalDelisted = !currentMarket || (Number.isFinite(delistEvidenceTimestamp) && delistEvidenceTimestamp < end);
  const listingExact = hasListingEvidence && Boolean(listingEvidenceSource);
  const delistExact = currentMarket
    ? !historicalDelisted || (Number.isFinite(delistEvidenceTimestamp) && Boolean(delistEvidenceSource))
    : hasDelistEvidence && Boolean(delistEvidenceSource);
  const lifecycleExact = listingExact && delistExact;
  const resolvedEnd = Number.isFinite(delistTime) && delistTime > 0 ? Math.min(end, delistTime) : end;
  const eligibleStart = Math.max(start, listingTime || start);
  return {
    symbol,
    onboardTime: Number.isFinite(listingTime) ? new Date(listingTime).toISOString() : null,
    listingTime: Number.isFinite(listingTime) ? new Date(listingTime).toISOString() : null,
    deliveryTime: Number.isFinite(externalDeliveryTime || exchangeDeliveryTime) && (externalDeliveryTime || exchangeDeliveryTime) > 0 && (externalDeliveryTime || exchangeDeliveryTime) < end ? new Date(externalDeliveryTime || exchangeDeliveryTime).toISOString() : null,
    delistTime: Number.isFinite(delistTime) && delistTime > 0 && delistTime < end ? new Date(delistTime).toISOString() : null,
    eligibleStart: new Date(eligibleStart).toISOString(),
    eligibleEnd: new Date(resolvedEnd).toISOString(),
    activeStart: new Date(eligibleStart).toISOString(),
    activeEnd: new Date(resolvedEnd).toISOString(),
    tier: CORE_MARKETS.has(symbol) ? 'core' : 'expanded',
    core: CORE_MARKETS.has(symbol),
    lifecycleExact,
    lifecycleSource: external.source || (currentMarket ? 'current-exchangeInfo-cross-check' : 'archive-observation-unresolved'),
    historicalDelistEvidence: !currentMarket && hasDelistEvidence && Boolean(delistEvidenceSource),
    inferredDelistFromLastKline: Boolean(!currentMarket && !Number.isFinite(externalDelistTime) && Number.isFinite(lastObserved)),
    inferredDelistFromArchiveWindow: Boolean(!currentMarket && !Number.isFinite(externalDelistTime) && !Number.isFinite(lastObserved) && archiveWindowValue.lastMonthEnd),
    actualFirstArchiveMonth: archiveWindowValue.firstMonth,
    actualLastArchiveMonth: archiveWindowValue.lastMonth,
    firstObserved: Number.isFinite(firstObserved) ? new Date(firstObserved).toISOString() : null,
    lastObserved: Number.isFinite(lastObserved) ? new Date(lastObserved).toISOString() : null,
    listingEvidenceSource,
    listingEvidenceTimestamp: hasListingEvidence ? new Date(listingEvidenceTimestamp).toISOString() : null,
    delistEvidenceSource,
    delistEvidenceTimestamp: hasDelistEvidence ? new Date(delistEvidenceTimestamp).toISOString() : null,
    archiveFirstMonth: archiveWindowValue.firstMonth,
    archiveLastMonth: archiveWindowValue.lastMonth,
    firstObservedPriceTimestamp: Number.isFinite(firstObserved) ? new Date(firstObserved).toISOString() : null,
    lastObservedPriceTimestamp: Number.isFinite(lastObserved) ? new Date(lastObserved).toISOString() : null,
  };
}

async function downloadArchive(record, {root, gate, retries, keepSourceArchives}) {
  const sourceDir = path.join(root, 'source', 'archives', record.kind, record.symbol);
  const target = path.join(sourceDir, path.basename(record.key));
  const part = `${target}.part`;
  await fs.promises.mkdir(sourceDir, {recursive: true});
  let checksumText;
  try {
    checksumText = await fetchText(`${sourceUrl(record.key)}.CHECKSUM`, {gate, retries});
  } catch (error) {
    const details = `${error.message || ''} ${error.stderr || ''}`;
    if (/404|not found|does not exist/i.test(details)) return null;
    throw error;
  }
  const checksum = parseChecksum(checksumText);
  const existing = fs.existsSync(target) ? sha256File(target) : null;
  if (existing !== checksum.sha256) {
    const offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const executable = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const download = async (resume) => {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          if (gate) await gate.wait();
          const args = ['-L', '--fail', '--silent', '--show-error', '--connect-timeout', '20', '--max-time', '1200'];
          if (resume) args.push('-C', '-');
          args.push('-o', part, sourceUrl(record.key));
          await execFile(executable, args, {encoding: 'buffer', maxBuffer: 16 * 1024 * 1024});
          return;
        } catch (error) {
          lastError = error;
          if (attempt === retries) break;
          await sleep(2 ** attempt * 1000);
        }
      }
      throw lastError || new Error(`curl download failed: ${record.key}`);
    };
    try {
      await download(offset > 0);
    } catch (error) {
      if (!offset) throw error;
      await fs.promises.rm(part, {force: true});
      await download(false);
    }
    const actual = sha256File(part);
    if (actual !== checksum.sha256) throw new Error(`SHA256 mismatch for ${record.key}: expected ${checksum.sha256}, actual ${actual}`);
    await fs.promises.rm(target, {force: true});
    await fs.promises.rename(part, target);
  }
  if (!keepSourceArchives) {
    return {...record, path: target, sourceSha256: checksum.sha256, sourceFileSize: fs.statSync(target).size, removeAfterUse: true};
  }
  return {...record, path: target, sourceSha256: checksum.sha256, sourceFileSize: fs.statSync(target).size, removeAfterUse: false};
}

async function writeArtifactFromArchives(archives, {root, symbol, kind, start, end}) {
  const directory = path.join(root, kind);
  await fs.promises.mkdir(directory, {recursive: true});
  const file = path.join(directory, `${symbol}.json.gz`);
  const output = fs.createWriteStream(file);
  const gzip = zlib.createGzip({level: 6});
  gzip.pipe(output);
  let first = true;
  let rows = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let previousTimestamp = null;
  const fundingDeltas = [];
  const fundingIntervals = [];
  gzip.write('[');
  for (const archive of archives) {
    const csv = extractArchiveCsv(fs.readFileSync(archive.path));
    const normalized = normalizedRowsFromCsv(csv, kind);
    normalized.sort((a, b) => a.t - b.t);
    for (const row of normalized) {
      if (row.t < start || row.t >= end) continue;
      if (previousTimestamp != null && row.t <= previousTimestamp) continue;
      if (previousTimestamp != null && kind === 'funding') fundingDeltas.push(row.t - previousTimestamp);
      if (kind === 'funding' && Number.isFinite(row.fundingIntervalHours) && row.fundingIntervalHours > 0) fundingIntervals.push(row.fundingIntervalHours);
      if (!first) gzip.write(',');
      first = false;
      if (!gzip.write(JSON.stringify(row))) await once(gzip, 'drain');
      rows++;
      firstTimestamp ??= row.t;
      lastTimestamp = row.t;
      previousTimestamp = row.t;
    }
  }
  gzip.write(']');
  gzip.end();
  await finished(output);
  const artifact = {
    path: path.relative(APP_DIR, file).replaceAll('\\', '/'),
    symbol,
    kind,
    interval: kind === 'funding' ? 'event' : kind === 'minute' ? '1m' : '1h',
    activeStart: new Date(start).toISOString(),
    activeEnd: new Date(end).toISOString(),
    rows,
    sha256: sha256File(file),
    firstTimestamp: firstTimestamp == null ? null : new Date(firstTimestamp).toISOString(),
    lastTimestamp: lastTimestamp == null ? null : new Date(lastTimestamp).toISOString(),
  };
  if (kind === 'funding') {
    const ordered = [...fundingIntervals].sort((a, b) => a - b);
    const deltaOrdered = [...fundingDeltas].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    const deltaMiddle = Math.floor(deltaOrdered.length / 2);
    const medianHours = ordered.length
      ? ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
      : deltaOrdered.length
        ? (deltaOrdered.length % 2 ? deltaOrdered[deltaMiddle] : (deltaOrdered[deltaMiddle - 1] + deltaOrdered[deltaMiddle]) / 2) / 3_600_000
        : FUNDING_INTERVAL_FALLBACK_HOURS;
    artifact.fundingIntervalHours = +Number(medianHours).toFixed(6);
    artifact.fundingIntervalSource = ordered.length ? 'observed-field' : deltaOrdered.length ? 'observed-timestamp-delta' : 'documented-fallback';
    if (!ordered.length && !deltaOrdered.length) artifact.fundingIntervalFallbackHours = FUNDING_INTERVAL_FALLBACK_HOURS;
  }
  for (const archive of archives) {
    if (archive.removeAfterUse) await fs.promises.rm(archive.path, {force: true});
  }
  return artifact;
}

async function mapConcurrent(items, concurrency, handler) {
  const result = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      result[index] = await handler(items[index], index);
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, worker));
  return result;
}

function loadLifecycleEvidence(file) {
  if (!file) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const records = Array.isArray(parsed) ? parsed : parsed.markets;
  if (!Array.isArray(records)) throw new Error('Historical lifecycle evidence must be an array or {markets: []}');
  const result = {};
  for (const record of records) {
    if (!record?.symbol) continue;
    if (result[record.symbol]) throw new Error(`Duplicate historical lifecycle evidence: ${record.symbol}`);
    result[record.symbol] = record;
  }
  return result;
}

function qualityReport(manifest, verifier, {currentSymbols, sourceIndex, root}) {
  const markets = manifest.universe.markets || [];
  const artifactByKey = new Map((manifest.artifacts || []).filter(item => item.symbol).map(item => [`${item.symbol}|${item.kind}`, item]));
  const resolvedMarkets = markets.filter(market => market.lifecycleExact === true);
  const unresolvedMarkets = markets.filter(market => market.lifecycleExact !== true);
  const years = {};
  for (let year = new Date(manifest.universe.backtestStart).getUTCFullYear(); year <= new Date(manifest.snapshotTimestamp).getUTCFullYear(); year++) {
    const yearStart = Date.UTC(year, 0, 1);
    const yearEnd = Date.UTC(year + 1, 0, 1);
    years[year] = resolvedMarkets.filter(market => Date.parse(market.activeStart) < yearEnd && Date.parse(market.activeEnd) > yearStart).length;
  }
  const bytes = (manifest.artifacts || []).reduce((total, artifact) => {
    const file = path.join(APP_DIR, artifact.path);
    return total + (fs.existsSync(file) ? fs.statSync(file).size : 0);
  }, 0);
  const missingByKind = Object.fromEntries(['price', 'funding', 'minute'].map(kind => [kind, manifest.universe.symbols.filter(symbol => {
    const artifact = artifactByKey.get(`${symbol}|${kind}`);
    return !artifact || Number(artifact.rows) <= 0;
  })]));
  return {
    generatedAt: new Date().toISOString(),
    snapshotEnd: manifest.snapshotTimestamp,
    start: manifest.universe.backtestStart,
    totalSymbols: manifest.universe.symbols.length,
    coreSymbols: manifest.universe.symbols.filter(symbol => CORE_MARKETS.has(symbol)).length,
    expandedSymbols: manifest.universe.symbols.filter(symbol => !CORE_MARKETS.has(symbol)).length,
    historicalDelistedSymbols: markets.filter(market => !currentSymbols.has(market.symbol)).length,
    currentSymbols: markets.filter(market => currentSymbols.has(market.symbol)).length,
    resolvedLifecycleSymbols: resolvedMarkets.length,
    unresolvedLifecycleSymbols: unresolvedMarkets.map(market => market.symbol),
    activeSymbolsByYear: years,
    missingArtifacts: missingByKind,
    dataRows: Object.fromEntries(['price', 'funding', 'minute'].map(kind => [kind, (manifest.artifacts || []).filter(item => item.kind === kind).reduce((sum, item) => sum + Number(item.rows || 0), 0)])),
    dataBytes: bytes,
    lifecycleEvidenceCoverage: {
      listingEvidence: markets.filter(market => market.listingEvidenceSource && market.listingEvidenceTimestamp).length,
      delistEvidence: markets.filter(market => market.delistEvidenceSource && market.delistEvidenceTimestamp).length,
      exactLifecycle: resolvedMarkets.length,
      unresolvedLifecycle: unresolvedMarkets.length,
    },
    sourceIndex: {
      path: path.relative(APP_DIR, sourceIndex.path).replaceAll('\\', '/'),
      sha256: sourceIndex.sha256,
      keyCounts: sourceIndex.keyCounts,
    },
    verifier: {
      complete: verifier.complete,
      status: verifier.status,
      missing: verifier.missing.length,
      mismatched: verifier.mismatched.length,
      rowCounts: verifier.rowCounts.length,
      continuity: verifier.continuity.length,
      coverage: verifier.coverage.length,
      contract: verifier.contract,
    },
    formalOosAllowed: verifier.complete,
  };
}

export async function buildFormalDataset(options = {}) {
  const args = {...parseArgs([]), ...options};
  if (!(args.end > args.start)) throw new Error('snapshot-end must be after start');
  const root = path.resolve(args.root || DEFAULT_ROOT);
  await fs.promises.mkdir(root, {recursive: true});
  const gate = new RequestGate(args.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS);
  const [symbolPrefixes, fundingPrefixes, exchangeInfo] = await Promise.all([
    listS3Prefixes(`${SOURCE_PREFIXES.price}/`, {gate, retries: args.retries}),
    listS3Prefixes(`${SOURCE_PREFIXES.funding}/`, {gate, retries: args.retries}),
    fetchJson('https://fapi.binance.com/fapi/v1/exchangeInfo', {gate, retries: args.retries}),
  ]);
  const discoveredSymbols = new Set([
    ...symbolPrefixes.map(symbolFromPrefix),
    ...fundingPrefixes.map(symbolFromPrefix),
  ].filter(isUsdtPerpetualArchiveSymbol));
  const exchangeInfoEvidence = await writeJson(path.join(root, 'source', 'current-exchangeInfo.json'), exchangeInfo);
  const currentSymbols = currentPerpetualSymbols(exchangeInfo);
  const candidateSymbols = [...discoveredSymbols]
    .filter(symbol => !currentSymbols.has(symbol) || timeValue(currentSymbols.get(symbol).onboardDate) < args.end)
    .sort();
  let requestedSymbols = candidateSymbols;
  if (args.symbols?.length) requestedSymbols = requestedSymbols.filter(symbol => args.symbols.includes(symbol));
  if (args.maxSymbols) requestedSymbols = requestedSymbols.slice(0, args.maxSymbols);
  const archiveIndexFile = path.join(root, 'source', 'archive-index.json');
  let cachedArchiveIndex = null;
  if (fs.existsSync(archiveIndexFile)) {
    try {
      const candidate = JSON.parse(fs.readFileSync(archiveIndexFile, 'utf8'));
      const cachedSymbols = candidate.actualArchiveKeysBySymbol || {};
      if (candidate.snapshotEnd === new Date(args.end).toISOString() && requestedSymbols.every(symbol => cachedSymbols[symbol])) cachedArchiveIndex = candidate;
    } catch {
      cachedArchiveIndex = null;
    }
  }
  const actualArchiveKeysBySymbol = cachedArchiveIndex
    ? Object.fromEntries(requestedSymbols.map(symbol => [symbol, cachedArchiveIndex.actualArchiveKeysBySymbol[symbol]]))
    : await discoverActualArchiveKeys(requestedSymbols, {
      gate,
      retries: args.retries,
      concurrency: args.concurrency ?? 2,
      rateLimitMs: args.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS,
    });
  const bySymbol = archivesBySymbolFromKeys(actualArchiveKeysBySymbol, requestedSymbols, args.start, args.end);
  let symbols = requestedSymbols.filter(symbol => {
    const archives = bySymbol.get(symbol);
    return archives && Object.values(archives).some(rows => rows.length > 0);
  }).sort();
  const lifecycleEvidence = loadLifecycleEvidence(args.lifecycleEvidence);
  const lifecycleEvidenceFile = args.lifecycleEvidence
    ? {path: path.relative(APP_DIR, path.resolve(args.lifecycleEvidence)).replaceAll('\\', '/'), sha256: sha256File(path.resolve(args.lifecycleEvidence))}
    : null;
  const sourceIndexPayload = {
    retrievedAt: new Date().toISOString(),
    snapshotEnd: new Date(args.end).toISOString(),
    source: 'Binance Data Vision S3 archive-key listing; current exchangeInfo is cross-check only',
    reusedCachedArchiveIndex: Boolean(cachedArchiveIndex),
    endpoints: {
      price: `${S3_HOST}?list-type=2&prefix=${SOURCE_PREFIXES.price}/{SYMBOL}/`,
      minute: `${S3_HOST}?list-type=2&prefix=${SOURCE_PREFIXES.minute}/{SYMBOL}/`,
      funding: `${S3_HOST}?list-type=2&prefix=${SOURCE_PREFIXES.funding}/{SYMBOL}/`,
    },
    requestedArchiveMonths: monthKeys(args.start, args.end),
    symbolPrefixes: {klines: symbolPrefixes, funding: fundingPrefixes},
    actualArchiveKeysBySymbol,
    symbolsWithActualArchives: symbols,
    symbolsWithoutActualArchives: requestedSymbols.filter(symbol => !symbols.includes(symbol)),
    keyCounts: {
      klineSymbolPrefixes: symbolPrefixes.length,
      fundingSymbolPrefixes: fundingPrefixes.length,
      discoveredUsdtPerpetualSymbols: discoveredSymbols.size,
      requestedSymbols: requestedSymbols.length,
      symbolsWithActualArchives: symbols.length,
      actualKlineArchives: Object.values(actualArchiveKeysBySymbol).reduce((sum, item) => sum + item.klines.length, 0),
      actualFundingArchives: Object.values(actualArchiveKeysBySymbol).reduce((sum, item) => sum + item.funding.length, 0),
    },
  };
  const sourceIndex = await writeJson(path.join(root, 'source', 'archive-index.json'), sourceIndexPayload);
  const archivesBySymbol = Object.fromEntries(symbols.map(symbol => [symbol, bySymbol.get(symbol)]));
  const artifacts = [];
  const summaries = new Map();
  const progressFile = path.join(root, 'progress.json');
  const progress = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, 'utf8')) : {};
  const progressWriter = createSerializedProgressWriter(progressFile, progress);

  if (!args.discoverOnly) {
    await mapConcurrent(symbols, args.concurrency ?? 2, async symbol => {
      const source = archivesBySymbol[symbol];
      for (const kind of ['price', 'funding', 'minute']) {
        const saved = progress[`${symbol}|${kind}`];
        const savedFile = saved?.path ? path.join(APP_DIR, saved.path) : null;
        if (savedFile && fs.existsSync(savedFile) && saved.sha256 === sha256File(savedFile)) {
          artifacts.push(saved);
          if (kind === 'price') summaries.set(symbol, saved);
          continue;
        }
        const records = [];
        for (const archive of source[kind]) {
          const downloaded = await downloadArchive(archive, {root, gate, retries: args.retries, keepSourceArchives: args.keepSourceArchives});
          if (downloaded) records.push(downloaded);
        }
        if (!records.length) continue;
        const artifact = await writeArtifactFromArchives(records, {root, symbol, kind, start: args.start, end: args.end});
        artifact.sourceArchiveCount = records.length;
        artifact.sourceArchiveSha256 = records.map(record => record.sourceSha256);
        artifacts.push(artifact);
        if (kind === 'price') summaries.set(symbol, artifact);
        await progressWriter.update({[`${symbol}|${kind}`]: {...artifact, completedAt: new Date().toISOString()}});
      }
    });
  }
  await progressWriter.flush();
  artifacts.sort((a, b) => `${a.symbol}|${a.kind}`.localeCompare(`${b.symbol}|${b.kind}`));

  const marketRecords = symbols.map(symbol => {
    const priceSummary = summaries.get(symbol);
    const archiveRows = Object.values(archivesBySymbol[symbol]).flat();
    const window = archiveWindow(archiveRows, args.start, args.end);
    return lifecycleFromEvidence(symbol, {
      start: args.start,
      end: args.end,
      currentMarket: currentSymbols.get(symbol),
      priceSummary,
      archiveWindowValue: window,
      lifecycleEvidence,
    });
  });
  const marketBySymbol = new Map(marketRecords.map(market => [market.symbol, market]));
  for (const artifact of artifacts) {
    const market = marketBySymbol.get(artifact.symbol);
    if (!market) continue;
    artifact.activeStart = market.activeStart;
    artifact.activeEnd = market.activeEnd;
  }
  const minuteComplete = symbols.length > 0 && symbols.every(symbol => artifacts.some(item => item.symbol === symbol && item.kind === 'minute' && item.rows > 0));
  const nonCoreComplete = symbols.some(symbol => !CORE_MARKETS.has(symbol)) && symbols.filter(symbol => !CORE_MARKETS.has(symbol)).every(symbol => ['price', 'funding', 'minute'].every(kind => artifacts.some(item => item.symbol === symbol && item.kind === kind && item.rows > 0)));
  const historicalSymbols = symbols.filter(symbol => !currentSymbols.has(symbol));
  const lifecycleGate = symbols.length > 0
    && marketRecords.length === symbols.length
    && marketRecords.every(market => market.lifecycleExact === true)
    && historicalSymbols.every(symbol => {
      const market = marketRecords.find(item => item.symbol === symbol);
      return market?.listingEvidenceSource && market?.listingEvidenceTimestamp && market?.delistEvidenceSource && market?.delistEvidenceTimestamp;
    });
  const manifest = {
    schemaVersion: 2,
    status: 'M4-INCOMPLETE',
    scope: 'formal dataset build; strict gate is required before any OOS strategy run',
    snapshotTimestamp: new Date(args.end).toISOString(),
    retrievedAt: new Date().toISOString(),
    hashAlgorithm: 'SHA-256',
    universe: {
      source: 'Binance Data Vision monthly USD-M archive index; current exchangeInfo is cross-check only',
      sourceEvidence: path.relative(APP_DIR, sourceIndex.path).replaceAll('\\', '/'),
      sourceEvidenceSha256: sourceIndex.sha256,
      currentExchangeInfoEvidence: path.relative(APP_DIR, exchangeInfoEvidence.path).replaceAll('\\', '/'),
      currentExchangeInfoSha256: exchangeInfoEvidence.sha256,
      historicalLifecycleEvidence: lifecycleEvidenceFile,
      pointInTime: lifecycleGate,
      historicalDelistingsResolved: lifecycleGate && historicalSymbols.every(symbol => marketRecords.find(item => item.symbol === symbol)?.historicalDelistEvidence === true),
      expandedNonCoreCovered: nonCoreComplete,
      backtestStart: new Date(args.start).toISOString(),
      symbols,
      markets: marketRecords,
      note: lifecycleGate
        ? 'All lifecycle records have timestamped listing and delist evidence, cross-checked against actual archive observations.'
        : 'Actual archive months were used for lifecycle windows, but one or more lifecycle records lack timestamped listing/delist evidence; inferred windows remain M4-INCOMPLETE.',
    },
    requiredAlphaCoverage: ['daily_breakout_long', 'funding_crowding_short', 'volume_shock_short', 'v8_bear_trend_short'],
    execution: {
      decisionLatencyMinutes: 20,
      preferredInterval: '1m',
      oneMinuteAvailable: true,
      oneMinuteDataComplete: minuteComplete,
      executionProxyAllowedOnlyInSmoke: true,
    },
    sources: {
      price: {provider: 'Binance Public Data Vision', endpoint: `${DATA_HOST}/data/futures/um/monthly/klines/{SYMBOL}/1h/{SYMBOL}-1h-{YYYY}-{MM}.zip`, interval: '1h', activeStart: new Date(args.start).toISOString(), activeEnd: new Date(args.end).toISOString(), checksum: 'sibling .CHECKSUM file'},
      minute: {provider: 'Binance Public Data Vision', endpoint: `${DATA_HOST}/data/futures/um/monthly/klines/{SYMBOL}/1m/{SYMBOL}-1m-{YYYY}-{MM}.zip`, interval: '1m', activeStart: new Date(args.start).toISOString(), activeEnd: new Date(args.end).toISOString(), checksum: 'sibling .CHECKSUM file'},
      funding: {provider: 'Binance Public Data Vision', endpoint: `${DATA_HOST}/data/futures/um/monthly/fundingRate/{SYMBOL}/{SYMBOL}-fundingRate-{YYYY}-{MM}.zip`, interval: 'event', fundingIntervalFallbackHours: FUNDING_INTERVAL_FALLBACK_HOURS, fundingIntervalSource: 'documented-fallback', note: 'Artifact-level observed fundingIntervalHours takes precedence; fallback is only used when fewer than two events are available.'},
      universe: {provider: 'Binance Public Data Vision S3 listing', endpoint: S3_HOST, snapshot: new Date(args.end).toISOString(), currentExchangeInfoCrossCheck: 'https://fapi.binance.com/fapi/v1/exchangeInfo'},
    },
    artifacts,
  };
  const manifestFile = path.join(root, 'manifest.json');
  await writeJson(manifestFile, manifest);
  let verifier = verifyBacktestManifest(manifest, APP_DIR);
  if (lifecycleGate) {
    manifest.status = 'COMPLETE';
    await writeJson(manifestFile, manifest);
    verifier = verifyBacktestManifest(manifest, APP_DIR);
    if (!verifier.complete) {
      manifest.status = 'M4-INCOMPLETE';
      await writeJson(manifestFile, manifest);
      verifier = verifyBacktestManifest(manifest, APP_DIR);
    }
  }
  const quality = qualityReport(manifest, verifier, {currentSymbols, sourceIndex, root});
  await writeJson(path.join(root, 'quality-report.json'), quality);
  await writeJson(path.join(root, 'snapshot-end.json'), {snapshotEnd: manifest.snapshotTimestamp, start: manifest.universe.backtestStart});
  console.log(JSON.stringify({
    manifest: path.relative(APP_DIR, manifestFile).replaceAll('\\', '/'),
    quality: path.relative(APP_DIR, path.join(root, 'quality-report.json')).replaceAll('\\', '/'),
    verifier: {
      status: verifier.status,
      complete: verifier.complete,
      snapshotTimestamp: verifier.snapshotTimestamp,
      artifacts: verifier.artifacts,
      symbols: verifier.universe.symbols.length,
      expandedSymbols: verifier.universe.expandedSymbols.length,
      missing: verifier.missing.length,
      mismatched: verifier.mismatched.length,
      rowCounts: verifier.rowCounts.length,
      continuity: verifier.continuity.length,
      coverage: verifier.coverage.length,
      contract: verifier.contract.length,
      firstContractReasons: verifier.contract.slice(0, 5),
    },
    formalOosAllowed: verifier.complete,
  }, null, 2));
  return {manifest, verifier, quality, sourceIndex};
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await buildFormalDataset(parseArgs());
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
