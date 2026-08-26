import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {DAY, H1} from '../config.mjs';
import {directionalOutcome, fourHourBars, prepareFeatureSeries} from './features.mjs';
import {ALPHA_REGISTRY, RESEARCH_ALPHA_IDS, validateAlphaRegistry} from './alpha-registry.mjs';
import {scoreCandidate} from './scoring.mjs';
import {SCORING_CONFIG} from './scoring.mjs';
import {mergeResearchCandidates, rankResearchCandidates} from './dedupe.mjs';
import {TIER_THRESHOLDS} from './tiers.mjs';
import {createMonthlyFrequency, frequencySummary, recordMonthlyObservation} from './metrics.mjs';
import {dedupeResearchEpisodes} from './episodes.mjs';
import {simulatePortfolio, PORTFOLIO_CONFIG} from './portfolio.mjs';
import {evaluateCandidateAcceptance} from '../portfolio.mjs';
import {detectTrendPullback} from './alphas/trend-pullback.mjs';
import {detectVolatilityExpansion} from './alphas/volatility-expansion.mjs';
import {detectFailedBreakout} from './alphas/failed-breakout.mjs';
import {detectMeanReversion} from './alphas/mean-reversion.mjs';
import {detectFundingDivergence} from './alphas/funding-divergence.mjs';
import {detectRelativeStrength} from './alphas/relative-strength.mjs';

const DETECTORS = Object.freeze({
  trend_pullback_continuation: detectTrendPullback,
  volatility_expansion: detectVolatilityExpansion,
  failed_breakout_reversal: detectFailedBreakout,
  mean_reversion_extreme: detectMeanReversion,
  funding_price_divergence: detectFundingDivergence,
  relative_strength_btc_rotation: detectRelativeStrength,
});

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(temporary, content, 'utf8');
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if (!['EPERM', 'EXDEV'].includes(error.code)) throw error;
    // The managed Windows workspace can deny rename even within one directory.
    // The normal path remains atomic; this single-process fallback preserves
    // serialized progress rather than losing the checkpoint.
    fs.copyFileSync(temporary, file);
    fs.unlinkSync(temporary);
  }
}

function readJson(file, fallback = null) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function gzipRows(file) {
  if (!fs.existsSync(file)) return [];
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim();
  return text ? JSON.parse(text) : [];
}

function symbolFiles(directory, symbol) {
  if (!fs.existsSync(directory)) return [];
  const exact = `${symbol}.json.gz`;
  const files = fs.readdirSync(directory).filter(name => name === exact || name.startsWith(`${symbol}-`)).sort();
  return files.map(name => path.join(directory, name));
}

