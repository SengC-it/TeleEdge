import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import zlib from 'node:zlib';
import {APP_DIR, H1, H4} from '../src/config.mjs';
import {buildFundingQuery, buildMinuteQuery} from '../src/v9/replay.mjs';
import {buildV9FeatureSeries} from '../src/v9/features.mjs';
import {CANONICAL_OUTCOME_CONTRACT} from '../src/profit-engine/labels.mjs';
import {simulateCanonicalOutcome} from '../src/profit-engine/canonical-outcome.mjs';
import {auditProductionIsolation, auditRepoNoOrder} from '../src/profit-engine/audits.mjs';
import {stopForPoint} from '../src/v81/features.mjs';
import {
  EVENT_DEFINITION_VERSION,
  EVENT_DEFINITIONS,
  EVENT_FAMILIES,
  EVENT_KEEP_GATE,
  EVENT_REFRACTORY_HOURS,
  eventResearchGate,
} from '../src/m4/event-engine.mjs';
import {runEventResearch} from './run-m4-event-regime.mjs';
import {
  OBSERVED_PIT_DEVELOPMENT_END,
  OBSERVED_PIT_DEVELOPMENT_START,
  OBSERVED_PIT_LIQUIDITY_THRESHOLD_USDT,
  artifactFile,
  buildObservedMarket,
  buildObservedPITSnapshots,
  discoverObservedArchiveUniverse,
  monthlyObservedCoverage,
  observedAnnouncementEvidenceIsUsdM,
  observedPitGate,
  observedPitDataLossSummary,
  observedPitInvariantAudit,
  normalizeHourlyRows,
  observedTradabilityCodeAt,
  sha256File,
} from '../src/m4/observed-pit-universe.mjs';

const DEFAULT_DATA_ROOT = path.join(APP_DIR, 'data', 'backtest');
const DEFAULT_REPORTS_DIR = path.join(APP_DIR, 'reports');
const DEVELOPMENT_START = OBSERVED_PIT_DEVELOPMENT_START;
const DEVELOPMENT_END = OBSERVED_PIT_DEVELOPMENT_END;
const MINUTE_MS = 60_000;

function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function iso(value) { return value == null ? null : new Date(Number(value)).toISOString(); }
function mean(values) { const usable = values.map(Number).filter(Number.isFinite); return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null; }
function median(values) { const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return null; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function parseArgs(argv = process.argv.slice(2)) {
  const result = {dataRoot: DEFAULT_DATA_ROOT, reportsDir: DEFAULT_REPORTS_DIR, start: DEVELOPMENT_START, end: DEVELOPMENT_END};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--data-root') result.dataRoot = path.resolve(argv[++index]);
    else if (argv[index] === '--reports-dir') result.reportsDir = path.resolve(argv[++index]);
    else if (argv[index] === '--start') result.start = Date.parse(argv[++index]);
    else if (argv[index] === '--end') result.end = Date.parse(argv[++index]);
  }
  if (!Number.isFinite(result.start) || !Number.isFinite(result.end) || result.start >= result.end) throw new Error('invalid development window');
  return result;
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, value, {flag: 'wx'});
  fs.renameSync(temporary, file);
}

