import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {APP_DIR, CORE_MARKETS, DAY, H1, H4, modelConfig, v8ShadowConfig, WORKSPACE_DIR} from '../src/config.mjs';
import {aggregate} from '../src/indicators.mjs';
import {buildBreadth, buildBtcEnvironment, generateLatestCandidates} from '../src/strategy.mjs';
import {generateV8ShadowCandidates} from '../src/v8-shadow.mjs';
import {recalculateFilledRisk} from '../src/fill-risk.mjs';
import {marketRules} from '../src/market-data.mjs';
import {evaluateCandidateAcceptance, rankCandidates} from '../src/portfolio.mjs';
import {allocateResearchRisk} from '../src/risk.mjs';
import {accrueFunding, calculateMetrics, drawdownPercent, priceAtOrBefore, settleOnCompletedBars} from '../src/backtest.mjs';
import {activeWindowForMarket, hasCompleteSeries} from './backtest-data.mjs';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const SNAPSHOT_END = Date.parse('2026-07-15T00:00:00.000Z');
const INITIAL_EQUITY = 10_000;
const DECISION_LATENCY_MS = 20 * 60_000;
export const REQUIRED_ALPHA_COVERAGE = Object.freeze([
  'daily_breakout_long',
  'funding_crowding_short',
  'volume_shock_short',
  'v8_bear_trend_short',
]);

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

function readGzipJson(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim();
  return text ? JSON.parse(text) : [];
}

function loadRows(directory, symbol, funding = false) {
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory)
    .filter(name => name.match(new RegExp(`^${symbol}-\\d+\\.json\\.gz$`)))
    .sort((a, b) => Number(a.match(/-(\d+)\./)[1]) - Number(b.match(/-(\d+)\./)[1]));
  const sourceFiles = files.length
    ? files
    : (fs.existsSync(path.join(directory, `${symbol}.json.gz`)) ? [`${symbol}.json.gz`] : []);
  const byTime = new Map();
  for (const file of sourceFiles) {
    for (const row of readGzipJson(path.join(directory, file))) {
      const t = Number(row.t ?? row.fundingTime);
      if (!Number.isFinite(t)) continue;
      byTime.set(t, funding ? {t, rate: Number(row.rate ?? row.fundingRate), markPrice: Number(row.markPrice) || null}
        : {t, o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c), q: Number(row.q || 0)});
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function completedSlice(rows, endTime, period = H1) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].t + period <= endTime) low = middle + 1;
    else high = middle;
  }
  return rows.slice(0, low);
}

function beforeSlice(rows, endTime) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].t < endTime) low = middle + 1;
    else high = middle;
  }
  return rows.slice(0, low);
}

function nextBar(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].t < timestamp) low = middle + 1;
    else high = middle;
  }
  return rows[low] ?? null;
}

function exchangeMarkets(dataRoot, externalCache) {
  const file = externalCache
    ? path.join(dataRoot, 'v60_full_universe_cache', 'exchangeInfo.json')
    : path.join(dataRoot, 'exchangeInfo.json');
  if (!fs.existsSync(file)) return new Map();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map((parsed.symbols || []).map(item => [item.symbol, item]));
}

function marketFor(symbol, exchange) {
  const item = exchange.get(symbol) || {};
  return {
    symbol,
    baseAsset: item.baseAsset || symbol.replace(/USDT$/, ''),
    onboardDate: Number(item.onboardDate) || 0,
    deliveryDate: Number(item.deliveryDate) || 0,
    filters: item.filters || [],
    core: CORE_MARKETS.has(symbol),
  };
}

export function makeScanTimes(start, end, intervalHours = 4) {
  const hours = Number(intervalHours);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('scan interval must be a positive number of hours');
  const step = Math.max(1, Math.round(hours)) * H1;
  const first = Math.ceil(start / step) * step;
  const output = [];
  for (let t = first; t < end; t += step) output.push(t);
  return output;
}

export function buildCoreBreadth(dailyByMarket) {
  return buildBreadth(new Map([...dailyByMarket].filter(([symbol]) => CORE_MARKETS.has(symbol))));
}

function signalEvent(candidate, model) {
  return {
    model,
    id: candidate.id,
    marketId: candidate.marketId,
    symbol: candidate.marketId || candidate.symbol,
    side: candidate.side,
    family: candidate.family,
    alpha: candidate.alpha || 'unknown',
    regime: candidate.btcRouter || 'unknown',
    btcRouter: candidate.btcRouter || 'unknown',
    signalTime: candidate.t,
    signalPrice: Number(candidate.signalPrice ?? candidate.entry) || null,
    stop: Number(candidate.sl) || null,
    target: Number(candidate.target) || null,
    targetR: Number(candidate.targetR) || null,
    stopPct: Number(candidate.stopPct) || null,
    edgeScore: candidate.edgeScore,
    eventScore: candidate.eventScore,
    dayVolume: candidate.dayVolume,
    core: Boolean(candidate.core),
  };
}

function declaredMinuteArtifact(manifest, symbol) {
  return (manifest?.artifacts || []).find(item => item.symbol === symbol && item.kind === 'minute') || null;
}

function ensureMinuteData(data) {
  if (typeof data.loadMinute === 'function') data.loadMinute();
  return data.m1;
}

function ensurePriceData(data) {
  if (typeof data.loadPrice === 'function') data.loadPrice();
  return data.h1;
}