function loadRows(dataRoot, kind, symbol, startTime = -Infinity, endTime = Infinity) {
  const directory = path.join(dataRoot, kind);
  const byTime = new Map();
  for (const file of symbolFiles(directory, symbol)) {
    for (const source of gzipRows(file)) {
      const t = Number(source.t ?? source.fundingTime);
      if (!Number.isFinite(t) || t < startTime || t >= endTime) continue;
      const row = kind === 'funding'
        ? {t, rate: Number(source.rate ?? source.fundingRate), fundingIntervalHours: Number(source.fundingIntervalHours) || null, markPrice: Number(source.markPrice) > 0 ? Number(source.markPrice) : null}
        : {t, o: Number(source.o), h: Number(source.h), l: Number(source.l), c: Number(source.c), q: Number(source.q || 0)};
      byTime.set(t, row);
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function computeTouchProfile(position, rows, endTime) {
  const interval = H1 / 60;
  const firstEligible = Math.ceil(Number(position.fillTime) / interval) * interval;
  const entry = Number(position.entry);
  const direction = position.side === 'long' ? 1 : -1;
  let touch = null;
  let mfe = -Infinity;
  let mae = Infinity;
  for (const row of rows) {
    const openTime = Number(row.t);
    const closeTime = openTime + interval;
    if (openTime < firstEligible || closeTime > Number(endTime)) continue;
    const favorable = direction === 1 ? Number(row.h) / entry - 1 : 1 - Number(row.l) / entry;
    const adverse = direction === 1 ? Number(row.l) / entry - 1 : 1 - Number(row.h) / entry;
    mfe = Math.max(mfe, favorable);
    mae = Math.min(mae, adverse);
    const stopHit = position.side === 'long' ? Number(row.l) <= Number(position.stop) : Number(row.h) >= Number(position.stop);
    const targetHit = position.side === 'long' ? Number(row.h) >= Number(position.target) : Number(row.l) <= Number(position.target);
    if (stopHit || targetHit) {
      touch = {
        reason: stopHit ? 'sl' : 'tp',
        price: stopHit ? Number(position.stop) : Number(position.target),
        time: closeTime,
        ambiguous: Boolean(stopHit && targetHit),
      };
      break;
    }
  }
  return {
    touch,
    mfe: Number.isFinite(mfe) ? mfe : null,
    mae: Number.isFinite(mae) ? mae : null,
  };
}

function upperBoundRows(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].t) <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function buildMinuteQuery(rows) {
  let size = 1;
  while (size < rows.length) size *= 2;
  const lowTree = new Float64Array(size * 2);
  const highTree = new Float64Array(size * 2);
  lowTree.fill(Infinity);
  highTree.fill(-Infinity);
  for (let index = 0; index < rows.length; index++) {
    lowTree[size + index] = Number(rows[index].l);
    highTree[size + index] = Number(rows[index].h);
  }
  for (let index = size - 1; index > 0; index--) {
    lowTree[index] = Math.min(lowTree[index * 2], lowTree[index * 2 + 1]);
    highTree[index] = Math.max(highTree[index * 2], highTree[index * 2 + 1]);
  }
  const range = (tree, left, right, identity, operation) => {
    let result = identity;
    for (let start = left + size, end = right + size; start < end; start = Math.floor(start / 2), end = Math.floor(end / 2)) {
      if (start % 2 === 1) result = operation(result, tree[start++]);
      if (end % 2 === 1) result = operation(result, tree[--end]);
    }
    return result;
  };
  const firstWith = (start, end, threshold, tree, identity, operation, predicate) => {
    if (start >= end || !predicate(range(tree, start, end, identity, operation), threshold)) return -1;
    let low = start;
    let high = end - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (predicate(range(tree, start, middle + 1, identity, operation), threshold)) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  return {
    rows,
    firstLow: (start, end, threshold) => firstWith(start, end, threshold, lowTree, Infinity, Math.min, (value, limit) => value <= limit),
    firstHigh: (start, end, threshold) => firstWith(start, end, threshold, highTree, -Infinity, Math.max, (value, limit) => value >= limit),
    min: (start, end) => range(lowTree, start, end, Infinity, Math.min),
    max: (start, end) => range(highTree, start, end, -Infinity, Math.max),
  };
}

function queryTouchProfile(position, query, endTime) {
  const interval = H1 / 60;
  const rows = query.rows;
  const start = upperBoundRows(rows, Number(position.fillTime) - 1);
  const end = upperBoundRows(rows, Number(endTime) - interval);
  if (start >= end) return {touch: null, mfe: null, mae: null};
  const stopIndex = position.side === 'long'
    ? query.firstLow(start, end, Number(position.stop))
    : query.firstHigh(start, end, Number(position.stop));
  const targetIndex = position.side === 'long'
    ? query.firstHigh(start, end, Number(position.target))
    : query.firstLow(start, end, Number(position.target));
  const touchIndex = stopIndex < 0 ? targetIndex : targetIndex < 0 ? stopIndex : Math.min(stopIndex, targetIndex);
  const profileEnd = touchIndex < 0 ? end : touchIndex + 1;
  const entry = Number(position.entry);
  const direction = position.side === 'long' ? 1 : -1;
  const stopWins = stopIndex >= 0 && (targetIndex < 0 || stopIndex <= targetIndex);
  const touch = touchIndex < 0 ? null : {
    reason: stopWins ? 'sl' : 'tp',
    price: stopWins ? Number(position.stop) : Number(position.target),
    time: Number(rows[touchIndex].t) + interval,
    ambiguous: stopIndex >= 0 && stopIndex === targetIndex,
  };
  return {
    touch,
    mfe: direction === 1 ? query.max(start, profileEnd) / entry - 1 : 1 - query.min(start, profileEnd) / entry,
    mae: direction === 1 ? query.min(start, profileEnd) / entry - 1 : 1 - query.max(start, profileEnd) / entry,
  };
}

function baseAsset(symbol, exchangeMarket) {
  return exchangeMarket?.baseAsset || symbol.replace(/USDT$/, '');
}

function developmentDurationBand(market, start, end) {
  const activeStart = Math.max(start, Date.parse(market?.activeStart || market?.eligibleStart || '') || start);
  const activeEnd = Math.min(end, Date.parse(market?.activeEnd || market?.eligibleEnd || '') || end);
  const days = Math.max(0, activeEnd - activeStart) / DAY;
  return days >= 240 ? 'long-history' : days >= 120 ? 'medium-history' : 'recent-listing';
}

function selectStratifiedSymbols(symbols, markets, start, end, limit) {
  if (!(limit > 0) || symbols.length <= limit) return {symbols, mode: 'full-clean-eligible'};
  const groups = new Map();
  for (const symbol of symbols) {
    const market = markets.get(symbol);
    const key = `${market?.core ? 'core' : 'expanded'}|${developmentDurationBand(market, start, end)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(symbol);
  }
  for (const rows of groups.values()) rows.sort();
  const selected = [];
  const orderedKeys = ['core|long-history', 'core|medium-history', 'core|recent-listing', 'expanded|long-history', 'expanded|medium-history', 'expanded|recent-listing'];
  const cursors = new Map(orderedKeys.map(key => [key, 0]));
  while (selected.length < limit) {
    let added = false;
    for (const key of orderedKeys) {
      const rows = groups.get(key) || [];
      const cursor = cursors.get(key) || 0;
      if (cursor >= rows.length || selected.length >= limit) continue;
      selected.push(rows[cursor]);
      cursors.set(key, cursor + 1);
      added = true;
    }
    if (!added) break;
  }
  if (symbols.includes('BTCUSDT') && !selected.includes('BTCUSDT')) {
    selected.pop();
    selected.push('BTCUSDT');
  }
  return {symbols: selected.sort(), mode: 'stratified-fallback'};
}

function loadUniverse(dataRoot, appDir, {start, end, maxSymbols = 0} = {}) {
  const manifestFile = path.join(dataRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const eligibleReport = readJson(path.join(appDir, 'reports', 'fast-oos-universe.json'), {});
  const preferred = Array.isArray(eligibleReport.eligibleSymbols) ? eligibleReport.eligibleSymbols : manifest.universe.symbols;
  const markets = new Map((manifest.universe.markets || []).map(item => [item.symbol, item]));
  const exchangeFile = path.join(dataRoot, 'source', 'current-exchangeInfo.json');
  const exchange = fs.existsSync(exchangeFile) ? JSON.parse(fs.readFileSync(exchangeFile, 'utf8')) : {symbols: []};
  const exchangeBySymbol = new Map((exchange.symbols || []).map(item => [item.symbol, item]));
  const allSymbols = [...new Set(preferred)].filter(symbol => markets.has(symbol)).sort();
  const selection = selectStratifiedSymbols(allSymbols, markets, start, end, maxSymbols);
  return {
    manifest,
    manifestFile,
    symbols: selection.symbols,
    requestedSymbols: allSymbols.length,
    selectionMode: selection.mode,
    markets,
    exchangeBySymbol,
    source: Array.isArray(eligibleReport.eligibleSymbols) ? 'reports/fast-oos-universe.json' : 'manifest.universe.symbols',
  };
}

function marketMap(universe) {
  return new Map(universe.symbols.map(symbol => {
    const lifecycle = universe.markets.get(symbol);
    const exchange = universe.exchangeBySymbol.get(symbol) || {};
    return [symbol, {
      symbol,
      baseAsset: baseAsset(symbol, exchange),
      core: Boolean(lifecycle.core),
      filters: exchange.filters || [],
      onboardDate: Date.parse(lifecycle.activeStart || lifecycle.eligibleStart || '') || 0,
      deliveryDate: Date.parse(lifecycle.activeEnd || lifecycle.eligibleEnd || '') || 0,
    }];
  }));
}

function activeWindow(universe, symbol, start, end) {
  const market = universe.markets.get(symbol);
  const activeStart = Math.max(start, Date.parse(market?.activeStart || market?.eligibleStart || '') || start);
  const activeEnd = Math.min(end, Date.parse(market?.activeEnd || market?.eligibleEnd || '') || end);
  return {activeStart, activeEnd, active: activeEnd > activeStart};
}

function buildDataAccess(dataRoot, marketBySymbol, start, end, fillDir = null) {
  const minuteCache = new Map();
  const fundingCache = new Map();
  const fillCache = new Map();
  const profileCache = new Map();
  const retainedSymbols = new Set();
  // Minute artifacts are large (one year of 1m rows per symbol). Keep only a
  // small working set so the paper portfolio cannot retain an entire universe.
  const minuteCacheLimit = 2;
  const fundingCacheLimit = 8;
  const touch = (cache, symbol) => {
    const value = cache.get(symbol);
    if (value == null) return value;
    cache.delete(symbol);
    cache.set(symbol, value);
    return value;
  };
  const trim = (cache, limit) => {
    while (cache.size > limit) {
      const removable = [...cache.keys()].find(symbol => !retainedSymbols.has(symbol));
      if (removable == null) break;
      cache.delete(removable);
    }
  };
  const loadMinute = symbol => {
    const cached = touch(minuteCache, symbol);
    if (cached) return cached;
    const rows = loadRows(dataRoot, 'minute', symbol, start - H1, end + H1);
    minuteCache.set(symbol, rows);
    trim(minuteCache, minuteCacheLimit);
    return rows;
  };
  const loadFunding = (symbol, startTime = start - DAY, endTime = end + H1) => {
    const cached = touch(fundingCache, symbol);
    if (cached && startTime <= start - DAY && endTime >= end + H1) return cached;
    if (cached && startTime >= start - DAY && endTime <= end + H1) return cached.filter(row => row.t > startTime && row.t < endTime);
    const rows = loadRows(dataRoot, 'funding', symbol, start - DAY, end + H1);
    fundingCache.set(symbol, rows);
    trim(fundingCache, fundingCacheLimit);
    return rows.filter(row => row.t > startTime && row.t < endTime);
  };
  const firstMinute = (symbol, decisionTime, endTime) => {
    if (fillDir) {
      if (!fillCache.has(symbol)) {
        const file = path.join(fillDir, `${symbol}.json`);
        fillCache.set(symbol, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
      }
      const rows = fillCache.get(symbol);
      let low = 0;
      let high = rows.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (Number(rows[middle].decisionTime) < decisionTime) low = middle + 1;
        else high = middle;
      }
      const indexed = rows[low];
      return indexed && indexed.t + H1 / 60 <= endTime ? indexed : null;
    }
    const rows = loadMinute(symbol);
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (rows[middle].t < decisionTime) low = middle + 1;
      else high = middle;
    }
    const row = rows[low];
    return row && row.t + H1 / 60 <= endTime ? row : null;
  };
  return {
    marketBySymbol,
    loadMinute,
    loadFunding,
    firstMinute,
    firstTouch: (position, endTime) => {
      if (profileCache.has(position.id)) return profileCache.get(position.id);
      if (fillDir) {
        if (!fillCache.has(position.marketId)) {
          const file = path.join(fillDir, `${position.marketId}.json`);
          fillCache.set(position.marketId, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
        }
        const indexed = fillCache.get(position.marketId).find(row => row.candidateId === position.id);
        if (indexed && Object.prototype.hasOwnProperty.call(indexed, 'touch')) {
          return {touch: indexed.touch, mfe: indexed.mfe ?? null, mae: indexed.mae ?? null};
        }
      }
      const profile = computeTouchProfile(position, loadMinute(position.marketId), endTime);
      profileCache.set(position.id, profile);
      return profile;
    },
    lastMinuteClose: (symbol, fillTime, endTime) => {
      const rows = loadRows(dataRoot, 'minute', symbol, Number(fillTime) - H1, Number(endTime) + H1);
      const eligible = rows.filter(row => Number(row.t) + H1 / 60 <= Number(endTime));
      return Number(eligible.at(-1)?.c) > 0 ? Number(eligible.at(-1).c) : null;
    },
    priceAt: (symbol, timestamp) => {
      const rows = loadMinute(symbol);
      let low = 0;
      let high = rows.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (Number(rows[middle].t) <= Number(timestamp)) low = middle + 1;
        else high = middle;
      }
      const row = rows[low - 1];
      return Number(row?.c) > 0 ? Number(row.c) : null;
    },
    release: (symbol, {keep = false} = {}) => {
      if (keep) {
        touch(minuteCache, symbol);
        touch(fundingCache, symbol);
        return;
      }
      retainedSymbols.delete(symbol);
      minuteCache.delete(symbol);
      fundingCache.delete(symbol);
      fillCache.delete(symbol);
    },
    retain: symbol => retainedSymbols.add(symbol),
  };
}

export function createDevelopmentDataAccess(dataRoot, marketBySymbol, start, end) {
  return buildDataAccess(dataRoot, marketBySymbol, start, end);
}

function writePartition(file, rows) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function outcomeRecord(candidate, h1Rows) {
  const outcome = directionalOutcome(h1Rows, candidate.t, candidate.side);
  return {...candidate, outcome};
}

function generateForSymbol({symbol, market, universe, dataRoot, start, end, btcSeries}) {
  const window = activeWindow(universe, symbol, start, end);
  if (!window.active) return {rows: [], status: 'no-development-window'};
  const historyStart = Math.max(0, start - 300 * DAY, window.activeStart - 300 * DAY);
  const h1Rows = loadRows(dataRoot, 'price', symbol, historyStart, end + H1);
  if (h1Rows.length < 1_500) return {rows: [], status: 'insufficient-price-history'};
  const fundingRows = loadRows(dataRoot, 'funding', symbol, historyStart, end + H1);
  const bars4h = fourHourBars(h1Rows, end + H1);
  const series = prepareFeatureSeries(bars4h, {funding: fundingRows, btcSeries});
  const rows = [];
  for (const point of series.points) {
    if (point.signalTime < Math.max(start, window.activeStart) || point.signalTime >= Math.min(end, window.activeEnd)) continue;
    for (const alphaId of RESEARCH_ALPHA_IDS) {
      const detector = DETECTORS[alphaId];
      const alpha = ALPHA_REGISTRY[alphaId];
      for (const candidate of detector(point, market, alpha)) rows.push(outcomeRecord(scoreCandidate(candidate), h1Rows));
    }
  }
  rows.sort((a, b) => Number(a.t) - Number(b.t) || String(a.side).localeCompare(String(b.side)) || String(a.id).localeCompare(String(b.id)));
  return {rows, status: 'processed', oneHourRows: h1Rows.length, fourHourRows: bars4h.length, fundingEvents: fundingRows.length};
}

function* readPartition(file) {
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let carry = '';
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      carry += buffer.subarray(0, count).toString('utf8');
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() || '';
      for (const line of lines) if (line.trim()) yield JSON.parse(line);
    }
    if (carry.trim()) yield JSON.parse(carry);
  } finally {
    fs.closeSync(descriptor);
  }
}

function* mergeCandidatePartitions(files) {
  const iterators = files.map(file => readPartition(file));
  const heap = [];
  const compareEntries = (left, right) => Number(left.value.t) - Number(right.value.t)
    || String(left.value.id).localeCompare(String(right.value.id));
  const push = entry => {
    heap.push(entry);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareEntries(heap[parent], heap[index]) <= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
  };
  const pop = () => {
    const result = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && compareEntries(heap[left], heap[smallest]) < 0) smallest = left;
        if (right < heap.length && compareEntries(heap[right], heap[smallest]) < 0) smallest = right;
        if (smallest === index) break;
        [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
        index = smallest;
      }
    }
    return result;
  };
  for (let index = 0; index < iterators.length; index++) {
    const next = iterators[index].next();
    if (!next.done) push({index, value: next.value});
  }
  try {
    while (heap.length) {
      const entry = pop();
      yield entry.value;
      const next = iterators[entry.index].next();
      if (!next.done) push({index: entry.index, value: next.value});
    }
  } finally {
    for (const iterator of iterators) iterator.return?.();
  }
}

export function* candidateCycles(files, predicate = () => true) {
  let currentTime = null;
  let batch = [];
  const flush = function* () {
    if (!batch.length) return;
    yield batch.filter(predicate);
    batch = [];
  };
  for (const candidate of mergeCandidatePartitions(files)) {
    if (!predicate(candidate)) continue;
    if (currentTime != null && Number(candidate.t) !== currentTime) yield* flush();
    currentTime = Number(candidate.t);
    batch.push(candidate);
  }
  yield* flush();
}

function writeIndependentPartitions(partitionFiles, outputDir) {
  const independentDir = path.join(outputDir, 'independent');
  fs.mkdirSync(independentDir, {recursive: true});
  const files = [];
  for (const partition of partitionFiles) {
    const rows = dedupeResearchEpisodes([...readPartition(partition)]);
    const file = path.join(independentDir, path.basename(partition));
    writePartition(file, rows);
    files.push(file);
  }
  return files;
}

function collectResearchStats(rawFiles, independentFiles, start, end) {
  const monthly = createMonthlyFrequency(start, end);
  const observations = {rawTotal: 0, independentTotal: 0, byAlpha: {}};
  for (const file of rawFiles) {
    for (const candidate of readPartition(file)) {
      observations.rawTotal++;
      recordMonthlyObservation(monthly, candidate, 'rawEvents');
    }
  }
  let currentTime = null;
  let batch = [];
  const flush = () => {
    if (!batch.length) return;
    for (const candidate of batch) {
      observations.independentTotal++;
      observations.byAlpha[candidate.alpha] ||= {observations: 0, qualified: 0};
      observations.byAlpha[candidate.alpha].observations++;
      recordMonthlyObservation(monthly, candidate, 'independentResearchObservations');
    }
    const merged = mergeResearchCandidates(batch);
    for (const candidate of merged.filter(row => row.tier === 'A' || row.tier === 'B')) {
      recordMonthlyObservation(monthly, candidate, 'qualified');
      for (const source of candidate.alphaSources || [candidate.alpha]) {
        observations.byAlpha[source] ||= {observations: 0, qualified: 0};
        observations.byAlpha[source].qualified++;
      }
      if (candidate.tier === 'A') recordMonthlyObservation(monthly, candidate, 'highConfidence');
      recordMonthlyObservation(monthly, candidate, 'uniqueAlerts');
    }
    batch = [];
  };
  for (const candidate of mergeCandidatePartitions(independentFiles)) {
    if (currentTime != null && Number(candidate.t) !== currentTime) flush();
    currentTime = Number(candidate.t);
    batch.push(candidate);
  }
  flush();
  return {monthly, observations};
}

function buildFillIndex({partitionFiles, symbols, marketBySymbol, dataRoot, outputDir, start, end, resume = false}) {
  const fillDir = path.join(outputDir, 'fills');
  fs.mkdirSync(fillDir, {recursive: true});
  let built = 0;
  for (const symbol of symbols) {
    const file = path.join(fillDir, `${symbol}.json`);
    if (resume && fs.existsSync(file)) continue;
    const partition = partitionFiles.find(candidate => path.basename(candidate) === `${symbol}.ndjson`);
    const candidates = [];
    if (partition && fs.existsSync(partition)) {
      for (const candidate of readPartition(partition)) {
        if (candidate.tier === 'A' || candidate.tier === 'B') candidates.push({candidate, decisionTime: Number(candidate.t) + 20 * 60_000});
      }
    }
    const minuteRows = candidates.length ? loadRows(dataRoot, 'minute', symbol, start - H1, end + H1) : [];
    const minuteQuery = candidates.length ? buildMinuteQuery(minuteRows) : null;
    const indexed = [];
    candidates.sort((left, right) => left.decisionTime - right.decisionTime || String(left.candidate.id).localeCompare(String(right.candidate.id)));
    let cursor = 0;
    for (const {candidate, decisionTime} of candidates) {
      while (cursor < minuteRows.length && minuteRows[cursor].t < decisionTime) cursor++;
      const row = minuteRows[cursor];
      if (!row || row.t + H1 / 60 > end) continue;
      const indexedRow = {candidateId: candidate.id, decisionTime, t: row.t, o: row.o, c: row.c};
      const acceptance = evaluateCandidateAcceptance(candidate, {
        activePositions: [], cooldowns: {}, equityUsdt: PORTFOLIO_CONFIG.initialEquityUsdt,
        market: marketBySymbol.get(symbol), decisionTime, fillTime: row.t,
        fillPrice: row.o ?? row.c, strictFill: true,
        positionCap: PORTFOLIO_CONFIG.positionCap, sideCap: PORTFOLIO_CONFIG.sideCap,
      });
      if (acceptance.accepted) {
        const position = {
          id: candidate.id, marketId: symbol, side: candidate.side, fillTime: acceptance.fillTime,
          entry: acceptance.fillPrice, stop: acceptance.filledRisk.stop,
          target: acceptance.filledRisk.target,
        };
        const profile = queryTouchProfile(position, minuteQuery, end);
        indexedRow.touch = profile.touch;
        indexedRow.mfe = profile.mfe;
        indexedRow.mae = profile.mae;
      }
      indexed.push(indexedRow);
    }
    fs.writeFileSync(file, `${JSON.stringify(indexed)}\n`, 'utf8');
    built++;
  }
  return {dir: fillDir, built};
}

export function validateDevelopmentUniverse(universe, {minimum = 150, mode = 'formal'} = {}) {
  const count = Number(universe?.symbols?.length || 0);
  if (mode === 'formal' && count < minimum) {
    throw new Error(`Formal Development requires at least ${minimum} symbols; selected ${count}`);
  }
  return {valid: mode !== 'formal' || count >= minimum, count, minimum, mode};
}

export async function runDevelopmentReplay({dataRoot, appDir, start, end, outputDir, resume = false, maxSymbols = 0, mode = 'formal'} = {}) {
  const registryCheck = validateAlphaRegistry();
  if (!registryCheck.valid) throw new Error(`Invalid V8.1 registry: ${registryCheck.errors.join(',')}`);
  const universe = loadUniverse(dataRoot, appDir, {start, end, maxSymbols});
  validateDevelopmentUniverse(universe, {mode});
  const marketBySymbol = marketMap(universe);
  const btcRows = loadRows(dataRoot, 'price', 'BTCUSDT', Math.max(0, start - 300 * DAY), end + H1);
  const btcSeries = prepareFeatureSeries(fourHourBars(btcRows, end + H1), {funding: loadRows(dataRoot, 'funding', 'BTCUSDT', start - DAY, end + H1)});
  fs.mkdirSync(outputDir, {recursive: true});
  const partitionDir = path.join(outputDir, 'partitions');
  fs.mkdirSync(partitionDir, {recursive: true});
  const progressFile = path.join(outputDir, 'progress.json');
  const progress = resume ? readJson(progressFile, {symbols: []}) : {symbols: []};
  const completed = new Set(progress.symbols || []);
  const partitionFiles = [];
  const symbolStatus = {};
  let processed = 0;
  for (const symbol of universe.symbols) {
    const file = path.join(partitionDir, `${symbol}.ndjson`);
    if (resume && completed.has(symbol) && fs.existsSync(file)) {
      partitionFiles.push(file);
      processed++;
      symbolStatus[symbol] = 'resumed';
      continue;
    }
    const result = generateForSymbol({symbol, market: marketBySymbol.get(symbol), universe, dataRoot, start, end, btcSeries});
    writePartition(file, result.rows);
    partitionFiles.push(file);
    processed++;
    symbolStatus[symbol] = result.status;
    completed.add(symbol);
    atomicWriteJson(progressFile, {schemaVersion: 1, boundary: {start, end}, symbols: [...completed].sort(), updatedAt: new Date().toISOString()});
  }
  const independentFiles = writeIndependentPartitions(partitionFiles, outputDir);
  const researchStats = collectResearchStats(partitionFiles, independentFiles, start, end);
  const fillIndex = buildFillIndex({partitionFiles: independentFiles, symbols: universe.symbols, marketBySymbol, dataRoot, outputDir, start, end, resume});
  const cycles = candidateCycles(independentFiles, candidate => candidate.tier === 'A' || candidate.tier === 'B');
  const data = buildDataAccess(dataRoot, marketBySymbol, start, end, fillIndex.dir);
  const portfolio = await simulatePortfolio(cycles, data, {endTime: end, ranker: rankResearchCandidates});
  return {
    universe,
    marketBySymbol,
    dataAccess: data,
    portfolio,
    observations: researchStats.observations,
    monthly: researchStats.monthly,
    frequency: frequencySummary(researchStats.monthly),
    partitionFiles,
    independentFiles,
    symbolStatus,
    btcContext: {rows: btcRows.length, points: btcSeries.points.length},
    fillIndex,
    processedSymbols: processed,
    sourceManifestSha256: hashFile(path.join(dataRoot, 'manifest.json')),
    artifactDir: outputDir,
  };
}

export function researchConfig({start, end, sourceManifestSha256, universeCount, universeMode = 'full-clean-eligible', requestedUniverseCount = universeCount, provenance = {}}) {
  return {
    schemaVersion: 1,
    engineVersion: 'V8.1-research-1',
    alphaRegistry: Object.fromEntries(RESEARCH_ALPHA_IDS.map(id => [id, ALPHA_REGISTRY[id]])),
    baselineAnchors: ['v8_daily_breakout_long', 'v8_funding_crowding_short', 'v8_volume_shock_short', 'v8_bear_trend_short'],
    enabledAlphaIds: RESEARCH_ALPHA_IDS,
    scoring: {version: SCORING_CONFIG.version, tierThresholds: TIER_THRESHOLDS},
    riskSettings: {minStopPct: 0.02, maxStopPct: 0.12, riskFraction: PORTFOLIO_CONFIG.riskFraction},
    dedupeRules: {key: 'symbol|side|signalTime', episodeKey: 'symbol|side|alpha', deterministicTieBreak: 'edgeScore,eventScore,dayVolume,id', sameTimePerSide: 3},
    portfolioSettings: {positionCap: 10, sideCap: 8, cooldownHours: 72, decisionLatencyMinutes: 20, fillInterval: '1m', settlementInterval: '1m', sameMinuteTpSl: 'sl'},
    costModel: {roundTripCostRate: PORTFOLIO_CONFIG.costRate, funding: 'event-rate × priceAtOrBefore fallback when markPrice is null'},
    datasetBoundary: {start, end, holdoutStart: Date.parse('2026-01-01T00:00:00Z'), holdoutEnd: Date.parse('2026-07-15T00:00:00Z')},
    universeSpecification: {source: 'reports/fast-oos-universe.json', mode: universeMode, requestedSymbols: requestedUniverseCount, symbols: universeCount, sourceManifestSha256},
    provenance,
    noOrderMode: true,
  };
}
