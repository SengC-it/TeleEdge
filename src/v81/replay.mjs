import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {DAY, H1} from '../config.mjs';
import {fourHourBars, prepareFeatureSeries} from './features.mjs';
import {ALPHA_REGISTRY, RESEARCH_ALPHA_IDS, validateAlphaRegistry} from './alpha-registry.mjs';
import {scoreCandidate} from './scoring.mjs';
import {SCORING_CONFIG} from './scoring.mjs';
import {mergeResearchCandidates, rankResearchCandidates} from './dedupe.mjs';
import {TIER_THRESHOLDS} from './tiers.mjs';
import {createMonthlyFrequency, frequencySummary, recordMonthlyObservation} from './metrics.mjs';
import {dedupeResearchEpisodes} from './episodes.mjs';
import {simulatePortfolio, PORTFOLIO_CONFIG} from './portfolio.mjs';
import {evaluateCandidateAcceptance} from '../portfolio.mjs';
import {priceAtOrBefore, settleOnCompletedBars} from '../backtest.mjs';
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

const DECISION_LATENCY_MS = 20 * 60_000;
const MINUTE_INTERVAL_MS = H1 / 60;

function firstExecutableMinute(rows, decisionTime, endTime) {
  for (const row of rows || []) {
    const t = Number(row.t);
    const price = Number(row.o) > 0 ? Number(row.o) : Number(row.c);
    if (t < decisionTime || t + MINUTE_INTERVAL_MS > endTime || !(price > 0)) continue;
    return {t, o: price, c: Number(row.c)};
  }
  return null;
}

function syntheticTouchBar(position, touch) {
  const both = Boolean(touch.ambiguous);
  const entry = Number(position.entry);
  const stop = Number(position.stop);
  const target = Number(position.target);
  const long = position.side === 'long';
  const isStop = touch.reason === 'sl';
  const high = long
    ? (isStop ? (both ? target : entry) : target)
    : (isStop ? stop : (both ? stop : entry));
  const low = long
    ? (isStop ? stop : (both ? stop : entry))
    : (isStop ? (both ? target : entry) : target);
  return {t: Number(touch.time) - MINUTE_INTERVAL_MS, o: entry, h: high, l: low, c: Number(touch.price)};
}

function outcomeBase(candidate, decisionTime) {
  return {
    outcomeType: 'researchTradeOutcome',
    observationId: candidate.id,
    episodeId: candidate.episodeId || null,
    marketId: candidate.marketId,
    symbol: candidate.symbol || candidate.marketId,
    side: candidate.side,
    alpha: candidate.alpha,
    alphaSources: candidate.alphaSources || [candidate.alpha],
    family: candidate.family,
    regime: candidate.regime || candidate.features?.regime || 'unknown',
    btcRouter: candidate.btcRouter || candidate.features?.btcRegime || 'unknown',
    signalTime: Number(candidate.t),
    decisionTime,
    fillTime: null,
    fillPrice: null,
    stop: null,
    target: null,
    targetR: Number.isFinite(Number(candidate.targetR)) ? Number(candidate.targetR) : null,
    effectiveTargetR: null,
    stopPct: null,
    riskUsdt: null,
    quantity: null,
    exitReason: null,
    exitTime: null,
    exitPrice: null,
    grossPnlUsdt: null,
    fundingPnlUsdt: null,
    modeledCostUsdt: null,
    netPnlUsdt: null,
    netR: null,
    mfe: null,
    mae: null,
    executable: false,
    outcomeStatus: 'not-executable',
    rejectionReason: null,
    features: {...(candidate.features || {})},
    edgeScore: candidate.edgeScore ?? null,
    originalEdgeScore: candidate.originalEdgeScore ?? candidate.edgeScore ?? null,
    commonScore: candidate.commonScore ?? null,
    alphaEvidenceScore: candidate.alphaEvidenceScore ?? null,
    confidenceScore: candidate.confidenceScore ?? null,
    calibratedScore: candidate.calibratedScore ?? null,
    tier: candidate.tier ?? 'C',
  };
}

function finishedOutcome(base, position, trade, profile, {fundingEvents = 0, fallbackMarkPriceRows = 0} = {}) {
  return {
    ...base,
    executable: true,
    outcomeStatus: 'closed',
    fillTime: position.fillTime,
    fillPrice: position.fillPrice,
    stop: position.stop,
    target: position.target,
    targetR: position.targetR,
    effectiveTargetR: position.effectiveTargetR,
    stopPct: position.stopPct,
    riskUsdt: position.riskUsdt,
    quantity: position.quantity,
    exitReason: trade.exitReason,
    exitTime: trade.exitTime,
    exitPrice: trade.exitPrice,
    grossPnlUsdt: trade.grossPnlUsdt,
    fundingPnlUsdt: trade.fundingPnlUsdt,
    modeledCostUsdt: trade.modeledCostUsdt,
    netPnlUsdt: trade.netPnlUsdt,
    netR: trade.netR,
    mfe: profile.mfe,
    mae: profile.mae,
    fundingEvents,
    fallbackMarkPriceRows,
    touch: profile.touch || null,
  };
}

