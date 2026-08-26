const freeze = value => Object.freeze(value);

export const BASELINE_ALPHA_IDS = freeze([
  'v8_daily_breakout_long',
  'v8_funding_crowding_short',
  'v8_volume_shock_short',
  'v8_bear_trend_short',
]);

export const RESEARCH_ALPHA_IDS = freeze([
  'trend_pullback_continuation',
  'volatility_expansion',
  'failed_breakout_reversal',
  'mean_reversion_extreme',
  'funding_price_divergence',
  'relative_strength_btc_rotation',
]);

export const ALPHA_REGISTRY = freeze({
  v8_daily_breakout_long: freeze({
    id: 'v8_daily_breakout_long', version: 'v8-anchor-1', family: 'daily_breakout',
    supportedSides: freeze(['long']), supportedRegimes: freeze(['bull']),
    requiredInputs: freeze(['daily_breakout', 'ema', 'breadth', 'funding']), targetR: 2,
    riskConstraints: freeze({minStopPct: 0.02, maxStopPct: 0.12}),
    description: 'Frozen V8 daily breakout long baseline anchor; not modified by V8.1.',
    baseline: true,
  }),
  v8_funding_crowding_short: freeze({
    id: 'v8_funding_crowding_short', version: 'v8-anchor-1', family: 'funding_crowding',
    supportedSides: freeze(['short']), supportedRegimes: freeze(['bull', 'sideways']),
    requiredInputs: freeze(['funding_z', 'rsi', 'volume']), targetR: 2,
    riskConstraints: freeze({minStopPct: 0.02, maxStopPct: 0.08}),
    description: 'Frozen V8 funding crowding reversal baseline anchor; not modified by V8.1.',
    baseline: true,
  }),
  v8_volume_shock_short: freeze({
    id: 'v8_volume_shock_short', version: 'v8-anchor-1', family: 'volume_shock',
    supportedSides: freeze(['short']), supportedRegimes: freeze(['bull', 'sideways']),
    requiredInputs: freeze(['volume_ratio', 'range_ratio', 'btc_context']), targetR: 2,
    riskConstraints: freeze({minStopPct: 0.02, maxStopPct: 0.10}),
    description: 'Frozen V8 volume shock reversal baseline anchor; not modified by V8.1.',
    baseline: true,
  }),
  v8_bear_trend_short: freeze({
    id: 'v8_bear_trend_short', version: 'v8-anchor-1', family: 'bear_trend',
    supportedSides: freeze(['short']), supportedRegimes: freeze(['bear']),
    requiredInputs: freeze(['ema', 'adx', 'breakdown', 'btc_context']), targetR: 2,
    riskConstraints: freeze({minStopPct: 0.02, maxStopPct: 0.12}),
    description: 'Frozen V8 bear trend short baseline anchor; not modified by V8.1.',
    baseline: true,
  }),
  trend_pullback_continuation: freeze({
    id: 'trend_pullback_continuation', version: 'v81-primary-1', family: 'trend_pullback',
    supportedSides: freeze(['long', 'short']), supportedRegimes: freeze(['bull', 'bear']),
    requiredInputs: freeze(['ema20', 'ema50', 'adx', 'atr', 'pullback']), targetR: 2,
    riskConstraints: freeze({minStopPct: 0.02, maxStopPct: 0.12, minAdx: 18}),
    description: 'Continuation after a completed-bar pullback to the fast trend average.',
  }),
  volatility_expansion: freeze({
    id: 'volatility_expansion', version: 'v81-primary-1', family: 'volatility_expansion',
    supportedSides: freeze(['long', 'short']), supportedRegimes: freeze(['bull', 'bear', 'sideways']),
    requiredInputs: freeze(['atr', 'range_ratio', 'volume_ratio', 'breakout']), targetR: 2,
    riskConstraints: freeze({minStopPct: 0.02, maxStopPct: 0.12, minRangeRatio: 1.5, minVolumeRatio: 1.4}),
    description: 'Range and volume expansion confirmed by a close beyond the prior range.',
  }),
  failed_breakout_reversal: freeze({
    id: 'failed_breakout_reversal', version: 'v81-primary-1', family: 'failed_breakout',
    supportedSides: freeze(['long', 'short']), supportedRegimes: freeze(['bull', 'bear', 'sideways']),
    requiredInputs: freeze(['prior_range', 'wick_rejection', 'atr']), targetR: 1.8,
    riskConstraints: freeze({minStopPct: 0.02, maxStopPct: 0.12}),
    description: 'Reversal after an intrabar range breach closes back inside the prior range.',
  }),
  mean_reversion_extreme: freeze({
    id: 'mean_reversion_extreme', version: 'v81-primary-1', family: 'mean_reversion',
    supportedSides: freeze(['long', 'short']), supportedRegimes: freeze(['sideways']),
    requiredInputs: freeze(['rsi', 'ema20', 'atr', 'distance_to_mean']), targetR: 1.6,
    riskConstraints: freeze({minStopPct: 0.02, maxStopPct: 0.12, maxAdx: 25}),
    description: 'Extreme displacement from the mean with a completed-bar momentum turn.',
  }),
  funding_price_divergence: freeze({
    id: 'funding_price_divergence', version: 'v81-primary-1', family: 'funding_divergence',
    supportedSides: freeze(['long', 'short']), supportedRegimes: freeze(['bull', 'bear', 'sideways']),
    requiredInputs: freeze(['funding_z', 'return_3', 'volume_ratio']), targetR: 1.8,
    riskConstraints: freeze({minStopPct: 0.02, maxStopPct: 0.12, minFundingZ: 1.5}),
    description: 'Contrarian funding pressure confirmed by short-horizon price resilience or weakness.',
  }),
  relative_strength_btc_rotation: freeze({
    id: 'relative_strength_btc_rotation', version: 'v81-primary-1', family: 'relative_strength',
    supportedSides: freeze(['long', 'short']), supportedRegimes: freeze(['bull', 'bear', 'sideways']),
    requiredInputs: freeze(['return_12', 'btc_return_12', 'btc_context', 'ema50']), targetR: 1.8,
    riskConstraints: freeze({minStopPct: 0.02, maxStopPct: 0.12, minRelativeReturn: 0.05}),
    description: 'Cross-sectional rotation relative to BTC with a local trend confirmation.',
  }),
});

export function getResearchAlphaRegistry() {
  return Object.fromEntries(Object.entries(ALPHA_REGISTRY).map(([id, value]) => [id, {...value}]));
}

export function validateAlphaRegistry(registry = ALPHA_REGISTRY) {
  const errors = [];
  for (const [id, item] of Object.entries(registry)) {
    if (item.id !== id || !item.version || !item.family) errors.push(`${id}:identity`);
    if (!item.supportedSides?.length || !item.supportedRegimes?.length) errors.push(`${id}:scope`);
    if (!item.requiredInputs?.length || !(Number(item.targetR) > 0)) errors.push(`${id}:inputs`);
    if (!(Number(item.riskConstraints?.minStopPct) > 0) || !(Number(item.riskConstraints?.maxStopPct) > 0)) errors.push(`${id}:risk`);
    if (!item.description) errors.push(`${id}:description`);
  }
  for (const id of [...BASELINE_ALPHA_IDS, ...RESEARCH_ALPHA_IDS]) if (!registry[id]) errors.push(`${id}:missing`);
  return {valid: errors.length === 0, errors};
}
