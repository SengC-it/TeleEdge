import {aggregateMarketFeatures, R1_FEATURE_NAMES} from './features.mjs';
import {fitRidge, predictLinear} from './linear-models.mjs';
import {fitTrainNormalizer} from './normalization.mjs';

function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function key(row) { return String(row?.signalTime ?? row?.t); }

export function buildOpportunityRows(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    if (!grouped.has(key(row))) grouped.set(key(row), []);
    grouped.get(key(row)).push(row);
  }
  return [...grouped.entries()].map(([signalTime, group]) => {
    const executable = group.filter(row => row.outcome?.labelUsable === true);
    if (!executable.length) return null;
    return {
      signalTime: Number(signalTime), features: aggregateMarketFeatures(group),
      futureOpportunityDensity: executable.filter(row => row.outcome.positiveOpportunity === true).length / executable.length,
      executableSample: executable.length,
      netRs: executable.map(row => Number(row.outcome.netR)).filter(Number.isFinite),
      marketIds: [...new Set(group.map(row => row.marketId || row.symbol))].sort(),
    };
  }).filter(Boolean).sort((a, b) => a.signalTime - b.signalTime);
}

export function buildMarketSnapshots(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const signalTime = key(row);
    if (!grouped.has(signalTime)) grouped.set(signalTime, []);
    grouped.get(signalTime).push(row);
  }
  return [...grouped.entries()].map(([signalTime, group]) => ({
    signalTime: Number(signalTime), features: aggregateMarketFeatures(group),
    marketIds: [...new Set(group.map(row => row.marketId || row.symbol))].sort(),
  })).sort((a, b) => a.signalTime - b.signalTime);
}

export function fitOpportunityModel(rows, {lambda = 1} = {}) {
  const normalizer = fitTrainNormalizer(rows, R1_FEATURE_NAMES, {getValue: (row, name) => row.features?.[name]});
  const design = rows.map(row => normalizer.transform(row).values);
  const model = fitRidge(design, rows.map(row => row.futureOpportunityDensity), {lambda, featureNames: R1_FEATURE_NAMES});
  return {model, normalizer, trainRows: rows.length, lambda};
}

export function scoreOpportunity(fitted, row) {
  if (!fitted) return null;
  return predictLinear(fitted.model, fitted.normalizer.transform(row).values);
}

function stats(rows) {
  const netRs = rows.flatMap(row => row.netRs || []).filter(Number.isFinite);
  const wins = netRs.filter(value => value > 0);
  const losses = netRs.filter(value => value < 0);
  return {
    sample: netRs.length,
    futureOpportunityDensity: rows.length ? rows.reduce((sum, row) => sum + Number(row.futureOpportunityDensity || 0), 0) / rows.length : null,
    expectancyR: netRs.length ? netRs.reduce((sum, value) => sum + value, 0) / netRs.length : null,
    profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : wins.length ? Infinity : null,
  };
}

export function opportunityDeciles(rows) {
  const ordered = [...(rows || [])].filter(row => finite(row.marketOpportunityScore) != null).sort((a, b) => Number(a.marketOpportunityScore) - Number(b.marketOpportunityScore) || Number(a.signalTime) - Number(b.signalTime));
  const buckets = Array.from({length: 10}, () => []);
  ordered.forEach((row, index) => buckets[Math.min(9, Math.floor(index * 10 / Math.max(1, ordered.length)))].push(row));
  const deciles = buckets.map((bucket, index) => ({decile: index + 1, ...stats(bucket), scoreMin: bucket.length ? bucket[0].marketOpportunityScore : null, scoreMax: bucket.length ? bucket.at(-1).marketOpportunityScore : null}));
  const top = ordered.slice(Math.floor(ordered.length * 0.7));
  const bottom = ordered.slice(0, Math.ceil(ordered.length * 0.3));
  return {deciles, top30: stats(top), bottom30: stats(bottom), expectancyDelta: stats(top).expectancyR == null || stats(bottom).expectancyR == null ? null : stats(top).expectancyR - stats(bottom).expectancyR, profitFactorDelta: stats(top).profitFactor == null || stats(bottom).profitFactor == null ? null : stats(top).profitFactor - stats(bottom).profitFactor};
}
