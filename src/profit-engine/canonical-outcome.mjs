import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {isMainThread, parentPort, Worker, workerData} from 'node:worker_threads';
import {H1} from '../config.mjs';
import {createDevelopmentDataAccess} from '../v81/replay.mjs';
import {evaluateCandidateAcceptance} from '../portfolio.mjs';
import {buildFundingQuery, buildMinuteQuery} from '../v9/replay.mjs';
import {CANONICAL_OUTCOME_CONTRACT} from './labels.mjs';
import {PROFIT_PORTFOLIO_CONFIG} from './portfolio.mjs';

const MINUTE_MS = H1 / 60;
const VERTICAL_BARRIER_MS = CANONICAL_OUTCOME_CONTRACT.verticalBarrierHours * H1;
const CANONICAL_CACHE_VERSION = 'canonical-72h-v2';

function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }

function lowerBound(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].t) < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].t) <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function validMinute(row) {
  return Number(row?.t) >= 0 && Number(row?.o) > 0 && Number(row?.h) > 0
    && Number(row?.l) > 0 && Number(row?.c) > 0
    && row?.complete !== false && row?.isComplete !== false && row?.closed !== false;
}

function normalizeMinuteRows(rows) {
  const byTime = new Map();
  for (const row of rows || []) {
    if (!validMinute(row)) continue;
    const t = Number(row.t);
    if (!Number.isFinite(t)) continue;
    byTime.set(t, {t, o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c)});
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function firstExecutableMinute(rows, decisionTime) {
  const start = lowerBound(rows, decisionTime);
  for (let index = start; index < rows.length; index++) {
    const row = rows[index];
    if (row.t < decisionTime || !validMinute(row)) continue;
    return row;
  }
  return null;
}

function completedEnd(rows, barrierTime) {
  return upperBound(rows, barrierTime - MINUTE_MS);
}

function firstTouch(rows, query, fillTime, barrierTime, side, stop, target) {
  const start = lowerBound(rows, fillTime);
  const end = completedEnd(rows, barrierTime);
  if (start >= end) return null;
  const stopIndex = side === 'long'
    ? query.firstLow(start, end, stop)
    : query.firstHigh(start, end, stop);
  const targetIndex = side === 'long'
    ? query.firstHigh(start, end, target)
    : query.firstLow(start, end, target);
  if (stopIndex < 0 && targetIndex < 0) return null;
  const stopWins = stopIndex >= 0 && (targetIndex < 0 || stopIndex <= targetIndex);
  const index = stopWins ? stopIndex : targetIndex;
  const row = rows[index];
  const stopHit = stopIndex === index;
  const targetHit = targetIndex === index;
  return {
    exitReason: stopHit ? 'SL' : 'TP',
    exitPrice: stopHit ? stop : target,
    exitTime: Number(row.t) + MINUTE_MS,
    touchMinute: Number(row.t),
    ambiguousSameMinute: Boolean(stopHit && targetHit),
  };
}

function verticalMark(rows, fillTime, barrierTime) {
  const start = lowerBound(rows, fillTime);
  const end = completedEnd(rows, barrierTime);
  if (start >= end) return null;
  const row = rows[end - 1];
  return {
    exitReason: 'VERTICAL_MTM',
    exitPrice: Number(row.c),
    exitTime: Number(row.t) + MINUTE_MS,
    touchMinute: null,
    ambiguousSameMinute: false,
  };
}

function canonicalFunding(fundingRows, minuteRows, fillTime, exitTime, fillPrice, quantity, side, fundingQuery = null) {
  const query = fundingQuery || buildFundingQuery(fundingRows, minuteRows);
  const funding = query.query(fillTime - 1, exitTime, fillPrice);
  const direction = side === 'long' ? -1 : 1;
  return {
    fundingPnlUsdt: direction * Number(funding.cashflow || 0) * Number(quantity),
    fundingEvents: Number(funding.fundingEvents || 0),
    fallbackMarkPriceRows: Number(funding.fallbackMarkPriceRows || 0),
    lastFundingTime: funding.lastFundingTime,
  };
}

function baseOutcome(candidate, decisionTime) {
  return {
    outcomeType: 'canonical-72h-research-outcome',
    observationId: candidate.id,
    episodeId: candidate.episodeId || null,
    marketId: candidate.marketId,
    symbol: candidate.symbol || candidate.marketId,
    side: candidate.side,
    alpha: candidate.alpha,
    alphaSources: candidate.alphaSources || candidate.proposalSources || [candidate.alpha],
    proposalSources: candidate.proposalSources || [],
    family: candidate.family,
    signalTime: Number(candidate.signalTime ?? candidate.t),
    decisionTime,
    fillTime: null,
    fillPrice: null,
    stop: null,
    target: null,
    targetR: CANONICAL_OUTCOME_CONTRACT.targetR,
    effectiveTargetR: null,
    stopPct: null,
    quantity: null,
    riskUsdt: null,
    exitReason: null,
    exitTime: null,
    exitPrice: null,
    canonicalBarrierTime: null,
    canonicalDurationHours: null,
    grossPnlUsdt: null,
    fundingPnlUsdt: null,
    modeledCostUsdt: null,
    netPnlUsdt: null,
    netR: null,
    executable: false,
    canonicalExecutable: false,
    outcomeStatus: 'not-executable',
    rejectionReason: null,
    ambiguousSameMinute: false,
    fundingEvents: 0,
    fallbackMarkPriceRows: 0,
  };
}

export function simulateCanonicalOutcome(candidate, {
  market,
  minuteRows = [],
  minuteRowsPrepared = false,
  minuteQuery = null,
  fundingRows = [],
  fundingQuery = null,
  equityUsdt = PROFIT_PORTFOLIO_CONFIG.initialEquityUsdt,
  costRate = PROFIT_PORTFOLIO_CONFIG.costRate,
} = {}) {
  const signalTime = Number(candidate.signalTime ?? candidate.t);
  const decisionTime = signalTime + CANONICAL_OUTCOME_CONTRACT.decisionLatencyMinutes * 60_000;
  const base = baseOutcome(candidate, decisionTime);
  const validRows = minuteRowsPrepared ? minuteRows : normalizeMinuteRows(minuteRows);
  const firstMinute = firstExecutableMinute(validRows, decisionTime);
  if (!firstMinute) return {...base, rejectionReason: 'fill-price-unavailable'};

  // Canonical labels always use the frozen 2R contract, even when a source
  // proposal was emitted by a legacy alpha with a different target.
  const canonicalCandidate = {...candidate, targetR: CANONICAL_OUTCOME_CONTRACT.targetR};
  const acceptance = evaluateCandidateAcceptance(canonicalCandidate, {
    activePositions: [], cooldowns: {}, equityUsdt, market, decisionTime,
    fillTime: firstMinute.t, fillPrice: firstMinute.o, strictFill: true,
    positionCap: Number.MAX_SAFE_INTEGER, sideCap: Number.MAX_SAFE_INTEGER,
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

  const filledRisk = acceptance.filledRisk;
  const barrierTime = Number(acceptance.fillTime) + VERTICAL_BARRIER_MS;
  const query = minuteQuery || buildMinuteQuery(validRows);
  const touch = firstTouch(validRows, query, Number(acceptance.fillTime), barrierTime, candidate.side, Number(filledRisk.stop), Number(filledRisk.target));
  const exit = touch || verticalMark(validRows, Number(acceptance.fillTime), barrierTime);
  if (!exit) {
    return {
      ...base,
      fillTime: acceptance.fillTime,
      fillPrice: acceptance.fillPrice,
      stop: filledRisk.stop,
      target: filledRisk.target,
      stopPct: filledRisk.stopPct,
      effectiveTargetR: filledRisk.effectiveTargetR,
      canonicalBarrierTime: barrierTime,
      rejectionReason: 'canonical-vertical-price-unavailable',
    };
  }

  const funding = canonicalFunding(fundingRows, validRows, Number(acceptance.fillTime), Number(exit.exitTime), Number(acceptance.fillPrice), Number(acceptance.quantity), candidate.side, fundingQuery);
  const direction = candidate.side === 'long' ? 1 : -1;
  const grossPnlUsdt = direction * (Number(exit.exitPrice) - Number(acceptance.fillPrice)) * Number(acceptance.quantity);
  const modeledCostUsdt = Number(costRate) * Number(acceptance.fillPrice) * Number(acceptance.quantity);
  const netPnlUsdt = grossPnlUsdt + funding.fundingPnlUsdt - modeledCostUsdt;
  const canonicalDurationHours = (Number(exit.exitTime) - Number(acceptance.fillTime)) / 3_600_000;
  if (!(canonicalDurationHours >= 0 && canonicalDurationHours <= CANONICAL_OUTCOME_CONTRACT.verticalBarrierHours + 1 / 60)) {
    throw new Error(`canonical duration exceeds 72h for ${candidate.id}: ${canonicalDurationHours}`);
  }
  return {
    ...base,
    executable: true,
    canonicalExecutable: true,
    outcomeStatus: 'closed',
    fillTime: acceptance.fillTime,
    fillPrice: acceptance.fillPrice,
    stop: filledRisk.stop,
    target: filledRisk.target,
    targetR: filledRisk.targetR,
    effectiveTargetR: filledRisk.effectiveTargetR,
    stopPct: filledRisk.stopPct,
    quantity: acceptance.quantity,
    riskUsdt: acceptance.riskUsdt,
    exitReason: exit.exitReason,
    exitTime: exit.exitTime,
    exitPrice: exit.exitPrice,
    canonicalBarrierTime: barrierTime,
    canonicalDurationHours,
    grossPnlUsdt,
    fundingPnlUsdt: funding.fundingPnlUsdt,
    modeledCostUsdt,
    netPnlUsdt,
    netR: Number(acceptance.riskUsdt) > 0 ? netPnlUsdt / Number(acceptance.riskUsdt) : null,
    ambiguousSameMinute: exit.ambiguousSameMinute,
    fundingEvents: funding.fundingEvents,
    fallbackMarkPriceRows: funding.fallbackMarkPriceRows,
  };
}

function cacheFingerprint(proposals) {
  return crypto.createHash('sha256').update(JSON.stringify((proposals || []).map(row => [row.id, row.signalTime ?? row.t, row.side, row.sl ?? row.stop, row.targetR]))).digest('hex');
}

function readCache(file, proposals) {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    if (parsed.version !== CANONICAL_CACHE_VERSION || parsed.fingerprint !== cacheFingerprint(proposals) || parsed.outcomes?.length !== proposals.length) return null;
    const ids = parsed.outcomes.map(row => String(row.observationId ?? row.id));
    if (ids.some((id, index) => id !== String(proposals[index].id))) return null;
    return parsed.outcomes;
  } catch {
    return null;
  }
}

function writeCache(file, proposals, outcomes) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, zlib.gzipSync(JSON.stringify({version: CANONICAL_CACHE_VERSION, fingerprint: cacheFingerprint(proposals), outcomes}), {level: 1}));
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function symbolOutcomes({symbol, proposals, market, dataRoot, start, end}) {
  const dataEnd = Number(end) + VERTICAL_BARRIER_MS + H1;
  const dataAccess = createDevelopmentDataAccess(dataRoot, new Map([[symbol, market]]), Number(start), dataEnd);
  const minuteRows = normalizeMinuteRows(dataAccess.loadMinute(symbol));
  const fundingRows = dataAccess.loadFunding(symbol, Number(start) - 24 * H1, dataEnd);
  const minuteQuery = buildMinuteQuery(minuteRows);
  const fundingQuery = buildFundingQuery(fundingRows, minuteRows);
  const outcomes = proposals.map(proposal => simulateCanonicalOutcome(proposal, {
    market, minuteRows, minuteRowsPrepared: true, minuteQuery, fundingRows, fundingQuery,
  }));
  dataAccess.release(symbol);
  return outcomes;
}

function runSymbolWorker(payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {workerData: {type: 'canonical-symbol', ...payload}});
    worker.once('message', message => message.ok ? resolve(message.outcomes) : reject(new Error(message.error)));
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`canonical worker exited with code ${code}`)); });
  });
}

