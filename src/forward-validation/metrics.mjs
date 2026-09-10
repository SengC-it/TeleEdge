import {DAY, countIndependentSignals} from './contract.mjs';

function time(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : NaN;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function month(value) {
  const date = new Date(time(value));
  return Number.isFinite(date.getTime()) ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}` : 'unknown';
}

export function profitFactor(outcomes) {
  const wins = outcomes.filter(row => Number(row.netPnl ?? row.net_pnl) > 0).reduce((sum, row) => sum + Number(row.netPnl ?? row.net_pnl), 0);
  const losses = outcomes.filter(row => Number(row.netPnl ?? row.net_pnl) < 0).reduce((sum, row) => sum + Number(row.netPnl ?? row.net_pnl), 0);
  if (losses === 0) return wins > 0 ? 'Infinity' : null;
  return wins / Math.abs(losses);
}

export function maxDrawdown(outcomes, initialEquity = 10_000) {
  let equity = initialEquity;
  let peak = equity;
  let max = 0;
  for (const row of [...outcomes].sort((a, b) => time(a.closedAt ?? a.closed_at) - time(b.closedAt ?? b.closed_at))) {
    equity += Number(row.netPnl ?? row.net_pnl ?? 0);
    peak = Math.max(peak, equity);
    max = Math.max(max, peak - equity);
  }
  return {maxDrawdownUsdt: max, maxDrawdownPct: initialEquity > 0 ? max / initialEquity : null, endingEquity: equity};
}

export function calculateForwardMetrics(signals = [], outcomes = [], {initialEquity = 10_000} = {}) {
  const validSignals = signals.filter(row => row.origin === 'forward-validation' && row.dataQualityStatus !== 'INVALID_SIGNAL_DATA');
  const signalIds = new Set(validSignals.map(row => row.id));
  const closed = outcomes.filter(row => (row.status === 'closed' || row.closedAt || row.closed_at) && signalIds.has(row.signalId ?? row.signal_id));
  const open = outcomes.filter(row => !(row.status === 'closed' || row.closedAt || row.closed_at) && signalIds.has(row.signalId ?? row.signal_id));
  const netR = closed.map(row => Number(row.netR ?? row.net_r)).filter(Number.isFinite);
  const netPnlUsdt = closed.reduce((sum, row) => sum + Number(row.netPnl ?? row.net_pnl ?? 0), 0);
  const positiveMonths = new Set(closed.filter(row => Number(row.netPnl ?? row.net_pnl) > 0).map(row => month(row.closedAt ?? row.closed_at))).size;
  const monthlyPnl = {};
  const monthlySignalCounts = {};
  for (const row of validSignals) {
    const key = month(row.signalTime ?? row.signal_time);
    monthlySignalCounts[key] = (monthlySignalCounts[key] || 0) + 1;
  }
  for (const row of closed) {
    const key = month(row.closedAt ?? row.closed_at);
    monthlyPnl[key] = (monthlyPnl[key] || 0) + Number(row.netPnl ?? row.net_pnl ?? 0);
  }
  const drawdown = maxDrawdown(closed, initialEquity);
  return {
    signals: validSignals.length,
    independentSignals: countIndependentSignals(validSignals),
    closedTrades: closed.length,
    openTrades: open.length,
    wins: closed.filter(row => Number(row.netPnl ?? row.net_pnl) > 0).length,
    losses: closed.filter(row => Number(row.netPnl ?? row.net_pnl) < 0).length,
    winRate: closed.length ? closed.filter(row => Number(row.netPnl ?? row.net_pnl) > 0).length / closed.length : null,
    expectancyR: mean(netR),
    averageR: mean(netR),
    profitFactor: profitFactor(closed),
    netPnlUsdt,
    grossPnlUsdt: closed.reduce((sum, row) => sum + Number(row.grossPnl ?? row.gross_pnl ?? 0), 0),
    fundingPnlUsdt: closed.reduce((sum, row) => sum + Number(row.funding ?? row.fundingPnl ?? row.funding_pnl ?? 0), 0),
    feesAndCostsUsdt: closed.reduce((sum, row) => sum + Number(row.feesCost ?? row.fees_cost ?? row.cost ?? 0), 0),
    ...drawdown,
    positiveMonths,
    negativeMonths: Object.values(monthlyPnl).filter(value => value < 0).length,
    zeroMonths: Object.values(monthlyPnl).filter(value => value === 0).length,
    monthlyPnl,
    monthlySignalCounts,
    signalsPerMonth: Object.values(monthlySignalCounts).length ? validSignals.length / Object.values(monthlySignalCounts).length : 0,
    uniqueSymbols: new Set(validSignals.map(row => row.symbol)).size,
  };
}

export function aggregateForwardMetrics(signals = [], outcomes = [], options = {}) {
  const by = (predicate) => calculateForwardMetrics(signals.filter(predicate), outcomes, options);
  const v75 = by(row => row.strategy === 'V7.5');
  const v8 = by(row => row.strategy === 'V8');
  const unique = new Map();
  for (const signal of signals.filter(row => row.dataQualityStatus !== 'INVALID_SIGNAL_DATA')) {
    const key = signal.independentId || signal.overlapGroupId || signal.id;
    if (!unique.has(key)) unique.set(key, signal);
  }
  const canonicalBySignal = new Map([...unique.values()].map(signal => [signal.independentId || signal.overlapGroupId || signal.id, signal.id]));
  const combinedOutcomeBySignal = new Map();
  for (const outcome of outcomes) {
    const signal = signals.find(row => row.id === (outcome.signalId ?? outcome.signal_id));
    const canonicalId = signal ? canonicalBySignal.get(signal.independentId || signal.overlapGroupId || signal.id) : null;
    if (canonicalId && !combinedOutcomeBySignal.has(canonicalId)) combinedOutcomeBySignal.set(canonicalId, {...outcome, signalId: canonicalId});
  }
  const combinedOutcomes = [...combinedOutcomeBySignal.values()];
  const combined = calculateForwardMetrics([...unique.values()], combinedOutcomes, options);
  return {v75, v8, combined};
}

export function dailyIntegritySnapshot({date, run, signals = [], outcomes = [], dataErrors = 0, ledgerDuplicates = 0, emailHealth = 'unknown', workerHealth = 'unknown'} = {}) {
  const metrics = calculateForwardMetrics(signals, outcomes);
  return {
    date,
    runStatus: run?.status ?? null,
    strategyHashes: {v75: run?.v75StrategySha256 ?? null, v8: run?.v8StrategySha256 ?? null},
    signalsTotal: metrics.signals,
    closed: metrics.closedTrades,
    open: metrics.openTrades,
    dataErrors,
    ledgerDuplicates,
    emailHealth,
    workerHealth,
  };
}

export function finalForwardGate(metrics, {durationReady, signalReady, dataIntegrity = true, strategyHashesUnchanged = true} = {}) {
  if (!durationReady || !signalReady) return {status: 'INSUFFICIENT_FORWARD_SAMPLE', pass: false};
  if (!dataIntegrity || !strategyHashesUnchanged) return {status: 'FORWARD_STOP_CANDIDATE', pass: false};
  const pass = metrics.profitFactor !== null && metrics.profitFactor !== 'Infinity'
    ? metrics.profitFactor >= 1.35
    : metrics.profitFactor === 'Infinity'
      ? metrics.netPnlUsdt > 0
      : false;
  const gate = pass
    && Number(metrics.expectancyR) >= 0.15
    && Number(metrics.netPnlUsdt) > 0
    && Number(metrics.maxDrawdownPct) <= 0.06
    && Number(metrics.uniqueSymbols) >= 10;
  if (gate) return {status: 'FORWARD_GO', pass: true};
  if (Number(metrics.profitFactor) < 1 || Number(metrics.expectancyR) <= 0 || Number(metrics.netPnlUsdt) <= 0) {
    return {status: 'FORWARD_STOP_CANDIDATE', pass: false};
  }
  return {status: 'FORWARD_WATCH', pass: false};
}

export const FORWARD_METRIC_WINDOW_NOTE = `Only closed system-paper outcomes after ACTIVE startedAt are included; ${DAY}ms is one UTC day.`;
