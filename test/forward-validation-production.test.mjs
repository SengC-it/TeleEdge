import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {authorizeForwardRequest, getHeader} from '../api/forward-validation.mjs';
import {activateRun, createPreparedRun, createPreparedRunFromRuntime, enforceStrategyHashes, recordAdvisoryWithForwardLogging, sha256} from '../src/forward-validation/contract.mjs';
import {adaptV75ProductionAdvisory, adaptV8ProductionAdvisory, mapProductionOutcome} from '../src/forward-validation/production-adapter.mjs';
import {createForwardPersistence, recordProductionAdvisory, recordProductionOutcome} from '../src/forward-validation/persistence.mjs';
import {auditProductionIsolation, auditProductionSemanticIsolation, auditStrategyFreeze, computeStrategyFreeze, PRODUCTION_WORKER_FILES, V75_FROZEN_FILES, V8_FROZEN_FILES, verifyRuntimeFingerprint} from '../src/forward-validation/freeze.mjs';
import {adaptWorkerAdvisory, recordForwardAccepted} from '../supabase/functions/teleeg-worker/forward-validation.mjs';
import {RUNTIME_PRODUCTION_SEMANTIC_SHA256, RUNTIME_V75_STRATEGY_SHA256, RUNTIME_V8_STRATEGY_SHA256} from '../supabase/functions/teleeg-worker/forward-freeze.generated.mjs';

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
  assert.equal(v75.marketId, 'BTCUSDT');
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
  assert.equal(row.strategy_hash, RUNTIME_V75_STRATEGY_SHA256);
  assert.equal(row.production_semantic_hash, RUNTIME_PRODUCTION_SEMANTIC_SHA256);
  assert.equal(row.symbol, 'BTC');
  assert.equal(row.market_id, 'BTCUSDT');
  assert.equal(row.signal_time, '2026-04-01T00:00:00Z');
  assert.equal(row.reference_entry, 100);
  assert.equal(row.stop_loss, 98);
  assert.equal(row.take_profit, 104);
  assert.equal(row.email_eligible, true);
});

function runtimeRun() {
  return activateRun(createPreparedRun({
    runId: 'generated-runtime-run', baseMainSha: 'main',
    v75StrategySha256: RUNTIME_V75_STRATEGY_SHA256,
    v8StrategySha256: RUNTIME_V8_STRATEGY_SHA256,
    productionWorkerSha256: RUNTIME_PRODUCTION_SEMANTIC_SHA256,
    strategyFreezeManifestSha256: sha256('generated-freeze'),
    preparedAt: '2026-01-01T00:00:00Z',
  }), {startedAt: '2026-01-02T00:00:00Z'});
}

function runtimeDb() {
  const run = runtimeRun();
  return async endpoint => endpoint.startsWith('forward_validation_runs') ? [{
    run_id: run.runId, status: run.status, started_at: run.startedAt,
    v75_strategy_sha256: run.v75StrategySha256, v8_strategy_sha256: run.v8StrategySha256,
    production_worker_sha256: run.productionWorkerSha256,
  }] : [];
}

test('unchanged generated production runtime is accepted and sent with runtime hashes', async () => {
  let call;
  const result = await recordForwardAccepted({
    db: runtimeDb(),
    rpc: async (name, payload) => { call = {name, payload}; return {recorded: true}; },
    advisory: control({signal_id: 'runtime-accepted'}), strategy: 'V7.5',
    observedAt: '2026-04-01T00:20:00Z', timeoutMs: 100,
  });
  assert.equal(result.recorded, true);
  assert.equal(call.name, 'forward_validation_record_signal');
  assert.equal(call.payload.p_runtime_strategy_hash, RUNTIME_V75_STRATEGY_SHA256);
  assert.equal(call.payload.p_runtime_production_semantic_sha256, RUNTIME_PRODUCTION_SEMANTIC_SHA256);
  assert.equal(call.payload.p_signal.strategy_hash, RUNTIME_V75_STRATEGY_SHA256);
});

async function mutationResult(strategy, runtimeFingerprint) {
  let call;
  const result = await recordForwardAccepted({
    db: runtimeDb(),
    rpc: async (name, payload) => {
      call = {name, payload};
      return {recorded: false, invalidated: true, reason: 'STRATEGY_MUTATION'};
    },
    advisory: control({signal_id: `mutation-${strategy}`}), strategy, runtimeFingerprint, timeoutMs: 100,
  });
  return {result, call};
}

