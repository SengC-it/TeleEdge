import {H1, H4} from '../config.mjs';
import {prepareFeatureSeries} from '../v81/features.mjs';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function mean(values) {
  const rows = (values || []).map(Number).filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function standardDeviation(values) {
  const rows = (values || []).map(Number).filter(Number.isFinite);
  if (rows.length < 2) return null;
  const average = mean(rows);
  return Math.sqrt(rows.reduce((sum, value) => sum + (value - average) ** 2, 0) / (rows.length - 1));
}

export function parseEnhancedKlineRow(row) {
  if (Array.isArray(row)) {
    const [t, o, h, l, c, v, closeTime, q, trades, takerBuyBase, takerBuyQuote] = row;
    return {
      t: finite(t), o: finite(o), h: finite(h), l: finite(l), c: finite(c),
      v: finite(v), closeTime: finite(closeTime), q: finite(q), trades: finite(trades),
      takerBuyBase: finite(takerBuyBase), takerBuyQuote: finite(takerBuyQuote),
    };
  }
  const source = row || {};
  return {
    t: finite(source.t ?? source.openTime ?? source.open_time),
    o: finite(source.o ?? source.open ?? source.openPrice),
    h: finite(source.h ?? source.high ?? source.highPrice),
    l: finite(source.l ?? source.low ?? source.lowPrice),
    c: finite(source.c ?? source.close ?? source.closePrice),
    v: finite(source.v ?? source.volume),
    closeTime: finite(source.closeTime ?? source.close_time),
    q: finite(source.q ?? source.quoteVolume ?? source.quote_asset_volume),
    trades: finite(source.trades ?? source.numberOfTrades ?? source.number_of_trades),
    takerBuyBase: finite(source.takerBuyBase ?? source.taker_buy_base_asset_volume),
    takerBuyQuote: finite(source.takerBuyQuote ?? source.taker_buy_quote_asset_volume),
  };
}

function validKline(row) {
  return Number.isFinite(row.t) && row.t >= 0 && row.o > 0 && row.h > 0 && row.l > 0 && row.c > 0;
}

export function parseEnhancedKlineCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const header = lines[0]?.toLowerCase() || '';
  const hasHeader = header.includes('open_time') || header.includes('open time') || header.includes('openprice');
  const rows = lines.slice(hasHeader ? 1 : 0).map(line => line.split(',').map(value => value.trim()))
    .map(parseEnhancedKlineRow).filter(validKline);
  const byTime = new Map(rows.map(row => [row.t, row]));
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function numericSeries(rows, key) {
  return (rows || []).map(row => ({t: finite(row.t), value: finite(row[key] ?? row.value ?? row.c)}))
    .filter(row => row.t != null && row.value != null)
    .sort((a, b) => a.t - b.t);
}

function lowerBound(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].t) < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].t) <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function valueAtOrBefore(rows, timestamp) {
  const index = upperBound(rows || [], timestamp) - 1;
  return index >= 0 ? rows[index].value : null;
}

function previousValue(rows, timestamp) {
  const index = lowerBound(rows || [], timestamp) - 1;
  return index >= 0 ? rows[index].value : null;
}

export function rollingZ(value, priorValues, minimum = 8) {
  const current = finite(value);
  const prior = (priorValues || []).map(Number).filter(Number.isFinite);
  if (current == null || prior.length < minimum) return null;
  const average = mean(prior);
  const deviation = standardDeviation(prior);
  return deviation > 1e-12 ? (current - average) / deviation : 0;
}

function floorH4(timestamp) {
  return Math.floor(Number(timestamp) / H4) * H4;
}

