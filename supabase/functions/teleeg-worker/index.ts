import {
  CORE_MARKETS,
  DAY,
  H4,
  buildMarketContext,
  completedBars,
  firstTouch,
  generateCandidates,
  klineToBar,
  rankCandidates,
} from './strategy.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ADMIN_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BINANCE_URL = 'https://fapi.binance.com';
const SIGNAL_MAX_AGE = 30 * 60_000;
const TOTAL_SHARDS = 12;
const MODEL_COST = 0.0015;
const MAIL_ENDPOINT = 'https://teleedge.vercel.app/api/send-mail';

type Json = Record<string, unknown> | unknown[];

function response(body: Json, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  });
}

function dbHeaders(prefer?: string) {
  const headers: Record<string, string> = {
    apikey: ADMIN_KEY,
    'content-type': 'application/json',
  };
  if (ADMIN_KEY.startsWith('eyJ')) headers.authorization = `Bearer ${ADMIN_KEY}`;
  if (prefer) headers.prefer = prefer;
  return headers;
}

async function db(path: string, options: {method?: string; body?: unknown; prefer?: string} = {}) {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method ?? 'GET',
    headers: dbHeaders(options.prefer),
    body: options.body == null ? undefined : JSON.stringify(options.body),
  });
  const text = await result.text();
  if (!result.ok) throw new Error(`Supabase ${result.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function rpc(name: string, body: Record<string, unknown> = {}) {
  return db(`rpc/${name}`, {method: 'POST', body});
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function authorized(req: Request) {
  const supplied = req.headers.get('x-teleeg-token') ?? '';
  if (!supplied) return false;
  const rows = await db('teleeg_account?select=cron_token_hash&id=eq.1');
  const expected = rows?.[0]?.cron_token_hash;
  return typeof expected === 'string' && expected.length === 64 && await sha256(supplied) === expected;
}

async function binance(path: string, parameters: Record<string, string | number> = {}, attempts = 3) {
  const url = new URL(path, BINANCE_URL);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await fetch(url, {
        headers: {'user-agent': 'teleedge-cloud/1.0'},
        signal: AbortSignal.timeout(20_000),
      });
      if (!result.ok) throw new Error(`Binance ${result.status}: ${(await result.text()).slice(0, 200)}`);
      return await result.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function mapLimit<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) {
  const output = new Array<R>(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, run));
  return output;
}

function cycleAt(now: number) {
  return Math.floor(now / H4) * H4;
}

function minuteAt(now: number) {
  return Math.floor(now / 60_000) * 60_000;
}

function iso(value: number) {
  return new Date(value).toISOString();
}

function marketFromExchangeInfo(item: any) {
  const price = item.filters?.find((filter: any) => filter.filterType === 'PRICE_FILTER');
  const lot = item.filters?.find((filter: any) => filter.filterType === 'LOT_SIZE');
  return {
    marketId: item.symbol,
    baseAsset: item.baseAsset,
    core: CORE_MARKETS.has(item.symbol),
    onboardDate: +item.onboardDate,
    tickSize: +(price?.tickSize || 0),
    stepSize: +(lot?.stepSize || 0),
    minQty: +(lot?.minQty || 0),
    status: item.status,
  };
}

function eligibleMarkets(exchangeInfo: any, cycle: number) {
  return (exchangeInfo.symbols ?? [])
    .filter((item: any) => item.quoteAsset === 'USDT' && item.contractType === 'PERPETUAL'
      && item.status === 'TRADING' && +item.onboardDate <= cycle - 34 * DAY)
    .map(marketFromExchangeInfo)
    .sort((a: any, b: any) => a.marketId.localeCompare(b.marketId));
}

async function startJob(action: string, cycle: number, shard = -1) {
  const key = `action=eq.${encodeURIComponent(action)}&cycle_time=eq.${encodeURIComponent(iso(cycle))}&shard=eq.${shard}`;
  const existing = await db(`teleeg_job_runs?select=id,status&${key}`);
  if (existing?.[0]?.status === 'ok') return {id: existing[0].id, skip: true};
  const rows = await db('teleeg_job_runs?on_conflict=action,cycle_time,shard', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: {
      action,
      cycle_time: iso(cycle),
      shard,
      status: 'running',
      started_at: new Date().toISOString(),
      completed_at: null,
      summary: {},
      error: null,
    },
  });
  return {id: rows[0].id, skip: false};
}

async function finishJob(id: number, status: 'ok' | 'error' | 'skipped', summary: Record<string, unknown>, error?: unknown) {
  await db(`teleeg_job_runs?id=eq.${id}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: {
      status,
      completed_at: new Date().toISOString(),
      summary,
      error: error == null ? null : String(error).slice(0, 2000),
    },
  });
  await rpc('teleeg_refresh_public_status');
}

