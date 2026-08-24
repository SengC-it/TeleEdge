const INTERVAL_UNITS = Object.freeze({
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
});

export function intervalToMs(interval) {
  if (Number.isFinite(Number(interval)) && Number(interval) > 0) return Number(interval);
  const match = String(interval ?? '').trim().toLowerCase().match(/^(\d+)([mhdw])$/);
  if (!match) throw new Error(`Unsupported candle interval: ${interval}`);
  return Number(match[1]) * INTERVAL_UNITS[match[2]];
}

export function timestampValue(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function activeWindowForMarket({symbol, market = {}, manifest = null, startTime, endTime}) {
  const declared = [...(manifest?.markets || []), ...(manifest?.universe?.markets || [])]
    .find(item => item.symbol === symbol) || {};
  const declaredStart = timestampValue(declared.activeStart ?? declared.eligibleStart ?? market.onboardDate);
  const declaredEnd = timestampValue(declared.activeEnd ?? declared.eligibleEnd ?? market.deliveryDate);
  const eligibleStart = Math.max(startTime, Number.isFinite(declaredStart) && declaredStart > 0 ? declaredStart : startTime);
  const eligibleEnd = Math.min(endTime, Number.isFinite(declaredEnd) && declaredEnd > 0 ? declaredEnd : endTime);
  return {
    symbol,
    eligibleStart,
    eligibleEnd,
    active: eligibleEnd > eligibleStart,
    lifecycleDeclared: Boolean(declared.activeStart || declared.activeEnd || declared.eligibleStart || declared.eligibleEnd),
  };
}

export function continuityIssues(rows, interval) {
  const step = intervalToMs(interval);
  const issues = [];
  for (let index = 0; index < (rows || []).length; index++) {
    const current = Number(rows[index]?.t);
    if (!Number.isFinite(current)) {
      issues.push({index, reason: 'invalid-timestamp', current: rows[index]?.t ?? null});
      continue;
    }
    if (index === 0) continue;
    const previous = Number(rows[index - 1]?.t);
    const expected = previous + step;
    if (current !== expected) {
      issues.push({index, reason: 'non-contiguous-timestamp', previous, current, expected});
    }
  }
  return issues;
}

export function hasCompleteSeries(rows, interval, startTime, endTime) {
  if (!Array.isArray(rows) || !rows.length) return false;
  if (!(Number(endTime) > Number(startTime))) return false;
  const step = intervalToMs(interval);
  const relevant = rows.filter(row => {
    const timestamp = Number(row?.t);
    return Number.isFinite(timestamp) && timestamp + step > startTime && timestamp < endTime;
  });
  if (!relevant.length || continuityIssues(relevant, step).length) return false;
  const first = Number(relevant[0]?.t);
  const last = Number(relevant.at(-1)?.t);
  return Number.isFinite(first) && Number.isFinite(last)
    && first <= startTime
    && last + step >= endTime;
}
