const DAY = 86_400_000;
const H4 = 14_400_000;

export const CORE_MARKETS = new Set([
  'AAVEUSDT', 'ADAUSDT', 'AGLDUSDT', 'ALGOUSDT', 'ALLOUSDT', 'APTUSDT',
  'ARBUSDT', 'ASTERUSDT', 'AVAXUSDT', 'BCHUSDT', 'BEATUSDT', 'BNBUSDT',
  '1000BONKUSDT', 'BTCUSDT', 'DASHUSDT', 'DOGEUSDT', 'DOTUSDT', 'EIGENUSDT',
  'ENAUSDT', 'ETCUSDT', 'ETHUSDT', 'FARTCOINUSDT', 'FILUSDT', 'GLMUSDT',
  'GRASSUSDT', 'HUSDT', 'HBARUSDT', 'HYPEUSDT', 'INJUSDT', 'JTOUSDT',
  'JUPUSDT', 'KAITOUSDT', 'KGENUSDT', 'LABUSDT', 'LINKUSDT', 'LITUSDT',
  'LTCUSDT', 'MMTUSDT', 'MSTRUSDT', 'NEARUSDT', 'ONDOUSDT', 'OPUSDT',
  'PENGUUSDT', '1000PEPEUSDT', 'PIEVERSEUSDT', 'RAVEUSDT', 'RENDERUSDT',
  'SUSDT', 'SEIUSDT', '1000SHIBUSDT', 'SNDKUSDT', 'SOLUSDT', 'STXUSDT',
  'SUIUSDT', 'SYRUPUSDT', 'TAOUSDT', 'TIAUSDT', 'TRUMPUSDT', 'TRXUSDT',
  'UNIUSDT', 'VIRTUALUSDT', 'WIFUSDT', 'WLDUSDT', 'WLFIUSDT', 'XAGUSDT',
  'XAUUSDT', 'XLMUSDT', 'XPLUSDT', 'XRPUSDT', 'ZECUSDT',
]);

const LONG_SLEEVES = {
  expanded: {targetR: 2, mean: 0.6566271611465045, lcb90: 0.39774417899478093},
  core: {targetR: 2, mean: 0.487856733621996, lcb90: 0.3794563977981343},
};

const SHORT_SEGMENTS = [
  {id: 'funding-breadth-minus10-to-0', family: 'fundingCrowdingReversal', targetR: 1.5, feature: 'breadthMomentum5d', min: -0.1, max: 0, mean: 0.5425502254706844, lcb90: 0.36551350071043354},
  {id: 'funding-volume-gte200m', family: 'fundingCrowdingReversal', targetR: 1.5, feature: 'dayVolume', min: 200_000_000, max: Infinity, mean: 0.24441156266925573, lcb90: 0.03413067293733266},
  {id: 'shock-volume-50-to-200m', family: 'volumeShockReversal', targetR: 1.5, feature: 'dayVolume', min: 50_000_000, max: 200_000_000, mean: 0.17594210898154714, lcb90: 0.04089951234156186},
  {id: 'shock-btc-strength-0-to-20', family: 'volumeShockReversal', targetR: 1.5, feature: 'btcRouterStrength', min: 0, max: 0.2, mean: 0.2049284641968539, lcb90: 0.06586850310536216},
  {id: 'shock-volume-ratio-gte5', family: 'volumeShockReversal', targetR: 2, feature: 'volumeRatio', min: 5, max: Infinity, mean: 0.17316054103044048, lcb90: 0.03243004980966105},
  {id: 'shock-btc-strength-0-to-20-2r', family: 'volumeShockReversal', targetR: 2, feature: 'btcRouterStrength', min: 0, max: 0.2, mean: 0.22522904342527966, lcb90: 0.06082927924691034},
];

function ema(rows, period) {
  const output = new Array(rows.length).fill(null);
  const alpha = 2 / (period + 1);
  let value = rows[0]?.c;
  for (let i = 0; i < rows.length; i++) {
    value = i ? rows[i].c * alpha + value * (1 - alpha) : value;
    if (i >= period - 1) output[i] = value;
  }
  return output;
}

function atr(rows, period = 14) {
  const output = new Array(rows.length).fill(null);
  let value = 0;
  for (let i = 0; i < rows.length; i++) {
    const tr = i
      ? Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - rows[i - 1].c), Math.abs(rows[i].l - rows[i - 1].c))
      : rows[i].h - rows[i].l;
    if (i < period) {
      value += tr;
      if (i === period - 1) output[i] = value / period;
    } else {
      value = (value * (period - 1) + tr) / period;
      output[i] = value;
    }
  }
  return output;
}

