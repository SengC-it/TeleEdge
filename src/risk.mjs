export const researchRiskConfig = Object.freeze({
  baseRiskFraction: 0.006,
  minRiskFraction: 0.002,
  maxRiskFraction: 0.009,
  portfolioRiskFraction: 0.06,
  maxCorrelatedRiskFraction: 0.03,
  drawdownThrottleStart: 0.05,
  drawdownStop: 0.12,
  lossStreakThrottleAt: 3,
  lossStreakStopAt: 20,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function positionRisk(position) {
  return Math.max(0, Number(position.riskUsdt ?? position.risk_usdt ?? 0));
}

function positionRegime(position) {
  return position.btcRouter ?? position.features?.btcRouter ?? position.features?.btc_router ?? 'unknown';
}

function currentLossStreak(closedPositions) {
  let streak = 0;
  for (const position of [...(closedPositions || [])].sort((a, b) => {
    const time = value => Number.isFinite(Number(value)) ? Number(value) : Date.parse(value || '') || 0;
    return time(a.exitTime ?? a.exit_time) - time(b.exitTime ?? b.exit_time);
  }).reverse()) {
    if (Number(position.netR ?? position.net_r) < 0) streak++;
    else break;
  }
  return streak;
}

/**
 * Research-only risk sizing. V7.5 keeps its frozen 0.6% control sizing;
 * this allocator is used by the V8 shadow/backtest namespace only.
 */
export function allocateResearchRisk({
  equityUsdt,
  peakEquityUsdt = equityUsdt,
  candidate,
  openPositions = [],
  closedPositions = [],
  config = researchRiskConfig,
}) {
  const equity = Number(equityUsdt);
  if (!(equity > 0)) return {accepted: false, reason: 'invalid-equity', riskUsdt: 0};

  const peak = Math.max(equity, Number(peakEquityUsdt) || equity);
  const drawdown = Math.max(0, 1 - equity / peak);
  if (drawdown >= config.drawdownStop) {
    return {accepted: false, reason: 'drawdown-stop', riskUsdt: 0, drawdown};
  }

  const stopPct = clamp(Math.abs(Number(candidate.stopPct) || 0.06), 0.02, 0.12);
  const edge = clamp(Number(candidate.edgeScore) || 0, 0, 1);
  const confidenceScale = 0.8 + 0.4 * edge;
  const liquidityScale = clamp(Math.sqrt(Math.max(1, Number(candidate.dayVolume) || 0) / 20_000_000), 0.75, 1.15);
  const volatilityScale = clamp(0.06 / stopPct, 0.5, 1.2);
  let riskFraction = config.baseRiskFraction * confidenceScale * liquidityScale * volatilityScale;
  if (drawdown > config.drawdownThrottleStart) {
    riskFraction *= clamp(
      (config.drawdownStop - drawdown) / (config.drawdownStop - config.drawdownThrottleStart),
      0,
      1,
    );
  }

  const lossStreak = currentLossStreak(closedPositions);
  if (lossStreak >= config.lossStreakStopAt) {
    return {accepted: false, reason: 'loss-streak-stop', riskUsdt: 0, drawdown, lossStreak};
  }
  if (lossStreak >= config.lossStreakThrottleAt) riskFraction *= 0.6;
  riskFraction = clamp(riskFraction, config.minRiskFraction, config.maxRiskFraction);

  const openRisk = openPositions.reduce((sum, position) => sum + positionRisk(position), 0);
  const portfolioRemaining = equity * config.portfolioRiskFraction - openRisk;
  const candidateRegime = candidate.btcRouter ?? candidate.features?.btcRouter ?? 'unknown';
  const correlatedRisk = openPositions
    .filter(position => position.side === candidate.side && positionRegime(position) === candidateRegime)
    .reduce((sum, position) => sum + positionRisk(position), 0);
  const correlatedRemaining = equity * config.maxCorrelatedRiskFraction - correlatedRisk;
  const riskUsdt = Math.min(equity * riskFraction, portfolioRemaining, correlatedRemaining);
  if (!(riskUsdt > 0)) {
    return {accepted: false, reason: portfolioRemaining <= 0 ? 'portfolio-risk-cap' : 'correlated-risk-cap', riskUsdt: 0, drawdown, lossStreak};
  }

  return {
    accepted: true,
    riskUsdt,
    riskFraction: riskUsdt / equity,
    drawdown,
    lossStreak,
    confidenceScale,
    liquidityScale,
    volatilityScale,
    correlatedRisk,
    portfolioRisk: openRisk,
  };
}
