import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptCandidates, rankCandidates} from '../src/portfolio.mjs';

const market = symbol => ({
  symbol,
  filters: [
    {filterType: 'PRICE_FILTER', tickSize: '0.01'},
    {filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001'},
  ],
});

const candidate = (id, score, marketId = `${id}USDT`) => ({
  id, t: 1_000_000, marketId, symbol: id, side: 'long', family: 'dailyBreakout', route: 'test',
  entry: 100, sl: 95, target: 110, targetR: 2, stopPct: 0.05,
  edgeScore: score, edgeSegment: 'test', eventScore: score, dayVolume: 100_000_000,
  fundingZ: 0, breadthAbove50: 0.6, breadthMomentum5d: 0.1, btcRouter: 'bull', btcRouterStrength: 0.1,
});

test('ranking keeps only three candidates per timestamp and side', () => {
  const ranked = rankCandidates([
    candidate('A', 1), candidate('B', 4), candidate('C', 3), candidate('D', 2),
  ]);
  assert.deepEqual(ranked.map(item => item.id), ['B', 'C', 'D']);
});

test('same symbol and side at one timestamp uses one ranking slot and preserves breakout horizons', () => {
  const rows = [5, 10, 20].map(lookback => ({
    ...candidate(`ETH-${lookback}`, 1 + lookback / 100, 'ETHUSDT'),
    breakoutLookback: lookback,
  }));
  const ranked = rankCandidates(rows);
  assert.equal(ranked.length, 1);
  assert.deepEqual(ranked[0].matchedBreakouts, [5, 10, 20]);
  assert.deepEqual(ranked[0].features.matchedBreakouts, [5, 10, 20]);
});

test('accepted paper position risks 0.6% of equity and signal is one-shot', () => {
  const state = {
    equityUsdt: 10_000, positions: [], closedPositions: [], processedSignalIds: [], cooldowns: {},
  };
  const item = candidate('A', 1, 'AUSDT');
  const markets = new Map([['AUSDT', market('AUSDT')]]);
  const first = acceptCandidates([item], state, markets);
  assert.equal(first.accepted.length, 1);
  assert.ok(Math.abs(first.accepted[0].riskUsdt - 60) < 0.01);
  const second = acceptCandidates([item], state, markets);
  assert.equal(second.accepted.length, 0);
  assert.equal(second.unseenCount, 0);
});

test('paper position records signal and executable fill clocks separately', () => {
  const state = {equityUsdt: 10_000, positions: [], closedPositions: [], processedSignalIds: [], cooldowns: {}};
  const item = {...candidate('FILL', 1, 'FILLUSDT'), fillPrice: 101};
  const accepted = acceptCandidates([item], state, new Map([['FILLUSDT', market('FILLUSDT')]]), {
    decisionTime: 2_000_000,
    strictFill: true,
  });
  assert.equal(accepted.accepted.length, 1);
  const position = accepted.accepted[0];
  assert.equal(position.signalPrice, 100);
  assert.equal(position.fillPrice, 101);
  assert.equal(position.fillTime, 2_000_000);
  assert.equal(position.lastCheckedAt, position.fillTime);
});
