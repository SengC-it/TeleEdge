import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {isMainThread, parentPort, Worker, workerData} from 'node:worker_threads';
import {DAY, H1} from '../config.mjs';
import {createDevelopmentDataAccess} from '../v81/replay.mjs';
import {dedupeResearchEpisodes} from '../v81/episodes.mjs';
import {mergeResearchCandidates, rankResearchCandidates} from '../v81/dedupe.mjs';
import {PORTFOLIO_CONFIG} from '../v81/portfolio.mjs';
import {evaluateCandidateAcceptance} from '../portfolio.mjs';
import {assignCrossSectionalRanks, buildV9FeatureSeries, parseEnhancedKlineRow} from './features.mjs';
import {generateV9Candidates} from './alphas.mjs';
import {loadV9Universe, activeWindow} from './universe.mjs';
import {V9_ALPHA_IDS} from './registry.mjs';

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function parseTime(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readGzipJson(file) {
  if (!fs.existsSync(file)) return [];
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim();
  return text ? JSON.parse(text) : [];
}

function writeGzipJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, zlib.gzipSync(JSON.stringify(value), {level: 1}));
  fs.renameSync(temporary, file);
}

function compactOutcome(row) {
  if (row && Object.prototype.hasOwnProperty.call(row, 'features')) delete row.features;
  return row;
}

function symbolFiles(directory, symbol) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name === `${symbol}.json.gz` || name.startsWith(`${symbol}-`)).sort()
    .map(name => path.join(directory, name));
}

function loadGzipRows(root, kind, symbol, start = -Infinity, end = Infinity) {
  const byTime = new Map();
  for (const file of symbolFiles(path.join(root, kind), symbol)) {
    for (const raw of readGzipJson(file)) {
      const t = finite(raw.t ?? raw.openTime ?? raw.fundingTime);
      if (t == null || t < start || t >= end) continue;
      byTime.set(t, raw);
    }
  }
  return [...byTime.values()].sort((a, b) => Number(a.t ?? a.openTime) - Number(b.t ?? b.openTime));
}

function loadEnhancedRows(root, symbol, start, end) {
  return loadGzipRows(root, 'taker-1h', symbol, start, end).map(parseEnhancedKlineRow);
}

function loadOptionalRows(root, kind, symbol, start, end) {
  return loadGzipRows(root, kind, symbol, start, end);
}

function metricsArtifactBySymbol(root) {
  const manifestFile = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return new Map();
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  return new Map((manifest.artifacts || []).filter(row => row.kind === 'metrics').map(row => [row.symbol, row]));
}

function hashFile(file) {
  return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}

function marketMap(universe) {
  return new Map(universe.symbols.map(symbol => {
    const lifecycle = universe.markets.get(symbol) || {};
    const exchange = universe.exchangeBySymbol.get(symbol) || {};
    return [symbol, {
      symbol,
      baseAsset: exchange.baseAsset || symbol.replace(/USDT$/, ''),
      core: Boolean(lifecycle.core),
      filters: exchange.filters || [],
      onboardDate: parseTime(lifecycle.activeStart ?? lifecycle.eligibleStart, 0),
      deliveryDate: parseTime(lifecycle.activeEnd ?? lifecycle.eligibleEnd, 0),
      activeStart: lifecycle.activeStart ?? lifecycle.eligibleStart ?? null,
      activeEnd: lifecycle.activeEnd ?? lifecycle.eligibleEnd ?? null,
    }];
  }));
}

const DECISION_LATENCY_MS = 20 * 60_000;
const MINUTE_INTERVAL_MS = H1 / 60;

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

function lowerBoundRows(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].t) < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function buildMinuteQuery(rows) {
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
  const firstWith = (start, end, threshold, tree, predicate) => {
    const search = (node, left, right) => {
      if (right <= start || end <= left || !predicate(tree[node], threshold)) return -1;
      if (right - left === 1) return left < end ? left : -1;
      const middle = Math.floor((left + right) / 2);
      const first = search(node * 2, left, middle);
      return first >= 0 ? first : search(node * 2 + 1, middle, right);
    };
    return start < end ? search(1, 0, size) : -1;
  };
  return {
    rows,
    firstLow: (start, end, threshold) => firstWith(start, end, threshold, lowTree, (value, limit) => value <= limit),
    firstHigh: (start, end, threshold) => firstWith(start, end, threshold, highTree, (value, limit) => value >= limit),
    min: (start, end) => range(lowTree, start, end, Infinity, Math.min),
    max: (start, end) => range(highTree, start, end, -Infinity, Math.max),
  };
}

