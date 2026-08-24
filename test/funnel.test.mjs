import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFunnel, summarizeFunnel} from '../src/funnel.mjs';
import {compactFunnelSummary} from '../supabase/functions/teleeg-worker/funnel.mjs';

const schemaSource = fs.readFileSync(new URL('../supabase/schema/teleeg.sql', import.meta.url), 'utf8');

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

test('full funnel remains diagnostic while public status receives only a compact projection', () => {
  const full = {
    candidates: 524,
    accepted: 2,
    funnel: {
      stages: {history_valid: {reached: 524, passed: 500, rejected: 24}},
      byDimension: Object.fromEntries(Array.from({length: 524}, (_, index) => [`market-${index}`, {stages: {}}])),
      rejectionReasons: {insufficient_history: 20, liquidity_filter: 4},
    },
    v8Shadow: {candidates: 12, accepted: 3, rejected: 9, errors: 0},
  };
  assert.equal(Object.keys(full.funnel.byDimension).length, 524);
  const compact = compactFunnelSummary(full);
  assert.deepEqual(compact.stages.history_valid, {reached: 524, passed: 500, rejected: 24});
  assert.deepEqual(compact.topRejectionReasons[0], {reason: 'insufficient_history', count: 20});
  assert.equal(compact.candidateCount, 524);
  assert.equal(compact.acceptedCount, 2);
  assert.equal(compact.v8Shadow.accepted, 3);
  assert.equal('byDimension' in compact, false);
  assert.equal(JSON.stringify(compact).includes('market-523'), false);
  assert.match(schemaSource, /create or replace function public\.teleeg_compact_scan_summary/);
  assert.match(schemaSource, /public\.teleeg_compact_scan_summary\(coalesce\(v_scan\.summary/);
  assert.doesNotMatch(schemaSource, /last_scan_summary[\s\S]{0,500}\n\s{4}coalesce\(v_scan\.summary, '\{\}'::jsonb\)/);
});
