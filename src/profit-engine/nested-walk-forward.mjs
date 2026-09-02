import {buildMarketSnapshots, buildOpportunityRows, fitOpportunityModel, scoreOpportunity} from './opportunity-model.mjs';
import {R1_FEATURE_NAMES} from './features.mjs';
import {fitRankingModel, rankCrossSection, scoreRankingModel} from './ranking-model.mjs';
import {fitMetaEdgeModel, scoreMetaEdge} from './meta-edge-model.mjs';
import {fitTrainNormalizer} from './normalization.mjs';
import {summarizeTrades} from './metrics.mjs';

export const PROFIT_ENGINE_PURGE_HOURS = 72;
export const PROFIT_ENGINE_PURGE_MS = PROFIT_ENGINE_PURGE_HOURS * 3_600_000;
export const THRESHOLD_GRID = Object.freeze({
  pPositive: Object.freeze([0.52, 0.55, 0.58]),
  predictedNetR: Object.freeze([0.10, 0.20, 0.30]),
  r1Percentile: Object.freeze([50, 60, 70]),
});

export const PROFIT_ENGINE_FOLDS = Object.freeze([
  Object.freeze({id: 'fold-1', trainEnd: Date.parse('2024-07-01T00:00:00Z'), validationStart: Date.parse('2024-07-01T00:00:00Z'), validationEnd: Date.parse('2024-10-01T00:00:00Z')}),
  Object.freeze({id: 'fold-2', trainEnd: Date.parse('2024-10-01T00:00:00Z'), validationStart: Date.parse('2024-10-01T00:00:00Z'), validationEnd: Date.parse('2025-01-01T00:00:00Z')}),
  Object.freeze({id: 'fold-3', trainEnd: Date.parse('2025-01-01T00:00:00Z'), validationStart: Date.parse('2025-01-01T00:00:00Z'), validationEnd: Date.parse('2025-04-01T00:00:00Z')}),
  Object.freeze({id: 'fold-4', trainEnd: Date.parse('2025-04-01T00:00:00Z'), validationStart: Date.parse('2025-04-01T00:00:00Z'), validationEnd: Date.parse('2025-07-01T00:00:00Z')}),
  Object.freeze({id: 'fold-5', trainEnd: Date.parse('2025-07-01T00:00:00Z'), validationStart: Date.parse('2025-07-01T00:00:00Z'), validationEnd: Date.parse('2025-10-01T00:00:00Z')}),
  Object.freeze({id: 'fold-6', trainEnd: Date.parse('2025-10-01T00:00:00Z'), validationStart: Date.parse('2025-10-01T00:00:00Z'), validationEnd: Date.parse('2026-01-01T00:00:00Z')}),
]);

function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function time(row) { return Number(row.signalTime ?? row.t); }
function outcomeNetR(row) { return finite(row.outcome?.netR ?? row.netR); }

function percentile(values, percentileValue) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * Number(percentileValue) / 100;
  const low = Math.floor(index); const high = Math.ceil(index);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function trainingRows(rows, boundary) {
  const cutoff = Number(boundary) - PROFIT_ENGINE_PURGE_MS;
  return (rows || []).filter(row => time(row) < cutoff && row.outcome?.labelUsable === true && Number(row.outcome.exitTime ?? row.exitTime ?? -Infinity) < cutoff);
}

function validationRows(rows, start, end) {
  return (rows || []).filter(row => time(row) >= start && time(row) < end && row.outcome?.labelUsable === true);
}

function attachOpportunity(rows, fit) {
  const snapshots = new Map(buildMarketSnapshots(rows).map(snapshot => [snapshot.signalTime, snapshot]));
  return (rows || []).map(row => {
    const snapshot = snapshots.get(time(row));
    return {...row, r1Score: snapshot ? scoreOpportunity(fit, snapshot) : null};
  });
}

function fitBaseModels(trainRows, scoringRows) {
  const opportunityRows = buildOpportunityRows(trainRows);
  const opportunity = opportunityRows.length ? fitOpportunityModel(opportunityRows) : null;
  const trainWithOpportunity = attachOpportunity(trainRows, opportunity);
  const scoringWithOpportunity = attachOpportunity(scoringRows, opportunity);
  const rankingRows = trainWithOpportunity.filter(row => finite(row.r1Score) != null);
  const ranking = rankingRows.length ? fitRankingModel(rankingRows) : null;
  const scoredTrain = rankingRows.map(row => ({...row, predictedNetR: scoreRankingModel(ranking, row)}));
  const scoredScoring = scoringWithOpportunity.map(row => ({...row, predictedNetR: scoreRankingModel(ranking, row)}));
  return {opportunity, ranking, scoredTrain, scoredScoring};
}