function queryTouchProfile(position, query, endTime) {
  const rows = query.rows;
  const start = upperBoundRows(rows, Number(position.fillTime) - 1);
  const end = upperBoundRows(rows, Number(endTime) - MINUTE_INTERVAL_MS);
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
    reason: stopWins ? 'sl' : 'tp', price: stopWins ? Number(position.stop) : Number(position.target),
    time: Number(rows[touchIndex].t) + MINUTE_INTERVAL_MS, ambiguous: stopIndex >= 0 && stopIndex === targetIndex,
  };
  return {
    touch,
    mfe: direction === 1 ? query.max(start, profileEnd) / entry - 1 : 1 - query.min(start, profileEnd) / entry,
    mae: direction === 1 ? query.min(start, profileEnd) / entry - 1 : 1 - query.max(start, profileEnd) / entry,
  };
}

function firstExecutableMinute(rows, decisionTime, endTime) {
  const start = lowerBoundRows(rows || [], decisionTime);
  for (let index = start; index < (rows || []).length; index++) {
    const row = rows[index];
    const t = Number(row.t);
    const price = Number(row.o) > 0 ? Number(row.o) : Number(row.c);
    if (t < decisionTime || t + MINUTE_INTERVAL_MS > endTime || !(price > 0)) continue;
    return {t, o: price, c: Number(row.c)};
  }
  return null;
}

function priceAtOrBeforeFast(rows, timestamp, fallback = null) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].t) <= timestamp) low = middle + 1;
    else high = middle;
  }
  for (let index = low - 1; index >= 0; index--) {
    const close = Number(rows[index].c);
    if (close > 0) return close;
  }
  return fallback;
}

export function buildFundingQuery(rows = [], minuteRows = []) {
  const events = [...(rows || [])]
    .map(row => ({
      ...row,
      t: finite(row.t ?? row.fundingTime ?? row.funding_time),
      rate: finite(row.rate ?? row.fundingRate ?? row.funding_rate),
    }))
    .filter(row => row.t != null)
    .sort((a, b) => Number(a.t) - Number(b.t));
  const knownCashflow = [0];
  const fallbackCashflow = [0];
  const entryRate = [0];
  const fundingEvents = [0];
  const missingMarkRows = [0];
  const lastValidIndex = [-1];
  let lastValid = -1;
  for (let index = 0; index < events.length; index++) {
    const row = events[index];
    const mark = Number(row.markPrice ?? row.mark_price);
    const rate = Number(row.rate);
    let known = mark > 0;
    let fallbackPrice = null;
    let entryFallback = false;
    if (!known) {
      fallbackPrice = priceAtOrBeforeFast(minuteRows, Number(row.t), null);
      if (!(fallbackPrice > 0)) entryFallback = true;
    }
    const valid = Number.isFinite(rate) && (known ? mark > 0 : (fallbackPrice > 0 || entryFallback));
    knownCashflow.push(knownCashflow[index] + (valid && known ? mark * rate : 0));
    fallbackCashflow.push(fallbackCashflow[index] + (valid && !known && !entryFallback ? fallbackPrice * rate : 0));
    entryRate.push(entryRate[index] + (valid && !known && entryFallback ? rate : 0));
    fundingEvents.push(fundingEvents[index] + (valid ? 1 : 0));
    missingMarkRows.push(missingMarkRows[index] + (known ? 0 : 1));
    if (valid) lastValid = index;
    lastValidIndex.push(lastValid);
  }
  return {
    events,
    query(lastFundingTime, until, entry) {
      const left = upperBoundRows(events, Number(lastFundingTime));
      const right = lowerBoundRows(events, Number(until));
      if (left >= right) return {cashflow: 0, fundingEvents: 0, fallbackMarkPriceRows: 0, lastFundingTime};
      const validIndex = lastValidIndex[right];
      const latest = validIndex >= left ? Number(events[validIndex].t) : lastFundingTime;
      return {
        cashflow: knownCashflow[right] - knownCashflow[left]
          + fallbackCashflow[right] - fallbackCashflow[left]
          + Number(entry || 0) * (entryRate[right] - entryRate[left]),
        fundingEvents: fundingEvents[right] - fundingEvents[left],
        fallbackMarkPriceRows: missingMarkRows[right] - missingMarkRows[left],
        lastFundingTime: latest,
      };
    },
  };
}

