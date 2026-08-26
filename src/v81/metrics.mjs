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
    rawEvents: 0,
    independentResearchObservations: 0,
    research: 0,
    qualified: 0,
    highConfidence: 0,
    standaloneExecutable: 0,
    oofQualifiedCandidates: 0,
    oofQualifiedExecutable: 0,
    oofHighConfidenceCandidates: 0,
    oofHighConfidenceExecutable: 0,
    uniqueAlerts: 0,
    long: 0,
    short: 0,
    byAlpha: {},
    byRegime: {},
  }]));
}

export function recordMonthlyObservation(monthly, candidate, field = 'research') {
  const month = monthKey(candidate.t);
  if (!monthly[month]) return;
  if (field === 'rawEvents') {
    monthly[month].rawEvents++;
    return;
  }
  if (field === 'independentResearchObservations') {
    monthly[month].independentResearchObservations++;
    monthly[month].research++;
    monthly[month][candidate.side]++;
    const alpha = candidate.alpha || 'unknown';
    const regime = candidate.regime || candidate.features?.regime || 'unknown';
    monthly[month].byAlpha[alpha] = (monthly[month].byAlpha[alpha] || 0) + 1;
    monthly[month].byRegime[regime] = (monthly[month].byRegime[regime] || 0) + 1;
    return;
  }
  monthly[month][field]++;
  if (field === 'research' || field === 'independentResearchObservations') {
    monthly[month][candidate.side]++;
    const alpha = candidate.alpha || 'unknown';
    const regime = candidate.regime || candidate.features?.regime || 'unknown';
    monthly[month].byAlpha[alpha] = (monthly[month].byAlpha[alpha] || 0) + 1;
    monthly[month].byRegime[regime] = (monthly[month].byRegime[regime] || 0) + 1;
  }
}

export function frequencySummary(monthly) {
  const rows = Object.values(monthly || {});
  const field = (name, fallbackName = null) => {
    const values = rows.map(row => Number(row[name]) || (fallbackName ? Number(row[fallbackName]) || 0 : 0));
    return {
      mean: mean(values) ?? 0,
      median: median(values) ?? 0,
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
      zeroMonths: values.filter(value => value === 0).length,
    };
  };
  const independent = field('independentResearchObservations', 'research');
  const raw = field('rawEvents');
  const counts = rows.map(row => Number(row.independentResearchObservations ?? row.research) || 0);
  const total = counts.reduce((sum, value) => sum + value, 0);
  const sorted = [...counts].sort((a, b) => b - a);
  return {
    months: monthly,
    rawEvents: raw,
    independentResearchObservations: independent,
    research: independent,
    qualified: field('qualified'),
    highConfidence: field('highConfidence'),
    standaloneExecutable: field('standaloneExecutable'),
    oofQualifiedCandidates: field('oofQualifiedCandidates'),
    oofQualifiedExecutable: field('oofQualifiedExecutable'),
    oofHighConfidenceCandidates: field('oofHighConfidenceCandidates'),
    oofHighConfidenceExecutable: field('oofHighConfidenceExecutable'),
    uniqueAlerts: field('uniqueAlerts'),
    monthlyConcentration: total > 0
      ? {topMonthShare: (sorted[0] || 0) / total, top3MonthShare: sorted.slice(0, 3).reduce((sum, value) => sum + value, 0) / total}
      : {topMonthShare: 0, top3MonthShare: 0},
  };
}

function emptyMetrics() {
  return {
    trades: 0, wins: 0, losses: 0, winRate: null, grossPnlUsdt: 0, fundingPnlUsdt: 0,
    feesAndCostsUsdt: 0, netPnlUsdt: 0, netReturn: 0, profitFactor: null, expectancyR: null,
    expectancyR95CI: null, maxDrawdownUsdt: 0, maxDrawdownPct: 0, mfe: null, mae: null,
    positiveMonths: 0, negativeMonths: 0, zeroMonths: 0, uniqueSymbols: 0, alphaBreadth: 0,
    regimeBreadth: 0, topSymbolConcentration: null, topTradeConcentration: null,
  };
}

function positiveContribution(groups) {
  const positive = groups.map(group => Math.max(0, group.reduce((sum, row) => sum + (Number(row.netPnlUsdt) || 0), 0)));
  const total = positive.reduce((sum, value) => sum + value, 0);
  return total > 0 ? Math.max(...positive) / total : null;
}

