function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function quantile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function fitTrainNormalizer(rows, featureNames, {getValue = (row, name) => row?.[name], clip = 6} = {}) {
  const stats = Object.fromEntries(featureNames.map(name => {
    const values = (rows || []).map(row => finite(getValue(row, name))).filter(value => value != null);
    const median = quantile(values, 0.5);
    const scale = Math.max(1e-9, quantile(values, 0.75) - quantile(values, 0.25) || 1);
    return [name, {median, scale, observed: values.length}];
  }));
  return {
    method: 'train-only-median-IQR', featureNames: [...featureNames], clip: Number(clip), stats,
    transform(row) {
      const values = [];
      const missing = {};
      for (const name of featureNames) {
        const raw = finite(getValue(row, name));
        const stat = stats[name] || {median: 0, scale: 1, observed: 0};
        missing[name] = raw == null;
        const normalized = ((raw == null ? stat.median : raw) - stat.median) / stat.scale;
        values.push(Math.max(-Number(clip), Math.min(Number(clip), Number.isFinite(normalized) ? normalized : 0)));
      }
      return {values, missing};
    },
  };
}

export function transformRows(rows, normalizer) {
  return (rows || []).map(row => normalizer.transform(row));
}

export function normalizerSummary(normalizer) {
  return {method: normalizer?.method, featureNames: normalizer?.featureNames || [], clip: normalizer?.clip, stats: normalizer?.stats || {}};
}
