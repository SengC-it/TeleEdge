import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {authorizeForwardRequest} from '../api/forward-validation.mjs';
import {
  activateRun, assertImmutableSignalUpdate, buildForwardSignal, createPreparedRun,
  enforceStrategyHashes, evaluateForwardStatus, invalidateRun, sha256,
} from '../src/forward-validation/contract.mjs';
import {InMemoryForwardLedger, recordAdvisoryWithForwardLogging} from '../src/forward-validation/ledger.mjs';
import {aggregateForwardMetrics, calculateForwardMetrics, finalForwardGate} from '../src/forward-validation/metrics.mjs';
import {auditProductionIsolation, auditStrategyFreeze, computeStrategyFreeze} from '../src/forward-validation/freeze.mjs';
import {auditNoOrderPaths} from '../src/forward-validation/no-order-audit.mjs';
import {recordAcceptedAdvisory} from '../src/forward-validation/bridge.mjs';

const BASE = {baseMainSha: '21d2b8a1cdfed3e84153dce8491ed8448128727d', v75StrategySha256: sha256('v75'), v8StrategySha256: sha256('v8'), strategyFreezeManifestSha256: sha256('freeze')};

function prepared() {
  return createPreparedRun({...BASE, preparedAt: '2026-01-01T00:00:00.000Z', runId: 'run-test'});
}

function signal(overrides = {}) {
  return {
    id: overrides.id || undefined,
    strategy: 'V7.5', strategyHash: BASE.v75StrategySha256, symbol: 'BTCUSDT', side: 'long',
    signalTime: '2026-04-01T00:00:00.000Z', observedAt: '2026-04-01T00:01:00.000Z',
    signalPrice: 100, referenceEntry: 100, stopLoss: 98, takeProfit: 104, stopPct: 0.02, targetR: 2,
    marketRegime: 'bull', score: 1, confidence: 0.8, emailEligible: true, ...overrides,
  };
}

function activeLedger() {
  const ledger = new InMemoryForwardLedger(prepared());
  ledger.activate('2026-01-02T00:00:00.000Z');
  return ledger;
}

test('strategy hashes and freeze manifest are deterministic', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const first = computeStrategyFreeze({root});
  const second = computeStrategyFreeze({root});
  assert.equal(first.v75StrategySha256, second.v75StrategySha256);
  assert.equal(first.v8StrategySha256, second.v8StrategySha256);
  assert.equal(first.strategyFreezeManifestSha256, second.strategyFreezeManifestSha256);
  assert.equal(first.status, 'PREPARED');
});

test('PREPARED cannot count days and explicit activation starts the clock', () => {
  const run = prepared();
  assert.equal(evaluateForwardStatus(run, {now: '2027-01-01T00:00:00Z'}).verdict, 'INSUFFICIENT_FORWARD_SAMPLE');
  const active = activateRun(run, {startedAt: '2026-01-02T00:00:00Z'});
  assert.equal(active.status, 'ACTIVE');
  assert.equal(active.minimumEndAt, '2026-04-02T00:00:00.000Z');
});

test('historical backfill is rejected and strategy mutation invalidates a run', () => {
  const ledger = activeLedger();
  assert.throws(() => ledger.recordSignal(signal({observedAt: '2026-01-01T23:59:00Z'})), /historical backfill/);
  const invalidated = invalidateRun(ledger.run, 'STRATEGY_MUTATION', {at: '2026-01-03T00:00:00Z'});
  assert.equal(invalidated.status, 'INVALIDATED');
  assert.equal(invalidated.invalidationReason, 'STRATEGY_MUTATION');
  assert.equal(evaluateForwardStatus(invalidated).verdict, 'FORWARD_STOP_CANDIDATE');
  const active = activateRun(prepared(), {startedAt: '2026-01-02T00:00:00Z'});
  assert.equal(enforceStrategyHashes(active, {v75StrategySha256: 'changed', v8StrategySha256: BASE.v8StrategySha256}).invalidationReason, 'STRATEGY_MUTATION');
});

test('signal ledger is retry-idempotent and applies 72h symbol/side refractory', () => {
  const ledger = activeLedger();
  const first = ledger.recordSignal(signal({id: 's1'}));
  const retry = ledger.recordSignal(signal({id: 's1'}));
  const refractory = ledger.recordSignal(signal({id: 's2', signalTime: '2026-04-02T00:00:00Z', observedAt: '2026-04-02T00:01:00Z'}));
  const nextEpisode = ledger.recordSignal(signal({id: 's3', signalTime: '2026-04-05T00:00:01Z', observedAt: '2026-04-05T00:01:00Z'}));
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(refractory.independent, false);
  assert.equal(nextEpisode.independent, true);
  assert.equal(ledger.signals.length, 3);
});

