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

function currentPerpetualMarkets(exchangeInfo) {
  return new Map((exchangeInfo?.symbols || [])
    .filter(row => row?.quoteAsset === 'USDT' && ['PERPETUAL', 'TRADIFI_PERPETUAL'].includes(row?.contractType))
    .map(row => [row.symbol, row]));
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
  const price = artifacts.get('price');
  return {
    first: timestampValue(price?.firstTimestamp ?? price?.firstObservedTimestamp),
    last: timestampValue(price?.lastTimestamp ?? price?.lastObservedTimestamp),
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
    source: row?.liquidityByMonth || row?.monthlyLiquidity ? 'point-in-time-monthly-30d-average' : Number.isFinite(volume) ? 'point-in-time-30d-average' : null,
  };
}

function liquidityCoverage(row, start, end) {
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
      : coverageWindow(summary.firstTimestamp, summary.lastTimestamp, activeStart, activeEnd, interval);
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
  appDir = process.cwd(),
} = {}) {
  const months = archiveMonths(archiveRecord);
  const firstArchiveMonth = months[0] || null;
  const lastArchiveMonth = months.at(-1) || null;
  const observedFirst = timestampValue(firstObserved);
  const observedLast = timestampValue(lastObserved);
  let listing = evidence(lifecycleRecord, 'listing');
  const currentOnboard = timestampValue(currentMarket?.onboardDate);
  if (!listing.complete && Number.isFinite(currentOnboard)) {
    listing = {...evidence({}, 'listing', {...currentExchangeInfoEvidence(exchangeInfoEvidence), timestamp: currentOnboard}), timestamp: currentOnboard, exact: true, complete: true, source: 'Binance official exchangeInfo onboardDate', url: exchangeInfoEvidence.url, path: exchangeInfoEvidence.path, sha256: exchangeInfoEvidence.sha256};
  }
  const externalDelist = evidence(lifecycleRecord, 'delist');
  const delivery = timestampValue(currentMarket?.deliveryDate);
  let delist = externalDelist;
  if (!delist.complete && Number.isFinite(delivery) && delivery > 0) {
    delist = {...evidence({}, 'delist', {...currentExchangeInfoEvidence(exchangeInfoEvidence), timestamp: delivery}), timestamp: delivery, exact: true, complete: true, source: 'Binance official exchangeInfo deliveryDate', url: exchangeInfoEvidence.url, path: exchangeInfoEvidence.path, sha256: exchangeInfoEvidence.sha256};
  }
  const snapshotAt = timestampValue(snapshotTimestamp);
  const currentActiveThroughEnd = Boolean(currentMarket) && Number.isFinite(snapshotAt) && snapshotAt >= end && !(Number.isFinite(delivery) && delivery < end);
  const delistTimestamp = Number.isFinite(delist.timestamp) ? delist.timestamp : null;
  const listingTimestamp = Number.isFinite(listing.timestamp) ? listing.timestamp : null;
  const activeBeforeDevelopment = hasArchiveBefore(months, start)
    || (Number.isFinite(observedFirst) && observedFirst < start)
    || (Number.isFinite(listingTimestamp) && listingTimestamp < start);
  const listingInsideDevelopment = Number.isFinite(listingTimestamp) && listingTimestamp >= start && listingTimestamp < end;
  const archiveOverlap = hasArchiveOverlap(months, start, end)
    || (Number.isFinite(observedFirst) && Number.isFinite(observedLast) && observedFirst < end && observedLast >= start);
  const likelyActiveInDevelopment = archiveOverlap || listingInsideDevelopment || (activeBeforeDevelopment && (currentActiveThroughEnd || (delistTimestamp != null && delistTimestamp > start)));
  const delistedInsideDevelopment = Number.isFinite(delistTimestamp) && delistTimestamp >= start && delistTimestamp < end;
  const activeThroughDevelopmentEnd = currentActiveThroughEnd || (Number.isFinite(delistTimestamp) && delistTimestamp >= end && delist.complete);
  const historicalDelisted = !currentMarket && (delistTimestamp != null || (lastArchiveMonth && lastArchiveMonth < monthKey(end)));
  const conflicts = [];
  if (Number.isFinite(listingTimestamp) && Number.isFinite(observedFirst) && listingTimestamp > observedFirst) conflicts.push('listing-after-first-observed');
  if (Number.isFinite(delistTimestamp) && Number.isFinite(observedLast) && observedLast >= delistTimestamp) conflicts.push('delist-at-or-before-last-observed');
  if (Number.isFinite(listingTimestamp) && Number.isFinite(delistTimestamp) && listingTimestamp >= delistTimestamp) conflicts.push('listing-not-before-delist');
  if (likelyActiveInDevelopment && listingInsideDevelopment && !listing.complete) conflicts.push('listing-evidence-missing-for-in-window-listing');
  if (likelyActiveInDevelopment && delistedInsideDevelopment && !(delist.complete && delist.exact)) conflicts.push('delist-evidence-missing-for-in-window-delist');
  if (likelyActiveInDevelopment && !activeBeforeDevelopment && !listingInsideDevelopment) conflicts.push('entry-boundary-unresolved');
  if (likelyActiveInDevelopment && !activeThroughDevelopmentEnd && !delistedInsideDevelopment) conflicts.push('exit-boundary-unresolved');
  const entryBoundaryResolved = !likelyActiveInDevelopment
    || activeBeforeDevelopment
    || (listingInsideDevelopment && listing.complete);
  const exitBoundaryResolved = !likelyActiveInDevelopment
    || activeThroughDevelopmentEnd
    || (delistedInsideDevelopment && delist.complete && delist.exact)
    || (Number.isFinite(delistTimestamp) && delistTimestamp <= start && delist.complete && delist.exact);
  const noLifecycleConflict = conflicts.length === 0;
  const pitWindowResolved = !likelyActiveInDevelopment || (entryBoundaryResolved && exitBoundaryResolved && noLifecycleConflict);
  // Current markets can be proven active through the Development boundary by
  // the post-window exchangeInfo snapshot; a historical delisted market must
  // additionally carry both independently auditable lifecycle evidences.
  const historicalLifecycleResolved = !historicalDelisted || (listing.complete && delist.complete);
  const lifecycleExact = entryBoundaryResolved && exitBoundaryResolved && noLifecycleConflict && historicalLifecycleResolved;
  const activeStart = Math.max(start, Number.isFinite(listingTimestamp) ? listingTimestamp : start);
  const activeEnd = Math.min(end, Number.isFinite(delistTimestamp) ? delistTimestamp : end);
  const data = likelyActiveInDevelopment && activeStart < activeEnd
    ? dataContract(appDir, artifactRows, activeStart, activeEnd)
    : {complete: true, artifacts: {}, gaps: [], hashFailures: []};
  const liquidity = {liquidityByMonth, liquidity30dAverageQuoteVolume};
  const liquidityEvidence = liquidityCoverage(liquidity, activeStart, activeEnd);
  const entryEvidence = activeBeforeDevelopment
    ? archiveObservationEvidence(archiveEvidence)
    : listing;
  const exitEvidence = activeThroughDevelopmentEnd
    ? {...currentExchangeInfoEvidence(exchangeInfoEvidence), source: 'Binance USD-M snapshot after Development end', timestamp: snapshotAt}
    : delist;
  return {
    symbol,
    core: CORE_MARKETS.has(symbol),
    tier: CORE_MARKETS.has(symbol) ? 'core' : 'expanded',
    firstArchiveMonth,
    lastArchiveMonth,
    actualFirstArchiveMonth: firstArchiveMonth,
    actualLastArchiveMonth: lastArchiveMonth,
    archiveEvidenceSource: archiveEvidence.source || null,
    archiveEvidenceUrl: archiveEvidence.url || null,
    archiveEvidencePath: archiveEvidence.path || null,
    archiveEvidenceSha256: archiveEvidence.sha256 || null,
    firstObserved: iso(observedFirst),
    lastObserved: iso(observedLast),
    activeBeforeDevelopment,
    listingInsideDevelopment,
    listingTimestamp: iso(listingTimestamp),
    listingAgeDays: listingAgeDaysAt({listingTimestamp}, start),
    activeThroughDevelopmentEnd,
    delistedInsideDevelopment,
    delistTimestamp: iso(delistTimestamp),
    eligibleStart: iso(activeStart),
    eligibleEnd: iso(activeEnd),
    activeStart: iso(activeStart),
    activeEnd: iso(activeEnd),
    historicalDelisted,
    likelyActiveInDevelopment,
    requiredForDevelopment: likelyActiveInDevelopment,
    entryBoundaryResolved,
    exitBoundaryResolved,
    noLifecycleConflict,
    pitWindowResolved,
    lifecycleExact,
    listingEvidenceSource: listing.source,
    listingEvidenceTimestamp: iso(listing.timestamp),
    listingEvidenceUrl: listing.url,
    listingEvidencePath: listing.path,
    listingEvidenceSha256: listing.sha256,
    delistEvidenceSource: delist.source,
    delistEvidenceTimestamp: iso(delist.timestamp),
    delistEvidenceUrl: delist.url,
    delistEvidencePath: delist.path,
    delistEvidenceSha256: delist.sha256,
    entryEvidenceSource: entryEvidence.source || null,
    entryEvidenceTimestamp: iso(entryEvidence.timestamp ?? (activeBeforeDevelopment ? observedFirst : listingTimestamp)),
    entryEvidencePath: entryEvidence.path || null,
    entryEvidenceUrl: entryEvidence.url || null,
    entryEvidenceSha256: entryEvidence.sha256 || null,
    exitEvidenceSource: exitEvidence.source || null,
    exitEvidenceTimestamp: iso(exitEvidence.timestamp ?? delistTimestamp),
    exitEvidencePath: exitEvidence.path || null,
    exitEvidenceUrl: exitEvidence.url || null,
    exitEvidenceSha256: exitEvidence.sha256 || null,
    lifecycleConflictReasons: conflicts,
    data,
    liquidityByMonth,
    liquidity30dAverageQuoteVolume,
    liquidity: {
      ...liquidityEvidence,
      thresholdUsdt: M4_LIQUIDITY_THRESHOLD_USDT,
      lookbackDays: M4_LIQUIDITY_LOOKBACK_DAYS,
    },
  };
}