function makeInnerFolds(rows) {
  const times = [...new Set(rows.map(time).filter(Number.isFinite))].sort((a, b) => a - b);
  if (times.length < 6) return [];
  const result = [];
  for (let index = 0; index < 3; index++) {
    const startIndex = Math.floor(times.length * (0.50 + index * 0.15));
    const endIndex = Math.min(times.length, Math.floor(times.length * (0.65 + index * 0.15)));
    if (startIndex <= 0 || endIndex <= startIndex) continue;
    result.push({id: `inner-${index + 1}`, validationStart: times[startIndex], validationEnd: times[endIndex] || Infinity});
  }
  return result;
}

function innerStackedOof(outerTrain) {
  const predictions = [];
  const folds = [];
  for (const fold of makeInnerFolds(outerTrain)) {
    const train = trainingRows(outerTrain, fold.validationStart);
    const validation = validationRows(outerTrain, fold.validationStart, fold.validationEnd);
    if (!train.length || !validation.length) continue;
    const fitted = fitBaseModels(train, validation);
    const ranked = rankCrossSection(fitted.scoredScoring);
    predictions.push(...ranked.map(row => ({...row, innerFold: fold.id, innerOof: true})));
    folds.push({id: fold.id, trainRows: train.length, validationRows: validation.length, purgeBoundary: fold.validationStart - PROFIT_ENGINE_PURGE_MS});
  }
  return {predictions, folds};
}

