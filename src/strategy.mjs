import {CORE_MARKETS, DAY, H4, LONG_SLEEVES, SHORT_SEGMENTS} from './config.mjs';
import {adx, aggregate, atr, ema, lowerBound, rsi} from './indicators.mjs';

function reportFunnel(telemetry, context, stage, passed, rejectionReason = null, count = 1) {
  telemetry?.record({stage, passed, rejectionReason, count, ...context});
}

export function buildBreadth(dailyByMarket) {
  const accumulator = new Map();
  for (const daily of dailyByMarket.values()) {
    const e50 = ema(daily, 50);
    for (let i = 50; i < daily.length; i++) {
      const t = daily[i].t + DAY;
      if (!accumulator.has(t)) accumulator.set(t, {n: 0, above: 0});
      const item = accumulator.get(t);
      item.n++;
      if (daily[i].c > e50[i]) item.above++;
    }
  }
  return new Map([...accumulator].map(([t, value]) => [t, value.above / value.n]));
}

export function buildBtcEnvironment(daily) {
  const e20 = ema(daily, 20);
  const e50 = ema(daily, 50);
  const e200 = ema(daily, 200);
  const drawdown365 = new Array(daily.length).fill(null);
  const ema200Slope20 = new Array(daily.length).fill(null);
  const bearAgeDays = new Array(daily.length).fill(0);
  for (let i = 0; i < daily.length; i++) {
    const high365 = Math.max(...daily.slice(Math.max(0, i - 364), i + 1).map(bar => bar.h));
    drawdown365[i] = high365 > 0 ? daily[i].c / high365 - 1 : null;
    if (i >= 20 && e200[i] != null && e200[i - 20] != null) {
      ema200Slope20[i] = e200[i] / e200[i - 20] - 1;
    }
    const bear = i >= 5 && e200[i] != null && e50[i - 5] != null
      && daily[i].c < e200[i] && e50[i] < e50[i - 5];
    bearAgeDays[i] = bear ? (bearAgeDays[i - 1] || 0) + 1 : 0;
  }
  return {daily, e20, e50, e200, drawdown365, ema200Slope20, bearAgeDays};
}

export function btcRegimesAt(environment, timestamp) {
  const {daily, e20, e50, e200, drawdown365, ema200Slope20, bearAgeDays} = environment;
  const i = lowerBound(daily, timestamp + 1, bar => bar.t + DAY) - 1;
  if (i < 0) return {btcRouter: 'neutral', btcRouterStrength: 0, btcDrawdown365: null, btcEma200Slope20: null, btcBearAgeDays: 0};
  const close = daily[i].c;
  const btcRouter = i < 5 || e200[i] == null || e50[i - 5] == null ? 'neutral'
    : close > e200[i] && e50[i] > e50[i - 5] ? 'bull'
      : close < e200[i] && e50[i] < e50[i - 5] ? 'bear' : 'neutral';
  const btcRouterStrength = i < 5 || e200[i] == null || e50[i - 5] == null ? 0
    : close / e200[i] - 1 + e50[i] / e50[i - 5] - 1;
  return {
    btcRouter,
    btcRouterStrength,
    btcDrawdown365: drawdown365[i],
    btcEma200Slope20: ema200Slope20[i],
    btcBearAgeDays: bearAgeDays[i],
  };
}

export function fundingStateAt(events, timestamp) {
  const to = lowerBound(events, timestamp, event => event.t);
  if (to < 22) return null;
  const current = events[to - 1];
  const prior = events.slice(to - 22, to - 1).map(event => event.rate);
  const mean = prior.reduce((sum, value) => sum + value, 0) / prior.length;
  const deviation = Math.sqrt(prior.reduce((sum, value) => sum + (value - mean) ** 2, 0) / prior.length);
  return {rate: current.rate, z: deviation > 1e-12 ? (current.rate - mean) / deviation : 0};
}

function sharedFeatures({t, funding, breadthByTime, btcEnvironment}) {
  const fundingState = fundingStateAt(funding, t);
  if (!fundingState) return null;
  const latestDailyClose = Math.floor(t / DAY) * DAY;
  const breadthAbove50 = breadthByTime.get(latestDailyClose) ?? 0.5;
  const breadthMomentum5d = breadthAbove50 - (breadthByTime.get(latestDailyClose - 5 * DAY) ?? breadthAbove50);
  return {
    currentFundingRate: fundingState.rate,
    fundingZ: fundingState.z,
    breadthAbove50,
    breadthMomentum5d,
    ...btcRegimesAt(btcEnvironment, t),
  };
}

function edgeScore(estimate) {
  return estimate.lcb90 + 0.1 * estimate.mean;
}

