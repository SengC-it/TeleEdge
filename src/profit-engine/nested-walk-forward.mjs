import {buildMarketSnapshots, buildOpportunityRows, fitOpportunityModel, scoreOpportunity} from './opportunity-model.mjs';
import {R1_FEATURE_NAMES} from './features.mjs';
import {fitRankingModel, rankCrossSection, scoreRankingModel} from './ranking-model.mjs';
import {fitMetaEdgeModel, scoreMetaEdge} from './meta-edge-model.mjs';

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

export function percentile(values, percentileValue) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * Number(percentileValue) / 100;
  const low = Math.floor(index); const high = Math.ceil(index);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/**
 * A label is admitted to a training set only when both its signal and its
 * event end are before the purge boundary. This is the event-end-aware purge
 * used by both outer and inner folds.
 */
export function trainingRows(rows, boundary, purgeMs = PROFIT_ENGINE_PURGE_MS) {
  const cutoff = Number(boundary) - Number(purgeMs);
  return (rows || []).filter(row => time(row) < cutoff
    && row.outcome?.labelUsable === true
    && Number(row.outcome.exitTime ?? row.exitTime ?? -Infinity) < cutoff);
}

export function validationRows(rows, start, end) {
  return (rows || []).filter(row => time(row) >= Number(start) && time(row) < Number(end) && row.outcome?.labelUsable === true);
}

function attachOpportunity(rows, fit) {
  const snapshots = new Map(buildMarketSnapshots(rows).map(snapshot => [snapshot.signalTime, snapshot]));
  return (rows || []).map(row => {
    const snapshot = snapshots.get(time(row));
    return {...row, r1Score: snapshot ? scoreOpportunity(fit, snapshot) : null};
  });
}

export function fitBaseModels(trainRows, scoringRows) {
  const opportunityRows = buildOpportunityRows(trainRows);
  const opportunity = opportunityRows.length ? fitOpportunityModel(opportunityRows, {lambda: 1}) : null;
  const trainWithOpportunity = attachOpportunity(trainRows, opportunity);
  const scoringWithOpportunity = attachOpportunity(scoringRows, opportunity);
  const rankingRows = trainWithOpportunity.filter(row => finite(row.r1Score) != null);
  const ranking = rankingRows.length ? fitRankingModel(rankingRows, {lambda: 1}) : null;
  const scoredTrain = rankingRows.map(row => ({...row, predictedNetR: scoreRankingModel(ranking, row)}));
  const scoredScoring = scoringWithOpportunity.map(row => ({...row, predictedNetR: scoreRankingModel(ranking, row)}));
  return {
    opportunity, ranking, scoredTrain, scoredScoring,
    normalizationAudit: {r1TrainOnly: true, r2TrainOnly: true, r1TrainRows: opportunityRows.length, r2TrainRows: rankingRows.length},
  };
}

