import {candidateFromPoint} from '../alpha-common.mjs';

export function detectVolatilityExpansion(point, market, alpha) {
  if (!(Number(point.rangeRatio) >= alpha.riskConstraints.minRangeRatio)
    || !(Number(point.volumeRatio) >= alpha.riskConstraints.minVolumeRatio)) return [];
  const candidates = [];
  if (point.breakoutUp && point.previousClose <= point.priorHigh20 && point.c > point.o) {
    const candidate = candidateFromPoint(point, market, alpha, 'long');
    if (candidate) candidates.push(candidate);
  }
  if (point.breakoutDown && point.previousClose >= point.priorLow20 && point.c < point.o) {
    const candidate = candidateFromPoint(point, market, alpha, 'short');
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}
