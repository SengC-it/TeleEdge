import {candidateFromPoint} from '../alpha-common.mjs';

export function detectTrendPullback(point, market, alpha) {
  if (!(Number(point.adx) >= alpha.riskConstraints.minAdx)) return [];
  const candidates = [];
  if (point.regime === 'bull' && point.pullbackLong && point.turnLong) {
    const candidate = candidateFromPoint(point, market, alpha, 'long');
    if (candidate) candidates.push(candidate);
  }
  if (point.regime === 'bear' && point.pullbackShort && point.turnShort) {
    const candidate = candidateFromPoint(point, market, alpha, 'short');
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}