async function getCompletedKlines(symbol: string, interval: string, limit: number, now: number) {
  const rows = await binance('/fapi/v1/klines', {symbol, interval, limit});
  return completedBars(rows, now);
}

async function getFunding(symbol: string, now: number, limit = 50) {
  const rows = await binance('/fapi/v1/fundingRate', {symbol, endTime: now, limit});
  return rows.map((row: any) => ({t: +row.fundingTime, rate: +row.fundingRate, markPrice: +row.markPrice || null}));
}

async function runContext(now: number, cycle: number) {
  const job = await startJob('context', cycle);
  if (job.skip) return {skipped: true, cycle: iso(cycle)};
  try {
    const exchangeInfo = await binance('/fapi/v1/exchangeInfo');
    const markets = eligibleMarkets(exchangeInfo, cycle);
    const marketRows = markets.map((market: any) => ({
      market_id: market.marketId,
      base_asset: market.baseAsset,
      core: market.core,
      onboard_date: iso(market.onboardDate),
      tick_size: market.tickSize,
      step_size: market.stepSize,
      min_qty: market.minQty,
      status: market.status,
      updated_at: new Date().toISOString(),
    }));
    if (marketRows.length) {
      await db('teleeg_markets?on_conflict=market_id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: marketRows,
      });
    }

    const core = markets.filter((market: any) => market.core);
    const results = await mapLimit(core, 5, async (market: any) => {
      try {
        return {market, bars: await getCompletedKlines(market.marketId, '1d', 400, now)};
      } catch (error) {
        return {market, error: String(error)};
      }
    });
    const btc = results.find((item: any) => item.market.marketId === 'BTCUSDT' && item.bars)?.bars;
    if (!btc) throw new Error('BTCUSDT context data unavailable');
    const successful = results.filter((item: any) => item.bars?.length >= 56);
    const context = buildMarketContext(btc, successful.map((item: any) => item.bars));
    const errors = results.filter((item: any) => item.error);
    await db('teleeg_context?id=eq.1', {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        as_of: iso(cycle),
        btc_router: context.btcRouter,
        btc_router_strength: context.btcRouterStrength,
        btc_drawdown_365: context.btcDrawdown365,
        btc_ema200_slope_20: context.btcEma200Slope20,
        btc_bear_age_days: context.btcBearAgeDays,
        breadth_above_50: context.breadthAbove50,
        breadth_momentum_5d: context.breadthMomentum5d,
        core_markets: context.coreMarkets,
        errors: errors.length,
        updated_at: new Date().toISOString(),
      },
    });
    const summary = {cycle: iso(cycle), universe: markets.length, coreMarkets: context.coreMarkets, errors: errors.length, btcRouter: context.btcRouter, breadthAbove50: context.breadthAbove50};
    await finishJob(job.id, 'ok', summary);
    return summary;
  } catch (error) {
    await finishJob(job.id, 'error', {cycle: iso(cycle)}, error);
    throw error;
  }
}

