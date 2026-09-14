import {buildForwardSignal} from './contract.mjs';

function value(input, ...keys) {
  for (const key of keys) {
    if (input?.[key] !== undefined && input?.[key] !== null) return input[key];
  }
  return null;
}

function runValue(run, camel, snake) {
  return run?.[camel] ?? run?.[snake] ?? null;
}

function strategyHashFor(strategy, run, input) {
  const supplied = value(input, 'strategyHash', 'strategy_hash');
  const expected = strategy === 'V8'
    ? runValue(run, 'v8StrategySha256', 'v8_strategy_sha256')
    : runValue(run, 'v75StrategySha256', 'v75_strategy_sha256');
  if (supplied && expected && supplied !== expected) throw new Error('STRATEGY_MUTATION');
  return supplied || expected || null;
}

/**
 * The worker has two persisted shapes (teleeg_candidates and
 * teleeg_v8_shadow_signals). Keep their translation in one narrow adapter so
 * the forward contract never becomes a second production signal schema.
 */
export function adaptProductionAdvisory(input, {run, strategy = null, observedAt = Date.now(), existingSignals = []} = {}) {
  if (!run || run.status !== 'ACTIVE') throw new Error('forward signals require an ACTIVE run');
  const resolvedStrategy = strategy || (value(input, 'strategy', 'model', 'modelVersion', 'model_version')?.toString().toUpperCase().includes('V8') ? 'V8' : 'V7.5');
  const signal = {
    id: value(input, 'id', 'signalId', 'signal_id'),
    strategy: resolvedStrategy,
    strategyHash: strategyHashFor(resolvedStrategy, run, input),
    origin: 'forward-validation',
    symbol: value(input, 'symbol', 'baseAsset') || value(input, 'market_id', 'marketId'),
    marketId: value(input, 'market_id', 'marketId'),
    side: value(input, 'side'),
    signalTime: value(input, 'signalTime', 'signal_time', 't'),
    observedAt: value(input, 'observedAt', 'observed_at') ?? observedAt,
    signalPrice: value(input, 'signalPrice', 'signal_price', 'entry', 'price'),
    referenceEntry: value(input, 'referenceEntry', 'reference_entry', 'signal_price', 'entry', 'price'),
    stopLoss: value(input, 'stopLoss', 'stop_loss', 'stop', 'sl'),
    takeProfit: value(input, 'takeProfit', 'take_profit', 'target'),
    stopPct: value(input, 'stopPct', 'stop_pct'),
    targetR: value(input, 'targetR', 'target_r'),
    marketRegime: value(input, 'marketRegime', 'market_regime', 'regime') ?? input?.features?.btcRouter ?? null,
    score: value(input, 'score', 'edgeScore', 'edge_score'),
    confidence: value(input, 'confidence'),
    funding: value(input, 'funding'),
    context: value(input, 'context', 'features'),
    emailEligible: Boolean(value(input, 'emailEligible', 'email_eligible') ?? true),
    emailSent: Boolean(value(input, 'emailSent', 'email_sent') ?? false),
  };
  const normalizedRun = {
    ...run,
    runId: runValue(run, 'runId', 'run_id'),
    startedAt: runValue(run, 'startedAt', 'started_at'),
    v75StrategySha256: runValue(run, 'v75StrategySha256', 'v75_strategy_sha256'),
    v8StrategySha256: runValue(run, 'v8StrategySha256', 'v8_strategy_sha256'),
  };
  return buildForwardSignal(signal, {run: normalizedRun, existingSignals});
}

export const adaptV75ProductionAdvisory = (input, options = {}) =>
  adaptProductionAdvisory(input, {...options, strategy: 'V7.5'});

export const adaptV8ProductionAdvisory = (input, options = {}) =>
  adaptProductionAdvisory(input, {...options, strategy: 'V8'});

export function mapProductionOutcome(position, outcome = {}) {
  return {
    signalId: value(position, 'signalId', 'signal_id'),
    positionId: value(position, 'positionId', 'position_id', 'id'),
    openedAt: value(position, 'openedAt', 'opened_at', 'fillTime', 'fill_time'),
    entryPrice: value(position, 'entryPrice', 'entry_price', 'fillPrice', 'fill_price', 'entry'),
    closedAt: value(outcome, 'closedAt', 'closed_at', 'exitTime', 'exit_time') ?? value(position, 'exitTime', 'exit_time'),
    exitPrice: value(outcome, 'exitPrice', 'exit_price') ?? value(position, 'exitPrice', 'exit_price'),
    exitReason: value(outcome, 'exitReason', 'exit_reason') ?? value(position, 'exitReason', 'exit_reason'),
    grossPnl: value(outcome, 'grossPnl', 'gross_pnl', 'gross_pnl_usdt') ?? value(position, 'grossPnl', 'gross_pnl', 'gross_pnl_usdt'),
    feesCost: value(outcome, 'feesCost', 'fees_cost', 'modeledCost', 'modeled_cost_usdt') ?? value(position, 'modeledCost', 'modeled_cost_usdt'),
    funding: value(outcome, 'funding', 'fundingPnl', 'funding_pnl') ?? value(position, 'fundingPnl', 'funding_pnl_usdt'),
    netPnl: value(outcome, 'netPnl', 'net_pnl', 'net_pnl_usdt') ?? value(position, 'netPnl', 'net_pnl_usdt'),
    grossR: value(outcome, 'grossR', 'gross_r'),
    netR: value(outcome, 'netR', 'net_r') ?? value(position, 'netR', 'net_r'),
    status: value(outcome, 'status') ?? (value(outcome, 'closedAt', 'closed_at', 'exitTime', 'exit_time') ? 'closed' : 'open'),
    settledAt: value(outcome, 'settledAt', 'settled_at'),
  };
}
