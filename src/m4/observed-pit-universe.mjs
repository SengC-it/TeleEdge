import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {CORE_MARKETS, DAY, H1, H4} from '../config.mjs';

export const OBSERVED_PIT_DEVELOPMENT_START = Date.parse('2024-01-01T00:00:00.000Z');
export const OBSERVED_PIT_DEVELOPMENT_END = Date.parse('2026-01-01T00:00:00.000Z');
export const OBSERVED_PIT_WARMUP_MS = 30 * DAY;
export const OBSERVED_PIT_HISTORY_HOURS = 30 * 24;
export const OBSERVED_PIT_LIQUIDITY_THRESHOLD_USDT = 20_000_000;
export const OBSERVED_PIT_SNAPSHOT_INTERVAL_MS = H4;
export const OBSERVED_STATUS_BITS = Object.freeze({archiveObserved: 1, historyReady: 2, liquidityReady: 4, featureReady: 8, finalEligible: 16, dataLoss: 32, futureListed: 64, postDelist: 128});

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function iso(value) {
  return value == null ? null : new Date(Number(value)).toISOString();
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function standardDeviation(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  if (usable.length < 2) return null;
  const average = mean(usable);
  return Math.sqrt(usable.reduce((sum, value) => sum + (value - average) ** 2, 0) / (usable.length - 1));
}

function rollingZScore(value, history, minimumHistory = 8) {
  const current = finite(value);
  const prior = history.map(Number).filter(Number.isFinite).slice(-30);
  if (current == null || prior.length < minimumHistory) return null;
  const deviation = standardDeviation(prior);
  return deviation != null && deviation > 1e-12 ? (current - mean(prior)) / deviation : 0;
}

function dataLossReason({archiveObserved, historyReady, liquidityReady, featureReady, dataLoss}) {
  if (!dataLoss) return null;
  if (!archiveObserved) return 'missing-or-incomplete-price-artifact';
  if (!historyReady) return 'local-1h-gap';
  if (!liquidityReady) return 'liquidity-data-unresolved';
  if (!featureReady) return 'required-feature-unavailable';
  return 'data-quality-unresolved';
}

function derivativeReady(point) {
  if (!point || point.fundingValid === false) return false;
  return [point.fundingZ, point.premiumZ, point.oiZ].filter(value => finite(value) != null).length >= 2;
}

function monthKey(timestamp) {
  const date = new Date(Number(timestamp));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function lowerBound(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].t) < Number(timestamp)) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function sha256File(file) {
  if (!file || !fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function artifactFile(dataRoot, kind, symbol) {
  return path.join(dataRoot, kind, `${symbol}.json.gz`);
}

export function readGzipJson(file) {
  if (!file || !fs.existsSync(file)) return [];
  const compressed = fs.readFileSync(file);
  if (!compressed.length) return [];
  const text = zlib.gunzipSync(compressed).toString('utf8').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

function rawKline(row) {
  if (Array.isArray(row)) {
    return {
      t: finite(row[0]), o: finite(row[1]), h: finite(row[2]), l: finite(row[3]),
      c: finite(row[4]), q: finite(row[7] ?? row[5]),
    };
  }
  const source = row || {};
  return {
    t: finite(source.t ?? source.openTime ?? source.open_time),
    o: finite(source.o ?? source.open ?? source.openPrice),
    h: finite(source.h ?? source.high ?? source.highPrice),
    l: finite(source.l ?? source.low ?? source.lowPrice),
    c: finite(source.c ?? source.close ?? source.closePrice),
    q: finite(source.q ?? source.quoteVolume ?? source.quote_asset_volume),
  };
}

export function normalizeHourlyRows(input) {
  const byTime = new Map();
  let invalidRows = 0;
  let duplicateRows = 0;
  for (const source of input || []) {
    const row = rawKline(source);
    if (row.t == null || row.t < 0 || !(row.o > 0) || !(row.h > 0) || !(row.l > 0) || !(row.c > 0)) {
      invalidRows++;
      continue;
    }
    if (byTime.has(row.t)) duplicateRows++;
    byTime.set(row.t, row);
  }
  const rows = [...byTime.values()].sort((left, right) => left.t - right.t);
  return {rows, invalidRows, duplicateRows};
}

function contiguousEpisodes(rows, interval = H1) {
  const episodes = [];
  if (!rows.length) return episodes;
  let start = 0;
  for (let index = 1; index <= rows.length; index++) {
    if (index < rows.length && rows[index].t - rows[index - 1].t === interval) continue;
    const first = rows[start];
    const last = rows[index - 1];
    episodes.push({
      episode: episodes.length + 1,
      observedStart: first.t,
      observedEnd: last.t + interval,
      eligibleStart: first.t + OBSERVED_PIT_WARMUP_MS,
      eligibleEnd: last.t + interval,
      rows: index - start,
    });
    start = index;
  }
  return episodes;
}

function artifactSummary({meta = null, file = null, rows = [], invalidRows = 0, duplicateRows = 0, interval = H1} = {}) {
  const gaps = [];
  for (let index = 1; index < rows.length; index++) {
    const delta = rows[index].t - rows[index - 1].t;
    if (delta !== interval) gaps.push({from: rows[index - 1].t + interval, to: rows[index].t, missingRows: Math.max(0, Math.round(delta / interval) - 1)});
  }
  const actualHash = sha256File(file);
  return {
    present: Boolean(file && fs.existsSync(file)),
    nonEmpty: rows.length > 0,
    rows: rows.length,
    sha256: actualHash,
    expectedSha256: meta?.sha256 || null,
    hashVerified: actualHash != null && meta?.sha256 ? actualHash === meta.sha256 : null,
    firstObserved: iso(rows[0]?.t),
    lastObserved: iso(rows.at(-1)?.t),
    firstTimestamp: rows[0]?.t ?? null,
    lastTimestamp: rows.at(-1)?.t ?? null,
    continuity: gaps.length === 0,
    gaps,
    duplicates: duplicateRows,
    invalidRows,
    interval: meta?.interval || (interval === H1 ? '1h' : null),
    activeStart: meta?.activeStart || null,
    activeEnd: meta?.activeEnd || null,
  };
}

function archiveMonths(keys = []) {
  return [...new Set((keys || []).map(key => String(key).match(/-(\d{4}-\d{2})\.(?:zip|csv|json)(?:\.gz)?$/)?.[1]).filter(Boolean))].sort();
}

function exchangeMap(exchangeInfo) {
  const symbols = Array.isArray(exchangeInfo) ? exchangeInfo : exchangeInfo?.symbols || [];
  return new Map(symbols.filter(row => row?.symbol).map(row => [String(row.symbol), row]));
}

function tradfiLike(row) {
  if (!row) return false;
  const contractType = String(row.contractType || '').toUpperCase();
  const quoteAsset = String(row.quoteAsset || '').toUpperCase();
  const underlyingType = String(row.underlyingType || '').toUpperCase();
  const subtypes = (row.underlyingSubType || []).map(value => String(value).toUpperCase());
  return quoteAsset !== 'USDT'
    || (contractType && contractType !== 'PERPETUAL')
    || ['EQUITY', 'COMMODITY', 'INDEX', 'FIAT'].includes(underlyingType)
    || subtypes.some(value => value.includes('TRADFI') || value.includes('EQUITY') || value.includes('COMMODITY') || value.includes('INDEX'));
}

/**
 * Return true for an archive-union symbol that can be a USD-M USDT
 * perpetual-style crypto market.  Current exchangeInfo is classification-only;
 * it is never used to add or remove an unknown historical archive symbol.
 */
export function isPlainCryptoArchiveSymbol(symbol, exchangeInfo = null) {
  const normalized = String(symbol || '').toUpperCase();
  if (!/^[A-Z0-9]+USDT$/.test(normalized)) return false;
  const row = exchangeInfo instanceof Map ? exchangeInfo.get(normalized) : exchangeMap(exchangeInfo).get(normalized);
  return !tradfiLike(row);
}

export function discoverObservedArchiveUniverse({dataRoot, archiveIndex = null, exchangeInfo = null} = {}) {
  const indexFile = path.join(dataRoot, 'source', 'archive-index.json');
  const index = archiveIndex || (fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {});
  const bySymbol = index.actualArchiveKeysBySymbol || {};
  const exchangeBySymbol = exchangeInfo instanceof Map ? exchangeInfo : exchangeMap(exchangeInfo);
  const archiveSymbols = Object.keys(bySymbol).sort();
  const excludedTradfi = [];
  const entries = [];
  for (const symbol of archiveSymbols) {
    const keys = bySymbol[symbol] || {};
    if (!isPlainCryptoArchiveSymbol(symbol, exchangeBySymbol)) {
      if (/^[A-Z0-9]+USDT$/.test(symbol)) excludedTradfi.push(symbol);
      continue;
    }
    entries.push({
      symbol,
      core: CORE_MARKETS.has(symbol),
      archiveKeys: {klines: [...(keys.klines || [])], funding: [...(keys.funding || [])]},
      actualFirstArchiveMonth: archiveMonths([...(keys.klines || []), ...(keys.funding || [])])[0] || null,
      actualLastArchiveMonth: archiveMonths([...(keys.klines || []), ...(keys.funding || [])]).at(-1) || null,
      source: index.source || 'Binance Data Vision archive index',
    });
  }
  return {
    symbols: entries.map(row => row.symbol),
    entries,
    excludedTradfiSymbols: excludedTradfi.sort(),
    archiveIndexFile: indexFile,
    archiveIndexSha256: sha256File(indexFile),
    exchangeInfoSource: 'current exchangeInfo used only for product classification; archive union is authoritative',
    snapshotEnd: index.snapshotEnd || null,
  };
}

export function buildObservedMarket({symbol, rows = [], rawRows = rows, lifecycleRows = null, artifactRows = null, core = CORE_MARKETS.has(symbol), exchange = null, artifactMeta = {}, priceFile = null, minuteFile = null, fundingFile = null, archiveKeys = {klines: [], funding: []}, invalidRows = 0, duplicateRows = 0} = {}) {
  const normalized = rows.length ? rows : rawRows.length ? normalizeHourlyRows(rawRows).rows : [];
  const completeRows = lifecycleRows || (rawRows === rows ? normalized : normalizeHourlyRows(rawRows).rows);
  const episodes = contiguousEpisodes(completeRows);
  const gapPrefix = new Array(normalized.length).fill(0);
  const volumePrefix = new Array(normalized.length + 1).fill(0);
  let volumeValid = true;
  for (let index = 1; index < normalized.length; index++) {
    gapPrefix[index] = gapPrefix[index - 1] + (normalized[index].t - normalized[index - 1].t === H1 ? 0 : 1);
  }
  for (let index = 0; index < normalized.length; index++) {
    if (normalized[index].q == null) volumeValid = false;
    volumePrefix[index + 1] = volumePrefix[index] + (normalized[index].q == null ? 0 : normalized[index].q);
  }
  const priceMeta = artifactMeta.price || null;
  const price = artifactSummary({meta: priceMeta, file: priceFile, rows: artifactRows || completeRows, invalidRows, duplicateRows});
  const firstObserved = completeRows[0]?.t ?? null;
  const lastObserved = completeRows.at(-1)?.t == null ? null : completeRows.at(-1).t + H1;
  return {
    symbol,
    marketId: symbol,
    core: Boolean(core),
    expanded: !core,
    rows: normalized,
    gapPrefix,
    volumePrefix,
    volumeValid,
    episodes,
    activeEpisodes: episodes,
    activeStart: firstObserved,
    activeEnd: lastObserved,
    eligibleStart: episodes[0]?.eligibleStart ?? null,
    eligibleEnd: lastObserved,
    actualFirstObserved: firstObserved,
    actualLastObserved: completeRows.at(-1)?.t ?? null,
    firstObserved: iso(firstObserved),
    lastObserved: iso(completeRows.at(-1)?.t),
    actualFirstArchiveMonth: archiveMonths([...(archiveKeys.klines || []), ...(archiveKeys.funding || [])])[0] || null,
    actualLastArchiveMonth: archiveMonths([...(archiveKeys.klines || []), ...(archiveKeys.funding || [])]).at(-1) || null,
    listingEvidenceSource: 'observed Data Vision 1h first observation (tradability diagnostic; not an official listing claim)',
    listingEvidenceTimestamp: firstObserved,
    delistEvidenceSource: 'observed Data Vision 1h last observation + 1h (tradability diagnostic; not an official delist claim)',
    delistEvidenceTimestamp: lastObserved,
    lifecycleExact: false,
    observedLifecycle: true,
    historicalObservedEnd: lastObserved,
    relisted: episodes.length > 1,
    exchangeInfo: exchange || null,
    filters: exchange?.filters || [],
    marketFilters: exchange?.filters || [],
    marketFilterSource: exchange?.filters?.length ? 'current exchangeInfo classification/filter metadata; not PIT lifecycle membership' : 'unavailable-for-historical-symbol',
    currentExchangeInfoSymbol: Boolean(exchange),
    priceFile,
    minuteFile,
    fundingFile,
    archiveKeys,
    artifacts: {
      price,
      minute: {present: Boolean(minuteFile && fs.existsSync(minuteFile)), nonEmpty: Boolean(minuteFile && fs.existsSync(minuteFile)), expectedSha256: artifactMeta.minute?.sha256 || null, hashVerified: null, rows: artifactMeta.minute?.rows ?? null, interval: artifactMeta.minute?.interval || '1m'},
      funding: {present: Boolean(fundingFile && fs.existsSync(fundingFile)), nonEmpty: Boolean(fundingFile && fs.existsSync(fundingFile)), expectedSha256: artifactMeta.funding?.sha256 || null, hashVerified: null, rows: artifactMeta.funding?.rows ?? null, interval: artifactMeta.funding?.interval || 'event'},
    },
    dataIntegrity: {
      invalidRows,
      duplicateRows,
      gaps: price.gaps,
      hashVerified: price.hashVerified,
      priceComplete: price.present && price.nonEmpty && price.hashVerified !== false && price.invalidRows === 0,
    },
    featureByTime: null,
  };
}

function featureReady(point, timestamp) {
  if (!point || Number(point.signalTime) !== Number(timestamp)) return false;
  return Number(point.close) > 0
    && Number.isFinite(Number(point.return4 ?? point.return3 ?? point.previousClose))
    && Number(point.atr) > 0
    && Number(point.priorLow4) > 0
    && Number(point.priorHigh4) > 0
    && typeof (point.regime || point.marketRegime) === 'string';
}

function statusBase(symbol, timestamp) {
  return {
    symbol,
    timestamp,
    timestampIso: iso(timestamp),
    archiveObserved: false,
    historyReady: false,
    liquidityReady: false,
    featureReady: false,
    finalEligible: false,
    dataLoss: false,
    rejectionReason: null,
    averageDailyQuoteVolume: null,
    historyKind: 'observed-1h',
  };
}

export function encodeObservedStatus(status = {}) {
  let code = 0;
  if (status.archiveObserved) code |= OBSERVED_STATUS_BITS.archiveObserved;
  if (status.historyReady) code |= OBSERVED_STATUS_BITS.historyReady;
  if (status.liquidityReady) code |= OBSERVED_STATUS_BITS.liquidityReady;
  if (status.featureReady) code |= OBSERVED_STATUS_BITS.featureReady;
  if (status.finalEligible) code |= OBSERVED_STATUS_BITS.finalEligible;
  if (status.dataLoss) code |= OBSERVED_STATUS_BITS.dataLoss;
  if (status.rejectionReason === 'not-listed-yet') code |= OBSERVED_STATUS_BITS.futureListed;
  if (status.rejectionReason === 'not-observed-at-timestamp') code |= OBSERVED_STATUS_BITS.postDelist;
  return code;
}

function decodeObservedStatus(symbol, timestamp, code) {
  const bits = Number(code) || 0;
  const has = name => (bits & OBSERVED_STATUS_BITS[name]) !== 0;
  let rejectionReason = null;
  if (!has('archiveObserved')) rejectionReason = has('futureListed') ? 'not-listed-yet' : has('postDelist') ? 'not-observed-at-timestamp' : 'missing-price-artifact';
  else if (!has('historyReady')) rejectionReason = has('dataLoss') ? 'local-1h-gap' : '30d-warmup-incomplete';
  else if (!has('liquidityReady')) rejectionReason = 'below-30d-volume-threshold';
  else if (!has('featureReady')) rejectionReason = 'required-feature-unavailable';
  return {
    ...statusBase(symbol, timestamp),
    archiveObserved: has('archiveObserved'),
    historyReady: has('historyReady'),
    liquidityReady: has('liquidityReady'),
    featureReady: has('featureReady'),
    finalEligible: has('finalEligible'),
    dataLoss: has('dataLoss'),
    rejectionReason,
  };
}

/**
 * Fast, allocation-free status evaluation for large PIT runs.  It mirrors
 * observedTradabilityAt but returns the compact bit representation used by
 * the observed snapshot adapter.  rowIndex is the already-advanced lower
 * bound when callers scan timestamps in ascending order.
 */
export function observedTradabilityCodeAt(market, timestamp, {featurePoint = null, rowIndex = null, historyHours = OBSERVED_PIT_HISTORY_HOURS, liquidityThresholdUsdt = OBSERVED_PIT_LIQUIDITY_THRESHOLD_USDT} = {}) {
  const t = Number(timestamp);
  const rows = market?.rows || (Array.isArray(market) ? market : []);
  if (!rows.length || market?.dataIntegrity?.priceComplete === false) return OBSERVED_STATUS_BITS.dataLoss;
  const latestExpected = t - H1;
  const endIndex = Number.isInteger(rowIndex) ? rowIndex : lowerBound(rows, latestExpected);
  if (endIndex >= rows.length || Number(rows[endIndex]?.t) !== latestExpected) {
    const hasPrior = endIndex > 0;
    const hasLater = endIndex < rows.length;
    return (hasPrior && hasLater ? OBSERVED_STATUS_BITS.dataLoss : 0)
      | (hasLater ? OBSERVED_STATUS_BITS.futureListed : OBSERVED_STATUS_BITS.postDelist);
  }
  let code = OBSERVED_STATUS_BITS.archiveObserved;
  const firstIndex = endIndex - historyHours + 1;
  const expectedFirst = latestExpected - (historyHours - 1) * H1;
  if (firstIndex < 0) {
    return code | (Number(rows[0]?.t) <= expectedFirst ? OBSERVED_STATUS_BITS.dataLoss : 0);
  }
  if (Number(rows[firstIndex]?.t) !== expectedFirst) return code;
  const gaps = market?.gapPrefix
    ? Number(market.gapPrefix[endIndex] || 0) - Number(market.gapPrefix[firstIndex] || 0)
    : rows.slice(firstIndex + 1, endIndex + 1).some((row, index) => Number(row.t) - Number(rows[firstIndex + index].t) !== H1);
  if (gaps > 0) return code | OBSERVED_STATUS_BITS.dataLoss;
  code |= OBSERVED_STATUS_BITS.historyReady;
  if (!market?.volumeValid && rows.slice(firstIndex, endIndex + 1).some(row => row.q == null)) return code | OBSERVED_STATUS_BITS.dataLoss;
  const volume = market?.volumePrefix
    ? Number(market.volumePrefix[endIndex + 1]) - Number(market.volumePrefix[firstIndex])
    : rows.slice(firstIndex, endIndex + 1).reduce((sum, row) => sum + Number(row.q || 0), 0);
  if (volume / 30 + 1e-6 < Number(liquidityThresholdUsdt)) return code;
  code |= OBSERVED_STATUS_BITS.liquidityReady;
  if (!featureReady(featurePoint, t)) return code | OBSERVED_STATUS_BITS.dataLoss;
  code |= OBSERVED_STATUS_BITS.featureReady | OBSERVED_STATUS_BITS.finalEligible;
  return code;
}

/**
 * Point-in-time membership.  It only indexes rows at or before timestamp and
 * never reads lifecycle, current-status, or future-volume fields.
 */
export function observedTradabilityAt(market, timestamp, {featurePoint = null, historyHours = OBSERVED_PIT_HISTORY_HOURS, liquidityThresholdUsdt = OBSERVED_PIT_LIQUIDITY_THRESHOLD_USDT} = {}) {
  const t = Number(timestamp);
  const result = statusBase(market?.symbol || market?.marketId, t);
  const rows = market?.rows || (Array.isArray(market) ? market : []);
  if (!rows.length || market?.dataIntegrity?.priceComplete === false) {
    result.rejectionReason = !rows.length ? 'missing-price-artifact' : 'price-artifact-invalid';
    result.dataLoss = true;
    return result;
  }
  const latestExpected = t - H1;
  const endIndex = lowerBound(rows, latestExpected);
  if (endIndex >= rows.length || Number(rows[endIndex]?.t) !== latestExpected) {
    // lowerBound already partitions the sorted rows; avoid scanning each
    // symbol's retained history for every 4h snapshot.
    const hasPrior = endIndex > 0;
    const hasLater = endIndex < rows.length;
    result.rejectionReason = hasPrior && hasLater ? 'internal-latest-hour-gap' : Number(rows[0]?.t) > latestExpected ? 'not-listed-yet' : 'not-observed-at-timestamp';
    result.dataLoss = hasPrior && hasLater;
    return result;
  }
  result.archiveObserved = true;
  const firstIndex = endIndex - historyHours + 1;
  const expectedFirst = latestExpected - (historyHours - 1) * H1;
  if (firstIndex < 0) {
    result.rejectionReason = Number(rows[0]?.t) <= expectedFirst ? 'local-1h-gap' : '30d-warmup-incomplete';
    result.dataLoss = result.rejectionReason === 'local-1h-gap';
    return result;
  }
  if (Number(rows[firstIndex]?.t) !== expectedFirst) {
    result.rejectionReason = '30d-warmup-incomplete';
    return result;
  }
  const gaps = market?.gapPrefix
    ? Number(market.gapPrefix[endIndex] || 0) - Number(market.gapPrefix[firstIndex] || 0)
    : rows.slice(firstIndex + 1, endIndex + 1).filter((row, index) => Number(row.t) - Number(rows[firstIndex + index].t) !== H1).length;
  if (gaps > 0) {
    result.rejectionReason = 'local-1h-gap';
    result.dataLoss = true;
    return result;
  }
  result.historyReady = true;
  if (!market?.volumeValid && rows.slice(firstIndex, endIndex + 1).some(row => row.q == null)) {
    result.rejectionReason = 'quote-volume-unavailable';
    result.dataLoss = true;
    return result;
  }
  const volume = market?.volumePrefix
    ? Number(market.volumePrefix[endIndex + 1]) - Number(market.volumePrefix[firstIndex])
    : rows.slice(firstIndex, endIndex + 1).reduce((sum, row) => sum + Number(row.q || 0), 0);
  result.averageDailyQuoteVolume = volume / 30;
  // Decimal quote volumes can accumulate a sub-cent floating-point residue;
  // the tolerance is far below one quote unit and does not relax the rule.
  result.liquidityReady = result.averageDailyQuoteVolume + 1e-6 >= Number(liquidityThresholdUsdt);
  const point = featurePoint || market?.featureByTime?.get(t) || null;
  result.featureReady = featureReady(point, t);
  if (!result.liquidityReady) result.rejectionReason = 'below-30d-volume-threshold';
  else if (!result.featureReady) {
    result.rejectionReason = 'required-feature-unavailable';
    result.dataLoss = true;
  }
  result.finalEligible = result.archiveObserved && result.historyReady && result.liquidityReady && result.featureReady;
  if (result.finalEligible) result.rejectionReason = null;
  return result;
}

function pointFor(points, timestamp) {
  if (points instanceof Map) return points.get(Number(timestamp)) || null;
  const rows = points || [];
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle]?.signalTime) < Number(timestamp)) low = middle + 1;
    else high = middle;
  }
  const index = low;
  return Number(rows[index]?.signalTime) === Number(timestamp) ? rows[index] : null;
}

