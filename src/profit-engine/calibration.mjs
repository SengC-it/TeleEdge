function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function monthKey(value) { const date = new Date(Number(value)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`; }

export function brierScore(rows) {
  const values = (rows || []).map(row => ({p: finite(row.pPositiveNetR), y: Number(row.outcome?.netR ?? row.netR) > 0 ? 1 : 0})).filter(row => row.p != null);
  return values.length ? values.reduce((sum, row) => sum + (row.p - row.y) ** 2, 0) / values.length : null;
}

export function baseRateBrier(rows) {
  const ys = (rows || []).map(row => Number(row.outcome?.netR ?? row.netR) > 0 ? 1 : 0);
  if (!ys.length) return null;
  const rate = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  return ys.reduce((sum, value) => sum + (rate - value) ** 2, 0) / ys.length;
}

export function brierSkillScore(rows) {
  const score = brierScore(rows); const base = baseRateBrier(rows);
  return score == null || base == null || base === 0 ? null : 1 - score / base;
}

export function logLoss(rows) {
  const values = (rows || []).map(row => ({p: Math.max(1e-6, Math.min(1 - 1e-6, finite(row.pPositiveNet) ?? 0.5)), y: Number(row.outcome?.netR ?? row.netR) > 0 ? 1 : 0}));
  return values.length ? -values.reduce((sum, row) => sum + row.y * Math.log(row.p) + (1 - row.y) * Math.log(1 - row.p), 0) / values.length : null;
}

export function probabilityBins(rows, bounds = [0.45, 0.50, 0.55, 0.60, 1]) {
  const output = [];
  for (let index = 0; index < bounds.length - 1; index++) {
    const low = bounds[index]; const high = bounds[index + 1];
    const selected = (rows || []).filter(row => finite(row.pPositiveNet) != null && Number(row.pPositiveNet) >= low && (index === bounds.length - 2 ? Number(row.pPositiveNet) <= high : Number(row.pPositiveNet) < high));
    const net = selected.map(row => Number(row.outcome?.netR ?? row.netR)).filter(Number.isFinite);
    const wins = net.filter(value => value > 0); const losses = net.filter(value => value < 0);
    output.push({low, high, sample: selected.length, actualPositiveRate: net.length ? wins.length / net.length : null, expectancyR: net.length ? net.reduce((sum, value) => sum + value, 0) / net.length : null, profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : wins.length ? Infinity : null});
  }
  return output;
}

export function monotonicProbabilityBins(bins) {
  const observed = (bins || []).filter(row => row.sample > 0).map(row => row.actualPositiveRate);
  return observed.length >= 2 && observed.every((value, index) => index === 0 || value >= observed[index - 1] - 0.05);
}

function rank(values) { const order = values.map((value, index) => ({value, index})).sort((a, b) => a.value - b.value || a.index - b.index); const result = Array(values.length); order.forEach((row, index) => { result[row.index] = index + 1; }); return result; }

export function spearman(xs, ys) {
  const pairs = xs.map((x, index) => [finite(x), finite(ys[index])]).filter(pair => pair[0] != null && pair[1] != null);
  if (pairs.length < 2) return null;
  const rx = rank(pairs.map(pair => pair[0])); const ry = rank(pairs.map(pair => pair[1]));
  const mx = rx.reduce((sum, value) => sum + value, 0) / rx.length; const my = ry.reduce((sum, value) => sum + value, 0) / ry.length;
  const numerator = rx.reduce((sum, value, index) => sum + (value - mx) * (ry[index] - my), 0);
  const denominator = Math.sqrt(rx.reduce((sum, value) => sum + (value - mx) ** 2, 0) * ry.reduce((sum, value) => sum + (value - my) ** 2, 0));
  return denominator ? numerator / denominator : 0;
}

export function monthlyRankIc(rows) {
  const groups = new Map();
  for (const row of rows || []) { const key = monthKey(row.signalTime ?? row.t); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  const values = [...groups.entries()].map(([month, group]) => ({month, ic: spearman(group.map(row => row.predictedNetR), group.map(row => row.outcome?.netR ?? row.netR)), sample: group.length})).filter(row => row.ic != null);
  const ics = values.map(row => row.ic);
  return {months: values, mean: ics.length ? ics.reduce((sum, value) => sum + value, 0) / ics.length : null, median: ics.length ? [...ics].sort((a, b) => a - b)[Math.floor(ics.length / 2)] : null, positiveMonths: ics.length ? ics.filter(value => value > 0).length / ics.length : null};
}
