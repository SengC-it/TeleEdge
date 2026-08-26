import {H1} from '../config.mjs';
import {calculateResearchMetrics} from './metrics.mjs';
import {classifyTier, tierLabel} from './tiers.mjs';

export const PURGE_DURATION_MS = 72 * H1;

export const WALK_FORWARD_FOLDS = Object.freeze([
  Object.freeze({id: 'fold-1', trainStart: Date.parse('2025-01-01T00:00:00Z'), trainEnd: Date.parse('2025-05-01T00:00:00Z'), validationStart: Date.parse('2025-05-01T00:00:00Z'), validationEnd: Date.parse('2025-07-01T00:00:00Z')}),
  Object.freeze({id: 'fold-2', trainStart: Date.parse('2025-01-01T00:00:00Z'), trainEnd: Date.parse('2025-07-01T00:00:00Z'), validationStart: Date.parse('2025-07-01T00:00:00Z'), validationEnd: Date.parse('2025-09-01T00:00:00Z')}),
  Object.freeze({id: 'fold-3', trainStart: Date.parse('2025-01-01T00:00:00Z'), trainEnd: Date.parse('2025-09-01T00:00:00Z'), validationStart: Date.parse('2025-09-01T00:00:00Z'), validationEnd: Date.parse('2025-11-01T00:00:00Z')}),
  Object.freeze({id: 'fold-4', trainStart: Date.parse('2025-01-01T00:00:00Z'), trainEnd: Date.parse('2025-11-01T00:00:00Z'), validationStart: Date.parse('2025-11-01T00:00:00Z'), validationEnd: Date.parse('2026-01-01T00:00:00Z')}),
]);

const FEATURE_CONFIG = Object.freeze({
  adx: Object.freeze({type: 'numeric', bounds: [15, 25, 35]}),
  fundingZ: Object.freeze({type: 'numeric', bounds: [-2, -1, 1, 2]}),
  volumeRatio: Object.freeze({type: 'numeric', bounds: [0.8, 1.2, 2]}),
  rangeRatio: Object.freeze({type: 'numeric', bounds: [0.8, 1.2, 2]}),
  stopPct: Object.freeze({type: 'numeric', bounds: [0.03, 0.05, 0.08]}),
  relativeReturn12: Object.freeze({type: 'numeric', bounds: [-0.1, 0, 0.1]}),
  distanceEmaAtr: Object.freeze({type: 'numeric', bounds: [-2, -1, 1, 2]}),
  rsi: Object.freeze({type: 'numeric', bounds: [30, 40, 60, 70]}),
  return3: Object.freeze({type: 'numeric', bounds: [-0.05, 0, 0.05]}),
  regime: Object.freeze({type: 'categorical'}),
  btcRegime: Object.freeze({type: 'categorical'}),
  localTrend: Object.freeze({type: 'categorical'}),
});

export const CALIBRATION_FEATURES = Object.freeze(Object.keys(FEATURE_CONFIG));

