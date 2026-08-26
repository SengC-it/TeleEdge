import {classifyTier, tierLabel} from './tiers.mjs';

function clamp(value, low = 0, high = 100) {
  return Math.max(low, Math.min(high, Number(value) || 0));
}

export const SCORING_CONFIG = Object.freeze({
  version: 'v81-score-1',
  edge: Object.freeze({returnWeight: 180, volumeWeight: 8, rangeWeight: 5, fundingWeight: 2}),
  confidence: Object.freeze({base: 45, adxWeight: 0.45, trend: 12, btcAlignment: 8, stopQuality: 8}),
});

export function scoreCandidate(candidate) {
  const features = candidate.features || {};
  const returnMagnitude = Math.abs(Number(features.return12) || 0);
  const volumeExcess = Math.max(0, (Number(features.volumeRatio) || 0) - 1);
  const rangeExcess = Math.max(0, (Number(features.rangeRatio) || 0) - 1);
  const edgeScore = clamp(45
    + returnMagnitude * SCORING_CONFIG.edge.returnWeight
    + volumeExcess * SCORING_CONFIG.edge.volumeWeight
    + rangeExcess * SCORING_CONFIG.edge.rangeWeight
    + Math.min(6, Math.abs(Number(features.fundingZ) || 0) * SCORING_CONFIG.edge.fundingWeight));
  const trendAligned = (candidate.side === 'long' && ['bull', 'sideways'].includes(features.regime))
    || (candidate.side === 'short' && ['bear', 'sideways'].includes(features.regime));
  const btcAligned = (candidate.side === 'long' && features.btcRegime !== 'bear')
    || (candidate.side === 'short' && features.btcRegime !== 'bull');
  const stopPct = Number(candidate.stopPct);
  const stopQuality = Number.isFinite(stopPct) && stopPct >= 0.025 && stopPct <= 0.09 ? 8 : 0;
  const confidenceScore = clamp(SCORING_CONFIG.confidence.base
    + Math.min(20, (Number(features.adx) || 0) * SCORING_CONFIG.confidence.adxWeight)
    + (trendAligned ? SCORING_CONFIG.confidence.trend : 0)
    + (btcAligned ? SCORING_CONFIG.confidence.btcAlignment : 0)
    + stopQuality);
  const compositeScore = clamp(0.55 * edgeScore + 0.45 * confidenceScore);
  const tier = classifyTier(compositeScore);
  return {
    ...candidate,
    edgeScore: compositeScore,
    confidenceScore,
    tier,
    tierLabel: tierLabel(tier),
    scoreVersion: SCORING_CONFIG.version,
  };
}
