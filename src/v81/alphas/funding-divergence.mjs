import {candidateFromPoint} from '../alpha-common.mjs';

export function detectFundingDivergence(point, market, alpha) {
  if (!point.fundingValid) return [];
  const candidates = [];
  if (Number(point.fundingZ) <= -alpha.riskConstraints.minFundingZ && Number(point.previousFundingZ) > -alpha.riskConstraints.minFundingZ && Number(point.return3) >= -0.005 && point.turnLong) {
    const candidate = candidateFromPoint(point, market, alpha, 'long');
    if (candidate) candidates.push(candidate);
  }
  if (Number(point.fundingZ) >= alpha.riskConstraints.minFundingZ && Number(point.previousFundingZ) < alpha.riskConstraints.minFundingZ && Number(point.return3) <= 0.005 && point.turnShort) {
    const candidate = candidateFromPoint(point, market, alpha, 'short');
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}
