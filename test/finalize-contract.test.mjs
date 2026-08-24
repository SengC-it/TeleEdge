import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {classifyFinalizeFailure} from '../supabase/functions/teleeg-worker/finalize.mjs';

const workerSource = fs.readFileSync(new URL('../supabase/functions/teleeg-worker/index.ts', import.meta.url), 'utf8');

test('finalize keeps data, database, RPC, and fill rejection reasons distinct', () => {
  assert.equal(classifyFinalizeFailure(new Error('timeout'), 'market-data'), 'market-data-error');
  assert.equal(classifyFinalizeFailure(new Error('fill-price-unavailable'), 'market-data'), 'fill-price-unavailable');
  assert.equal(classifyFinalizeFailure(new Error('Supabase 500'), 'candidate-patch'), 'database-error');
  assert.equal(classifyFinalizeFailure(new Error('Supabase 500'), 'acceptance-rpc'), 'acceptance-rpc-error');
  assert.equal(classifyFinalizeFailure(new Error('invalid-fill-or-stop'), 'strategy'), 'invalid-fill-or-stop');
  assert.equal(classifyFinalizeFailure(new Error('symbol-cooldown'), 'strategy'), 'symbol-cooldown');
  assert.equal(classifyFinalizeFailure(new Error('portfolio-risk-cap'), 'strategy'), 'portfolio-risk-cap');
  assert.equal(classifyFinalizeFailure(new Error('unexpected internal error'), 'strategy'), 'database-error');
  assert.match(workerSource, /classifyFinalizeFailure\(error, 'market-data'\)/);
  assert.match(workerSource, /classifyFinalizeFailure\(error, 'candidate-patch'\)/);
  assert.match(workerSource, /classifyFinalizeFailure\(error, 'acceptance-rpc'\)/);
});
