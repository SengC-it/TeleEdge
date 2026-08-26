import {classifyTier, tierLabel} from './tiers.mjs';

function clamp(value, low = 0, high = 100) {
  return Math.max(low, Math.min(high, Number(value) || 0));
}

export const SCORING_CONFIG = Object.freeze({
  version: 'v81-score-2',
  common: Object.freeze({base: 28, adxWeight: 0.45, trend: 15, btcAlignment: 8, volumeWeight: 4, rangeWeight: 3}),
  alphaEvidence: Object.freeze({
    trend_pullback_continuation: Object.freeze({base: 18, adxWeight: 0.45, pullback: 28, distance: 10}),
    volatility_expansion: Object.freeze({base: 12, volumeWeight: 12, rangeWeight: 12, breakout: 18}),
    failed_breakout_reversal: Object.freeze({base: 16, rejection: 32, rangeWeight: 6}),
    mean_reversion_extreme: Object.freeze({base: 10, rsi: 32, distance: 22}),
    funding_price_divergence: Object.freeze({base: 14, fundingWeight: 14, resilience: 18, volumeWeight: 5}),
    relative_strength_btc_rotation: Object.freeze({base: 12, relativeWeight: 18, localTrend: 28}),
    default: Object.freeze({base: 10, evidence: 12}),
  }),
  confidence: Object.freeze({base: 32, adxWeight: 0.35, trend: 10, btcAlignment: 7, stopQuality: 8}),
});

export function scoreCandidate(candidate) {
  const features = candidate.features || {};
  const alphaScore = SCORING_CONFIG.alphaEvidence[candidate.alpha] || SCORING_CONFIG.alphaEvidence.default;
  const volumeExcess = Math.max(0, (Number(features.volumeRatio) || 0) - 1);
  const rangeExcess = Math.max(0, (Number(features.rangeRatio) || 0) - 1);
  const trendAligned = (candidate.side === 'long' && ['bull', 'sideways'].includes(features.regime))
    || (candidate.side === 'short' && ['bear', 'sideways'].includes(features.regime));
  const btcAligned = (candidate.side === 'long' && features.btcRegime !== 'bear')
    || (candidate.side === 'short' && features.btcRegime !== 'bull');
  const localTrend = (candidate.side === 'long' && Number(features.close) > Number(features.ema50) && Number(features.ema50) > Number(features.previousEma50))
    || (candidate.side === 'short' && Number(features.close) < Number(features.ema50) && Number(features.ema50) < Number(features.previousEma50));
  const rsiEvidence = candidate.side === 'long' ? Math.max(0, 50 - Number(features.rsi || 50)) : Math.max(0, Number(features.rsi || 50) - 50);
  const relativeEvidence = Math.min(2, Math.abs(Number(features.relativeReturn12) || 0)) * 100;
  const resilience = candidate.side === 'long' ? Math.max(0, Number(features.return3) || 0) * 100 : Math.max(0, -(Number(features.return3) || 0)) * 100;
  const rejection = (features.failedBreakoutUp || features.failedBreakoutDown) ? 1 : 0;
  const pullback = (features.pullbackLong || features.pullbackShort) ? 1 : 0;
  const breakout = (features.breakoutUp || features.breakoutDown) ? 1 : 0;
  const commonScore = clamp(SCORING_CONFIG.common.base
    + Math.min(20, (Number(features.adx) || 0) * SCORING_CONFIG.common.adxWeight)
    + (trendAligned ? SCORING_CONFIG.common.trend : 0)
    + (btcAligned ? SCORING_CONFIG.common.btcAlignment : 0)
    + Math.min(10, volumeExcess * SCORING_CONFIG.common.volumeWeight)
    + Math.min(8, rangeExcess * SCORING_CONFIG.common.rangeWeight));
  const evidenceScore = clamp(alphaScore.base
    + Math.min(18, (Number(features.adx) || 0) * Number(alphaScore.adxWeight || 0))
    + (pullback ? Number(alphaScore.pullback || 0) : 0)
    + (breakout ? Number(alphaScore.breakout || 0) : 0)
    + (rejection ? Number(alphaScore.rejection || 0) : 0)
    + Math.min(20, volumeExcess * Number(alphaScore.volumeWeight || 0))
    + Math.min(20, rangeExcess * Number(alphaScore.rangeWeight || 0))
    + Math.min(22, rsiEvidence * Number(alphaScore.rsi || 0) / 32)
    + Math.min(20, Math.abs(Number(features.distanceEmaAtr) || 0) * Number(alphaScore.distance || 0) / 2)
    + Math.min(20, Math.abs(Number(features.fundingZ) || 0) * Number(alphaScore.fundingWeight || 0) / 2)
    + Math.min(20, resilience * Number(alphaScore.resilience || 0) / 10)
    + Math.min(24, relativeEvidence * Number(alphaScore.relativeWeight || 0) / 10)
    + (localTrend ? Number(alphaScore.localTrend || 0) : 0));
  const stopPct = Number(candidate.stopPct);
  const stopQuality = Number.isFinite(stopPct) && stopPct >= 0.025 && stopPct <= 0.09 ? 8 : 0;
  const confidenceScore = clamp(SCORING_CONFIG.confidence.base
    + Math.min(20, (Number(features.adx) || 0) * SCORING_CONFIG.confidence.adxWeight)
    + (trendAligned ? SCORING_CONFIG.confidence.trend : 0)
    + (btcAligned ? SCORING_CONFIG.confidence.btcAlignment : 0)
    + stopQuality);
  const compositeScore = clamp(0.55 * commonScore + 0.30 * evidenceScore + 0.15 * confidenceScore);
  const tier = classifyTier(compositeScore);
  return {
    ...candidate,
    edgeScore: compositeScore,
    commonScore,
    alphaEvidenceScore: evidenceScore,
    confidenceScore,
    tier,
    tierLabel: tierLabel(tier),
    scoreVersion: SCORING_CONFIG.version,
  };
}