const FEATURE_WEIGHTS = Object.freeze({
  adx: 0.5,
  fundingZ: 0.75,
  volumeRatio: 0.5,
  rangeRatio: 0.5,
  stopPct: 0.25,
  relativeReturn12: 0.75,
  distanceEmaAtr: 0.5,
  rsi: 0.5,
  return3: 0.75,
  regime: 0.5,
  btcRegime: 0.5,
  localTrend: 0.75,
});

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function mean(values) {
  const rows = values.map(Number).filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function clamp(value, low = 0, high = 100) {
  return Math.max(low, Math.min(high, Number(value) || 0));
}

function observationTime(row) {
  return Number(row?.signalTime ?? row?.t);
}

function stripOutcome(row) {
  const {outcome: _ignoredOutcome, ...exAnte} = row || {};
  return exAnte;
}

export function featureValue(row, name) {
  const features = row?.features || {};
  if (name === 'stopPct') return finite(row?.stopPct);
  if (name === 'regime') return features.regime ?? row?.regime ?? 'unknown';
  if (name === 'btcRegime') return features.btcRegime ?? row?.btcRouter ?? 'unknown';
  if (name === 'localTrend') {
    const close = finite(features.close);
    const ema50 = finite(features.ema50);
    const previousEma50 = finite(features.previousEma50);
    if (close == null || ema50 == null || previousEma50 == null) return 'unknown';
    if (row?.side === 'long' && close > ema50 && ema50 > previousEma50) return 'aligned';
    if (row?.side === 'short' && close < ema50 && ema50 < previousEma50) return 'aligned';
    return 'not-aligned';
  }
  return features[name] ?? row?.[name] ?? null;
}

export function bucketForFeature(name, value) {
  const config = FEATURE_CONFIG[name];
  if (!config) return 'unknown-feature';
  if (config.type === 'categorical') return value == null || value === '' ? 'missing' : String(value);
  const numeric = finite(value);
  if (numeric == null) return 'missing';
  const bounds = config.bounds;
  if (bounds.length === 3) {
    if (numeric < bounds[0]) return `<${bounds[0]}`;
    if (numeric < bounds[1]) return `${bounds[0]}-${bounds[1]}`;
    if (numeric < bounds[2]) return `${bounds[1]}-${bounds[2]}`;
    return `>=${bounds[2]}`;
  }
  if (numeric < bounds[0]) return `<${bounds[0]}`;
  if (numeric < bounds[1]) return `${bounds[0]}-${bounds[1]}`;
  if (numeric < bounds[2]) return `${bounds[1]}-${bounds[2]}`;
  if (numeric < bounds[3]) return `${bounds[2]}-${bounds[3]}`;
  return `>=${bounds[3]}`;
}

function labeledRows(observations, outcomes) {
  const byId = new Map((outcomes || []).map(row => [String(row.observationId ?? row.id), row]));
  return (observations || []).map(observation => ({
    observation: stripOutcome(observation),
    outcome: byId.get(String(observation.id ?? observation.observationId)),
  })).filter(row => row.outcome?.executable && Number.isFinite(Number(row.outcome.netR)));
}

function labelStats(rows, minimumBucketSamples) {
  const netR = rows.map(row => Number(row.outcome.netR)).filter(Number.isFinite);
  const netPnlUsdt = rows.map(row => Number(row.outcome.netPnlUsdt)).filter(Number.isFinite);
  const average = mean(netR);
  return {
    sample: rows.length,
    meanNetR: average,
    meanNetPnlUsdt: mean(netPnlUsdt),
    positiveRate: rows.length ? rows.filter(row => Number(row.outcome.netR) > 0).length / rows.length : null,
    sufficientSample: rows.length >= minimumBucketSamples,
  };
}

export function calibrateAlphaModels(observations, outcomes, {minimumBucketSamples = 20} = {}) {
  const alphas = [...new Set((observations || []).map(row => row.alpha).filter(Boolean))].sort();
  return Object.fromEntries(alphas.map(alpha => {
    const alphaObservations = (observations || []).filter(row => row.alpha === alpha);
    const labels = labeledRows(alphaObservations, outcomes);
    const baselineExpectancyR = mean(labels.map(row => Number(row.outcome.netR))) ?? 0;
    const featureBuckets = {};
    for (const feature of CALIBRATION_FEATURES) {
      const groups = new Map();
      for (const row of labels) {
        const bucket = bucketForFeature(feature, featureValue(row.observation, feature));
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket).push(row);
      }
      featureBuckets[feature] = Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right)).map(([bucket, rows]) => {
        const stats = labelStats(rows, minimumBucketSamples);
        return [bucket, {...stats, liftNetR: stats.sufficientSample ? Number(stats.meanNetR) - baselineExpectancyR : 0}];
      }));
    }
    return [alpha, {
      version: 'v81-walk-forward-score-1',
      alpha,
      trainingObservations: alphaObservations.length,
      trainingExecutableOutcomes: labels.length,
      baselineExpectancyR,
      minimumBucketSamples,
      featureBuckets,
      inferenceFeatures: CALIBRATION_FEATURES,
      frozenForValidation: true,
    }];
  }));
}

export function applyCalibratedScore(candidate, model) {
  const baseScore = finite(candidate?.edgeScore) ?? 0;
  let adjustment = 0;
  for (const feature of CALIBRATION_FEATURES) {
    const bucket = bucketForFeature(feature, featureValue(candidate, feature));
    const stats = model?.featureBuckets?.[feature]?.[bucket];
    if (!stats?.sufficientSample) continue;
    const lift = clamp(Number(stats.liftNetR) * 18, -6, 6);
    adjustment += lift * Number(FEATURE_WEIGHTS[feature] || 0.5);
  }
  const calibratedScore = clamp(baseScore + adjustment);
  const tier = classifyTier(calibratedScore);
  return {
    ...stripOutcome(candidate),
    originalEdgeScore: candidate?.edgeScore ?? null,
    edgeScore: calibratedScore,
    calibratedScore,
    calibrationVersion: model?.version || 'v81-walk-forward-score-1',
    calibrationAlpha: model?.alpha || candidate?.alpha || null,
    tier,
    tierLabel: tierLabel(tier),
  };
}

export function featureBucketMetrics(outcomes, {minimumSample = 30, start, end} = {}) {
  const rows = (outcomes || []).filter(row => row.executable && Number.isFinite(Number(row.netR)));
  return Object.fromEntries(CALIBRATION_FEATURES.map(feature => {
    const groups = new Map();
    for (const row of rows) {
      const bucket = bucketForFeature(feature, featureValue(row, feature));
      if (!groups.has(bucket)) groups.set(bucket, []);
      groups.get(bucket).push(row);
    }
    const buckets = Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right)).map(([bucket, bucketRows]) => {
      const metrics = calculateResearchMetrics(bucketRows, [], {initialEquity: 10_000, start, end});
      return [bucket, {
        sample: bucketRows.length,
        sufficientSample: bucketRows.length >= minimumSample,
        expectancyR: metrics.expectancyR,
        profitFactor: metrics.profitFactor,
        winRate: metrics.winRate,
        netR: bucketRows.reduce((sum, row) => sum + Number(row.netR || 0), 0),
        netPnlUsdt: metrics.netPnlUsdt,
      }];
    }));
    return [feature, {minimumSample, buckets}];
  }));
}