function settleV9Position(position, fundingQuery, until, touch, costRate) {
  const funding = fundingQuery.query(position.lastFundingTime, until, position.entry);
  const fundingDirection = position.side === 'long' ? -1 : 1;
  const next = {
    ...position,
    fundingPnlUsdt: Number(position.fundingPnlUsdt || 0) + fundingDirection * funding.cashflow,
    lastFundingTime: funding.lastFundingTime,
  };
  if (!touch) return {closed: false, position: next, fundingEvents: funding.fundingEvents, fallbackMarkPriceRows: funding.fallbackMarkPriceRows};
  const direction = next.side === 'long' ? 1 : -1;
  const grossPnlUsdt = direction * (Number(touch.price) - Number(next.entry)) * Number(next.quantity);
  const modeledCostUsdt = costRate * Number(next.entry) * Number(next.quantity);
  const netPnlUsdt = grossPnlUsdt + next.fundingPnlUsdt - modeledCostUsdt;
  const trade = {
    ...next,
    status: 'closed', exitReason: touch.reason, exitPrice: Number(touch.price), exitTime: Number(touch.time),
    ambiguousSameMinute: Boolean(touch.ambiguous), grossPnlUsdt, modeledCostUsdt, netPnlUsdt,
    netR: Number(next.riskUsdt) > 0 ? netPnlUsdt / Number(next.riskUsdt) : null,
  };
  return {closed: true, position: trade, trade, fundingEvents: funding.fundingEvents, fallbackMarkPriceRows: funding.fallbackMarkPriceRows};
}

function outcomeBase(candidate, decisionTime) {
  return {
    outcomeType: 'researchTradeOutcome', observationId: candidate.id, episodeId: candidate.episodeId || null,
    marketId: candidate.marketId, symbol: candidate.symbol || candidate.marketId, side: candidate.side,
    alpha: candidate.alpha, alphaSources: candidate.alphaSources || [candidate.alpha], family: candidate.family,
    regime: candidate.regime || candidate.features?.regime || 'unknown', btcRouter: candidate.btcRouter || candidate.features?.btcRegime || 'unknown',
    signalTime: Number(candidate.t), decisionTime, fillTime: null, fillPrice: null, stop: null, target: null,
    targetR: Number.isFinite(Number(candidate.targetR)) ? Number(candidate.targetR) : null, effectiveTargetR: null, stopPct: null,
    riskUsdt: null, quantity: null, exitReason: null, exitTime: null, exitPrice: null, grossPnlUsdt: null,
    fundingPnlUsdt: null, modeledCostUsdt: null, netPnlUsdt: null, netR: null, mfe: null, mae: null,
    executable: false, outcomeStatus: 'not-executable', rejectionReason: null,
    edgeScore: candidate.edgeScore ?? null, originalEdgeScore: candidate.originalEdgeScore ?? candidate.edgeScore ?? null,
    commonScore: candidate.commonScore ?? null, alphaEvidenceScore: candidate.alphaEvidenceScore ?? null,
    confidenceScore: candidate.confidenceScore ?? null, calibratedScore: candidate.calibratedScore ?? null, tier: candidate.tier ?? 'C',
  };
}

function finishedOutcome(base, position, trade, profile, settlement) {
  return {
    ...base, executable: true, outcomeStatus: 'closed', fillTime: position.fillTime, fillPrice: position.fillPrice,
    stop: position.stop, target: position.target, targetR: position.targetR, effectiveTargetR: position.effectiveTargetR,
    stopPct: position.stopPct, riskUsdt: position.riskUsdt, quantity: position.quantity, exitReason: trade.exitReason,
    exitTime: trade.exitTime, exitPrice: trade.exitPrice, grossPnlUsdt: trade.grossPnlUsdt,
    fundingPnlUsdt: trade.fundingPnlUsdt, modeledCostUsdt: trade.modeledCostUsdt, netPnlUsdt: trade.netPnlUsdt,
    netR: trade.netR, mfe: profile.mfe, mae: profile.mae, fundingEvents: settlement.fundingEvents || 0,
    fallbackMarkPriceRows: settlement.fallbackMarkPriceRows || 0, touch: profile.touch || null,
  };
}

