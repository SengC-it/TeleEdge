import {candidateFromPoint} from '../alpha-common.mjs';

export function detectMeanReversion(point, market, alpha) {
  if (point.regime !== 'sideways' || !(Number(point.adx) <= alpha.riskConstraints.maxAdx)) return [];
  const candidates = [];
  if (Number(point.rsi) <= 25 && Number(point.distanceEmaAtr) <= -2 && point.turnLong) {
    const candidate = candidateFromPoint(point, market, alpha, 'long');
    if (candidate) candidates.push(candidate);
  }
  if (Number(point.rsi) >= 75 && Number(point.distanceEmaAtr) >= 2 && point.turnShort) {
    const candidate = candidateFromPoint(point, market, alpha, 'short');
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}