async function runScan(now: number, cycle: number, shard: number) {
  if (!Number.isInteger(shard) || shard < 0 || shard >= TOTAL_SHARDS) throw new Error(`shard must be 0-${TOTAL_SHARDS - 1}`);
  const job = await startJob('scan', cycle, shard);
  if (job.skip) return {skipped: true, cycle: iso(cycle), shard};
  try {
    const [contextRows, exchangeInfo] = await Promise.all([
      db('teleeg_context?select=*&id=eq.1'),
      binance('/fapi/v1/exchangeInfo'),
    ]);
    const stored = contextRows[0];
    if (!stored?.as_of || Date.parse(stored.as_of) < cycle) throw new Error('TeleEdge market context is stale');
    const context = {
      btcRouter: stored.btc_router,
      btcRouterStrength: +stored.btc_router_strength,
      btcDrawdown365: +stored.btc_drawdown_365,
      btcEma200Slope20: +stored.btc_ema200_slope_20,
      btcBearAgeDays: +stored.btc_bear_age_days,
      breadthAbove50: +stored.breadth_above_50,
      breadthMomentum5d: +stored.breadth_momentum_5d,
    };
    const markets = eligibleMarkets(exchangeInfo, cycle).filter((_: unknown, index: number) => index % TOTAL_SHARDS === shard);
    const results = await mapLimit(markets, 5, async (market: any) => {
      try {
        const [daily, bars4h, funding] = await Promise.all([
          getCompletedKlines(market.marketId, '1d', 400, now),
          market.core ? Promise.resolve([]) : getCompletedKlines(market.marketId, '4h', 230, now),
          getFunding(market.marketId, now),
        ]);
        return {market, candidates: generateCandidates({market, daily, bars4h, funding, context})};
      } catch (error) {
        return {market, error: String(error)};
      }
    });
    const candidates = results.flatMap((item: any) => item.candidates ?? [])
      .filter((candidate: any) => candidate.signalTime <= now && candidate.signalTime >= now - SIGNAL_MAX_AGE);
    const rows = candidates.map((candidate: any) => ({
      signal_id: candidate.signalId,
      cycle_time: iso(cycle),
      signal_time: iso(candidate.signalTime),
      expires_at: iso(candidate.signalTime + SIGNAL_MAX_AGE),
      market_id: candidate.marketId,
      symbol: candidate.symbol,
      side: candidate.side,
      family: candidate.family,
      route: candidate.route,
      edge_segment: candidate.edgeSegment,
      entry: candidate.entry,
      stop: candidate.stop,
      target: candidate.target,
      target_r: candidate.targetR,
      stop_pct: candidate.stopPct,
      edge_score: candidate.edgeScore,
      event_score: candidate.eventScore,
      day_volume: candidate.dayVolume,
      tick_size: candidate.marketId ? markets.find((market: any) => market.marketId === candidate.marketId)?.tickSize : 0,
      step_size: candidate.marketId ? markets.find((market: any) => market.marketId === candidate.marketId)?.stepSize : 0,
      min_qty: candidate.marketId ? markets.find((market: any) => market.marketId === candidate.marketId)?.minQty : 0,
      features: candidate.features,
    }));
    if (rows.length) {
      await db('teleeg_candidates?on_conflict=signal_id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: rows,
      });
    }
    const errors = results.filter((item: any) => item.error);
    const summary = {cycle: iso(cycle), shard, markets: markets.length, evaluated: results.length - errors.length, errors: errors.length, candidates: rows.length, firstError: errors[0]?.error ?? null};
    await finishJob(job.id, errors.length === markets.length && markets.length ? 'error' : 'ok', summary, errors.length === markets.length ? errors[0]?.error : undefined);
    return summary;
  } catch (error) {
    await finishJob(job.id, 'error', {cycle: iso(cycle), shard}, error);
    throw error;
  }
}

