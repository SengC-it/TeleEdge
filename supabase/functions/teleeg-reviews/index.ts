import {authorizeReviewsRequest, buildReviewsPayload} from './reviews.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ADMIN_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const REVIEWS_TOKEN = Deno.env.get('TELEEDGE_REVIEWS_TOKEN') ?? '';

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

async function db(path: string) {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: ADMIN_KEY,
      authorization: `Bearer ${ADMIN_KEY}`,
    },
    signal: AbortSignal.timeout(8000),
  });
  const text = await result.text();
  if (!result.ok) throw new Error(`Supabase ${result.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return reply({}, 204);
  if (request.method !== 'GET') return reply({ok: false, error: 'method-not-allowed'}, 405);
  if (!await authorizeReviewsRequest(request, REVIEWS_TOKEN)) {
    return reply({ok: false, error: 'unauthorized'}, 401);
  }
  if (!SUPABASE_URL || !ADMIN_KEY) return reply({ok: false, error: 'reviews runtime secrets unavailable'}, 500);
  try {
    // Control and shadow positions are both advisory history. Outbox rows
    // decorate either position with notification delivery state.
    const [positions, shadowPositions, outbox] = await Promise.all([
      db('teleeg_positions?select=*&order=signal_time.desc'),
      db('teleeg_v8_shadow_positions?select=*&order=signal_time.desc'),
      db('teleeg_outbox?select=*&order=created_at.desc'),
    ]);
    return reply(buildReviewsPayload(positions, outbox, shadowPositions));
  } catch (error) {
    console.error(error);
    return reply({ok: false, error: String(error)}, 500);
  }
});
