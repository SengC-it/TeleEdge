import test from 'node:test';
import assert from 'node:assert/strict';
import {completedBars, firstTouch, rankCandidates} from '../supabase/functions/teleeg-worker/strategy.mjs';

test('cloud worker ignores an unfinished confirmation candle', () => {
  const now = 1_000_000;
  const row = t => [t, '1', '2', '0.5', '1.5', '0', t + 59_999, '100'];
  assert.equal(completedBars([row(900_000), row(960_000)], now).length, 1);
});

test('cloud first-touch rule uses SL when TP and SL share one minute', () => {
  const position = {side: 'long', stop: 90, target: 110};
  const touch = firstTouch(position, [{t: 0, o: 100, h: 112, l: 88, c: 101}]);
  assert.deepEqual(touch, {reason: 'sl', price: 90, time: 60_000, ambiguous: true});
});

test('cloud finalizer keeps only three signals per timestamp and side', () => {
  const rows = Array.from({length: 5}, (_, index) => ({
    signal_id: `s${index}`,
    signal_time: '2026-07-16T00:00:00.000Z',
    side: 'short',
    edge_score: index,
    event_score: 0,
    day_volume: 1,
  }));
  assert.deepEqual(rankCandidates(rows).map(row => row.signal_id), ['s4', 's3', 's2']);
});