function validDimension(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? mean(usable) : null;
}

export function buildObservedPITSnapshot({timestamp, markets = [], featurePointsBySymbol = new Map(), featurePointsAtTimestamp = null, featurePointCountAt = null, statusAtTimestamp = null, statusCodesAtTimestamp = null, precomputedMembers = null, precomputedStats = null, marketsSorted = false, liquidityThresholdUsdt = OBSERVED_PIT_LIQUIDITY_THRESHOLD_USDT, includeSymbolLists = true} = {}) {
  const t = Number(timestamp);
  const orderedMarkets = marketsSorted ? markets : [...markets].sort((left, right) => String(left.symbol).localeCompare(String(right.symbol)));
  const statuses = precomputedStats || statusCodesAtTimestamp instanceof Map ? null : [];
  const members = precomputedMembers ? [...precomputedMembers] : [];
  const archiveObservedSymbols = includeSymbolLists ? [] : null;
  const historyReadySymbols = includeSymbolLists ? [] : null;
  const liquidityReadySymbols = includeSymbolLists ? [] : null;
  const featureReadySymbols = includeSymbolLists ? [] : null;
  const dataLossSymbols = includeSymbolLists ? [] : null;
  let archiveObservedCount = 0;
  let historyReadyCount = 0;
  let liquidityReadyCount = 0;
  let featureReadyCount = 0;
  let dataLossCount = 0;
  let otherwiseEligibleCount = 0;
  let corruptionLostCount = 0;
  const dataLossReasonCounts = {...(precomputedStats?.dataLossReasonCounts || {})};
  let liquidityUnavailableMemberCount = 0;
  let futureListedMemberCount = 0;
  let postDelistMemberCount = 0;
  let btcStatus = precomputedStats?.btcStatus || null;
  if (precomputedStats) {
    archiveObservedCount = precomputedStats.archiveObservedCount;
    historyReadyCount = precomputedStats.historyReadyCount;
    liquidityReadyCount = precomputedStats.liquidityReadyCount;
    featureReadyCount = precomputedStats.featureReadyCount;
    dataLossCount = precomputedStats.dataLossCount;
    otherwiseEligibleCount = precomputedStats.otherwiseEligibleCount || 0;
    corruptionLostCount = precomputedStats.corruptionLostCount || 0;
    liquidityUnavailableMemberCount = precomputedStats.liquidityUnavailableMemberCount;
    futureListedMemberCount = precomputedStats.futureListedMemberCount;
    postDelistMemberCount = precomputedStats.postDelistMemberCount;
    if (archiveObservedSymbols) archiveObservedSymbols.push(...(precomputedStats.archiveObservedSymbols || []));
    if (historyReadySymbols) historyReadySymbols.push(...(precomputedStats.historyReadySymbols || []));
    if (liquidityReadySymbols) liquidityReadySymbols.push(...(precomputedStats.liquidityReadySymbols || []));
    if (featureReadySymbols) featureReadySymbols.push(...(precomputedStats.featureReadySymbols || []));
    if (dataLossSymbols) dataLossSymbols.push(...(precomputedStats.dataLossSymbols || []));
  } else for (const market of orderedMarkets) {
    const points = featurePointsBySymbol instanceof Map ? featurePointsBySymbol.get(market.symbol) : featurePointsBySymbol?.[market.symbol];
    const point = featurePointsAtTimestamp instanceof Map
      ? featurePointsAtTimestamp.get(market.symbol) || null
      : pointFor(points || market.featureByTime, t);
    let archiveObserved;
    let historyReady;
    let liquidityReady;
    let featureReadyValue;
    let finalEligible;
    let dataLoss;
    let lossReason;
    let futureListed;
    let postDelist;
    if (statusCodesAtTimestamp instanceof Map && statusCodesAtTimestamp.has(market.symbol)) {
      const bits = Number(statusCodesAtTimestamp.get(market.symbol)) || 0;
      archiveObserved = (bits & OBSERVED_STATUS_BITS.archiveObserved) !== 0;
      historyReady = (bits & OBSERVED_STATUS_BITS.historyReady) !== 0;
      liquidityReady = (bits & OBSERVED_STATUS_BITS.liquidityReady) !== 0;
      featureReadyValue = (bits & OBSERVED_STATUS_BITS.featureReady) !== 0;
      finalEligible = (bits & OBSERVED_STATUS_BITS.finalEligible) !== 0;
      dataLoss = (bits & OBSERVED_STATUS_BITS.dataLoss) !== 0;
      lossReason = dataLossReason({archiveObserved, historyReady, liquidityReady, featureReady: featureReadyValue, dataLoss});
      futureListed = (bits & OBSERVED_STATUS_BITS.futureListed) !== 0;
      postDelist = (bits & OBSERVED_STATUS_BITS.postDelist) !== 0;
    } else {
      const status = statusAtTimestamp instanceof Map && statusAtTimestamp.has(market.symbol)
        ? statusAtTimestamp.get(market.symbol)
        : observedTradabilityAt(market, t, {featurePoint: point, liquidityThresholdUsdt});
      statuses.push(status);
      archiveObserved = status.archiveObserved;
      historyReady = status.historyReady;
      liquidityReady = status.liquidityReady;
      featureReadyValue = status.featureReady;
      finalEligible = status.finalEligible;
      dataLoss = status.dataLoss;
      lossReason = status.dataLossReason || (dataLoss ? status.rejectionReason : null);
      futureListed = !archiveObserved && status.rejectionReason === 'not-listed-yet';
      postDelist = !archiveObserved && status.rejectionReason === 'not-observed-at-timestamp';
    }
    if (archiveObserved) { archiveObservedCount++; if (archiveObservedSymbols) archiveObservedSymbols.push(market.symbol); }
    if (historyReady) { historyReadyCount++; if (historyReadySymbols) historyReadySymbols.push(market.symbol); }
    if (liquidityReady) { liquidityReadyCount++; if (liquidityReadySymbols) liquidityReadySymbols.push(market.symbol); }
    if (featureReadyValue) { featureReadyCount++; if (featureReadySymbols) featureReadySymbols.push(market.symbol); }
    if (dataLoss) { dataLossCount++; if (dataLossSymbols) dataLossSymbols.push(market.symbol); }
    if (finalEligible || dataLoss) otherwiseEligibleCount++;
    if (dataLoss) {
      corruptionLostCount++;
      const key = lossReason || 'data-quality-unresolved';
      dataLossReasonCounts[key] = Number(dataLossReasonCounts[key] || 0) + 1;
    }
    if (archiveObserved && !liquidityReady) liquidityUnavailableMemberCount++;
    if (!archiveObserved && futureListed) futureListedMemberCount++;
    if (!archiveObserved && postDelist) postDelistMemberCount++;
    if (market.symbol === 'BTCUSDT') btcStatus = {historyReady, featureReady: featureReadyValue, finalEligible, dataLoss};
    if (finalEligible && point) {
      // A point is shared by the feature store and the snapshot.  Reusing the
      // object keeps the full-universe diagnostic bounded while the symbol and
      // PIT rank remain deterministic metadata on that immutable observation.
      point.symbol = market.symbol;
      point.marketId = market.symbol;
      point.core = market.core;
      point.liquidityBucket = 'eligible';
      members.push(point);
    }
  }
  const ranked = [...members].sort((left, right) => Number(right.return4 ?? -Infinity) - Number(left.return4 ?? -Infinity) || String(left.symbol).localeCompare(String(right.symbol)));
  ranked.forEach((point, index) => { point.pitReturnRank = ranked.length <= 1 ? 1 : 1 - index / (ranked.length - 1); });
  const values = ranked.map(point => Number(point.return4)).filter(Number.isFinite);
  const above = ranked.map(point => Number(point.close) > Number(point.ema50));
  const positive = values.filter(value => value > 0).length;
  const negative = values.filter(value => value < 0).length;
  const btc = ranked.find(point => point.symbol === 'BTCUSDT');
  const derivativeReadyCount = ranked.filter(derivativeReady).length;
  const funding = validDimension(ranked.filter(point => point.fundingValid !== false).map(point => point.fundingZ));
  const premium = validDimension(ranked.map(point => point.premiumZ));
  const oi = validDimension(ranked.map(point => point.oiZ));
  const dimensions = [['funding', funding], ['premium', premium], ['oi', oi]].filter(([, value]) => value != null && value !== 0);
  const sameSign = dimensions.length >= 2 && new Set(dimensions.map(([, value]) => Math.sign(value))).size === 1;
  const crowdingStressZ = sameSign ? Math.max(...dimensions.map(([, value]) => Math.abs(value))) * Math.sign(dimensions[0][1]) : null;
  const averageReturn = mean(values);
  return {
    eventTime: t,
    signalTime: t,
    timestamp: t,
    timestampIso: iso(t),
    completed: true,
    isComplete: true,
    pitUniverseSize: ranked.length,
    archiveObservedSymbols: archiveObservedSymbols || (statuses ? statuses.filter(row => row.archiveObserved).map(row => row.symbol) : null),
    historyReadySymbols: historyReadySymbols || (statuses ? statuses.filter(row => row.historyReady).map(row => row.symbol) : null),
    liquidityReadySymbols: liquidityReadySymbols || (statuses ? statuses.filter(row => row.liquidityReady).map(row => row.symbol) : null),
    featureReadySymbols: featureReadySymbols || (statuses ? statuses.filter(row => row.featureReady).map(row => row.symbol) : null),
    finalPitSymbols: ranked.map(point => point.symbol),
    archiveObservedCount: statuses ? statuses.filter(row => row.archiveObserved).length : archiveObservedCount,
    historyReadyCount: statuses ? statuses.filter(row => row.historyReady).length : historyReadyCount,
    liquidityReadyCount: statuses ? statuses.filter(row => row.liquidityReady).length : liquidityReadyCount,
    featureReadyCount: statuses ? statuses.filter(row => row.featureReady).length : featureReadyCount,
    dataLossSymbols: dataLossSymbols || (statuses ? statuses.filter(row => row.dataLoss).map(row => row.symbol) : null),
    dataLossCount: statuses ? statuses.filter(row => row.dataLoss).length : dataLossCount,
    otherwiseEligibleObservations: statuses
      ? statuses.filter(row => row.finalEligible || row.dataLoss).length
      : otherwiseEligibleCount,
    corruptionLostObservations: statuses
      ? statuses.filter(row => row.dataLoss).length
      : corruptionLostCount,
    dataLossReasonCounts,
    liquidityUnavailableMemberCount: statuses ? statuses.filter(row => row.archiveObserved && !row.liquidityReady).length : liquidityUnavailableMemberCount,
    futureListedMemberCount: statuses ? statuses.filter(row => !row.archiveObserved && row.rejectionReason === 'not-listed-yet').length : futureListedMemberCount,
    postDelistMemberCount: statuses ? statuses.filter(row => !row.archiveObserved && row.rejectionReason === 'not-observed-at-timestamp').length : postDelistMemberCount,
    members: ranked,
    allFeaturePointCount: featurePointCountAt == null
      ? [...(featurePointsBySymbol instanceof Map ? featurePointsBySymbol.values() : Object.values(featurePointsBySymbol || {}))].reduce((sum, points) => sum + (pointFor(points, t) ? 1 : 0), 0)
      : Number(featurePointCountAt),
    breadthAbove50: above.length ? above.filter(Boolean).length / above.length : null,
    positiveReturnBreadth: values.length ? positive / values.length : null,
    negativeReturnBreadth: values.length ? negative / values.length : null,
    directionalBreadth: values.length ? Math.max(positive, negative) / values.length : null,
    marketReturn: averageReturn,
    marketDirection: averageReturn == null ? null : averageReturn > 0 ? 'long' : averageReturn < 0 ? 'short' : null,
    marketRegime: String(btc?.regime || btc?.btcRegime || 'SIDEWAYS').toUpperCase(),
    liquidityBucket: ranked.length ? 'eligible' : 'unavailable',
    volatilityProxy: values.length ? mean(values.map(value => Math.abs(value))) : null,
    dispersionProxy: standardDeviation(values),
    derivativeReadyCount,
    derivativeFeatureAvailable: derivativeReadyCount >= 100,
    leverageFeatureAvailable: derivativeReadyCount >= 100,
    fundingZ: derivativeReadyCount >= 100 ? funding : null,
    premiumZ: derivativeReadyCount >= 100 ? premium : null,
    oiZ: derivativeReadyCount >= 100 ? oi : null,
    crowdingStressZ: derivativeReadyCount >= 100 ? crowdingStressZ : null,
    btcOtherwiseEligible: Boolean(btcStatus?.historyReady && btcStatus?.featureReady),
    btcFinalEligible: Boolean(btcStatus?.finalEligible),
    btcDataLoss: Boolean(btcStatus?.dataLoss),
  };
}