export function simulateStandaloneObservation(candidate, {
  market,
  minuteRows = [],
  fundingRows = [],
  activeEnd = Infinity,
  equityUsdt = PORTFOLIO_CONFIG.initialEquityUsdt,
  costRate = PORTFOLIO_CONFIG.costRate,
  positionCap = PORTFOLIO_CONFIG.positionCap,
  sideCap = PORTFOLIO_CONFIG.sideCap,
} = {}) {
  const signalTime = Number(candidate.t ?? candidate.signalTime);
  const decisionTime = signalTime + DECISION_LATENCY_MS;
  const endTime = Number(activeEnd);
  const base = outcomeBase(candidate, decisionTime);
  const firstMinute = firstExecutableMinute(minuteRows, decisionTime, endTime);
  if (!firstMinute) return {...base, rejectionReason: 'fill-price-unavailable'};
  const acceptance = evaluateCandidateAcceptance(candidate, {
    activePositions: [],
    cooldowns: {},
    equityUsdt,
    market,
    decisionTime,
    fillTime: firstMinute.t,
    fillPrice: firstMinute.o,
    strictFill: true,
    positionCap,
    sideCap,
  });
  if (!acceptance.accepted) {
    return {
      ...base,
      fillTime: firstMinute.t,
      fillPrice: firstMinute.o,
      rejectionReason: acceptance.reason || 'acceptance-rejected',
      acceptanceRules: acceptance.rules || null,
    };
  }
  const position = {
    id: candidate.id,
    marketId: candidate.marketId,
    symbol: candidate.symbol || candidate.marketId,
    side: candidate.side,
    alpha: candidate.alpha,
    family: candidate.family,
    signalTime,
    decisionTime,
    fillTime: acceptance.fillTime,
    fillPrice: acceptance.fillPrice,
    entry: acceptance.fillPrice,
    stop: acceptance.filledRisk.stop,
    target: acceptance.filledRisk.target,
    targetR: acceptance.filledRisk.targetR,
    effectiveTargetR: acceptance.filledRisk.effectiveTargetR,
    stopPct: acceptance.filledRisk.stopPct,
    quantity: acceptance.quantity,
    riskUsdt: acceptance.riskUsdt,
    fundingPnlUsdt: 0,
    lastFundingTime: acceptance.fillTime,
  };
  const query = buildMinuteQuery(minuteRows);
  const profile = queryTouchProfile(position, query, endTime);
  const priceAt = timestamp => priceAtOrBefore(minuteRows, timestamp, position.entry);
  if (profile.touch) {
    const settled = settleOnCompletedBars(position, [syntheticTouchBar(position, profile.touch)], fundingRows, {
      now: endTime + 1,
      costRate,
      barIntervalMs: MINUTE_INTERVAL_MS,
      priceAt,
    });
    return finishedOutcome(base, position, settled.trade, profile, settled);
  }
  const accrued = settleOnCompletedBars(position, [], fundingRows, {
    now: endTime + 1,
    costRate,
    barIntervalMs: MINUTE_INTERVAL_MS,
    priceAt,
  });
  const completed = (minuteRows || []).filter(row => Number(row.t) >= position.fillTime && Number(row.t) + MINUTE_INTERVAL_MS <= endTime);
  const last = completed.at(-1);
  const exitPrice = Number(last?.c) > 0 ? Number(last.c) : Number(position.entry);
  const exitTime = last ? Number(last.t) + MINUTE_INTERVAL_MS : Math.max(position.fillTime, endTime - 1);
  const direction = position.side === 'long' ? 1 : -1;
  const grossPnlUsdt = direction * (exitPrice - Number(position.entry)) * Number(position.quantity);
  const modeledCostUsdt = costRate * Number(position.entry) * Number(position.quantity);
  const netPnlUsdt = grossPnlUsdt + Number(accrued.position.fundingPnlUsdt || 0) - modeledCostUsdt;
  const trade = {
    ...accrued.position,
    exitReason: 'end-of-window',
    exitTime,
    exitPrice,
    grossPnlUsdt,
    modeledCostUsdt,
    netPnlUsdt,
    netR: Number(position.riskUsdt) > 0 ? netPnlUsdt / Number(position.riskUsdt) : null,
  };
  return finishedOutcome(base, position, trade, profile, accrued);
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
      return indexed && Number.isFinite(Number(indexed.t)) && Number(indexed.t) + H1 / 60 <= endTime ? indexed : null;
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
      for (const candidate of detector(point, market, alpha)) rows.push(scoreCandidate(candidate));
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

function symbolFromPartition(file) {
  return path.basename(file).replace(/\.ndjson$/, '');
}

function symbolActiveEnd(market, end) {
  const deliveryDate = Number(market?.deliveryDate);
  return Number.isFinite(deliveryDate) && deliveryDate > 0 ? Math.min(end, deliveryDate) : end;
}

function readStandaloneFiles(files) {
  const rows = [];
  for (const file of files || []) rows.push(...readPartition(file));
  return rows.sort((a, b) => Number(a.signalTime) - Number(b.signalTime) || String(a.observationId).localeCompare(String(b.observationId)));
}

export function buildStandaloneOutcomes({independentFiles, symbols, marketBySymbol, dataRoot, outputDir, start, end, resume = false} = {}) {
  const standaloneDir = path.join(outputDir, 'standalone');
  fs.mkdirSync(standaloneDir, {recursive: true});
  const bySymbol = new Map((independentFiles || []).map(file => [symbolFromPartition(file), file]));
  const files = [];
  for (const symbol of symbols || [...bySymbol.keys()].sort()) {
    const file = path.join(standaloneDir, `${symbol}.ndjson`);
    files.push(file);
    if (resume && fs.existsSync(file)) continue;
    const candidates = bySymbol.has(symbol) ? [...readPartition(bySymbol.get(symbol))]
      .sort((a, b) => Number(a.t) - Number(b.t) || String(a.id).localeCompare(String(b.id))) : [];
    const market = marketBySymbol.get(symbol);
    const activeEnd = symbolActiveEnd(market, end);
    const minuteRows = candidates.length ? loadRows(dataRoot, 'minute', symbol, start - H1, activeEnd + H1) : [];
    const fundingRows = candidates.length ? loadRows(dataRoot, 'funding', symbol, start - DAY, activeEnd + H1) : [];
    const outcomes = candidates.map(candidate => simulateStandaloneObservation(candidate, {
      market,
      minuteRows,
      fundingRows,
      activeEnd,
    }));
    writePartition(file, outcomes);
  }
  const rows = readStandaloneFiles(files);
  const byReason = {};
  for (const row of rows) {
    if (!row.executable) byReason[row.rejectionReason || 'unknown'] = (byReason[row.rejectionReason || 'unknown'] || 0) + 1;
  }
  return {
    dir: standaloneDir,
    files,
    rows,
    counts: {
      total: rows.length,
      executable: rows.filter(row => row.executable).length,
      rejected: rows.filter(row => !row.executable).length,
      byReason,
    },
  };
}

function buildFillIndex({standaloneFiles, symbols, outputDir}) {
  const fillDir = path.join(outputDir, 'fills');
  fs.mkdirSync(fillDir, {recursive: true});
  let built = 0;
  for (const symbol of symbols) {
    const file = path.join(fillDir, `${symbol}.json`);
    const standaloneFile = standaloneFiles.find(candidate => path.basename(candidate) === `${symbol}.ndjson`);
    const indexed = [];
    if (standaloneFile && fs.existsSync(standaloneFile)) {
      for (const outcome of readPartition(standaloneFile)) {
        if (!(Number(outcome.fillTime) > 0) || !(Number(outcome.fillPrice) > 0)) continue;
        const indexedRow = {
          candidateId: outcome.observationId,
          decisionTime: Number(outcome.decisionTime),
          t: Number(outcome.fillTime),
          o: Number(outcome.fillPrice),
          c: Number(outcome.fillPrice),
        };
        if (outcome.executable) {
          indexedRow.touch = outcome.touch || null;
          indexedRow.mfe = outcome.mfe ?? null;
          indexedRow.mae = outcome.mae ?? null;
        }
        indexed.push(indexedRow);
      }
    }
    indexed.sort((left, right) => left.decisionTime - right.decisionTime || String(left.candidateId).localeCompare(String(right.candidateId)));
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
  const independentObservations = [];
  for (const file of independentFiles) independentObservations.push(...readPartition(file));
  const standalone = buildStandaloneOutcomes({independentFiles, symbols: universe.symbols, marketBySymbol, dataRoot, outputDir, start, end, resume});
  const fillIndex = buildFillIndex({standaloneFiles: standalone.files, symbols: universe.symbols, outputDir});
  const cycles = candidateCycles(independentFiles, candidate => candidate.tier === 'A' || candidate.tier === 'B');
  const data = buildDataAccess(dataRoot, marketBySymbol, start, end, fillIndex.dir);
  const portfolio = await simulatePortfolio(cycles, data, {endTime: end, ranker: rankResearchCandidates});
  return {
    universe,
    marketBySymbol,
    dataAccess: data,
    portfolio,
    observations: researchStats.observations,
    independentObservations,
    standaloneOutcomes: standalone.rows,
    standalone,
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
    engineVersion: 'V8.1-research-3',
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