export function selectShortTarget(candidate) {
  const matches = SHORT_SEGMENTS.filter(segment => segment.family === candidate.family
    && Number.isFinite(candidate[segment.feature])
    && candidate[segment.feature] >= segment.min
    && candidate[segment.feature] < segment.max);
  if (!matches.length) return null;
  matches.sort((a, b) => b.lcb90 - a.lcb90 || b.mean - a.mean);
  const best = matches[0];
  return {
    ...candidate,
    targetR: best.targetR,
    edgeScore: edgeScore(best),
    edgeSegment: best.id,
    target: candidate.entry - best.targetR * (candidate.sl - candidate.entry),
  };
}

function dailyLongCandidates({market, h1, daily: providedDaily, funding, breadthByTime, btcEnvironment, endTime, telemetry}) {
  const funnelContext = {family: 'dailyBreakout', side: 'long', regime: 'unknown', symbol: market.symbol, tier: CORE_MARKETS.has(market.symbol) ? 'core' : 'expanded'};
  const daily = providedDaily ?? aggregate(h1, DAY, endTime);
  if (daily.length < 201) {
    reportFunnel(telemetry, funnelContext, 'history_valid', false, 'insufficient_history');
    return [];
  }
  reportFunnel(telemetry, funnelContext, 'history_valid', true);
  const i = daily.length - 1;
  const t = daily[i].t + DAY;
  const bar = daily[i];
  const e50 = ema(daily, 50);
  const e200 = ema(daily, 200);
  const dailyAtr = atr(daily);
  const dailyAdx = adx(daily);
  if (dailyAtr[i] == null || dailyAdx[i] == null) {
    reportFunnel(telemetry, funnelContext, 'history_valid', false, 'indicator_unavailable');
    return [];
  }
  const firstPositive = h1.find(item => item.q > 0)?.t ?? +market.onboardDate;
  const rolling30DayAverageVolume = daily.slice(i - 29, i + 1).reduce((sum, item) => sum + item.q, 0) / 30;
  const liquidityValid = bar.q >= 20_000_000 && t >= firstPositive + 180 * DAY && rolling30DayAverageVolume >= 20_000_000;
  reportFunnel(telemetry, funnelContext, 'liquidity_valid', liquidityValid, liquidityValid ? null : 'liquidity_filter');
  if (!liquidityValid) return [];
  const features = sharedFeatures({t, funding, breadthByTime, btcEnvironment});
  if (!features) {
    reportFunnel(telemetry, funnelContext, 'funding_valid', false, 'funding_history_unavailable');
    return [];
  }
  const context = {...funnelContext, regime: features.btcRouter};
  const regimeValid = features.btcRouter === 'bull' && features.breadthAbove50 >= 0.55;
  reportFunnel(telemetry, context, 'regime_valid', regimeValid, regimeValid ? null : 'regime_filter');
  if (!regimeValid) return [];
  const trendValid = e50[i] > e200[i] && bar.c > e50[i] && dailyAdx[i] >= 18;
  reportFunnel(telemetry, context, 'trend_valid', trendValid, trendValid ? null : 'trend_filter');
  if (!trendValid) return [];
  const fundingValid = features.fundingZ < 1.5;
  reportFunnel(telemetry, context, 'funding_valid', fundingValid, fundingValid ? null : 'funding_filter');
  if (!fundingValid) return [];
  const recent = daily.slice(i - 4, i + 1);
  const sl = Math.min(...recent.map(item => item.l)) - 0.5 * dailyAtr[i];
  const stopPct = Math.abs(bar.c - sl) / bar.c;
  const stopValid = stopPct >= 0.02 && stopPct <= 0.12;
  reportFunnel(telemetry, context, 'stop_valid', stopValid, stopValid ? null : 'stop_distance_filter');
  if (!stopValid) return [];
  const core = CORE_MARKETS.has(market.symbol);
  const sleeve = LONG_SLEEVES[core ? 'core' : 'expanded'];
  const candidates = [];
  for (const breakoutLookback of [5, 10, 20]) {
    const prior = daily.slice(i - breakoutLookback, i);
    if (bar.c <= Math.max(...prior.map(item => item.h))) continue;
    candidates.push({
      id: `${market.symbol}|v39_${breakoutLookback}d|long|${t}`,
      marketId: market.symbol,
      symbol: market.baseAsset,
      alpha: 'daily_breakout_long',
      core,
      route: 'extended_cycle_regime_breakout',
      family: 'dailyBreakout',
      side: 'long',
      t,
      signalIntervalHours: 24,
      entry: bar.c,
      sl,
      stopPct,
      dayVolume: bar.q,
      breakoutLookback,
      eventScore: 100 * Math.abs(bar.c / daily[i - breakoutLookback].c - 1),
      ...features,
      targetR: sleeve.targetR,
      target: bar.c + sleeve.targetR * (bar.c - sl),
      edgeScore: edgeScore(sleeve),
      edgeSegment: `long-dailyBreakout-2R-${core ? 'core' : 'expanded'}`,
    });
  }
  const triggerValid = candidates.length > 0;
  reportFunnel(telemetry, context, 'trigger_valid', triggerValid, triggerValid ? null : 'no_breakout');
  if (triggerValid) reportFunnel(telemetry, context, 'edge_valid', true);
  return candidates;
}