export function monthlyPitCounts(markets, start = M4_DEVELOPMENT_START, end = M4_DEVELOPMENT_END) {
  const result = {};
  for (let cursor = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1); cursor < end; cursor = nextMonth(cursor)) {
    const monthEnd = Math.min(nextMonth(cursor), end);
    const key = monthKey(cursor);
    const active = (markets || []).filter(row => row.pitWindowResolved && row.activeStart && row.activeEnd
      && timestampValue(row.activeStart) < monthEnd && timestampValue(row.activeEnd) > cursor);
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
    const active = (markets || []).filter(row => row.pitWindowResolved && row.activeStart && row.activeEnd
      && timestampValue(row.activeStart) < monthEnd && timestampValue(row.activeEnd) > cursor);
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
    && timestampValue(row.activeStart) <= t
    && t < timestampValue(row.activeEnd)
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
  const lifecycleBySymbol = evidenceMap(lifecycle);
  const artifacts = artifactMap(manifest);
  const manifestMarkets = new Map((manifest.universe?.markets || manifest.markets || [])
    .filter(row => row?.symbol)
    .map(row => [row.symbol, row]));
  const archiveSymbols = archiveIndex.symbolsWithActualArchives || Object.keys(archiveIndex.actualArchiveKeysBySymbol || {});
  const currentSymbols = [...current.keys()];
  const discoveredSymbols = [...new Set([...archiveSymbols, ...currentSymbols])]
    .filter(symbol => /^[A-Z0-9]+USDT$/.test(symbol))
    .sort();
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
    const range = observedRange(new Map([['price', artifacts.get(`${symbol}|price`)]]));
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
  const unresolved = activeMarkets.filter(row => !row.pitWindowResolved).map(row => ({
    symbol: row.symbol,
    reasons: row.lifecycleConflictReasons,
    firstArchiveMonth: row.firstArchiveMonth,
    lastArchiveMonth: row.lastArchiveMonth,
  }));
  const dataGaps = activeMarkets.flatMap(row => row.data.gaps.map(gap => ({symbol: row.symbol, ...gap})));
  const hashFailures = activeMarkets.flatMap(row => row.data.hashFailures.map(failure => ({symbol: row.symbol, ...failure})));
  const liquidityUnknown = activeMarkets.filter(row => !row.liquidity.complete).map(row => ({symbol: row.symbol, missingMonths: row.liquidity.missingMonths}));
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
  const historicalDelistingsResolved = markets.filter(row => row.historicalDelisted)
    .every(row => row.lifecycleExact && row.listingEvidenceTimestamp && row.delistEvidenceTimestamp);
  const expandedActiveMarkets = activeMarkets.filter(row => !row.core);
  const expandedNonCoreCovered = expandedActiveMarkets.length > 0
    && expandedActiveMarkets.every(row => row.pitWindowResolved && row.lifecycleExact && row.data.complete);
  const pointInTime = unresolved.length === 0
    && discoveredSymbols.length > 0
    && activeMarkets.length > 0
    && hashFailures.length === 0
    && dataGaps.length === 0
    && historicalDelistingsResolved
    && liquidityUnknown.length === 0
    && manifestDataContractReady;
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
  if (!discoveredSymbols.length || !activeMarkets.length) blockers.push({reason: 'empty-pit-universe', count: discoveredSymbols.length ? activeMarkets.length : 0});
  if (liquidityUnknown.length) blockers.push({reason: 'point-in-time-liquidity-metadata-missing', count: liquidityUnknown.length, symbols: liquidityUnknown.map(row => row.symbol)});
  if (!manifestDataContractReady) blockers.push({reason: 'manifest-strict-data-contract-incomplete'});
  if (!expandedNonCoreCovered) blockers.push({reason: 'expanded-non-core-data-incomplete', count: expandedActiveMarkets.filter(row => !row.data.complete).length});
  return {
    status: pointInTime ? 'M4_PIT_WINDOW_COMPLETE' : 'M4_BLOCKED',
    start: iso(start),
    end: iso(end),
    snapshotTimestamp: manifest.snapshotTimestamp || null,
    discoveredSymbols,
    currentSymbols: discoveredSymbols.filter(symbol => current.has(symbol)),
    historicalDelistedSymbols: discoveredSymbols.filter(symbol => !current.has(symbol)),
    listedDuringDevelopment: markets.filter(row => row.listingInsideDevelopment).map(row => row.symbol),
    delistedDuringDevelopment: markets.filter(row => row.delistedInsideDevelopment).map(row => row.symbol),
    markets,
    activeMarkets,
    unresolved,
    lifecycleConflicts: markets.filter(row => row.lifecycleConflictReasons.length).map(row => ({symbol: row.symbol, reasons: row.lifecycleConflictReasons})),
    monthlyPitUniverse: monthlyPitCounts(markets, start, end),
    monthlyLiquidityEligible: monthlyLiquidityCounts(markets, start, end),
    dataGaps,
    hashFailures,
    liquidityUnknown,
    dataIntegrity: {
      requiredArtifacts: M4_REQUIRED_ARTIFACTS,
      artifactRows: Object.fromEntries(M4_REQUIRED_ARTIFACTS.map(kind => [kind, markets.reduce((sum, row) => sum + Number(row.data.artifacts?.[kind]?.rows || 0), 0)])),
      completeActiveMarkets: activeMarkets.filter(row => row.data.complete).length,
      activeMarkets: activeMarkets.length,
      hashFailures: hashFailures.length,
      gaps: dataGaps.length,
      liquidityUnknown: liquidityUnknown.length,
    },
    pointInTime,
    historicalDelistingsResolved,
    expandedNonCoreCovered,
    manifestDataContractReady,
    m4PitWindowComplete: pointInTime,
    m4GlobalComplete: globalResolved,
    pitUniverseSha256,
    universeEvidenceSha256,
    datasetManifestSha256: hashFile(manifestFile),
    sourceFiles: sourceFiles.map(file => ({path: path.relative(appDir, file).replaceAll('\\', '/'), sha256: hashFile(file)})),
    blockers,
  };
}
