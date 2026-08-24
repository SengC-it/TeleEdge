import {modelConfig} from './config.mjs';
import {recalculateFilledRisk} from './fill-risk.mjs';
import {marketRules, roundDown, roundToTick} from './market-data.mjs';

function numericTime(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : NaN;
}

function rankValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : -Infinity;
}

function compareCandidates(a, b) {
  return rankValue(b.edgeScore) - rankValue(a.edgeScore)
    || rankValue(b.eventScore) - rankValue(a.eventScore)
    || rankValue(b.dayVolume) - rankValue(a.dayVolume)
    || String(a.id ?? a.signalId ?? '').localeCompare(String(b.id ?? b.signalId ?? ''));
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
  }).sort((a, b) => numericTime(a.t) - numericTime(b.t) || compareCandidates(a, b));
}

/**
 * Shared local/backtest acceptance contract. The database RPC applies the
 * same gate ordering and fill-risk/quantity rules to the persisted candidate.
 */
export function evaluateCandidateAcceptance(candidate, {
  activePositions = [],
  cooldowns = {},
  equityUsdt = 0,
  market = null,
  decisionTime = Date.now(),
  fillTime = candidate.fillTime ?? decisionTime,
  fillPrice = candidate.fillPrice,
  strictFill = false,
  positionCap = modelConfig.cap,
  sideCap = modelConfig.maxPerSide,
} = {}) {
  const openPositions = (activePositions || []).filter(position => position.status == null || position.status === 'open');
  const configuredFillPrice = fillPrice ?? candidate.fillPrice;
  if (strictFill && !(Number(configuredFillPrice) > 0)) return {accepted: false, reason: 'fill-price-unavailable'};
  if (!(numericTime(fillTime) >= numericTime(candidate.t))) return {accepted: false, reason: 'invalid-fill-time'};
  if (!market) return {accepted: false, reason: 'market-data-unavailable'};
  const rules = marketRules(market);
  if (!(rules.tickSize > 0)) return {accepted: false, reason: 'invalid-market-tick'};
  if (!(rules.stepSize > 0)) return {accepted: false, reason: 'invalid-market-step'};
  if (openPositions.some(position => position.marketId === candidate.marketId)) return {accepted: false, reason: 'symbol-already-open'};
  if (numericTime(candidate.t) < numericTime(cooldowns[candidate.marketId] ?? -Infinity) + modelConfig.cooldownMs) {
    return {accepted: false, reason: 'symbol-cooldown'};
  }
  if (openPositions.length >= positionCap) return {accepted: false, reason: 'portfolio-cap'};
  if (openPositions.filter(position => position.side === candidate.side).length >= sideCap) return {accepted: false, reason: 'side-cap'};
  const entry = roundToTick(candidate.entry, rules.tickSize);
  const roundedFillPrice = roundToTick(Number(configuredFillPrice ?? entry), rules.tickSize);
  if (!(roundedFillPrice > 0)) return {accepted: false, reason: 'fill-price-unavailable'};
  const filledRisk = recalculateFilledRisk({
    side: candidate.side,
    family: candidate.family,
    fillPrice: roundedFillPrice,
    stop: roundToTick(candidate.sl, rules.tickSize),
    targetR: candidate.targetR,
    tickSize: rules.tickSize,
  });
  if (!filledRisk.accepted) return {accepted: false, reason: filledRisk.reason, filledRisk, rules, entry};
  const plannedRiskUsdt = Number(equityUsdt) * modelConfig.riskFraction;
  const quantity = roundDown(plannedRiskUsdt / Math.abs(filledRisk.fillPrice - filledRisk.stop), rules.stepSize);
  if (!(quantity > 0) || quantity < rules.minQty) {
    return {accepted: false, reason: 'quantity-below-market-minimum', filledRisk, rules, entry, quantity};
  }
  const riskUsdt = quantity * Math.abs(filledRisk.fillPrice - filledRisk.stop);
  return {accepted: true, rules, entry, fillPrice: filledRisk.fillPrice, fillTime, filledRisk, quantity, riskUsdt};
}

function positionFromCandidate(candidate, state, market, options, acceptance = null) {
  const decisionTime = options.decisionTime;
  const contract = acceptance || evaluateCandidateAcceptance(candidate, {
    activePositions: state.positions,
    cooldowns: state.cooldowns,
    equityUsdt: state.equityUsdt,
    market,
    decisionTime,
    fillTime: candidate.fillTime ?? decisionTime,
    fillPrice: candidate.fillPrice ?? options.fillPrices?.get(candidate.marketId),
    strictFill: options.strictFill,
  });
  if (!contract.accepted) return null;
  const {entry, fillTime, filledRisk, quantity, riskUsdt} = contract;
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
  state.cooldowns ||= {};
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
    const market = marketById.get(candidate.marketId);
    const configuredFillPrice = candidate.fillPrice ?? normalizedOptions.fillPrices?.get(candidate.marketId);
    const acceptance = evaluateCandidateAcceptance(candidate, {
      activePositions: active,
      cooldowns: state.cooldowns,
      equityUsdt: state.equityUsdt,
      market,
      decisionTime: normalizedOptions.decisionTime,
      fillTime: candidate.fillTime ?? normalizedOptions.decisionTime,
      fillPrice: configuredFillPrice,
      strictFill: normalizedOptions.strictFill,
    });
    const position = acceptance.accepted ? positionFromCandidate(candidate, state, market, normalizedOptions, acceptance) : null;
    if (!position) {
      const reason = acceptance.reason || 'quantity-below-market-minimum';
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
