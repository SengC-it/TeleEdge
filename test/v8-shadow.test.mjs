import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptV8ShadowCandidates, createV8ShadowState} from '../src/v8-shadow.mjs';

const candidate = (id, marketId, alpha = 'bear') => ({
  id: `V8|${alpha}|${id}`,
  modelVersion: 'V8-shadow-research-20260819',
  alpha,
  marketId,
  symbol: marketId.replace('USDT', ''),
  side: alpha === 'bull' ? 'long' : 'short',
  family: `v8${alpha}`,
  route: `v8_${alpha}`,
  edgeSegment: 'research',
  t: 1_000_000,
  signalPrice: 100,
  entry: 100,
  sl: alpha === 'bull' ? 95 : 105,
  target: alpha === 'bull' ? 110 : 90,
  targetR: 2,
  edgeScore: 1,
  eventScore: 1,
  dayVolume: 100_000_000,
  features: {},
});

test('V7.5 state and V8 shadow state remain isolated', () => {
  const v75 = {positions: [], processedSignalIds: []};
  const shadow = createV8ShadowState(2_000_000, 10_000);
  const result = acceptV8ShadowCandidates([
    candidate('BTC', 'BTCUSDT'),
    candidate('ETH', 'ETHUSDT'),
  ], shadow, new Map(), {decisionTime: 2_000_000, fillPrices: new Map([['BTCUSDT', 101], ['ETHUSDT', 99]])});
  assert.equal(result.accepted.length, 2);
  assert.equal(shadow.positions.length, 2);
  assert.equal(v75.positions.length, 0);
  assert.equal(v75.processedSignalIds.length, 0);
  assert.ok(shadow.positions.every(position => position.mode === 'paper-shadow'));
  assert.ok(shadow.positions.every(position => position.modelVersion.startsWith('V8-')));
});