test('runtime V7.5 hash mismatch invalidates the active run', async () => {
  const {result, call} = await mutationResult('V7.5', {...adaptRuntime(), v75StrategySha256: 'changed-v75'});
  assert.equal(result.recorded, false);
  assert.match(result.error, /STRATEGY_MUTATION/);
  assert.equal(call.payload.p_runtime_strategy_hash, 'changed-v75');
});

test('runtime V8 hash mismatch invalidates the active run', async () => {
  const {result, call} = await mutationResult('V8', {...adaptRuntime(), v8StrategySha256: 'changed-v8'});
  assert.equal(result.recorded, false);
  assert.match(result.error, /STRATEGY_MUTATION/);
  assert.equal(call.payload.p_runtime_strategy_hash, 'changed-v8');
});

test('runtime production semantic hash mismatch invalidates the active run', async () => {
  const {result, call} = await mutationResult('V7.5', {...adaptRuntime(), productionSemanticSha256: 'changed-production'});
  assert.equal(result.recorded, false);
  assert.match(result.error, /STRATEGY_MUTATION/);
  assert.equal(call.payload.p_runtime_production_semantic_sha256, 'changed-production');
});

function adaptRuntime() {
  return {
    v75StrategySha256: RUNTIME_V75_STRATEGY_SHA256,
    v8StrategySha256: RUNTIME_V8_STRATEGY_SHA256,
    productionSemanticSha256: RUNTIME_PRODUCTION_SEMANTIC_SHA256,
  };
}

function freezeFixture(mutator) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleedge-forward-freeze-'));
  const files = [...new Set([...V75_FROZEN_FILES, ...V8_FROZEN_FILES, ...PRODUCTION_WORKER_FILES])];
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', file), target);
  }
  try {
    mutator(root);
    return computeStrategyFreeze({root, baseMainSha: 'main'});
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

test('generated runtime fingerprint changes when a production strategy fixture changes', () => {
  const baseline = computeStrategyFreeze({root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')});
  const modified = freezeFixture(root => fs.appendFileSync(path.join(root, 'supabase/functions/teleeg-worker/strategy.mjs'), '\n// semantic fixture mutation\n'));
  assert.notEqual(modified.productionSemanticSha256, baseline.productionSemanticSha256);
});

test('dashboard and forward instrumentation changes do not change strategy fingerprint', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const baseline = computeStrategyFreeze({root, baseMainSha: 'main'});
  assert.deepEqual(computeStrategyFreeze({root, baseMainSha: 'main'}), baseline);
  const instrumented = freezeFixture(temp => {
    const helper = path.join(temp, 'supabase/functions/teleeg-worker/forward-validation.mjs');
    fs.mkdirSync(path.dirname(helper), {recursive: true});
    fs.copyFileSync(path.join(root, 'supabase/functions/teleeg-worker/forward-validation.mjs'), helper);
    fs.appendFileSync(helper, '\n// forward instrumentation fixture mutation\n');
  });
  assert.equal(instrumented.productionSemanticSha256, baseline.productionSemanticSha256);
});

test('worker risk or settlement semantic changes change the production fingerprint', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const baseline = computeStrategyFreeze({root, baseMainSha: 'main'});
  const modified = freezeFixture(temp => fs.appendFileSync(path.join(temp, 'supabase/functions/teleeg-worker/risk.mjs'), '\n// semantic fixture mutation\n'));
  assert.notEqual(modified.productionSemanticSha256, baseline.productionSemanticSha256);
});

test('stale generated fingerprint fails verification', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = computeStrategyFreeze({root, baseMainSha: 'main'});
  const stale = verifyRuntimeFingerprint({root, manifest, runtimeFingerprint: {
    RUNTIME_V75_STRATEGY_SHA256: '0'.repeat(64),
    RUNTIME_V8_STRATEGY_SHA256: manifest.v8StrategySha256,
    RUNTIME_PRODUCTION_SEMANTIC_SHA256: manifest.productionSemanticSha256,
  }});
  assert.equal(stale.pass, false);
});

test('prepared runs can only bind the generated runtime fingerprint', () => {
  const prepared = createPreparedRunFromRuntime({baseMainSha: 'main', strategyFreezeManifestSha256: 'freeze', preparedAt: '2026-01-01T00:00:00Z'});
  assert.equal(prepared.v75StrategySha256, RUNTIME_V75_STRATEGY_SHA256);
  assert.equal(prepared.v8StrategySha256, RUNTIME_V8_STRATEGY_SHA256);
  assert.equal(prepared.productionWorkerSha256, RUNTIME_PRODUCTION_SEMANTIC_SHA256);
  assert.throws(() => createPreparedRunFromRuntime({runtimeFingerprint: {...adaptRuntime(), v8StrategySha256: 'client-value'}, baseMainSha: 'main', strategyFreezeManifestSha256: 'freeze'}), /generated runtime fingerprint/);
});