export function simulateV9StandaloneObservation(candidate, {market, minuteRows = [], minuteQuery = buildMinuteQuery(minuteRows), fundingRows = [], fundingQuery = null, activeEnd = Infinity, equityUsdt = PORTFOLIO_CONFIG.initialEquityUsdt, costRate = PORTFOLIO_CONFIG.costRate, positionCap = PORTFOLIO_CONFIG.positionCap, sideCap = PORTFOLIO_CONFIG.sideCap} = {}) {
  const signalTime = Number(candidate.t ?? candidate.signalTime);
  const decisionTime = signalTime + DECISION_LATENCY_MS;
  const endTime = Number(activeEnd);
  const base = outcomeBase(candidate, decisionTime);
  const firstMinute = firstExecutableMinute(minuteRows, decisionTime, endTime);
  if (!firstMinute) return {...base, rejectionReason: 'fill-price-unavailable'};
  const acceptance = evaluateCandidateAcceptance(candidate, {activePositions: [], cooldowns: {}, equityUsdt, market, decisionTime, fillTime: firstMinute.t, fillPrice: firstMinute.o, strictFill: true, positionCap, sideCap});
  if (!acceptance.accepted) return {...base, fillTime: firstMinute.t, fillPrice: firstMinute.o, rejectionReason: acceptance.reason || 'acceptance-rejected', acceptanceRules: acceptance.rules || null};
  const position = {
    id: candidate.id, marketId: candidate.marketId, symbol: candidate.symbol || candidate.marketId, side: candidate.side,
    signalTime, decisionTime, fillTime: acceptance.fillTime, fillPrice: acceptance.fillPrice, entry: acceptance.fillPrice,
    stop: acceptance.filledRisk.stop, target: acceptance.filledRisk.target, targetR: acceptance.filledRisk.targetR,
    effectiveTargetR: acceptance.filledRisk.effectiveTargetR, stopPct: acceptance.filledRisk.stopPct, quantity: acceptance.quantity,
    riskUsdt: acceptance.riskUsdt, fundingPnlUsdt: 0, lastFundingTime: acceptance.fillTime,
  };
  const profile = queryTouchProfile(position, minuteQuery, endTime);
  const fundingLookup = fundingQuery || buildFundingQuery(fundingRows, minuteRows);
  if (profile.touch) {
    const settled = settleV9Position(position, fundingLookup, Number(profile.touch.time), profile.touch, costRate);
    return finishedOutcome(base, position, settled.trade, profile, settled);
  }
  const accrued = settleV9Position(position, fundingLookup, endTime + 1, null, costRate);
  const firstCompletedIndex = upperBoundRows(minuteRows, Number(position.fillTime) - 1);
  const lastCompletedExclusive = upperBoundRows(minuteRows, Number(endTime) - MINUTE_INTERVAL_MS);
  const last = lastCompletedExclusive > firstCompletedIndex ? minuteRows[lastCompletedExclusive - 1] : null;
  const exitPrice = Number(last?.c) > 0 ? Number(last.c) : Number(position.entry);
  const exitTime = last ? Number(last.t) + MINUTE_INTERVAL_MS : Math.max(position.fillTime, endTime - 1);
  const direction = position.side === 'long' ? 1 : -1;
  const grossPnlUsdt = direction * (exitPrice - Number(position.entry)) * Number(position.quantity);
  const modeledCostUsdt = costRate * Number(position.entry) * Number(position.quantity);
  const netPnlUsdt = grossPnlUsdt + Number(accrued.position.fundingPnlUsdt || 0) - modeledCostUsdt;
  const trade = {...accrued.position, exitReason: 'end-of-window', exitTime, exitPrice, grossPnlUsdt, modeledCostUsdt, netPnlUsdt, netR: Number(position.riskUsdt) > 0 ? netPnlUsdt / Number(position.riskUsdt) : null};
  return finishedOutcome(base, position, trade, profile, accrued);
}

function v9RefractoryHours() {
  return Object.fromEntries(V9_ALPHA_IDS.map(alpha => [alpha, 72]));
}