test('V7.5/V8 overlap is grouped without double counting independent opportunities', () => {
  const ledger = activeLedger();
  ledger.recordSignal(signal({id: 'control'}));
  const shadow = ledger.recordSignal(signal({id: 'shadow', strategy: 'V8', strategyHash: BASE.v8StrategySha256}));
  assert.equal(shadow.independent, false);
  assert.equal(ledger.signals[0].overlapGroupId, ledger.signals[1].overlapGroupId);
  assert.equal(new Set(ledger.signals.map(row => row.independentId)).size, 1);
});

test('combined metrics count one closed outcome for an overlapping V7.5/V8 opportunity', () => {
  const ledger = activeLedger();
  ledger.recordSignal(signal({id: 'control'}));
  ledger.recordSignal(signal({id: 'shadow', strategy: 'V8', strategyHash: BASE.v8StrategySha256}));
  ledger.recordOutcome({signalId: 'control', status: 'closed', closedAt: '2026-04-01T01:00:00Z', netPnl: 10, netR: 0.1});
  ledger.recordOutcome({signalId: 'shadow', status: 'closed', closedAt: '2026-04-01T01:00:00Z', netPnl: 10, netR: 0.1});
  const aggregate = aggregateForwardMetrics(ledger.signals, ledger.outcomes);
  assert.equal(aggregate.combined.closedTrades, 1);
  assert.equal(aggregate.combined.netPnlUsdt, 10);
});

test('invalid signal data remains auditable but is excluded from the system sample', () => {
  const ledger = activeLedger();
  const result = ledger.recordSignal(signal({id: 'bad', referenceEntry: null}));
  assert.equal(result.signal.dataQualityStatus, 'INVALID_SIGNAL_DATA');
  assert.equal(result.independent, false);
  assert.equal(ledger.metrics().signals, 0);
  assert.equal(ledger.audit.length, 2);
});

test('open outcome is excluded from PF, expectancy and realized metrics', () => {
  const ledger = activeLedger();
  ledger.recordSignal(signal({id: 'open'}));
  ledger.recordOutcome({signalId: 'open', openedAt: '2026-04-01T00:02:00Z', entryPrice: 100});
  const metrics = ledger.metrics();
  assert.equal(metrics.closedTrades, 0);
  assert.equal(metrics.openTrades, 1);
  assert.equal(metrics.profitFactor, null);
  assert.equal(metrics.expectancyR, null);
  assert.equal(metrics.netPnlUsdt, 0);
});

test('PF, expectancy and peak-relative DD use only closed system-paper outcomes', () => {
  const signals = ['a', 'b', 'c'].map((id, index) => buildForwardSignal(signal({id, signalTime: `2026-04-0${index + 1}T00:00:00Z`, observedAt: `2026-04-0${index + 1}T00:01:00Z`}), {run: activateRun(prepared(), {startedAt: '2026-01-02T00:00:00Z'})}));
  const outcomes = [
    {signalId: 'a', status: 'closed', closedAt: '2026-04-01T01:00:00Z', netPnl: 200, netR: 1},
    {signalId: 'b', status: 'closed', closedAt: '2026-04-02T01:00:00Z', netPnl: -100, netR: -0.5},
    {signalId: 'c', status: 'open', netPnl: 999, netR: 9},
  ];
  const metrics = calculateForwardMetrics(signals, outcomes);
  assert.equal(metrics.profitFactor, 2);
  assert.equal(metrics.expectancyR, 0.25);
  assert.equal(metrics.netPnlUsdt, 100);
  assert.equal(metrics.maxDrawdownUsdt, 100);
});

test('manual decision edits have an audit trail and cannot change system metrics', () => {
  const ledger = activeLedger();
  ledger.recordSignal(signal({id: 'manual'}));
  ledger.recordOutcome({signalId: 'manual', status: 'closed', closedAt: '2026-04-01T01:00:00Z', netPnl: 10, netR: 0.1});
  ledger.recordManualDecision({signalId: 'manual', decision: 'TAKEN', actualPnl: -999});
  ledger.updateManualDecision('manual-manual', {actualPnl: 500}, '2026-04-02T00:00:00Z');
  assert.equal(ledger.metrics().netPnlUsdt, 10);
  assert.equal(ledger.audit.filter(row => row.entityType === 'manual_decision').length, 2);
});

test('forward logging failure never suppresses the advisory', async () => {
  const result = await recordAdvisoryWithForwardLogging({id: 'advisory'}, async () => { throw new Error('ledger unavailable'); });
  assert.equal(result.advisorySuppressed, false);
  assert.match(result.forwardLoggingError, /ledger unavailable/);
});

