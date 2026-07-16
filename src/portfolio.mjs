import {modelConfig} from './config.mjs';
import {marketRules, roundDown, roundToTick} from './market-data.mjs';

export function rankCandidates(input) {
  const groups = new Map();
  for (const candidate of input) {
    const key = `${candidate.t}|${candidate.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  return [...groups.values()].flatMap(group => {
    const bestTargetBySignal = new Map();
    for (const candidate of group) {
      const previous = bestTargetBySignal.get(candidate.id);
      if (!previous || candidate.edgeScore > previous.edgeScore) bestTargetBySignal.set(candidate.id, candidate);
    }
    return [...bestTargetBySignal.values()].sort((a, b) => b.edgeScore - a.edgeScore
      || b.eventScore - a.eventScore || b.dayVolume - a.dayVolume).slice(0, modelConfig.sameTimePerSide);
  }).sort((a, b) => a.t - b.t || b.edgeScore - a.edgeScore || b.eventScore - a.eventScore);
}

function positionFromCandidate(candidate, state, market) {
  const rules = marketRules(market);
  const entry = roundToTick(candidate.entry, rules.tickSize);
  const stop = roundToTick(candidate.sl, rules.tickSize);
  const target = roundToTick(candidate.target, rules.tickSize);
  const plannedRiskUsdt = state.equityUsdt * modelConfig.riskFraction;
  const quantity = roundDown(plannedRiskUsdt / Math.abs(entry - stop), rules.stepSize);
  if (!(quantity > 0) || quantity < rules.minQty) return null;
  const riskUsdt = quantity * Math.abs(entry - stop);
  return {
    id: candidate.id,
    modelVersion: modelConfig.version,
    status: 'open',
    mode: 'paper',
    marketId: candidate.marketId,
    symbol: candidate.symbol,
    side: candidate.side,
    family: candidate.family,
    route: candidate.route,
    edgeSegment: candidate.edgeSegment,
    edgeScore: candidate.edgeScore,
    signalTime: candidate.t,
    openedAt: Date.now(),
    entry,
    stop,
    target,
    targetR: candidate.targetR,
    stopPct: Math.abs(entry - stop) / entry,
    quantity,
    notionalUsdt: entry * quantity,
    riskUsdt,
    fundingPnlUsdt: 0,
    lastFundingTime: candidate.t,
    lastCheckedAt: candidate.t,
    features: {
      fundingZ: candidate.fundingZ,
      breadthAbove50: candidate.breadthAbove50,
      breadthMomentum5d: candidate.breadthMomentum5d,
      btcRouter: candidate.btcRouter,
      btcRouterStrength: candidate.btcRouterStrength,
      eventScore: candidate.eventScore,
      dayVolume: candidate.dayVolume,
      volumeRatio: candidate.volumeRatio ?? null,
      rangeRatio: candidate.rangeRatio ?? null,
      wickShare: candidate.wickShare ?? null,
    },
  };
}

export function acceptCandidates(candidates, state, marketById) {
  const known = new Set(state.processedSignalIds);
  const unseen = candidates.filter(candidate => !known.has(candidate.id));
  const ranked = rankCandidates(unseen);
  const accepted = [];
  const rejected = [];
  const active = state.positions.filter(position => position.status === 'open');
  for (const candidate of ranked) {
    let reason = null;
    if (active.some(position => position.marketId === candidate.marketId)) reason = 'symbol-already-open';
    else if (candidate.t < (state.cooldowns[candidate.marketId] ?? -Infinity) + modelConfig.cooldownMs) reason = 'symbol-cooldown';
    else if (active.length >= modelConfig.cap) reason = 'portfolio-cap';
    else if (active.filter(position => position.side === candidate.side).length >= modelConfig.maxPerSide) reason = 'side-cap';
    if (reason) {
      rejected.push({candidate, reason});
      continue;
    }
    const market = marketById.get(candidate.marketId);
    const position = market ? positionFromCandidate(candidate, state, market) : null;
    if (!position) {
      rejected.push({candidate, reason: 'quantity-below-market-minimum'});
      continue;
    }
    active.push(position);
    accepted.push(position);
  }
  // A signal is a point-in-time decision. Rejected and non-top-ranked signals
  // must never be reconsidered later after capacity changes.
  for (const candidate of unseen) state.processedSignalIds.push(candidate.id);
  state.positions = active;
  return {accepted, rejected, rankedCount: ranked.length, unseenCount: unseen.length};
}
