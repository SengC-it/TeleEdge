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

test('cloud monitor ignores an incomplete 1m candle', () => {
  const position = {side: 'long', stop: 90, target: 110, fill_time: '1970-01-01T00:01:00.000Z'};
  assert.equal(firstTouch(position, [{t: 120_000, closeTime: 179_999, h: 112, l: 88}], 150_000), null);
});

test('cloud fill time excludes earlier price touches', () => {
  const position = {side: 'long', stop: 90, target: 110, fill_time: '1970-01-01T00:02:30.000Z'};
  const touch = firstTouch(position, [
    {t: 120_000, closeTime: 179_999, h: 112, l: 88},
    {t: 180_000, closeTime: 239_999, h: 112, l: 100},
  ]);
  assert.equal(touch.reason, 'tp');
  assert.equal(touch.time, 240_000);
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

test('cloud exact-tie ranking is deterministic across database return order', () => {
  const rows = ['C', 'A', 'E', 'B', 'D'].map(symbol => ({
    signal_id: symbol,
    signal_time: '2026-07-16T00:00:00.000Z',
    market_id: `${symbol}USDT`,
    side: 'short',
    edge_score: 1,
    event_score: 1,
    day_volume: 1,
  }));
  assert.deepEqual(rankCandidates(rows).map(row => row.signal_id), ['A', 'B', 'C']);
  assert.deepEqual(rankCandidates([...rows].reverse()).map(row => row.signal_id), ['A', 'B', 'C']);
});

test('cloud ranking deduplicates breakout horizons per market', () => {
  const rows = [5, 10, 20].map(lookback => ({
    signal_id: `eth-${lookback}`,
    signal_time: '2026-07-16T00:00:00.000Z',
    market_id: 'ETHUSDT',
    side: 'long',
    edge_score: lookback,
    event_score: 0,
    day_volume: 1,
    features: {breakoutLookback: lookback},
  }));
  const ranked = rankCandidates(rows);
  assert.equal(ranked.length, 1);
  assert.deepEqual(ranked[0].features.matchedBreakouts, [5, 10, 20]);
});