async function runFinalize(now: number, cycle: number) {
  const job = await startJob('finalize', cycle);
  if (job.skip) return {skipped: true, cycle: iso(cycle)};
  try {
    const rows = await db(`teleeg_candidates?select=*&cycle_time=eq.${encodeURIComponent(iso(cycle))}&status=eq.pending&expires_at=gte.${encodeURIComponent(iso(now))}`);
    const ranked = rankCandidates(rows, 3);
    const rankedIds = new Set(ranked.map((candidate: any) => candidate.signal_id));
    const unranked = rows.filter((candidate: any) => !rankedIds.has(candidate.signal_id));
    for (const candidate of unranked) {
      await db(`teleeg_candidates?signal_id=eq.${encodeURIComponent(candidate.signal_id)}&status=eq.pending`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {status: 'rejected', decision_reason: 'not-top-ranked', decided_at: new Date().toISOString()},
      });
    }
    let accepted = 0;
    const reasons: Record<string, number> = {};
    for (const candidate of ranked) {
      const result = await rpc('teleeg_accept_candidate', {p_signal_id: candidate.signal_id});
      const decision = result ?? {accepted: false, reason: 'unknown'};
      if (decision.accepted) accepted++;
      else reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
    }
    const active = await db('teleeg_positions?select=signal_id&status=eq.open');
    const summary = {cycle: iso(cycle), candidates: rows.length, ranked: ranked.length, accepted, rejected: rows.length - accepted, activePositions: active.length, rejectionReasons: reasons};
    await finishJob(job.id, 'ok', summary);
    return summary;
  } catch (error) {
    await finishJob(job.id, 'error', {cycle: iso(cycle)}, error);
    throw error;
  }
}

async function minuteBars(symbol: string, startTime: number, endTime: number) {
  const output: any[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const rows = await binance('/fapi/v1/klines', {symbol, interval: '1m', startTime: cursor, endTime: endTime - 1, limit: 1500});
    if (!rows.length) break;
    output.push(...rows.map(klineToBar));
    const next = +rows.at(-1)[0] + 60_000;
    if (next <= cursor) break;
    cursor = next;
    if (rows.length < 1500) break;
  }
  return output;
}

async function fundingSince(position: any, endTime: number) {
  const start = Date.parse(position.last_funding_time ?? position.signal_time) + 1;
  const rows = await binance('/fapi/v1/fundingRate', {symbol: position.market_id, startTime: start, endTime, limit: 1000});
  return rows.map((row: any) => ({t: +row.fundingTime, rate: +row.fundingRate, markPrice: +row.markPrice || +position.entry}));
}

async function monitorPosition(position: any, now: number) {
  const [bars, funding] = await Promise.all([
    minuteBars(position.market_id, Date.parse(position.last_checked_at), now),
    fundingSince(position, now),
  ]);
  const touch = firstTouch(position, bars);
  let fundingPnl = +position.funding_pnl_usdt;
  let lastFundingTime = position.last_funding_time;
  for (const event of funding.filter((event: any) => event.t < (touch?.time ?? now + 1))) {
    const cashflow = event.markPrice * +position.quantity * event.rate;
    fundingPnl += position.side === 'long' ? -cashflow : cashflow;
    lastFundingTime = iso(event.t);
  }
  if (!touch) {
    await db(`teleeg_positions?signal_id=eq.${encodeURIComponent(position.signal_id)}&status=eq.open`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        funding_pnl_usdt: fundingPnl,
        last_funding_time: lastFundingTime,
        last_checked_at: iso(minuteAt(now)),
        updated_at: new Date().toISOString(),
      },
    });
    return {closed: false};
  }
  const direction = position.side === 'long' ? 1 : -1;
  const gross = direction * (touch.price - +position.entry) * +position.quantity;
  const cost = MODEL_COST * +position.entry * +position.quantity;
  const net = gross + fundingPnl - cost;
  const settled = await rpc('teleeg_settle_position', {
    p_signal_id: position.signal_id,
    p_exit_reason: touch.reason,
    p_exit_price: touch.price,
    p_exit_time: iso(touch.time),
    p_ambiguous: touch.ambiguous,
    p_funding_pnl: fundingPnl,
    p_last_funding_time: lastFundingTime,
    p_gross_pnl: gross,
    p_modeled_cost: cost,
    p_net_pnl: net,
    p_net_r: net / +position.risk_usdt,
  });
  return {closed: Boolean(settled), reason: touch.reason};
}

