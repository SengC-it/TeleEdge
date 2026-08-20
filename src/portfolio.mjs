import {modelConfig} from './config.mjs';
import {recalculateFilledRisk} from './fill-risk.mjs';
import {marketRules, roundDown, roundToTick} from './market-data.mjs';

function compareCandidates(a, b) {
  return b.edgeScore - a.edgeScore || b.eventScore - a.eventScore || b.dayVolume - a.dayVolume
    || String(a.id).localeCompare(String(b.id));
}

function candidateKey(candidate) {
  return `${candidate.marketId || candidate.symbol}|${candidate.side}|${candidate.t}`;
}

export function dedupeCandidates(input) {
  const groups = new Map();
  for (const candidate of input) {
    const key = candidateKey(candidate);
    const previous = groups.get(key);
    if (!previous) {
      groups.set(key, {...candidate});
      continue;
    }
    const matched = new Set([
      ...(previous.matchedBreakouts || []),
      ...(candidate.matchedBreakouts || []),
      previous.breakoutLookback,
      candidate.breakoutLookback,
      previous.features?.breakoutLookback,
      candidate.features?.breakoutLookback,
    ].filter(value => Number.isFinite(Number(value))).map(Number));
    const winner = compareCandidates(candidate, previous) < 0 ? candidate : previous;
    groups.set(key, {
      ...winner,
      matchedBreakouts: [...matched].sort((a, b) => a - b),
      features: {...winner.features, matchedBreakouts: [...matched].sort((a, b) => a - b)},
    });
  }
  return [...groups.values()];
}

export function rankCandidates(input) {
  const groups = new Map();
  for (const candidate of dedupeCandidates(input)) {
    const key = `${candidate.t}|${candidate.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  return [...groups.values()].flatMap(group => {
    return group.sort(compareCandidates).slice(0, modelConfig.sameTimePerSide);
  }).sort((a, b) => a.t - b.t || compareCandidates(a, b));
}

function positionFromCandidate(candidate, state, market, options) {
  const rules = marketRules(market);
  const entry = roundToTick(candidate.entry, rules.tickSize);
  const stop = roundToTick(candidate.sl, rules.tickSize);
  const decisionTime = options.decisionTime;
  const fillTime = candidate.fillTime ?? decisionTime;
  const configuredFillPrice = candidate.fillPrice ?? options.fillPrices?.get(candidate.marketId);
  if (options.strictFill && !(Number(configuredFillPrice) > 0)) return null;
  const fillPrice = roundToTick(Number(configuredFillPrice ?? entry), rules.tickSize);
  if (!(fillPrice > 0) || !(fillTime >= candidate.t)) return null;
  const filledRisk = recalculateFilledRisk({
    side: candidate.side,
    family: candidate.family,
    fillPrice,
    stop,
    targetR: candidate.targetR,
    tickSize: rules.tickSize,
  });
  if (!filledRisk.accepted) return null;
  const plannedRiskUsdt = state.equityUsdt * modelConfig.riskFraction;
  const quantity = roundDown(plannedRiskUsdt / Math.abs(filledRisk.fillPrice - filledRisk.stop), rules.stepSize);
  if (!(quantity > 0) || quantity < rules.minQty) return null;
  const riskUsdt = quantity * Math.abs(filledRisk.fillPrice - filledRisk.stop);
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
    signalPrice: entry,
    decisionTime,
    fillTime,
    fillPrice: filledRisk.fillPrice,
    openedAt: decisionTime,
    entry: filledRisk.fillPrice,
    stop: filledRisk.stop,
    target: filledRisk.target,
    targetR: filledRisk.targetR,
    effectiveTargetR: filledRisk.effectiveTargetR,
    stopPct: filledRisk.stopPct,
    quantity,
    notionalUsdt: filledRisk.fillPrice * quantity,
    riskUsdt,
    fundingPnlUsdt: 0,
    lastFundingTime: fillTime,
    lastCheckedAt: fillTime,
    matchedBreakouts: candidate.matchedBreakouts || [],
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

export function acceptCandidates(candidates, state, marketById, options = {}) {
  const normalizedOptions = {
    decisionTime: options.decisionTime ?? Date.now(),
    fillPrices: options.fillPrices,
    strictFill: Boolean(options.strictFill),
    funnel: options.funnel,
  };
  const known = new Set(state.processedSignalIds);
  const unseen = candidates.filter(candidate => !known.has(candidate.id));
  const ranked = rankCandidates(unseen);
  const accepted = [];
  const rejected = [];
  const active = state.positions.filter(position => position.status === 'open');
  const report = (candidate, stage, passed, rejectionReason = null) => normalizedOptions.funnel?.record({
    stage,
    passed,
    rejectionReason,
    family: candidate.family,
    side: candidate.side,
    regime: candidate.btcRouter,
    symbol: candidate.marketId || candidate.symbol,
    tier: candidate.core ? 'core' : 'expanded',
  });
  for (const candidate of ranked) {
    report(candidate, 'ranked', true);
    let reason = null;
    if (active.some(position => position.marketId === candidate.marketId)) reason = 'symbol-already-open';
    else if (candidate.t < (state.cooldowns[candidate.marketId] ?? -Infinity) + modelConfig.cooldownMs) reason = 'symbol-cooldown';
    else if (active.length >= modelConfig.cap) reason = 'portfolio-cap';
    else if (active.filter(position => position.side === candidate.side).length >= modelConfig.maxPerSide) reason = 'side-cap';
    if (reason) {
      rejected.push({candidate, reason});
      report(candidate, 'accepted', false, reason);
      continue;
    }
    const market = marketById.get(candidate.marketId);
    let position = null;
    if (market) {
      const rules = marketRules(market);
      const entry = roundToTick(candidate.entry, rules.tickSize);
      const configuredFillPrice = candidate.fillPrice ?? normalizedOptions.fillPrices?.get(candidate.marketId);
      const fillPrice = roundToTick(Number(configuredFillPrice ?? entry), rules.tickSize);
      if (normalizedOptions.strictFill && !(Number(configuredFillPrice) > 0)) {
        reason = 'fill-price-unavailable';
      } else {
        const filledRisk = recalculateFilledRisk({
          side: candidate.side,
          family: candidate.family,
          fillPrice,
          stop: roundToTick(candidate.sl, rules.tickSize),
          targetR: candidate.targetR,
          tickSize: rules.tickSize,
        });
        if (!filledRisk.accepted) reason = filledRisk.reason;
        else position = positionFromCandidate(candidate, state, market, normalizedOptions);
      }
    }
    if (!position) {
      reason ||= normalizedOptions.strictFill && !(Number(candidate.fillPrice ?? normalizedOptions.fillPrices?.get(candidate.marketId)) > 0)
        ? 'fill-price-unavailable' : 'quantity-below-market-minimum';
      rejected.push({candidate, reason});
      report(candidate, 'accepted', false, reason);
      continue;
    }
    active.push(position);
    accepted.push(position);
    report(candidate, 'accepted', true);
  }
  // A signal is a point-in-time decision. Rejected and non-top-ranked signals
  // must never be reconsidered later after capacity changes.
  for (const candidate of unseen) state.processedSignalIds.push(candidate.id);
  state.positions = active;
  return {accepted, rejected, rankedCount: ranked.length, unseenCount: unseen.length};
}
