import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_ROOT = path.join(APP_DIR, 'data', 'forward-research');
const API = 'https://fapi.binance.com/fapi/v1';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = {root: DEFAULT_ROOT, symbols: null, timeoutMs: 30_000};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--root') result.root = path.resolve(argv[++index]);
    if (value === '--symbols') result.symbols = String(argv[++index]).split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean);
    if (value === '--timeout-ms') result.timeoutMs = Math.max(1_000, Number(argv[++index]) || result.timeoutMs);
  }
  return result;
}

async function fetchJson(url, {timeoutMs = 30_000, retries = 2} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {signal: controller.signal, headers: {'accept': 'application/json', 'user-agent': 'TeleEdge-forward-research/1.0'}});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function endpoint(pathname, params = {}) {
  const url = new URL(`${API}/${pathname}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

function feedRecord({id, url, payload = null, error = null, sourceTimestamp = new Date().toISOString()}) {
  const bytes = payload == null ? null : jsonBytes(payload);
  return {
    id,
    url,
    ok: Boolean(bytes),
    sourceTimestamp,
    sha256: bytes ? sha256(bytes) : null,
    bytes: bytes?.length || 0,
    payload,
    error: error ? String(error.message || error) : null,
  };
}

export function completedOneHourKlines(payload, captureTime) {
  const cutoff = Date.parse(captureTime);
  if (!Array.isArray(payload) || !Number.isFinite(cutoff)) return [];
  // Keep a one-bar safety margin at the exact boundary so a candle whose
  // close coincides with captureTime is never treated as completed data.
  return payload.filter(row => Number(row?.[0]) + 3_600_000 < cutoff);
}

export function buildForwardSnapshot({captureTime, exchangeInfo, feeds = [], requestedSymbols = []} = {}) {
  const timestamp = captureTime || new Date().toISOString();
  const symbols = (exchangeInfo?.symbols || [])
    .filter(row => row?.quoteAsset === 'USDT' && ['PERPETUAL', 'TRADIFI_PERPETUAL'].includes(row?.contractType))
    .map(row => row.symbol).sort();
  const missingFeeds = feeds.filter(feed => !feed.ok).map(feed => ({id: feed.id, url: feed.url, error: feed.error || 'missing'}));
  const snapshot = {
    schemaVersion: 1,
    snapshotId: timestamp.replaceAll(/[^0-9A-Z]/gi, '-'),
    captureTime: timestamp,
    immutable: true,
    purpose: 'manual research-only forward capture; read-only market data',
    universe: {symbols, requestedSymbols: [...requestedSymbols].sort(), source: 'Binance USD-M exchangeInfo'},
    feeds: feeds.map(feed => ({id: feed.id, url: feed.url, ok: feed.ok, sourceTimestamp: feed.sourceTimestamp, sha256: feed.sha256, bytes: feed.bytes, error: feed.error})),
    dataFreshness: {capturedAt: timestamp, maxAgeSeconds: 600},
    missingFeeds,
    pitStatus: missingFeeds.length ? 'INCOMPLETE' : 'SNAPSHOT_COMPLETE',
    sourceEvidence: {exchangeInfo: feedRecord({id: 'exchangeInfo', url: `${API}/exchangeInfo`, payload: exchangeInfo})},
    payloads: {exchangeInfo, feeds: Object.fromEntries(feeds.filter(feed => feed.ok).map(feed => [feed.id, feed.payload]))},
  };
  const snapshotWithHashBasis = {
    ...snapshot,
    snapshotHashBasis: 'canonical snapshot JSON without snapshotSha256 field',
  };
  const immutableBytes = jsonBytes(snapshotWithHashBasis);
  return {
    ...snapshotWithHashBasis,
    snapshotSha256: sha256(immutableBytes),
  };
}

export function writeImmutableForwardSnapshot(root, snapshot) {
  const directory = path.join(root, snapshot.snapshotId);
  if (fs.existsSync(directory)) throw new Error(`forward snapshot already exists: ${directory}`);
  fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, 'snapshot.json');
  const bytes = jsonBytes(snapshot);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, {flag: 'wx'});
  fs.renameSync(temporary, file);
  fs.writeFileSync(`${file}.sha256`, `${sha256(bytes)}  snapshot.json\n`, {flag: 'wx'});
  return {directory, file, sha256: sha256(bytes)};
}

async function capture(args) {
  const captureTime = new Date().toISOString();
  const exchangeUrl = `${API}/exchangeInfo`;
  const exchangeInfo = await fetchJson(exchangeUrl, {timeoutMs: args.timeoutMs});
  const available = (exchangeInfo.symbols || [])
    .filter(row => row?.quoteAsset === 'USDT' && ['PERPETUAL', 'TRADIFI_PERPETUAL'].includes(row?.contractType))
    .map(row => row.symbol).sort();
  const requestedSymbols = args.symbols?.length ? args.symbols.filter(symbol => available.includes(symbol)) : available.slice(0, 10);
  const feeds = [];
  for (const symbol of requestedSymbols) {
    const requests = [
      ['price-1h', endpoint('klines', {symbol, interval: '1h', limit: 1000})],
      ['funding', endpoint('fundingRate', {symbol, limit: 1000})],
      ['premium-1h', endpoint('premiumIndexKlines', {symbol, interval: '1h', limit: 1000})],
      ['open-interest', endpoint('openInterestHist', {symbol, period: '5m', limit: 500})],
      ['global-long-short', endpoint('globalLongShortAccountRatio', {symbol, period: '5m', limit: 500})],
      ['top-trader-long-short', endpoint('topLongShortAccountRatio', {symbol, period: '5m', limit: 500})],
      ['taker-long-short', endpoint('takerlongshortRatio', {symbol, period: '5m', limit: 500})],
    ];
    const results = await Promise.all(requests.map(async ([id, url]) => {
      try {
        const rawPayload = await fetchJson(url, {timeoutMs: args.timeoutMs});
        const payload = id === 'price-1h' || id === 'premium-1h'
          ? completedOneHourKlines(rawPayload, captureTime)
          : rawPayload;
        return feedRecord({id: `${symbol}:${id}`, url, payload, sourceTimestamp: captureTime});
      }
      catch (error) { return feedRecord({id: `${symbol}:${id}`, url, error, sourceTimestamp: captureTime}); }
    }));
    feeds.push(...results);
  }
  const snapshot = buildForwardSnapshot({captureTime, exchangeInfo, feeds, requestedSymbols});
  return writeImmutableForwardSnapshot(args.root, snapshot);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  capture(parseArgs()).then(result => console.log(JSON.stringify({file: result.file, sha256: result.sha256}, null, 2))).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
