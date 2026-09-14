import {
  RUNTIME_PRODUCTION_SEMANTIC_SHA256,
  RUNTIME_V75_STRATEGY_SHA256,
  RUNTIME_V8_STRATEGY_SHA256,
} from './forward-freeze.generated.mjs';

const encoder = new TextEncoder();

export const RUNTIME_FINGERPRINT = Object.freeze({
  v75StrategySha256: RUNTIME_V75_STRATEGY_SHA256,
  v8StrategySha256: RUNTIME_V8_STRATEGY_SHA256,
  productionSemanticSha256: RUNTIME_PRODUCTION_SEMANTIC_SHA256,
});

function first(input, ...keys) {
  for (const key of keys) if (input?.[key] !== undefined && input?.[key] !== null) return input[key];
  return null;
}

function runShape(row) {
  if (!row) return null;
  return {
    ...row,
    runId: row.runId ?? row.run_id,
    status: row.status,
    startedAt: row.startedAt ?? row.started_at,
    v75StrategySha256: row.v75StrategySha256 ?? row.v75_strategy_sha256,
    v8StrategySha256: row.v8StrategySha256 ?? row.v8_strategy_sha256,
    productionWorkerSha256: row.productionWorkerSha256 ?? row.production_worker_sha256,
  };
}

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function bounded(operation, timeoutMs = 8_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('forward-validation persistence timeout')), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

async function activeRun(db) {
  const rows = await db('forward_validation_runs?status=eq.ACTIVE&order=started_at.desc&limit=1');
  return runShape(rows?.[0]);
}

async function outcomeRun(db, signalId) {
  const active = await activeRun(db);
  if (active) return active;
  const signals = await db(`forward_validation_signals?id=eq.${encodeURIComponent(signalId)}&select=run_id&limit=1`);
  if (!signals?.[0]?.run_id) return null;
  const runs = await db(`forward_validation_runs?run_id=eq.${encodeURIComponent(signals[0].run_id)}&limit=1`);
  return runShape(runs?.[0]);
}

export function adaptWorkerAdvisory(input, {run, strategy, observedAt = Date.now(), runtimeFingerprint = RUNTIME_FINGERPRINT} = {}) {
  const resolved = strategy || (String(first(input, 'strategy', 'model_version', 'modelVersion') || '').toUpperCase().includes('V8') ? 'V8' : 'V7.5');
  const runtimeStrategyHash = resolved === 'V8' ? runtimeFingerprint.v8StrategySha256 : runtimeFingerprint.v75StrategySha256;
  const runtimeSemanticHash = runtimeFingerprint.productionSemanticSha256;
  const suppliedHash = first(input, 'strategy_hash', 'strategyHash');
  const marketId = first(input, 'market_id', 'marketId') || first(input, 'symbol');
  const signalTime = first(input, 'signal_time', 'signalTime', 't');
  const signal = {
    id: first(input, 'signal_id', 'signalId', 'id'),
    strategy: resolved,
    strategy_hash: runtimeStrategyHash,
    production_semantic_hash: runtimeSemanticHash,
    source_strategy_hash: suppliedHash,
    origin: 'forward-validation',
    symbol: first(input, 'symbol', 'baseAsset') || marketId,
    market_id: marketId,
    side: first(input, 'side'),
    signal_time: signalTime,
    observed_at: first(input, 'observed_at', 'observedAt') || new Date(observedAt).toISOString(),
    signal_price: first(input, 'signal_price', 'signalPrice', 'entry', 'price'),
    reference_entry: first(input, 'reference_entry', 'referenceEntry', 'signal_price', 'entry', 'price'),
    stop_loss: first(input, 'stop_loss', 'stopLoss', 'stop', 'sl'),
    take_profit: first(input, 'take_profit', 'takeProfit', 'target'),
    stop_pct: first(input, 'stop_pct', 'stopPct'),
    target_r: first(input, 'target_r', 'targetR'),
    market_regime: first(input, 'market_regime', 'marketRegime', 'regime') ?? input?.features?.btcRouter ?? null,
    score: first(input, 'score', 'edge_score', 'edgeScore'),
    confidence: first(input, 'confidence'),
    funding: first(input, 'funding'),
    context: first(input, 'context', 'features'),
    email_eligible: true,
    email_sent: Boolean(first(input, 'email_sent', 'emailSent') || false),
  };
  return signal;
}

