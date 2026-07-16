import test from 'node:test';
import assert from 'node:assert/strict';
import {DAY} from '../src/config.mjs';
import {aggregate} from '../src/indicators.mjs';
import {buildBtcEnvironment, generateLatestCandidates, selectShortTarget} from '../src/strategy.mjs';

test('short selector reproduces frozen segment priority and target', () => {
  const candidate = {
    id: 'X', family: 'volumeShockReversal', entry: 100, sl: 105,
    dayVolume: 100_000_000, volumeRatio: 6, btcRouterStrength: 0.1,
  };
  const selected = selectShortTarget(candidate);
  assert.equal(selected.targetR, 1.5);
  assert.equal(selected.edgeSegment, 'shock-btc-strength-0-to-20');
  assert.equal(selected.target, 92.5);
});

test('short selector uses 2R volume-ratio sleeve when it is the only match', () => {
  const selected = selectShortTarget({
    id: 'Y', family: 'volumeShockReversal', entry: 100, sl: 105,
    dayVolume: 30_000_000, volumeRatio: 5.1, btcRouterStrength: -0.1,
  });
  assert.equal(selected.targetR, 2);
  assert.equal(selected.target, 90);
});

test('latest daily breakout produces confirmed-close 2R long candidate', () => {
  const start = Date.UTC(2025, 0, 1);
  const h1 = [];
  for (let i = 0; i < 260; i++) {
    const base = 100 * 1.003 ** i;
    h1.push({t: start + i * DAY, o: base * 0.995, h: base * 1.01, l: base * 0.99, c: base, q: 30_000_000});
  }
  const last = h1.at(-1);
  last.c *= 1.08;
  last.h = last.c * 1.005;
  last.o = last.c * 0.98;
  const endTime = last.t + DAY;
  const daily = aggregate(h1, DAY, endTime);
  const btcEnvironment = buildBtcEnvironment(daily);
  const breadthByTime = new Map([
    [endTime, 0.7],
    [endTime - 5 * DAY, 0.6],
  ]);
  const funding = Array.from({length: 30}, (_, i) => ({t: endTime - (30 - i) * 8 * 3_600_000, rate: 0.0001}));
  const market = {
    symbol: 'ETHUSDT', baseAsset: 'ETH', onboardDate: start,
    filters: [
      {filterType: 'PRICE_FILTER', tickSize: '0.01'},
      {filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001'},
    ],
  };
  const candidates = generateLatestCandidates({market, h1, funding, breadthByTime, btcEnvironment, endTime});
  assert.ok(candidates.length >= 1);
  assert.ok(candidates.every(candidate => candidate.side === 'long' && candidate.targetR === 2));
  assert.equal(candidates[0].entry, last.c);
  assert.equal(candidates[0].t, endTime);
});
