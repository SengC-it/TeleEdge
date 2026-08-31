import {classifyTier, tierLabel} from '../v81/tiers.mjs';
import {V9_SCORECARD} from './registry.mjs';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, Number(value) || 0));

function directionAligned(candidate) {
  const long = candidate.side === 'long';
  const point = candidate.features || {};
  const trend = point.regime === (long ? 'bull' : 'bear') ? 1 : point.regime === 'sideways' ? 0.5 : 0;
  const btc = point.btcRegime === (long ? 'bull' : 'bear') ? 1 : point.btcRegime === 'sideways' ? 0.5 : 0;
  return {trend, btc};
}

function component(candidate) {
  const point = candidate.features || {};
  const flow = Math.min(1, Math.abs(Number(point.takerImbalance) || 0) / 0.5);
  const aggressiveVolume = Math.min(1, Math.max(0, Math.abs(Number(point.aggressiveVolumeZ) || 0)) / 3);
  const {trend, btc} = directionAligned(candidate);
  const crossValue = candidate.side === 'long' ? Number(point.crossSectionalReturnRank) : 1 - Number(point.crossSectionalReturnRank);
  const crossFlow = candidate.side === 'long' ? Number(point.crossSectionalFlowRank) : 1 - Number(point.crossSectionalFlowRank);
  const cross = Number.isFinite(crossValue) && Number.isFinite(crossFlow) ? (clamp(crossValue) + clamp(crossFlow)) / 2 : 0;
  const funding = Math.min(1, Math.abs(Number(point.fundingZ) || 0) / 3);
  const derivatives = [point.oiZ, point.premiumZ, point.markIndexSpread].map(Number).filter(Number.isFinite);
  const derivativeScore = derivatives.length ? Math.min(1, derivatives.reduce((sum, value) => sum + Math.abs(value), 0) / (derivatives.length * 3)) : 0;
  return {flow, aggressiveVolume, trend, cross, btc, funding, derivatives: derivativeScore};
}

export function scoreV9Candidate(candidate) {
  const parts = component(candidate);
  const weights = V9_SCORECARD.weights;
  const score = clamp(V9_SCORECARD.base
    + weights.flow * parts.flow
    + weights.aggressiveVolume * parts.aggressiveVolume
    + weights.trend * parts.trend
    + weights.crossSectional * parts.cross
    + weights.btcContext * parts.btc
    + weights.funding * parts.funding
    + weights.derivatives * parts.derivatives);
  const tier = classifyTier(score);
  return {
    ...candidate,
    edgeScore: score,
    originalEdgeScore: score,
    commonScore: score,
    alphaEvidenceScore: score,
    confidenceScore: score,
    calibratedScore: score,
    scoreVersion: V9_SCORECARD.version,
    scoreComponents: parts,
    tier,
    tierLabel: tierLabel(tier),
  };
}

export function compareV9Candidates(left, right) {
  return Number(right.edgeScore || 0) - Number(left.edgeScore || 0)
    || Number(right.eventScore || 0) - Number(left.eventScore || 0)
    || Number(right.dayVolume || 0) - Number(left.dayVolume || 0)
    || String(left.id || left.signalId || '').localeCompare(String(right.id || right.signalId || ''));
}
