import {H1} from '../config.mjs';

export const METRICS_INTERVAL_MS = 5 * 60_000;
export const METRICS_MAX_OBSERVATION_AGE_MS = 10 * 60_000;
// A symbol is PIT-usable when the frozen signal grid can find at least one
// fresh, local observation.  Availability is still checked independently for
// every signal and every lookback below; this is not a whole-window quality
// exemption and is deliberately kept separate from alpha history minimums.
export const METRICS_MIN_PIT_OBSERVATIONS = 1;

const REQUIRED_COLUMNS = Object.freeze([
  'create_time',
  'symbol',
  'sum_open_interest',
  'sum_open_interest_value',
  'count_toptrader_long_short_ratio',
  'sum_toptrader_long_short_ratio',
  'count_long_short_ratio',
  'sum_taker_long_short_vol_ratio',
]);

const FIELD_MAP = Object.freeze({
  sum_open_interest: 'openInterest',
  sum_open_interest_value: 'openInterestValue',
  count_toptrader_long_short_ratio: 'topTraderAccountRatio',
  sum_toptrader_long_short_ratio: 'topTraderPositionRatio',
  count_long_short_ratio: 'globalLongShortRatio',
  sum_taker_long_short_vol_ratio: 'takerLongShortRatio',
});

const metricsContextCache = new WeakMap();

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function parseUtcTimestamp(value) {
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value ?? '').trim())) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function csvFields(line) {
  // Binance metrics rows do not contain quoted commas. Keeping this parser
  // deliberately strict prevents a malformed row from shifting features.
  return String(line).split(',').map(value => value.trim());
}

export function parseMetricsTimestamp(value) {
  return parseUtcTimestamp(value);
}

export function parseBinanceMetricsCsv(text, {expectedSymbol = null, strict = false} = {}) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const header = lines[0] ? csvFields(lines[0]) : [];
  const columnIndex = new Map(header.map((name, index) => [name, index]));
  const errors = [];
  const rows = [];
  const seen = new Set();
  let duplicates = 0;
  let outOfOrder = 0;
  let previousTimestamp = null;
  for (const column of REQUIRED_COLUMNS) if (!columnIndex.has(column)) errors.push({type: 'missing-column', column});
  if (errors.length) return {rows, errors, diagnostics: {totalRows: 0, uniqueRows: 0, duplicates, outOfOrder, invalidTimestamp: 0, invalidNumeric: 0}};
  for (let lineNumber = 1; lineNumber < lines.length; lineNumber++) {
    const fields = csvFields(lines[lineNumber]);
    const rawTime = fields[columnIndex.get('create_time')];
    const timestamp = parseUtcTimestamp(rawTime);
    if (timestamp == null) {
      errors.push({type: 'invalid-timestamp', line: lineNumber + 1, value: rawTime});
      continue;
    }
    const symbol = fields[columnIndex.get('symbol')]?.trim() || null;
    if (!symbol) errors.push({type: 'missing-symbol', line: lineNumber + 1});
    if (expectedSymbol && symbol !== expectedSymbol) errors.push({type: 'symbol-mismatch', line: lineNumber + 1, expected: expectedSymbol, actual: symbol});
    if (previousTimestamp != null && timestamp < previousTimestamp) {
      outOfOrder++;
      errors.push({type: 'out-of-order', line: lineNumber + 1, previousTimestamp, timestamp});
    }
    previousTimestamp = timestamp;
    if (seen.has(timestamp)) {
      duplicates++;
      errors.push({type: 'duplicate-timestamp', line: lineNumber + 1, timestamp});
    }
    seen.add(timestamp);
    const values = {};
    let invalidNumeric = false;
    for (const column of REQUIRED_COLUMNS.slice(2)) {
      const value = finite(fields[columnIndex.get(column)]);
      if (value == null) {
        invalidNumeric = true;
        errors.push({type: 'invalid-numeric', line: lineNumber + 1, column, value: fields[columnIndex.get(column)]});
      }
      values[FIELD_MAP[column]] = value;
    }
    if (invalidNumeric) continue;
    rows.push({t: timestamp, symbol, ...values});
  }
  const unique = new Map();
  for (const row of rows) if (!unique.has(row.t)) unique.set(row.t, row);
  const normalized = [...unique.values()].sort((a, b) => a.t - b.t);
  const diagnostics = {
    totalRows: Math.max(0, lines.length - 1), uniqueRows: normalized.length, duplicates, outOfOrder,
    invalidTimestamp: errors.filter(error => error.type === 'invalid-timestamp').length,
    invalidNumeric: errors.filter(error => error.type === 'invalid-numeric').length,
  };
  if (strict && errors.length) {
    const error = new Error(`Invalid Binance metrics CSV: ${errors[0].type}`);
    error.code = 'METRICS_CSV_INVALID';
    error.errors = errors;
    error.diagnostics = diagnostics;
    throw error;
  }
  return {rows: normalized, errors, diagnostics};
}