function writeJson(file, value) { atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`); }

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readArtifact(file, expected, tracker, key) {
  if (!file || !fs.existsSync(file)) {
    tracker.set(key, {file, present: false, rows: 0, actualSha256: null, expectedSha256: expected?.sha256 || null, hashVerified: false, error: 'missing'});
    return {rows: [], actualSha256: null, error: 'missing'};
  }
  try {
    const compressed = fs.readFileSync(file);
    const actualSha256 = crypto.createHash('sha256').update(compressed).digest('hex');
    const text = zlib.gunzipSync(compressed).toString('utf8').trim();
    const rows = text ? JSON.parse(text) : [];
    const array = Array.isArray(rows) ? rows : [];
    const hashVerified = expected?.sha256 ? actualSha256 === expected.sha256 : null;
    tracker.set(key, {file, present: true, rows: array.length, actualSha256, expectedSha256: expected?.sha256 || null, hashVerified, error: Array.isArray(rows) ? null : 'not-array'});
    return {rows: array, actualSha256, error: Array.isArray(rows) ? null : 'not-array'};
  } catch (error) {
    tracker.set(key, {file, present: true, rows: 0, actualSha256: null, expectedSha256: expected?.sha256 || null, hashVerified: false, error: String(error.message || error)});
    return {rows: [], actualSha256: null, error: String(error.message || error)};
  }
}

function artifactManifest(dataRoot) {
  const file = path.join(dataRoot, 'manifest.json');
  const manifest = readJson(file, {});
  const byKey = new Map((manifest.artifacts || []).map(row => [`${row.kind}|${row.symbol}`, row]));
  return {manifest, byKey, file, sha256: sha256File(file)};
}

function exchangeBySymbol(dataRoot) {
  const file = path.join(dataRoot, 'source', 'current-exchangeInfo.json');
  const info = readJson(file, {});
  return {map: new Map((info.symbols || []).filter(row => row?.symbol).map(row => [row.symbol, row])), file, sha256: sha256File(file)};
}

function normalizeFundingRows(rows) {
  const byTime = new Map();
  for (const row of rows || []) {
    const t = finite(row?.t ?? row?.fundingTime ?? row?.funding_time ?? row?.calc_time);
    const rate = finite(row?.rate ?? row?.fundingRate ?? row?.funding_rate ?? row?.last_funding_rate);
    if (t == null || rate == null) continue;
    byTime.set(t, {
      t,
      rate,
      // Funding archives do not contain mark prices.  Never interpret the
      // interval field as a price; canonical-outcome supplies priceAt fallback.
      markPrice: finite(row?.markPrice ?? row?.mark_price) ?? null,
      fundingIntervalHours: finite(row?.fundingIntervalHours ?? row?.funding_interval_hours) ?? null,
    });
  }
  return [...byTime.values()].sort((left, right) => left.t - right.t);
}

function normalizeMinuteRows(rows) {
  const byTime = new Map();
  for (const source of rows || []) {
    const row = normalizeMinuteRow(source);
    if (row.t == null || !(row.o > 0) || !(row.h > 0) || !(row.l > 0) || !(row.c > 0)) continue;
    if (source?.complete === false || source?.isComplete === false || source?.closed === false) continue;
    byTime.set(row.t, row);
  }
  return [...byTime.values()].sort((left, right) => left.t - right.t);
}

function normalizeMinuteRow(source) {
  return Array.isArray(source)
    ? {t: finite(source[0]), o: finite(source[1]), h: finite(source[2]), l: finite(source[3]), c: finite(source[4])}
    : {t: finite(source?.t ?? source?.openTime), o: finite(source?.o ?? source?.open ?? source?.openPrice), h: finite(source?.h ?? source?.high ?? source?.highPrice), l: finite(source?.l ?? source?.low ?? source?.lowPrice), c: finite(source?.c ?? source?.close ?? source?.closePrice)};
}

function jsonObjectEnd(text, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return index + 1;
  }
  return -1;
}

function jsonNumberAfter(text, markerStart) {
  const colon = text.indexOf(':', markerStart);
  if (colon < 0) return null;
  let start = colon + 1;
  while (start < text.length && /\s/.test(text[start])) start++;
  let end = start;
  while (end < text.length && /[-+0-9.eE]/.test(text[end])) end++;
  const value = Number(text.slice(start, end));
  return Number.isFinite(value) ? value : null;
}

/**
 * Build a bounded-memory index over the object rows in a gzip JSON array.
 * The raw text is retained only for artifacts selected for outcome lookup;
 * rows are parsed/materialized for the requested execution window on demand.
 * This avoids JSON.parse'ing several multi-year 1m artifacts into RAM at once.
 */
export function readGzipObjectIndex(file, expected, tracker, key) {
  if (!file || !fs.existsSync(file)) {
    tracker.set(key, {file, present: false, rows: 0, actualSha256: null, expectedSha256: expected?.sha256 || null, hashVerified: false, error: 'missing'});
    return null;
  }
  try {
    const compressed = fs.readFileSync(file);
    const actualSha256 = crypto.createHash('sha256').update(compressed).digest('hex');
    const text = zlib.gunzipSync(compressed).toString('utf8').trim();
    let capacity = Math.max(1024, Number(expected?.rows) || 65_536);
    let times = new Float64Array(capacity);
    let starts = new Uint32Array(capacity);
    let ends = new Uint32Array(capacity);
    let count = 0;
    let cursor = text.indexOf('{');
    let sorted = true;
    let previousTime = -Infinity;
    while (cursor >= 0) {
      // Minute/funding artifacts are flat objects.  The direct lookup keeps
      // indexing fast; retain the balanced parser as a defensive fallback.
      const directEnd = text.indexOf('}', cursor);
      const end = directEnd >= 0 ? directEnd + 1 : jsonObjectEnd(text, cursor);
      if (end < 0) break;
      const timeMarker = text.indexOf('"t"', cursor);
      const t = timeMarker >= 0 && timeMarker < end ? jsonNumberAfter(text, timeMarker) : null;
      if (t != null) {
        if (t < previousTime) sorted = false;
        previousTime = t;
        if (count >= capacity) {
          capacity *= 2;
          const nextTimes = new Float64Array(capacity); nextTimes.set(times); times = nextTimes;
          const nextStarts = new Uint32Array(capacity); nextStarts.set(starts); starts = nextStarts;
          const nextEnds = new Uint32Array(capacity); nextEnds.set(ends); ends = nextEnds;
        }
        times[count] = t;
        starts[count] = cursor;
        ends[count] = end;
        count++;
      }
      cursor = text.indexOf('{', end);
    }
    const hashVerified = expected?.sha256 ? actualSha256 === expected.sha256 : null;
    tracker.set(key, {file, present: true, rows: count, actualSha256, expectedSha256: expected?.sha256 || null, hashVerified, error: count ? null : 'no-object-rows'});
    if (!count) return {text, times: [], starts: [], ends: [], sorted: true};
    return {
      text,
      times: times.slice(0, count),
      starts: starts.slice(0, count),
      ends: ends.slice(0, count),
      sorted,
    };
  } catch (error) {
    tracker.set(key, {file, present: true, rows: 0, actualSha256: null, expectedSha256: expected?.sha256 || null, hashVerified: false, error: String(error.message || error)});
    return null;
  }
}

export function rangeFromObjectIndex(index, start, end) {
  if (!index?.times?.length) return [];
  let first = 0;
  let last = index.times.length;
  if (index.sorted) {
    while (first < last) {
      const middle = Math.floor((first + last) / 2);
      if (index.times[middle] < Number(start)) first = middle + 1;
      else last = middle;
    }
    last = first;
    while (last < index.times.length && index.times[last] <= Number(end)) last++;
  } else {
    first = 0;
    last = index.times.length;
  }
  const byTime = new Map();
  for (let position = first; position < last; position++) {
    const timestamp = index.times[position];
    if (timestamp < Number(start) || timestamp > Number(end)) continue;
    try {
      const source = JSON.parse(index.text.slice(index.starts[position], index.ends[position]));
      const row = normalizeMinuteRow(source);
      if (row.t == null || !(row.o > 0) || !(row.h > 0) || !(row.l > 0) || !(row.c > 0)) continue;
      if (source?.complete === false || source?.isComplete === false || source?.closed === false) continue;
      byTime.set(row.t, row);
    } catch {
      // Artifact integrity is reported by the caller; malformed rows are not
      // executable minutes and are therefore excluded fail-closed here.
    }
  }
  return [...byTime.values()].sort((left, right) => left.t - right.t);
}

function pointAt(points, timestamp) {
  const rows = points || [];
  let low = 0; let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].signalTime) < Number(timestamp)) low = middle + 1;
    else high = middle;
  }
  return Number(rows[low]?.signalTime) === Number(timestamp) ? rows[low] : null;
}

function compactFeaturePoint(point) {
  return {
    signalTime: finite(point.signalTime),
    close: finite(point.close ?? point.c),
    ema50: finite(point.ema50),
    atr: finite(point.atr),
    priorHigh4: finite(point.priorHigh4),
    priorLow4: finite(point.priorLow4),
    return4: finite(point.return4),
    regime: point.regime || 'sideways',
    marketRegime: String(point.marketRegime || point.regime || 'SIDEWAYS').toUpperCase(),
    fundingZ: finite(point.fundingZ),
    fundingValid: point.fundingValid !== false,
    premiumZ: finite(point.premiumZ),
    oiZ: finite(point.oiZ),
    quoteVolume: finite(point.quoteVolume ?? point.q),
  };
}

function buildFeaturePoints(market, fundingRows, btcSeries, {start, end, keepSeries = false}) {
  const featureStart = Math.max(0, Number(start) - 150 * 24 * H1);
  const rows = market.rows.filter(row => row.t >= featureStart && row.t < Number(end));
  if (!rows.length) return {points: [], series: null};
  const series = buildV9FeatureSeries(rows, {funding: fundingRows, btcSeries, endTime: end});
  const points = series.points.filter(point => point.signalTime >= Number(start) && point.signalTime < Number(end)).map(point => compactFeaturePoint({
    ...point,
    // v9's 4h point has a previous 4h close; this is the feature-only return
    // used by the frozen event snapshot adapter, not a new alpha rule.
    return4: Number(point.previousClose) > 0 ? Number(point.close) / Number(point.previousClose) - 1 : null,
    marketRegime: String(point.regime || 'SIDEWAYS').toUpperCase(),
  }));
  const seriesForContext = keepSeries ? {
    points: series.points.map(point => ({
      signalTime: finite(point.signalTime),
      regime: point.regime || 'sideways',
      return12: finite(point.return12),
      close: finite(point.close),
      ema200: finite(point.ema200),
      atr: finite(point.atr),
    })),
  } : null;
  return {points, series: seriesForContext};
}

function snapshotTimestamps(start, end) {
  const first = Math.ceil(Number(start) / H4) * H4;
  const timestamps = [];
  for (let timestamp = first; timestamp < Number(end); timestamp += H4) timestamps.push(timestamp);
  return timestamps;
}

function featureRowsForMarket(market, dataRoot, manifestByKey, artifactTracker, {start, end}) {
  const file = artifactFile(dataRoot, 'price', market.symbol);
  const raw = readArtifact(file, manifestByKey.get(`price|${market.symbol}`), artifactTracker, `feature-price|${market.symbol}`);
  const normalized = normalizeHourlyRows(raw.rows);
  const featureStart = Math.max(0, Number(start) - 150 * 24 * H1);
  return normalized.rows.filter(row => row.t >= featureStart && row.t < Number(end));
}

function withRowIndexes(market, rows) {
  const gapPrefix = new Array(rows.length).fill(0);
  const volumePrefix = new Array(rows.length + 1).fill(0);
  let volumeValid = true;
  for (let index = 1; index < rows.length; index++) {
    gapPrefix[index] = gapPrefix[index - 1] + (rows[index].t - rows[index - 1].t === H1 ? 0 : 1);
  }
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].q == null) volumeValid = false;
    volumePrefix[index + 1] = volumePrefix[index] + (rows[index].q == null ? 0 : rows[index].q);
  }
  return {...market, rows, gapPrefix, volumePrefix, volumeValid};
}

function precomputePitStatusCodes(market, featurePoints, timestamps) {
  const codes = new Uint8Array(timestamps.length);
  const rows = market.rows || [];
  let rowIndex = 0;
  let pointIndex = 0;
  for (let index = 0; index < timestamps.length; index++) {
    const timestamp = timestamps[index];
    const latestExpected = timestamp - H1;
    while (rowIndex < rows.length && Number(rows[rowIndex]?.t) < latestExpected) rowIndex++;
    while (pointIndex < featurePoints.length && Number(featurePoints[pointIndex]?.signalTime) < timestamp) pointIndex++;
    codes[index] = observedTradabilityCodeAt(market, timestamp, {
      featurePoint: Number(featurePoints[pointIndex]?.signalTime) === timestamp ? featurePoints[pointIndex] : null,
      rowIndex,
      liquidityThresholdUsdt: OBSERVED_PIT_LIQUIDITY_THRESHOLD_USDT,
    });
  }
  return codes;
}

function buildControls(snapshots, start, end) {
  const output = [];
  for (const snapshot of snapshots) {
    for (const point of snapshot.members) {
      const value = Number(point.return4);
      if (!Number.isFinite(value) || value === 0) continue;
      output.push({
        id: `control|${point.symbol}|${snapshot.eventTime}`,
        signalTime: snapshot.eventTime,
        eventTime: snapshot.eventTime,
        symbol: point.symbol,
        marketId: point.symbol,
        side: value > 0 ? 'long' : 'short',
        marketRegime: snapshot.marketRegime,
        liquidityBucket: 'eligible',
        outerFold: outerFoldAt(snapshot.eventTime, start, end),
        controlLevel: point.symbol === 'BTCUSDT' ? 'market' : 'symbol',
        completed: true,
      });
    }
  }
  return output.sort((left, right) => left.signalTime - right.signalTime || left.id.localeCompare(right.id));
}

function outerFoldAt(timestamp, start, end, folds = 6) {
  const value = (Number(timestamp) - Number(start)) / Math.max(1, Number(end) - Number(start));
  return Math.max(0, Math.min(folds - 1, Math.floor(value * folds)));
}

function forwardProfile(rows, fillTime, fillPrice, side, barrierTime) {
  const direction = side === 'long' ? 1 : -1;
  const usable = rows.filter(row => row.t >= fillTime && row.t + MINUTE_MS <= barrierTime);
  const forwardReturns = {};
  for (const [hours, key] of [[4, 'h4'], [12, 'h12'], [24, 'h24'], [72, 'h72']]) {
    const cutoff = fillTime + hours * H1;
    const row = usable.filter(item => item.t + MINUTE_MS <= cutoff).at(-1);
    forwardReturns[key] = row ? direction * (row.c / fillPrice - 1) : null;
  }
  const mfe = usable.map(row => direction === 1 ? row.h / fillPrice - 1 : 1 - row.l / fillPrice);
  const mae = usable.map(row => direction === 1 ? row.l / fillPrice - 1 : 1 - row.h / fillPrice);
  return {forwardReturns, mfe: mfe.length ? Math.max(...mfe) : null, mae: mae.length ? Math.min(...mae) : null};
}

function lowerBoundRows(rows, timestamp) {
  let low = 0; let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].t) < Number(timestamp)) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundRows(rows, timestamp) {
  let low = 0; let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].t) <= Number(timestamp)) low = middle + 1;
    else high = middle;
  }
  return low;
}

function rowsBetween(rows, start, end) {
  const first = lowerBoundRows(rows, start);
  const last = upperBoundRows(rows, end);
  return first < last ? rows.slice(first, last) : [];
}

function createOutcomeProvider({dataRoot, markets, featurePointsBySymbol, start, end, manifestByKey, artifactTracker}) {
  const marketBySymbol = new Map(markets.map(row => [row.symbol, row]));
  const cache = new Map();
  const loadInstrument = symbol => {
    if (cache.has(symbol)) {
      const value = cache.get(symbol);
      cache.delete(symbol); cache.set(symbol, value);
      return value;
    }
    const minuteFile = artifactFile(dataRoot, 'minute', symbol);
    const fundingFile = artifactFile(dataRoot, 'funding', symbol);
    const minuteIndex = readGzipObjectIndex(minuteFile, manifestByKey.get(`minute|${symbol}`), artifactTracker, `minute|${symbol}`);
    const fundingRaw = readArtifact(fundingFile, manifestByKey.get(`funding|${symbol}`), artifactTracker, `funding|${symbol}`);
    const fundingRows = normalizeFundingRows(fundingRaw.rows);
    const value = {minuteIndex, fundingRows};
    cache.set(symbol, value);
    // Keep BTC plus a small LRU.  The index retains compressed JSON's
    // decompressed text and typed offsets, not millions of parsed row objects.
    while (cache.size > 3) {
      const oldest = cache.keys().next().value;
      if (oldest === 'BTCUSDT' && cache.size > 1) {
        const btc = cache.get(oldest); cache.delete(oldest); cache.set(oldest, btc); continue;
      }
      cache.delete(oldest);
      if (global.gc) global.gc();
    }
    return value;
  };
  return event => {
    const symbol = event.level === 'market' ? 'BTCUSDT' : event.symbol;
    const market = marketBySymbol.get(symbol);
    const point = pointAt(featurePointsBySymbol.get(symbol), event.eventTime);
    const episode = market?.activeEpisodes?.find(row => Number(row.observedStart) <= Number(event.eventTime) && Number(event.eventTime) < Number(row.observedEnd));
    if (!market || !point || !episode) return {executable: false, canonicalExecutable: false, labelUsable: false, rejectionReason: 'canonical-outcome-unavailable'};
    const stop = stopForPoint(point, event.sideHypothesis);
    if (!stop) return {executable: false, canonicalExecutable: false, labelUsable: false, rejectionReason: 'deterministic-stop-unavailable'};
    const data = loadInstrument(symbol);
    const activeEnd = Math.min(Number(end), Number(episode.observedEnd));
    const decisionTime = Number(event.eventTime) + CANONICAL_OUTCOME_CONTRACT.decisionLatencyMinutes * 60_000;
    const executionWindowEnd = Math.min(activeEnd, decisionTime + (CANONICAL_OUTCOME_CONTRACT.verticalBarrierHours + 1) * H1);
    // The canonical label only needs completed executable minutes from the
    // decision clock through its 72h barrier.  Parse only that range from the
    // indexed gzip JSON so several multi-year 1m artifacts never coexist as
    // materialized row objects.
    const minuteRows = rangeFromObjectIndex(data.minuteIndex, decisionTime, executionWindowEnd - MINUTE_MS);
    const fundingRows = rowsBetween(data.fundingRows, decisionTime - 24 * H1, executionWindowEnd);
    const candidate = {
      id: event.eventId,
      marketId: symbol,
      symbol,
      instrument: symbol,
      side: event.sideHypothesis,
      family: event.eventFamily,
      t: event.eventTime,
      signalTime: event.eventTime,
      entry: point.close,
      sl: stop.stop,
      targetR: CANONICAL_OUTCOME_CONTRACT.targetR,
    };
    const outcome = simulateCanonicalOutcome(candidate, {
      market: {...market, filters: market.marketFilters || market.filters || []},
      minuteRows,
      minuteRowsPrepared: true,
      minuteQuery: buildMinuteQuery(minuteRows),
      fundingRows,
      fundingQuery: buildFundingQuery(fundingRows, minuteRows),
    });
    const canonicalBarrierTime = Number(outcome.canonicalBarrierTime);
    const labelUsable = outcome.canonicalExecutable === true && Number.isFinite(canonicalBarrierTime) && canonicalBarrierTime <= Number(end);
    return {
      ...outcome,
      labelUsable,
      canonicalOutcomeBoundary: labelUsable ? 'fillTime+72h<=developmentEnd' : 'not-usable-before-development-end',
      ...(outcome.canonicalExecutable ? forwardProfile(minuteRows, Number(outcome.fillTime), Number(outcome.fillPrice), event.sideHypothesis, canonicalBarrierTime) : {}),
      stopAlgorithm: 'priorLow4/priorHigh4 +/- 0.5 * ATR',
      stopFeatureTimestamp: iso(point.signalTime),
      stopEventTime: iso(event.eventTime),
      stopUsesFutureData: false,
      fundingWindow: {start: iso(outcome.fillTime), end: iso(outcome.exitTime), events: outcome.fundingEvents || 0},
      noFutureData: Number(event.eventTime) < Number(end) && (!Number.isFinite(canonicalBarrierTime) || canonicalBarrierTime <= Number(end)),
    };
  };
}

function aggregateSubsetSnapshot(snapshot, members, previous) {
  const returns = members.map(row => Number(row.return4)).filter(Number.isFinite);
  const above = members.map(row => Number(row.close) > Number(row.ema50));
  const positive = returns.filter(value => value > 0).length;
  const negative = returns.filter(value => value < 0).length;
  const dispersion = returns.length > 1 ? Math.sqrt(returns.reduce((sum, value) => sum + (value - mean(returns)) ** 2, 0) / (returns.length - 1)) : null;
  const priorDispersion = previous ? previous.__dispersionHistory : [];
  const priorVolatility = previous ? previous.__volatilityHistory : [];
  const z = (value, history) => {
    if (!Number.isFinite(Number(value)) || history.length < 8) return null;
    const average = mean(history); const deviation = Math.sqrt(history.reduce((sum, item) => sum + (item - average) ** 2, 0) / (history.length - 1));
    return deviation > 1e-12 ? (value - average) / deviation : 0;
  };
  const currentVolatility = returns.length ? mean(returns.map(value => Math.abs(value))) : null;
  const output = {...snapshot, members, pitUniverseSize: members.length,
    finalPitSymbols: members.map(row => row.symbol),
    breadthAbove50: above.length ? above.filter(Boolean).length / above.length : null,
    positiveReturnBreadth: returns.length ? positive / returns.length : null,
    negativeReturnBreadth: returns.length ? negative / returns.length : null,
    directionalBreadth: returns.length ? Math.max(positive, negative) / returns.length : null,
    marketReturn: mean(returns),
    marketDirection: mean(returns) == null ? null : mean(returns) > 0 ? 'long' : 'short',
    dispersionProxy: dispersion,
    previousDispersionZ: previous?.dispersionZ ?? null,
    dispersionZ: z(dispersion, priorDispersion),
    volatilityProxy: currentVolatility,
    realizedVolZ: z(currentVolatility, priorVolatility),
    __dispersionHistory: [...priorDispersion, dispersion].filter(Number.isFinite).slice(-30),
    __volatilityHistory: [...priorVolatility, currentVolatility].filter(Number.isFinite).slice(-30),
  };
  return output;
}

function topLiquiditySnapshots(snapshots, limit = 100) {
  let previous = null;
  return snapshots.map(snapshot => {
    const members = [...snapshot.members].sort((left, right) => Number(right.quoteVolume ?? right.q ?? 0) - Number(left.quoteVolume ?? left.q ?? 0) || left.symbol.localeCompare(right.symbol)).slice(0, limit);
    const output = aggregateSubsetSnapshot(snapshot, members, previous);
    previous = output;
    return output;
  });
}

function compactArtifactReport(markets, artifactTracker) {
  const required = ['price', 'minute', 'funding'];
  const output = {};
  for (const kind of required) {
    const rows = markets.map(market => {
      const artifact = market.artifacts?.[kind] || {};
      const tracked = artifactTracker.get(`${kind}|${market.symbol}`) || {};
      return {symbol: market.symbol, present: artifact.present ?? tracked.present ?? false, nonEmpty: artifact.nonEmpty ?? (tracked.rows > 0), rows: artifact.rows ?? tracked.rows ?? null, hashVerified: artifact.hashVerified ?? tracked.hashVerified ?? null, expectedSha256: artifact.expectedSha256 ?? tracked.expectedSha256 ?? null};
    });
    output[kind] = {
      markets: rows.length,
      present: rows.filter(row => row.present).length,
      nonEmpty: rows.filter(row => row.nonEmpty).length,
      hashVerified: rows.filter(row => row.hashVerified === true).length,
      missingSymbols: rows.filter(row => !row.present || !row.nonEmpty).map(row => row.symbol),
      hashFailures: rows.filter(row => row.hashVerified === false).map(row => row.symbol),
    };
  }
  return output;
}

function activeSymbolsByYear(snapshots) {
  const grouped = new Map();
  for (const snapshot of snapshots) {
    const year = String(new Date(snapshot.eventTime).getUTCFullYear());
    if (!grouped.has(year)) grouped.set(year, {symbols: new Set(), core: new Set(), expanded: new Set()});
    const row = grouped.get(year);
    for (const point of snapshot.members) { row.symbols.add(point.symbol); (point.core ? row.core : row.expanded).add(point.symbol); }
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([year, row]) => [year, {symbols: row.symbols.size, core: row.core.size, expanded: row.expanded.size}]));
}

function snapshotDiagnostics(snapshots) {
  return snapshots.map(row => ({
    timestamp: iso(row.eventTime),
    archiveObservedSymbols: row.archiveObservedCount,
    historyReadySymbols: row.historyReadyCount,
    liquidityReadySymbols: row.liquidityReadyCount,
    featureReadySymbols: row.featureReadyCount,
    finalPitSymbols: row.finalPitSymbols,
    dataLossSymbols: row.dataLossSymbols,
    otherwiseEligibleObservations: row.otherwiseEligibleObservations,
    corruptionLostObservations: row.corruptionLostObservations,
    dataLossReasonCounts: row.dataLossReasonCounts,
    derivativeReadyCount: row.derivativeReadyCount,
    leverageFeatureAvailable: row.leverageFeatureAvailable,
  }));
}

function buildInvariantScenario({scenario, loaded, featurePointsBySymbol, pitStatusBySymbol, pitTimestamps, cutoff}) {
  const markets = [...(loaded || [])];
  const statusCodes = new Map(pitStatusBySymbol);
  if (scenario === 'append-future-rows-after-cutoff' || scenario === 'append-future-high-volume-rows-after-cutoff') {
    const btc = loaded.find(row => row.symbol === 'BTCUSDT');
    if (btc?.rows?.length) {
      const last = Number(btc.rows.at(-1).t);
      const firstFuture = Math.max(Number(cutoff) + H1, last + H1);
      const futureRows = [0, 1].map(index => ({
        t: firstFuture + index * H1,
        o: 100,
        h: 101,
        l: 99,
        c: 100,
        q: scenario === 'append-future-high-volume-rows-after-cutoff' ? 1_000_000_000_000 : 1,
      }));
      const perturbed = withRowIndexes({...btc, rows: [...btc.rows, ...futureRows]}, [...btc.rows, ...futureRows]);
      statusCodes.set('BTCUSDT', precomputePitStatusCodes(perturbed, featurePointsBySymbol.get('BTCUSDT') || [], pitTimestamps));
    }
  } else if (scenario === 'add-future-listed-symbol') {
    const futureMarket = {symbol: 'FUTURE_INVARIANT_USDT', core: false, rows: [], dataIntegrity: {priceComplete: false}, exchangeInfo: {onboardDate: Number(cutoff) + H1}};
    markets.push(futureMarket);
    statusCodes.set(futureMarket.symbol, new Uint8Array(pitTimestamps.length));
  } else if (scenario === 'change-future-delist-knowledge') {
    const index = markets.findIndex(row => row.symbol === 'BTCUSDT');
    if (index >= 0) markets[index] = {...markets[index], activeEnd: Number(cutoff) + H1, futureDelistMetadata: {timestamp: Number(cutoff) + H1}};
  } else if (scenario === 'change-current-exchangeInfo-survival-metadata') {
    const index = markets.findIndex(row => row.symbol === 'BTCUSDT');
    if (index >= 0) markets[index] = {...markets[index], exchangeInfo: {...(markets[index].exchangeInfo || {}), status: 'TRADING', survivalMetadata: {changed: true}}};
  } else if (scenario === 'inject-listing-delisting-announcement-metadata') {
    const index = markets.findIndex(row => row.symbol === 'BTCUSDT');
    if (index >= 0) markets[index] = {...markets[index], announcementEvidence: [{type: 'listing'}, {type: 'delisting'}]};
  }
  return {markets, statusCodes};
}

function snapshotsForScenario(snapshots, statusCodes) {
  return (snapshots || []).map((row, index) => ({
    eventTime: row.eventTime,
    finalPitSymbols: (row.finalPitSymbols || []).filter(symbol => ((Number(statusCodes.get(symbol)?.[index]) || 0) & 16) !== 0),
  }));
}

function runInvariantScenarios(snapshots, cutoff, loaded, featurePointsBySymbol, pitStatusBySymbol, pitTimestamps) {
  const scenarios = [
    ['futureRowsInvariant', 'append-future-rows-after-cutoff'],
    ['futureVolumeInvariant', 'append-future-high-volume-rows-after-cutoff'],
    ['futureListingInvariant', 'add-future-listed-symbol'],
    ['futureDelistInvariant', 'change-future-delist-knowledge'],
    ['currentExchangeInfoInvariant', 'change-current-exchangeInfo-survival-metadata'],
    ['announcementInvariant', 'inject-listing-delisting-announcement-metadata'],
  ];
  const result = {};
  for (const [key, scenario] of scenarios) {
    const mutated = buildInvariantScenario({scenario, loaded, featurePointsBySymbol, pitStatusBySymbol, pitTimestamps, cutoff});
    const comparison = observedPitInvariantAudit({
      before: loaded,
      after: mutated.markets,
      snapshotsBefore: snapshots,
      snapshotsAfter: snapshotsForScenario(snapshots, mutated.statusCodes),
      cutoff,
    });
    result[key] = {
      pass: comparison.pass,
      comparedHistoricalSnapshots: comparison.comparedHistoricalSnapshots,
      changedHistoricalSnapshots: comparison.changedHistoricalSnapshots,
      perturbation: scenario,
    };
  }
  return result;
}

function emptyFamily(family, status) {
  return {family, status, raw: null, independent: null, executable: null, symbols: null, months: null, long: null, short: null, profitFactor: null, expectancyR: null, confidenceInterval: null, pnl: null, maxDrawdownPct: null, positiveFolds: null, sampleFolds: null, positiveExpectancyFolds: null, foldMetrics: null, control: null, forwardReturns: null, mfe: null, mae: null};
}

function eventResearchSummary(research, pitReady, outcomeProvider, snapshots, controls, start, end) {
  if (!pitReady) {
    return {
      status: 'NOT_RUN_OBSERVED_PIT_DATA_BLOCKED',
      families: Object.fromEntries(EVENT_FAMILIES.map(family => [family, emptyFamily(family, 'NOT_RUN_OBSERVED_PIT_DATA_BLOCKED')])),
      totalKeep: 0,
      totalStrongKeep: 0,
      rawEvents: null,
      independentEvents: null,
      suppressedEvents: null,
      eventFrequency: null,
      horizonStudy: null,
      controls: {method: 'frozen exact month + side + regime + liquidity; market=BTCUSDT; dispersion=same symbol; ±72h contamination; no reuse', matched: null, unmatched: null, noReuse: true},
      sixFold: {outerFolds: 6, purgeHours: EVENT_REFRACTORY_HOURS, status: 'NOT_RUN'},
    };
  }
  return {
    status: research?.status || 'DATA_UNAVAILABLE',
    families: research?.families || Object.fromEntries(EVENT_FAMILIES.map(family => [family, emptyFamily(family, 'DATA_UNAVAILABLE')])),
    totalKeep: research?.totalKeep ?? 0,
    totalStrongKeep: research?.totalStrongKeep ?? 0,
    rawEvents: research?.rawEvents?.length ?? 0,
    independentEvents: research?.independentEvents?.length ?? 0,
    suppressedEvents: research?.suppressedEvents?.length ?? 0,
    eventFrequency: research?.eventFrequency || null,
    horizonStudy: research?.horizonStudy || null,
    controls: {method: 'frozen exact month + side + regime + liquidity; market=BTCUSDT; dispersion=same symbol; ±72h contamination; no reuse', matched: research?.controls ? (research.rawEvents?.length || 0) - research.controls.unmatched : null, unmatched: research?.controls?.unmatched ?? null, noReuse: research?.controls?.noReuse ?? true},
    sixFold: {...(research?.walkForward || {outerFolds: 6, purgeHours: EVENT_REFRACTORY_HOURS}), eventEndAware: true, status: 'PASS'},
  };
}

function markdownPit(report) {
  const monthly = Object.entries(report.coverage.monthly || {}).map(([month, row]) => `| ${month} | ${row.median ?? '—'} | ${row.mean ?? '—'} | ${row.min ?? '—'} | ${row.coreMedian ?? '—'} | ${row.expandedMedian ?? '—'} |`).join('\n');
  return `# Observed-Tradability PIT Universe\n\nStatus: **${report.status}**\n\nThis is the observed-tradability research universe. Binance Data Vision archive union is the source of candidate symbols; current exchangeInfo is classification/filter metadata only and announcements are diagnostics only.\n\nDevelopment window: ${report.developmentWindow.start} → ${report.developmentWindow.end} (end exclusive).\n\n## Universe and coverage\n\n- Archive-union symbols: ${report.sourceArchiveSymbols}\n- Archive-union symbols excluded as non-crypto/non-USDT/delivery: ${report.excludedTradfiSymbols}\n- Price-bearing observed markets: ${report.priceBearingSymbols}\n- Current exchangeInfo overlap: ${report.currentExchangeInfoSymbols}\n- Observed historical stop before Development end: ${report.historicalObservedSymbols}\n- Core / expanded observed markets: ${report.coreSymbols} / ${report.expandedSymbols}\n- PIT mean / median / min / max: ${report.coverage.mean} / ${report.coverage.median} / ${report.coverage.min} / ${report.coverage.max}\n- Monthly median minimum: ${report.coverage.monthlyMedianMin}\n- BTC required coverage: ${report.coverage.btcCoverage}\n- Data-loss observations (non-critical diagnostics): ${report.coverage.nonCriticalDataLossObservations}\n- Gate: **${report.coverage.status}**\n\n## Monthly PIT diagnostics\n\n| Month | PIT median | PIT mean | PIT min | Core median | Expanded median |\n|---|---:|---:|---:|---:|---:|\n${monthly || '| — | — | — | — | — | — |'}\n\nEvery 4h snapshot writes compact diagnostics to observed-pit-snapshots.ndjson: archiveObservedSymbols, historyReadySymbols, liquidityReadySymbols, featureReadySymbols, finalPitSymbols, and local data-loss symbols.\n\n## Artifact contract\n\n${Object.entries(report.artifacts).map(([kind, row]) => `- ${kind}: present ${row.present}/${row.markets}, non-empty ${row.nonEmpty}/${row.markets}, hash-verified ${row.hashVerified}/${row.markets}, missing ${row.missingSymbols.length}, hash failures ${row.hashFailures.length}`).join('\n')}\n\n## PIT invariants and diagnostics\n\n- Future rows / future listing / future delisting knowledge / future volume: **${report.pitInvariantAudit.pass}**\n- Current exchangeInfo invariant: **${report.pitInvariantAudit.currentExchangeInfoInvariant}**\n- Announcement evidence invariant: **${report.pitInvariantAudit.announcementEvidenceInvariant}**\n- Announcement evidence is not a membership hard gate: **true**\n- Spot false-evidence fixture rejected as USD-M evidence: **${report.announcementDiagnostics.spotFalseEvidenceRejected}**\n\n## Provenance\n\n- Observed PIT universe SHA-256: ${report.observedPitUniverseSha256}\n- Archive index SHA-256: ${report.archiveIndexSha256}\n- Dataset manifest SHA-256: ${report.datasetManifestSha256 || '—'}\n`;
}