export function buildObservedPITSnapshots({markets = [], featurePointsBySymbol = new Map(), pitStatusBySymbol = null, start = OBSERVED_PIT_DEVELOPMENT_START, end = OBSERVED_PIT_DEVELOPMENT_END, snapshotInterval = OBSERVED_PIT_SNAPSHOT_INTERVAL_MS, liquidityThresholdUsdt = OBSERVED_PIT_LIQUIDITY_THRESHOLD_USDT, includeSymbolLists = true} = {}) {
  const first = Math.ceil(Number(start) / Number(snapshotInterval)) * Number(snapshotInterval);
  const snapshots = [];
  const orderedMarkets = [...markets].sort((left, right) => String(left.symbol).localeCompare(String(right.symbol)));
  const pointIndexes = new Map(orderedMarkets.map(market => [market.symbol, 0]));
  let snapshotIndex = 0;
  if (pitStatusBySymbol instanceof Map) {
    for (let timestamp = first; timestamp < Number(end); timestamp += Number(snapshotInterval), snapshotIndex++) {
      const members = [];
      const stats = {
        archiveObservedCount: 0,
        historyReadyCount: 0,
        liquidityReadyCount: 0,
        featureReadyCount: 0,
        dataLossCount: 0,
        otherwiseEligibleCount: 0,
        corruptionLostCount: 0,
        dataLossReasonCounts: {},
        liquidityUnavailableMemberCount: 0,
        futureListedMemberCount: 0,
        postDelistMemberCount: 0,
        archiveObservedSymbols: includeSymbolLists ? [] : null,
        historyReadySymbols: includeSymbolLists ? [] : null,
        liquidityReadySymbols: includeSymbolLists ? [] : null,
        featureReadySymbols: includeSymbolLists ? [] : null,
        dataLossSymbols: includeSymbolLists ? [] : null,
        btcStatus: null,
      };
      let featurePointCountAt = 0;
      for (const market of orderedMarkets) {
        const points = featurePointsBySymbol instanceof Map ? featurePointsBySymbol.get(market.symbol) : featurePointsBySymbol?.[market.symbol];
        const rows = points || [];
        let index = pointIndexes.get(market.symbol) || 0;
        while (index < rows.length && Number(rows[index]?.signalTime) < timestamp) index++;
        pointIndexes.set(market.symbol, index);
        const point = Number(rows[index]?.signalTime) === timestamp ? rows[index] : null;
        if (point) featurePointCountAt++;
        const codes = pitStatusBySymbol.get(market.symbol);
        const bits = Number(codes?.[snapshotIndex]) || 0;
        const archiveObserved = (bits & OBSERVED_STATUS_BITS.archiveObserved) !== 0;
        const historyReady = (bits & OBSERVED_STATUS_BITS.historyReady) !== 0;
        const liquidityReady = (bits & OBSERVED_STATUS_BITS.liquidityReady) !== 0;
        const featureReadyValue = (bits & OBSERVED_STATUS_BITS.featureReady) !== 0;
        const finalEligible = (bits & OBSERVED_STATUS_BITS.finalEligible) !== 0;
        const dataLoss = (bits & OBSERVED_STATUS_BITS.dataLoss) !== 0;
        if (archiveObserved) { stats.archiveObservedCount++; if (stats.archiveObservedSymbols) stats.archiveObservedSymbols.push(market.symbol); }
        if (historyReady) { stats.historyReadyCount++; if (stats.historyReadySymbols) stats.historyReadySymbols.push(market.symbol); }
        if (liquidityReady) { stats.liquidityReadyCount++; if (stats.liquidityReadySymbols) stats.liquidityReadySymbols.push(market.symbol); }
        if (featureReadyValue) { stats.featureReadyCount++; if (stats.featureReadySymbols) stats.featureReadySymbols.push(market.symbol); }
        if (dataLoss) { stats.dataLossCount++; if (stats.dataLossSymbols) stats.dataLossSymbols.push(market.symbol); }
        if (finalEligible || dataLoss) stats.otherwiseEligibleCount++;
        if (dataLoss) {
          stats.corruptionLostCount++;
          const key = dataLossReason({archiveObserved, historyReady, liquidityReady, featureReady: featureReadyValue, dataLoss}) || 'data-quality-unresolved';
          stats.dataLossReasonCounts[key] = Number(stats.dataLossReasonCounts[key] || 0) + 1;
        }
        if (archiveObserved && !liquidityReady) stats.liquidityUnavailableMemberCount++;
        if (!archiveObserved && (bits & OBSERVED_STATUS_BITS.futureListed)) stats.futureListedMemberCount++;
        if (!archiveObserved && (bits & OBSERVED_STATUS_BITS.postDelist)) stats.postDelistMemberCount++;
        if (market.symbol === 'BTCUSDT') stats.btcStatus = {historyReady, featureReady: featureReadyValue, finalEligible, dataLoss};
        if (finalEligible && point) {
          point.symbol = market.symbol;
          point.marketId = market.symbol;
          point.core = market.core;
          point.liquidityBucket = 'eligible';
          members.push(point);
        }
      }
      snapshots.push(buildObservedPITSnapshot({timestamp, markets: orderedMarkets, marketsSorted: true, featurePointsBySymbol, featurePointCountAt, precomputedMembers: members, precomputedStats: stats, liquidityThresholdUsdt, includeSymbolLists}));
    }
    return addObservedSnapshotEventFeatures(snapshots);
  }
  for (let timestamp = first; timestamp < Number(end); timestamp += Number(snapshotInterval), snapshotIndex++) {
    const pointsAtTimestamp = new Map();
    const statusCodesAtTimestamp = pitStatusBySymbol instanceof Map ? new Map() : null;
    let featurePointCountAt = 0;
    for (const market of orderedMarkets) {
      const points = featurePointsBySymbol instanceof Map ? featurePointsBySymbol.get(market.symbol) : featurePointsBySymbol?.[market.symbol];
      const rows = points || [];
      let index = pointIndexes.get(market.symbol) || 0;
      while (index < rows.length && Number(rows[index]?.signalTime) < timestamp) index++;
      pointIndexes.set(market.symbol, index);
      if (Number(rows[index]?.signalTime) === timestamp) {
        pointsAtTimestamp.set(market.symbol, rows[index]);
        featurePointCountAt++;
      }
      if (statusCodesAtTimestamp) {
        const codes = pitStatusBySymbol.get(market.symbol);
        if (codes) statusCodesAtTimestamp.set(market.symbol, codes[snapshotIndex]);
      }
    }
    snapshots.push(buildObservedPITSnapshot({timestamp, markets: orderedMarkets, marketsSorted: true, featurePointsBySymbol, featurePointsAtTimestamp: pointsAtTimestamp, featurePointCountAt, statusCodesAtTimestamp, liquidityThresholdUsdt, includeSymbolLists}));
  }
  return addObservedSnapshotEventFeatures(snapshots);
}