export function calculateResearchMetrics(trades, observations = [], {initialEquity = 10_000, start, end} = {}) {
  const observationCount = Array.isArray(observations)
    ? observations.length
    : Number(observations?.independentResearchObservations ?? observations?.total ?? 0);
  const rows = [...(trades || [])]
    .filter(row => start == null || end == null || (Number(row.exitTime || row.signalTime) >= start && Number(row.exitTime || row.signalTime) < end))
    .sort((a, b) => Number(a.exitTime || 0) - Number(b.exitTime || 0));
  const periodMonths = start != null && end != null ? monthList(start, end) : [];
  if (!rows.length) return {...emptyMetrics(), observations: observationCount, period: {start, end}, monthlyPnl: Object.fromEntries(periodMonths.map(month => [month, 0]))};
  const returns = rows.map(row => finite(row.netR)).filter(value => value != null);
  const wins = rows.map(row => Number(row.netPnlUsdt) || 0).filter(value => value > 0);
  const losses = rows.map(row => Number(row.netPnlUsdt) || 0).filter(value => value < 0);
  const grossPnlUsdt = rows.reduce((sum, row) => sum + (Number(row.grossPnlUsdt) || 0), 0);
  const fundingPnlUsdt = rows.reduce((sum, row) => sum + (Number(row.fundingPnlUsdt) || 0), 0);
  const feesAndCostsUsdt = rows.reduce((sum, row) => sum + (Number(row.modeledCostUsdt) || 0), 0);
  const netPnlUsdt = rows.reduce((sum, row) => sum + (Number(row.netPnlUsdt) || 0), 0);
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDrawdownUsdt = 0;
  let maxDrawdownPct = 0;
  for (const row of rows) {
    equity += Number(row.netPnlUsdt) || 0;
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak : 0);
  }
  const monthlyPnl = Object.fromEntries(periodMonths.map(month => [month, 0]));
  for (const row of rows) {
    const key = monthKey(row.exitTime || row.signalTime);
    if (Object.prototype.hasOwnProperty.call(monthlyPnl, key)) monthlyPnl[key] += Number(row.netPnlUsdt) || 0;
  }
  const monthlyValues = Object.values(monthlyPnl);
  const bySymbol = groupRows(rows, row => row.marketId || row.symbol);
  const byAlpha = groupRows(rows, row => row.alpha || 'unknown');
  const byRegime = groupRows(rows, row => row.regime || row.btcRouter || row.features?.regime || 'unknown');
  const average = mean(returns);
  const standardError = sampleStd(returns);
  const margin = standardError == null ? null : 1.96 * standardError / Math.sqrt(returns.length);
  return {
    trades: rows.length, wins: wins.length, losses: losses.length, winRate: wins.length / rows.length,
    grossPnlUsdt, fundingPnlUsdt, feesAndCostsUsdt, netPnlUsdt, netReturn: netPnlUsdt / initialEquity,
    profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : null,
    expectancyR: average, expectancyR95CI: margin == null || average == null ? null : [average - margin, average + margin],
    maxDrawdownUsdt, maxDrawdownPct, mfe: mean(rows.map(row => row.mfe)), mae: mean(rows.map(row => row.mae)),
    positiveMonths: monthlyValues.filter(value => value > 0).length,
    negativeMonths: monthlyValues.filter(value => value < 0).length,
    zeroMonths: monthlyValues.filter(value => value === 0).length,
    uniqueSymbols: bySymbol.size, alphaBreadth: byAlpha.size, regimeBreadth: byRegime.size,
    topSymbolConcentration: positiveContribution([...bySymbol.values()]),
    topTradeConcentration: positiveContribution(rows.map(row => [row])),
    period: {start, end}, observations: observationCount, endingEquity: equity, monthlyPnl,
  };
}

export function breakdownMetrics(trades, keyOf, options = {}) {
  return Object.fromEntries([...groupRows(trades, keyOf)].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, calculateResearchMetrics(rows, [], options)]));
}

export function validateTierMonotonicity(byTier, {minimumSamples = 10} = {}) {
  const a = byTier?.A;
  const b = byTier?.B;
  const c = byTier?.C;
  const sampleByTier = {A: Number(a?.trades) || 0, B: Number(b?.trades) || 0, C: Number(c?.trades) || 0};
  if (!a || !b || !c || Object.values(sampleByTier).some(sample => sample < minimumSamples)) {
    return {valid: false, sufficientSample: false, reason: 'INSUFFICIENT', sampleByTier};
  }
  const expectancyMonotonic = Number(a.expectancyR) >= Number(b.expectancyR)
    && Number(b.expectancyR) >= Number(c.expectancyR);
  const profitFactorMonotonic = (a.profitFactor == null || b.profitFactor == null || Number(a.profitFactor) >= Number(b.profitFactor))
    && (b.profitFactor == null || c.profitFactor == null || Number(b.profitFactor) >= Number(c.profitFactor));
  const valid = expectancyMonotonic && profitFactorMonotonic;
  return {valid, sufficientSample: true, reason: valid ? 'monotonic' : 'tier-order-inversion', sampleByTier};
}

export function classifyAlphaAttribution(metrics) {
  const enough = metrics.trades >= 30 && metrics.uniqueSymbols >= 10;
  const positive = Number(metrics.netPnlUsdt) > 0 && Number(metrics.expectancyR) >= 0.15 && Number(metrics.profitFactor) >= 1.3;
  const confidence = Array.isArray(metrics.expectancyR95CI) && Number(metrics.expectancyR95CI[0]) > 0;
  if (enough && positive && confidence && Number(metrics.maxDrawdownPct) <= 0.2) return 'KEEP';
  if (!enough || (positive && !confidence)) return 'WATCH';
  return 'REJECT';
}

