import {CORE_MARKETS, DAY, adx, atr, ema, generateCandidates, rankCandidates, roundToTick} from './strategy.mjs';

export const V8_SHADOW_VERSION = 'V8-shadow-research-20260819';
const BEAR = Object.freeze({lookback: 20, minAdx: 18, minVolume: 20_000_000, minStopPct: 0.02, maxStopPct: 0.12, targetR: 2});

function mapControl(candidate, alpha) {
  return {
    ...candidate,
    signalId: `V8|${alpha}|${candidate.signalId}`,
    modelVersion: V8_SHADOW_VERSION,
    alpha,
    family: alpha === 'bull' ? 'v8BullTrendBreakout'
      : candidate.family === 'fundingCrowdingReversal' ? 'v8FundingCrowdingReversal' : 'v8VolumeShockReversal',
    route: `v8_${alpha}`,
    edgeSegment: `v8-${candidate.edgeSegment}`,
    features: {...candidate.features, alpha},
  };
}

function bearCandidate({market, daily, context}) {
  if (!market.core || daily.length < 221 || context.btcRouter !== 'bear') return null;
  const i = daily.length - 1;
  const e50 = ema(daily, 50);
  const e200 = ema(daily, 200);
  const valuesAtr = atr(daily);
  const valuesAdx = adx(daily);
  const bar = daily[i];
  if (valuesAtr[i] == null || valuesAdx[i] == null || e50[i] >= e200[i] || bar.c >= e50[i] || valuesAdx[i] < BEAR.minAdx) return null;
  const prior = daily.slice(i - BEAR.lookback, i);
  if (bar.c >= Math.min(...prior.map(item => item.l)) || bar.q < BEAR.minVolume) return null;
  const signalTime = bar.closeTime + 1;
  const sl = Math.max(...daily.slice(i - 4, i + 1).map(item => item.h)) + 0.5 * valuesAtr[i];
  const stopPct = Math.abs(sl - bar.c) / bar.c;
  if (stopPct < BEAR.minStopPct || stopPct > BEAR.maxStopPct) return null;
  return {
    signalId: `V8|bear|${market.marketId}|${signalTime}`,
    signalTime,
    marketId: market.marketId,
    symbol: market.baseAsset,
    side: 'short',
    family: 'v8BearCoreTrendShort',
    route: 'v8_bear_core_trend_short',
    edgeSegment: 'v8-bear-core-trend',
    entry: bar.c,
    stop: roundToTick(sl, market.tickSize),
    target: roundToTick(bar.c - BEAR.targetR * (sl - bar.c), market.tickSize),
    targetR: BEAR.targetR,
    stopPct,
    edgeScore: Math.max(0, Number(context.btcBearAgeDays || 0) / 100),
    eventScore: Math.abs(bar.c / daily[i - BEAR.lookback].c - 1) * 100,
    dayVolume: bar.q,
    alpha: 'bear',
    modelVersion: V8_SHADOW_VERSION,
    features: {...context, alpha: 'bear', breakoutLookback: BEAR.lookback},
  };
}

export function generateV8ShadowCandidates({market, daily, bars4h, funding, context}) {
  const control = generateCandidates({market, daily, bars4h, funding, context});
  const output = control
    .filter(candidate => candidate.family === 'dailyBreakout')
    .map(candidate => mapControl(candidate, 'bull'));
  output.push(...control
    .filter(candidate => candidate.family === 'fundingCrowdingReversal' || candidate.family === 'volumeShockReversal')
    .map(candidate => mapControl(candidate, 'reversal')));
  const bear = bearCandidate({market, daily, context});
  if (bear) output.push(bear);
  return output;
}

export function rankV8ShadowCandidates(candidates, cap = 3) {
  return rankCandidates(candidates, cap);
}
