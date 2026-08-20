import test from 'node:test';
import assert from 'node:assert/strict';
import {generateCandidates} from '../supabase/functions/teleeg-worker/strategy.mjs';
import {createFunnel, summarizeFunnel} from '../supabase/functions/teleeg-worker/funnel.mjs';

const context = {
  btcRouter: 'neutral',
  btcRouterStrength: 0,
  btcDrawdown365: 0,
  btcEma200Slope20: 0,
  btcBearAgeDays: 0,
  breadthAbove50: 0.5,
  breadthMomentum5d: 0,
};

test('cloud strategy records actual per-family rejection instead of post-generation passes', () => {
  const funnel = createFunnel();
  generateCandidates({
    market: {
      marketId: 'TESTUSDT', baseAsset: 'TEST', core: false, onboardDate: 0, tickSize: 0.01,
    },
    daily: [],
    bars4h: [],
    funding: [],
    context,
    telemetry: funnel,
  });
  const summary = summarizeFunnel(funnel);
  assert.equal(summary.stages.history_valid.rejected, 3);
  assert.equal(summary.rejectionReasons.insufficient_history, 3);
  assert.equal(summary.rejectionReasons.no_candidate, undefined);
  assert.equal(summary.stages.liquidity_valid.reached, 0);
  assert.ok(Object.keys(summary.byDimension).every(key => key.includes('TESTUSDT')));
});
