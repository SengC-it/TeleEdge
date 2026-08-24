import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {authorizeWorkerToken, sha256Token} from '../supabase/functions/teleeg-worker/auth.mjs';

const config = fs.readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('../supabase/functions/teleeg-worker/index.ts', import.meta.url), 'utf8');
const reviewsSource = fs.readFileSync(new URL('../supabase/functions/teleeg-reviews/index.ts', import.meta.url), 'utf8');

test('worker deployment auth contract is independent from Supabase JWT and reviews token', async () => {
  assert.match(config, /\[functions\.teleeg-worker\][\s\S]*?verify_jwt\s*=\s*false/);
  assert.match(config, /\[functions\.teleeg-reviews\][\s\S]*?verify_jwt\s*=\s*false/);
  assert.match(workerSource, /x-teleeg-token/);
  assert.doesNotMatch(workerSource, /req\.headers\.get\(['"]authorization['"]\)/);
  assert.doesNotMatch(workerSource, /TELEEDGE_REVIEWS_TOKEN/);
  assert.match(reviewsSource, /TELEEDGE_REVIEWS_TOKEN/);

  const workerToken = `worker-${crypto.randomUUID()}`;
  const reviewToken = `review-${crypto.randomUUID()}`;
  const workerHash = await sha256Token(workerToken);
  const reviewHash = await sha256Token(reviewToken);

  assert.equal(await authorizeWorkerToken('', workerHash), false, 'missing x-teleeg-token must be unauthorized');
  assert.equal(await authorizeWorkerToken('wrong-token', workerHash), false, 'wrong x-teleeg-token must be unauthorized');
  assert.equal(await authorizeWorkerToken(workerToken, workerHash), true, 'correct worker token must enter the action path');
  assert.equal(await authorizeWorkerToken(workerToken, reviewHash), false, 'reviews token hash must not authorize the worker');
  assert.equal(await authorizeWorkerToken(reviewToken, workerHash), false, 'worker token hash must not authorize reviews traffic');

  const authIndex = workerSource.indexOf('if (!await authorized(req))');
  const actionIndex = workerSource.indexOf('const action = input.action');
  assert.ok(authIndex >= 0 && actionIndex > authIndex, 'worker auth must run before action dispatch');
});