export function createFeatureRows({universe, dataRoot, enhancedRoot, start, end, marketBySymbol, btcSeries}) {
  const pointsBySymbol = new Map();
  const candidatesBySymbol = {};
  const symbolStatus = {};
  const featureAvailability = {takerBuyVolume: 0, metrics: 0, openInterest: 0, premiumIndex: 0, markPrice: 0, indexPrice: 0, funding: 0};
  const metricsRejectionCounts = {};
  const metricsPITBySymbol = {};
  const metricsArtifacts = metricsArtifactBySymbol(enhancedRoot);
  for (const symbol of universe.symbols) {
    const lifecycle = universe.markets.get(symbol) || {};
    const window = activeWindow(lifecycle, start, end);
    if (!window.active) {
      symbolStatus[symbol] = 'no-development-window';
      pointsBySymbol.set(symbol, []);
      candidatesBySymbol[symbol] = [];
      continue;
    }
    const historyStart = Math.max(0, window.activeStart - 120 * DAY);
    const rows = loadEnhancedRows(enhancedRoot, symbol, historyStart, window.activeEnd + H1);
    if (!rows.length) {
      symbolStatus[symbol] = 'missing-taker-buy-1h';
      pointsBySymbol.set(symbol, []);
      candidatesBySymbol[symbol] = [];
      continue;
    }
    const funding = loadGzipRows(dataRoot, 'funding', symbol, historyStart - DAY, window.activeEnd + H1)
      .map(row => ({t: finite(row.t ?? row.fundingTime), rate: finite(row.rate ?? row.fundingRate)})).filter(row => row.t != null);
    const metricsArtifact = metricsArtifacts.get(symbol);
    const metricsAvailable = Boolean(metricsArtifact?.rows > 0 && (metricsArtifact.invalidArchiveDates || []).length === 0);
    // Metrics are admitted when official rows exist. Continuity is evaluated
    // at each signal time by metrics.mjs; a local gap can reject that signal
    // without disabling the symbol for the rest of the development window.
    const metrics = metricsAvailable ? loadOptionalRows(enhancedRoot, 'metrics', symbol, historyStart, window.activeEnd + H1) : [];
    const openInterest = loadOptionalRows(enhancedRoot, 'open-interest-1h', symbol, historyStart, window.activeEnd + H1);
    const premium = loadOptionalRows(enhancedRoot, 'premium-1h', symbol, historyStart, window.activeEnd + H1);
    const mark = loadOptionalRows(enhancedRoot, 'mark-1h', symbol, historyStart, window.activeEnd + H1);
    const index = loadOptionalRows(enhancedRoot, 'index-1h', symbol, historyStart, window.activeEnd + H1);
    const series = buildV9FeatureSeries(rows, {funding, btcSeries, metricsRows: metrics, openInterest, premium, mark, index, endTime: window.activeEnd + H1});
    const points = series.points.filter(point => point.signalTime >= window.activeStart && point.signalTime < window.activeEnd);
    metricsPITBySymbol[symbol] = points.filter(point => point.metricsAvailable).length;
    for (const point of points) for (const reason of point.metricsRejections || []) metricsRejectionCounts[reason] = (metricsRejectionCounts[reason] || 0) + 1;
    // Diagnostics are aggregated above; do not retain a per-point object in
    // every candidate feature because the formal replay may contain millions
    // of feature points.
    for (const point of points) {
      delete point.metricsRejections;
      delete point.metricsDiagnostics;
    }
    pointsBySymbol.set(symbol, points);
    if (series.dataAvailability.takerBuyVolume) featureAvailability.takerBuyVolume++;
    if (series.dataAvailability.metrics) featureAvailability.metrics++;
    if (series.dataAvailability.openInterest) featureAvailability.openInterest++;
    if (series.dataAvailability.premiumIndex) featureAvailability.premiumIndex++;
    if (series.dataAvailability.markPrice) featureAvailability.markPrice++;
    if (series.dataAvailability.indexPrice) featureAvailability.indexPrice++;
    if (series.dataAvailability.funding) featureAvailability.funding++;
    symbolStatus[symbol] = points.length ? 'processed' : 'insufficient-completed-4h-bars';
  }
  const rankedPoints = assignCrossSectionalRanks(pointsBySymbol);
  for (const symbol of universe.symbols) {
    const market = marketBySymbol.get(symbol);
    const points = rankedPoints.get(symbol) || [];
    candidatesBySymbol[symbol] = points.flatMap(point => generateV9Candidates(point, market));
  }
  return {pointsBySymbol: rankedPoints, candidatesBySymbol, symbolStatus, featureAvailability, metricsRejectionCounts, metricsPITBySymbol};
}