/**
 * Add the frozen event-engine's historical feature semantics to completed
 * observed-PIT snapshots.  Each z-score reads only the prior 30 completed
 * observations and requires eight finite historical values; the current row
 * is never included in its own baseline and no future row is consulted.
 */
export function addObservedSnapshotEventFeatures(snapshots = [], {historyLength = 30, minimumHistory = 8} = {}) {
  const ordered = [...(snapshots || [])].sort((left, right) => Number(left.eventTime) - Number(right.eventTime));
  const dispersionHistory = [];
  const volatilityHistory = [];
  let previousDispersionZ = null;
  return ordered.map(snapshot => {
    const currentDispersion = finite(snapshot.dispersionProxy);
    const currentVolatility = finite(snapshot.volatilityProxy);
    const realizedVolZ = rollingZScore(currentVolatility, volatilityHistory.slice(-historyLength), minimumHistory);
    const dispersionZ = rollingZScore(currentDispersion, dispersionHistory.slice(-historyLength), minimumHistory);
    const output = {
      ...snapshot,
      realizedVolZ,
      dispersionZ,
      previousDispersionZ,
      eventFeatures: {
        realizedVolZ,
        previousDispersionZ,
        dispersionZ,
        historyLength,
        availableHistory: Math.max(dispersionHistory.length, volatilityHistory.length),
        minimumHistory,
        lookbackCompletedOnly: true,
      },
    };
    if (currentDispersion != null) dispersionHistory.push(currentDispersion);
    if (currentVolatility != null) volatilityHistory.push(currentVolatility);
    while (dispersionHistory.length > historyLength) dispersionHistory.shift();
    while (volatilityHistory.length > historyLength) volatilityHistory.shift();
    previousDispersionZ = dispersionZ;
    return output;
  });
}

