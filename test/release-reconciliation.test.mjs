import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(resolve(
  here,
  '..',
  'supabase',
  'migrations',
  '20260825024545_teleeg_release_reconciliation.sql',
), 'utf8');
const sql = migration.replace(/\s+/g, ' ');

function reconcileV7(startingEquity, closedPnl) {
  const realizedPnl = closedPnl.reduce((sum, pnl) => sum + pnl, 0);
  return { realizedPnl, equity: startingEquity + realizedPnl };
}

function reconcileV8(startingEquity, positions) {
  if (positions.length > 0) {
    throw new Error('V8 position state changed; manual reconciliation required');
  }
  return { realizedPnl: 0, equity: startingEquity, peakEquity: startingEquity };
}

function shouldDeleteCooldown(cooldown, retainedClosedPositions) {
  const start = Date.parse('2026-08-25T02:11:00Z');
  const end = Date.parse('2026-08-25T02:13:00Z');
  const timestamp = Date.parse(cooldown.lastExitTime);
  return ['1000PEPEUSDT', '1000BONKUSDT'].includes(cooldown.marketId)
    && timestamp >= start
    && timestamp <= end
    && !retainedClosedPositions.some((position) => (
      position.marketId === cooldown.marketId
      && position.exitTime === cooldown.lastExitTime
    ));
}

function activeLastError(errorAt, finalizeAt, monitorAt) {
  if (!errorAt) return null;
  const latestSuccess = Math.max(
    finalizeAt ? Date.parse(finalizeAt) : Number.NEGATIVE_INFINITY,
    monitorAt ? Date.parse(monitorAt) : Number.NEGATIVE_INFINITY,
  );
  return Date.parse(errorAt) > latestSuccess ? 'active error' : null;
}

function retryableCount(rows) {
  return rows.filter((row) => (
    row.status === 'pending'
    || (row.status === 'failed' && row.attempts < 5)
  )).length;
}

test('V7 reconciliation uses retained closed PnL and starting equity', () => {
  assert.deepEqual(reconcileV7(10000, [-97.23257555]), {
    realizedPnl: -97.23257555,
    equity: 9902.76742445,
  });
  assert.match(sql, /sum\(p\.net_pnl_usdt\).*where p\.status = 'closed'/);
  assert.match(sql, /equity = starting_equity \+ v_realized/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('teleeg-portfolio'\)\)/);
});

test('V8 zero-position reconciliation resets the starting state', () => {
  assert.deepEqual(reconcileV8(10000, []), {
    realizedPnl: 0,
    equity: 10000,
    peakEquity: 10000,
  });
  assert.match(sql, /realized_pnl = 0, equity = starting_equity, peak_equity = starting_equity/);
});

test('V8 reconciliation fails safe when a position exists', () => {
  assert.throws(() => reconcileV8(10000, [{ signalId: 'retained' }]), {
    message: 'V8 position state changed; manual reconciliation required',
  });
  assert.match(sql, /raise exception 'V8 position state changed; manual reconciliation required'/);
});

test('cooldown cleanup is restricted to the exact smoke guard', () => {
  const smokeCooldown = {
    marketId: '1000PEPEUSDT',
    lastExitTime: '2026-08-25T02:12:00Z',
  };
  assert.equal(shouldDeleteCooldown(smokeCooldown, []), true);
  assert.equal(shouldDeleteCooldown({ ...smokeCooldown, marketId: 'BTCUSDT' }, []), false);
  assert.equal(shouldDeleteCooldown({ ...smokeCooldown, lastExitTime: '2026-08-25T02:10:00Z' }, []), false);
  assert.equal(shouldDeleteCooldown(smokeCooldown, [{
    marketId: smokeCooldown.marketId,
    exitTime: smokeCooldown.lastExitTime,
  }]), false);
  assert.match(sql, /not exists \( select 1 from public\.teleeg_positions as p/);
  assert.match(sql, /2026-08-25 02:11:00\+00/);
  assert.match(sql, /2026-08-25 02:13:00\+00/);
});

test('an old error is cleared after a newer successful finalize or monitor', () => {
  assert.equal(activeLastError(
    '2026-08-25T02:00:00Z',
    '2026-08-25T02:01:00Z',
    '2026-08-25T02:02:00Z',
  ), null);
  assert.match(sql, /v_error\.completed_at > greatest\(/g);
  assert.doesNotMatch(sql, /v_error\.completed_at > now\(\) - interval '24 hours'/);
});

test('a new error after the latest successful job remains visible', () => {
  assert.equal(activeLastError(
    '2026-08-25T02:03:00Z',
    '2026-08-25T02:01:00Z',
    '2026-08-25T02:02:00Z',
  ), 'active error');
});

test('retryable notification count excludes exhausted failures', () => {
  const rows = [
    { status: 'failed', attempts: 5 },
    { status: 'failed', attempts: 4 },
    { status: 'pending', attempts: 5 },
  ];
  assert.equal(retryableCount(rows), 2);
  assert.match(sql, /status = 'pending' or \(status = 'failed' and attempts < 5\)/);
});