function markdownEvent(report) {
  const rows = Object.values(report.families).map(row => `| ${row.family} | ${row.status} | ${row.raw ?? '—'} | ${row.independent ?? '—'} | ${row.executable ?? '—'} | ${row.profitFactor ?? '—'} | ${row.expectancyR ?? '—'} | ${row.eventControlExpectancyUpliftR ?? '—'} |`).join('\n');
  return `# Observed PIT Event / Regime Development\n\nFinal decision: **${report.finalDecision}**\n\nNo strategy thresholds, event families, Production code, scheduler, secrets, or Holdout were changed. The five event families and KEEP gates are frozen from PR #8.\n\n## Pipeline\n\nData Vision archive union → observed PIT membership at each completed 4h timestamp → feature-only points → frozen event detector → canonical 72h outcomes → exact controls → six-fold event-end purge/evaluation.\n\nOutcome contract: ${JSON.stringify(report.outcomeContract)}\n\n## Family results\n\n| Family | Status | Raw | Independent | Executable | PF | Expectancy R | Control uplift R |\n|---|---|---:|---:|---:|---:|---:|---:|\n${rows}\n\n## Gate and audits\n\n- Observed PIT gate: **${report.observedPitGate.status}**\n- Total KEEP / STRONG_KEEP: ${report.totalKeep} / ${report.totalStrongKeep}\n- Event/month: ${report.eventFrequency?.mean ?? '—'} (median ${report.eventFrequency?.median ?? '—'})\n- Controls: ${report.controls.status || 'not run'}; unmatched ${report.controls.unmatched ?? '—'}; no reuse ${report.controls.noReuse}\n- Six-fold audit: ${report.sixFoldAudit.status}\n- PIT invariant audit: ${report.pitInvariantAudit.pass}\n- Announcement mismatch diagnostics: ${JSON.stringify(report.announcementDiagnostics)}\n- Missing-data sensitivity: ${report.missingDataSensitivity.status}\n- Holdout: **NOT RUN**\n\n## Final interpretation\n\n${report.finalDecision === 'OBSERVED_PIT_DATA_BLOCKED' ? 'Formal event metrics were not run because the observed PIT data gate failed; no profitability conclusion is made.' : 'Event results are research diagnostics only; no Production promotion is implied.'}\n\n## Provenance\n\n- Event engine SHA-256: ${report.eventEngineCodeSha256}\n- Frozen event configuration SHA-256: ${report.eventFrozenConfigSha256}\n- Dataset manifest SHA-256: ${report.datasetManifestSha256 || '—'}\n`;
}

