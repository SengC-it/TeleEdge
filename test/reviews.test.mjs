import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewsPayload} from '../src/reviews.mjs';

test('position history remains complete when one notification failed', () => {
  const positions = [
    {signal_id: 'robo', status: 'closed', market_id: 'ROBOUSDT', exit_reason: 'sl', signal_time: '2026-07-16T00:00:00Z'},
    {signal_id: 'q', status: 'closed', market_id: 'QUSDT', exit_reason: 'tp', signal_time: '2026-07-17T00:00:00Z'},
  ];
  const before = structuredClone(positions);
  const payload = buildReviewsPayload(positions, [
    {position_signal_id: 'robo', event_type: 'entry', status: 'sent', attempts: 1},
    {position_signal_id: 'q', event_type: 'entry', status: 'failed', attempts: 5, last_error: '401'},
  ]);
  assert.equal(payload.source, 'teleeg_positions');
  assert.equal(payload.closedSignals, 2);
  assert.equal(payload.wins, 1);
  assert.equal(payload.losses, 1);
  assert.equal(payload.trades.length, 2);
  assert.equal(payload.trades.find(item => item.market_id === 'QUSDT').notificationStatus.entry.status, 'failed');
  assert.deepEqual(positions, before, 'notification delivery state must not mutate position state');
});
