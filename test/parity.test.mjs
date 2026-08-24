import test from 'node:test';
import assert from 'node:assert/strict';
import {firstTouch as firstLocalTouch} from '../src/service.mjs';
import {firstTouch, rankCandidates as rankCloud} from '../supabase/functions/teleeg-worker/strategy.mjs';
import {rankCandidates as rankLocal} from '../src/portfolio.mjs';

test('local and cloud settlement contracts keep SL priority and fill boundary parity', () => {
  const local = firstLocalTouch(
    {side: 'long', stop: 95, target: 110, fillTime: 150_000},
    [{t: 120_000, closeTime: 179_999, h: 112, l: 90}, {t: 180_000, closeTime: 239_999, h: 112, l: 100}],
    240_000,
  );
  const cloud = firstTouch(
    {side: 'long', stop: 95, target: 110, fill_time: '1970-01-01T00:02:30.000Z'},
    [{t: 120_000, closeTime: 179_999, h: 112, l: 90}, {t: 180_000, closeTime: 239_999, h: 112, l: 100}],
    240_000,
  );
  assert.deepEqual({reason: local.reason, price: local.price, ambiguous: local.ambiguous}, {reason: cloud.reason, price: cloud.price, ambiguous: cloud.ambiguous});
});

test('local and cloud ranking contracts deduplicate breakout horizons', () => {
  const localRows = [5, 10, 20].map(lookback => ({
    id: `local-${lookback}`, t: 1_000_000, marketId: 'ETHUSDT', side: 'long', edgeScore: lookback, eventScore: 0, dayVolume: 1, breakoutLookback: lookback,
  }));
  const cloudRows = localRows.map((row, index) => ({
    signal_id: `cloud-${index}`, signal_time: '1970-01-01T00:16:40.000Z', market_id: row.marketId, side: row.side, edge_score: row.edgeScore, event_score: row.eventScore, day_volume: row.dayVolume, features: {breakoutLookback: row.breakoutLookback},
  }));
  const local = rankLocal(localRows);
  const cloud = rankCloud(cloudRows);
  assert.equal(local.length, 1);
  assert.equal(cloud.length, 1);
  assert.deepEqual(local[0].matchedBreakouts, cloud[0].features.matchedBreakouts);
});