function rsi(rows, period = 14) {
  const output = new Array(rows.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < rows.length; i++) {
    const delta = rows[i].c - rows[i - 1].c;
    const up = Math.max(delta, 0);
    const down = Math.max(-delta, 0);
    if (i <= period) {
      gain += up;
      loss += down;
      if (i === period) {
        gain /= period;
        loss /= period;
        output[i] = 100 - 100 / (1 + gain / (loss || 1e-12));
      }
    } else {
      gain = (gain * (period - 1) + up) / period;
      loss = (loss * (period - 1) + down) / period;
      output[i] = 100 - 100 / (1 + gain / (loss || 1e-12));
    }
  }
  return output;
}

function adx(rows, period = 14) {
  const n = rows.length;
  const tr = new Array(n).fill(0);
  const plus = new Array(n).fill(0);
  const minus = new Array(n).fill(0);
  const dx = new Array(n).fill(null);
  const output = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - rows[i - 1].c), Math.abs(rows[i].l - rows[i - 1].c));
    const up = rows[i].h - rows[i - 1].h;
    const down = rows[i - 1].l - rows[i].l;
    plus[i] = up > down && up > 0 ? up : 0;
    minus[i] = down > up && down > 0 ? down : 0;
  }
  let smoothedTr = 0;
  let smoothedPlus = 0;
  let smoothedMinus = 0;
  for (let i = 1; i < n; i++) {
    if (i <= period) {
      smoothedTr += tr[i];
      smoothedPlus += plus[i];
      smoothedMinus += minus[i];
    } else {
      smoothedTr = smoothedTr - smoothedTr / period + tr[i];
      smoothedPlus = smoothedPlus - smoothedPlus / period + plus[i];
      smoothedMinus = smoothedMinus - smoothedMinus / period + minus[i];
    }
    if (i >= period) {
      const positive = 100 * smoothedPlus / (smoothedTr || 1);
      const negative = 100 * smoothedMinus / (smoothedTr || 1);
      dx[i] = 100 * Math.abs(positive - negative) / (positive + negative || 1);
    }
    if (i === 2 * period - 1) {
      output[i] = dx.slice(period, i + 1).reduce((sum, value) => sum + (value || 0), 0) / period;
    } else if (i >= 2 * period) {
      output[i] = (output[i - 1] * (period - 1) + dx[i]) / period;
    }
  }
  return output;
}

function edgeScore(estimate) {
  return estimate.lcb90 + 0.1 * estimate.mean;
}

export function klineToBar(row) {
  return {t: +row[0], o: +row[1], h: +row[2], l: +row[3], c: +row[4], q: +row[7], closeTime: +row[6]};
}

export function completedBars(rows, now) {
  return rows.map(klineToBar).filter(row => row.closeTime < now);
}

export function roundToTick(value, tick) {
  if (!(tick > 0)) return value;
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)));
  return +((Math.round(value / tick) * tick).toFixed(decimals));
}

export function buildMarketContext(btcDaily, coreDaily) {
  if (btcDaily.length < 201) throw new Error('BTCUSDT requires at least 201 completed daily bars');
  const e50 = ema(btcDaily, 50);
  const e200 = ema(btcDaily, 200);
  const i = btcDaily.length - 1;
  const close = btcDaily[i].c;
  const btcRouter = close > e200[i] && e50[i] > e50[i - 5] ? 'bull'
    : close < e200[i] && e50[i] < e50[i - 5] ? 'bear' : 'neutral';
  const btcRouterStrength = close / e200[i] - 1 + e50[i] / e50[i - 5] - 1;
  const high365 = Math.max(...btcDaily.slice(Math.max(0, i - 364)).map(bar => bar.h));
  const btcDrawdown365 = close / high365 - 1;
  const btcEma200Slope20 = e200[i] / e200[i - 20] - 1;
  let btcBearAgeDays = 0;
  for (let j = i; j >= 5; j--) {
    if (btcDaily[j].c < e200[j] && e50[j] < e50[j - 5]) btcBearAgeDays++;
    else break;
  }

  let currentN = 0;
  let currentAbove = 0;
  let priorN = 0;
  let priorAbove = 0;
  for (const daily of coreDaily) {
    if (daily.length < 56) continue;
    const values = ema(daily, 50);
    const j = daily.length - 1;
    if (values[j] != null) {
      currentN++;
      if (daily[j].c > values[j]) currentAbove++;
    }
    if (values[j - 5] != null) {
      priorN++;
      if (daily[j - 5].c > values[j - 5]) priorAbove++;
    }
  }
  const breadthAbove50 = currentN ? currentAbove / currentN : 0.5;
  const priorBreadth = priorN ? priorAbove / priorN : breadthAbove50;
  return {
    btcRouter,
    btcRouterStrength,
    btcDrawdown365,
    btcEma200Slope20,
    btcBearAgeDays,
    breadthAbove50,
    breadthMomentum5d: breadthAbove50 - priorBreadth,
    coreMarkets: currentN,
  };
}