function mergeMissingRange(ranges, start, end, intervalMs) {
  const count = Math.max(0, Math.round((end - start) / intervalMs));
  if (!count) return;
  const previous = ranges.at(-1);
  if (previous && previous.end === start) {
    previous.end = end;
    previous.count += count;
  } else ranges.push({start, end, count});
}

export function auditMetricsContinuity(rows, {activeStart = 0, activeEnd = Infinity, intervalMs = METRICS_INTERVAL_MS} = {}) {
  const sourceRows = (rows || []).filter(row => Number.isFinite(Number(row.t))).map(row => ({...row, t: Number(row.t)}));
  const unique = new Map();
  let duplicates = 0;
  for (const row of sourceRows) {
    if (unique.has(row.t)) duplicates++;
    else unique.set(row.t, row);
  }
  const sorted = [...unique.values()].sort((a, b) => a.t - b.t);
  const start = Math.ceil(Number(activeStart) / intervalMs) * intervalMs;
  const end = Math.ceil(Number(activeEnd) / intervalMs) * intervalMs;
  const expectedRows = Number.isFinite(end) && end > start ? Math.max(0, Math.floor((end - start) / intervalMs)) : 0;
  const missingIntervals = [];
  let expected = start;
  let index = 0;
  let largestGapMs = 0;
  let firstObserved = sorted[0]?.t ?? null;
  let lastObserved = sorted.at(-1)?.t ?? null;
  while (expected < end) {
    while (index < sorted.length && sorted[index].t < expected) index++;
    if (index >= sorted.length || sorted[index].t > expected) {
      const gapStart = expected;
      while (expected < end && (index >= sorted.length || sorted[index].t > expected)) expected += intervalMs;
      mergeMissingRange(missingIntervals, gapStart, expected, intervalMs);
      continue;
    }
    expected += intervalMs;
    index++;
  }
  for (let rowIndex = 1; rowIndex < sorted.length; rowIndex++) {
    const gap = sorted[rowIndex].t - sorted[rowIndex - 1].t;
    if (gap > intervalMs) largestGapMs = Math.max(largestGapMs, gap);
  }
  const missingTimestamps = missingIntervals.reduce((sum, range) => sum + range.count, 0);
  const coveragePct = expectedRows > 0 ? ((expectedRows - missingTimestamps) / expectedRows) * 100 : 0;
  return {
    intervalMs, activeStart: Number(activeStart), activeEnd: Number(activeEnd), totalRows: sourceRows.length,
    uniqueRows: sorted.length, duplicates, expectedRows, missingTimestamps, missingIntervals,
    largestGapMs, firstObserved, lastObserved, coveragePct: Number(coveragePct.toFixed(6)),
    complete: expectedRows > 0 && missingTimestamps === 0 && duplicates === 0,
  };
}

function numericRows(rows, key) {
  return (rows || []).map(row => ({t: finite(row.t), value: finite(row[key])})).filter(row => row.t != null && row.value != null).sort((a, b) => a.t - b.t);
}

function metricsContext(rows) {
  const source = Array.isArray(rows) ? rows : [];
  const cached = metricsContextCache.get(source);
  if (cached) return cached;
  const sorted = [...source].filter(row => finite(row?.t) != null).sort((a, b) => Number(a.t) - Number(b.t));
  const context = {
    rows: sorted,
    oi: numericRows(sorted, 'openInterest'),
    oiValue: numericRows(sorted, 'openInterestValue'),
    account: numericRows(sorted, 'topTraderAccountRatio'),
    position: numericRows(sorted, 'topTraderPositionRatio'),
    global: numericRows(sorted, 'globalLongShortRatio'),
    taker: numericRows(sorted, 'takerLongShortRatio'),
  };
  metricsContextCache.set(source, context);
  return context;
}

