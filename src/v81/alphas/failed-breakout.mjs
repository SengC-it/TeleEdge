import {candidateFromPoint} from '../alpha-common.mjs';

export function detectFailedBreakout(point, market, alpha) {
  const candidates = [];
  if (point.failedBreakoutDown && point.turnLong) {
    const candidate = candidateFromPoint(point, market, alpha, 'long');
    if (candidate) candidates.push(candidate);
  }
  if (point.failedBreakoutUp && point.turnShort) {
    const candidate = candidateFromPoint(point, market, alpha, 'short');
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}
