import {adaptV75ProductionAdvisory, adaptV8ProductionAdvisory, mapProductionOutcome} from './production-adapter.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function retry(operation, {attempts = 3, delayMs = 150} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await operation(); } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(delayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

export function toSignalRpcPayload(signal) {
  return {
    id: signal.id,
    strategy: signal.strategy,
    strategy_hash: signal.strategyHash,
    origin: signal.origin,
    symbol: signal.symbol,
    side: signal.side,
    signal_time: signal.signalTime,
    observed_at: signal.observedAt,
    signal_price: signal.signalPrice,
    reference_entry: signal.referenceEntry,
    stop_loss: signal.stopLoss,
    take_profit: signal.takeProfit,
    stop_pct: signal.stopPct,
    target_r: signal.targetR,
    market_regime: signal.marketRegime,
    score: signal.score,
    confidence: signal.confidence,
    funding: signal.funding,
    context: signal.context,
    email_eligible: signal.emailEligible,
    email_sent: signal.emailSent,
    overlap_group_id: signal.overlapGroupId,
    dedupe_key: signal.dedupeKey,
  };
}

export function toOutcomeRpcPayload(outcome) {
  return {
    signal_id: outcome.signalId,
    position_id: outcome.positionId,
    opened_at: outcome.openedAt,
    entry_price: outcome.entryPrice,
    closed_at: outcome.closedAt,
    exit_price: outcome.exitPrice,
    exit_reason: outcome.exitReason,
    gross_pnl: outcome.grossPnl,
    fees_cost: outcome.feesCost,
    funding: outcome.funding,
    net_pnl: outcome.netPnl,
    gross_r: outcome.grossR,
    net_r: outcome.netR,
    status: outcome.status,
    settled_at: outcome.settledAt,
  };
}

/**
 * Persistence is deliberately injected. Production supplies the Supabase
 * RPC client; tests and local tooling can use a fake. All failures are
 * returned, never allowed to change the advisory/paper decision.
 */
export function createForwardPersistence({rpc, listSignals, attempts = 3} = {}) {
  if (typeof rpc !== 'function') throw new Error('forward persistence requires rpc');
  return {
    async recordSignal(signal, run) {
      return retry(() => rpc('forward_validation_record_signal', {p_run_id: run.runId ?? run.run_id, p_signal: toSignalRpcPayload(signal)}), {attempts});
    },
    async recordOutcome(outcome, run) {
      return retry(() => rpc('forward_validation_record_outcome', {p_run_id: run.runId ?? run.run_id, p_signal_id: outcome.signalId, p_outcome: toOutcomeRpcPayload(outcome)}), {attempts});
    },
    async existingSignals({runId, symbol, side, before}) {
      if (typeof listSignals !== 'function') return [];
      return retry(() => listSignals({runId, symbol, side, before}), {attempts});
    },
  };
}

export async function recordProductionAdvisory({run, advisory, strategy, observedAt, existingSignals = [], persist}) {
  if (run?.status !== 'ACTIVE') return {recorded: false, reason: 'no-active-forward-run', advisorySuppressed: false};
  const adapt = strategy === 'V8' ? adaptV8ProductionAdvisory : adaptV75ProductionAdvisory;
  try {
    const signal = adapt(advisory, {run, observedAt});
    const withEpisode = adapt(advisory, {run, observedAt, existingSignals});
    if (!persist) return {recorded: true, signal: withEpisode, advisorySuppressed: false};
    const persisted = await persist(withEpisode, run);
    return {recorded: true, signal: withEpisode, persisted, advisorySuppressed: false};
  } catch (error) {
    return {recorded: false, advisorySuppressed: false, error: String(error)};
  }
}

export async function recordProductionOutcome({run, position, outcome, persist}) {
  if (!run || run.status !== 'ACTIVE' || typeof persist !== 'function') return {recorded: false, reason: 'no-active-forward-run'};
  try {
    const mapped = mapProductionOutcome(position, outcome);
    return {recorded: true, outcome: mapped, persisted: await persist(mapped, run)};
  } catch (error) {
    return {recorded: false, error: String(error)};
  }
}