function rowAtOrBefore(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].t <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low > 0 ? rows[low - 1] : null;
}

function upperBound(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].t <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function rowAtOrBeforeWithin(rows, timestamp, maxAgeMs) {
  const observed = rowAtOrBefore(rows, Number(timestamp));
  if (!observed) return {row: null, observed: null, ageMs: null};
  const ageMs = Number(timestamp) - Number(observed.t);
  return {
    row: ageMs >= 0 && ageMs <= maxAgeMs ? observed : null,
    observed,
    ageMs,
  };
}

function ratioChange(current, previous) {
  return current != null && previous > 0 ? current / previous - 1 : null;
}

function mean(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function zScore(value, prior) {
  const current = finite(value);
  const values = (prior || []).map(Number).filter(Number.isFinite);
  if (current == null || values.length < 8) return null;
  const average = mean(values);
  const deviation = Math.sqrt(mean(values.map(item => (item - average) ** 2)) || 0);
  return deviation > 1e-12 ? (current - average) / deviation : 0;
}

function changesBefore(rows, timestamp, maxGapMs = METRICS_MAX_OBSERVATION_AGE_MS, limit = 48) {
  const endIndex = upperBound(rows, Number(timestamp)) - 1;
  if (endIndex < 0) return {changes: [], segmentLength: 0, reset: false};
  const history = [];
  let nextIndex = endIndex;
  let reset = false;
  for (let index = endIndex - 1; index >= 0 && history.length < limit + 1; index--) {
    if (rows[nextIndex].t - rows[index].t > maxGapMs) {
      reset = true;
      break;
    }
    history.push(rows[index]);
    nextIndex = index;
  }
  history.reverse();
  const changes = [];
  for (let index = 1; index < history.length; index++) {
    const delta = history[index].t - history[index - 1].t;
    if (delta <= maxGapMs && history[index].value > 0 && history[index - 1].value > 0) changes.push(history[index].value / history[index - 1].value - 1);
  }
  return {
    changes,
    segmentLength: history.length + 1,
    reset,
  };
}

export function aggregateMetricsAt(metricsRows, signalTime, {maxAgeMs = METRICS_MAX_OBSERVATION_AGE_MS, priceMove = null} = {}) {
  const context = metricsContext(metricsRows);
  const current = rowAtOrBeforeWithin(context.rows, Number(signalTime), maxAgeMs);
  const state = current.observed;
  const diagnostics = {rejections: []};
  if (!current.row) {
    diagnostics.rejections.push('current-stale');
    return {available: false, state, ageMs: current.ageMs, diagnostics};
  }
  const ageMs = current.ageMs;
  const {oi, oiValue, account, position, global, taker} = context;
  const currentOiRow = rowAtOrBeforeWithin(oi, signalTime, maxAgeMs);
  const currentOiValueRow = rowAtOrBeforeWithin(oiValue, signalTime, maxAgeMs);
  const oiAt1hRow = rowAtOrBeforeWithin(oi, Number(signalTime) - H1, maxAgeMs);
  const oiAt4hRow = rowAtOrBeforeWithin(oi, Number(signalTime) - 4 * H1, maxAgeMs);
  const oiAt12hRow = rowAtOrBeforeWithin(oi, Number(signalTime) - 12 * H1, maxAgeMs);
  const currentGlobalRow = rowAtOrBeforeWithin(global, signalTime, maxAgeMs);
  const globalAt4hRow = rowAtOrBeforeWithin(global, Number(signalTime) - 4 * H1, maxAgeMs);
  const currentOi = currentOiRow.row?.value ?? null;
  const currentOiValue = currentOiValueRow.row?.value ?? null;
  const oiAt1h = oiAt1hRow.row?.value ?? null;
  const oiAt4h = oiAt4hRow.row?.value ?? null;
  const oiAt12h = oiAt12hRow.row?.value ?? null;
  const currentGlobal = currentGlobalRow.row?.value ?? null;
  const globalAt4h = globalAt4hRow.row?.value ?? null;
  if (!oiAt1hRow.row) diagnostics.rejections.push('lookback-1h-gap');
  if (!oiAt4hRow.row || !globalAt4hRow.row) diagnostics.rejections.push('lookback-4h-gap');
  if (!oiAt12hRow.row) diagnostics.rejections.push('lookback-12h-gap');
  const oiChange4h = ratioChange(currentOi, oiAt4h);
  const normalizedPriceMove = Number(priceMove);
  const oiState = Number.isFinite(normalizedPriceMove) && oiChange4h != null
    ? normalizedPriceMove > 0 && oiChange4h > 0 ? 'new-long'
      : normalizedPriceMove < 0 && oiChange4h > 0 ? 'new-short'
        : normalizedPriceMove > 0 && oiChange4h < 0 ? 'short-covering'
          : normalizedPriceMove < 0 && oiChange4h < 0 ? 'long-liquidation' : 'position-reduction'
    : null;
  const oiHistory = changesBefore(oi, signalTime, maxAgeMs);
  const globalHistory = changesBefore(global, signalTime, maxAgeMs);
  const oiChanges = oiHistory.changes;
  const globalChanges = globalHistory.changes;
  const oiHistoryAvailable = oiChanges.length >= 8;
  const ratioHistoryAvailable = globalChanges.length >= 8;
  if (!oiHistoryAvailable || !ratioHistoryAvailable) diagnostics.rejections.push('rolling-history-gap');
  return {
    available: true, ageMs, state,
    oi: currentOi, oiValue: currentOiValue,
    oiChange1h: ratioChange(currentOi, oiAt1h), oiChange4h, oiChange12h: ratioChange(currentOi, oiAt12h),
    oiZ: zScore(oiChange4h, oiChanges), oiHistoryAvailable,
    topTraderAccountRatio: rowAtOrBeforeWithin(account, signalTime, maxAgeMs).row?.value ?? null,
    topTraderPositionRatio: rowAtOrBeforeWithin(position, signalTime, maxAgeMs).row?.value ?? null,
    globalLongShortRatio: currentGlobal, takerLongShortRatio: rowAtOrBeforeWithin(taker, signalTime, maxAgeMs).row?.value ?? null,
    ratioChange: ratioChange(currentGlobal, globalAt4h), ratioZ: zScore(ratioChange(currentGlobal, globalAt4h), globalChanges),
    ratioHistoryAvailable,
    diagnostics: {
      ...diagnostics,
      currentAgeMs: ageMs,
      oiHistorySegmentLength: oiHistory.segmentLength,
      ratioHistorySegmentLength: globalHistory.segmentLength,
      oiHistoryReset: oiHistory.reset,
      ratioHistoryReset: globalHistory.reset,
    },
    oiState,
  };
}

export function metricsRowsToFeatures(rows, signalTime, options = {}) {
  return aggregateMetricsAt(rows, signalTime, options);
}

export function auditMetricsPIT(rows, {signalTimes = null, activeStart = 0, activeEnd = Infinity, signalIntervalMs = 4 * H1, minimumObservations = METRICS_MIN_PIT_OBSERVATIONS} = {}) {
  const times = Array.isArray(signalTimes) && signalTimes.length
    ? [...new Set(signalTimes.map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
    : (() => {
      const start = Math.ceil(Number(activeStart) / signalIntervalMs) * signalIntervalMs;
      const end = Number(activeEnd);
      if (!Number.isFinite(end) || end <= start) return [];
      return Array.from({length: Math.max(0, Math.ceil((end - start) / signalIntervalMs))}, (_, index) => start + index * signalIntervalMs);
    })();
  const rejectionCounts = {};
  let validObservations = 0;
  for (const time of times) {
    const result = aggregateMetricsAt(rows, time);
    if (result.available) validObservations++;
    for (const reason of result.diagnostics?.rejections || []) rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
  }
  return {
    signalTimes: times.length,
    validObservations,
    rejectedObservations: times.length - validObservations,
    minimumObservations,
    usable: validObservations >= minimumObservations,
    rejectionCounts,
  };
}

export {REQUIRED_COLUMNS};
