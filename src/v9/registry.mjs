const freeze = value => Object.freeze(value);

export const V9_ALPHA_IDS = freeze([
  'FLOW_MOMENTUM',
  'FLOW_REVERSAL',
  'OI_TREND_CONFIRMATION',
  'CROWDED_UNWIND',
  'PREMIUM_DISLOCATION',
  'CROSS_SECTIONAL_FLOW_STRENGTH',
]);

export const V9_ALPHA_REGISTRY = freeze({
  FLOW_MOMENTUM: freeze({
    id: 'FLOW_MOMENTUM',
    version: 'v9-flow-1',
    family: 'flow_momentum',
    variants: freeze(['trend-confirmed', 'impulse-continuation']),
    requiredInputs: freeze(['takerImbalance', 'aggressiveVolumeZ', 'ema50', 'return3']),
    supportedSides: freeze(['long', 'short']),
    description: 'Price direction confirmed by completed-bar aggressive taker flow.',
  }),
  FLOW_REVERSAL: freeze({
    id: 'FLOW_REVERSAL',
    version: 'v9-flow-1',
    family: 'flow_reversal',
    variants: freeze(['exhaustion-rejection', 'failed-continuation']),
    requiredInputs: freeze(['takerImbalance', 'aggressiveVolumeZ', 'failedBreakoutUp', 'failedBreakoutDown']),
    supportedSides: freeze(['long', 'short']),
    description: 'Extreme aggressive flow with completed-bar rejection of continuation.',
  }),
  OI_TREND_CONFIRMATION: freeze({
    id: 'OI_TREND_CONFIRMATION',
    version: 'v9-open-interest-1',
    family: 'oi_trend_confirmation',
    variants: freeze(['price-oi-alignment', 'price-oi-divergence']),
    requiredInputs: freeze(['openInterest', 'oiChange', 'oiZ', 'return3']),
    supportedSides: freeze(['long', 'short']),
    description: 'Structured price/open-interest state; disabled unless historical OI is present.',
  }),
  CROWDED_UNWIND: freeze({
    id: 'CROWDED_UNWIND',
    version: 'v9-crowding-1',
    family: 'crowded_unwind',
    variants: freeze(['funding-premium-unwind', 'oi-crowding-unwind']),
    requiredInputs: freeze(['fundingZ', 'premiumZ', 'oiChange', 'return3']),
    supportedSides: freeze(['long', 'short']),
    description: 'Funding/premium/OI crowding followed by a price unwind; requires real derivative history.',
  }),
  PREMIUM_DISLOCATION: freeze({
    id: 'PREMIUM_DISLOCATION',
    version: 'v9-premium-1',
    family: 'premium_dislocation',
    variants: freeze(['mean-reversion', 'continuation']),
    requiredInputs: freeze(['premiumIndex', 'premiumZ', 'markIndexSpread', 'return3']),
    supportedSides: freeze(['long', 'short']),
    description: 'Mark/index or premium dislocation with a preregistered response variant.',
  }),
  CROSS_SECTIONAL_FLOW_STRENGTH: freeze({
    id: 'CROSS_SECTIONAL_FLOW_STRENGTH',
    version: 'v9-cross-sectional-1',
    family: 'cross_sectional_flow_strength',
    variants: freeze(['return-flow-leaders', 'btc-aligned-leaders']),
    requiredInputs: freeze(['crossSectionalReturnRank', 'crossSectionalFlowRank', 'takerImbalance', 'btcRegime']),
    supportedSides: freeze(['long', 'short']),
    description: 'Cross-sectional price leaders confirmed by taker-flow rank and BTC context.',
  }),
});

export const V9_SCORECARD = freeze({
  version: 'v9-interpretable-scorecard-1',
  base: 28,
  weights: freeze({
    flow: 38,
    aggressiveVolume: 7,
    trend: 15,
    crossSectional: 12,
    btcContext: 5,
    funding: 4,
    derivatives: 6,
  }),
  tiers: freeze({highConfidence: 88, qualified: 76}),
});

export function validateV9Registry(registry = V9_ALPHA_REGISTRY) {
  const errors = [];
  for (const id of V9_ALPHA_IDS) {
    const item = registry[id];
    if (!item || item.id !== id || !item.version || !item.family) errors.push(`${id}:identity`);
    if (!item?.variants || item.variants.length < 1 || item.variants.length > 2) errors.push(`${id}:variants`);
    if (!item?.requiredInputs?.length || !item?.supportedSides?.length) errors.push(`${id}:inputs`);
    if (!item?.description) errors.push(`${id}:description`);
  }
  return {valid: errors.length === 0, errors};
}
