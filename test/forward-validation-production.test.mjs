import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {authorizeForwardRequest, getHeader} from '../api/forward-validation.mjs';
import {activateRun, createPreparedRun, enforceStrategyHashes, sha256} from '../src/forward-validation/contract.mjs';
import {adaptV75ProductionAdvisory, adaptV8ProductionAdvisory, mapProductionOutcome} from '../src/forward-validation/production-adapter.mjs';
import {createForwardPersistence, recordProductionAdvisory, recordProductionOutcome} from '../src/forward-validation/persistence.mjs';
import {auditProductionIsolation, auditProductionSemanticIsolation, auditStrategyFreeze, computeStrategyFreeze} from '../src/forward-validation/freeze.mjs';
import {adaptWorkerAdvisory, recordForwardAccepted} from '../supabase/functions/teleeg-worker/forward-validation.mjs';

const HASH75 = sha256('v75-production');
const HASH8 = sha256('v8-production');
const RUN = activateRun(createPreparedRun({
  runId: 'production-run', baseMainSha: sha256('main'), v75StrategySha256: HASH75,
  v8StrategySha256: HASH8, strategyFreezeManifestSha256: sha256('freeze'),
  preparedAt: '2026-01-01T00:00:00Z',
}), {startedAt: '2026-01-02T00:00:00Z'});

function control(overrides = {}) {
  return {
    signal_id: 'V75|BTCUSDT|long|1775001600000', market_id: 'BTCUSDT', symbol: 'BTC', side: 'long',
    signal_time: '2026-04-01T00:00:00Z', signal_price: 100, entry: 100, stop: 98, target: 104,
    stop_pct: 0.02, target_r: 2, features: {btcRouter: 'bull'}, edge_score: 0.8, event_score: 2,
    ...overrides,
  };
}

test('production adapter maps actual V7.5 and V8 worker shapes and active-run hash', () => {
  const v75 = adaptV75ProductionAdvisory(control(), {run: RUN, observedAt: '2026-04-01T00:20:00Z'});
  const v8 = adaptV8ProductionAdvisory({...control(), signal_id: 'v8-1', alpha: 'bear'}, {run: RUN, observedAt: '2026-04-01T00:20:00Z'});
  assert.equal(v75.strategy, 'V7.5');
  assert.equal(v75.strategyHash, HASH75);
  assert.equal(v75.symbol, 'BTC');
  assert.equal(v75.referenceEntry, 100);
  assert.equal(v75.stopLoss, 98);
  assert.equal(v75.takeProfit, 104);
  assert.equal(v8.strategy, 'V8');
  assert.equal(v8.strategyHash, HASH8);
  assert.throws(() => adaptV75ProductionAdvisory(control({strategy_hash: HASH8}), {run: RUN}), /STRATEGY_MUTATION/);
});

test('worker adapter accepts the persisted candidate shape without a second signal schema', () => {
  const row = adaptWorkerAdvisory(control({signal_id: 'worker-shape'}), {run: RUN, strategy: 'V7.5', observedAt: '2026-04-01T00:20:00Z'});
  assert.equal(row.strategy, 'V7.5');
  assert.equal(row.strategy_hash, HASH75);
  assert.equal(row.symbol, 'BTC');
  assert.equal(row.signal_time, '2026-04-01T00:00:00Z');
  assert.equal(row.reference_entry, 100);
  assert.equal(row.stop_loss, 98);
  assert.equal(row.take_profit, 104);
  assert.equal(row.email_eligible, true);
});

test('production forward logging is inert before activation and uses persisted cross-strategy episodes', async () => {
  const prepared = createPreparedRun({runId: 'prepared', baseMainSha: 'm', v75StrategySha256: HASH75, v8StrategySha256: HASH8, strategyFreezeManifestSha256: 'f'});
  let calls = 0;
  assert.equal((await recordProductionAdvisory({run: prepared, advisory: control(), strategy: 'V7.5', persist: async () => { calls++; }})).recorded, false);
  const first = await recordProductionAdvisory({run: RUN, advisory: control({signal_id: 'control'}), strategy: 'V7.5', existingSignals: [], persist: async signal => signal});
  const second = await recordProductionAdvisory({run: RUN, advisory: control({signal_id: 'shadow'}), strategy: 'V8', existingSignals: [first.signal], persist: async signal => signal});
  assert.equal(first.signal.independent, true);
  assert.equal(second.signal.independent, false);
  assert.equal(second.signal.independentId, first.signal.independentId);
  assert.equal(calls, 0);
});

