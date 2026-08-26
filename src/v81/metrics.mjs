function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function mean(values) {
  const rows = values.map(Number).filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function median(values) {
  const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function sampleStd(values) {
  const rows = values.map(Number).filter(Number.isFinite);
  if (rows.length < 2) return null;
  const average = mean(rows);
  return Math.sqrt(rows.reduce((sum, value) => sum + (value - average) ** 2, 0) / (rows.length - 1));
}

function monthKey(value) {
  const date = new Date(Number(value));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthList(start, end) {
  const rows = [];
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  while (cursor.getTime() < end) {
    rows.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return rows;
}

function groupRows(rows, keyOf) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = String(keyOf(row));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

export function createMonthlyFrequency(start, end) {
  return Object.fromEntries(monthList(start, end).map(month => [month, {
    research: 0, qualified: 0, highConfidence: 0, uniqueAlerts: 0, long: 0, short: 0,
    byAlpha: {}, byRegime: {},
  }]));
}

export function recordMonthlyObservation(monthly, candidate, field = 'research') {
  const month = monthKey(candidate.t);
  if (!monthly[month]) return;
  monthly[month][field]++;
  if (field === 'research') {
    monthly[month][candidate.side]++;
    const alpha = candidate.alpha || 'unknown';
    const regime = candidate.regime || candidate.features?.regime || 'unknown';
    monthly[month].byAlpha[alpha] = (monthly[month].byAlpha[alpha] || 0) + 1;
    monthly[month].byRegime[regime] = (monthly[month].byRegime[regime] || 0) + 1;
  }
}

export function frequencySummary(monthly) {
  const rows = Object.values(monthly || {});
  const field = name => {
    const values = rows.map(row => Number(row[name]) || 0);
    return {mean: mean(values) ?? 0, median: median(values) ?? 0, min: values.length ? Math.min(...values) : 0, max: values.length ? Math.max(...values) : 0, zeroMonths: values.filter(value => value === 0).length};
  };
  const counts = rows.map(row => Number(row.research) || 0);
  const total = counts.reduce((sum, value) => sum + value, 0);
  const sorted = [...counts].sort((a, b) => b - a);
  return {
    months: monthly,
    research: field('research'),
    qualified: field('qualified'),
    highConfidence: field('highConfidence'),
    uniqueAlerts: field('uniqueAlerts'),
    monthlyConcentration: total > 0 ? {topMonthShare: (sorted[0] || 0) / total, top3MonthShare: sorted.slice(0, 3).reduce((sum, value) => sum + value, 0) / total} : {topMonthShare: 0, top3MonthShare: 0},
  };
}

function emptyMetrics() {
  return {
    trades: 0, wins: 0, losses: 0, winRate: null, grossPnlUsdt: 0, fundingPnlUsdt: 0,
    feesAndCostsUsdt: 0, netPnlUsdt: 0, netReturn: 0, profitFactor: null, expectancyR: null,
    expectancyR95CI: null, maxDrawdownUsdt: 0, maxDrawdownPct: 0, mfe: null, mae: null,
    positiveMonths: 0, negativeMonths: 0, uniqueSymbols: 0, alphaBreadth: 0, regimeBreadth: 0,
    topSymbolConcentration: null, topTradeConcentration: null,
  };
}

export function calculateResearchMetrics(trades, observations = [], {initialEquity = 10_000, start, end} = {}) {
  const observationCount = Array.isArray(observations) ? observations.length : Number(observations?.total || 0);
  const rows = [...(trades || [])].sort((a, b) => Number(a.exitTime || 0) - Number(b.exitTime || 0));
  if (!rows.length) return {...emptyMetrics(), observations: observationCount};
  const returns = rows.map(row => finite(row.netR)).filter(value => value != null);
  const wins = returns.filter(value => value > 0);
  const losses = returns.filter(value => value < 0);
  const grossPnlUsdt = rows.reduce((sum, row) => sum + (Number(row.grossPnlUsdt) || 0), 0);
  const fundingPnlUsdt = rows.reduce((sum, row) => sum + (Number(row.fundingPnlUsdt) || 0), 0);
  const feesAndCostsUsdt = rows.reduce((sum, row) => sum + (Number(row.modeledCostUsdt) || 0), 0);
  const netPnlUsdt = rows.reduce((sum, row) => sum + (Number(row.netPnlUsdt) || 0), 0);
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDrawdownUsdt = 0;
  for (const row of rows) {
    equity += Number(row.netPnlUsdt) || 0;
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
  }
  const monthly = new Map();
  for (const row of rows) {
    const key = monthKey(row.exitTime || row.signalTime);
    monthly.set(key, (monthly.get(key) || 0) + (Number(row.netPnlUsdt) || 0));
  }
  const monthlyPnl = [...monthly.values()];
  const bySymbol = groupRows(rows, row => row.marketId || row.symbol);
  const byAlpha = groupRows(rows, row => row.alpha || 'unknown');
  const byRegime = groupRows(rows, row => row.regime || 'unknown');
  const symbolPnl = [...bySymbol.values()].map(group => Math.abs(group.reduce((sum, row) => sum + (Number(row.netPnlUsdt) || 0), 0)));
  const tradePnl = rows.map(row => Math.abs(Number(row.netPnlUsdt) || 0));
  const average = mean(returns);
  const standardError = sampleStd(returns);
  const margin = standardError == null ? null : 1.96 * standardError / Math.sqrt(returns.length);
  return {
    trades: rows.length, wins: wins.length, losses: losses.length, winRate: wins.length / rows.length,
    grossPnlUsdt, fundingPnlUsdt, feesAndCostsUsdt, netPnlUsdt, netReturn: netPnlUsdt / initialEquity,
    profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : null,
    expectancyR: average, expectancyR95CI: margin == null ? null : [average - margin, average + margin],
    maxDrawdownUsdt, maxDrawdownPct: maxDrawdownUsdt / initialEquity, mfe: mean(rows.map(row => row.mfe)),
    mae: mean(rows.map(row => row.mae)), positiveMonths: monthlyPnl.filter(value => value > 0).length,
    negativeMonths: monthlyPnl.filter(value => value < 0).length, uniqueSymbols: bySymbol.size,
    alphaBreadth: byAlpha.size, regimeBreadth: byRegime.size,
    topSymbolConcentration: netPnlUsdt ? Math.max(...symbolPnl, 0) / Math.abs(netPnlUsdt) : 0,
    topTradeConcentration: netPnlUsdt ? Math.max(...tradePnl, 0) / Math.abs(netPnlUsdt) : 0,
    period: {start, end}, observations: observationCount, endingEquity: equity,
  };
}

export function breakdownMetrics(trades, keyOf, options = {}) {
  return Object.fromEntries([...groupRows(trades, keyOf)].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, calculateResearchMetrics(rows, [], options)]));
}

export function alphaAttribution(registryIds, observations, trades, options = {}) {
  return Object.fromEntries(registryIds.map(alpha => {
    const observed = Array.isArray(observations) ? observations.filter(row => row.alpha === alpha) : [];
    const observedCount = Array.isArray(observations) ? observed.length : Number(observations?.byAlpha?.[alpha]?.observations || 0);
    const qualifiedCount = Array.isArray(observations)
      ? observed.filter(row => row.tier === 'A' || row.tier === 'B').length
      : Number(observations?.byAlpha?.[alpha]?.qualified || 0);
    const primaryTrades = (trades || []).filter(row => row.alpha === alpha);
    const metrics = calculateResearchMetrics(primaryTrades, [], options);
    metrics.observations = observedCount;
    const status = metrics.trades < 3 ? 'WATCH' : metrics.expectancyR > 0 && (metrics.profitFactor == null || metrics.profitFactor >= 1.2) ? 'KEEP' : metrics.expectancyR < 0 || metrics.profitFactor < 1 ? 'REJECT' : 'WATCH';
    return [alpha, {observations: observedCount, qualified: qualifiedCount, trades: primaryTrades.length, ...metrics, status}];
  }));
}