export function alphaAttribution(registryIds, observations, trades, options = {}) {
  return Object.fromEntries(registryIds.map(alpha => {
    const observed = Array.isArray(observations) ? observations.filter(row => row.alpha === alpha) : [];
    const observedCount = Array.isArray(observations) ? observed.length : Number(observations?.byAlpha?.[alpha]?.observations || 0);
    const qualifiedCandidates = Array.isArray(observations)
      ? observed.filter(row => row.tier === 'A' || row.tier === 'B')
      : [];
    const highConfidenceCandidates = Array.isArray(observations)
      ? observed.filter(row => row.tier === 'A')
      : [];
    const tierByObservationId = new Map(observed.map(row => [String(row.id ?? row.observationId), row.tier]));
    const primaryTrades = (trades || [])
      .filter(row => row.alpha === alpha)
      .map(row => row.tier ? row : {...row, tier: tierByObservationId.get(String(row.observationId ?? row.id)) || 'C'});
    const qualifiedTrades = primaryTrades.filter(row => row.tier === 'A' || row.tier === 'B');
    const highConfidenceTrades = primaryTrades.filter(row => row.tier === 'A');
    const allOofExecutable = attributionLayer(primaryTrades, observed, options);
    const qualifiedOofExecutable = attributionLayer(qualifiedTrades, qualifiedCandidates, options);
    const highConfidenceOofExecutable = attributionLayer(highConfidenceTrades, highConfidenceCandidates, options);
    const allStatus = classifyAlphaAttribution(allOofExecutable.metrics);
    const qualifiedStatus = classifyAlphaAttribution(qualifiedOofExecutable.metrics);
    const scoringEfficacy = {
      allOofExecutable: {sample: allOofExecutable.sample, expectancyR: allOofExecutable.expectancyR, profitFactor: allOofExecutable.profitFactor},
      qualifiedOofExecutable: {sample: qualifiedOofExecutable.sample, expectancyR: qualifiedOofExecutable.expectancyR, profitFactor: qualifiedOofExecutable.profitFactor},
      deltaExpectancyR: difference(qualifiedOofExecutable.expectancyR, allOofExecutable.expectancyR),
      deltaProfitFactor: difference(qualifiedOofExecutable.profitFactor, allOofExecutable.profitFactor),
      qualifiedImproves: improves(qualifiedOofExecutable, allOofExecutable),
    };
    return [alpha, {
      alpha,
      observations: observedCount,
      qualified: qualifiedCandidates.length,
      highConfidence: highConfidenceCandidates.length,
      trades: allOofExecutable.sample,
      executableCounts: {
        allOofExecutable: allOofExecutable.sample,
        qualifiedOofExecutable: qualifiedOofExecutable.sample,
        highConfidenceOofExecutable: highConfidenceOofExecutable.sample,
      },
      candidateCounts: {
        allOofCandidates: observed.length,
        oofQualifiedCandidates: qualifiedCandidates.length,
        oofHighConfidenceCandidates: highConfidenceCandidates.length,
      },
      allOofExecutable,
      qualifiedOofExecutable,
      highConfidenceOofExecutable,
      scoringEfficacy,
      allStatus,
      qualifiedStatus,
      status: qualifiedStatus,
      metrics: allOofExecutable.metrics,
      ...allOofExecutable.metrics,
    }];
  }));
}

function difference(left, right) {
  return left == null || right == null || !Number.isFinite(Number(left)) || !Number.isFinite(Number(right))
    ? null
    : Number(left) - Number(right);
}

function improves(qualified, all) {
  return qualified.expectancyR != null && qualified.profitFactor != null
    && all.expectancyR != null && all.profitFactor != null
    && Number(qualified.expectancyR) > Number(all.expectancyR)
    && Number(qualified.profitFactor) > Number(all.profitFactor);
}

function attributionLayer(trades, observations, options) {
  const metrics = calculateResearchMetrics(trades, observations, options);
  const bySide = breakdownMetrics(trades, row => row.side || 'unknown', options);
  const byRegime = breakdownMetrics(trades, row => row.regime || row.btcRouter || row.features?.regime || 'unknown', options);
  const empty = () => calculateResearchMetrics([], [], options);
  return {
    sample: metrics.trades,
    uniqueSymbols: metrics.uniqueSymbols,
    wins: metrics.wins,
    losses: metrics.losses,
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor,
    expectancyR: metrics.expectancyR,
    expectancyR95CI: metrics.expectancyR95CI,
    netPnlUsdt: metrics.netPnlUsdt,
    maxDrawdownUsdt: metrics.maxDrawdownUsdt,
    maxDrawdownPct: metrics.maxDrawdownPct,
    long: bySide.long || empty(),
    short: bySide.short || empty(),
    bySide,
    byRegime,
    metrics,
  };
}
