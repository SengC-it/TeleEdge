import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {intervalToMs} from './backtest-data.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = path.join(APP_DIR, 'data', 'backtest');
const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];

function cliValue(name, fallback = null) {
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

async function fetchJson(url) {
  const result = await fetch(url, {headers: {'user-agent': 'teleedge-backtest-fetch/1.0'}});
  if (!result.ok) throw new Error(`${result.status} ${url}: ${(await result.text()).slice(0, 300)}`);
  return result.json();
}

export async function fetchPaged(pathname, parameters, {rowLimit = 1500, mapRow = row => row, fetchPage = fetchJson} = {}) {
  const rows = [];
  let startTime = parameters.startTime;
  const isFunding = pathname.includes('fundingRate');
  const step = isFunding ? 1 : intervalToMs(parameters.interval);
  while (startTime < parameters.endTime) {
    const url = new URL(`https://fapi.binance.com${pathname}`);
    for (const [key, value] of Object.entries({...parameters, startTime, limit: rowLimit})) url.searchParams.set(key, String(value));
    const page = await fetchPage(url);
    if (!page.length) break;
    rows.push(...page.map(mapRow));
    const lastTime = isFunding
      ? Number(page.at(-1).fundingTime)
      : Number(page.at(-1)[0]);
    if (!(lastTime >= startTime)) throw new Error(`Non-advancing Binance page for ${pathname}`);
    startTime = lastTime + step;
    if (page.length < rowLimit) break;
  }
  return rows.filter(row => row.t >= parameters.startTime && row.t < parameters.endTime);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function writeArtifact(directory, symbol, rows, interval = null) {
  fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, `${symbol}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(rows)));
  return {
    path: path.relative(APP_DIR, file).replaceAll('\\', '/'),
    rows: rows.length,
    sha256: sha256(file),
    ...(interval ? {interval} : {}),
  };
}

export async function fetchBacktestData({
  start = Date.parse('2021-01-01T00:00:00Z'),
  end = Date.parse('2026-07-15T00:00:00Z'),
  symbols = DEFAULT_SYMBOLS,
  includeOneMinute = false,
} = {}) {
  if (!(end > start) || !symbols.length) throw new Error('Use a positive start/end range and at least one symbols value');

  const exchangeInfo = await fetchJson('https://fapi.binance.com/fapi/v1/exchangeInfo');
  fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.writeFileSync(path.join(DATA_DIR, 'exchangeInfo.json'), `${JSON.stringify(exchangeInfo, null, 2)}\n`);
  fs.writeFileSync(path.join(DATA_DIR, 'snapshotEnd.json'), `${JSON.stringify({snapshotEnd: new Date(end).toISOString()})}\n`);

  const artifacts = [
    {path: 'data/backtest/exchangeInfo.json', rows: exchangeInfo.symbols?.length ?? 0, sha256: sha256(path.join(DATA_DIR, 'exchangeInfo.json')), kind: 'universe'},
    {path: 'data/backtest/snapshotEnd.json', rows: 1, sha256: sha256(path.join(DATA_DIR, 'snapshotEnd.json')), kind: 'snapshot'},
  ];
  for (const symbol of symbols) {
    const [price, funding] = await Promise.all([
      fetchPaged('/fapi/v1/klines', {symbol, interval: '1h', startTime: start, endTime: end}, {
        mapRow: row => ({t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), q: Number(row[7])}),
      }),
      fetchPaged('/fapi/v1/fundingRate', {symbol, startTime: start, endTime: end}, {
        rowLimit: 1000,
        mapRow: row => ({t: Number(row.fundingTime), rate: Number(row.fundingRate), markPrice: Number(row.markPrice) || null}),
      }),
    ]);
    artifacts.push({...writeArtifact(path.join(DATA_DIR, 'price'), symbol, price, '1h'), kind: 'price', symbol});
    artifacts.push({...writeArtifact(path.join(DATA_DIR, 'funding'), symbol, funding), kind: 'funding', symbol});
    let minute = [];
    if (includeOneMinute) {
      minute = await fetchPaged('/fapi/v1/klines', {symbol, interval: '1m', startTime: start, endTime: end}, {
        mapRow: row => ({t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), q: Number(row[7])}),
      });
      artifacts.push({...writeArtifact(path.join(DATA_DIR, 'minute'), symbol, minute, '1m'), kind: 'minute', symbol});
    }
    console.log(`${symbol}: price=${price.length} funding=${funding.length} minute=${minute.length}`);
  }

  const manifest = {
    schemaVersion: 1,
    status: 'M4-INCOMPLETE',
    scope: 'artifact snapshot; formal OOS remains incomplete until point-in-time universe is supplied',
    snapshotTimestamp: new Date(end).toISOString(),
    retrievedAt: new Date().toISOString(),
    universe: {
      source: 'Binance USD-M exchangeInfo snapshot',
      pointInTime: false,
      historicalDelistingsResolved: false,
      symbols,
      exchangeInfoSymbols: exchangeInfo.symbols?.filter(item => item.quoteAsset === 'USDT' && item.contractType === 'PERPETUAL').map(item => item.symbol) ?? [],
      note: 'Current exchangeInfo cannot reconstruct symbols that delisted before the snapshot. Supply dated exchangeInfo snapshots before declaring M4 complete.',
    },
    requiredAlphaCoverage: ['daily_breakout_long', 'funding_crowding_short', 'volume_shock_short', 'v8_bear_trend_short'],
    execution: {
      decisionLatencyMinutes: 20,
      preferredInterval: '1m',
      oneMinuteAvailable: includeOneMinute,
      executionProxyAllowedOnlyInSmoke: true,
    },
    sources: {
      price: {provider: 'Binance USD-M Futures REST API', endpoint: 'https://fapi.binance.com/fapi/v1/klines', interval: '1h'},
      funding: {provider: 'Binance USD-M Futures REST API', endpoint: 'https://fapi.binance.com/fapi/v1/fundingRate'},
      universe: {provider: 'Binance USD-M Futures REST API', endpoint: 'https://fapi.binance.com/fapi/v1/exchangeInfo'},
    },
    artifacts,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${path.join(DATA_DIR, 'manifest.json')}`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const start = dateValue(cliValue('--start', '2021-01-01T00:00:00Z'), Date.parse('2021-01-01T00:00:00Z'));
  const end = dateValue(cliValue('--end', '2026-07-15T00:00:00Z'), Date.parse('2026-07-15T00:00:00Z'));
  const symbols = (cliValue('--symbols', DEFAULT_SYMBOLS.join(',')) || '')
    .split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
  const includeOneMinute = process.argv.includes('--include-1m') || process.env.BACKTEST_INCLUDE_1M === '1';
  await fetchBacktestData({start, end, symbols, includeOneMinute});
}
