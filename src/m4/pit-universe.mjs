import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {CORE_MARKETS, H1} from '../config.mjs';

export const M4_DEVELOPMENT_START = Date.parse('2024-01-01T00:00:00.000Z');
export const M4_DEVELOPMENT_END = Date.parse('2026-01-01T00:00:00.000Z');
export const M4_REQUIRED_ARTIFACTS = Object.freeze(['price', 'minute', 'funding']);
export const M4_HOURS = 3_600_000;
export const M4_DAY = 24 * M4_HOURS;
export const M4_LIQUIDITY_LOOKBACK_DAYS = 30;
export const M4_LIQUIDITY_THRESHOLD_USDT = 20_000_000;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(file) {
  return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
}

export function timestampValue(value) {
  if (value == null || value === '') return null;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function listingAgeDaysAt(row, timestamp) {
  const listing = timestampValue(row?.listingTimestamp ?? row?.listingEvidenceTimestamp ?? row?.listingTime);
  const at = timestampValue(timestamp);
  return Number.isFinite(listing) && Number.isFinite(at) && at >= listing ? (at - listing) / M4_DAY : null;
}

function iso(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : new Date(Number(value)).toISOString();
}

function validHash(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

function monthKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthStart(value) {
  const [year, month] = String(value).split('-').map(Number);
  return Number.isInteger(year) && Number.isInteger(month) ? Date.UTC(year, month - 1, 1) : null;
}

function nextMonth(timestamp) {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function archiveMonth(key) {
  const value = String(key || '').match(/(?:-1[hm]-|fundingRate-)(\d{4}-\d{2})(?:-\d{2})?\.zip$/);
  return value?.[1] || null;
}

function archiveMonths(archiveRecord = {}) {
  return [...new Set([
    ...(archiveRecord.klines || []),
    ...(archiveRecord.price || []),
    ...(archiveRecord.funding || []),
  ].map(archiveMonth).filter(Boolean))].sort();
}

function artifactFile(appDir, artifact) {
  return artifact?.path ? path.resolve(appDir, artifact.path) : null;
}

function artifactSummary(appDir, artifact) {
  const file = artifactFile(appDir, artifact);
  return {
    present: Boolean(file && fs.existsSync(file)),
    nonEmpty: Boolean(Number(artifact?.rows) > 0),
    path: artifact?.path || null,
    rows: Number(artifact?.rows || 0),
    sha256: artifact?.sha256 || null,
    hashRecorded: validHash(artifact?.sha256),
    file,
    firstTimestamp: timestampValue(artifact?.firstTimestamp ?? artifact?.firstObservedTimestamp),
    lastTimestamp: timestampValue(artifact?.lastTimestamp ?? artifact?.lastObservedTimestamp),
    firstObservedTimestamp: timestampValue(artifact?.firstObservedTimestamp),
    lastObservedTimestamp: timestampValue(artifact?.lastObservedTimestamp),
    declaredActiveStart: timestampValue(artifact?.activeStart),
    declaredActiveEnd: timestampValue(artifact?.activeEnd),
    interval: artifact?.interval || null,
    fundingIntervalHours: Number(artifact?.fundingIntervalHours) > 0 ? Number(artifact.fundingIntervalHours) : null,
    fundingIntervalFallbackHours: Number(artifact?.fundingIntervalFallbackHours) > 0 ? Number(artifact.fundingIntervalFallbackHours) : null,
    fundingIntervalSource: artifact?.fundingIntervalSource || null,
  };
}

function fundingBoundary(summary, activeStart, activeEnd) {
  const fallback = {
    first: summary.firstTimestamp,
    last: summary.lastTimestamp,
    firstIntervalHours: summary.fundingIntervalHours ?? summary.fundingIntervalFallbackHours,
    lastIntervalHours: summary.fundingIntervalHours ?? summary.fundingIntervalFallbackHours,
  };
  if (!summary.file || !fs.existsSync(summary.file)
    || (Number.isFinite(fallback.first) && fallback.first >= activeStart
      && Number.isFinite(fallback.last) && fallback.last < activeEnd)) return fallback;
  try {
    const text = zlib.gunzipSync(fs.readFileSync(summary.file)).toString('utf8').trim();
    const rows = text ? JSON.parse(text) : [];
    const activeRows = (Array.isArray(rows) ? rows : []).filter(row => {
      const timestamp = timestampValue(row?.t ?? row?.fundingTime);
      return Number.isFinite(timestamp) && timestamp >= activeStart && timestamp < activeEnd;
    }).sort((left, right) => timestampValue(left?.t ?? left?.fundingTime) - timestampValue(right?.t ?? right?.fundingTime));
    const firstRow = activeRows[0];
    const lastRow = activeRows.at(-1);
    return {
      first: timestampValue(firstRow?.t ?? firstRow?.fundingTime),
      last: timestampValue(lastRow?.t ?? lastRow?.fundingTime),
      firstIntervalHours: Number(firstRow?.fundingIntervalHours) > 0 ? Number(firstRow.fundingIntervalHours) : fallback.firstIntervalHours,
      lastIntervalHours: Number(lastRow?.fundingIntervalHours) > 0 ? Number(lastRow.fundingIntervalHours) : fallback.lastIntervalHours,
    };
  } catch {
    return {...fallback, readError: 'funding-boundary-read-failed'};
  }
}

function evidence(record, prefix, fallback = {}) {
  const timestamp = timestampValue(record?.[`${prefix}EvidenceTimestamp`] ?? (
    prefix === 'listing' ? record?.listingTime ?? record?.onboardTime : record?.delistTime ?? record?.deliveryTime
  ));
  const source = record?.[`${prefix}EvidenceSource`] || fallback.source || null;
  const url = record?.[`${prefix}EvidenceUrl`] || fallback.url || null;
  const filePath = record?.[`${prefix}EvidencePath`] || fallback.path || null;
  const sha = record?.[`${prefix}EvidenceSha256`] || fallback.sha256 || null;
  const exact = record?.[`${prefix}EvidenceExact`] !== false;
  return {
    timestamp,
    source,
    url,
    path: filePath,
    sha256: sha,
    exact,
    complete: Number.isFinite(timestamp) && Boolean(source) && Boolean(url || filePath) && validHash(sha) && exact,
  };
}

function currentExchangeInfoEvidence({path: filePath, sha256: hash}) {
  return {
    source: 'Binance official USD-M exchangeInfo snapshot',
    url: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
    path: filePath,
    sha256: hash,
  };
}

function archiveObservationEvidence({path: filePath, sha256: hash} = {}) {
  return {
    source: 'Binance official Data Vision USD-M archive observation',
    url: 'https://data.binance.vision/?prefix=data/futures/um/monthly/',
    path: filePath || null,
    sha256: hash || null,
  };
}

export function isCryptoUsdMPerpetual(row) {
  return row?.quoteAsset === 'USDT' && row?.contractType === 'PERPETUAL'
    && !['TRADIFI', 'EQUITY', 'COMMODITY', 'INDEX'].some(value => String(row?.underlyingType || '').toUpperCase().includes(value))
    && !((row?.underlyingSubType || []).map(value => String(value).toUpperCase()).includes('TRADFI'));
}

function currentPerpetualMarkets(exchangeInfo) {
  return new Map((exchangeInfo?.symbols || [])
    .filter(isCryptoUsdMPerpetual)
    .map(row => [row.symbol, row]));
}

function tradfiPerpetualSymbols(exchangeInfo) {
  return (exchangeInfo?.symbols || [])
    .filter(row => row?.quoteAsset === 'USDT' && row?.contractType === 'TRADIFI_PERPETUAL')
    .map(row => row.symbol)
    .filter(Boolean)
    .sort();
}

function artifactMap(manifest) {
  return new Map((manifest?.artifacts || [])
    .filter(row => row?.symbol && row?.kind)
    .map(row => [`${row.symbol}|${row.kind}`, row]));
}

function evidenceMap(payload) {
  const records = Array.isArray(payload?.markets) ? payload.markets : Array.isArray(payload) ? payload : [];
  return new Map(records
    .filter(row => row?.symbol)
    .map(row => [row.symbol, row]));
}

function observedRange(artifacts) {
  const minute = artifacts.get('minute');
  const price = artifacts.get('price');
  return {
    first: timestampValue(minute?.firstObservedTimestamp ?? minute?.firstTimestamp
      ?? price?.firstObservedTimestamp ?? price?.firstTimestamp),
    last: timestampValue(minute?.lastObservedTimestamp ?? minute?.lastTimestamp
      ?? price?.lastObservedTimestamp ?? price?.lastTimestamp),
  };
}

export function boundaryObservations(artifacts, fallbackFirst = null, fallbackLast = null) {
  const minute = artifacts?.get?.('minute') || {};
  const price = artifacts?.get?.('price') || {};
  return {
    minuteFirst: timestampValue(minute.firstObservedTimestamp ?? minute.firstTimestamp),
    minuteLast: timestampValue(minute.lastObservedTimestamp ?? minute.lastTimestamp),
    hourlyFirst: timestampValue(price.firstObservedTimestamp ?? price.firstTimestamp ?? fallbackFirst),
    hourlyLast: timestampValue(price.lastObservedTimestamp ?? price.lastTimestamp ?? fallbackLast),
  };
}

function hasArchiveBefore(months, start) {
  const startMonth = monthKey(start);
  return months.some(month => month < startMonth);
}

function hasArchiveOverlap(months, start, end) {
  return months.some(month => {
    const from = monthStart(month);
    return Number.isFinite(from) && from < end && nextMonth(from) > start;
  });
}

function hasArchiveOverlapInRange(months, start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && start < end && hasArchiveOverlap(months, start, end);
}

function coverageWindow(first, last, activeStart, activeEnd, intervalMs) {
  if (!Number.isFinite(first) || !Number.isFinite(last)) return {complete: false, reason: 'observed-range-missing'};
  const startGap = first > activeStart + intervalMs;
  const endGap = last + intervalMs < activeEnd;
  return {
    complete: !startGap && !endGap,
    startGap,
    endGap,
    first: iso(first),
    last: iso(last),
    activeStart: iso(activeStart),
    activeEnd: iso(activeEnd),
  };
}

function readGzipRows(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim();
    const parsed = text ? JSON.parse(text) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function validHourlyLiquidityRow(row) {
  const t = timestampValue(row?.t ?? row?.openTime ?? row?.open_time);
  const q = Number(row?.q ?? row?.quoteVolume ?? row?.quote_asset_volume);
  return Number.isFinite(t) && Number.isFinite(q) && q >= 0 && row?.completed !== false && row?.isComplete !== false && row?.closed !== false
    ? {t, q}
    : null;
}

function lowerBoundNumber(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundNumber(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function buildLiquidityIndex(priceRows) {
  const byTime = new Map();
  for (const raw of priceRows || []) {
    const parsed = validHourlyLiquidityRow(raw);
    if (parsed) byTime.set(parsed.t, parsed.q);
  }
  const rows = [...byTime.entries()].sort(([left], [right]) => left - right);
  const timestamps = rows.map(([timestamp]) => timestamp);
  const prefix = [0];
  for (const [, quoteVolume] of rows) prefix.push(prefix.at(-1) + quoteVolume);
  return {timestamps, prefix};
}

function liquidityAtTimestamp(row, timestamp) {
  const t = timestampValue(timestamp);
  const activeStart = timestampValue(row?.activeStart ?? row?.eligibleStart);
  const priceRows = row?._priceRows || [];
  const index = row?._liquidityIndex || buildLiquidityIndex(priceRows);
  if (!Number.isFinite(t) || !Number.isFinite(activeStart) || !index.timestamps.length) return {
    available: false, eligible: false, volumeUsdt: null, reason: 'liquidity-history-unavailable',
  };
  const windowStart = t - M4_LIQUIDITY_LOOKBACK_DAYS * M4_DAY;
  if (windowStart < activeStart) return {
    available: false, eligible: false, volumeUsdt: null, reason: 'insufficient-30d-history',
  };
  const observedTimes = index.timestamps;
  if (!observedTimes.length || observedTimes[0] > windowStart) return {
    available: false, eligible: false, volumeUsdt: null, reason: 'insufficient-30d-history',
  }
  const firstExpected = Math.ceil(windowStart / M4_HOURS) * M4_HOURS;
  const lastExpected = Math.floor((t - 1) / M4_HOURS) * M4_HOURS;
  const expectedCount = lastExpected >= firstExpected ? Math.floor((lastExpected - firstExpected) / M4_HOURS) + 1 : 0;
  const left = lowerBoundNumber(observedTimes, firstExpected);
  const right = upperBoundNumber(observedTimes, lastExpected);
  const actualCount = right - left;
  if (actualCount !== expectedCount || observedTimes[left] !== firstExpected || observedTimes[right - 1] !== lastExpected) {
    const firstMissing = observedTimes[left] !== firstExpected ? firstExpected
      : observedTimes[right - 1] !== lastExpected ? lastExpected : null;
    return {
      available: false, eligible: false, volumeUsdt: null, reason: 'liquidity-window-gap',
      missingStart: iso(firstMissing), missingEnd: iso(firstMissing), missingRows: Math.max(1, expectedCount - actualCount),
    };
  };
  if (expectedCount < M4_LIQUIDITY_LOOKBACK_DAYS * 24) return {
    available: false, eligible: false, volumeUsdt: null, reason: 'insufficient-30d-history',
  };
  const volumeUsdt = Number(((index.prefix[right] - index.prefix[left]) / M4_LIQUIDITY_LOOKBACK_DAYS).toFixed(6));
  return {
    available: true,
    eligible: volumeUsdt >= M4_LIQUIDITY_THRESHOLD_USDT,
    volumeUsdt,
    reason: volumeUsdt >= M4_LIQUIDITY_THRESHOLD_USDT ? null : 'below-threshold',
    source: 'binance-1h-quoteVolume-completed-before-snapshot',
    lookbackDays: M4_LIQUIDITY_LOOKBACK_DAYS,
  };
}

function liquidityValue(row, key = null) {
  const monthly = row?.liquidityByMonth || row?.monthlyLiquidity || null;
  if (monthly && key) {
    if (!Object.prototype.hasOwnProperty.call(monthly, key)) return Number.NaN;
    return Number(monthly[key]?.averageQuoteVolume ?? monthly[key]?.quoteVolume ?? monthly[key]?.value ?? monthly[key]);
  }
  if (monthly) return Number.NaN;
  const candidate = row?.liquidity30dAverageQuoteVolume ?? row?.average30dQuoteVolume;
  if (candidate == null) return Number.NaN;
  if (candidate && typeof candidate === 'object') return Number(candidate.averageQuoteVolume ?? candidate.quoteVolume ?? candidate.value);
  return Number(candidate);
}

export function liquidityEligibilityAt(row, timestamp, {allowMonthly = true} = {}) {
  const direct = liquidityAtTimestamp(row, timestamp);
  if (row?._liquidityIndex?.timestamps?.length || row?._priceRows?.length) {
    return {
      ...direct,
      thresholdUsdt: M4_LIQUIDITY_THRESHOLD_USDT,
      lookbackDays: M4_LIQUIDITY_LOOKBACK_DAYS,
    };
  }
  const date = new Date(timestampValue(timestamp));
  const key = Number.isNaN(date.getTime()) ? null : `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const hasMonthly = Boolean(row?.liquidityByMonth || row?.monthlyLiquidity);
  if (hasMonthly && !allowMonthly) {
    return {
      available: false,
      volumeUsdt: null,
      eligible: false,
      thresholdUsdt: M4_LIQUIDITY_THRESHOLD_USDT,
      lookbackDays: M4_LIQUIDITY_LOOKBACK_DAYS,
      source: null,
      reason: 'monthly-liquidity-snapshot-not-point-in-time-at-timestamp',
    };
  }
  const volume = liquidityValue(row, key);
  return {
    available: Number.isFinite(volume),
    volumeUsdt: Number.isFinite(volume) ? volume : null,
    eligible: Number.isFinite(volume) && volume >= M4_LIQUIDITY_THRESHOLD_USDT,
    thresholdUsdt: M4_LIQUIDITY_THRESHOLD_USDT,
    lookbackDays: M4_LIQUIDITY_LOOKBACK_DAYS,
    source: row?.liquidityByMonth || row?.monthlyLiquidity ? 'legacy-monthly-diagnostic-not-used-for-formal-snapshots' : Number.isFinite(volume) ? 'point-in-time-30d-average' : null,
  };
}

function liquidityCoverage(row, start, end) {
  if (row?._liquidityIndex?.timestamps?.length || row?._priceRows?.length) {
    const observations = [];
    const first = Math.ceil(Number(start) / (4 * M4_HOURS)) * (4 * M4_HOURS);
    for (let timestamp = first; timestamp < Number(end); timestamp += 4 * M4_HOURS) observations.push(liquidityAtTimestamp(row, timestamp));
    const audit = {
      observations: observations.length,
      eligible: observations.filter(item => item.eligible).length,
      available: observations.filter(item => item.available).length,
      insufficientHistory: observations.filter(item => item.reason === 'insufficient-30d-history').length,
      gap: observations.filter(item => item.reason === 'liquidity-window-gap').length,
      belowThreshold: observations.filter(item => item.reason === 'below-threshold').length,
    };
    return {complete: audit.gap === 0 && audit.observations > 0, missingMonths: [], audit, source: 'formal-1h-quoteVolume'};
  }
  const monthly = row?.liquidityByMonth || row?.monthlyLiquidity;
  if (!monthly && Number.isFinite(liquidityValue(row))) return {complete: true, missingMonths: []};
  if (!monthly || typeof monthly !== 'object') return {complete: false, missingMonths: ['all-active-months']};
  const missingMonths = [];
  for (let cursor = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1); cursor < end; cursor = nextMonth(cursor)) {
    const key = monthKey(cursor);
    if (!Number.isFinite(liquidityValue(row, key))) missingMonths.push(key);
  }
  return {complete: missingMonths.length === 0, missingMonths};
}

function dataContract(appDir, artifactRows, activeStart, activeEnd) {
  const artifacts = {};
  const gaps = [];
  const hashes = [];
  for (const kind of M4_REQUIRED_ARTIFACTS) {
    const summary = artifactRows.get(kind) || artifactSummary(appDir, null);
    const interval = kind === 'price' ? H1 : kind === 'minute' ? 60_000 : null;
    const coverage = kind === 'funding'
      ? (() => {
        const boundary = fundingBoundary(summary, activeStart, activeEnd);
        const firstIntervalHours = Number(boundary.firstIntervalHours);
        const lastIntervalHours = Number(boundary.lastIntervalHours);
        const firstIntervalMs = Number.isFinite(firstIntervalHours) ? firstIntervalHours * M4_HOURS : null;
        const lastIntervalMs = Number.isFinite(lastIntervalHours) ? lastIntervalHours * M4_HOURS : null;
        const first = boundary.first;
        const last = boundary.last;
        const complete = summary.present && summary.nonEmpty && boundary.readError == null
          && Number.isFinite(firstIntervalMs) && Number.isFinite(lastIntervalMs)
          && Number.isFinite(first) && Number.isFinite(last)
          && first >= activeStart && first <= activeStart + firstIntervalMs
          && last < activeEnd && last >= activeEnd - lastIntervalMs;
        return {
          complete,
          first: iso(first),
          last: iso(last),
          firstIntervalHours: Number.isFinite(firstIntervalHours) ? firstIntervalHours : null,
          lastIntervalHours: Number.isFinite(lastIntervalHours) ? lastIntervalHours : null,
          startWindowHours: Number.isFinite(firstIntervalHours) ? firstIntervalHours : null,
          endWindowHours: Number.isFinite(lastIntervalHours) ? lastIntervalHours : null,
          reason: boundary.readError || !Number.isFinite(firstIntervalMs) || !Number.isFinite(lastIntervalMs) ? 'funding-interval-metadata-missing'
            : !Number.isFinite(first) || first < activeStart || first > activeStart + firstIntervalMs ? 'funding-start-outside-window'
              : !Number.isFinite(last) || last >= activeEnd || last < activeEnd - lastIntervalMs ? 'funding-end-window-not-covered' : null,
        };
      })()
      : coverageWindow(
        timestampValue(summary.firstObservedTimestamp ?? summary.firstTimestamp),
        timestampValue(summary.lastObservedTimestamp ?? summary.lastTimestamp),
        activeStart,
        activeEnd,
        interval,
      );
    const {file: _internalFile, ...portableSummary} = summary;
    artifacts[kind] = {...portableSummary, coverage};
    if (!summary.present || !summary.nonEmpty) gaps.push({kind, reason: !summary.present ? 'missing-artifact' : 'empty-artifact'});
    if (!summary.hashRecorded || !summary.present) hashes.push({kind, path: summary.path, reason: !summary.hashRecorded ? 'hash-not-recorded' : 'file-missing'});
    if (summary.declaredActiveStart != null && summary.declaredActiveStart > activeStart) gaps.push({kind, reason: 'declared-active-start-after-lifecycle-start'});
    if (summary.declaredActiveEnd != null && summary.declaredActiveEnd < activeEnd) gaps.push({kind, reason: 'declared-active-end-before-lifecycle-end'});
    if (!coverage.complete) gaps.push({kind, reason: coverage.reason || (coverage.startGap ? 'active-start-not-covered' : coverage.endGap ? 'active-end-not-covered' : 'observed-range-missing')});
  }
  return {complete: gaps.length === 0 && hashes.length === 0, artifacts, gaps, hashFailures: hashes};
}

function lifecycleEpisodes(record = {}) {
  const episodes = record.activeEpisodes || record.episodes;
  if (Array.isArray(episodes) && episodes.length) return episodes;
  return [record];
}

function exchangeInfoEvidenceAt(kind, timestamp, exchangeInfoEvidence) {
  const source = currentExchangeInfoEvidence(exchangeInfoEvidence);
  return {
    timestamp,
    source: kind === 'listing' ? 'Binance official exchangeInfo onboardDate' : 'Binance official exchangeInfo deliveryDate',
    url: source.url,
    path: source.path,
    sha256: source.sha256,
    exact: true,
    complete: Number.isFinite(timestamp) && validHash(source.sha256),
  };
}

function episodeEvidence(record, kind, currentMarket, exchangeInfoEvidence, allowCurrentFallback = true) {
  const prefix = kind === 'listing' ? 'listing' : 'delist';
  let result = evidence(record, prefix);
  const fallbackTime = kind === 'listing' ? timestampValue(currentMarket?.onboardDate) : timestampValue(currentMarket?.deliveryDate);
  if (allowCurrentFallback && !result.complete && Number.isFinite(fallbackTime) && (kind === 'listing' || fallbackTime > 0)) {
    result = exchangeInfoEvidenceAt(kind, fallbackTime, exchangeInfoEvidence);
  }
  return result;
}

function episodeRows({symbol, start, end, months, observedFirst, observedLast, boundary = {}, currentMarket, lifecycleRecord, exchangeInfoEvidence, archiveEvidence, snapshotAt, artifactRows, liquidityByMonth, liquidity30dAverageQuoteVolume, priceRows, appDir}) {
  const records = lifecycleEpisodes(lifecycleRecord);
  const currentDelivery = timestampValue(currentMarket?.deliveryDate);
  const currentActiveThroughEnd = Boolean(currentMarket) && Number.isFinite(snapshotAt) && snapshotAt >= end
    && !(Number.isFinite(currentDelivery) && currentDelivery < end);
  const rows = records.map((record, index) => {
    const allowCurrentFallback = records.length === 1 || index === records.length - 1;
    const listing = episodeEvidence(record, 'listing', currentMarket, exchangeInfoEvidence, allowCurrentFallback);
    const delist = episodeEvidence(record, 'delist', currentMarket, exchangeInfoEvidence, allowCurrentFallback);
    const listingTimestamp = Number.isFinite(listing.timestamp) ? listing.timestamp : null;
    const delistTimestamp = Number.isFinite(delist.timestamp) ? delist.timestamp : null;
    const activeBeforeDevelopment = hasArchiveBefore(months, start)
      || (Number.isFinite(observedFirst) && observedFirst < start)
      || (Number.isFinite(listingTimestamp) && listingTimestamp < start);
    const listingInsideDevelopment = Number.isFinite(listingTimestamp) && listingTimestamp >= start && listingTimestamp < end;
    const delistedInsideDevelopment = Number.isFinite(delistTimestamp) && delistTimestamp >= start && delistTimestamp < end;
    const activeThroughDevelopmentEnd = currentActiveThroughEnd
      || (Number.isFinite(delistTimestamp) && delistTimestamp >= end && delist.complete);
    const intervalOverlap = (listingTimestamp == null || listingTimestamp < end)
      && (delistTimestamp == null || delistTimestamp > start);
    const episodeStart = Math.max(start, Number.isFinite(listingTimestamp) ? listingTimestamp : start);
    const episodeEnd = Math.min(end, Number.isFinite(delistTimestamp) ? delistTimestamp : end);
    const episodeArchiveOverlap = hasArchiveOverlapInRange(months, episodeStart, episodeEnd)
      || (records.length === 1 && Number.isFinite(observedFirst) && Number.isFinite(observedLast)
        && observedFirst < episodeEnd && observedLast >= episodeStart);
    // A current exchangeInfo row alone is never a historical-universe
    // observation.  It can corroborate an archived/confirmed lifecycle, but
    // cannot make every current symbol part of the Development universe.
    const likelyActiveInDevelopment = intervalOverlap && (episodeArchiveOverlap || listingInsideDevelopment || delistedInsideDevelopment);
    const conflicts = [];
    const conflictClasses = [];
    const boundaryDiagnostics = [];
    const addConflict = (reason, conflictClass) => { conflicts.push(reason); if (!conflictClasses.includes(conflictClass)) conflictClasses.push(conflictClass); };
    const addBoundaryDiagnostic = diagnostic => { if (!boundaryDiagnostics.includes(diagnostic)) boundaryDiagnostics.push(diagnostic); };
    const minuteFirst = timestampValue(boundary.minuteFirst);
    const minuteLast = timestampValue(boundary.minuteLast);
    const hourlyFirst = timestampValue(boundary.hourlyFirst ?? observedFirst);
    const hourlyLast = timestampValue(boundary.hourlyLast ?? observedLast);
    let entryBoundaryEvidence = !listingInsideDevelopment || index !== 0;
    let exitBoundaryEvidence = !delistedInsideDevelopment || index !== records.length - 1;
    // firstObserved/lastObserved are symbol-level diagnostics. For a
    // relisted symbol they can span several episodes, so only compare the
    // outer evidence boundaries against them; an inner relist naturally
    // occurs after the first observation and before the last observation.
    if (index === 0 && Number.isFinite(listingTimestamp)) {
      if (Number.isFinite(minuteFirst)) {
        if (minuteFirst < listingTimestamp) addConflict('listing-after-first-observed', 'TRUE_LIFECYCLE_CONFLICT');
        else {
          entryBoundaryEvidence = true;
          addBoundaryDiagnostic('ARCHIVE_INTERVAL_ALIGNMENT');
        }
      } else if (Number.isFinite(hourlyFirst)
        && hourlyFirst <= listingTimestamp && listingTimestamp < hourlyFirst + H1) {
        entryBoundaryEvidence = true;
        addBoundaryDiagnostic('HOURLY_BOUNDARY_STRADDLE');
        addBoundaryDiagnostic('ARCHIVE_INTERVAL_ALIGNMENT');
      } else if (Number.isFinite(hourlyFirst)) {
        // An hourly open outside the listing interval is not minute-level
        // evidence of a lifecycle conflict. Keep it unresolved and fail closed.
        entryBoundaryEvidence = false;
      }
    }
    if (index === records.length - 1 && Number.isFinite(delistTimestamp)) {
      if (Number.isFinite(minuteLast)) {
        if (minuteLast >= delistTimestamp) addConflict('delist-at-or-before-last-observed', 'TRUE_LIFECYCLE_CONFLICT');
        else {
          exitBoundaryEvidence = true;
          addBoundaryDiagnostic('ARCHIVE_INTERVAL_ALIGNMENT');
        }
      } else if (Number.isFinite(hourlyLast)
        && hourlyLast < delistTimestamp && delistTimestamp <= hourlyLast + H1) {
        exitBoundaryEvidence = true;
        addBoundaryDiagnostic('HOURLY_BOUNDARY_STRADDLE');
        addBoundaryDiagnostic('ARCHIVE_INTERVAL_ALIGNMENT');
      } else if (Number.isFinite(hourlyLast)) {
        exitBoundaryEvidence = false;
      }
    }
    if (Number.isFinite(listingTimestamp) && Number.isFinite(delistTimestamp) && listingTimestamp >= delistTimestamp) {
      addConflict('listing-not-before-delist', 'TRUE_LIFECYCLE_CONFLICT');
    }
    if (likelyActiveInDevelopment && listingInsideDevelopment && !listing.complete) {
      addConflict('listing-evidence-missing-for-in-window-listing', 'EVIDENCE_MATCH_AMBIGUOUS');
    }
    if (likelyActiveInDevelopment && delistedInsideDevelopment && !(delist.complete && delist.exact)) {
      addConflict('delist-evidence-missing-for-in-window-delist', 'EVIDENCE_MATCH_AMBIGUOUS');
    }
    const entryBoundaryResolved = !likelyActiveInDevelopment || activeBeforeDevelopment
      || (listingInsideDevelopment && listing.complete && entryBoundaryEvidence);
    const exitBoundaryResolved = !likelyActiveInDevelopment || activeThroughDevelopmentEnd
      || (delistedInsideDevelopment && delist.complete && delist.exact)
      || (Number.isFinite(delistTimestamp) && delistTimestamp <= start && delist.complete && delist.exact);
    const resolvedExitBoundary = exitBoundaryResolved && (!delistedInsideDevelopment || exitBoundaryEvidence);
    if (likelyActiveInDevelopment && !entryBoundaryResolved) addConflict('entry-boundary-unresolved', 'ENTRY_UNRESOLVED');
    if (likelyActiveInDevelopment && !resolvedExitBoundary) addConflict('exit-boundary-unresolved', 'EXIT_UNRESOLVED');
    // Multiple independently evidenced active intervals are a first-class
    // lifecycle shape, not by themselves a contradiction. Keep the relist
    // signal visible for audit without turning valid episodes into a block.
    if (records.length > 1) conflictClasses.push('RELIST_EPISODE_DETECTED');
    const activeStart = Math.max(start, Number.isFinite(listingTimestamp) ? listingTimestamp : start);
    const activeEnd = Math.min(end, Number.isFinite(delistTimestamp) ? delistTimestamp : end);
    const entryEvidence = activeBeforeDevelopment ? archiveObservationEvidence(archiveEvidence) : listing;
    const exitEvidence = activeThroughDevelopmentEnd
      ? {...currentExchangeInfoEvidence(exchangeInfoEvidence), source: 'Binance USD-M snapshot after Development end', timestamp: snapshotAt}
      : delist;
    const data = likelyActiveInDevelopment && activeStart < activeEnd
      ? dataContract(appDir, artifactRows, activeStart, activeEnd)
      : {complete: true, artifacts: {}, gaps: [], hashFailures: []};
    return {
      episodeId: record.episodeId || record.id || `${symbol}|${index}`,
      activeStart: iso(activeStart), activeEnd: iso(activeEnd),
      listingTimestamp: iso(listingTimestamp), delistTimestamp: iso(delistTimestamp),
      listingEvidenceTimestamp: iso(listing.timestamp), listingEvidenceSource: listing.source,
      listingEvidenceUrl: listing.url, listingEvidencePath: listing.path, listingEvidenceSha256: listing.sha256,
      delistEvidenceTimestamp: iso(delist.timestamp), delistEvidenceSource: delist.source,
      delistEvidenceUrl: delist.url, delistEvidencePath: delist.path, delistEvidenceSha256: delist.sha256,
      activeBeforeDevelopment, listingInsideDevelopment, delistedInsideDevelopment, activeThroughDevelopmentEnd,
      likelyActiveInDevelopment, entryBoundaryResolved, exitBoundaryResolved: resolvedExitBoundary,
      noLifecycleConflict: conflicts.length === 0,
      pitWindowResolved: !likelyActiveInDevelopment || (entryBoundaryResolved && resolvedExitBoundary && conflicts.length === 0),
      lifecycleExact: !likelyActiveInDevelopment || (entryBoundaryResolved && resolvedExitBoundary && conflicts.length === 0),
      lifecycleConflictReasons: conflicts, lifecycleConflictClasses: conflictClasses,
      entryEvidenceSource: entryEvidence.source || null, entryEvidenceTimestamp: iso(entryEvidence.timestamp),
      entryEvidencePath: entryEvidence.path || null, entryEvidenceUrl: entryEvidence.url || null, entryEvidenceSha256: entryEvidence.sha256 || null,
      exitEvidenceSource: exitEvidence.source || null, exitEvidenceTimestamp: iso(exitEvidence.timestamp),
      exitEvidencePath: exitEvidence.path || null, exitEvidenceUrl: exitEvidence.url || null, exitEvidenceSha256: exitEvidence.sha256 || null,
      archiveEvidenceOverlap: episodeArchiveOverlap,
      lifecycleBoundaryDiagnostics: boundaryDiagnostics,
      data,
    };
  });
  return {rows, archiveOverlap: rows.some(row => row.archiveEvidenceOverlap), currentActiveThroughEnd};
}

export function resolvePitWindow({
  symbol,
  start = M4_DEVELOPMENT_START,
  end = M4_DEVELOPMENT_END,
  archiveRecord = {},
  firstObserved = null,
  lastObserved = null,
  currentMarket = null,
  lifecycleRecord = {},
  exchangeInfoEvidence = {},
  archiveEvidence = {},
  snapshotTimestamp = null,
  artifactRows = new Map(),
  liquidityByMonth = null,
  liquidity30dAverageQuoteVolume = null,
  priceRows = null,
  appDir = process.cwd(),
} = {}) {
  const months = archiveMonths(archiveRecord);
  const firstArchiveMonth = months[0] || null;
  const lastArchiveMonth = months.at(-1) || null;
  const observedFirst = timestampValue(firstObserved);
  const observedLast = timestampValue(lastObserved);
  const snapshotAt = timestampValue(snapshotTimestamp);
  const boundary = boundaryObservations(artifactRows, observedFirst, observedLast);
  const resolved = episodeRows({symbol, start, end, months, observedFirst, observedLast, boundary, currentMarket, lifecycleRecord, exchangeInfoEvidence, archiveEvidence, snapshotAt, artifactRows, liquidityByMonth, liquidity30dAverageQuoteVolume, priceRows, appDir});
  const episodes = resolved.rows;
  const relevantEpisodes = episodes.filter(row => row.likelyActiveInDevelopment);
  const likelyActiveInDevelopment = relevantEpisodes.length > 0;
  const firstEpisode = episodes[0] || {};
  const lastEpisode = episodes.at(-1) || {};
  const activeStart = relevantEpisodes.reduce((value, row) => Math.min(value, timestampValue(row.activeStart) ?? end), end);
  const activeEnd = relevantEpisodes.reduce((value, row) => Math.max(value, timestampValue(row.activeEnd) ?? start), start);
  const activeBeforeDevelopment = relevantEpisodes.some(row => row.activeBeforeDevelopment);
  const listingInsideDevelopment = relevantEpisodes.some(row => row.listingInsideDevelopment);
  const delistedInsideDevelopment = relevantEpisodes.some(row => row.delistedInsideDevelopment);
  const activeThroughDevelopmentEnd = relevantEpisodes.some(row => row.activeThroughDevelopmentEnd);
  const historicalDelisted = !currentMarket && (delistedInsideDevelopment || (lastArchiveMonth && lastArchiveMonth < monthKey(end)) || Boolean(lastEpisode.delistTimestamp));
  const conflicts = [...new Set(relevantEpisodes.flatMap(row => row.lifecycleConflictReasons || []))];
  const conflictClasses = [...new Set(relevantEpisodes.flatMap(row => row.lifecycleConflictClasses || []))];
  const boundaryDiagnostics = [...new Set(relevantEpisodes.flatMap(row => row.lifecycleBoundaryDiagnostics || []))];
  const entryBoundaryResolved = !likelyActiveInDevelopment || relevantEpisodes.every(row => row.entryBoundaryResolved);
  const exitBoundaryResolved = !likelyActiveInDevelopment || relevantEpisodes.every(row => row.exitBoundaryResolved);
  const noLifecycleConflict = conflicts.length === 0;
  const pitWindowResolved = !likelyActiveInDevelopment || relevantEpisodes.every(row => row.pitWindowResolved);
  const lifecycleExact = !likelyActiveInDevelopment || relevantEpisodes.every(row => row.lifecycleExact);
  const artifactPrice = artifactRows.get?.('price');
  const loadedPriceRows = likelyActiveInDevelopment
    ? (Array.isArray(priceRows) ? priceRows : readGzipRows(artifactPrice?.file))
    : [];
  const liquidityIndex = buildLiquidityIndex(loadedPriceRows);
  const liquidityRow = {activeStart: iso(activeStart), activeEnd: iso(activeEnd), liquidityByMonth, liquidity30dAverageQuoteVolume};
  Object.defineProperty(liquidityRow, '_liquidityIndex', {value: liquidityIndex, enumerable: false});
  const liquidityEvidence = likelyActiveInDevelopment && activeStart < activeEnd
    ? liquidityCoverage(liquidityRow, activeStart, activeEnd)
    : {complete: true, missingMonths: [], audit: {observations: 0, eligible: 0, available: 0, insufficientHistory: 0, gap: 0, belowThreshold: 0}};
  const allData = relevantEpisodes.map(row => row.data);
  const data = !likelyActiveInDevelopment ? {complete: true, artifacts: {}, gaps: [], hashFailures: []} : {
    complete: allData.every(row => row.complete),
    artifacts: allData[0]?.artifacts || {},
    gaps: allData.flatMap(row => row.gaps || []),
    hashFailures: allData.flatMap(row => row.hashFailures || []),
  };
  const firstListing = firstEpisode.listingEvidenceTimestamp ? firstEpisode : relevantEpisodes[0] || firstEpisode;
  const lastDelist = lastEpisode.delistEvidenceTimestamp ? lastEpisode : relevantEpisodes.at(-1) || lastEpisode;
  const row = {
    symbol,
    core: CORE_MARKETS.has(symbol), tier: CORE_MARKETS.has(symbol) ? 'core' : 'expanded',
    firstArchiveMonth, lastArchiveMonth, actualFirstArchiveMonth: firstArchiveMonth, actualLastArchiveMonth: lastArchiveMonth,
    archiveEvidenceSource: archiveEvidence.source || null, archiveEvidenceUrl: archiveEvidence.url || null,
    archiveEvidencePath: archiveEvidence.path || null, archiveEvidenceSha256: archiveEvidence.sha256 || null,
    firstObserved: iso(observedFirst), lastObserved: iso(observedLast),
    activeBeforeDevelopment, listingInsideDevelopment, archiveEvidenceOverlap: resolved.archiveOverlap,
    listingTimestamp: firstListing.listingTimestamp || null, listingAgeDays: listingAgeDaysAt({listingTimestamp: firstListing.listingTimestamp}, start),
    activeThroughDevelopmentEnd, delistedInsideDevelopment, delistTimestamp: lastDelist.delistTimestamp || null,
    eligibleStart: iso(activeStart), eligibleEnd: iso(activeEnd), activeStart: iso(activeStart), activeEnd: iso(activeEnd),
    historicalDelisted, likelyActiveInDevelopment, requiredForDevelopment: likelyActiveInDevelopment,
    entryBoundaryResolved, exitBoundaryResolved, noLifecycleConflict, pitWindowResolved, lifecycleExact,
    listingEvidenceTimestamp: firstListing.listingEvidenceTimestamp || null, listingEvidenceSource: firstListing.listingEvidenceSource || null,
    listingEvidenceUrl: firstListing.listingEvidenceUrl || null, listingEvidencePath: firstListing.listingEvidencePath || null, listingEvidenceSha256: firstListing.listingEvidenceSha256 || null,
    delistEvidenceTimestamp: lastDelist.delistEvidenceTimestamp || null, delistEvidenceSource: lastDelist.delistEvidenceSource || null,
    delistEvidenceUrl: lastDelist.delistEvidenceUrl || null, delistEvidencePath: lastDelist.delistEvidencePath || null, delistEvidenceSha256: lastDelist.delistEvidenceSha256 || null,
    entryEvidenceSource: firstListing.entryEvidenceSource || null, entryEvidenceTimestamp: firstListing.entryEvidenceTimestamp || null,
    entryEvidencePath: firstListing.entryEvidencePath || null, entryEvidenceUrl: firstListing.entryEvidenceUrl || null, entryEvidenceSha256: firstListing.entryEvidenceSha256 || null,
    exitEvidenceSource: lastDelist.exitEvidenceSource || null, exitEvidenceTimestamp: lastDelist.exitEvidenceTimestamp || null,
    exitEvidencePath: lastDelist.exitEvidencePath || null, exitEvidenceUrl: lastDelist.exitEvidenceUrl || null, exitEvidenceSha256: lastDelist.exitEvidenceSha256 || null,
    lifecycleConflictReasons: conflicts, lifecycleConflictClasses: conflictClasses,
    lifecycleBoundaryDiagnostics: boundaryDiagnostics,
    lifecycleConflictClass: conflictClasses[0] || null, activeEpisodes: episodes,
    currentMarketContractType: currentMarket?.contractType || null,
    marketFilters: currentMarket?.filters || null,
    data, liquidityByMonth, liquidity30dAverageQuoteVolume,
    liquidity: {...liquidityEvidence, thresholdUsdt: M4_LIQUIDITY_THRESHOLD_USDT, lookbackDays: M4_LIQUIDITY_LOOKBACK_DAYS},
  };
  Object.defineProperty(row, '_liquidityIndex', {value: liquidityIndex, enumerable: false});
  Object.defineProperty(row, '_liquidityByTimestamp', {value: new Map(), enumerable: false, writable: true});
  Object.defineProperty(row, '_liquidityAudit', {value: liquidityEvidence.audit || {}, enumerable: false, writable: true});
  return row;
}

export function monthlyPitCounts(markets, start = M4_DEVELOPMENT_START, end = M4_DEVELOPMENT_END) {
  const result = {};
  for (let cursor = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1); cursor < end; cursor = nextMonth(cursor)) {
    const monthEnd = Math.min(nextMonth(cursor), end);
    const key = monthKey(cursor);
    const active = (markets || []).filter(row => row.pitWindowResolved && (row.activeEpisodes || [{activeStart: row.activeStart, activeEnd: row.activeEnd}])
      .some(episode => timestampValue(episode.activeStart) < monthEnd && timestampValue(episode.activeEnd) > cursor));
    result[key] = {
      pitEligibleSymbols: active.length,
      core: active.filter(row => row.core).length,
      expanded: active.filter(row => !row.core).length,
    };
  }
  return result;
}

export function monthlyLiquidityCounts(markets, start = M4_DEVELOPMENT_START, end = M4_DEVELOPMENT_END) {
  const result = {};
  for (let cursor = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1); cursor < end; cursor = nextMonth(cursor)) {
    const monthEnd = Math.min(nextMonth(cursor), end);
    const key = monthKey(cursor);
    const active = (markets || []).filter(row => row.pitWindowResolved && (row.activeEpisodes || [{activeStart: row.activeStart, activeEnd: row.activeEnd}])
      .some(episode => timestampValue(episode.activeStart) < monthEnd && timestampValue(episode.activeEnd) > cursor));
    const evaluated = active.map(row => ({row, liquidity: liquidityEligibilityAt(row, monthEnd - 1)}));
    result[key] = {
      pitEligibleSymbols: evaluated.filter(item => item.liquidity.eligible).length,
      liquidityDataAvailable: evaluated.filter(item => item.liquidity.available).length,
      liquidityUnknown: evaluated.filter(item => !item.liquidity.available).length,
      core: evaluated.filter(item => item.liquidity.eligible && item.row.core).length,
      expanded: evaluated.filter(item => item.liquidity.eligible && !item.row.core).length,
    };
  }
  return result;
}

function artifactAvailableAt(artifact, timestamp) {
  if (!artifact?.present || !artifact.nonEmpty) return false;
  const first = timestampValue(artifact.firstTimestamp);
  const last = timestampValue(artifact.lastTimestamp);
  const t = timestampValue(timestamp);
  return Number.isFinite(first) && Number.isFinite(last) && Number.isFinite(t) && first <= t && t <= last;
}

export function isPitMarketDataAvailableAt(row, timestamp) {
  const artifacts = row?.data?.artifacts;
  if (!row?.data?.complete || !artifacts) return false;
  return M4_REQUIRED_ARTIFACTS.every(kind => artifactAvailableAt(artifacts[kind], timestamp));
}

export function buildPitUniverseAt(timestamp, markets, {requireData = true, requireLiquidity = false} = {}) {
  const t = timestampValue(timestamp);
  if (t == null) return [];
  return (markets || []).filter(row => row.pitWindowResolved
    && (row.activeEpisodes || [{activeStart: row.activeStart, activeEnd: row.activeEnd}]).some(episode => timestampValue(episode.activeStart) <= t && t < timestampValue(episode.activeEnd))
    && (!requireData || isPitMarketDataAvailableAt(row, t))
    && (!requireLiquidity || liquidityEligibilityAt(row, t, {allowMonthly: false}).eligible)).map(row => row.symbol).sort();
}

function canonicalUniverseRow(row) {
  return {
    symbol: row.symbol,
    core: row.core,
    tier: row.tier,
    firstArchiveMonth: row.firstArchiveMonth,
    lastArchiveMonth: row.lastArchiveMonth,
    actualFirstArchiveMonth: row.actualFirstArchiveMonth,
    actualLastArchiveMonth: row.actualLastArchiveMonth,
    archiveEvidenceSource: row.archiveEvidenceSource,
    archiveEvidenceUrl: row.archiveEvidenceUrl,
    archiveEvidencePath: row.archiveEvidencePath,
    archiveEvidenceSha256: row.archiveEvidenceSha256,
    firstObserved: row.firstObserved,
    lastObserved: row.lastObserved,
    eligibleStart: row.eligibleStart,
    eligibleEnd: row.eligibleEnd,
    activeBeforeDevelopment: row.activeBeforeDevelopment,
    archiveEvidenceOverlap: row.archiveEvidenceOverlap,
    listingInsideDevelopment: row.listingInsideDevelopment,
    listingTimestamp: row.listingTimestamp,
    listingAgeDays: row.listingAgeDays,
    activeThroughDevelopmentEnd: row.activeThroughDevelopmentEnd,
    delistedInsideDevelopment: row.delistedInsideDevelopment,
    delistTimestamp: row.delistTimestamp,
    listingEvidenceTimestamp: row.listingEvidenceTimestamp,
    listingEvidenceSource: row.listingEvidenceSource,
    listingEvidenceUrl: row.listingEvidenceUrl,
    listingEvidencePath: row.listingEvidencePath,
    listingEvidenceSha256: row.listingEvidenceSha256,
    delistEvidenceTimestamp: row.delistEvidenceTimestamp,
    delistEvidenceSource: row.delistEvidenceSource,
    delistEvidenceUrl: row.delistEvidenceUrl,
    delistEvidencePath: row.delistEvidencePath,
    delistEvidenceSha256: row.delistEvidenceSha256,
    entryBoundaryResolved: row.entryBoundaryResolved,
    exitBoundaryResolved: row.exitBoundaryResolved,
    lifecycleExact: row.lifecycleExact,
    liquidityByMonth: row.liquidityByMonth,
    liquidity30dAverageQuoteVolume: row.liquidity30dAverageQuoteVolume,
    liquidity: row.liquidity,
    pitWindowResolved: row.pitWindowResolved,
    lifecycleConflictReasons: row.lifecycleConflictReasons,
    lifecycleConflictClasses: row.lifecycleConflictClasses,
    lifecycleConflictClass: row.lifecycleConflictClass,
    lifecycleBoundaryDiagnostics: row.lifecycleBoundaryDiagnostics,
    activeEpisodes: row.activeEpisodes,
    requiredForDevelopment: row.requiredForDevelopment,
    likelyActiveInDevelopment: row.likelyActiveInDevelopment,
    currentMarketContractType: row.currentMarketContractType,
    marketFilters: row.marketFilters,
  };
}

export function buildPitUniverseFromFiles({
  appDir = process.cwd(),
  dataRoot = path.join(appDir, 'data', 'backtest'),
  start = M4_DEVELOPMENT_START,
  end = M4_DEVELOPMENT_END,
} = {}) {
  const manifestFile = path.join(dataRoot, 'manifest.json');
  const archiveFile = path.join(dataRoot, 'source', 'archive-index.json');
  const exchangeFile = path.join(dataRoot, 'source', 'current-exchangeInfo.json');
  const lifecycleFile = path.join(dataRoot, 'source', 'historical-lifecycle-evidence.json');
  if (!fs.existsSync(manifestFile) || !fs.existsSync(archiveFile) || !fs.existsSync(exchangeFile)) {
    return {status: 'M4_BLOCKED', blockers: [{reason: 'required-source-manifest-missing'}], markets: [], discoveredSymbols: [], unresolved: []};
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const archiveIndex = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
  const exchangeInfo = JSON.parse(fs.readFileSync(exchangeFile, 'utf8'));
  const lifecycle = fs.existsSync(lifecycleFile) ? JSON.parse(fs.readFileSync(lifecycleFile, 'utf8')) : {};
  const current = currentPerpetualMarkets(exchangeInfo);
  const excludedTradfiSymbols = tradfiPerpetualSymbols(exchangeInfo);
  const lifecycleBySymbol = evidenceMap(lifecycle);
  const artifacts = artifactMap(manifest);
  const manifestMarkets = new Map((manifest.universe?.markets || manifest.markets || [])
    .filter(row => row?.symbol)
    .map(row => [row.symbol, row]));
  const archiveSymbols = archiveIndex.symbolsWithActualArchives || Object.keys(archiveIndex.actualArchiveKeysBySymbol || {});
  const currentSymbols = [...current.keys()];
  const globalDiscoveredSymbols = [...new Set([...archiveSymbols, ...currentSymbols, ...excludedTradfiSymbols])]
    .filter(symbol => /^[A-Z0-9]+USDT$/.test(symbol)).sort();
  const discoveredSymbols = [...new Set([...archiveSymbols, ...currentSymbols])]
    .filter(symbol => /^[A-Z0-9]+USDT$/.test(symbol) && !excludedTradfiSymbols.includes(symbol)).sort();
  const exchangeInfoEvidence = currentExchangeInfoEvidence({
    path: path.relative(appDir, exchangeFile).replaceAll('\\', '/'),
    sha256: hashFile(exchangeFile),
  });
  const archiveEvidence = archiveObservationEvidence({
    path: path.relative(appDir, archiveFile).replaceAll('\\', '/'),
    sha256: hashFile(archiveFile),
  });
  const markets = discoveredSymbols.map(symbol => {
    const symbolArtifacts = new Map();
    for (const kind of M4_REQUIRED_ARTIFACTS) symbolArtifacts.set(kind, artifactSummary(appDir, artifacts.get(`${symbol}|${kind}`)));
    const symbolArtifactRows = new Map([...M4_REQUIRED_ARTIFACTS].map(kind => [kind, artifacts.get(symbol + '|' + kind)]));
    const range = observedRange(symbolArtifactRows);
    return resolvePitWindow({
      symbol,
      start,
      end,
      archiveRecord: archiveIndex.actualArchiveKeysBySymbol?.[symbol] || {},
      firstObserved: range.first,
      lastObserved: range.last,
      currentMarket: current.get(symbol) || null,
      lifecycleRecord: lifecycleBySymbol.get(symbol) || {},
      exchangeInfoEvidence,
      archiveEvidence,
      snapshotTimestamp: manifest.snapshotTimestamp,
      artifactRows: symbolArtifacts,
      liquidityByMonth: manifestMarkets.get(symbol)?.liquidityByMonth || manifestMarkets.get(symbol)?.monthlyLiquidity || null,
      liquidity30dAverageQuoteVolume: manifestMarkets.get(symbol)?.liquidity30dAverageQuoteVolume ?? manifestMarkets.get(symbol)?.average30dQuoteVolume ?? null,
      appDir,
    });
  });
  const activeMarkets = markets.filter(row => row.requiredForDevelopment);
  const developmentArchiveSymbols = activeMarkets.filter(row => row.archiveEvidenceOverlap).map(row => row.symbol).sort();
  const developmentRelevantSymbols = activeMarkets.map(row => row.symbol).sort();
  const unresolved = activeMarkets.filter(row => !row.pitWindowResolved).map(row => ({
    symbol: row.symbol,
    reasons: row.lifecycleConflictReasons,
    conflictClasses: row.lifecycleConflictClasses,
    firstArchiveMonth: row.firstArchiveMonth,
    lastArchiveMonth: row.lastArchiveMonth,
  }));
  const dataGaps = activeMarkets.flatMap(row => row.data.gaps.map(gap => ({symbol: row.symbol, ...gap})));
  const hashFailures = activeMarkets.flatMap(row => row.data.hashFailures.map(failure => ({symbol: row.symbol, ...failure})));
  const liquidityUnknown = activeMarkets.filter(row => !row.liquidity.complete).map(row => ({symbol: row.symbol, missingMonths: row.liquidity.missingMonths, audit: row.liquidity.audit || null}));
  const liquidityAudit = activeMarkets.reduce((result, row) => {
    const audit = row.liquidity.audit || {};
    result.observations += Number(audit.observations || 0);
    result.eligible += Number(audit.eligible || 0);
    result.insufficientHistory += Number(audit.insufficientHistory || 0);
    result.gap += Number(audit.gap || 0);
    result.belowThreshold += Number(audit.belowThreshold || 0);
    return result;
  }, {observations: 0, eligible: 0, insufficientHistory: 0, gap: 0, belowThreshold: 0});
  const canonical = markets.map(canonicalUniverseRow);
  const pitUniverseSha256 = sha256(JSON.stringify(canonical));
  const sourceFiles = [manifestFile, archiveFile, exchangeFile, lifecycleFile].filter(fs.existsSync);
  const universeEvidenceSha256 = sha256(sourceFiles.map(file => `${path.basename(file)}:${hashFile(file)}`).join('\n'));
  const manifestDataContractReady = manifest.status === 'COMPLETE'
    && manifest.universe?.pointInTime === true
    && manifest.universe?.historicalDelistingsResolved === true
    && manifest.universe?.expandedNonCoreCovered === true
    && manifest.execution?.preferredInterval === '1m'
    && manifest.execution?.oneMinuteAvailable === true;
  const historicalDelistingsResolved = activeMarkets.filter(row => row.historicalDelisted)
    .every(row => row.lifecycleExact && row.exitBoundaryResolved);
  const expandedActiveMarkets = activeMarkets.filter(row => !row.core);
  const expandedNonCoreCovered = expandedActiveMarkets.length > 0
    && expandedActiveMarkets.every(row => row.pitWindowResolved && row.lifecycleExact && row.data.complete);
  // This is the Development-window gate.  It deliberately does not depend
  // on a global current-symbol lifecycle result or on the legacy manifest
  // booleans; those remain diagnostics below.
  const m4WindowDataContractReady = activeMarkets.length > 0
    && activeMarkets.every(row => row.pitWindowResolved && row.data.complete && row.data.artifacts
      && M4_REQUIRED_ARTIFACTS.every(kind => row.data.artifacts[kind]?.present && row.data.artifacts[kind]?.nonEmpty));
  const pointInTime = unresolved.length === 0
    && developmentRelevantSymbols.length > 0
    && hashFailures.length === 0
    && dataGaps.length === 0
    && historicalDelistingsResolved
    && m4WindowDataContractReady;
  const globalResolved = markets.length > 0
    && markets.every(row => row.lifecycleExact)
    && activeMarkets.length > 0
    && activeMarkets.every(row => row.pitWindowResolved && row.lifecycleExact && row.data.complete)
    && historicalDelistingsResolved
    && expandedNonCoreCovered
    && liquidityUnknown.length === 0;
  const blockers = [];
  if (!unresolved.length) {
    // No-op: keeping the release decision data-driven avoids asserting a
    // global lifecycle result from a static current exchangeInfo list.
  } else blockers.push({reason: 'unresolved-pit-lifecycle', count: unresolved.length, symbols: unresolved.map(row => row.symbol)});
  if (dataGaps.length) blockers.push({reason: 'required-data-gaps', count: dataGaps.length});
  if (hashFailures.length) blockers.push({reason: 'artifact-hash-failures', count: hashFailures.length});
  if (!globalDiscoveredSymbols.length || !activeMarkets.length) blockers.push({reason: 'empty-pit-universe', count: globalDiscoveredSymbols.length ? activeMarkets.length : 0});
  if (!m4WindowDataContractReady) blockers.push({reason: 'm4-window-data-contract-incomplete'});
  if (!expandedNonCoreCovered) blockers.push({reason: 'expanded-non-core-data-incomplete', count: expandedActiveMarkets.filter(row => !row.data.complete).length});
  return {
    status: pointInTime ? 'M4_PIT_WINDOW_COMPLETE' : 'M4_BLOCKED',
    start: iso(start),
    end: iso(end),
    snapshotTimestamp: manifest.snapshotTimestamp || null,
    discoveredSymbols,
    globalDiscoveredSymbols,
    developmentArchiveSymbols,
    developmentRelevantSymbols,
    excludedTradfiSymbols,
    currentSymbols: discoveredSymbols.filter(symbol => current.has(symbol)),
    historicalDelistedSymbols: developmentRelevantSymbols.filter(symbol => !current.has(symbol)),
    listedDuringDevelopment: markets.filter(row => row.listingInsideDevelopment).map(row => row.symbol),
    delistedDuringDevelopment: markets.filter(row => row.delistedInsideDevelopment).map(row => row.symbol),
    markets,
    activeMarkets,
    unresolved,
    resolvedLifecycleSymbols: activeMarkets.filter(row => row.pitWindowResolved).map(row => row.symbol).sort(),
    lifecycleConflicts: markets.filter(row => row.lifecycleConflictReasons.length).map(row => ({symbol: row.symbol, reasons: row.lifecycleConflictReasons, conflictClasses: row.lifecycleConflictClasses})),
    trueLifecycleConflicts: activeMarkets.filter(row => (row.lifecycleConflictClasses || []).includes('TRUE_LIFECYCLE_CONFLICT')).map(row => row.symbol).sort(),
    ambiguousEvidenceMatches: activeMarkets.filter(row => (row.lifecycleConflictClasses || []).includes('EVIDENCE_MATCH_AMBIGUOUS')).map(row => row.symbol).sort(),
    relistEpisodeSymbols: activeMarkets.filter(row => (row.lifecycleConflictClasses || []).includes('RELIST_EPISODE_DETECTED')).map(row => row.symbol).sort(),
    hourlyBoundaryStraddleSymbols: activeMarkets.filter(row => (row.lifecycleBoundaryDiagnostics || []).includes('HOURLY_BOUNDARY_STRADDLE')).map(row => row.symbol).sort(),
    archiveIntervalAlignmentSymbols: activeMarkets.filter(row => (row.lifecycleBoundaryDiagnostics || []).includes('ARCHIVE_INTERVAL_ALIGNMENT')).map(row => row.symbol).sort(),
    developmentActiveEpisodes: activeMarkets.flatMap(row => (row.activeEpisodes || []).filter(episode => episode.likelyActiveInDevelopment).map(episode => ({symbol: row.symbol, ...episode}))),
    multiEpisodeSymbols: activeMarkets.filter(row => (row.activeEpisodes || []).filter(episode => episode.likelyActiveInDevelopment).length > 1).map(row => row.symbol).sort(),
    monthlyPitUniverse: monthlyPitCounts(markets, start, end),
    monthlyLiquidityEligible: monthlyLiquidityCounts(markets, start, end),
    dataGaps,
    hashFailures,
    liquidityUnknown,
    liquidityEligibleObservations: liquidityAudit.eligible,
    liquidityRejectedInsufficientHistory: liquidityAudit.insufficientHistory,
    liquidityRejectedGap: liquidityAudit.gap,
    liquidityRejectedBelowThreshold: liquidityAudit.belowThreshold,
    dataIntegrity: {
      requiredArtifacts: M4_REQUIRED_ARTIFACTS,
      artifactRows: Object.fromEntries(M4_REQUIRED_ARTIFACTS.map(kind => [kind, markets.reduce((sum, row) => sum + Number(row.data.artifacts?.[kind]?.rows || 0), 0)])),
      completeActiveMarkets: activeMarkets.filter(row => row.data.complete).length,
      activeMarkets: activeMarkets.length,
      hashFailures: hashFailures.length,
      gaps: dataGaps.length,
      liquidityUnknown: liquidityUnknown.length,
      liquidityEligibleObservations: liquidityAudit.eligible,
      liquidityRejectedInsufficientHistory: liquidityAudit.insufficientHistory,
      liquidityRejectedGap: liquidityAudit.gap,
      liquidityRejectedBelowThreshold: liquidityAudit.belowThreshold,
    },
    pointInTime,
    historicalDelistingsResolved,
    expandedNonCoreCovered,
    manifestDataContractReady,
    m4WindowDataContractReady,
    m4PitWindowComplete: pointInTime,
    m4GlobalComplete: globalResolved,
    pitUniverseSha256,
    universeEvidenceSha256,
    datasetManifestSha256: hashFile(manifestFile),
    sourceFiles: sourceFiles.map(file => ({path: path.relative(appDir, file).replaceAll('\\', '/'), sha256: hashFile(file)})),
    blockers,
  };
}