function markdownEventForReport(report) {
  const controls = `- Controls: matched ${report.controls.matched ?? '—'}; unmatched ${report.controls.unmatched ?? '—'}; no reuse ${report.controls.noReuse}`;
  const provenance = report.provenance || {};
  return markdownEvent(report)
    .replace(/- Controls: [^\n]+/, controls)
    .replace(/- Event engine SHA-256: [^\n]+/, `- Event engine SHA-256: ${provenance.eventEngineCodeSha256 || report.eventEngineCodeSha256 || '—'}`)
    .replace(/- Frozen event configuration SHA-256: [^\n]+/, `- Frozen event configuration SHA-256: ${provenance.eventFrozenConfigSha256 || report.eventFrozenConfigSha256 || '—'}`)
    .replace(/- Dataset manifest SHA-256: [^\n]+/, `- Dataset manifest SHA-256: ${provenance.datasetManifestSha256 || report.datasetManifestSha256 || '—'}`);
}

export function runObservedPitEventResearch({dataRoot = DEFAULT_DATA_ROOT, reportsDir = DEFAULT_REPORTS_DIR, start = DEVELOPMENT_START, end = DEVELOPMENT_END} = {}) {
  const manifestData = artifactManifest(dataRoot);
  const exchange = exchangeBySymbol(dataRoot);
  const discovery = discoverObservedArchiveUniverse({dataRoot, exchangeInfo: exchange.map});
  const artifactTracker = new Map();
  const loaded = [];
  const pitTimestamps = snapshotTimestamps(start, end);
  for (const entry of discovery.entries) {
    const priceFile = artifactFile(dataRoot, 'price', entry.symbol);
    const minuteFile = artifactFile(dataRoot, 'minute', entry.symbol);
    const fundingFile = artifactFile(dataRoot, 'funding', entry.symbol);
    const price = readArtifact(priceFile, manifestData.byKey.get(`price|${entry.symbol}`), artifactTracker, `price|${entry.symbol}`);
    const normalized = normalizeHourlyRows(price.rows);
    const market = buildObservedMarket({
      symbol: entry.symbol,
      rows: [],
      rawRows: [],
      lifecycleRows: normalized.rows,
      artifactRows: normalized.rows,
      core: entry.core,
      exchange: exchange.map.get(entry.symbol) || null,
      artifactMeta: {
        price: manifestData.byKey.get(`price|${entry.symbol}`),
        minute: manifestData.byKey.get(`minute|${entry.symbol}`),
        funding: manifestData.byKey.get(`funding|${entry.symbol}`),
      },
      priceFile,
      minuteFile,
      fundingFile,
      archiveKeys: entry.archiveKeys,
      invalidRows: normalized.invalidRows,
      duplicateRows: normalized.duplicateRows,
    });
    loaded.push(market);
    if (loaded.length % 25 === 0) console.error(JSON.stringify({stage: 'load-price', markets: loaded.length, total: discovery.entries.length}));
    if (global.gc && loaded.length % 25 === 0) global.gc();
  }

  const featurePointsBySymbol = new Map();
  const pitStatusBySymbol = new Map();
  let btcSeries = null;
  const btc = loaded.find(row => row.symbol === 'BTCUSDT');
  if (btc?.dataIntegrity?.priceComplete !== false) {
    const fundingFile = artifactFile(dataRoot, 'funding', 'BTCUSDT');
    const fundingRaw = readArtifact(fundingFile, manifestData.byKey.get('funding|BTCUSDT'), artifactTracker, 'funding|BTCUSDT');
    const btcFeatureMarket = withRowIndexes(btc, featureRowsForMarket(btc, dataRoot, manifestData.byKey, artifactTracker, {start, end}));
    const btcFeatures = buildFeaturePoints(btcFeatureMarket, normalizeFundingRows(fundingRaw.rows), null, {start, end, keepSeries: true});
    for (const point of btcFeatures.series?.points || []) point.return4 = Number(point.previousClose) > 0 ? Number(point.close) / Number(point.previousClose) - 1 : null;
    btcSeries = btcFeatures.series ? {points: btcFeatures.series.points} : null;
    featurePointsBySymbol.set('BTCUSDT', btcFeatures.points);
    pitStatusBySymbol.set('BTCUSDT', precomputePitStatusCodes(btcFeatureMarket, btcFeatures.points, pitTimestamps));
  } else {
    pitStatusBySymbol.set('BTCUSDT', new Uint8Array(pitTimestamps.length).fill(32));
  }
  for (const market of loaded.sort((left, right) => left.symbol.localeCompare(right.symbol))) {
    if (market.symbol === 'BTCUSDT') continue;
    if (market.dataIntegrity?.priceComplete === false) {
      featurePointsBySymbol.set(market.symbol, []);
      pitStatusBySymbol.set(market.symbol, new Uint8Array(pitTimestamps.length).fill(32));
      continue;
    }
    const fundingFile = artifactFile(dataRoot, 'funding', market.symbol);
    const fundingRaw = readArtifact(fundingFile, manifestData.byKey.get(`funding|${market.symbol}`), artifactTracker, `funding|${market.symbol}`);
    const featureMarket = withRowIndexes(market, featureRowsForMarket(market, dataRoot, manifestData.byKey, artifactTracker, {start, end}));
    const features = buildFeaturePoints(featureMarket, normalizeFundingRows(fundingRaw.rows), btcSeries, {start, end});
    featurePointsBySymbol.set(market.symbol, features.points);
    pitStatusBySymbol.set(market.symbol, precomputePitStatusCodes(featureMarket, features.points, pitTimestamps));
    // All non-BTC PIT state is now represented by compact status codes and
    // feature points.  Keep only lifecycle/artifact metadata for later
    // outcome lookup; this releases millions of hourly row objects before
    // snapshot construction.
    market.rows = [];
    market.gapPrefix = [];
    market.volumePrefix = [0];
    market.volumeValid = false;
    if (featurePointsBySymbol.size % 25 === 0) console.error(JSON.stringify({stage: 'build-features', markets: featurePointsBySymbol.size, total: discovery.entries.length, memory: process.memoryUsage()}));
    if (global.gc && featurePointsBySymbol.size % 25 === 0) global.gc();
  }

  if (global.gc) global.gc();
  console.error(JSON.stringify({stage: 'snapshots-start', markets: loaded.length, featurePoints: [...featurePointsBySymbol.values()].reduce((sum, rows) => sum + rows.length, 0), memory: process.memoryUsage()}));
  const snapshots = buildObservedPITSnapshots({markets: loaded, featurePointsBySymbol, pitStatusBySymbol, start, end, liquidityThresholdUsdt: OBSERVED_PIT_LIQUIDITY_THRESHOLD_USDT, includeSymbolLists: false});
  console.error(JSON.stringify({stage: 'snapshots-done', snapshots: snapshots.length, memory: process.memoryUsage()}));
  const coverage = observedPitGate(snapshots);
  const dataLoss = observedPitDataLossSummary({markets: loaded, pitStatusBySymbol, timestamps: pitTimestamps});
  coverage.topLossSymbols = dataLoss.topLossSymbols;
  coverage.topLossReasons = dataLoss.topLossReasons;
  coverage.lossSymbolCounts = dataLoss.lossSymbolCounts;
  coverage.lossReasonCounts = dataLoss.lossReasonCounts;
  console.error(JSON.stringify({stage: 'pit-gate', status: coverage.status, mean: coverage.mean, median: coverage.median, memory: process.memoryUsage()}));
  const controls = buildControls(snapshots, start, end);
  const outcomeProvider = createOutcomeProvider({dataRoot, markets: loaded, featurePointsBySymbol, start, end, manifestByKey: manifestData.byKey, artifactTracker});
  console.error(JSON.stringify({stage: 'event-research-start', controls: controls.length, snapshots: snapshots.length, memory: process.memoryUsage()}));
  const research = coverage.pass ? runEventResearch({snapshots, start, end, outcomeForEvent: outcomeProvider, controlObservations: controls}) : null;
  console.error(JSON.stringify({stage: 'event-research-done', rawEvents: research?.rawEvents?.length ?? 0, independentEvents: research?.independentEvents?.length ?? 0, memory: process.memoryUsage()}));
  const eventSummary = eventResearchSummary(research, coverage.pass, outcomeProvider, snapshots, controls, start, end);

  let missingDataSensitivity = {status: coverage.pass ? 'COMPUTED' : 'NOT_RUN_OBSERVED_PIT_DATA_BLOCKED', top100: null, all: null, directionReversal: null};
  if (coverage.pass && research) {
    const top100 = topLiquiditySnapshots(snapshots);
    const top100Controls = buildControls(top100, start, end);
    const sensitivityResearch = runEventResearch({snapshots: top100, start, end, outcomeForEvent: outcomeProvider, controlObservations: top100Controls});
    const direction = value => value?.expectancyR == null ? null : Number(value.expectancyR) > 0;
    const directionReversal = EVENT_FAMILIES.some(family => direction(research.families?.[family]) !== direction(sensitivityResearch.families?.[family]));
    missingDataSensitivity = {status: 'COMPUTED', top100: sensitivityResearch.families, all: research.families, directionReversal};
  }

  const invariantCutoff = Date.parse('2025-01-01T00:00:00.000Z');
  const invariantScenarios = runInvariantScenarios(snapshots, invariantCutoff, loaded, featurePointsBySymbol, pitStatusBySymbol, pitTimestamps);
  const spotFalseEvidenceRejected = !observedAnnouncementEvidenceIsUsdM({product: 'Spot', title: 'Delisting of AKRO/USDT spot trading pair', url: 'https://www.binance.com/en/support/announcement/spot-akro'});
  const invariantBaseline = observedPitInvariantAudit({
    before: loaded,
    after: loaded,
    snapshotsBefore: snapshots,
    snapshotsAfter: snapshotsForScenario(snapshots, pitStatusBySymbol),
    cutoff: invariantCutoff,
  });
  const pitInvariantAudit = {
    ...invariantBaseline,
    cutoff: iso(invariantCutoff),
    scenarios: invariantScenarios,
    futureRowsInvariant: invariantScenarios.futureRowsInvariant.pass,
    futureVolumeInvariant: invariantScenarios.futureVolumeInvariant.pass,
    futureListingInvariant: invariantScenarios.futureListingInvariant.pass,
    futureDelistInvariant: invariantScenarios.futureDelistInvariant.pass,
    currentExchangeInfoInvariant: invariantScenarios.currentExchangeInfoInvariant.pass,
    announcementInvariant: invariantScenarios.announcementInvariant.pass && spotFalseEvidenceRejected,
    announcementEvidenceInvariant: invariantScenarios.announcementInvariant.pass && spotFalseEvidenceRejected,
    pass: Object.values(invariantScenarios).every(row => row.pass) && spotFalseEvidenceRejected,
  };

  const noOrder = auditRepoNoOrder(APP_DIR);
  const isolation = auditProductionIsolation(APP_DIR, 'research/m4-event-regime');
  const monthly = monthlyObservedCoverage(snapshots);
  const derivativeReadyCounts = snapshots.map(row => Number(row.derivativeReadyCount)).filter(Number.isFinite);
  const leverageValidSnapshotCount = snapshots.filter(row => row.leverageFeatureAvailable === true).length;
  const coreSymbols = loaded.filter(row => row.core).length;
  const expandedSymbols = loaded.filter(row => !row.core).length;
  const priceBearing = loaded.filter(row => row.artifacts.price.present && row.artifacts.price.nonEmpty).length;
  const currentOverlap = loaded.filter(row => row.currentExchangeInfoSymbol).length;
  const historicalObserved = loaded.filter(row => Number(row.actualLastObserved || Infinity) < Number(end)).length;
  const diagnostics = snapshotDiagnostics(snapshots);
  const diagnosticsFile = path.join(reportsDir, 'observed-pit-snapshots.ndjson');
  atomicWrite(diagnosticsFile, `${diagnostics.map(row => JSON.stringify(row)).join('\n')}\n`);
  const marketReport = loaded.map(market => ({
    symbol: market.symbol,
    core: market.core,
    expanded: market.expanded,
    actualFirstArchiveMonth: market.actualFirstArchiveMonth,
    actualLastArchiveMonth: market.actualLastArchiveMonth,
    firstObserved: market.firstObserved,
    lastObserved: market.lastObserved,
    activeStart: iso(market.activeStart),
    activeEnd: iso(market.activeEnd),
    eligibleStart: iso(market.eligibleStart),
    eligibleEnd: iso(market.eligibleEnd),
    relisted: market.relisted,
    lifecycleExact: false,
    listingEvidenceSource: market.listingEvidenceSource,
    delistEvidenceSource: market.delistEvidenceSource,
    artifacts: market.artifacts,
    dataIntegrity: market.dataIntegrity,
    marketFilterSource: market.marketFilterSource,
  }));
  const observedPitUniverseSha256 = sha256(JSON.stringify({symbols: discovery.symbols, markets: marketReport, snapshots: diagnostics.map(row => ({timestamp: row.timestamp, finalPitSymbols: row.finalPitSymbols}))}));
  const pitReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: coverage.status,
    source: 'Binance official Data Vision USD-M archive union; current exchangeInfo classification-only; announcements diagnostics-only',
    developmentWindow: {start: iso(start), end: iso(end)},
    sourceArchiveSymbols: discovery.symbols.length,
    archiveUnionSymbols: discovery.symbols,
    excludedTradfiSymbols: discovery.excludedTradfiSymbols.length,
    excludedTradfiSymbolList: discovery.excludedTradfiSymbols,
    priceBearingSymbols: priceBearing,
    currentExchangeInfoSymbols: currentOverlap,
    historicalObservedSymbols: historicalObserved,
    coreSymbols,
    expandedSymbols,
    activeSymbolsByYear: activeSymbolsByYear(snapshots),
    coverage: {...coverage, monthly},
    derivativeCoverage: {
      min: derivativeReadyCounts.length ? Math.min(...derivativeReadyCounts) : null,
      mean: derivativeReadyCounts.length ? mean(derivativeReadyCounts) : null,
      median: derivativeReadyCounts.length ? median(derivativeReadyCounts) : null,
      validSnapshotCount: leverageValidSnapshotCount,
      minimumRequired: 100,
    },
    artifacts: compactArtifactReport(loaded, artifactTracker),
    markets: marketReport,
    pitSnapshots: {count: snapshots.length, diagnosticsFile: path.relative(APP_DIR, diagnosticsFile).replaceAll('\\', '/'), diagnosticsSha256: sha256File(diagnosticsFile), firstTimestamp: iso(snapshots[0]?.eventTime), lastTimestamp: iso(snapshots.at(-1)?.eventTime)},
    pitInvariantAudit,
    announcementDiagnostics: {hardGate: false, disagreementCount: null, spotFuturesAmbiguityCount: null, archiveAnnouncementMismatch: null, spotFalseEvidenceRejected},
    observedPitUniverseSha256,
    archiveIndexSha256: discovery.archiveIndexSha256,
    datasetManifestSha256: manifestData.sha256,
    noOrderAudit: noOrder,
    productionIsolation: isolation,
    knownLimitations: ['Observed-tradability membership intentionally does not claim official listing/delist evidence.', 'Historical symbols without a historical market-filter artifact may be PIT members but cannot produce executable canonical outcomes under fail-closed acceptance.', 'The local archive snapshot ends at 2026-08-01; no Holdout data was read.', 'GAIBUSDT is retained in archive diagnostics but has no price artifact and is excluded only at its local timestamp.'],
  };
  const frozenConfig = {eventDefinitionVersion: EVENT_DEFINITION_VERSION, families: EVENT_DEFINITIONS, refractoryHours: EVENT_REFRACTORY_HOURS, keepGate: EVENT_KEEP_GATE, outcomeContract: CANONICAL_OUTCOME_CONTRACT, developmentWindow: pitReport.developmentWindow};
  const eventEngineCodeSha256 = sha256(fs.readFileSync(path.join(APP_DIR, 'src', 'm4', 'event-engine.mjs')));
  const eventFrozenConfigSha256 = sha256(JSON.stringify(frozenConfig));
  const finalDecision = !coverage.pass ? 'OBSERVED_PIT_DATA_BLOCKED' : eventResearchGate(eventSummary.families);
  const eventReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    eventDefinitionVersion: EVENT_DEFINITION_VERSION,
    developmentWindow: pitReport.developmentWindow,
    observedPitGate: coverage,
    finalDecision,
    families: eventSummary.families,
    totalKeep: eventSummary.totalKeep,
    totalStrongKeep: eventSummary.totalStrongKeep,
    rawEvents: eventSummary.rawEvents,
    independentEvents: eventSummary.independentEvents,
    suppressedEvents: eventSummary.suppressedEvents,
    eventFrequency: eventSummary.eventFrequency,
    horizonStudy: eventSummary.horizonStudy,
    controls: eventSummary.controls,
    sixFoldAudit: eventSummary.sixFold,
    pitInvariantAudit,
    derivativeCoverage: pitReport.derivativeCoverage,
    announcementDiagnostics: pitReport.announcementDiagnostics,
    missingDataSensitivity,
    outcomeContract: CANONICAL_OUTCOME_CONTRACT,
    keepGate: EVENT_KEEP_GATE,
    holdout: {status: 'NOT RUN', authorized: false},
    repoNoOrderAudit: noOrder,
    productionIsolation: isolation,
    provenance: {
      observedPitUniverseSha256,
      eventEngineCodeSha256,
      eventFrozenConfigSha256,
      datasetManifestSha256: manifestData.sha256,
      sourceArchiveIndexSha256: discovery.archiveIndexSha256,
      snapshotDiagnosticsSha256: sha256File(diagnosticsFile),
    },
    knownLimitations: pitReport.knownLimitations,
  };
  fs.mkdirSync(reportsDir, {recursive: true});
  writeJson(path.join(reportsDir, 'observed-pit-universe.json'), pitReport);
  atomicWrite(path.join(reportsDir, 'observed-pit-universe.md'), `${markdownPit(pitReport)}\n## Corrected data-loss gate\n\n- Otherwise-eligible observations: ${coverage.otherwiseEligibleObservations}\n- Corruption-lost observations: ${coverage.corruptionLostObservations}\n- Corruption retention / loss: ${coverage.corruptionRetentionRate} / ${coverage.corruptionLossRate}\n- Top loss symbols: ${JSON.stringify(coverage.topLossSymbols || [])}\n- Top loss reasons: ${JSON.stringify(coverage.topLossReasons || [])}\n- Corruption gate: **${coverage.corruptionPass}**\n\n## PIT invariant perturbations\n\n${Object.entries(pitInvariantAudit.scenarios || {}).map(([key, row]) => `- ${key}: **${row.pass}**; compared ${row.comparedHistoricalSnapshots}; changed ${row.changedHistoricalSnapshots}`).join('\n')}\n`);
  writeJson(path.join(reportsDir, 'observed-event-regime-development.json'), eventReport);
  const familyDetails = Object.values(eventReport.families || {}).map(row => `### ${row.family}\n\n- Fold metrics: ${JSON.stringify(row.foldMetrics || [])}\n- Sample folds / positive expectancy folds: ${row.sampleFolds ?? '—'} / ${row.positiveExpectancyFolds ?? row.positiveFolds ?? '—'}\n- MFE: ${JSON.stringify(row.mfe)}\n- MAE: ${JSON.stringify(row.mae)}`).join('\n\n');
  atomicWrite(path.join(reportsDir, 'observed-event-regime-development.md'), `${markdownEventForReport(eventReport)}\n## Fold and path diagnostics\n\n- Derivative-ready min / mean / median: ${eventReport.derivativeCoverage?.min ?? '—'} / ${eventReport.derivativeCoverage?.mean ?? '—'} / ${eventReport.derivativeCoverage?.median ?? '—'}\n- Leverage-valid snapshots: ${eventReport.derivativeCoverage?.validSnapshotCount ?? '—'}\n\n${familyDetails}\n`);
  writeJson(path.join(reportsDir, 'observed-event-regime-frozen-config.json'), frozenConfig);
  return {pit: pitReport, event: eventReport, markets: loaded, snapshots, featurePointsBySymbol, artifactTracker};
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const result = runObservedPitEventResearch(parseArgs());
    const families = Object.fromEntries(EVENT_FAMILIES.map(family => {
      const row = result.event.families?.[family] || {};
      return [family, {
        status: row.status ?? null,
        raw: row.raw ?? null,
        independent: row.independent ?? null,
        executable: row.executable ?? null,
        profitFactor: row.profitFactor ?? null,
        expectancyR: row.expectancyR ?? null,
        pnl: row.pnl ?? null,
        maxDrawdownPct: row.maxDrawdownPct ?? null,
        positiveFolds: row.positiveFolds ?? null,
        sampleFolds: row.sampleFolds ?? null,
        positiveExpectancyFolds: row.positiveExpectancyFolds ?? null,
        foldMetrics: row.foldMetrics ?? null,
        mfe: row.mfe ?? null,
        mae: row.mae ?? null,
      }];
    }));
    console.log(JSON.stringify({
      branchScope: 'research-only',
      developmentWindow: result.pit.developmentWindow,
      sourceArchiveSymbols: result.pit.sourceArchiveSymbols,
      coreSymbols: result.pit.coreSymbols,
      expandedSymbols: result.pit.expandedSymbols,
      historicalObservedSymbols: result.pit.historicalObservedSymbols,
      pitMean: result.pit.coverage.mean,
      pitMedian: result.pit.coverage.median,
      pitMin: result.pit.coverage.min,
      monthlyMedianMin: result.pit.coverage.monthlyMedianMin,
      btcCoverage: result.pit.coverage.btcCoverage,
      observedPitGate: result.pit.coverage.status,
      otherwiseEligibleObservations: result.pit.coverage.otherwiseEligibleObservations,
      corruptionLostObservations: result.pit.coverage.corruptionLostObservations,
      corruptionRetentionRate: result.pit.coverage.corruptionRetentionRate,
      topLossSymbols: result.pit.coverage.topLossSymbols,
      topLossReasons: result.pit.coverage.topLossReasons,
      derivativeCoverage: result.event.derivativeCoverage,
      pitInvariantAudit: result.event.pitInvariantAudit,
      eventDecision: result.event.finalDecision,
      rawEvents: result.event.rawEvents,
      independentEvents: result.event.independentEvents,
      totalKeep: result.event.totalKeep,
      totalStrongKeep: result.event.totalStrongKeep,
      eventFrequency: result.event.eventFrequency,
      families,
      sixFoldAudit: result.event.sixFoldAudit,
      controls: result.event.controls,
      repoNoOrderAudit: result.event.repoNoOrderAudit,
      productionIsolation: result.event.productionIsolation,
      provenance: result.event.provenance,
      holdout: result.event.holdout,
      reports: ['reports/observed-pit-universe.json', 'reports/observed-pit-universe.md', 'reports/observed-event-regime-development.json', 'reports/observed-event-regime-development.md', 'reports/observed-event-regime-frozen-config.json'],
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
