import {R2_FEATURE_NAMES, r2FeatureVector} from './features.mjs';
import {fitRidge, predictLinear} from './linear-models.mjs';
import {fitTrainNormalizer} from './normalization.mjs';

function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }

export function fitRankingModel(rows, {lambda = 1} = {}) {
  const vectors = rows.map(row => r2FeatureVector(row));
  const normalizer = fitTrainNormalizer(vectors, R2_FEATURE_NAMES, {getValue: (row, name) => row[name]});
  const design = vectors.map(row => normalizer.transform(row).values);
  const target = rows.map(row => Math.max(-1.5, Math.min(2.5, Number(row.outcome?.netR ?? row.netR))));
  return {model: fitRidge(design, target, {lambda, featureNames: R2_FEATURE_NAMES}), normalizer, trainRows: rows.length, lambda, targetClip: [-1.5, 2.5]};
}

export function scoreRankingModel(fitted, row) {
  if (!fitted) return null;
  return predictLinear(fitted.model, fitted.normalizer.transform(r2FeatureVector(row)).values);
}

export function rankCrossSection(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = `${row.signalTime ?? row.t}|${row.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].flatMap(group => {
    const ordered = group.slice().sort((a, b) => Number(b.predictedNetR) - Number(a.predictedNetR) || String(a.id).localeCompare(String(b.id)));
    return ordered.map((row, index) => ({...row, rank: index + 1, rankPercentile: ordered.length <= 1 ? 1 : 1 - index / (ordered.length - 1), edgeQuintile: 5 - Math.min(4, Math.floor(index * 5 / ordered.length))}));
  }).sort((a, b) => Number(a.signalTime ?? a.t) - Number(b.signalTime ?? b.t) || String(a.side).localeCompare(String(b.side)) || String(a.id).localeCompare(String(b.id)));
}

function tradeStats(rows) {
  const net = rows.map(row => Number(row.outcome?.netR ?? row.netR)).filter(Number.isFinite);
  const wins = net.filter(value => value > 0);
  const losses = net.filter(value => value < 0);
  return {sample: net.length, expectancyR: net.length ? net.reduce((sum, value) => sum + value, 0) / net.length : null, profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : wins.length ? Infinity : null, winRate: net.length ? wins.length / net.length : null, netPnlR: net.reduce((sum, value) => sum + value, 0)};
}

export function rankingQuintiles(rows) {
  return Object.fromEntries([1, 2, 3, 4, 5].map(quintile => [quintile, tradeStats((rows || []).filter(row => row.edgeQuintile === quintile))]));
}
