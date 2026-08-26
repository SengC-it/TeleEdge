import {candidateFromPoint} from '../alpha-common.mjs';

export function detectRelativeStrength(point, market, alpha) {
  if (!Number.isFinite(Number(point.return12)) || !Number.isFinite(Number(point.btcReturn12))) return [];
  const relative = Number(point.relativeReturn12);
  const previousRelative = Number(point.previousRelativeReturn12);
  const threshold = alpha.riskConstraints.minRelativeReturn;
  const candidates = [];
  if (relative >= threshold && previousRelative < threshold && point.regime !== 'bear') {
    const candidate = candidateFromPoint(point, market, alpha, 'long');
    if (candidate) candidates.push(candidate);
  }
  if (relative <= -threshold && previousRelative > -threshold && point.regime !== 'bull') {
    const candidate = candidateFromPoint(point, market, alpha, 'short');
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}