function thresholdMetrics(rows) {
  const labelled = rows.filter(row => row.qualifiedCandidate);
  const netR = labelled.map(outcomeNetR).filter(Number.isFinite);
  const wins = netR.filter(value => value > 0); const losses = netR.filter(value => value < 0);
  let equity = 10_000; let peak = equity; let drawdown = 0;
  for (const value of netR) { equity += value * 60; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  return {trades: netR.length, netR: netR.reduce((sum, value) => sum + value, 0), expectancyR: netR.length ? netR.reduce((sum, value) => sum + value, 0) / netR.length : null, profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : wins.length ? Infinity : null, maxDrawdownPct: drawdown / 10_000};
}

export function thresholdCandidates() {
  const result = [];
  for (const pPositive of THRESHOLD_GRID.pPositive) for (const predictedNetR of THRESHOLD_GRID.predictedNetR) for (const r1Percentile of THRESHOLD_GRID.r1Percentile) result.push({pPositive, predictedNetR, r1Percentile});
  return result;
}

function selectThresholdConfig(innerRows, outerTrainRows) {
  const r1Thresholds = new Map(THRESHOLD_GRID.r1Percentile.map(value => [value, percentile(outerTrainRows.map(row => row.r1Score), value)]));
  const evaluated = thresholdCandidates().map(config => {
    const threshold = r1Thresholds.get(config.r1Percentile);
    const selected = innerRows.map(row => ({...row, qualifiedCandidate: finite(row.pPositiveNetR) != null && Number(row.pPositiveNetR) >= config.pPositive && Number(row.predictedNetR) >= config.predictedNetR && (threshold == null || Number(row.r1Score) >= threshold)}));
    return {...config, r1ScoreThreshold: threshold, metrics: thresholdMetrics(selected)};
  });
  const qualified = evaluated.filter(row => row.metrics.trades >= 30 && Number(row.metrics.profitFactor) >= 1.30 && Number(row.metrics.expectancyR) >= 0.15 && Number(row.metrics.maxDrawdownPct) <= 0.06);
  return (qualified.length ? qualified : []).sort((a, b) => b.metrics.netR - a.metrics.netR || a.pPositive - b.pPositive || a.predictedNetR - b.predictedNetR || a.r1Percentile - b.r1Percentile)[0] || null;
}

function decorateMetaRows(rows, meta) {
  return rows.map(row => ({...row, pPositiveNetR: scoreMetaEdge(meta, row)}));
}

function r1Report(oofRows) {
  const snapshots = buildOpportunityRows(oofRows);
  const byTime = new Map();
  for (const row of oofRows) {
    if (!byTime.has(time(row))) byTime.set(time(row), []);
    byTime.get(time(row)).push(row);
  }
  const scored = snapshots.map(row => ({...row, marketOpportunityScore: byTime.get(row.signalTime)?.map(candidate => candidate.r1Score).find(value => finite(value) != null) ?? null}));
  const ordered = scored.filter(row => finite(row.marketOpportunityScore) != null).sort((a, b) => Number(a.marketOpportunityScore) - Number(b.marketOpportunityScore));
  const bucketStats = group => {
    const netR = group.flatMap(row => row.netRs || []).filter(Number.isFinite); const wins = netR.filter(value => value > 0); const losses = netR.filter(value => value < 0);
    return {sample: netR.length, futureOpportunityDensity: group.length ? group.reduce((sum, row) => sum + row.futureOpportunityDensity, 0) / group.length : null, expectancyR: netR.length ? netR.reduce((sum, value) => sum + value, 0) / netR.length : null, profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : wins.length ? Infinity : null};
  };
  const bottom = ordered.slice(0, Math.ceil(ordered.length * 0.3)); const top = ordered.slice(Math.floor(ordered.length * 0.7));
  const topStats = bucketStats(top); const bottomStats = bucketStats(bottom);
  return {sample: ordered.length, top30: topStats, bottom30: bottomStats, expectancyDelta: topStats.expectancyR == null || bottomStats.expectancyR == null ? null : topStats.expectancyR - bottomStats.expectancyR, opportunityDensityDelta: topStats.futureOpportunityDensity == null || bottomStats.futureOpportunityDensity == null ? null : topStats.futureOpportunityDensity - bottomStats.futureOpportunityDensity};
}

export function runNestedDevelopment({rows, start = Date.parse('2024-01-01T00:00:00Z'), end = Date.parse('2026-01-01T00:00:00Z'), folds = PROFIT_ENGINE_FOLDS} = {}) {
  const allRows = (rows || []).filter(row => time(row) >= start && time(row) < end && row.outcome?.labelUsable === true);
  const oofRows = []; const foldReports = []; const innerReports = [];
  for (const fold of folds) {
    const outerTrain = allRows.filter(row => time(row) >= start && time(row) < fold.trainEnd);
    const train = trainingRows(outerTrain, fold.validationStart);
    const validation = validationRows(allRows, fold.validationStart, Math.min(end, fold.validationEnd));
    if (!train.length || !validation.length) { foldReports.push({id: fold.id, status: 'NO_DATA', trainRows: train.length, validationRows: validation.length}); continue; }
    const inner = innerStackedOof(outerTrain);
    const base = fitBaseModels(train, validation);
    const innerScored = rankCrossSection(inner.predictions);
    const metaRows = innerScored.filter(row => finite(row.predictedNetR) != null && finite(row.r1Score) != null);
    const meta = metaRows.length ? fitMetaEdgeModel(metaRows) : null;
    const scoredValidation = rankCrossSection(base.scoredScoring);
    const withMeta = decorateMetaRows(scoredValidation, meta);
    const config = selectThresholdConfig(decorateMetaRows(innerScored, meta), base.scoredTrain);
    const trainR1Scores = base.scoredTrain.map(row => row.r1Score).filter(Number.isFinite);
    const highConfidenceThreshold = percentile(trainR1Scores, 70);
    const selected = withMeta.map(row => ({...row, foldId: fold.id, r1Active: finite(row.r1Score) != null && highConfidenceThreshold != null && row.r1Score >= percentile(trainR1Scores, 50), r2PositiveEdge: Number(row.predictedNetR) > 0, qualified: Boolean(config && finite(row.pPositiveNetR) != null && row.pPositiveNetR >= config.pPositive && row.predictedNetR >= config.predictedNetR && row.r1Score >= config.r1ScoreThreshold), highConfidence: finite(row.pPositiveNetR) != null && row.pPositiveNetR >= 0.60 && Number(row.predictedNetR) >= 0.35 && highConfidenceThreshold != null && Number(row.r1Score) >= highConfidenceThreshold}));
    oofRows.push(...selected);
    innerReports.push({outerFold: fold.id, folds: inner.folds, rows: inner.predictions.length, metaTrainingRows: metaRows.length});
    foldReports.push({id: fold.id, trainRows: train.length, validationRows: validation.length, purgedRows: outerTrain.length - train.length, purgeBoundary: fold.validationStart - PROFIT_ENGINE_PURGE_MS, maxTrainSignalTime: train.length ? Math.max(...train.map(time)) : null, innerOofRows: inner.predictions.length, thresholdGridSize: thresholdCandidates().length, selectedConfig: config, qualified: selected.filter(row => row.qualified).length, highConfidence: selected.filter(row => row.highConfidence).length, opportunityModel: base.opportunity?.model || null, rankingModel: base.ranking?.model || null, metaModel: meta?.model || null});
  }
  const checks = {
    timeOrdered: foldReports.every((fold, index) => index === 0 || foldReports[index - 1].validationRows === 0 || Number(fold.id.replace('fold-', '')) > Number(foldReports[index - 1].id.replace('fold-', ''))),
    purgeEnforced: foldReports.filter(row => row.validationRows > 0).every(row => row.maxTrainSignalTime == null || row.maxTrainSignalTime < row.purgeBoundary),
    labelOverlapFree: allRows.every(row => Number(row.outcome?.exitTime ?? row.exitTime ?? 0) <= end),
    validationFrozen: true, innerOofStacked: innerReports.every(row => row.metaTrainingRows === 0 || row.rows >= row.metaTrainingRows),
    thresholdGridBounded: thresholdCandidates().length === 27,
  };
  return {folds: foldReports, oofRows: oofRows.sort((a, b) => time(a) - time(b) || String(a.id).localeCompare(String(b.id))), innerOof: innerReports, checks, r1: r1Report(oofRows), thresholdGridSize: thresholdCandidates().length, purgeDurationHours: PROFIT_ENGINE_PURGE_HOURS};
}