async function runMonitor(now: number) {
  const cycle = minuteAt(now);
  const job = await startJob('monitor', cycle);
  if (job.skip) return {skipped: true, cycle: iso(cycle)};
  try {
    const positions = await db('teleeg_positions?select=*&status=eq.open&order=opened_at.asc');
    const results = await mapLimit(positions, 3, async (position: any) => {
      try {
        return await monitorPosition(position, now);
      } catch (error) {
        return {closed: false, error: String(error)};
      }
    });
    const errors = results.filter((item: any) => item.error);
    const summary = {checked: positions.length, closed: results.filter((item: any) => item.closed).length, errors: errors.length, firstError: errors[0]?.error ?? null};
    await finishJob(job.id, errors.length ? 'error' : 'ok', summary, errors[0]?.error);
    return summary;
  } catch (error) {
    await finishJob(job.id, 'error', {}, error);
    throw error;
  }
}

async function sendGmail(item: any, workerToken: string) {
  const result = await fetch(MAIL_ENDPOINT, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-teleeg-token': workerToken},
    body: JSON.stringify({subject: item.subject, message: item.message}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!result.ok) throw new Error(`TeleEdge SMTP gateway ${result.status}: ${(await result.text()).slice(0, 500)}`);
}

async function runMail(now: number, workerToken: string) {
  const cycle = minuteAt(now);
  const job = await startJob('mail', cycle);
  if (job.skip) return {skipped: true, cycle: iso(cycle)};
  try {
    const items = await db('teleeg_outbox?select=*&status=in.(pending,failed)&attempts=lt.5&order=created_at.asc&limit=10');
    if (!items.length) {
      const summary = {queued: 0, sent: 0, failed: 0};
      await finishJob(job.id, 'ok', summary);
      return summary;
    }
    let sent = 0;
    let failed = 0;
    for (const item of items) {
      try {
        await sendGmail(item, workerToken);
        await db(`teleeg_outbox?id=eq.${item.id}`, {method: 'PATCH', prefer: 'return=minimal', body: {status: 'sent', attempts: item.attempts + 1, last_error: null, sent_at: new Date().toISOString()}});
        sent++;
      } catch (error) {
        await db(`teleeg_outbox?id=eq.${item.id}`, {method: 'PATCH', prefer: 'return=minimal', body: {status: 'failed', attempts: item.attempts + 1, last_error: String(error).slice(0, 1000)}});
        failed++;
      }
    }
    const summary = {queued: items.length, sent, failed};
    await finishJob(job.id, failed ? 'error' : 'ok', summary, failed ? 'One or more Gmail deliveries failed' : undefined);
    return summary;
  } catch (error) {
    await finishJob(job.id, 'error', {}, error);
    throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return response({error: 'method-not-allowed'}, 405);
  if (!SUPABASE_URL || !ADMIN_KEY) return response({error: 'Supabase runtime secrets are unavailable'}, 500);
  try {
    const workerToken = req.headers.get('x-teleeg-token') ?? '';
    if (!await authorized(req)) return response({error: 'unauthorized'}, 401);
    const input = await req.json().catch(() => ({}));
    const action = input.action;
    const now = Date.now();
    const cycle = input.cycle ? Date.parse(input.cycle) : cycleAt(now);
    if (!Number.isFinite(cycle)) return response({error: 'invalid-cycle'}, 400);
    let result;
    if (action === 'context') result = await runContext(now, cycle);
    else if (action === 'scan') result = await runScan(now, cycle, Number(input.shard));
    else if (action === 'finalize') result = await runFinalize(now, cycle);
    else if (action === 'monitor') result = {
      monitor: await runMonitor(now),
      mail: await runMail(now, workerToken),
    };
    else if (action === 'mail') result = await runMail(now, workerToken);
    else return response({error: 'unknown-action'}, 400);
    return response({ok: true, action, result});
  } catch (error) {
    console.error(error);
    return response({ok: false, error: String(error)}, 500);
  }
});