function fundingCrowdingShort({market, bars, funding, breadthByTime, btcEnvironment, telemetry}) {
  const funnelContext = {family: 'fundingCrowdingReversal', side: 'short', regime: 'unknown', symbol: market.symbol, tier: 'expanded'};
  if (bars.length < 201) {
    reportFunnel(telemetry, funnelContext, 'history_valid', false, 'insufficient_history');
    return null;
  }
  reportFunnel(telemetry, funnelContext, 'history_valid', true);
  const i = bars.length - 1;
  const intervalAtr = atr(bars);
  const intervalAdx = adx(bars);
  const intervalRsi = rsi(bars);
  if (intervalAtr[i] == null || intervalAdx[i] == null || intervalRsi[i] == null || intervalRsi[i - 1] == null) {
    reportFunnel(telemetry, funnelContext, 'history_valid', false, 'indicator_unavailable');
    return null;
  }
  const t = bars[i].t + H4;
  const rolling24hVolume = bars.slice(i - 5, i + 1).reduce((sum, item) => sum + item.q, 0);
  const liquidityValid = rolling24hVolume >= 20_000_000;
  reportFunnel(telemetry, funnelContext, 'liquidity_valid', liquidityValid, liquidityValid ? null : 'liquidity_filter');
  if (!liquidityValid) return null;
  const trendValid = intervalAdx[i] <= 30;
  reportFunnel(telemetry, funnelContext, 'trend_valid', trendValid, trendValid ? null : 'trend_filter');
  if (!trendValid) return null;
  const features = sharedFeatures({t, funding, breadthByTime, btcEnvironment});
  if (!features) {
    reportFunnel(telemetry, funnelContext, 'funding_valid', false, 'funding_history_unavailable');
    return null;
  }
  const context = {...funnelContext, regime: features.btcRouter};
  reportFunnel(telemetry, context, 'regime_valid', true);
  const fundingValid = features.currentFundingRate > 0 && features.fundingZ >= 2;
  reportFunnel(telemetry, context, 'funding_valid', fundingValid, fundingValid ? null : 'funding_filter');
  if (!fundingValid) return null;
  const bar = bars[i];
  const triggerValid = intervalRsi[i - 1] >= 65 && intervalRsi[i] < intervalRsi[i - 1] && bar.c < bar.o;
  reportFunnel(telemetry, context, 'trigger_valid', triggerValid, triggerValid ? null : 'reversal_trigger_filter');
  if (!triggerValid) return null;
  const anchor = Math.max(...bars.slice(i - 4, i + 1).map(item => item.h));
  const sl = anchor + 0.5 * intervalAtr[i];
  const stopPct = Math.abs(bar.c - sl) / bar.c;
  const stopValid = stopPct >= 0.02 && stopPct <= 0.08;
  reportFunnel(telemetry, context, 'stop_valid', stopValid, stopValid ? null : 'stop_distance_filter');
  if (!stopValid) return null;
  const selected = selectShortTarget({
    id: `${market.symbol}|v54_funding_crowding_reversal|short|${t}`,
     marketId: market.symbol,
     symbol: market.baseAsset,
     alpha: 'funding_crowding_short',
     core: false,
    route: 'funding_crowding_reversal',
    family: 'fundingCrowdingReversal',
    side: 'short',
    t,
    signalIntervalHours: 4,
    entry: bar.c,
    sl,
    stopPct,
    dayVolume: rolling24hVolume,
    breakoutLookback: -2,
    eventScore: Math.abs(features.fundingZ),
    ...features,
  });
  reportFunnel(telemetry, context, 'edge_valid', Boolean(selected), selected ? null : 'no_edge_segment');
  return selected;
}

