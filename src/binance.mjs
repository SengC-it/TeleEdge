import {setTimeout as delay} from 'node:timers/promises';
import {H1, runtimeConfig} from './config.mjs';

const BASE_URL = 'https://fapi.binance.com';

function url(pathname, parameters = {}) {
  const output = new URL(pathname, BASE_URL);
  for (const [key, value] of Object.entries(parameters)) {
    if (value != null) output.searchParams.set(key, String(value));
  }
  return output;
}

export async function fetchJson(pathname, parameters = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url(pathname, parameters), {
        headers: {'user-agent': 'teleedge/1.0'},
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Binance HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(300 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export async function getExchangeInfo() {
  return fetchJson('/fapi/v1/exchangeInfo');
}

export async function getKlines(symbol, interval, parameters = {}) {
  return fetchJson('/fapi/v1/klines', {symbol, interval, ...parameters});
}

export async function getFundingRates(symbol, parameters = {}) {
  return fetchJson('/fapi/v1/fundingRate', {symbol, ...parameters});
}

export function klineToBar(row) {
  return {t: +row[0], o: +row[1], h: +row[2], l: +row[3], c: +row[4], q: +row[7], closeTime: +row[6]};
}

export async function fetchHourlyRange(symbol, startTime, endTime) {
  const rows = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const remaining = Math.ceil((endTime - cursor) / H1);
    const limit = Math.min(1500, Math.max(1, remaining));
    const batch = await getKlines(symbol, '1h', {startTime: cursor, endTime: endTime - 1, limit});
    if (!Array.isArray(batch) || !batch.length) break;
    for (const row of batch) rows.push(klineToBar(row));
    const next = +batch.at(-1)[0] + H1;
    if (next <= cursor) break;
    cursor = next;
    if (batch.length < limit) break;
    if (runtimeConfig.requestDelayMs) await delay(runtimeConfig.requestDelayMs);
  }
  return rows.filter(row => row.t + H1 <= endTime);
}

export async function fetchMinuteRange(symbol, startTime, endTime) {
  const minute = 60_000;
  const rows = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const batch = await getKlines(symbol, '1m', {startTime: cursor, endTime, limit: 1500});
    if (!Array.isArray(batch) || !batch.length) break;
    for (const row of batch) rows.push(klineToBar(row));
    const next = +batch.at(-1)[0] + minute;
    if (next <= cursor) break;
    cursor = next;
    if (batch.length < 1500) break;
    if (runtimeConfig.requestDelayMs) await delay(runtimeConfig.requestDelayMs);
  }
  return rows;
}

export async function mapLimit(items, concurrency, worker) {
  const output = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
      if (runtimeConfig.requestDelayMs) await delay(runtimeConfig.requestDelayMs);
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, run));
  return output;
}
