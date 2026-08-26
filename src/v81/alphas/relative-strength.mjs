import {candidateFromPoint} from '../alpha-common.mjs';

export function detectRelativeStrength(point, market, alpha) {
  if (!Number.isFinite(Number(point.return12)) || !Number.isFinite(Number(point.btcReturn12))) return [];
  const localBullTrend = Number(point.close) > Number(point.ema50)
    && Number(point.ema50) > Number(point.previousEma50);
  const localBearTrend = Number(point.close) < Number(point.ema50)
    && Number(point.ema50) < Number(point.previousEma50);
  if (!localBullTrend && !localBearTrend) return [];
  const relative = Number(point.relativeReturn12);
  const previousRelative = Number(point.previousRelativeReturn12);
  const threshold = alpha.riskConstraints.minRelativeReturn;
  const candidates = [];
  if (relative >= threshold && previousRelative < threshold && point.regime !== 'bear' && localBullTrend) {
    const candidate = candidateFromPoint(point, market, alpha, 'long');
    if (candidate) candidates.push(candidate);
  }
  if (relative <= -threshold && previousRelative > -threshold && point.regime !== 'bull' && localBearTrend) {
    const candidate = candidateFromPoint(point, market, alpha, 'short');
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}
