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
  const step = intervalToMs(interval);
  if (continuityIssues(rows, step).length) return false;
  const first = Number(rows[0]?.t);
  const last = Number(rows.at(-1)?.t);
  return Number.isFinite(first) && Number.isFinite(last)
    && first <= startTime
    && last + step >= endTime;
}