function createModel(name, v8 = false) {
  return {
    name,
    v8,
    equity: INITIAL_EQUITY,
    peakEquity: INITIAL_EQUITY,
    open: [],
    trades: [],
    signalEvents: [],
    allocations: [],
    rawCandidateEvents: [],
    rawCandidateCount: 0,
    rankedSignalCount: 0,
    acceptedSignalCount: 0,
    knownSignalIds: new Set(),
    acceptedSignalEvents: [],
    cooldowns: {},
    rejectionReasons: {},
    acceptedSignals: 0,
  };
}

function recordReject(model, reason) {
  model.rejectionReasons[reason] = (model.rejectionReasons[reason] || 0) + 1;
}

export function observedAlphaCoverage(model) {
  return [...new Set([
    ...model.signalEvents.map(event => event.alpha),
    ...model.trades.map(trade => trade.alpha),
  ].filter(alpha => typeof alpha === 'string' && alpha.length > 0))].sort();
}

function eventTime(event) {
  if (Number.isFinite(Number(event?.signalTime))) return Number(event.signalTime);
  return Date.parse(event?.signalTime || '') || 0;
}

function eventsInWindow(events, start, end) {
  return (events || []).filter(event => eventTime(event) >= start && eventTime(event) < end);
}

function alertKey(event) {
  return `${event.marketId}|${event.side}|${event.signalTime}`;
}

function signalCohortMetrics(model, start, end, periodStart, periodEnd) {
  const raw = eventsInWindow(model.rawCandidateEvents, start, end);
  const ranked = eventsInWindow(model.signalEvents, start, end);
  const accepted = eventsInWindow(model.acceptedSignalEvents, start, end);
  const isRecordedWindow = model.recordEventWindow
    && Number(model.recordEventWindow.start) === Number(start)
    && Number(model.recordEventWindow.end) === Number(end);
  const rawCount = isRecordedWindow ? model.rawCandidateCount : raw.length;
  const rankedCount = isRecordedWindow ? model.rankedSignalCount : ranked.length;
  const acceptedCount = isRecordedWindow ? model.acceptedSignalCount : accepted.length;
  const trades = (model.trades || []).filter(trade => eventTime({signalTime: trade.signalTime ?? trade.signal_time}) >= start
    && eventTime({signalTime: trade.signalTime ?? trade.signal_time}) < end);
  return {
    ...calculateMetrics(trades, {
      signals: rankedCount,
      initialEquity: INITIAL_EQUITY,
      periodStart,
      periodEnd,
    }),
    rawCandidates: rawCount,
    rankedSignals: rankedCount,
    uniqueAlerts: new Set(ranked.map(alertKey)).size,
    acceptedSignals: acceptedCount,
  };
}

function closePositionAtEnd(position, data, endTime, costRate, useMinute) {
  const bars = useMinute ? data.m1 : data.h1;
  const accrued = accrueFunding(position, data.funding, timestamp => priceAtOrBefore(bars, timestamp, position.entry), endTime + 1);
  const exitPrice = priceAtOrBefore(bars, endTime - 1, position.entry);
  const direction = position.side === 'long' ? 1 : -1;
  const grossPnlUsdt = direction * (exitPrice - position.entry) * position.quantity;
  const modeledCostUsdt = costRate * position.entry * position.quantity;
  const netPnlUsdt = grossPnlUsdt + accrued.position.fundingPnlUsdt - modeledCostUsdt;
  return {
    ...accrued.position,
    status: 'closed',
    exitReason: 'end_of_sample',
    exitPrice,
    exitTime: endTime,
    ambiguousSameMinute: false,
    grossPnlUsdt,
    modeledCostUsdt,
    netPnlUsdt,
    netR: position.riskUsdt ? netPnlUsdt / position.riskUsdt : null,
  };
}

function recordClosedTrade(model, trade, marketId) {
  model.trades.push(trade);
  model.equity += trade.netPnlUsdt;
  model.peakEquity = Math.max(model.peakEquity, model.equity);
  model.cooldowns[marketId] = Math.max(Number(model.cooldowns[marketId] ?? -Infinity), Number(trade.exitTime));
}

function settleOpen(model, dataBySymbol, now, costRate, {preferMinute = false} = {}) {
  model.cooldowns ||= {};
  const kept = [];
  for (const position of model.open) {
    const data = dataBySymbol.get(position.marketId);
    if (!data) {
      kept.push(position);
      continue;
    }
    const useMinute = preferMinute && data.execution?.oneMinuteComplete === true;
    if (!useMinute) ensurePriceData(data);
    const bars = useMinute ? data.m1 : data.h1;
    const interval = useMinute ? 60_000 : H1;
    const lifecycleEnd = Math.min(now, data.lifecycle?.eligibleEnd ?? now);
    const result = settleOnCompletedBars(position, bars, data.funding, {
      now: lifecycleEnd,
      costRate,
      barIntervalMs: interval,
      priceAt: timestamp => priceAtOrBefore(bars, timestamp, position.entry),
    });
    if (!result.closed && lifecycleEnd >= (data.lifecycle?.eligibleEnd ?? Infinity)) {
      recordClosedTrade(model, closePositionAtEnd(position, data, lifecycleEnd, costRate, useMinute), position.marketId);
      continue;
    }
    if (!result.closed) {
      kept.push(result.position);
      continue;
    }
    recordClosedTrade(model, result.trade, position.marketId);
  }
  model.open = kept;
}

export function advanceModelTo(model, dataBySymbol, now, {
  costRate = modelConfig.stressRoundTripCost,
  preferMinute = false,
} = {}) {
  if (preferMinute) {
    for (const position of model.open) {
      const data = dataBySymbol.get(position.marketId);
      if (data) ensureMinuteData(data);
    }
  }
  settleOpen(model, dataBySymbol, now, costRate, {preferMinute});
}

