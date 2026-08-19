import test from 'node:test';
import assert from 'node:assert/strict';
import {createFunnel, summarizeFunnel} from '../src/funnel.mjs';

test('filter funnel preserves reached/pass/rejection totals by dimension', () => {
  const funnel = createFunnel();
  funnel.record({stage: 'universe', family: 'all', side: 'all', regime: 'unknown', symbol: 'BTCUSDT', tier: 'core'});
  funnel.record({stage: 'universe', family: 'all', side: 'all', regime: 'unknown', symbol: 'ETHUSDT', tier: 'core'});
  funnel.record({stage: 'history_valid', passed: false, rejectionReason: 'market_data_error', family: 'dailyBreakout', side: 'long', regime: 'unknown', symbol: 'ETHUSDT', tier: 'core'});
  const summary = summarizeFunnel(funnel);
  assert.equal(summary.stages.universe.reached, 2);
  assert.equal(summary.stages.universe.passed, 2);
  assert.equal(summary.stages.history_valid.reached, 1);
  assert.equal(summary.stages.history_valid.rejected, 1);
  assert.equal(summary.rejectionReasons.market_data_error, 1);
  const dimension = Object.values(summary.byDimension).find(item => item.symbol === 'ETHUSDT' && item.family === 'dailyBreakout');
  assert.equal(dimension.stages.history_valid.reached, 1);
});