function volumeShockShort({market, bars, funding, breadthByTime, btcEnvironment, telemetry}) {
  const funnelContext = {family: 'volumeShockReversal', side: 'short', regime: 'unknown', symbol: market.symbol, tier: 'expanded'};
  if (bars.length < 201) {
    reportFunnel(telemetry, funnelContext, 'history_valid', false, 'insufficient_history');
    return null;
  }
  reportFunnel(telemetry, funnelContext, 'history_valid', true);
  const i = bars.length - 1;
  const intervalAtr = atr(bars);
  if (intervalAtr[i] == null) {
    reportFunnel(telemetry, funnelContext, 'history_valid', false, 'indicator_unavailable');
    return null;
  }
  const priorRange = bars.slice(i - 20, i);
  const bar = bars[i];
  const averageVolume = priorRange.reduce((sum, item) => sum + item.q, 0) / priorRange.length;
  const volumeRatio = averageVolume > 0 ? bar.q / averageVolume : 0;
  const trueRange = Math.max(bar.h - bar.l, Math.abs(bar.h - bars[i - 1].c), Math.abs(bar.l - bars[i - 1].c));
  const rangeRatio = trueRange / intervalAtr[i];
  const triggerValid = volumeRatio >= 3 && rangeRatio >= 2 && bar.h > bar.l;
  reportFunnel(telemetry, funnelContext, 'trigger_valid', triggerValid, triggerValid ? null : 'shock_size_filter');
  if (!triggerValid) return null;
  const rolling24hVolume = bars.slice(i - 5, i + 1).reduce((sum, item) => sum + item.q, 0);
  const liquidityValid = rolling24hVolume >= 20_000_000;
  reportFunnel(telemetry, funnelContext, 'liquidity_valid', liquidityValid, liquidityValid ? null : 'liquidity_filter');
  if (!liquidityValid) return null;
  const t = bar.t + H4;
  const features = sharedFeatures({t, funding, breadthByTime, btcEnvironment});
  if (!features) {
    reportFunnel(telemetry, funnelContext, 'funding_valid', false, 'funding_history_unavailable');
    return null;
  }
  const context = {...funnelContext, regime: features.btcRouter};
  reportFunnel(telemetry, context, 'regime_valid', true);
  const fundingValid = features.fundingZ >= 0;
  reportFunnel(telemetry, context, 'funding_valid', fundingValid, fundingValid ? null : 'funding_filter');
  if (!fundingValid) return null;
  const priorHigh = Math.max(...priorRange.map(item => item.h));
  const wickShare = (bar.h - Math.max(bar.o, bar.c)) / (bar.h - bar.l);
  const reversalValid = bar.h > priorHigh && bar.c < priorHigh && bar.c < bar.o && wickShare >= 0.5;
  reportFunnel(telemetry, context, 'trend_valid', reversalValid, reversalValid ? null : 'reversal_shape_filter');
  if (!reversalValid) return null;
  const sl = bar.h + 0.25 * intervalAtr[i];
  const stopPct = Math.abs(bar.c - sl) / bar.c;
  const stopValid = stopPct >= 0.02 && stopPct <= 0.10;
  reportFunnel(telemetry, context, 'stop_valid', stopValid, stopValid ? null : 'stop_distance_filter');
  if (!stopValid) return null;
  const selected = selectShortTarget({
    id: `${market.symbol}|v59_volume_shock_reversal|short|${t}`,
     marketId: market.symbol,
     symbol: market.baseAsset,
     alpha: 'volume_shock_short',
     core: false,
    route: 'volume_shock_reversal',
    family: 'volumeShockReversal',
    side: 'short',
    t,
    signalIntervalHours: 4,
    entry: bar.c,
    sl,
    stopPct,
    dayVolume: rolling24hVolume,
    breakoutLookback: -5,
    eventScore: volumeRatio * rangeRatio * wickShare,
    volumeRatio,
    rangeRatio,
    wickShare,
    ...features,
  });
  reportFunnel(telemetry, context, 'edge_valid', Boolean(selected), selected ? null : 'no_edge_segment');
  return selected;
}

export function generateLatestCandidates({market, h1, daily, bars4h, funding, breadthByTime, btcEnvironment, endTime, telemetry}) {
  const output = dailyLongCandidates({market, h1, daily, funding, breadthByTime, btcEnvironment, endTime, telemetry});
  // The frozen barbell model takes 4h shorts only from the expanded universe.
  if (!CORE_MARKETS.has(market.symbol)) {
    const bars = bars4h ?? aggregate(h1, H4, endTime);
    const fundingShort = fundingCrowdingShort({market, bars, funding, breadthByTime, btcEnvironment, telemetry});
    const shockShort = volumeShockShort({market, bars, funding, breadthByTime, btcEnvironment, telemetry});
    if (fundingShort) output.push(fundingShort);
    if (shockShort) output.push(shockShort);
  }
  return output;
}
