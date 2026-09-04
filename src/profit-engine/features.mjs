export const SOURCE_NAMES = Object.freeze([
  'TREND_PRIMITIVE', 'PULLBACK_PRIMITIVE', 'FLOW_PRIMITIVE',
  'CROSS_SECTION_PRIMITIVE', 'CROWDING_PRIMITIVE', 'VOLATILITY_PRIMITIVE', 'V8_BASELINE',
]);

export const R1_FEATURE_NAMES = Object.freeze([
  'candidateCount', 'longFraction', 'coreFraction', 'meanEdgeScore', 'meanStopPct',
  'meanVolumeRatio', 'meanRangeRatio', 'meanFundingZ', 'meanReturn12',
  'meanCrossSectionalReturnRank', 'meanCrossSectionalFlowRank', 'featureDispersion',
]);

export const R2_FEATURE_NAMES = Object.freeze([
  'return4', 'return12', 'return24', 'return72', 'atrPct', 'adx', 'distanceEmaAtr',
  'emaSlope', 'volumeRatio', 'rangeRatio', 'takerImbalance', 'aggressiveVolumeZ',
  'fundingZ', 'fundingChange', 'premiumZ', 'premiumChange', 'markIndexSpread',
  'oiChange1h', 'oiChange4h', 'oiChange12h', 'oiZ', 'crossSectionalReturnRank',
  'crossSectionalFlowRank', 'liquidity', 'listingAgeHours', 'stopPct', 'longSide',
  ...SOURCE_NAMES,
]);

export const R3_FEATURE_NAMES = Object.freeze([
  'r1Score', 'predictedNetR', 'rankPercentile', 'stopPct', 'liquidity', 'volatility',
  'longSide', 'bullRegime', 'bearRegime', 'sidewaysRegime', ...SOURCE_NAMES,
]);

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function sourceSet(row) {
  return new Set(row?.proposalSources || row?.alphaSources || []);
}

function features(row) { return row?.features || {}; }

export function featureValue(row, name) {
  const f = features(row);
  if (name === 'atrPct') {
    const atr = finite(f.atr ?? row?.atr);
    const close = finite(f.close ?? row?.signalPrice ?? row?.entry);
    return atr != null && close > 0 ? atr / close : null;
  }
  if (name === 'emaSlope') {
    const current = finite(f.ema50);
    const previous = finite(f.previousEma50);
    return current != null && previous != null && previous !== 0 ? current / previous - 1 : null;
  }
  if (name === 'longSide') return row?.side === 'long' ? 1 : row?.side === 'short' ? 0 : null;
  if (SOURCE_NAMES.includes(name)) return sourceSet(row).has(name) ? 1 : 0;
  if (name === 'liquidity') return finite(row?.liquidity ?? f.liquidity ?? row?.dayVolume ?? f.q);
  if (name === 'listingAgeHours') {
    const listing = finite(row?.listingTime ?? f.listingTime);
    const time = finite(row?.signalTime ?? row?.t);
    return listing != null && time != null ? Math.max(0, (time - listing) / 3_600_000) : null;
  }
  if (name === 'stopPct') return finite(row?.stopPct);
  return finite(row?.[name] ?? f[name]);
}

export function r2FeatureVector(row) {
  return Object.fromEntries(R2_FEATURE_NAMES.map(name => [name, featureValue(row, name)]));
}

export function r3FeatureVector(row) {
  const f = features(row);
  const regime = row?.regime ?? f.regime;
  const volatility = finite(f.rangeRatio ?? row?.rangeRatio);
  return Object.fromEntries(R3_FEATURE_NAMES.map(name => [name, (() => {
    if (name === 'r1Score') return finite(row?.r1Score);
    if (name === 'predictedNetR') return finite(row?.predictedNetR);
    if (name === 'rankPercentile') return finite(row?.rankPercentile);
    if (name === 'volatility') return volatility;
    if (name === 'bullRegime') return regime === 'bull' ? 1 : 0;
    if (name === 'bearRegime') return regime === 'bear' ? 1 : 0;
    if (name === 'sidewaysRegime') return regime === 'sideways' || regime === 'neutral' ? 1 : 0;
    return featureValue(row, name);
  })()]));
}

export function aggregateMarketFeatures(rows) {
  const values = rows || [];
  const average = name => {
    const observed = values.map(row => featureValue(row, name)).filter(value => value != null);
    return observed.length ? observed.reduce((sum, value) => sum + value, 0) / observed.length : null;
  };
  const returns = values.map(row => featureValue(row, 'return12')).filter(value => value != null);
  const meanReturn = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  const dispersion = returns.length ? Math.sqrt(returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / returns.length) : null;
  return {
    candidateCount: values.length,
    longFraction: values.length ? values.filter(row => row.side === 'long').length / values.length : null,
    coreFraction: values.length ? values.filter(row => row.core).length / values.length : null,
    meanEdgeScore: average('edgeScore'), meanStopPct: average('stopPct'),
    meanVolumeRatio: average('volumeRatio'), meanRangeRatio: average('rangeRatio'),
    meanFundingZ: average('fundingZ'), meanReturn12: average('return12'),
    meanCrossSectionalReturnRank: average('crossSectionalReturnRank'),
    meanCrossSectionalFlowRank: average('crossSectionalFlowRank'), featureDispersion: dispersion,
  };
}