function validateFoldOrdering(folds, purgeDurationMs) {
  return folds.every(fold => Number(fold.trainUsed?.end) <= Number(fold.validation?.start) - purgeDurationMs
    && Number(fold.validation?.start) < Number(fold.validation?.end)
    && Number(fold.trainUsed?.start) < Number(fold.trainUsed?.end));
}

export function runPurgedWalkForward({observations = [], outcomes = [], folds = WALK_FORWARD_FOLDS, purgeDurationMs = PURGE_DURATION_MS} = {}) {
  const sortedObservations = [...observations].sort((a, b) => observationTime(a) - observationTime(b) || String(a.id).localeCompare(String(b.id)));
  const sortedOutcomes = [...outcomes].sort((a, b) => Number(a.signalTime) - Number(b.signalTime) || String(a.observationId).localeCompare(String(b.observationId)));
  const oofRows = [];
  const oofOutcomes = [];
  const foldReports = [];
  for (const fold of folds) {
    const trainUsedEnd = fold.validationStart - purgeDurationMs;
    const train = sortedObservations.filter(row => observationTime(row) >= fold.trainStart && observationTime(row) < trainUsedEnd);
    const purged = sortedObservations.filter(row => observationTime(row) >= trainUsedEnd && observationTime(row) < fold.validationStart);
    const validation = sortedObservations.filter(row => observationTime(row) >= fold.validationStart && observationTime(row) < fold.validationEnd);
    const models = calibrateAlphaModels(train, sortedOutcomes.filter(row => Number(row.signalTime) >= fold.trainStart && Number(row.signalTime) < trainUsedEnd));
    const modelRows = validation.map(candidate => {
      const scored = applyCalibratedScore(candidate, models[candidate.alpha]);
      return {...scored, oof: true, oofFold: fold.id, validationStart: fold.validationStart, validationEnd: fold.validationEnd};
    });
    const byId = new Map(modelRows.map(row => [String(row.id ?? row.observationId), row]));
    for (const outcome of sortedOutcomes) {
      const scored = byId.get(String(outcome.observationId ?? outcome.id));
      if (!scored) continue;
      oofOutcomes.push({
        ...outcome,
        oof: true,
        oofFold: fold.id,
        edgeScore: scored.edgeScore,
        calibratedScore: scored.calibratedScore,
        tier: scored.tier,
      });
    }
    oofRows.push(...modelRows);
    foldReports.push({
      id: fold.id,
      requestedTrain: {start: fold.trainStart, end: fold.trainEnd},
      trainUsed: {start: fold.trainStart, end: trainUsedEnd},
      validation: {start: fold.validationStart, end: fold.validationEnd},
      purgeDurationHours: purgeDurationMs / H1,
      trainObservations: train.length,
      purgedObservations: purged.length,
      validationObservations: validation.length,
      validationExecutableOutcomes: oofOutcomes.filter(row => row.oofFold === fold.id && row.executable).length,
      models: Object.fromEntries(Object.entries(models).map(([alpha, model]) => [alpha, {
        trainingObservations: model.trainingObservations,
        trainingExecutableOutcomes: model.trainingExecutableOutcomes,
        baselineExpectancyR: model.baselineExpectancyR,
        minimumBucketSamples: model.minimumBucketSamples,
        inferenceFeatures: model.inferenceFeatures,
        frozenForValidation: model.frozenForValidation,
      }])),
    });
  }
  const expectedValidationIds = new Set(sortedObservations.filter(row => folds.some(fold => observationTime(row) >= fold.validationStart && observationTime(row) < fold.validationEnd)).map(row => String(row.id ?? row.observationId)));
  const actualValidationIds = new Set(oofRows.map(row => String(row.id ?? row.observationId)));
  return {
    spec: {
      method: 'purged-walk-forward',
      purgeDurationMs,
      purgeDurationHours: purgeDurationMs / H1,
      noRandomSplit: true,
      outcomeLabelsUsedOnlyInTraining: true,
      inferenceFeatures: CALIBRATION_FEATURES,
    },
    folds: foldReports,
    oofRows,
    oofOutcomes,
    checks: {
      timeOrdered: foldReports.every(fold => fold.trainUsed.end <= fold.validation.start && fold.validation.start < fold.validation.end),
      purgeEnforced: validateFoldOrdering(foldReports, purgeDurationMs),
      validationFrozen: foldReports.every(fold => Object.values(fold.models).every(model => model.frozenForValidation)),
      completeValidationCoverage: expectedValidationIds.size === actualValidationIds.size && [...expectedValidationIds].every(id => actualValidationIds.has(id)),
    },
  };
}