export function resolveExecution(data, candidate, executionProxy = false, endTime = SNAPSHOT_END, minuteExecutionAvailable = true) {
  const decisionTime = candidate.t + DECISION_LATENCY_MS;
  if (minuteExecutionAvailable) {
    const minuteBar = nextBar(data.m1, decisionTime);
    if (minuteBar && minuteBar.t < endTime) {
      return {
        accepted: true,
        decisionTime,
        fillTime: minuteBar.t,
        fillPrice: Number(minuteBar.o),
        interval: '1m',
        executionProxy: false,
      };
    }
  }
  if (!executionProxy) return {accepted: false, reason: 'execution-data-unavailable', decisionTime};
  const proxyBar = nextBar(data.h1, decisionTime);
  if (!proxyBar || proxyBar.t >= endTime) return {accepted: false, reason: 'fill-price-unavailable', decisionTime};
  return {
    accepted: true,
    decisionTime,
    fillTime: proxyBar.t,
    fillPrice: Number(proxyBar.o),
    interval: '1h',
    executionProxy: true,
  };
}

function createPosition(model, candidate, data, {
  executionProxy = false,
  endTime = SNAPSHOT_END,
  minuteExecutionAvailable = true,
  execution = null,
  acceptance = null,
} = {}) {
  const resolvedExecution = execution || resolveExecution(data, candidate, executionProxy, endTime, minuteExecutionAvailable);
  if (!resolvedExecution.accepted || !(resolvedExecution.fillPrice > 0)) return {reason: resolvedExecution.reason || 'fill-price-unavailable'};
  let filledRisk;
  let quantity;

  let allocation;
  if (!model.v8) {
    const contract = acceptance || evaluateCandidateAcceptance(candidate, {
      activePositions: model.open,
      cooldowns: model.cooldowns,
      equityUsdt: model.equity,
      market: data.market,
      decisionTime: resolvedExecution.decisionTime,
      fillTime: resolvedExecution.fillTime,
      fillPrice: resolvedExecution.fillPrice,
      strictFill: true,
      positionCap: modelConfig.cap,
      sideCap: modelConfig.maxPerSide,
    });
    if (!contract.accepted) return {reason: contract.reason};
    filledRisk = contract.filledRisk;
    quantity = contract.quantity;
    allocation = {
      accepted: true,
      riskUsdt: contract.riskUsdt,
      riskFraction: modelConfig.riskFraction,
      method: 'frozen-control',
    };
  } else {
    const fillPrice = resolvedExecution.fillPrice;
    filledRisk = recalculateFilledRisk({
      side: candidate.side,
      family: candidate.family,
      fillPrice,
      stop: candidate.sl,
      targetR: candidate.targetR,
      tickSize: marketRules(data.market).tickSize,
    });
    if (!filledRisk.accepted) return {reason: filledRisk.reason};
    const riskPerUnit = Math.abs(filledRisk.fillPrice - filledRisk.stop);
    allocation = allocateResearchRisk({
      equityUsdt: model.equity,
      peakEquityUsdt: model.peakEquity,
      candidate: {...candidate, stopPct: filledRisk.stopPct},
      openPositions: model.open,
      closedPositions: model.trades,
    });
    if (allocation.accepted) quantity = allocation.riskUsdt / riskPerUnit;
  }
  if (!allocation.accepted) return {reason: allocation.reason, allocation};
  return {
    position: {
      id: candidate.id,
      modelVersion: model.v8 ? v8ShadowConfig.version : modelConfig.version,
      mode: model.v8 ? 'paper-shadow' : 'paper-backtest',
      status: 'open',
      marketId: candidate.marketId,
      symbol: candidate.symbol,
      side: candidate.side,
      alpha: candidate.alpha || (model.v8 ? 'unknown' : 'control'),
      family: candidate.family,
      route: candidate.route,
      signalTime: candidate.t,
      signalPrice: candidate.signalPrice ?? candidate.entry,
      decisionTime: resolvedExecution.decisionTime,
      fillTime: resolvedExecution.fillTime,
      fillPrice: filledRisk.fillPrice,
      entry: filledRisk.fillPrice,
      stop: filledRisk.stop,
      target: filledRisk.target,
      targetR: filledRisk.targetR,
      effectiveTargetR: filledRisk.effectiveTargetR,
      stopPct: filledRisk.stopPct,
      quantity,
      notionalUsdt: filledRisk.fillPrice * quantity,
      riskUsdt: allocation.riskUsdt,
      fundingPnlUsdt: 0,
      lastFundingTime: resolvedExecution.fillTime,
      lastCheckedAt: resolvedExecution.fillTime,
      btcRouter: candidate.btcRouter,
      features: {
        ...candidate.features,
        btcRouter: candidate.btcRouter,
        riskAllocation: allocation,
        executionProxy: resolvedExecution.executionProxy,
        executionInterval: resolvedExecution.interval,
      },
    },
    allocation,
  };
}

