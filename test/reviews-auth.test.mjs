import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeReviewsRequest} from '../supabase/functions/teleeg-reviews/reviews.mjs';

function requestWithToken(token) {
  const headers = token == null ? undefined : {'x-teleeg-reviews-token': token};
  return new Request('https://teleeg-reviews.test/', {headers});
}

test('reviews function rejects missing and incorrect server tokens', async () => {
  const token = `unit-${crypto.randomUUID()}`;
  assert.equal(await authorizeReviewsRequest(requestWithToken(null), token), false);
  assert.equal(await authorizeReviewsRequest(requestWithToken(`${token}-wrong`), token), false);
});

test('reviews function accepts the exact server token', async () => {
  const token = `unit-${crypto.randomUUID()}`;
  assert.equal(await authorizeReviewsRequest(requestWithToken(token), token), true);
});

test('Vercel reviews proxy forwards the token only in the server request', async () => {
  const token = `unit-${crypto.randomUUID()}`;
  const previousToken = process.env.TELEEDGE_REVIEWS_TOKEN;
  const previousFetch = globalThis.fetch;
  let received;
  process.env.TELEEDGE_REVIEWS_TOKEN = token;
  globalThis.fetch = async (_url, options) => {
    received = options;
    return new Response(JSON.stringify({ok: true, trades: []}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  };
  try {
    const {default: handler} = await import(`../api/reviews.mjs?auth-test=${crypto.randomUUID()}`);
    const response = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      statusCode: 0,
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; return this; },
    };
    await handler({}, response);
    assert.equal(response.statusCode, 200);
    assert.equal(received.headers['x-teleeg-reviews-token'], token);
    assert.equal(received.headers.authorization, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.TELEEDGE_REVIEWS_TOKEN;
    else process.env.TELEEDGE_REVIEWS_TOKEN = previousToken;
  }
});