test('forward bridge is inert before explicit activation and best-effort after activation', async () => {
  const preparedRun = prepared();
  assert.equal((await recordAcceptedAdvisory({run: preparedRun, advisory: signal({id: 'inactive'})})).recorded, false);
  const activeRun = activateRun(preparedRun, {startedAt: '2026-01-02T00:00:00Z'});
  const result = await recordAcceptedAdvisory({run: activeRun, advisory: signal({id: 'bridge'}), persist: async row => row});
  assert.equal(result.recorded, true);
  assert.equal(result.signal.origin, 'forward-validation');
});

test('backtest or research-origin rows cannot enter forward metrics', () => {
  const run = activateRun(prepared(), {startedAt: '2026-01-02T00:00:00Z'});
  const historical = buildForwardSignal(signal({id: 'historical', origin: 'backtest'}), {run});
  assert.equal(calculateForwardMetrics([historical], []).signals, 0);
});

test('minimum gate requires 90d and 50 closed independent signals', () => {
  const run = activateRun(prepared(), {startedAt: '2026-01-02T00:00:00Z'});
  const signals = Array.from({length: 50}, (_, index) => ({...signal({id: `s-${index}`, symbol: `S${index}USDT`, signalTime: `2026-02-${String((index % 27) + 1).padStart(2, '0')}T00:00:00Z`, observedAt: `2026-02-${String((index % 27) + 1).padStart(2, '0')}T00:01:00Z`}), independent: true, independentId: `i-${index}`}));
  const outcomes = signals.map(row => ({signalId: row.id, status: 'closed'}));
  const notReadyDays = evaluateForwardStatus(run, {signals, outcomes, now: '2026-04-01T00:00:00Z'});
  const ready = evaluateForwardStatus(run, {signals, outcomes, now: '2026-04-03T00:00:00Z'});
  assert.equal(notReadyDays.verdict, 'INSUFFICIENT_FORWARD_SAMPLE');
  assert.equal(ready.evaluable, true);
});

test('FORWARD_GO uses exact final gate boundaries and bad integrity blocks it', () => {
  const metrics = {profitFactor: 1.35, expectancyR: 0.15, netPnlUsdt: 1, maxDrawdownPct: 0.06, uniqueSymbols: 10};
  assert.deepEqual(finalForwardGate(metrics, {durationReady: true, signalReady: true}), {status: 'FORWARD_GO', pass: true});
  assert.equal(finalForwardGate(metrics, {durationReady: true, signalReady: true, dataIntegrity: false}).status, 'FORWARD_STOP_CANDIDATE');
});

test('immutable system fields cannot be changed after observation', () => {
  const ledger = activeLedger();
  ledger.recordSignal(signal({id: 'immutable'}));
  assert.throws(() => ledger.updateSignal('immutable', {...ledger.signals[0], stopLoss: 90}), /immutable signal field changed: stopLoss/);
  assert.equal(assertImmutableSignalUpdate(ledger.signals[0], {...ledger.signals[0], emailSent: true}), true);
});

test('freeze and production isolation audits fail only on forbidden changed paths', () => {
  assert.equal(auditStrategyFreeze(['docs/FORWARD_VALIDATION.md']).pass, true);
  assert.equal(auditStrategyFreeze(['src/strategy.mjs']).pass, false);
  assert.equal(auditProductionIsolation(['api/forward-validation.mjs']).pass, true);
  assert.equal(auditProductionIsolation(['api/reviews.mjs']).pass, false);
});

test('repo-level no-order audit scans executable source and reports offending paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleedge-no-order-'));
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  fs.mkdirSync(path.join(root, 'api'), {recursive: true});
  fs.mkdirSync(path.join(root, 'supabase', 'functions'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src', 'safe.mjs'), 'export const safe = true;\n');
  assert.equal(auditNoOrderPaths(root).pass, true);
  fs.writeFileSync(path.join(root, 'src', 'bad.mjs'), 'export const bad = createOrder;\n');
  assert.deepEqual(auditNoOrderPaths(root).offendingPaths, ['src/bad.mjs']);
});

test('forward API uses the independent review token contract without accepting missing or wrong tokens', () => {
  const expected = 'review-secret-for-test';
  assert.equal(authorizeForwardRequest(new Request('https://test', {headers: {}}), expected), false);
  assert.equal(authorizeForwardRequest(new Request('https://test', {headers: {'x-teleeg-reviews-token': 'wrong'}}), expected), false);
  assert.equal(authorizeForwardRequest(new Request('https://test', {headers: {'x-teleeg-reviews-token': expected}}), expected), true);
});