export function monthlyObservedCoverage(snapshots = []) {
  const grouped = new Map();
  for (const snapshot of snapshots) {
    const key = monthKey(snapshot.eventTime);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(snapshot);
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([month, rows]) => {
    const sizes = rows.map(row => Number(row.pitUniverseSize));
    const medianSize = median(sizes);
    const core = rows.map(row => (row.members || []).filter(member => member.core).length);
    const expanded = rows.map(row => (row.members || []).filter(member => !member.core).length);
    return [month, {
      snapshots: rows.length,
      pitEligibleSymbols: medianSize,
      median: medianSize,
      mean: mean(sizes),
      min: Math.min(...sizes),
      max: Math.max(...sizes),
      coreMedian: median(core),
      expandedMedian: median(expanded),
      dataLossObservations: rows.reduce((sum, row) => sum + Number(row.dataLossCount ?? row.dataLossSymbols?.length ?? 0), 0),
    }];
  }))
}

export function observedPitGate(snapshots = [], {minimumMonthlyMedian = 100, minimumDevelopmentMean = 120, minimumBtcCoverage = 0.95} = {}) {
  const monthly = monthlyObservedCoverage(snapshots);
  const monthlyMedians = Object.values(monthly).map(row => Number(row.median)).filter(Number.isFinite);
  const pitSizes = snapshots.map(row => Number(row.pitUniverseSize)).filter(Number.isFinite);
  const btcOtherwise = snapshots.filter(row => row.btcOtherwiseEligible).length;
  const btcDataLoss = snapshots.filter(row => row.btcOtherwiseEligible && row.btcDataLoss).length;
  const btcCoverage = btcOtherwise ? (btcOtherwise - btcDataLoss) / btcOtherwise : 0;
  const nonCriticalDataLoss = snapshots.reduce((sum, row) => sum + (row.dataLossSymbols ? row.dataLossSymbols.filter(symbol => symbol !== 'BTCUSDT').length : Math.max(0, Number(row.dataLossCount || 0) - (row.btcDataLoss ? 1 : 0))), 0);
  const otherwiseEligibleObservations = snapshots.reduce((sum, row) => sum + Number(row.otherwiseEligibleObservations ?? Number(row.pitUniverseSize || 0) + Number(row.dataLossCount || 0)), 0);
  const corruptionLostObservations = snapshots.reduce((sum, row) => sum + Number(row.corruptionLostObservations ?? row.dataLossCount ?? 0), 0);
  const corruptionRetentionRate = otherwiseEligibleObservations > 0
    ? (otherwiseEligibleObservations - corruptionLostObservations) / otherwiseEligibleObservations
    : 0;
  const corruptionLossRate = otherwiseEligibleObservations > 0 ? corruptionLostObservations / otherwiseEligibleObservations : 1;
  const lossReasonCounts = {};
  for (const row of snapshots) for (const [reason, count] of Object.entries(row.dataLossReasonCounts || {})) lossReasonCounts[reason] = Number(lossReasonCounts[reason] || 0) + Number(count || 0);
  const lossSymbolCounts = {};
  for (const row of snapshots) for (const symbol of row.dataLossSymbols || []) lossSymbolCounts[symbol] = Number(lossSymbolCounts[symbol] || 0) + 1;
  const topLossSymbols = Object.entries(lossSymbolCounts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 20).map(([symbol, count]) => ({symbol, count}));
  const topLossReasons = Object.entries(lossReasonCounts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 20).map(([reason, count]) => ({reason, count}));
  const monthlyPass = monthlyMedians.length > 0 && Math.min(...monthlyMedians) >= minimumMonthlyMedian;
  const meanPass = pitSizes.length > 0 && mean(pitSizes) >= minimumDevelopmentMean;
  const btcPass = btcOtherwise > 0 && btcCoverage >= minimumBtcCoverage;
  const corruptionPass = otherwiseEligibleObservations > 0 && corruptionRetentionRate >= 0.95;
  const pass = monthlyPass && meanPass && btcPass && corruptionPass;
  return {
    pass,
    status: pass ? 'OBSERVED_PIT_READY' : 'OBSERVED_PIT_DATA_BLOCKED',
    mean: mean(pitSizes),
    median: median(pitSizes),
    min: pitSizes.length ? Math.min(...pitSizes) : 0,
    max: pitSizes.length ? Math.max(...pitSizes) : 0,
    monthly,
    monthlyMedianMin: monthlyMedians.length ? Math.min(...monthlyMedians) : null,
    monthlyMedianPass: monthlyPass,
    developmentMeanPass: meanPass,
    btcOtherwiseEligibleObservations: btcOtherwise,
    btcDataLossObservations: btcDataLoss,
    btcCoverage,
    btcCoveragePass: btcPass,
    nonCriticalDataLossObservations: nonCriticalDataLoss,
    otherwiseEligibleObservations,
    corruptionLostObservations,
    corruptionRetentionRate,
    corruptionLossRate,
    corruptionPass,
    topLossSymbols,
    topLossReasons,
    criteria: {minimumMonthlyMedian, minimumDevelopmentMean, minimumBtcCoverage, minimumCorruptionRetention: 0.95},
  };
}