async function processStandaloneAssignment({candidateGroups, marketRows, dataRoot, start, end, cacheDir}) {
  const marketBySymbol = new Map(marketRows);
  const dataAccess = createV9DataAccess(dataRoot, marketBySymbol, start, end);
  for (const [symbol, candidates] of Object.entries(candidateGroups)) {
    const market = marketBySymbol.get(symbol);
    const activeEnd = Math.min(end, parseTime(market?.activeEnd, end));
    const minuteRows = dataAccess.loadMinute(symbol);
    const minuteQuery = buildMinuteQuery(minuteRows);
    const fundingRows = dataAccess.loadFunding(symbol, start - DAY, activeEnd + H1);
    const fundingQuery = buildFundingQuery(fundingRows, minuteRows);
    const outcomes = [];
    for (const candidate of candidates.sort((a, b) => Number(a.t) - Number(b.t) || String(a.id).localeCompare(String(b.id)))) {
      outcomes.push(simulateV9StandaloneObservation(candidate, {market, minuteRows, minuteQuery, fundingRows, fundingQuery, activeEnd}));
    }
    dataAccess.release(symbol);
    writeGzipJsonAtomic(path.join(cacheDir, `${symbol}.json.gz`), outcomes);
  }
}

function runStandaloneWorker(workerPayload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {workerData: {type: 'v9-standalone', ...workerPayload}});
    worker.once('message', message => message.ok ? resolve(message) : reject(new Error(message.error)));
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`V9 standalone worker exited with code ${code}`)); });
  });
}

async function buildStandaloneOutcomes({independentObservations, marketBySymbol, dataAccess, dataRoot, start, end, cacheDir = null, workerCount = 1}) {
  const bySymbol = new Map();
  for (const candidate of independentObservations) {
    if (!bySymbol.has(candidate.marketId)) bySymbol.set(candidate.marketId, []);
    bySymbol.get(candidate.marketId).push(candidate);
  }
  const entries = [...bySymbol.entries()];
  const outcomes = [];
  const pending = [];
  for (const [symbol, candidates] of entries) {
    const cacheFile = cacheDir ? path.join(cacheDir, `${symbol}.json.gz`) : null;
    if (cacheFile && fs.existsSync(cacheFile)) {
      const cached = readGzipJson(cacheFile);
      if (Array.isArray(cached) && cached.length === candidates.length) {
        outcomes.push(...cached.map(compactOutcome));
        continue;
      }
    }
    pending.push([symbol, candidates]);
  }
  if (pending.length && cacheDir && workerCount > 1) {
    const assignments = Array.from({length: Math.min(workerCount, pending.length)}, () => ({}));
    pending.forEach(([symbol, candidates], index) => { assignments[index % assignments.length][symbol] = candidates; });
    await Promise.all(assignments.filter(group => Object.keys(group).length).map(candidateGroups => runStandaloneWorker({
      candidateGroups, marketRows: [...marketBySymbol.entries()], dataRoot, start, end, cacheDir,
    })));
    for (const [symbol, candidates] of pending) {
      const cached = readGzipJson(path.join(cacheDir, `${symbol}.json.gz`));
      if (!Array.isArray(cached) || cached.length !== candidates.length) throw new Error(`V9 standalone cache incomplete for ${symbol}`);
      outcomes.push(...cached.map(compactOutcome));
    }
    return outcomes.sort((a, b) => Number(a.signalTime) - Number(b.signalTime) || String(a.observationId).localeCompare(String(b.observationId)));
  }
  for (const [symbol, candidates] of pending) {
    const cacheFile = cacheDir ? path.join(cacheDir, `${symbol}.json.gz`) : null;
    const market = marketBySymbol.get(symbol);
    const activeEnd = Math.min(end, parseTime(market?.activeEnd, end));
    const minuteRows = dataAccess.loadMinute(symbol);
    const minuteQuery = buildMinuteQuery(minuteRows);
    const fundingRows = dataAccess.loadFunding(symbol, start - DAY, activeEnd + H1);
    const fundingQuery = buildFundingQuery(fundingRows, minuteRows);
    for (const candidate of candidates.sort((a, b) => Number(a.t) - Number(b.t) || String(a.id).localeCompare(String(b.id)))) {
      outcomes.push(simulateV9StandaloneObservation(candidate, {market, minuteRows, minuteQuery, fundingRows, fundingQuery, activeEnd}));
    }
    dataAccess.release(symbol);
    if (cacheFile) writeGzipJsonAtomic(cacheFile, outcomes.splice(outcomes.length - candidates.length, candidates.length));
  }
  return outcomes.sort((a, b) => Number(a.signalTime) - Number(b.signalTime) || String(a.observationId).localeCompare(String(b.observationId)));
}

