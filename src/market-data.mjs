import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {DAY, H1, RUNTIME_DIR, WORKSPACE_DIR, runtimeConfig} from './config.mjs';
import {atomicWriteJson, readJson} from './storage.mjs';
import {fetchHourlyRange, getExchangeInfo, getFundingRates} from './binance.mjs';

const PRICE_RUNTIME_DIR = path.join(RUNTIME_DIR, 'market', 'price');
const FUNDING_RUNTIME_DIR = path.join(RUNTIME_DIR, 'market', 'funding');
const localExchangeInfoFile = path.join(WORKSPACE_DIR, 'v60_full_universe_cache', 'exchangeInfo.json');

function indexFiles(directory) {
  if (!fs.existsSync(directory)) return new Map();
  const output = new Map();
  for (const name of fs.readdirSync(directory)) {
    const match = name.match(/^(.+?)-(\d+)\.(?:csv|json)\.gz$/);
    if (!match) continue;
    const [, symbol, start] = match;
    const previous = output.get(symbol);
    if (!previous || +start < previous.start) output.set(symbol, {file: path.join(directory, name), start: +start});
  }
  return output;
}

const v60Prices = indexFiles(path.join(WORKSPACE_DIR, 'v60_full_universe_cache', 'price'));
const v38Prices = indexFiles(path.join(WORKSPACE_DIR, 'v38_price_cache'));
const v60Funding = indexFiles(path.join(WORKSPACE_DIR, 'v60_full_universe_cache', 'funding'));
const v38Funding = indexFiles(path.join(WORKSPACE_DIR, 'v38_funding_cache'));

function parseGzip(file, columns) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim();
  if (!text) return [];
  if (file.endsWith('.json.gz')) return JSON.parse(text);
  return text.split(/\r?\n/).slice(1).map(line => {
    const values = line.split(',');
    return Object.fromEntries(columns.map((column, index) => [column, +values[index]]));
  });
}

function mergeByTime(...groups) {
  const values = new Map();
  for (const group of groups) for (const row of group || []) values.set(+row.t, row);
  return [...values.values()].sort((a, b) => a.t - b.t);
}

function basePriceFile(symbol) {
  return v60Prices.get(symbol)?.file || v38Prices.get(symbol)?.file || null;
}

function baseFundingFile(symbol) {
  return v60Funding.get(symbol)?.file || v38Funding.get(symbol)?.file || null;
}

export async function loadExchangeInfo() {
  if (!runtimeConfig.offline) {
    try {
      return await getExchangeInfo();
    } catch (error) {
      const local = JSON.parse(fs.readFileSync(localExchangeInfoFile, 'utf8'));
      local._fallbackError = String(error);
      return local;
    }
  }
  return JSON.parse(fs.readFileSync(localExchangeInfoFile, 'utf8'));
}

export async function loadPriceHistory(symbol, endTime) {
  const baseFile = basePriceFile(symbol);
  const base = baseFile ? parseGzip(baseFile, ['t', 'o', 'h', 'l', 'c', 'q', 'tq']) : [];
  const runtimeFile = path.join(PRICE_RUNTIME_DIR, `${symbol}.json`);
  let live = readJson(runtimeFile, []);
  let rows = mergeByTime(base, live);
  const baseLast = base.at(-1)?.t ?? -Infinity;
  if (!runtimeConfig.offline) {
    const start = rows.length ? rows.at(-1).t + H1 : endTime - 260 * DAY;
    if (start < endTime) {
      const fetched = await fetchHourlyRange(symbol, start, endTime);
      rows = mergeByTime(rows, fetched);
      live = rows.filter(row => row.t > baseLast).slice(-7000);
      atomicWriteJson(runtimeFile, live);
    }
  }
  return rows.filter(row => row.t + H1 <= endTime);
}

export async function loadFundingHistory(symbol, endTime) {
  const baseFile = baseFundingFile(symbol);
  const base = baseFile ? parseGzip(baseFile, ['t', 'rate']) : [];
  const runtimeFile = path.join(FUNDING_RUNTIME_DIR, `${symbol}.json`);
  let live = readJson(runtimeFile, []);
  let rows = mergeByTime(base, live);
  const baseLast = base.at(-1)?.t ?? -Infinity;
  if (!runtimeConfig.offline) {
    let cursor = rows.length ? rows.at(-1).t + 1 : Math.max(0, endTime - 40 * DAY);
    const fetched = [];
    while (cursor < endTime) {
      const batch = await getFundingRates(symbol, {startTime: cursor, endTime, limit: 1000});
      if (!Array.isArray(batch) || !batch.length) break;
      for (const row of batch) fetched.push({t: +row.fundingTime, rate: +row.fundingRate, markPrice: +row.markPrice || null});
      const next = +batch.at(-1).fundingTime + 1;
      if (next <= cursor) break;
      cursor = next;
      if (batch.length < 1000) break;
    }
    if (fetched.length) {
      rows = mergeByTime(rows, fetched);
      live = rows.filter(row => row.t > baseLast).slice(-1200);
      atomicWriteJson(runtimeFile, live);
    }
  }
  return rows.filter(row => row.t < endTime);
}

export function marketRules(market) {
  const price = market.filters?.find(filter => filter.filterType === 'PRICE_FILTER');
  const lot = market.filters?.find(filter => filter.filterType === 'LOT_SIZE');
  return {
    tickSize: +(price?.tickSize || 0),
    stepSize: +(lot?.stepSize || 0),
    minQty: +(lot?.minQty || 0),
  };
}

export function roundDown(value, step) {
  if (!(step > 0)) return value;
  return Math.floor((value + step * 1e-9) / step) * step;
}

export function roundToTick(value, tick) {
  if (!(tick > 0)) return value;
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)));
  return +((Math.round(value / tick) * tick).toFixed(decimals));
}