/**
 * Reconstruct compact data-loss diagnostics without retaining one symbol list
 * on every formal snapshot.  The status code is produced from the same
 * point-in-time evaluator as the PIT membership, so this is a diagnostic
 * projection rather than a second eligibility rule.
 */
export function observedPitDataLossSummary({markets = [], pitStatusBySymbol = new Map(), timestamps = []} = {}) {
  const symbolCounts = {};
  const reasonCounts = {};
  const orderedMarkets = [...(markets || [])].sort((left, right) => String(left.symbol).localeCompare(String(right.symbol)));
  const add = (bucket, key) => { bucket[key] = Number(bucket[key] || 0) + 1; };
  for (const market of orderedMarkets) {
    const codes = pitStatusBySymbol instanceof Map ? pitStatusBySymbol.get(market.symbol) : null;
    if (!codes) continue;
    for (let index = 0; index < Math.min(codes.length, timestamps.length); index++) {
      const bits = Number(codes[index]) || 0;
      if ((bits & OBSERVED_STATUS_BITS.dataLoss) === 0) continue;
      add(symbolCounts, market.symbol);
      const archiveObserved = (bits & OBSERVED_STATUS_BITS.archiveObserved) !== 0;
      const historyReady = (bits & OBSERVED_STATUS_BITS.historyReady) !== 0;
      const liquidityReady = (bits & OBSERVED_STATUS_BITS.liquidityReady) !== 0;
      const featureReadyValue = (bits & OBSERVED_STATUS_BITS.featureReady) !== 0;
      add(reasonCounts, dataLossReason({archiveObserved, historyReady, liquidityReady, featureReady: featureReadyValue, dataLoss: true}) || 'data-quality-unresolved');
    }
  }
  return {
    lossSymbolCounts: symbolCounts,
    lossReasonCounts: reasonCounts,
    topLossSymbols: Object.entries(symbolCounts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 20).map(([symbol, count]) => ({symbol, count})),
    topLossReasons: Object.entries(reasonCounts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 20).map(([reason, count]) => ({reason, count})),
  };
}

