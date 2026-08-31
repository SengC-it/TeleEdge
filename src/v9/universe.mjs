import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {CORE_MARKETS} from '../config.mjs';

export const V9_UNIVERSE_HASH = 'ec12cd57cca7022ed6c8f2c26a10ff34424a8513fbd6be091bdb359c06dc9b43';
const FROZEN_SELECTION_START = Date.parse('2025-01-01T00:00:00Z');
const FROZEN_SELECTION_END = Date.parse('2026-01-01T00:00:00Z');

function parseTime(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function durationBand(market, start, end) {
  const activeStart = Math.max(start, parseTime(market?.activeStart ?? market?.eligibleStart, start));
  const activeEnd = Math.min(end, parseTime(market?.activeEnd ?? market?.eligibleEnd, end));
  const days = Math.max(0, activeEnd - activeStart) / 86_400_000;
  return days >= 240 ? 'long-history' : days >= 120 ? 'medium-history' : 'recent-listing';
}

export function selectV9Symbols(symbols, markets, start, end, limit = 150) {
  const sorted = [...new Set(symbols || [])].filter(symbol => markets.has(symbol)).sort();
  if (!(limit > 0) || sorted.length <= limit) return {symbols: sorted, mode: 'full-clean-eligible'};
  const groups = new Map();
  for (const symbol of sorted) {
    const market = markets.get(symbol);
    const key = `${market?.core ? 'core' : 'expanded'}|${durationBand(market, start, end)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(symbol);
  }
  for (const rows of groups.values()) rows.sort();
  const keys = ['core|long-history', 'core|medium-history', 'core|recent-listing', 'expanded|long-history', 'expanded|medium-history', 'expanded|recent-listing'];
  const cursors = new Map(keys.map(key => [key, 0]));
  const selected = [];
  while (selected.length < limit) {
    let added = false;
    for (const key of keys) {
      const rows = groups.get(key) || [];
      const cursor = cursors.get(key) || 0;
      if (cursor >= rows.length || selected.length >= limit) continue;
      selected.push(rows[cursor]);
      cursors.set(key, cursor + 1);
      added = true;
    }
    if (!added) break;
  }
  if (sorted.includes('BTCUSDT') && !selected.includes('BTCUSDT')) {
    selected.pop();
    selected.push('BTCUSDT');
  }
  return {symbols: selected.sort(), mode: 'stratified-fallback'};
}

export function symbolsHash(symbols) {
  return crypto.createHash('sha256').update([...(symbols || [])].sort().join('\n')).digest('hex');
}

export function loadV9Universe(dataRoot, appDir, {start, end, limit = 150} = {}) {
  const manifestFile = path.join(dataRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const eligibleFile = path.join(appDir, 'reports', 'fast-oos-universe.json');
  const eligible = fs.existsSync(eligibleFile) ? JSON.parse(fs.readFileSync(eligibleFile, 'utf8')) : {};
  const markets = new Map((manifest.universe?.markets || []).map(item => [item.symbol, {...item, core: item.core ?? CORE_MARKETS.has(item.symbol)}]));
  const preferred = Array.isArray(eligible.eligibleSymbols) ? eligible.eligibleSymbols : manifest.universe?.symbols || [];
  // V8.1's 150-symbol stratification is a frozen input to V9. The V9
  // Development window must not silently change its composition.
  const selection = selectV9Symbols(preferred, markets, FROZEN_SELECTION_START, FROZEN_SELECTION_END, limit);
  const exchangeFile = path.join(dataRoot, 'source', 'current-exchangeInfo.json');
  const exchange = fs.existsSync(exchangeFile) ? JSON.parse(fs.readFileSync(exchangeFile, 'utf8')) : {symbols: []};
  const exchangeBySymbol = new Map((exchange.symbols || []).map(item => [item.symbol, item]));
  return {
    manifest, manifestFile, markets, exchangeBySymbol,
    requestedSymbols: [...new Set(preferred)].filter(symbol => markets.has(symbol)).length,
    symbols: selection.symbols, selectionMode: selection.mode,
    source: Array.isArray(eligible.eligibleSymbols) ? 'reports/fast-oos-universe.json' : 'data/backtest/manifest.json',
    symbolsHash: symbolsHash(selection.symbols),
    expectedHash: V9_UNIVERSE_HASH,
  };
}

export function activeWindow(market, start, end) {
  const activeStart = Math.max(start, parseTime(market?.activeStart ?? market?.eligibleStart, start));
  const activeEnd = Math.min(end, parseTime(market?.activeEnd ?? market?.eligibleEnd, end));
  return {activeStart, activeEnd, active: activeStart < activeEnd};
}
