const STRATEGY_REJECTION_REASONS = new Set([
  'candidate-not-found', 'signal-expired', 'invalid-fill-time', 'invalid-market-tick',
  'symbol-already-open', 'symbol-cooldown', 'portfolio-cap', 'side-cap',
  'timestamp-side-cap', 'invalid-fill-or-stop', 'invalid-stop-distance',
  'fill-stop-risk-out-of-bounds', 'fill-target-risk-too-low', 'quantity-below-market-minimum',
  'invalid-equity', 'portfolio-risk-cap', 'correlated-risk-cap',
  'drawdown-stop', 'loss-streak-stop',
]);

export function classifyFinalizeFailure(error, phase) {
  const message = String(error?.message ?? error ?? '');
  if (phase === 'market-data') return message.includes('fill-price-unavailable') ? 'fill-price-unavailable' : 'market-data-error';
  if (phase === 'candidate-patch' || phase === 'position-write') return 'database-error';
  if (phase === 'acceptance-rpc') return 'acceptance-rpc-error';
  return STRATEGY_REJECTION_REASONS.has(message) ? message : 'database-error';
}