function fundingState(events, signalTime) {
  const prior = events.filter(event => event.t < signalTime);
  if (prior.length < 22) return null;
  const current = prior.at(-1);
  const window = prior.slice(-22, -1).map(event => event.rate);
  const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
  const deviation = Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length);
  return {rate: current.rate, z: deviation > 1e-12 ? (current.rate - mean) / deviation : 0};
}

function sharedFeatures(context, funding, signalTime) {
  const state = fundingState(funding, signalTime);
  if (!state) return null;
  return {
    currentFundingRate: state.rate,
    fundingZ: state.z,
    breadthAbove50: context.breadthAbove50,
    breadthMomentum5d: context.breadthMomentum5d,
    btcRouter: context.btcRouter,
    btcRouterStrength: context.btcRouterStrength,
    btcDrawdown365: context.btcDrawdown365,
    btcEma200Slope20: context.btcEma200Slope20,
    btcBearAgeDays: context.btcBearAgeDays,
  };
}

function selectShortTarget(candidate) {
  const matches = SHORT_SEGMENTS.filter(segment => segment.family === candidate.family
    && Number.isFinite(candidate[segment.feature])
    && candidate[segment.feature] >= segment.min
    && candidate[segment.feature] < segment.max)
    .sort((a, b) => b.lcb90 - a.lcb90 || b.mean - a.mean);
  if (!matches.length) return null;
  const best = matches[0];
  return {
    ...candidate,
    targetR: best.targetR,
    edgeScore: edgeScore(best),
    edgeSegment: best.id,
    target: candidate.entry - best.targetR * (candidate.sl - candidate.entry),
  };
}

function dailyLongCandidates({market, daily, funding, context}) {
  if (daily.length < 201) return [];
  const i = daily.length - 1;
  const bar = daily[i];
  const signalTime = bar.closeTime + 1;
  const e50 = ema(daily, 50);
  const e200 = ema(daily, 200);
  const valuesAtr = atr(daily);
  const valuesAdx = adx(daily);
  if (valuesAtr[i] == null || valuesAdx[i] == null) return [];
  const averageVolume30 = daily.slice(i - 29, i + 1).reduce((sum, item) => sum + item.q, 0) / 30;
  if (bar.q < 20_000_000 || signalTime < market.onboardDate + 180 * DAY || averageVolume30 < 20_000_000) return [];
  const features = sharedFeatures(context, funding, signalTime);
  if (!features || e50[i] <= e200[i] || bar.c <= e50[i] || valuesAdx[i] < 18
    || features.btcRouter !== 'bull' || features.breadthAbove50 < 0.55 || features.fundingZ >= 1.5) return [];
  const sl = Math.min(...daily.slice(i - 4, i + 1).map(item => item.l)) - 0.5 * valuesAtr[i];
  const stopPct = Math.abs(bar.c - sl) / bar.c;
  if (stopPct < 0.02 || stopPct > 0.12) return [];
  const sleeve = LONG_SLEEVES[market.core ? 'core' : 'expanded'];
  const output = [];
  for (const lookback of [5, 10, 20]) {
    if (bar.c <= Math.max(...daily.slice(i - lookback, i).map(item => item.h))) continue;
    output.push({
      signalId: `${market.marketId}|v39_${lookback}d|long|${signalTime}`,
      signalTime,
      marketId: market.marketId,
      symbol: market.baseAsset,
      side: 'long',
      family: 'dailyBreakout',
      route: 'extended_cycle_regime_breakout',
      edgeSegment: `long-dailyBreakout-2R-${market.core ? 'core' : 'expanded'}`,
      entry: bar.c,
      sl,
      target: bar.c + sleeve.targetR * (bar.c - sl),
      targetR: sleeve.targetR,
      stopPct,
      edgeScore: edgeScore(sleeve),
      eventScore: 100 * Math.abs(bar.c / daily[i - lookback].c - 1),
      dayVolume: bar.q,
      features: {...features, breakoutLookback: lookback},
    });
  }
  return output;
}

