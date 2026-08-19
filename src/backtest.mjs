import {DAY, H1} from './config.mjs';

function numericTime(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  return Date.parse(value || '') || 0;
}

function sampleStd(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function monthKey(value) {
  const date = new Date(numericTime(value));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function yearKey(value) {
  return String(new Date(numericTime(value)).getUTCFullYear());
}

export function firstCompletedTouch(position, bars, now = Infinity) {
  const fillTime = numericTime(position.fillTime ?? position.fill_time);
  const firstEligibleBar = Number.isFinite(fillTime) ? Math.ceil(fillTime / H1) * H1 : -Infinity;
  for (const bar of bars || []) {
    const openTime = numericTime(bar.t);
    const closeTime = numericTime(bar.closeTime ?? bar.close_time ?? openTime + H1);
    if (!(closeTime < now) || openTime < firstEligibleBar) continue;
    const stopHit = position.side === 'long' ? Number(bar.l) <= Number(position.stop) : Number(bar.h) >= Number(position.stop);
    const targetHit = position.side === 'long' ? Number(bar.h) >= Number(position.target) : Number(bar.l) <= Number(position.target);
    if (stopHit) return {reason: 'sl', price: Number(position.stop), time: closeTime, ambiguous: targetHit};
    if (targetHit) return {reason: 'tp', price: Number(position.target), time: closeTime, ambiguous: false};
  }
  return null;
}

export function priceAtOrBefore(bars, timestamp, fallback = null) {
  let result = fallback;
  for (const bar of bars || []) {
    if (numericTime(bar.t) > timestamp) break;
    if (Number(bar.c) > 0) result = Number(bar.c);
  }
  return result;
}

export function accrueFunding(position, fundingRows, priceAt = () => null, until = Infinity) {
  const next = {...position};
  let fundingPnlUsdt = Number(next.fundingPnlUsdt ?? next.funding_pnl_usdt ?? 0);
  let lastFundingTime = numericTime(next.lastFundingTime ?? next.last_funding_time ?? next.fillTime ?? next.fill_time);
  let fallbackMarkPriceRows = 0;
  let fundingEvents = 0;
  for (const row of fundingRows || []) {
    const eventTime = numericTime(row.t ?? row.fundingTime ?? row.funding_time);
    if (!(eventTime > lastFundingTime) || !(eventTime < until)) continue;
    let markPrice = Number(row.markPrice ?? row.mark_price);
    if (!(markPrice > 0)) {
      markPrice = Number(priceAt(eventTime) ?? next.entry ?? next.fillPrice ?? next.fill_price);
      fallbackMarkPriceRows++;
    }
    const rate = Number(row.rate ?? row.fundingRate ?? row.funding_rate);
    if (!(markPrice > 0) || !Number.isFinite(rate)) continue;
    const cashflow = markPrice * Number(next.quantity) * rate;
    fundingPnlUsdt += next.side === 'long' ? -cashflow : cashflow;
    lastFundingTime = eventTime;
    fundingEvents++;
  }
  next.fundingPnlUsdt = fundingPnlUsdt;
  next.lastFundingTime = lastFundingTime;
  return {position: next, fundingEvents, fallbackMarkPriceRows};
}

export function settleOnCompletedBars(position, bars, fundingRows, {
  now = Infinity,
  costRate = 0.0015,
  priceAt = () => null,
} = {}) {
  const touch = firstCompletedTouch(position, bars, now);
  const cutoff = touch?.time ?? now;
  const accrued = accrueFunding(position, fundingRows, priceAt, cutoff);
  const next = accrued.position;
  if (!touch) return {closed: false, position: next, fundingEvents: accrued.fundingEvents, fallbackMarkPriceRows: accrued.fallbackMarkPriceRows};

  const direction = next.side === 'long' ? 1 : -1;
  const grossPnlUsdt = direction * (touch.price - Number(next.entry)) * Number(next.quantity);
  const modeledCostUsdt = costRate * Number(next.entry) * Number(next.quantity);
  const netPnlUsdt = grossPnlUsdt + next.fundingPnlUsdt - modeledCostUsdt;
  const settled = {
    ...next,
    status: 'closed',
    exitReason: touch.reason,
    exitPrice: touch.price,
    exitTime: touch.time,
    ambiguousSameMinute: touch.ambiguous,
    grossPnlUsdt,
    modeledCostUsdt,
    netPnlUsdt,
    netR: Number(next.riskUsdt) > 0 ? netPnlUsdt / Number(next.riskUsdt) : null,
  };
  return {closed: true, position: settled, trade: settled, fundingEvents: accrued.fundingEvents, fallbackMarkPriceRows: accrued.fallbackMarkPriceRows};
}

function calculateCoreMetrics(trades, {signals = 0, initialEquity = 10_000, periodStart = null, periodEnd = null, includeEquityPath = true} = {}) {
  const rows = [...(trades || [])].sort((a, b) => numericTime(a.exitTime ?? a.exit_time) - numericTime(b.exitTime ?? b.exit_time));
  const returns = rows.map(row => Number(row.netR ?? row.net_r)).filter(Number.isFinite);
  const wins = returns.filter(value => value > 0);
  const losses = returns.filter(value => value < 0);
  const netPnlUsdt = rows.reduce((sum, row) => sum + Number(row.netPnlUsdt ?? row.net_pnl_usdt ?? 0), 0);
  const grossPnlUsdt = rows.reduce((sum, row) => sum + Number(row.grossPnlUsdt ?? row.gross_pnl_usdt ?? 0), 0);
  const fundingPnlUsdt = rows.reduce((sum, row) => sum + Number(row.fundingPnlUsdt ?? row.funding_pnl_usdt ?? 0), 0);
  const modeledCostUsdt = rows.reduce((sum, row) => sum + Number(row.modeledCostUsdt ?? row.modeled_cost_usdt ?? 0), 0);
  const equityPath = [initialEquity];
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDrawdownUsdt = 0;
  for (const row of rows) {
    equity += Number(row.netPnlUsdt ?? row.net_pnl_usdt ?? 0);
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
    equityPath.push(equity);
  }
  const monthly = new Map();
  for (const row of rows) {
    const key = monthKey(row.exitTime ?? row.exit_time ?? row.signalTime ?? row.signal_time);
    monthly.set(key, (monthly.get(key) || 0) + Number(row.netPnlUsdt ?? row.net_pnl_usdt ?? 0) / initialEquity);
  }
  const monthlyReturns = [...monthly.values()];
  const monthlyMean = mean(monthlyReturns);
  const monthlyStd = sampleStd(monthlyReturns);
  const downside = monthlyReturns.filter(value => value < 0).map(value => value ** 2);
  const downsideDeviation = downside.length ? Math.sqrt(downside.reduce((sum, value) => sum + value, 0) / downside.length) : null;
  const expectancyR = mean(returns);
  const returnStd = sampleStd(returns);
  const expectancyMargin = returnStd == null ? null : 1.96 * returnStd / Math.sqrt(returns.length);
  const signalTimes = rows.map(row => numericTime(row.signalTime ?? row.signal_time)).filter(Boolean);
  const start = numericTime(periodStart) || Math.min(...signalTimes, Date.now());
  const end = numericTime(periodEnd) || Math.max(...signalTimes, start + DAY);
  const months = Math.max((end - start) / (DAY * 30.4375), 1 / 30.4375);
  const notional = rows.reduce((sum, row) => sum + Number(row.notionalUsdt ?? row.notional_usdt ?? 0), 0);
  const holdingHours = rows.map(row => (numericTime(row.exitTime ?? row.exit_time) - numericTime(row.fillTime ?? row.fill_time)) / 3_600_000).filter(Number.isFinite);
  const forcedExits = rows.filter(row => (row.exitReason ?? row.exit_reason) === 'end_of_sample').length;
  return {
    trades: rows.length,
    signals,
    signalsPerMonth: signals / months,
    winRate: rows.length ? wins.length / rows.length : null,
    wins: wins.length,
    losses: losses.length,
    avgWinR: mean(wins),
    avgLossR: mean(losses),
    expectancyR,
    netExpectancyR: expectancyR,
    expectancyR95CI: expectancyMargin == null || expectancyR == null ? null : [expectancyR - expectancyMargin, expectancyR + expectancyMargin],
    grossExpectancyR: rows.length ? grossPnlUsdt / rows.reduce((sum, row) => sum + Number(row.riskUsdt ?? row.risk_usdt ?? 0), 0) : null,
    profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : null,
    profitFactorStatus: losses.length ? 'defined' : wins.length ? 'no-losses' : 'no-trades',
    maxDrawdownUsdt,
    maxDrawdownPct: initialEquity ? maxDrawdownUsdt / initialEquity : null,
    endingEquity: equity,
    netPnlUsdt,
    grossPnlUsdt,
    fundingPnlUsdt,
    feesAndCostsUsdt: modeledCostUsdt,
    turnoverUsdt: notional * 2,
    averageHoldingHours: mean(holdingHours),
    forcedExits,
    sharpe: monthlyStd && monthlyMean != null ? monthlyMean / monthlyStd * Math.sqrt(12) : null,
    sortino: downsideDeviation && monthlyMean != null ? monthlyMean / downsideDeviation * Math.sqrt(12) : null,
    monthlyObservations: monthlyReturns.length,
    ...(includeEquityPath ? {equityPath} : {}),
    sampleStatus: rows.length >= 30 ? 'sample-available' : 'insufficient-sample',
    confidenceInterval: {method: 'normal-approximation-95%', parameter: 'net expectancy in R'},
  };
}

export function calculateMetrics(trades, options = {}) {
  const output = calculateCoreMetrics(trades, options);
  if (options.includeBreakdowns === false) return output;
  const fields = [
    ['bySide', row => row.side || 'unknown'],
    ['byRegime', row => row.btcRouter ?? row.features?.btcRouter ?? 'unknown'],
    ['byFamily', row => row.family || 'unknown'],
    ['byAlpha', row => row.alpha || 'control'],
    ['byYear', row => yearKey(row.signalTime ?? row.signal_time)],
  ];
  for (const [name, keyOf] of fields) {
    const groups = new Map();
    for (const row of trades || []) {
      const key = String(keyOf(row));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    output[name] = Object.fromEntries([...groups].map(([key, rows]) => [key, calculateCoreMetrics(rows, {...options, signals: rows.length, includeBreakdowns: false, includeEquityPath: false})]));
  }
  return output;
}

export function cohortMetrics(trades, signalEvents, start, end, options = {}) {
  const inWindow = row => {
    const time = numericTime(row.signalTime ?? row.signal_time);
    return time >= start && time < end;
  };
  return calculateMetrics((trades || []).filter(inWindow), {
    ...options,
    periodStart: start,
    periodEnd: end,
    signals: (signalEvents || []).filter(inWindow).length,
  });
}