export function processCandidates(model, candidates, dataBySymbol, {
  executionProxy = false,
  endTime = SNAPSHOT_END,
  minuteExecutionAvailable = true,
  rankedCandidates = null,
  eventWindow = null,
  eventStorage = 'all',
} = {}) {
  model.cooldowns ||= {};
  model.rawCandidateEvents ||= [];
  model.signalEvents ||= [];
  model.acceptedSignalEvents ||= [];
  const unseen = candidates.filter(candidate => !model.knownSignalIds.has(candidate.id));
  const ranked = rankedCandidates
    ? rankedCandidates.filter(candidate => !model.knownSignalIds.has(candidate.id))
    : rankCandidates(unseen);
  const shouldRecord = candidate => !eventWindow
    || (Number(candidate.t) >= Number(eventWindow.start) && Number(candidate.t) < Number(eventWindow.end));
  const recordedUnseen = unseen.filter(shouldRecord);
  const recordedRanked = ranked.filter(shouldRecord);
  model.rawCandidateCount += recordedUnseen.length;
  model.rankedSignalCount += recordedRanked.length;
  if (eventStorage === 'all') model.rawCandidateEvents.push(...recordedUnseen.map(candidate => signalEvent(candidate, model.name)));
  const rankedEvents = recordedRanked.map(candidate => signalEvent(candidate, model.name));
  if (eventStorage === 'ranked-file') {
    const bySymbol = new Map();
    for (const event of rankedEvents) {
      if (!bySymbol.has(event.marketId)) bySymbol.set(event.marketId, []);
      bySymbol.get(event.marketId).push(event);
    }
    for (const [symbol, events] of bySymbol) {
      const file = model.rankedEventFiles?.get(symbol);
      if (file != null) {
        fs.writeSync(file, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
        model.rankedSignalSymbols.add(symbol);
      }
    }
  } else {
    model.signalEvents.push(...rankedEvents);
  }
  const cap = model.v8 ? v8ShadowConfig.positionCap : modelConfig.cap;
  const maxPerSide = model.v8 ? v8ShadowConfig.maxPerSide : modelConfig.maxPerSide;
  for (const candidate of ranked) {
    let reason = null;
    if (model.v8 && model.open.some(position => position.marketId === candidate.marketId)) reason = 'symbol-already-open';
    else if (model.v8 && model.open.length >= cap) reason = 'portfolio-cap';
    else if (model.v8 && model.open.filter(position => position.side === candidate.side).length >= maxPerSide) reason = 'side-cap';
    const data = dataBySymbol.get(candidate.marketId);
    const symbolEndTime = Math.min(endTime, data?.lifecycle?.eligibleEnd ?? endTime);
    const symbolMinuteAvailable = data?.execution?.oneMinuteComplete ?? minuteExecutionAvailable;
    if (!reason && data && symbolMinuteAvailable) ensureMinuteData(data);
    if (!reason && data && executionProxy && !symbolMinuteAvailable) ensurePriceData(data);
    const execution = !reason && data
      ? resolveExecution(data, candidate, executionProxy, symbolEndTime, symbolMinuteAvailable)
      : null;
    let acceptance = null;
    if (!model.v8 && !reason && data && execution?.accepted) {
      acceptance = evaluateCandidateAcceptance(candidate, {
        activePositions: model.open,
        cooldowns: model.cooldowns,
        equityUsdt: model.equity,
        market: data.market,
        decisionTime: execution.decisionTime,
        fillTime: execution.fillTime,
        fillPrice: execution.fillPrice,
        strictFill: true,
        positionCap: cap,
        sideCap: maxPerSide,
      });
      if (!acceptance.accepted) reason = acceptance.reason;
    } else if (!data) {
      reason = 'market-data-unavailable';
    }
    const created = !reason && data ? createPosition(model, candidate, data, {
      executionProxy,
      endTime: symbolEndTime,
      minuteExecutionAvailable: symbolMinuteAvailable,
      execution,
      acceptance,
    }) : null;
    if (!reason && !created?.position) reason = created?.reason || 'market-data-unavailable';
    if (reason) {
      recordReject(model, reason);
      continue;
    }
    model.open.push(created.position);
    model.allocations.push(created.allocation);
    if (shouldRecord(candidate)) {
      model.acceptedSignalCount++;
      if (eventStorage === 'all') model.acceptedSignalEvents.push(signalEvent(candidate, model.name));
    }
    model.acceptedSignals++;
  }
  for (const candidate of unseen) {
    if (!eventWindow || Number(candidate.t) >= Number(eventWindow.start)) model.knownSignalIds.add(candidate.id);
  }
}

function closeAtEnd(model, dataBySymbol, endTime, costRate, {preferMinute = false} = {}) {
  for (const position of model.open) {
    const data = dataBySymbol.get(position.marketId);
    if (!data) continue;
    if (preferMinute) ensureMinuteData(data);
    const useMinute = preferMinute && data.execution?.oneMinuteComplete === true;
    if (!useMinute) ensurePriceData(data);
    const symbolEnd = Math.min(endTime, data.lifecycle?.eligibleEnd ?? endTime);
    recordClosedTrade(model, closePositionAtEnd(position, data, symbolEnd, costRate, useMinute), position.marketId);
  }
  model.open = [];
}

function modelReport(model, start, end) {
  const segments = {
    train: [start, Date.parse('2024-01-01T00:00:00Z')],
    validation: [Date.parse('2024-01-01T00:00:00Z'), Date.parse('2025-01-01T00:00:00Z')],
    oos: [Date.parse('2025-01-01T00:00:00Z'), end],
  };
  const walkForward = {
    '2025': {
      trainingWindow: [start, Date.parse('2025-01-01T00:00:00Z')],
      oos: signalCohortMetrics(model, Date.parse('2025-01-01T00:00:00Z'), Math.min(Date.parse('2026-01-01T00:00:00Z'), end), start, end),
    },
    '2026-H1': {
      trainingWindow: [start, Date.parse('2026-01-01T00:00:00Z')],
      oos: signalCohortMetrics(model, Date.parse('2026-01-01T00:00:00Z'), end, start, end),
    },
  };
  const full = signalCohortMetrics(model, start, end, start, end);
  return {
    model: model.name,
    modelVersion: model.v8 ? v8ShadowConfig.version : modelConfig.version,
    full,
    splits: Object.fromEntries(Object.entries(segments).map(([name, [from, to]]) => [name, signalCohortMetrics(model, from, to, start, end)])),
    walkForward,
    acceptedSignals: model.acceptedSignals,
    rejectionReasons: model.rejectionReasons,
    openAtEnd: model.open.length,
    observedAlphaCoverage: observedAlphaCoverage(model),
    rawCandidateEvents: model.rawCandidateEvents,
    signalEvents: model.signalEvents,
    acceptedSignalEvents: model.acceptedSignalEvents,
    rawCandidateCount: model.rawCandidateCount,
    rankedSignalCount: model.rankedSignalCount,
    acceptedSignalCount: model.acceptedSignalCount,
    rankedSignalArtifactPrefix: model.rankedEventPrefix ? path.relative(APP_DIR, model.rankedEventPrefix).replaceAll('\\', '/') : null,
    rankedSignalSymbols: [...(model.rankedSignalSymbols || [])].sort(),
    trades: model.trades,
  };
}

function markdownMetric(value, digits = 3) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

function markdownReport(report) {
  const rows = ['V7.5 Control', 'V8 Shadow'].map(name => {
    const item = report.models.find(model => model.model === name);
    const oos = item.splits.oos;
    return `| ${name} | ${oos.trades} | ${markdownMetric(oos.signalsPerMonth)} | ${markdownMetric(oos.winRate == null ? null : oos.winRate * 100, 1)}% | ${markdownMetric(oos.expectancyR)} | ${markdownMetric(oos.profitFactor)} | ${markdownMetric(drawdownPercent(oos.maxDrawdownPct), 1)}% | ${markdownMetric(oos.fundingPnlUsdt, 2)} | ${markdownMetric(oos.feesAndCostsUsdt, 2)} |`;
  }).join('\n');
  const walkForwardRows = report.models.flatMap(model => ['2025', '2026-H1'].map(fold => {
    const item = model.walkForward[fold].oos;
    return `| ${fold} | ${model.model} | ${item.trades} | ${markdownMetric(item.netExpectancyR)} | ${markdownMetric(item.profitFactor)} | ${markdownMetric(drawdownPercent(item.maxDrawdownPct), 1)}% |`;
  })).join('\n');
  const comparison = report.comparison;
  return `# TeleEdge ${report.data.scopeLabel}\n\n` +
    `本报告由 \`${report.data.command}\` 生成，数据快照时间为 ${report.data.snapshotEnd}。状态：**${report.data.status}**；仅用于研究，不构成盈利结论，也不改变 V7.5 paper 控制。\n\n` +
    `## OOS cohort（按 signal time）\n\n` +
    `| 模型 | Trades | Signals/月 | Win rate | Net expectancy (R) | Profit factor | Max drawdown | Funding PnL | Modeled costs |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    `V8 − V7.5 OOS expectancy: **${markdownMetric(comparison.netExpectancyRDelta)} R**；profit factor delta: **${markdownMetric(comparison.profitFactorDelta)}**；max drawdown delta: **${markdownMetric(comparison.maxDrawdownPctDelta * 100, 1)} pp**。\n\n` +
    `## Walk-forward folds\n\n| Fold | Model | Trades | Net expectancy (R) | Profit factor | Max drawdown |\n|---|---|---:|---:|---:|---:|\n${walkForwardRows}\n\n` +
    `## 设计与限制\n\n` +
    `- Scan cadence: ${report.methodology.scanCadence}；signal 后固定 20 分钟进入 decision，再取 decision_time 之后的可执行价格，禁止使用 signal close。\n` +
    `- Execution interval: ${report.data.executionInterval}；executionProxy=${report.data.executionProxy}。正式数据缺少 1m 时不静默回退，只有显式 smoke proxy 才使用 1h。\n` +
    `- ${report.methodology.settlement}；资金费使用历史事件，缺少 mark price 时回退到事件前最近 ${report.data.executionInterval === '1m' ? '1m' : '1h'} close。\n` +
    `- V7.5 使用冻结 0.6% 风险；V8 使用独立 research allocator（edge/liquidity/volatility/portfolio correlation/drawdown/loss streak）。\n` +
    `- 当前样本为 ${report.data.symbols.length} 个币种、${report.data.sampleSize.priceRows} 根 1h 价格记录和 ${report.data.sampleSize.fundingRows} 条资金费记录；这不是完整 V7.5 Control OOS。\n` +
    `- requiredAlphaCoverage: ${report.data.requiredAlphaCoverage.join(', ')}。observedAlphaCoverage（由实际 signals/trades 动态计算）：${report.data.observedAlphaCoverage.length ? report.data.observedAlphaCoverage.join(', ') : 'none'}。\n` +
    `- 固定五币种样本没有完成 expanded/non-core universe 和 point-in-time universe 验证；未观察到的 Alpha 不得称为已测试。\n` +
    `- 当前 exchangeInfo 快照无法证明没有历史退市 survivorship bias，结果不应外推到全市场。\n` +
    `- ${report.conclusion}\n\n` +
    `## Splits\n\n` +
    `训练集：2021-01-01—2023-12-31；验证集：2024；walk-forward OOS：2025 及 2026-H1。参数在本次运行中没有用 OOS 调优。\n`;
}

export async function runBacktest({symbols = DEFAULT_SYMBOLS, start = Date.parse('2021-01-01T00:00:00Z'), end = SNAPSHOT_END, scanIntervalHours = 4, outputBase = path.join(APP_DIR, 'reports', 'teleedge-oos-backtest'), mode = 'formal', executionProxy = false, allowExternalCache = false, lazyMinute = false, lazyPrice = false, recordEventsFrom = null, recordEventsUntil = null, eventStorage = 'all', dataRoot: requestedDataRoot = null} = {}) {
  const dataRoot = requestedDataRoot || (allowExternalCache ? WORKSPACE_DIR : path.join(APP_DIR, 'data', 'backtest'));
  const legacyLayout = allowExternalCache || fs.existsSync(path.join(dataRoot, 'v38_price_cache'));
  const priceDir = legacyLayout ? path.join(dataRoot, 'v38_price_cache') : path.join(dataRoot, 'price');
  const fundingDir = legacyLayout ? path.join(dataRoot, 'v38_funding_cache') : path.join(dataRoot, 'funding');
  const minuteDir = legacyLayout ? path.join(dataRoot, 'v60_full_universe_cache', 'minute') : path.join(dataRoot, 'minute');
  const exchange = exchangeMarkets(dataRoot, legacyLayout);
  const manifestFile = legacyLayout ? path.join(APP_DIR, 'data', 'backtest-manifest.json') : path.join(dataRoot, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const dataBySymbol = new Map();
  const missing = [];
  for (const symbol of symbols) {
    const h1 = loadRows(priceDir, symbol);
    const priceRows = h1.length;
    const funding = loadRows(fundingDir, symbol, true);
    const m1 = lazyMinute ? [] : loadRows(minuteDir, symbol);
    const market = marketFor(symbol, exchange);
    const lifecycle = activeWindowForMarket({symbol, market, manifest, startTime: start, endTime: end});
    if (!h1.length || !funding.length) missing.push({symbol, priceRows: h1.length, fundingRows: funding.length});
    const indicatorWarmupStart = Math.max(lifecycle.eligibleStart, start - 400 * DAY);
    const signalH1 = h1.filter(row => row.t >= indicatorWarmupStart && row.t < lifecycle.eligibleEnd);
    const firstPositiveRow = signalH1.find(row => row.q > 0) || null;
    const signalFunding = funding.filter(row => row.t >= indicatorWarmupStart && row.t < lifecycle.eligibleEnd);
    const daily = aggregate(signalH1.filter(row => row.t + H1 <= end), DAY, end);
    const bars4h = aggregate(signalH1.filter(row => row.t + H1 <= end), H4, end);
    const minuteArtifact = declaredMinuteArtifact(manifest, symbol);
    const data = {
      market,
      h1: lazyPrice ? [] : h1,
      priceLoaded: !lazyPrice,
      priceRows,
      m1,
      minuteLoaded: !lazyMinute,
      minuteArtifactRows: Number(minuteArtifact?.rows || 0),
      funding,
      signalH1: lazyPrice ? (firstPositiveRow ? [firstPositiveRow] : []) : signalH1,
      signalFunding,
      daily,
      bars4h,
      lifecycle,
      execution: {
        oneMinuteComplete: lazyMinute
          ? lifecycle.active && Number(minuteArtifact?.rows || 0) > 0
          : lifecycle.active && hasCompleteSeries(m1, '1m', lifecycle.eligibleStart, lifecycle.eligibleEnd),
        oneHourComplete: lifecycle.active && hasCompleteSeries(h1, '1h', lifecycle.eligibleStart, lifecycle.eligibleEnd),
      },
    };
    data.loadPrice = () => {
      if (data.priceLoaded) return data.h1;
      data.h1 = loadRows(priceDir, symbol);
      data.priceLoaded = true;
      return data.h1;
    };
    data.loadMinute = () => {
      if (data.minuteLoaded) return data.m1;
      data.m1 = loadRows(minuteDir, symbol);
      data.minuteLoaded = true;
      data.execution.oneMinuteComplete = lifecycle.active && hasCompleteSeries(data.m1, '1m', lifecycle.eligibleStart, lifecycle.eligibleEnd);
      return data.m1;
    };
    dataBySymbol.set(symbol, data);
  }
  const available = [...dataBySymbol].filter(([, data]) => data.lifecycle.active && data.priceRows > 0 && data.funding.length);
  if (!available.length) throw new Error(`No backtest data under ${dataRoot}. Run npm run backtest:fetch or explicitly use npm run backtest:smoke for the legacy external cache.`);
  const dailyByMarket = new Map([...dataBySymbol]
    .filter(([, data]) => data.lifecycle.active && data.priceRows > 0)
    .map(([symbol, data]) => [symbol, data.daily]));
  const breadthByTime = buildCoreBreadth(dailyByMarket);
  const btcEnvironment = buildBtcEnvironment(dailyByMarket.get('BTCUSDT') || []);
  const scanTimes = makeScanTimes(start, end, scanIntervalHours);
  const control = createModel('V7.5 Control');
  const shadow = createModel('V8 Shadow', true);
  const eventWindow = recordEventsFrom == null ? null : {start: recordEventsFrom, end: recordEventsUntil ?? end};
  control.recordEventWindow = eventWindow;
  shadow.recordEventWindow = eventWindow;
  if (eventStorage === 'ranked-file') {
    fs.mkdirSync(path.dirname(outputBase), {recursive: true});
    for (const model of [control, shadow]) {
      model.rankedEventPrefix = `${outputBase}.${model.v8 ? 'v8' : 'v75'}`;
      model.rankedEventFiles = new Map();
      model.rankedSignalSymbols = new Set();
      for (const symbol of symbols) {
        const file = `${model.rankedEventPrefix}.${symbol}.ranked.ndjson`;
        fs.writeFileSync(file, '');
        model.rankedEventFiles.set(symbol, fs.openSync(file, 'a'));
      }
    }
  }
  const symbolsWithOneMinute = available.filter(([, data]) => lazyMinute ? data.minuteArtifactRows > 0 : data.m1.length > 0).length;
  const symbolsWithCompleteOneMinute = available.filter(([, data]) => data.execution.oneMinuteComplete).length;
  const oneMinuteRows = available.reduce((sum, [, data]) => sum + (lazyMinute ? data.minuteArtifactRows : data.m1.length), 0);
  for (const scanTime of scanTimes) {
    const controlCandidates = [];
    const shadowCandidates = [];
    for (const [symbol, data] of available) {
      if (scanTime < data.lifecycle.eligibleStart || scanTime >= data.lifecycle.eligibleEnd) continue;
      const daily = completedSlice(data.daily, scanTime, DAY);
      const bars4h = completedSlice(data.bars4h, scanTime, 4 * H1);
      const args = {
        market: data.market,
        h1: completedSlice(data.signalH1, scanTime, H1),
        daily,
        bars4h,
        funding: beforeSlice(data.signalFunding, scanTime),
        breadthByTime,
        btcEnvironment,
        endTime: scanTime,
      };
      controlCandidates.push(...generateLatestCandidates(args).filter(candidate => candidate.t === scanTime));
      shadowCandidates.push(...generateV8ShadowCandidates(args).filter(candidate => candidate.t === scanTime));
    }
    const controlRanked = rankCandidates(controlCandidates);
    const shadowRanked = rankCandidates(shadowCandidates);
    const decisionTime = scanTime + DECISION_LATENCY_MS;
    advanceModelTo(control, dataBySymbol, decisionTime, {preferMinute: true});
    advanceModelTo(shadow, dataBySymbol, decisionTime, {preferMinute: true});
    processCandidates(control, controlCandidates, dataBySymbol, {
      executionProxy,
      endTime: end,
      rankedCandidates: controlRanked,
      eventWindow,
      eventStorage,
    });
    processCandidates(shadow, shadowCandidates, dataBySymbol, {
      executionProxy,
      endTime: end,
      rankedCandidates: shadowRanked,
      eventWindow,
      eventStorage,
    });
  }
  for (const model of [control, shadow]) {
    for (const file of model.rankedEventFiles?.values() || []) fs.closeSync(file);
    model.rankedEventFiles = null;
  }
  closeAtEnd(control, dataBySymbol, end, modelConfig.stressRoundTripCost, {preferMinute: true});
  closeAtEnd(shadow, dataBySymbol, end, modelConfig.stressRoundTripCost, {preferMinute: true});
  const models = [modelReport(control, start, end), modelReport(shadow, start, end)];
  const controlOos = models[0].splits.oos;
  const shadowOos = models[1].splits.oos;
  const observedAlphaCoverage = [...new Set(models.flatMap(model => model.observedAlphaCoverage))].sort();
  const executionIntervals = new Set(available.map(([, data]) => data.execution.oneMinuteComplete ? '1m' : '1h'));
  const executionInterval = executionIntervals.size === 1 && executionIntervals.has('1m')
    ? '1m'
    : executionProxy
      ? executionIntervals.size > 1 ? 'mixed-per-symbol-window' : '1h'
      : 'unavailable';
  const allMinuteComplete = available.length > 0 && symbolsWithCompleteOneMinute === available.length;
  const m4Reasons = [
    'point_in_time_universe_required',
    'historical_delisting_survivorship_handling_required',
    'expanded_non_core_universe_required',
    'sufficient_oos_sample_required',
    ...(symbolsWithCompleteOneMinute === available.length ? [] : ['one_minute_execution_data_incomplete']),
    ...(executionProxy ? ['execution_proxy_used'] : []),
    ...(Math.round(Number(scanIntervalHours)) === 4 ? [] : ['production_scan_cadence_is_4h']),
  ];
  const comparison = {
    netExpectancyRDelta: (shadowOos.netExpectancyR ?? 0) - (controlOos.netExpectancyR ?? 0),
    profitFactorDelta: (shadowOos.profitFactor ?? 0) - (controlOos.profitFactor ?? 0),
    maxDrawdownPctDelta: (shadowOos.maxDrawdownPct ?? 0) - (controlOos.maxDrawdownPct ?? 0),
    netPnlUsdtDelta: (shadowOos.netPnlUsdt ?? 0) - (controlOos.netPnlUsdt ?? 0),
  };
  const insufficient = models.some(model => model.splits.oos.trades < 30);
  const report = {
    generatedAt: new Date().toISOString(),
    data: {
      source: legacyLayout ? 'external workspace cache (smoke only)' : 'repository data/backtest artifacts',
      mode,
      scopeLabel: 'smoke backtest (M4 INCOMPLETE)',
      status: 'M4-INCOMPLETE',
      formalEligible: false,
      command: legacyLayout ? 'npm run backtest:smoke' : 'npm run backtest',
      dataRoot: path.relative(APP_DIR, dataRoot).replaceAll('\\', '/') || '.',
      manifest: path.relative(APP_DIR, manifestFile).replaceAll('\\', '/'),
      snapshotEnd: new Date(end).toISOString(),
      snapshotTimestamp: manifest?.snapshotTimestamp || new Date(end).toISOString(),
      exchangeInfo: legacyLayout ? 'external workspace/v60_full_universe_cache/exchangeInfo.json' : 'data/backtest/exchangeInfo.json',
      symbols,
      missing,
      fixedUniverse: symbols.length === DEFAULT_SYMBOLS.length && symbols.every(symbol => DEFAULT_SYMBOLS.includes(symbol)),
      pointInTimeUniverse: Boolean(manifest?.universe?.pointInTime),
      historicalDelistingsResolved: Boolean(manifest?.universe?.historicalDelistingsResolved),
      sampleSize: {
        priceRows: available.reduce((sum, [, data]) => sum + data.priceRows, 0),
        fundingRows: available.reduce((sum, [, data]) => sum + data.funding.length, 0),
         oneMinuteRows,
         symbolsWithBothFeeds: available.length,
         symbolsWithOneMinute,
       symbolsWithCompleteOneMinute,
       minuteLoadedLazily: lazyMinute,
       },
       executionCoverage: Object.fromEntries(available.map(([symbol, data]) => [symbol, {
         eligibleStart: new Date(data.lifecycle.eligibleStart).toISOString(),
         eligibleEnd: new Date(data.lifecycle.eligibleEnd).toISOString(),
         oneMinuteComplete: data.execution.oneMinuteComplete,
         oneHourComplete: data.execution.oneHourComplete,
         lifecycleDeclared: data.lifecycle.lifecycleDeclared,
       }])),
      requiredAlphaCoverage: REQUIRED_ALPHA_COVERAGE,
      observedAlphaCoverage,
      executionProxy,
      executionInterval,
      decisionLatencyMinutes: DECISION_LATENCY_MS / 60_000,
      m4Reasons,
      survivorshipWarning: 'Current snapshot exchangeInfo does not contain historical delistings; this is not a full-universe survivorship-free result.',
    },
    methodology: {
      scanCadence: `${scanIntervalHours}h UTC windows`,
      train: ['2021-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'],
      validation: ['2024-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'],
      walkForwardOos: ['2025-01-01T00:00:00.000Z', new Date(end).toISOString()],
      signalCohort: 'signalTime',
      executionLatency: 'decision_time = signal_time + 20 minutes; fill_time >= decision_time',
       fill: allMinuteComplete ? 'first 1m bar at or after decision time, open price within each symbol active window' : executionProxy ? 'explicit smoke-only 1h proxy at or after decision time, open price for symbols without complete 1m coverage' : 'unavailable without per-symbol 1m execution data',
      executionInterval,
      executionProxy,
       settlement: allMinuteComplete
         ? 'completed 1m bars; first touch by minute; SL priority when TP and SL occur in the same minute'
         : executionProxy
           ? 'per-symbol completed 1m bars where covered; explicit smoke-only completed 1h proxy for uncovered symbols; SL priority on the same bar'
           : 'unavailable without complete per-symbol 1m execution data',
      funding: 'historical funding rows; markPrice fallback to prior completed 1h close',
      costRate: modelConfig.stressRoundTripCost,
      lookaheadGuards: ['completed h1 slice', 'next-bar open fill', 'completed-bar-only settlement', 'no OOS parameter tuning'],
      requiredAlphaCoverage: REQUIRED_ALPHA_COVERAGE,
      observedAlphaCoverage,
    },
    models,
    comparison,
    conclusion: `M4 INCOMPLETE：${insufficient
      ? 'OOS 样本量不足（任一模型少于 30 笔），因此不报告统计显著的盈利或 V8 优越性结论。'
      : '即使固定样本达到最低门槛，仍缺少 expanded/non-core Alpha 的完整 point-in-time universe 和历史退市处理；不报告完整 V7.5 OOS 或 V8 优越性结论。'}`,
  };
  fs.mkdirSync(path.dirname(outputBase), {recursive: true});
  fs.writeFileSync(`${outputBase}.json`, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(`${outputBase}.md`, `${markdownReport(report)}\n`);
  return report;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/backtest.mjs')) {
  const symbols = (cliValue('--symbols', process.env.BACKTEST_SYMBOLS || DEFAULT_SYMBOLS.join(',')) || '')
    .split(',').map(item => item.trim().toUpperCase()).filter(Boolean);
  const start = dateValue(cliValue('--start', process.env.BACKTEST_START), Date.parse('2021-01-01T00:00:00Z'));
  const requestedEnd = dateValue(cliValue('--end', process.env.BACKTEST_END), SNAPSHOT_END);
  const end = Math.min(requestedEnd, SNAPSHOT_END);
  const scanIntervalHours = Number(cliValue('--scan-interval-hours', process.env.BACKTEST_SCAN_INTERVAL_HOURS || 4));
  const output = cliValue('--output', path.join(APP_DIR, 'reports', 'teleedge-oos-backtest'));
  const mode = cliValue('--mode', process.env.BACKTEST_MODE || 'formal');
  const allowExternalCache = process.argv.includes('--allow-external-cache');
  const executionProxy = process.argv.includes('--execution-proxy');
  if (executionProxy && mode !== 'smoke') throw new Error('--execution-proxy is allowed only with --mode smoke');
  const dataRoot = cliValue('--data-root', process.env.BACKTEST_DATA_ROOT || null);
  const report = await runBacktest({symbols, start, end, scanIntervalHours, outputBase: output, mode, executionProxy, allowExternalCache, dataRoot});
  for (const model of report.models) {
    const oos = model.splits.oos;
    console.log(`${model.model}: trades=${oos.trades} expectancyR=${oos.netExpectancyR ?? 'n/a'} PF=${oos.profitFactor ?? 'n/a'} MDD=${oos.maxDrawdownPct ?? 'n/a'}`);
  }
  console.log(`Reports: ${output}.json and ${output}.md`);
}