function splitSqlExpressions(source) {
  const expressions = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === "'" && source[index + 1] === "'") {
        index++;
      } else if (character === "'") {
        quoted = false;
      }
      continue;
    }
    if (character === "'") {
      quoted = true;
    } else if (character === '(') {
      depth++;
    } else if (character === ')') {
      depth--;
    } else if (character === ',' && depth === 0) {
      expressions.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = source.slice(start).trim();
  if (last) expressions.push(last);
  return expressions;
}

function loadRecordSignalInsert() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20260910100000_teleeg_frozen_forward_validation.sql'), 'utf8');
  const functionStart = sql.indexOf('create or replace function public.forward_validation_record_signal');
  const nextFunction = sql.indexOf('create or replace function public.forward_validation_record_outcome', functionStart);
  const functionBody = sql.slice(functionStart, nextFunction);
  const match = functionBody.match(/insert\s+into\s+public\.forward_validation_signals\s*\(([\s\S]*?)\)\s*values\s*\(([\s\S]*?)\)\s*on\s+conflict\s*\(dedupe_key\)/i);
  assert.ok(match, 'forward_validation_record_signal INSERT must be structurally parseable');
  return {
    functionBody,
    columns: splitSqlExpressions(match[1]),
    values: splitSqlExpressions(match[2]),
  };
}

test('migration SQL smoke keeps record_signal INSERT columns and values aligned', () => {
  const {columns, values} = loadRecordSignalInsert();
  assert.equal(columns.length, values.length);
  assert.deepEqual(columns.slice(0, 6), ['id', 'run_id', 'strategy', 'strategy_hash', 'production_semantic_hash', 'origin']);
  assert.equal(values[3].replace(/\s+/g, ''), "p_signal->>'strategy_hash'");
  assert.equal(values[4].replace(/\s+/g, ''), 'p_runtime_production_semantic_sha256');
  assert.equal(values[5].replace(/\s+/g, ''), "'forward-validation'");
  assert.equal(values.some(value => value.replace(/\s+/g, '') === 'p_runtime_strategy_hash'), false);
});

test('record_signal RPC fixture maps runtime hashes and preserves mutation invalidation', () => {
  const {functionBody, columns, values} = loadRecordSignalInsert();
  const fixture = {
    signal: {strategy_hash: RUNTIME_V75_STRATEGY_SHA256},
    runtimeStrategyHash: RUNTIME_V75_STRATEGY_SHA256,
    runtimeProductionSemanticHash: RUNTIME_PRODUCTION_SEMANTIC_SHA256,
  };
  const mapped = Object.fromEntries(columns.slice(3, 6).map((column, offset) => {
    const expression = values[offset + 3].replace(/\s+/g, '');
    if (expression === "p_signal->>'strategy_hash'") return [column, fixture.signal.strategy_hash];
    if (expression === 'p_runtime_production_semantic_sha256') return [column, fixture.runtimeProductionSemanticHash];
    if (expression === "'forward-validation'") return [column, 'forward-validation'];
    throw new Error('unexpected record_signal fixture expression: ' + expression);
  }));
  assert.deepEqual(mapped, {
    strategy_hash: fixture.runtimeStrategyHash,
    production_semantic_hash: fixture.runtimeProductionSemanticHash,
    origin: 'forward-validation',
  });
  assert.match(functionBody, /\(p_signal->>'strategy_hash'\) is distinct from p_runtime_strategy_hash/);
  assert.match(functionBody, /reason', 'STRATEGY_MUTATION'/);
});

test('forward RPC receives explicit runtime validation parameters', () => {
  const sql = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase/migrations/20260910100000_teleeg_frozen_forward_validation.sql'), 'utf8');
  assert.match(sql, /p_runtime_strategy_hash text/);
  assert.match(sql, /p_runtime_production_semantic_sha256 text/);
  assert.match(sql, /production_semantic_hash text not null/);
  assert.match(sql, /STRATEGY_MUTATION/);
});

test('strategy mutation logging failure does not suppress advisory execution', async () => {
  let paperExecution = 0;
  const result = await recordAdvisoryWithForwardLogging(control(), async () => { throw new Error('STRATEGY_MUTATION'); });
  paperExecution++;
  assert.equal(result.advisorySuppressed, false);
  assert.match(result.forwardLoggingError, /STRATEGY_MUTATION/);
  assert.equal(paperExecution, 1);
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
