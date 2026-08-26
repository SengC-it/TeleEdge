export const TIER_THRESHOLDS = Object.freeze({
  highConfidence: 78,
  qualified: 62,
});

export const TIER_LABELS = Object.freeze({
  C: 'RESEARCH',
  B: 'QUALIFIED / EXPERIMENTAL',
  A: 'HIGH CONFIDENCE / EXPERIMENTAL',
});

export function classifyTier(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'C';
  if (value >= TIER_THRESHOLDS.highConfidence) return 'A';
  if (value >= TIER_THRESHOLDS.qualified) return 'B';
  return 'C';
}

export function tierLabel(tier) {
  return TIER_LABELS[tier] || TIER_LABELS.C;
}
