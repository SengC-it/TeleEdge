import {R3_FEATURE_NAMES, r3FeatureVector} from './features.mjs';
import {fitLogistic, predictProbability} from './linear-models.mjs';
import {fitTrainNormalizer} from './normalization.mjs';

export function fitMetaEdgeModel(rows, {lambda = 0.1} = {}) {
  const vectors = rows.map(row => r3FeatureVector(row));
  const normalizer = fitTrainNormalizer(vectors, R3_FEATURE_NAMES, {getValue: (row, name) => row[name]});
  const design = vectors.map(row => normalizer.transform(row).values);
  const target = rows.map(row => Number(row.outcome?.netR ?? row.netR) > 0 ? 1 : 0);
  return {model: fitLogistic(design, target, {lambda, featureNames: R3_FEATURE_NAMES, maxIterations: 25}), normalizer, trainRows: rows.length, lambda};
}

export function scoreMetaEdge(fitted, row) {
  if (!fitted) return null;
  return predictProbability(fitted.model, fitted.normalizer.transform(r3FeatureVector(row)).values);
}
