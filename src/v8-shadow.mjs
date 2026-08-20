import {CORE_MARKETS, DAY, modelConfig, v8ShadowConfig} from './config.mjs';
import {recalculateFilledRisk} from './fill-risk.mjs';
import {marketRules} from './market-data.mjs';
import {adx, aggregate, atr, ema} from './indicators.mjs';
import {btcRegimesAt, fundingStateAt, generateLatestCandidates} from './strategy.mjs';
import {dedupeCandidates, rankCandidates} from './portfolio.mjs';
import {fetchMinuteRange, getFundingRates, mapLimit} from './binance.mjs';
import {allocateResearchRisk} from './risk.mjs';

export function createV8ShadowState(now = Date.now(), equityUsdt = 10_000) {
  return {
    schemaVersion: 1,
    modelVersion: v8ShadowConfig.version,
    mode: 'paper-shadow',
    startedAt: now,
    updatedAt: now,
    equityUsdt,
    peakEquityUsdt: equityUsdt,
    realizedPnlUsdt: 0,
    positions: [],
    closedPositions: [],
    processedSignalIds: [],
    lastScanSummary: null,
    lastMonitorSummary: null,
  };
}

function contextAt({t, funding, breadthByTime, btcEnvironment}) {
  const fundingState = fundingStateAt(funding, t);
  if (!fundingState) return null;
  const day = Math.floor(t / DAY) * DAY;
  const breadthAbove50 = breadthByTime.get(day) ?? 0.5;
  return {
    currentFundingRate: fundingState.rate,
    fundingZ: fundingState.z,
    breadthAbove50,
    breadthMomentum5d: breadthAbove50 - (breadthByTime.get(day - 5 * DAY) ?? breadthAbove50),
    ...btcRegimesAt(btcEnvironment, t),
  };
}

function mapControlCandidate(candidate, alpha) {
  const family = alpha === 'bull'
    ? 'v8BullTrendBreakout'
    : candidate.family === 'fundingCrowdingReversal' ? 'v8FundingCrowdingReversal' : 'v8VolumeShockReversal';
  return {
    ...candidate,
    id: `V8|${alpha}|${candidate.id}`,
    modelVersion: v8ShadowConfig.version,
    alpha,
    family,
    route: `v8_${alpha}`,
    edgeSegment: `v8-${candidate.edgeSegment}`,
    signalPrice: candidate.entry,
  };
}

function bearTrendCandidate({market, h1, daily: providedDaily, funding, breadthByTime, btcEnvironment, endTime}) {
  if (!CORE_MARKETS.has(market.symbol)) return null;
  const daily = providedDaily ?? aggregate(h1, DAY, endTime);
  if (daily.length < 221) return null;
  const i = daily.length - 1;
  const e50 = ema(daily, 50);
  const e200 = ema(daily, 200);
  const valuesAtr = atr(daily);
  const valuesAdx = adx(daily);
  if (valuesAtr[i] == null || valuesAdx[i] == null) return null;
  const bar = daily[i];
  const t = bar.t + DAY;
  const context = contextAt({t, funding, breadthByTime, btcEnvironment});
  if (!context || context.btcRouter !== 'bear' || e50[i] >= e200[i] || bar.c >= e50[i] || valuesAdx[i] < v8ShadowConfig.bear.minAdx) return null;
  const prior = daily.slice(i - v8ShadowConfig.bear.lookback, i);
  if (bar.c >= Math.min(...prior.map(item => item.l)) || bar.q < v8ShadowConfig.bear.minVolume) return null;
  const sl = Math.max(...daily.slice(i - 4, i + 1).map(item => item.h)) + 0.5 * valuesAtr[i];
  const stopPct = Math.abs(sl - bar.c) / bar.c;
  if (stopPct < v8ShadowConfig.bear.minStopPct || stopPct > v8ShadowConfig.bear.maxStopPct) return null;
  return {
    id: `V8|bear|${market.symbol}|${t}`,
    modelVersion: v8ShadowConfig.version,
    alpha: 'bear',
    marketId: market.symbol,
    symbol: market.baseAsset,
    core: true,
    route: 'v8_bear_core_trend_short',
    family: 'v8BearCoreTrendShort',
    side: 'short',
    t,
    signalIntervalHours: 24,
    signalPrice: bar.c,
    entry: bar.c,
    sl,
    stopPct,
    targetR: v8ShadowConfig.bear.targetR,
    target: bar.c - v8ShadowConfig.bear.targetR * (sl - bar.c),
    edgeScore: Math.max(0, context.btcBearAgeDays / 100),
    eventScore: Math.abs(bar.c / daily[i - v8ShadowConfig.bear.lookback].c - 1) * 100,
    dayVolume: bar.q,
    ...context,
    features: {...context, alpha: 'bear', breakoutLookback: v8ShadowConfig.bear.lookback},
  };
}