export function createV9DataAccess(dataRoot, marketBySymbol, start, end) {
  const base = createDevelopmentDataAccess(dataRoot, marketBySymbol, start, end);
  const minuteQueries = new Map();
  const profileCache = new Map();
  const profileSymbols = new Map();
  const firstTouch = (position, endTime) => {
    if (profileCache.has(position.id)) return profileCache.get(position.id);
    const rows = base.loadMinute(position.marketId);
    let query = minuteQueries.get(position.marketId);
    if (!query) {
      query = buildMinuteQuery(rows);
      minuteQueries.set(position.marketId, query);
    }
    const profile = queryTouchProfile(position, query, Number(endTime));
    profileCache.set(position.id, profile);
    if (!profileSymbols.has(position.marketId)) profileSymbols.set(position.marketId, new Set());
    profileSymbols.get(position.marketId).add(position.id);
    return profile;
  };
  const release = symbol => {
    // The V8 portfolio asks to keep a rejected symbol's data warm. That is
    // safe for its smaller cache, but the V9 formal 1m query is much larger;
    // retaining every rejected symbol can exhaust the process heap. A symbol
    // with no open position can be released immediately and will be reloaded
    // only if a later candidate needs it.
    minuteQueries.delete(symbol);
    for (const positionId of profileSymbols.get(symbol) || []) profileCache.delete(positionId);
    profileSymbols.delete(symbol);
    return base.release(symbol);
  };
  return {...base, firstTouch, release};
}

export function createV9OutcomeDataAccess(dataRoot, marketBySymbol, start, end, outcomes = []) {
  const base = createV9DataAccess(dataRoot, marketBySymbol, start, end);
  const byId = new Map(outcomes.map(row => [String(row.observationId ?? row.id), row]));
  const byDecision = new Map();
  for (const outcome of outcomes) {
    const decisionTime = Number(outcome.decisionTime);
    const fillTime = Number(outcome.fillTime);
    if (!Number.isFinite(decisionTime) || !Number.isFinite(fillTime) || !Number.isFinite(Number(outcome.fillPrice))) continue;
    byDecision.set(`${outcome.marketId}:${decisionTime}`, {t: fillTime, o: Number(outcome.fillPrice), c: Number(outcome.fillPrice)});
  }
  return {
    ...base,
    firstMinute: (symbol, decisionTime, endTime) => {
      const row = byDecision.get(`${symbol}:${Number(decisionTime)}`);
      return row && row.t + MINUTE_INTERVAL_MS <= Number(endTime) ? row : null;
    },
    firstTouch: (position, endTime) => {
      const outcome = byId.get(String(position.id));
      if (outcome?.outcomeType === 'researchTradeOutcome') {
        return {touch: outcome.touch || null, mfe: outcome.mfe ?? null, mae: outcome.mae ?? null};
      }
      return {touch: null, mfe: null, mae: null};
    },
  };
}