function fundingCrowdingShort({market, bars, funding, context}) {
  if (bars.length < 201) return null;
  const i = bars.length - 1;
  const valuesAtr = atr(bars);
  const valuesAdx = adx(bars);
  const valuesRsi = rsi(bars);
  if (valuesAtr[i] == null || valuesAdx[i] == null || valuesRsi[i] == null || valuesRsi[i - 1] == null) return null;
  const signalTime = bars[i].closeTime + 1;
  const dayVolume = bars.slice(i - 5, i + 1).reduce((sum, item) => sum + item.q, 0);
  if (dayVolume < 20_000_000 || valuesAdx[i] > 30) return null;
  const features = sharedFeatures(context, funding, signalTime);
  const bar = bars[i];
  if (!features || features.currentFundingRate <= 0 || features.fundingZ < 2
    || valuesRsi[i - 1] < 65 || valuesRsi[i] >= valuesRsi[i - 1] || bar.c >= bar.o) return null;
  const sl = Math.max(...bars.slice(i - 4, i + 1).map(item => item.h)) + 0.5 * valuesAtr[i];
  const stopPct = Math.abs(bar.c - sl) / bar.c;
  if (stopPct < 0.02 || stopPct > 0.08) return null;
  return selectShortTarget({
    signalId: `${market.marketId}|v54_funding_crowding_reversal|short|${signalTime}`,
    signalTime,
    marketId: market.marketId,
    symbol: market.baseAsset,
    side: 'short',
    family: 'fundingCrowdingReversal',
    route: 'funding_crowding_reversal',
    entry: bar.c,
    sl,
    stopPct,
    dayVolume,
    eventScore: Math.abs(features.fundingZ),
    ...features,
    features: {...features},
  });
}

function volumeShockShort({market, bars, funding, context}) {
  if (bars.length < 201) return null;
  const i = bars.length - 1;
  const valuesAtr = atr(bars);
  if (valuesAtr[i] == null) return null;
  const prior = bars.slice(i - 20, i);
  const bar = bars[i];
  const averageVolume = prior.reduce((sum, item) => sum + item.q, 0) / prior.length;
  const volumeRatio = averageVolume > 0 ? bar.q / averageVolume : 0;
  const trueRange = Math.max(bar.h - bar.l, Math.abs(bar.h - bars[i - 1].c), Math.abs(bar.l - bars[i - 1].c));
  const rangeRatio = trueRange / valuesAtr[i];
  const dayVolume = bars.slice(i - 5, i + 1).reduce((sum, item) => sum + item.q, 0);
  if (volumeRatio < 3 || rangeRatio < 2 || dayVolume < 20_000_000 || bar.h <= bar.l) return null;
  const signalTime = bar.closeTime + 1;
  const features = sharedFeatures(context, funding, signalTime);
  if (!features || features.fundingZ < 0) return null;
  const priorHigh = Math.max(...prior.map(item => item.h));
  const wickShare = (bar.h - Math.max(bar.o, bar.c)) / (bar.h - bar.l);
  if (bar.h <= priorHigh || bar.c >= priorHigh || bar.c >= bar.o || wickShare < 0.5) return null;
  const sl = bar.h + 0.25 * valuesAtr[i];
  const stopPct = Math.abs(bar.c - sl) / bar.c;
  if (stopPct < 0.02 || stopPct > 0.10) return null;
  return selectShortTarget({
    signalId: `${market.marketId}|v59_volume_shock_reversal|short|${signalTime}`,
    signalTime,
    marketId: market.marketId,
    symbol: market.baseAsset,
    side: 'short',
    family: 'volumeShockReversal',
    route: 'volume_shock_reversal',
    entry: bar.c,
    sl,
    stopPct,
    dayVolume,
    eventScore: volumeRatio * rangeRatio * wickShare,
    volumeRatio,
    rangeRatio,
    wickShare,
    ...features,
    features: {...features, volumeRatio, rangeRatio, wickShare},
  });
}

export function generateCandidates({market, daily, bars4h, funding, context}) {
  const output = dailyLongCandidates({market, daily, funding, context});
  if (!market.core) {
    const fundingShort = fundingCrowdingShort({market, bars: bars4h, funding, context});
    const shockShort = volumeShockShort({market, bars: bars4h, funding, context});
    if (fundingShort) output.push(fundingShort);
    if (shockShort) output.push(shockShort);
  }
  return output.map(candidate => ({
    ...candidate,
    entry: roundToTick(candidate.entry, market.tickSize),
    stop: roundToTick(candidate.sl, market.tickSize),
    target: roundToTick(candidate.target, market.tickSize),
  }));
}

export function firstTouch(position, bars) {
  for (const bar of bars) {
    const stopHit = position.side === 'long' ? bar.l <= +position.stop : bar.h >= +position.stop;
    const targetHit = position.side === 'long' ? bar.h >= +position.target : bar.l <= +position.target;
    if (stopHit) return {reason: 'sl', price: +position.stop, time: bar.t + 60_000, ambiguous: targetHit};
    if (targetHit) return {reason: 'tp', price: +position.target, time: bar.t + 60_000, ambiguous: false};
  }
  return null;
}

export function rankCandidates(candidates, cap = 3) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.signal_time}|${candidate.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  return [...groups.values()].flatMap(group => group.sort((a, b) => +b.edge_score - +a.edge_score
    || +b.event_score - +a.event_score || +b.day_volume - +a.day_volume).slice(0, cap))
    .sort((a, b) => Date.parse(a.signal_time) - Date.parse(b.signal_time)
      || +b.edge_score - +a.edge_score || +b.event_score - +a.event_score);
}

export {DAY, H4};