export function generateV8ShadowCandidates(args) {
  const control = generateLatestCandidates(args);
  const output = control
    .filter(candidate => candidate.family === 'dailyBreakout')
    .map(candidate => mapControlCandidate(candidate, 'bull'));
  output.push(...control
    .filter(candidate => candidate.family === 'fundingCrowdingReversal' || candidate.family === 'volumeShockReversal')
    .map(candidate => mapControlCandidate(candidate, 'reversal')));
  const bear = bearTrendCandidate(args);
  if (bear) output.push(bear);
  return dedupeCandidates(output);
}

export function acceptV8ShadowCandidates(candidates, state, marketById, options = {}) {
  const decisionTime = options.decisionTime ?? Date.now();
  const known = new Set(state.processedSignalIds);
  const unseen = candidates.filter(candidate => !known.has(candidate.id));
  const ranked = rankCandidates(unseen).filter(candidate => candidate.modelVersion === v8ShadowConfig.version);
  const accepted = [];
  const rejected = [];
  const active = state.positions.filter(position => position.status === 'open');
  for (const candidate of ranked) {
    let reason = null;
    if (active.some(position => position.marketId === candidate.marketId)) reason = 'symbol-already-open';
    else if (active.length >= v8ShadowConfig.positionCap) reason = 'portfolio-cap';
    else if (active.filter(position => position.side === candidate.side).length >= v8ShadowConfig.maxPerSide) reason = 'side-cap';
    const fillPrice = Number(candidate.fillPrice ?? options.fillPrices?.get(candidate.marketId));
    if (!reason && !(fillPrice > 0)) reason = 'fill-price-unavailable';
    const market = marketById.get(candidate.marketId);
    const filledRisk = !reason ? recalculateFilledRisk({
      side: candidate.side,
      family: candidate.family,
      fillPrice,
      stop: candidate.sl,
      targetR: candidate.targetR,
      tickSize: market ? marketRules(market).tickSize : 0,
    }) : null;
    if (!reason && !filledRisk?.accepted) reason = filledRisk?.reason || 'invalid-stop-distance';
    const allocation = !reason ? allocateResearchRisk({
      equityUsdt: state.equityUsdt,
      peakEquityUsdt: state.peakEquityUsdt,
      candidate: {...candidate, stopPct: filledRisk.stopPct},
      openPositions: active,
      closedPositions: state.closedPositions,
    }) : null;
    if (!reason && !allocation.accepted) reason = allocation.reason;
    if (reason) {
      rejected.push({candidate, reason});
      continue;
    }
    const position = {
      id: candidate.id,
      modelVersion: v8ShadowConfig.version,
      mode: 'paper-shadow',
      status: 'open',
      marketId: candidate.marketId,
      symbol: candidate.symbol,
      side: candidate.side,
      alpha: candidate.alpha,
      family: candidate.family,
      route: candidate.route,
      signalTime: candidate.t,
      signalPrice: candidate.signalPrice ?? candidate.entry,
      decisionTime,
      fillTime: decisionTime,
      fillPrice: filledRisk.fillPrice,
      entry: filledRisk.fillPrice,
      stop: filledRisk.stop,
      target: filledRisk.target,
      targetR: filledRisk.targetR,
      effectiveTargetR: filledRisk.effectiveTargetR,
      quantity: allocation.riskUsdt / Math.abs(filledRisk.fillPrice - filledRisk.stop),
      notionalUsdt: filledRisk.fillPrice * (allocation.riskUsdt / Math.abs(filledRisk.fillPrice - filledRisk.stop)),
      riskUsdt: allocation.riskUsdt,
      fundingPnlUsdt: 0,
      lastCheckedAt: decisionTime,
      lastFundingTime: decisionTime,
      matchedBreakouts: candidate.matchedBreakouts || [],
      riskAllocation: allocation,
      features: {...candidate.features, marketAvailable: Boolean(market)},
    };
    active.push(position);
    accepted.push(position);
  }
  for (const candidate of unseen) state.processedSignalIds.push(candidate.id);
  state.positions = active;
  state.updatedAt = decisionTime;
  return {accepted, rejected, rankedCount: ranked.length, unseenCount: unseen.length};
}