export function observedAnnouncementEvidenceIsUsdM(record) {
  const text = [record?.product, record?.market, record?.contractType, record?.title, record?.url, record?.path].filter(Boolean).join(' ').toLowerCase();
  if (/\bspot\b|spot market|spot trading/.test(text)) return false;
  return /usd[- ]?m|futures|perpetual|contract/.test(text) && !/delivery contract|quarterly/.test(text);
}

export function observedPitInvariantAudit({before, after, snapshotsBefore = [], snapshotsAfter = [], cutoff = null, invariants = {}} = {}) {
  const beforeByTime = new Map(snapshotsBefore.map(row => [Number(row.eventTime), row.finalPitSymbols.join('|')]));
  const afterByTime = new Map(snapshotsAfter.map(row => [Number(row.eventTime), row.finalPitSymbols.join('|')]));
  const cutoffTime = finite(cutoff);
  const historicalTimestamps = [...beforeByTime.keys()]
    .filter(timestamp => cutoffTime == null || timestamp < cutoffTime)
    .filter(timestamp => afterByTime.has(timestamp))
    .sort((left, right) => left - right);
  const changedHistoricalSnapshots = historicalTimestamps.filter(timestamp => beforeByTime.get(timestamp) !== afterByTime.get(timestamp)).length;
  const universeUnchanged = historicalTimestamps.length > 0 && changedHistoricalSnapshots === 0;
  const beforeSymbols = new Set((before || []).map(row => row.symbol));
  const afterSymbols = new Set((after || []).map(row => row.symbol));
  const resultFor = name => invariants[name] == null ? universeUnchanged : Boolean(invariants[name]);
  const futureRowsInvariant = resultFor('futureRowsInvariant');
  const futureVolumeInvariant = resultFor('futureVolumeInvariant');
  const futureListingInvariant = resultFor('futureListingInvariant');
  const futureDelistInvariant = resultFor('futureDelistInvariant');
  const currentExchangeInfoInvariant = resultFor('currentExchangeInfoInvariant');
  const announcementInvariant = resultFor('announcementInvariant');
  return {
    futureRowsDoNotChangePastUniverse: universeUnchanged,
    futureRowsInvariant,
    futureListedMemberInvariant: futureListingInvariant,
    futureListingInvariant,
    futureDelistedKnowledgeInvariant: futureDelistInvariant,
    futureDelistInvariant,
    futureVolumeInvariant,
    currentExchangeInfoInvariant,
    announcementEvidenceInvariant: announcementInvariant,
    announcementInvariant,
    beforeSymbols: beforeSymbols.size,
    afterSymbols: afterSymbols.size,
    comparedHistoricalSnapshots: historicalTimestamps.length,
    changedHistoricalSnapshots,
    pass: universeUnchanged && futureRowsInvariant && futureVolumeInvariant && futureListingInvariant && futureDelistInvariant && currentExchangeInfoInvariant && announcementInvariant,
  };
}