test('persistence retries transient RPC failures and keeps stable signal/outcome payloads', async () => {
  let attempts = 0;
  const persistence = createForwardPersistence({rpc: async (name, payload) => {
    attempts++;
    if (attempts === 1) throw new Error('timeout');
    return {name, payload};
  }, attempts: 2, delayMs: 0});
  const signal = adaptV75ProductionAdvisory(control(), {run: RUN});
  const saved = await persistence.recordSignal(signal, RUN);
  assert.equal(saved.name, 'forward_validation_record_signal');
  assert.equal(attempts, 2);
  const outcome = mapProductionOutcome({signal_id: signal.id, opened_at: signal.observedAt, fill_price: 100, entry: 100}, {status: 'closed', exit_time: '2026-04-01T01:00:00Z', exit_price: 104, exit_reason: 'tp', net_r: 1.9});
  assert.equal((await recordProductionOutcome({run: RUN, position: {signal_id: signal.id, opened_at: signal.observedAt, entry: 100}, outcome, persist: async row => row})).recorded, true);
  assert.equal(outcome.exitReason, 'tp');
});

test('worker persistence failures and timeouts are observable without suppressing the accepted path', async () => {
  const failure = await recordForwardAccepted({db: async () => { throw new Error('database unavailable'); }, rpc: async () => ({}), advisory: control(), strategy: 'V7.5', timeoutMs: 50});
  assert.equal(failure.recorded, false);
  assert.match(failure.error, /database unavailable/);
  const timeout = await recordForwardAccepted({db: () => new Promise(() => {}), rpc: async () => ({}), advisory: control(), strategy: 'V7.5', timeoutMs: 5});
  assert.equal(timeout.recorded, false);
  assert.match(timeout.error, /timeout/);
});

test('forward API accepts Fetch Headers and Node/Vercel header objects', () => {
  const token = 'review-token';
  assert.equal(getHeader({headers: {'X-Teleeg-Reviews-Token': token}}, 'x-teleeg-reviews-token'), token);
  assert.equal(authorizeForwardRequest({headers: {'x-teleeg-reviews-token': token}}, token), true);
  assert.equal(authorizeForwardRequest({headers: {'x-teleeg-reviews-token': 'wrong'}}, token), false);
});

test('semantic isolation allows only worker instrumentation and rejects runtime strategy changes', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(auditProductionIsolation(['supabase/functions/teleeg-worker/index.ts', 'supabase/functions/teleeg-worker/forward-validation.mjs']).pass, true);
  assert.equal(auditProductionIsolation(['supabase/functions/teleeg-worker/strategy.mjs']).pass, false);
  assert.equal(auditStrategyFreeze(['supabase/functions/teleeg-worker/strategy.mjs']).pass, false);
  assert.equal(auditProductionSemanticIsolation(root, ['supabase/functions/teleeg-worker/index.ts']).pass, true);
});

test('freeze manifest includes the real production worker runtime', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const freeze = computeStrategyFreeze({root});
  assert.match(freeze.productionWorkerSha256, /^[a-f0-9]{64}$/);
  assert.ok(freeze.productionWorkerFiles.some(file => file.path.endsWith('teleeg-worker/index.ts')));
  assert.ok(freeze.v75Files.some(file => file.path.endsWith('teleeg-worker/strategy.mjs')));
  assert.ok(freeze.v8Files.some(file => file.path.endsWith('teleeg-worker/v8-shadow.mjs')));
});

test('production worker mutation invalidates an active run without changing strategy parameters', () => {
  const run = activateRun(createPreparedRun({...RUN, runId: 'hash-run', productionWorkerSha256: 'frozen', preparedAt: '2026-01-01T00:00:00Z', startedAt: undefined}), {startedAt: '2026-01-02T00:00:00Z'});
  assert.equal(enforceStrategyHashes(run, {v75StrategySha256: HASH75, v8StrategySha256: HASH8, productionWorkerSha256: 'changed'}).invalidationReason, 'STRATEGY_MUTATION');
});

test('forward recording rejects mixed historical signal and observation timestamps', () => {
  assert.throws(() => adaptV75ProductionAdvisory(control({signal_time: '2026-01-01T23:59:00Z'}), {run: RUN, observedAt: '2026-04-01T00:20:00Z'}), /historical backfill/);
  assert.throws(() => adaptV75ProductionAdvisory(control(), {run: RUN, observedAt: '2026-01-01T23:59:00Z'}), /historical backfill/);
});