function firstShadowTouch(position, bars, now) {
  const fillTime = Number(position.fillTime ?? -Infinity);
  const firstEligibleMinute = Number.isFinite(fillTime) ? Math.ceil(fillTime / 60_000) * 60_000 : -Infinity;
  for (const bar of bars) {
    if (bar.t < firstEligibleMinute || (bar.closeTime ?? bar.t + 60_000) >= now) continue;
    const stopHit = position.side === 'long' ? bar.l <= position.stop : bar.h >= position.stop;
    const targetHit = position.side === 'long' ? bar.h >= position.target : bar.l <= position.target;
    if (stopHit) return {reason: 'sl', price: position.stop, time: bar.t + 60_000, ambiguous: targetHit};
    if (targetHit) return {reason: 'tp', price: position.target, time: bar.t + 60_000, ambiguous: false};
  }
  return null;
}

export async function runV8ShadowMonitor(state, now = Date.now()) {
  const active = state.positions.filter(position => position.status === 'open');
  if (!active.length) return {checked: 0, closed: 0, errors: 0};
  const results = await mapLimit(active, Math.min(3, active.length), async position => {
    try {
      const [bars, fundingRows] = await Promise.all([
        fetchMinuteRange(position.marketId, position.lastCheckedAt ?? position.fillTime, now),
        getFundingRates(position.marketId, {startTime: (position.lastFundingTime ?? position.fillTime) + 1, endTime: now, limit: 1000}),
      ]);
      const touch = firstShadowTouch(position, bars, now);
      const fundingPnlUsdt = Number(position.fundingPnlUsdt || 0);
      for (const row of fundingRows || []) {
        const eventTime = Number(row.fundingTime);
        if (eventTime >= (touch?.time ?? now + 1)) continue;
        const cashflow = (Number(row.markPrice) || position.entry) * position.quantity * Number(row.fundingRate);
        position.fundingPnlUsdt = (position.fundingPnlUsdt || 0) + (position.side === 'long' ? -cashflow : cashflow);
        position.lastFundingTime = Math.max(position.lastFundingTime || 0, eventTime);
      }
      if (!touch) {
        position.fundingPnlUsdt = position.fundingPnlUsdt ?? fundingPnlUsdt;
        position.lastCheckedAt = Math.floor(now / 60_000) * 60_000;
        return {position};
      }
      const direction = position.side === 'long' ? 1 : -1;
      const grossPnlUsdt = direction * (touch.price - position.entry) * position.quantity;
      const modeledCostUsdt = modelConfig.stressRoundTripCost * position.entry * position.quantity;
      const netPnlUsdt = grossPnlUsdt + position.fundingPnlUsdt - modeledCostUsdt;
      return {position: {...position, status: 'closed', exitReason: touch.reason, exitPrice: touch.price, exitTime: touch.time, ambiguousSameMinute: touch.ambiguous, grossPnlUsdt, modeledCostUsdt, netPnlUsdt, netR: position.riskUsdt ? netPnlUsdt / position.riskUsdt : null}, closed: true};
    } catch (error) {
      return {position, error: String(error)};
    }
  });
  const closed = results.filter(result => result.closed).map(result => result.position);
  state.positions = results.filter(result => !result.closed).map(result => result.position);
  state.closedPositions.push(...closed);
  state.realizedPnlUsdt += closed.reduce((sum, position) => sum + position.netPnlUsdt, 0);
  state.equityUsdt += closed.reduce((sum, position) => sum + position.netPnlUsdt, 0);
  state.peakEquityUsdt = Math.max(state.peakEquityUsdt || state.equityUsdt, state.equityUsdt);
  state.updatedAt = now;
  const errors = results.filter(result => result.error);
  return {checked: active.length, closed: closed.length, errors: errors.length};
}