export function aggregateEnhancedBars(rows, endTime = Infinity) {
  const groups = new Map();
  for (const raw of rows || []) {
    const row = parseEnhancedKlineRow(raw);
    if (!validKline(row)) continue;
    const start = floorH4(row.t);
    if (!groups.has(start)) groups.set(start, new Map());
    groups.get(start).set(row.t, row);
  }
  const output = [];
  for (const [start, byTime] of [...groups].sort(([a], [b]) => a - b)) {
    const hourly = [];
    for (let offset = 0; offset < 4; offset++) {
      const row = byTime.get(start + offset * H1);
      if (!row) break;
      hourly.push(row);
    }
    if (hourly.length !== 4 || start + H4 > Number(endTime)) continue;
    const quoteVolume = hourly.reduce((sum, row) => sum + (Number(row.q) || 0), 0);
    const buyQuote = hourly.reduce((sum, row) => sum + (Number(row.takerBuyQuote) || 0), 0);
    const volume = hourly.reduce((sum, row) => sum + (Number(row.v) || 0), 0);
    const buyBase = hourly.reduce((sum, row) => sum + (Number(row.takerBuyBase) || 0), 0);
    output.push({
      t: start, o: hourly[0].o, h: Math.max(...hourly.map(row => row.h)),
      l: Math.min(...hourly.map(row => row.l)), c: hourly[3].c,
      q: quoteVolume, v: volume, trades: hourly.reduce((sum, row) => sum + (Number(row.trades) || 0), 0),
      takerBuyBase: buyBase, takerBuyQuote: buyQuote,
      takerSellBase: Math.max(0, volume - buyBase),
      takerSellQuote: Math.max(0, quoteVolume - buyQuote),
      aggressiveVolume: quoteVolume > 0 ? (2 * buyQuote - quoteVolume) / quoteVolume : null,
    });
  }
  return output;
}

function baseBars(rows) {
  return rows.map(row => ({t: row.t, o: row.o, h: row.h, l: row.l, c: row.c, q: row.q}));
}

function priorValues(rows, index, key, limit = 24) {
  return rows.slice(Math.max(0, index - limit), index).map(row => row[key]).filter(value => finite(value) != null);
}

function priorOptionalValues(rows, timestamp, limit = 24) {
  const end = lowerBound(rows || [], timestamp);
  return (rows || []).slice(Math.max(0, end - limit), end);
}

function normalizeOptionalRows(rows, key) {
  return numericSeries(rows || [], key).filter(row => row.value != null);
}

function buildDerivativePoint(enhanced, index, signalTime, optional) {
  const takerBuyQuote = finite(enhanced.takerBuyQuote);
  const takerSellQuote = finite(enhanced.takerSellQuote);
  const quoteVolume = finite(enhanced.q);
  const takerBuyRatio = quoteVolume > 0 && takerBuyQuote != null ? takerBuyQuote / quoteVolume : null;
  const takerSellRatio = quoteVolume > 0 && takerSellQuote != null ? takerSellQuote / quoteVolume : null;
  const takerImbalance = takerBuyRatio != null && takerSellRatio != null ? takerBuyRatio - takerSellRatio : null;
  const aggressiveVolume = quoteVolume > 0 && takerImbalance != null ? takerImbalance * quoteVolume : null;
  const premium = valueAtOrBefore(optional.premium, signalTime);
  const previousPremium = previousValue(optional.premium, signalTime);
  const mark = valueAtOrBefore(optional.mark, signalTime);
  const indexPrice = valueAtOrBefore(optional.index, signalTime);
  const premiumPrior = priorOptionalValues(optional.premium, signalTime);
  const openInterest = valueAtOrBefore(optional.openInterest, signalTime);
  const previousOpenInterest = previousValue(optional.openInterest, signalTime);
  const oiPrior = priorOptionalValues(optional.openInterest, signalTime);
  const oiChangePrior = oiPrior.slice(1).map((row, rowIndex) => {
    const previous = oiPrior[rowIndex].value;
    return previous > 0 ? row.value / previous - 1 : null;
  }).filter(value => value != null);
  const premiumChange = premium != null && previousPremium != null ? premium - previousPremium : null;
  const oiChange = openInterest != null && previousOpenInterest > 0 ? openInterest / previousOpenInterest - 1 : null;
  const markIndexSpread = mark > 0 && indexPrice > 0 ? mark / indexPrice - 1 : null;
  return {
    takerBuyRatio, takerSellRatio, takerImbalance, aggressiveVolume,
    aggressiveVolumeZ: rollingZ(aggressiveVolume, priorValues(optional.enhanced, index, 'aggressiveVolume')),
    premiumIndex: premium,
    premiumZ: rollingZ(premium, premiumPrior.map(row => row.value)),
    premiumChange, markPrice: mark, indexPrice, markIndexSpread,
    openInterest, oiChange, oiZ: rollingZ(oiChange, oiChangePrior),
    oiHistoryAvailable: openInterest != null && oiPrior.length >= 8,
    premiumHistoryAvailable: premium != null && premiumPrior.length >= 8,
    markIndexHistoryAvailable: mark != null && indexPrice != null,
  };
}