export async function buildCanonicalOutcomes(proposals, {
  dataRoot,
  marketBySymbol,
  start,
  end,
  cacheDir = null,
  workerCount = 1,
  progress = () => {},
} = {}) {
  const bySymbol = new Map();
  for (const proposal of proposals || []) {
    const symbol = proposal.marketId || proposal.symbol;
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
    bySymbol.get(symbol).push(proposal);
  }
  const entries = [...bySymbol.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)));
  const results = new Map();
  const pending = [];
  for (const [symbol, rows] of entries) {
    rows.sort((a, b) => Number(a.signalTime ?? a.t) - Number(b.signalTime ?? b.t) || String(a.id).localeCompare(String(b.id)));
    const file = cacheDir ? path.join(cacheDir, `${symbol}.json.gz`) : null;
    const cached = file ? readCache(file, rows) : null;
    if (cached) { results.set(symbol, cached); progress(`canonical cache ${symbol}`); continue; }
    pending.push([symbol, rows, file]);
  }
  const count = Math.max(1, Math.min(Number(workerCount) || 1, pending.length || 1));
  if (pending.length && count > 1) {
    const assignments = Array.from({length: count}, () => []);
    pending.forEach((item, index) => assignments[index % count].push(item));
    await Promise.all(assignments.filter(rows => rows.length).map(async assignment => {
      for (const [symbol, rows, file] of assignment) {
        const outcomes = await runSymbolWorker({symbol, proposals: rows, market: marketBySymbol?.get?.(symbol) || null, dataRoot, start, end});
        if (file) writeCache(file, rows, outcomes);
        results.set(symbol, outcomes);
        progress(`canonical ${symbol}`);
      }
    }));
  } else {
    for (const [symbol, rows, file] of pending) {
      const outcomes = symbolOutcomes({symbol, proposals: rows, market: marketBySymbol?.get?.(symbol) || null, dataRoot, start, end});
      if (file) writeCache(file, rows, outcomes);
      results.set(symbol, outcomes);
      progress(`canonical ${symbol}`);
    }
  }
  return entries.flatMap(([symbol]) => results.get(symbol) || [])
    .sort((a, b) => Number(a.signalTime) - Number(b.signalTime) || String(a.observationId).localeCompare(String(b.observationId)));
}

export {firstExecutableMinute, firstTouch, verticalMark};

if (!isMainThread && workerData?.type === 'canonical-symbol') {
  try {
    const outcomes = symbolOutcomes(workerData);
    parentPort.postMessage({ok: true, outcomes});
  } catch (error) {
    parentPort.postMessage({ok: false, error: error.stack || error.message});
    process.exitCode = 1;
  }
}