async function recordSignal({db, rpc, advisory, strategy, observedAt = Date.now(), runtimeFingerprint = RUNTIME_FINGERPRINT}) {
  const run = await activeRun(db);
  if (!run) return {recorded: false, reason: 'no-active-forward-run'};
  const signal = adaptWorkerAdvisory(advisory, {run, strategy, observedAt, runtimeFingerprint});
  if (!signal.signal_time || !signal.side || !signal.symbol) throw new Error('invalid forward advisory shape');
  const time = Date.parse(signal.signal_time);
  if (!Number.isFinite(time) || time < Date.parse(run.startedAt)) throw new Error('historical backfill is forbidden');
  const existing = await db(`forward_validation_signals?run_id=eq.${encodeURIComponent(run.runId)}&symbol=eq.${encodeURIComponent(signal.symbol)}&side=eq.${encodeURIComponent(signal.side)}&signal_time=lte.${encodeURIComponent(signal.signal_time)}&select=id,independent_id,signal_time&order=signal_time.desc&limit=4`);
  signal.overlap_group_id = await digest(['overlap', signal.symbol, signal.side, time].join('|'));
  signal.dedupe_key = await digest([signal.strategy, signal.symbol, signal.side, time].join('|'));
  const result = await rpc('forward_validation_record_signal', {
    p_run_id: run.runId,
    p_signal: signal,
    p_runtime_strategy_hash: signal.strategy_hash,
    p_runtime_production_semantic_sha256: signal.production_semantic_hash,
  });
  if (result?.invalidated || result?.reason === 'STRATEGY_MUTATION') throw new Error('STRATEGY_MUTATION');
  return {recorded: true, runId: run.runId, signalId: signal.id, existingSignals: existing.length, result};
}

export async function recordForwardAccepted({db, rpc, advisory, strategy, observedAt = Date.now(), timeoutMs = 8_000, runtimeFingerprint = RUNTIME_FINGERPRINT} = {}) {
  try {
    return await bounded(() => recordSignal({db, rpc, advisory, strategy, observedAt, runtimeFingerprint}), timeoutMs);
  } catch (error) {
    console.error('TeleEdge forward signal logging failed', {signalId: first(advisory, 'signal_id', 'signalId', 'id'), error: String(error)});
    return {recorded: false, error: String(error)};
  }
}

export async function recordForwardOutcome({db, rpc, position, outcome = {}, timeoutMs = 8_000} = {}) {
  try {
    return await bounded(() => recordOutcome({db, rpc, position, outcome}), timeoutMs);
  } catch (error) {
    console.error('TeleEdge forward outcome logging failed', {signalId: first(position, 'signal_id', 'signalId'), error: String(error)});
    return {recorded: false, error: String(error)};
  }
}

async function recordOutcome({db, rpc, position, outcome}) {
    const run = await outcomeRun(db, first(position, 'signal_id', 'signalId'));
    if (!run) return {recorded: false, reason: 'no-active-forward-run'};
    const signalId = first(position, 'signal_id', 'signalId');
    const row = {
      signal_id: signalId,
      position_id: first(position, 'position_id', 'positionId', 'id'),
      opened_at: first(position, 'opened_at', 'openedAt', 'fill_time', 'fillTime'),
      entry_price: first(position, 'entry_price', 'entryPrice', 'fill_price', 'fillPrice', 'entry'),
      closed_at: first(outcome, 'closed_at', 'closedAt', 'exit_time', 'exitTime'),
      exit_price: first(outcome, 'exit_price', 'exitPrice'),
      exit_reason: first(outcome, 'exit_reason', 'exitReason'),
      gross_pnl: first(outcome, 'gross_pnl', 'grossPnl', 'gross_pnl_usdt'),
      fees_cost: first(outcome, 'fees_cost', 'feesCost', 'modeled_cost_usdt'),
      funding: first(outcome, 'funding', 'fundingPnl', 'funding_pnl_usdt'),
      net_pnl: first(outcome, 'net_pnl', 'netPnl', 'net_pnl_usdt'),
      gross_r: first(outcome, 'gross_r', 'grossR'),
      net_r: first(outcome, 'net_r', 'netR'),
      status: first(outcome, 'status') || (first(outcome, 'closed_at', 'closedAt', 'exit_time', 'exitTime') ? 'closed' : 'open'),
      settled_at: first(outcome, 'settled_at', 'settledAt') || new Date().toISOString(),
    };
    if (!row.signal_id || !row.opened_at || !(Number(row.entry_price) > 0)) throw new Error('invalid forward outcome shape');
    const result = await rpc('forward_validation_record_outcome', {p_run_id: run.runId, p_signal_id: row.signal_id, p_outcome: row});
    return {recorded: true, runId: run.runId, signalId: row.signal_id, result};
}
