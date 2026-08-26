import {H4} from '../config.mjs';
import {adx, aggregate, atr, ema, rsi} from '../indicators.mjs';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function mean(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function previousIndex(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].signalTime ?? rows[middle].t) <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function fundingAt(events, timestamp) {
  const rows = events || [];
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].t) <= timestamp) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  if (index < 0) return {rate: 0, z: 0, valid: false};
  const current = Number(rows[index].rate);
  const prior = rows.slice(Math.max(0, index - 22), index).map(row => Number(row.rate)).filter(Number.isFinite);
  if (prior.length < 8 || !Number.isFinite(current)) return {rate: current || 0, z: 0, valid: false};
  const baseline = mean(prior) ?? 0;
  const deviation = Math.sqrt(mean(prior.map(value => (value - baseline) ** 2)) || 0);
  return {rate: current, z: deviation > 1e-12 ? (current - baseline) / deviation : 0, valid: true};
}

function btcAt(series, timestamp) {
  if (!series?.points?.length) return {regime: 'sideways', return12: 0, strength: 0};
  const index = previousIndex(series.points, timestamp);
  if (index < 0) return {regime: 'sideways', return12: 0, strength: 0};
  const point = series.points[index];
  return {
    regime: point.regime,
    return12: Number(point.return12) || 0,
    strength: Number(point.close - point.ema200) / (Number(point.atr) || Math.max(Number(point.close), 1)),
  };
}

export function fourHourBars(rows, endTime = Infinity) {
  return aggregate((rows || []).map(row => ({
    t: Number(row.t), o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c), q: Number(row.q || 0),
  })).filter(row => Number.isFinite(row.t)).sort((a, b) => a.t - b.t), H4, endTime);
}

export function prepareFeatureSeries(rows, {funding = [], btcSeries = null} = {}) {
  const bars = rows || [];
  const ema20 = ema(bars, 20);
  const ema50 = ema(bars, 50);
  const ema200 = ema(bars, 200);
  const valuesAtr = atr(bars, 14);
  const valuesAdx = adx(bars, 14);
  const valuesRsi = rsi(bars, 14);
  const points = bars.map((bar, index) => {
    const signalTime = bar.t + H4;
    const prior = bars.slice(Math.max(0, index - 20), index);
    const prior4 = bars.slice(Math.max(0, index - 4), index);
    const atrValue = finite(valuesAtr[index]);
    const fast = finite(ema20[index]);
    const slow = finite(ema50[index]);
    const longTrend = finite(ema200[index]);
    const previousFast = finite(ema20[index - 3]);
    const priorHigh20 = prior.length ? Math.max(...prior.map(item => item.h)) : null;
    const priorLow20 = prior.length ? Math.min(...prior.map(item => item.l)) : null;
    const averageVolume = mean(prior.map(item => item.q));
    const volumeRatio = averageVolume > 0 ? bar.q / averageVolume : null;
    const rangeRatio = atrValue > 0 ? (bar.h - bar.l) / atrValue : null;
    const distanceEmaAtr = atrValue > 0 && fast != null ? (bar.c - fast) / atrValue : null;
    const regime = longTrend == null || slow == null || previousFast == null ? 'sideways'
      : bar.c > longTrend && slow > longTrend && slow > (finite(ema50[index - 3]) ?? slow) ? 'bull'
        : bar.c < longTrend && slow < longTrend && slow < (finite(ema50[index - 3]) ?? slow) ? 'bear' : 'sideways';
    const fundingState = fundingAt(funding, signalTime);
    const previousFundingState = fundingAt(funding, signalTime - H4);
    const btc = btcAt(btcSeries, signalTime);
    const previousBtc = btcAt(btcSeries, signalTime - H4);
    const previousClose = Number(bars[index - 1]?.c);
    const return3 = previousClose > 0 && index >= 3 ? bar.c / bars[index - 3].c - 1 : null;
    const return12 = index >= 12 && bars[index - 12].c > 0 ? bar.c / bars[index - 12].c - 1 : null;
    const previousReturn12 = index >= 13 && bars[index - 13].c > 0 ? bars[index - 1].c / bars[index - 13].c - 1 : null;
    const priorBar = bars[index - 1];
    return {
      index, t: bar.t, signalTime, o: bar.o, h: bar.h, l: bar.l, c: bar.c, q: bar.q,
      close: bar.c, ema20: fast, ema50: slow, ema200: longTrend, previousEma20: previousFast,
      atr: atrValue, adx: finite(valuesAdx[index]), rsi: finite(valuesRsi[index]), regime,
      fundingRate: fundingState.rate, fundingZ: fundingState.z, fundingValid: fundingState.valid,
      previousFundingZ: previousFundingState.z,
      btcRegime: btc.regime, btcReturn12: btc.return12, btcStrength: btc.strength,
      return3, return12, previousReturn12, relativeReturn12: (return12 || 0) - btc.return12,
      previousRelativeReturn12: (previousReturn12 || 0) - previousBtc.return12,
      volumeRatio, rangeRatio, distanceEmaAtr,
      priorHigh20, priorLow20, previousClose: Number.isFinite(previousClose) ? previousClose : null,
      priorHigh4: prior4.length ? Math.max(...prior4.map(item => item.h)) : null,
      priorLow4: prior4.length ? Math.min(...prior4.map(item => item.l)) : null,
      breakoutUp: priorHigh20 != null && bar.c > priorHigh20,
      breakoutDown: priorLow20 != null && bar.c < priorLow20,
      failedBreakoutUp: priorHigh20 != null && bar.h > priorHigh20 && bar.c <= priorHigh20,
      failedBreakoutDown: priorLow20 != null && bar.l < priorLow20 && bar.c >= priorLow20,
      pullbackLong: fast != null && bar.l <= fast && bar.c > fast && bar.c > bar.o,
      pullbackShort: fast != null && bar.h >= fast && bar.c < fast && bar.c < bar.o,
      turnLong: Number.isFinite(previousClose) && bar.c > previousClose,
      turnShort: Number.isFinite(previousClose) && bar.c < previousClose,
      priorBar,
    };
  });
  return {bars, points};
}

export function stopForPoint(point, side) {
  if (!(Number(point.atr) > 0)) return null;
  const stop = side === 'long'
    ? Number(point.priorLow4) - 0.5 * Number(point.atr)
    : Number(point.priorHigh4) + 0.5 * Number(point.atr);
  const stopPct = Number(point.close) > 0 ? Math.abs(stop - point.close) / point.close : null;
  return Number.isFinite(stop) && Number.isFinite(stopPct) ? {stop, stopPct} : null;
}

export function directionalOutcome(bars, signalTime, side) {
  const horizons = {h1: H4 / 4, h4: H4, h12: 3 * H4, h24: 6 * H4, h72: 18 * H4};
  const future = (bars || []).filter(row => Number(row.t) >= signalTime);
  const entry = Number(future[0]?.o ?? future[0]?.c);
  if (!(entry > 0)) return {};
  const direction = side === 'long' ? 1 : -1;
  const output = {};
  for (const [key, horizon] of Object.entries(horizons)) {
    const row = future.find(item => item.t >= signalTime + horizon);
    output[`return${key}`] = row?.c > 0 ? direction * (row.c / entry - 1) : null;
  }
  const window = future.filter(row => row.t < signalTime + 18 * H4);
  output.mfe = window.length ? Math.max(...window.map(row => direction === 1 ? row.h / entry - 1 : 1 - row.l / entry)) : null;
  output.mae = window.length ? Math.min(...window.map(row => direction === 1 ? row.l / entry - 1 : 1 - row.h / entry)) : null;
  return output;
}