export function buildV9FeatureSeries(rows, {
  funding = [], btcSeries = null, openInterest = [], premium = [], mark = [], index = [], endTime = Infinity,
} = {}) {
  const enhancedBars = aggregateEnhancedBars(rows, endTime);
  const optional = {
    enhanced: enhancedBars,
    openInterest: normalizeOptionalRows(openInterest, 'openInterest'),
    premium: normalizeOptionalRows(premium, 'premiumIndex'),
    mark: normalizeOptionalRows(mark, 'markPrice'),
    index: normalizeOptionalRows(index, 'indexPrice'),
  };
  const base = prepareFeatureSeries(baseBars(enhancedBars), {funding, btcSeries});
  const points = base.points.map((point, indexInSeries) => ({
    ...point,
    ...buildDerivativePoint(enhancedBars[indexInSeries], indexInSeries, point.signalTime, optional),
    fundingChange: point.fundingZ != null && point.previousFundingZ != null ? point.fundingZ - point.previousFundingZ : null,
    fundingHistoryAvailable: (funding || []).length >= 8,
    quoteVolume: enhancedBars[indexInSeries].q,
    trades: enhancedBars[indexInSeries].trades,
  }));
  for (const point of points) delete point.priorBar;
  return {
    bars: enhancedBars,
    points,
    dataAvailability: {
      takerBuyVolume: enhancedBars.some(row => row.takerBuyQuote != null),
      openInterest: optional.openInterest.length > 0,
      premiumIndex: optional.premium.length > 0,
      markPrice: optional.mark.length > 0,
      indexPrice: optional.index.length > 0,
      funding: (funding || []).length > 0,
    },
  };
}

function rankValue(value) {
  return finite(value);
}

function crossSectionalRank(rows, field, descending = true) {
  const usable = rows.filter(row => rankValue(row.point[field]) != null)
    .sort((left, right) => (descending ? rankValue(right.point[field]) - rankValue(left.point[field]) : rankValue(left.point[field]) - rankValue(right.point[field]))
      || left.symbol.localeCompare(right.symbol));
  const ranks = new Map();
  usable.forEach((row, index) => ranks.set(row.symbol, usable.length <= 1 ? 1 : 1 - index / (usable.length - 1)));
  return ranks;
}

export function assignCrossSectionalRanks(pointsBySymbol) {
  const source = pointsBySymbol instanceof Map ? [...pointsBySymbol.entries()] : Object.entries(pointsBySymbol || {});
  const byTime = new Map();
  for (const [symbol, points] of source) {
    for (const point of points || []) {
      if (!byTime.has(point.signalTime)) byTime.set(point.signalTime, []);
      byTime.get(point.signalTime).push({symbol, point});
    }
  }
  const output = new Map(source.map(([symbol, points]) => [symbol, points || []]));
  for (const rows of byTime.values()) {
    const returnRanks = crossSectionalRank(rows, 'return12', true);
    const flowRanks = crossSectionalRank(rows, 'takerImbalance', true);
    for (const {symbol, point} of rows) {
      point.crossSectionalReturnRank = returnRanks.get(symbol) ?? null;
      point.crossSectionalFlowRank = flowRanks.get(symbol) ?? null;
    }
  }
  for (const points of output.values()) points.sort((a, b) => Number(a.signalTime) - Number(b.signalTime));
  return output;
}