export async function runV9Replay({dataRoot, enhancedRoot, appDir, start, end, maxSymbols = 150, workerCount = 2, standaloneCacheDir} = {}) {
  const progress = label => { if (process.env.V9_PROGRESS === '1') console.error(`[v9] ${label}`); };
  progress('universe');
  const universe = loadV9Universe(dataRoot, appDir, {start, end, limit: maxSymbols});
  const marketBySymbol = marketMap(universe);
  const btcMarket = marketBySymbol.get('BTCUSDT');
  const btcLifecycle = universe.markets.get('BTCUSDT') || {};
  const btcWindow = activeWindow(btcLifecycle, start, end);
  const btcRows = loadEnhancedRows(enhancedRoot, 'BTCUSDT', Math.max(0, btcWindow.activeStart - 120 * DAY), btcWindow.activeEnd + H1);
  const btcFunding = loadGzipRows(dataRoot, 'funding', 'BTCUSDT', Math.max(0, start - 120 * DAY), end + H1)
    .map(row => ({t: finite(row.t ?? row.fundingTime), rate: finite(row.rate ?? row.fundingRate)})).filter(row => row.t != null);
  const btcSeries = btcRows.length ? buildV9FeatureSeries(btcRows, {funding: btcFunding, endTime: end + H1}) : {points: []};
  progress('features:start');
  const features = createFeatureRows({universe, dataRoot, enhancedRoot, start, end, marketBySymbol, btcSeries});
  progress('features:done');
  let rawCandidates = Object.values(features.candidatesBySymbol).flat()
    .sort((a, b) => Number(a.t) - Number(b.t) || String(a.side).localeCompare(String(b.side)) || String(a.id).localeCompare(String(b.id)));
  const rawCandidateSummary = rawCandidates.map(candidate => ({t: candidate.t, side: candidate.side, alpha: candidate.alpha, regime: candidate.regime}));
  delete features.candidatesBySymbol;
  features.pointsBySymbol.clear();
  const independentObservations = dedupeResearchEpisodes(rawCandidates, {refractoryHoursByAlpha: v9RefractoryHours()});
  const rankedCandidates = rankResearchCandidates(independentObservations);
  rawCandidates = null;
  progress(`candidates:done independent=${independentObservations.length} ranked=${rankedCandidates.length}`);
  const dataAccess = createV9DataAccess(dataRoot, marketBySymbol, start, end);
  const cacheDir = standaloneCacheDir === undefined ? path.join(enhancedRoot, 'standalone-cache-v4') : standaloneCacheDir;
  const standaloneOutcomes = await buildStandaloneOutcomes({independentObservations, marketBySymbol, dataAccess, dataRoot, start, end, cacheDir, workerCount});
  progress('standalone:done');
  const qualifiedRanked = rankedCandidates.filter(candidate => candidate.tier === 'A' || candidate.tier === 'B');
  // Portfolio simulation is performed after purged OOF selection by the
  // Development runner. Running the pre-selection portfolio here duplicated
  // the expensive acceptance/fill pass without affecting any reported result.
  const portfolio = {accepted: [], rejected: [], closedTrades: [], rankedCount: 0};
  progress('portfolio:deferred');
  return {
    universe, marketBySymbol, dataAccess, btcContext: {rows: btcRows.length, points: btcSeries.points.length, market: btcMarket?.symbol || null},
    rawCandidates: rawCandidateSummary, independentObservations, rankedCandidates, standaloneOutcomes, portfolio,
    symbolStatus: features.symbolStatus, featureAvailability: features.featureAvailability,
    metricsDiagnostics: {rejectionCounts: features.metricsRejectionCounts, pitObservationsBySymbol: features.metricsPITBySymbol},
    counts: {
      rawCandidates: rawCandidateSummary.length, independentObservations: independentObservations.length,
      rankedCandidates: rankedCandidates.length, qualifiedRanked: qualifiedRanked.length,
      standaloneExecutable: standaloneOutcomes.filter(row => row.executable).length,
      standaloneRejected: standaloneOutcomes.filter(row => !row.executable).length,
      accepted: portfolio.accepted.length, rejected: portfolio.rejected.length, trades: portfolio.closedTrades.length,
    },
    sourceManifestSha256: hashFile(path.join(dataRoot, 'manifest.json')),
    enhancedManifestSha256: hashFile(path.join(enhancedRoot, 'manifest.json')),
    artifactDir: enhancedRoot,
  };
}

export function mergeV9RankedWithBaseline(v9Rows, baselineRows) {
  return rankResearchCandidates(mergeResearchCandidates([...(baselineRows || []), ...(v9Rows || [])]));
}

if (!isMainThread && workerData?.type === 'v9-standalone') {
  processStandaloneAssignment(workerData).then(() => parentPort.postMessage({ok: true})).catch(error => {
    parentPort.postMessage({ok: false, error: error.stack || error.message});
    process.exitCode = 1;
  });
}