export function makeInnerFolds(rows) {
  const times = [...new Set((rows || []).map(time).filter(Number.isFinite))].sort((a, b) => a - b);
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

/**
 * Generate the first two model layers out of fold inside one outer train.
 * Every row returned here has R1/R2 predictions from a fit that predates that
 * row's inner validation block.
 */
export function innerStackedOof(outerTrain) {
  const predictions = [];
  const folds = [];
  for (const fold of makeInnerFolds(outerTrain)) {
    const train = trainingRows(outerTrain, fold.validationStart);
    const validation = validationRows(outerTrain, fold.validationStart, fold.validationEnd);
    if (!train.length || !validation.length) continue;
    const fitted = fitBaseModels(train, validation);
    const ranked = rankCrossSection(fitted.scoredScoring);
    predictions.push(...ranked.map(row => ({...row, innerFold: fold.id, innerOof: true, r1Oof: true, r2Oof: true})));
    folds.push({
      id: fold.id, trainRows: train.length, validationRows: validation.length,
      purgeBoundary: fold.validationStart - PROFIT_ENGINE_PURGE_MS,
      maxTrainSignalTime: Math.max(...train.map(time)),
      normalizationAudit: fitted.normalizationAudit,
    });
  }
  return {predictions, folds};
}

function makeMetaFolds(rows) {
  const times = [...new Set((rows || []).map(time).filter(Number.isFinite))].sort((a, b) => a - b);
  if (times.length < 4) return [];
  return [0, 1, 2].map(index => {
    const startIndex = Math.floor(times.length * (0.25 + index * 0.25));
    const endIndex = Math.min(times.length, Math.floor(times.length * (0.50 + index * 0.25)));
    return {id: `meta-${index + 1}`, validationStart: times[startIndex], validationEnd: times[endIndex] || Infinity};
  }).filter(fold => Number.isFinite(fold.validationStart) && fold.validationStart < fold.validationEnd);
}

function metaTrainingRows(rows, boundary) {
  const cutoff = Number(boundary) - PROFIT_ENGINE_PURGE_MS;
  return (rows || []).filter(row => time(row) < cutoff
    && Number(row.outcome?.exitTime ?? row.exitTime ?? -Infinity) < cutoff
    && row.r1Oof === true && row.r2Oof === true
    && finite(row.r1Score) != null && finite(row.predictedNetR) != null
    && row.outcome?.labelUsable === true);
}

/**
 * Cross-fit the meta model itself. Rows without a prior meta-training block
 * are intentionally omitted from threshold selection rather than scored by a
 * model trained on the same observation. The final outer-validation model is
 * fit separately on all inner base-OOF rows.
 */
export function metaCrossFit(rows) {
  const predictions = [];
  const folds = [];
  for (const fold of makeMetaFolds(rows)) {
    const train = metaTrainingRows(rows, fold.validationStart);
    const validation = (rows || []).filter(row => time(row) >= fold.validationStart && time(row) < fold.validationEnd
      && row.r1Oof === true && row.r2Oof === true && finite(row.r1Score) != null && finite(row.predictedNetR) != null
      && row.outcome?.labelUsable === true);
    if (!train.length || !validation.length) continue;
    const model = fitMetaEdgeModel(train, {lambda: 0.1});
    const trainIds = new Set(train.map(row => String(row.id)));
    predictions.push(...validation.map(row => ({
      ...row,
      pPositiveNetR: scoreMetaEdge(model, row),
      r3Oof: true,
      metaFold: fold.id,
      r3TrainingRowIds: [...trainIds],
    })));
    folds.push({
      id: fold.id, trainRows: train.length, validationRows: validation.length,
      purgeBoundary: fold.validationStart - PROFIT_ENGINE_PURGE_MS,
      maxTrainSignalTime: Math.max(...train.map(time)),
      selfTrainingRows: validation.filter(row => trainIds.has(String(row.id))).length,
      normalizationAudit: {r3TrainOnly: true, trainRows: train.length},
    });
  }
  return {predictions, folds};
}

function thresholdMetrics(rows) {
  const labelled = rows.filter(row => row.qualifiedCandidate && row.r3Oof === true);
  const ordered = labelled.slice().sort((a, b) => time(a) - time(b) || String(a.id).localeCompare(String(b.id)));
  const netR = ordered.map(outcomeNetR).filter(Number.isFinite);
  const wins = netR.filter(value => value > 0); const losses = netR.filter(value => value < 0);
  let equity = 10_000; let peak = equity; let drawdown = 0;
  for (const value of netR) { equity += value * 60; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  return {
    trades: netR.length,
    netR: netR.reduce((sum, value) => sum + value, 0),
    expectancyR: netR.length ? netR.reduce((sum, value) => sum + value, 0) / netR.length : null,
    profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : wins.length ? Infinity : null,
    maxDrawdownPct: drawdown / 10_000,
  };
}

export function thresholdCandidates() {
  const result = [];
  for (const pPositive of THRESHOLD_GRID.pPositive) for (const predictedNetR of THRESHOLD_GRID.predictedNetR) for (const r1Percentile of THRESHOLD_GRID.r1Percentile) result.push({pPositive, predictedNetR, r1Percentile});
  return result;
}

export function selectThresholdConfig(innerRows) {
  const r1Thresholds = new Map(THRESHOLD_GRID.r1Percentile.map(value => [value, percentile(innerRows.map(row => row.r1Score), value)]));
  const evaluated = thresholdCandidates().map(config => {
    const threshold = r1Thresholds.get(config.r1Percentile);
    const selected = innerRows.map(row => ({...row, qualifiedCandidate: row.r3Oof === true && finite(row.pPositiveNetR) != null && Number(row.pPositiveNetR) >= config.pPositive && Number(row.predictedNetR) >= config.predictedNetR && (threshold == null || Number(row.r1Score) >= threshold)}));
    return {...config, r1ScoreThreshold: threshold, metrics: thresholdMetrics(selected)};
  });
  const qualified = evaluated.filter(row => row.metrics.trades >= 30 && Number(row.metrics.profitFactor) >= 1.30 && Number(row.metrics.expectancyR) >= 0.15 && Number(row.metrics.maxDrawdownPct) <= 0.06);
  return qualified.sort((a, b) => b.metrics.netR - a.metrics.netR || a.pPositive - b.pPositive || a.predictedNetR - b.predictedNetR || a.r1Percentile - b.r1Percentile)[0] || null;
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
  const ordered = scored.filter(row => finite(row.marketOpportunityScore) != null).sort((a, b) => Number(a.marketOpportunityScore) - Number(b.marketOpportunityScore) || a.signalTime - b.signalTime);
  const bucketStats = group => {
    const netR = group.flatMap(row => row.netRs || []).filter(Number.isFinite); const wins = netR.filter(value => value > 0); const losses = netR.filter(value => value < 0);
    return {sample: netR.length, futureOpportunityDensity: group.length ? group.reduce((sum, row) => sum + row.futureOpportunityDensity, 0) / group.length : null, expectancyR: netR.length ? netR.reduce((sum, value) => sum + value, 0) / netR.length : null, profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : wins.length ? Infinity : null};
  };
  const bottom = ordered.slice(0, Math.ceil(ordered.length * 0.3)); const top = ordered.slice(Math.floor(ordered.length * 0.7));
  const topStats = bucketStats(top); const bottomStats = bucketStats(bottom);
  return {sample: ordered.length, top30: topStats, bottom30: bottomStats, expectancyDelta: topStats.expectancyR == null || bottomStats.expectancyR == null ? null : topStats.expectancyR - bottomStats.expectancyR, opportunityDensityDelta: topStats.futureOpportunityDensity == null || bottomStats.futureOpportunityDensity == null ? null : topStats.futureOpportunityDensity - bottomStats.futureOpportunityDensity};
}

function outcomeOverlapCount(rows, boundary) {
  const cutoff = Number(boundary) - PROFIT_ENGINE_PURGE_MS;
  return (rows || []).filter(row => time(row) < cutoff && Number(row.outcome?.exitTime ?? row.exitTime ?? -Infinity) >= cutoff).length;
}

function innerAudit(outerTrain) {
  let excludedByOutcomeOverlap = 0;
  let labelOverlapFree = true;
  const folds = [];
  for (const fold of makeInnerFolds(outerTrain)) {
    const train = trainingRows(outerTrain, fold.validationStart);
    excludedByOutcomeOverlap += outcomeOverlapCount(outerTrain, fold.validationStart);
    labelOverlapFree &&= train.every(row => Number(row.outcome?.exitTime ?? row.exitTime ?? -Infinity) < fold.validationStart - PROFIT_ENGINE_PURGE_MS);
    folds.push({id: fold.id, trainRows: train.length, validationStart: fold.validationStart, validationEnd: fold.validationEnd, purgeBoundary: fold.validationStart - PROFIT_ENGINE_PURGE_MS});
  }
  return {labelOverlapFree, excludedByOutcomeOverlap, folds};
}

export function runNestedDevelopment({rows, start = Date.parse('2024-01-01T00:00:00Z'), end = Date.parse('2026-01-01T00:00:00Z'), folds = PROFIT_ENGINE_FOLDS} = {}) {
  const allRows = (rows || []).filter(row => time(row) >= start && time(row) < end && row.outcome?.labelUsable === true);
  const oofRows = []; const foldReports = []; const innerReports = [];
  let excludedByOutcomeOverlap = 0;
  for (const fold of folds) {
    const outerTrain = allRows.filter(row => time(row) >= start && time(row) < fold.trainEnd);
    const train = trainingRows(outerTrain, fold.validationStart);
    const validation = validationRows(allRows, fold.validationStart, Math.min(end, fold.validationEnd));
    excludedByOutcomeOverlap += outcomeOverlapCount(outerTrain, fold.validationStart);
    const innerAuditResult = innerAudit(outerTrain);
    excludedByOutcomeOverlap += innerAuditResult.excludedByOutcomeOverlap;
    if (!train.length || !validation.length) {
      foldReports.push({id: fold.id, status: 'NO_DATA', trainRows: train.length, validationRows: validation.length, innerLabelOverlapFree: innerAuditResult.labelOverlapFree});
      continue;
    }
    const inner = innerStackedOof(outerTrain);
    const metaCross = metaCrossFit(inner.predictions);
    const metaRows = inner.predictions.filter(row => finite(row.predictedNetR) != null && finite(row.r1Score) != null);
    const meta = metaRows.length ? fitMetaEdgeModel(metaRows, {lambda: 0.1}) : null;
    const base = fitBaseModels(train, validation);
    const scoredValidation = rankCrossSection(base.scoredScoring);
    const withMeta = decorateMetaRows(scoredValidation, meta);
    const innerRows = metaCross.predictions;
    const config = selectThresholdConfig(innerRows);
    const innerR1Scores = innerRows.map(row => row.r1Score).filter(Number.isFinite);
    const r1Threshold50 = percentile(innerR1Scores, 50);
    const r1Threshold70 = percentile(innerR1Scores, 70);
    const selected = withMeta.map(row => ({
      ...row,
      foldId: fold.id,
      outerOof: true,
      r1Active: finite(row.r1Score) != null && r1Threshold50 != null && row.r1Score >= r1Threshold50,
      r2PositiveEdge: Number(row.predictedNetR) > 0,
      qualified: Boolean(config && finite(row.pPositiveNetR) != null && row.pPositiveNetR >= config.pPositive && row.predictedNetR >= config.predictedNetR && row.r1Score >= config.r1ScoreThreshold),
      highConfidence: finite(row.pPositiveNetR) != null && row.pPositiveNetR >= 0.60 && Number(row.predictedNetR) >= 0.35 && r1Threshold70 != null && Number(row.r1Score) >= r1Threshold70,
    }));
    oofRows.push(...selected);
    innerReports.push({
      outerFold: fold.id,
      folds: inner.folds,
      rows: inner.predictions.length,
      metaCrossFit: metaCross.folds,
      metaCrossFitRows: metaCross.predictions.length,
      metaTrainingRows: metaRows.length,
      thresholdRows: innerRows.length,
      thresholdRowsAllOof: innerRows.every(row => row.r1Oof && row.r2Oof && row.r3Oof && !(row.r3TrainingRowIds || []).includes(row.id)),
      normalizationAudit: {r1TrainOnly: true, r2TrainOnly: true, r3TrainOnly: metaCross.folds.every(row => row.normalizationAudit?.r3TrainOnly !== false)},
    });
    foldReports.push({
      id: fold.id, trainRows: train.length, validationRows: validation.length,
      purgedRows: outerTrain.length - train.length,
      purgeBoundary: fold.validationStart - PROFIT_ENGINE_PURGE_MS,
      maxTrainSignalTime: train.length ? Math.max(...train.map(time)) : null,
      maxTrainExitTime: train.length ? Math.max(...train.map(row => Number(row.outcome.exitTime))) : null,
      innerOofRows: inner.predictions.length,
      metaCrossFitRows: metaCross.predictions.length,
      thresholdRows: innerRows.length,
      thresholdGridSize: thresholdCandidates().length,
      selectedConfig: config,
      qualified: selected.filter(row => row.qualified).length,
      highConfidence: selected.filter(row => row.highConfidence).length,
      opportunityModel: base.opportunity?.model || null,
      rankingModel: base.ranking?.model || null,
      metaModel: meta?.model || null,
      normalizationAudit: base.normalizationAudit,
      innerLabelOverlapFree: innerAuditResult.labelOverlapFree,
      innerPurgeBoundary: innerAuditResult.folds,
      innerSelfTrainingRows: metaCross.folds.reduce((sum, row) => sum + row.selfTrainingRows, 0),
    });
  }
  const validOuterFolds = foldReports.filter(row => row.validationRows > 0);
  const outerLabelOverlapFree = validOuterFolds.every(row => row.maxTrainExitTime == null || row.maxTrainExitTime < row.purgeBoundary);
  const innerLabelOverlapFree = foldReports.every(row => row.innerLabelOverlapFree !== false);
  const metaFoldCount = innerReports.reduce((sum, row) => sum + (row.metaCrossFit?.length || 0), 0);
  const checks = {
    timeOrdered: foldReports.every((fold, index) => index === 0 || Number(fold.id.replace('fold-', '')) > Number(foldReports[index - 1].id.replace('fold-', ''))),
    purgeEnforced: validOuterFolds.every(row => row.maxTrainSignalTime == null || row.maxTrainSignalTime < row.purgeBoundary),
    outerLabelOverlapFree,
    innerLabelOverlapFree,
    labelOverlapFree: outerLabelOverlapFree && innerLabelOverlapFree,
    excludedByOutcomeOverlap,
    validationFrozen: true,
    innerOofStacked: innerReports.every(row => row.thresholdRowsAllOof !== false),
    metaCrossFit: innerReports.every(row => row.thresholdRowsAllOof !== false),
    thresholdGridBounded: thresholdCandidates().length === 27,
    normalizationLeakageFree: innerReports.every(row => row.normalizationAudit?.r1TrainOnly && row.normalizationAudit?.r2TrainOnly && row.normalizationAudit?.r3TrainOnly),
    outerValidationUntuned: true,
    innerOuterLeakageFree: innerLabelOverlapFree && innerReports.every(row => row.metaCrossFit.every(meta => meta.selfTrainingRows === 0)),
  };
  return {
    folds: foldReports,
    oofRows: oofRows.sort((a, b) => time(a) - time(b) || String(a.id).localeCompare(String(b.id))),
    innerOof: innerReports,
    checks,
    r1: r1Report(oofRows),
    r3CrossFit: {method: 'inner-expanding-meta-cross-fit', folds: metaFoldCount, thresholdUsesOnlyR3Oof: checks.metaCrossFit},
    thresholdGridSize: thresholdCandidates().length,
    purgeDurationHours: PROFIT_ENGINE_PURGE_HOURS,
  };
}
