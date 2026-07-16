-- TeleEdge cloud state. All project-owned relations use the teleeg_ prefix.

create table if not exists public.teleeg_account (
  id smallint primary key default 1 check (id = 1),
  model_version text not null default 'V7.5-cap10-risk60-same3',
  mode text not null default 'paper' check (mode = 'paper'),
  starting_equity numeric(24, 8) not null default 10000,
  equity numeric(24, 8) not null default 10000,
  realized_pnl numeric(24, 8) not null default 0,
  risk_fraction numeric(12, 8) not null default 0.006,
  stress_round_trip_cost numeric(12, 8) not null default 0.0015,
  position_cap smallint not null default 10,
  side_cap smallint not null default 8,
  timestamp_side_cap smallint not null default 3,
  cooldown_hours smallint not null default 72,
  cron_token_hash text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.teleeg_context (
  id smallint primary key default 1 check (id = 1),
  as_of timestamptz,
  btc_router text not null default 'neutral',
  btc_router_strength numeric,
  btc_drawdown_365 numeric,
  btc_ema200_slope_20 numeric,
  btc_bear_age_days integer not null default 0,
  breadth_above_50 numeric,
  breadth_momentum_5d numeric,
  core_markets integer not null default 0,
  errors integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.teleeg_markets (
  market_id text primary key,
  base_asset text not null,
  core boolean not null default false,
  onboard_date timestamptz not null,
  tick_size numeric not null,
  step_size numeric not null,
  min_qty numeric not null,
  status text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.teleeg_candidates (
  signal_id text primary key,
  cycle_time timestamptz not null,
  signal_time timestamptz not null,
  expires_at timestamptz not null,
  market_id text not null references public.teleeg_markets(market_id),
  symbol text not null,
  side text not null check (side in ('long', 'short')),
  family text not null,
  route text not null,
  edge_segment text not null,
  entry numeric not null,
  stop numeric not null,
  target numeric not null,
  target_r numeric not null,
  stop_pct numeric not null,
  edge_score numeric not null,
  event_score numeric not null,
  day_volume numeric not null,
  tick_size numeric not null,
  step_size numeric not null,
  min_qty numeric not null,
  features jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  decision_reason text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists teleeg_candidates_cycle_status_idx
  on public.teleeg_candidates (cycle_time, status, side, edge_score desc, event_score desc);
create index if not exists teleeg_candidates_expiry_idx
  on public.teleeg_candidates (expires_at) where status = 'pending';
create index if not exists teleeg_candidates_market_idx
  on public.teleeg_candidates (market_id);

create table if not exists public.teleeg_positions (
  signal_id text primary key references public.teleeg_candidates(signal_id),
  model_version text not null,
  mode text not null default 'paper' check (mode = 'paper'),
  market_id text not null references public.teleeg_markets(market_id),
  symbol text not null,
  side text not null check (side in ('long', 'short')),
  family text not null,
  route text not null,
  edge_segment text not null,
  edge_score numeric not null,
  signal_time timestamptz not null,
  opened_at timestamptz not null default now(),
  entry numeric not null,
  stop numeric not null,
  target numeric not null,
  target_r numeric not null,
  stop_pct numeric not null,
  quantity numeric not null,
  notional_usdt numeric(24, 8) not null,
  risk_usdt numeric(24, 8) not null,
  funding_pnl_usdt numeric(24, 8) not null default 0,
  last_funding_time timestamptz,
  last_checked_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  exit_reason text check (exit_reason is null or exit_reason in ('tp', 'sl')),
  exit_price numeric,
  exit_time timestamptz,
  ambiguous_same_minute boolean,
  gross_pnl_usdt numeric(24, 8),
  modeled_cost_usdt numeric(24, 8),
  net_pnl_usdt numeric(24, 8),
  net_r numeric,
  features jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create unique index if not exists teleeg_positions_one_open_market_idx
  on public.teleeg_positions (market_id) where status = 'open';
create index if not exists teleeg_positions_status_idx
  on public.teleeg_positions (status, opened_at);

create table if not exists public.teleeg_cooldowns (
  market_id text primary key references public.teleeg_markets(market_id),
  last_exit_time timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.teleeg_job_runs (
  id bigint generated always as identity primary key,
  action text not null,
  cycle_time timestamptz not null,
  shard smallint not null default -1,
  status text not null check (status in ('running', 'ok', 'error', 'skipped')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  error text,
  unique (action, cycle_time, shard)
);

create index if not exists teleeg_job_runs_latest_idx
  on public.teleeg_job_runs (started_at desc);

create table if not exists public.teleeg_outbox (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  event_type text not null check (event_type in ('entry', 'exit')),
  position_signal_id text not null references public.teleeg_positions(signal_id),
  subject text not null,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists teleeg_outbox_pending_idx
  on public.teleeg_outbox (status, created_at);
create index if not exists teleeg_outbox_position_idx
  on public.teleeg_outbox (position_signal_id);

create table if not exists public.teleeg_public_status (
  id smallint primary key default 1 check (id = 1),
  project text not null default 'TeleEdge',
  model_version text not null,
  mode text not null,
  service_status text not null default 'starting',
  equity numeric(24, 8) not null,
  realized_pnl numeric(24, 8) not null,
  return_pct numeric not null default 0,
  active_positions integer not null default 0,
  closed_positions integer not null default 0,
  pending_notifications integer not null default 0,
  last_context_at timestamptz,
  last_scan_at timestamptz,
  last_monitor_at timestamptz,
  btc_router text,
  breadth_above_50 numeric,
  last_scan_summary jsonb not null default '{}'::jsonb,
  last_error text,
  updated_at timestamptz not null default now()
);

insert into public.teleeg_account (id) values (1) on conflict (id) do nothing;
insert into public.teleeg_context (id) values (1) on conflict (id) do nothing;
insert into public.teleeg_public_status (
  id, model_version, mode, equity, realized_pnl
) select 1, model_version, mode, equity, realized_pnl
  from public.teleeg_account where id = 1
on conflict (id) do nothing;

create or replace function public.teleeg_refresh_public_status()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_account public.teleeg_account%rowtype;
  v_context public.teleeg_context%rowtype;
  v_scan public.teleeg_job_runs%rowtype;
  v_monitor public.teleeg_job_runs%rowtype;
  v_error public.teleeg_job_runs%rowtype;
begin
  select * into v_account from public.teleeg_account where id = 1;
  select * into v_context from public.teleeg_context where id = 1;
  select * into v_scan from public.teleeg_job_runs
    where action = 'finalize' and status = 'ok' order by completed_at desc nulls last limit 1;
  select * into v_monitor from public.teleeg_job_runs
    where action = 'monitor' and status = 'ok' order by completed_at desc nulls last limit 1;
  select * into v_error from public.teleeg_job_runs
    where status = 'error' order by completed_at desc nulls last limit 1;

  insert into public.teleeg_public_status (
    id, model_version, mode, service_status, equity, realized_pnl, return_pct,
    active_positions, closed_positions, pending_notifications,
    last_context_at, last_scan_at, last_monitor_at, btc_router,
    breadth_above_50, last_scan_summary, last_error, updated_at
  ) values (
    1, v_account.model_version, v_account.mode,
    case
      when v_error.completed_at is not null
        and v_error.completed_at > greatest(
          coalesce(v_scan.completed_at, '-infinity'::timestamptz),
          coalesce(v_monitor.completed_at, '-infinity'::timestamptz)
        ) then 'degraded'
      else 'ready'
    end,
    v_account.equity, v_account.realized_pnl,
    case when v_account.starting_equity = 0 then 0
      else (v_account.equity / v_account.starting_equity - 1) * 100 end,
    (select count(*) from public.teleeg_positions where status = 'open'),
    (select count(*) from public.teleeg_positions where status = 'closed'),
    (select count(*) from public.teleeg_outbox where status in ('pending', 'failed')),
    v_context.as_of, v_scan.completed_at, v_monitor.completed_at,
    v_context.btc_router, v_context.breadth_above_50,
    coalesce(v_scan.summary, '{}'::jsonb),
    case when v_error.completed_at is not null
      and v_error.completed_at > now() - interval '24 hours' then v_error.error else null end,
    now()
  )
  on conflict (id) do update set
    model_version = excluded.model_version,
    mode = excluded.mode,
    service_status = excluded.service_status,
    equity = excluded.equity,
    realized_pnl = excluded.realized_pnl,
    return_pct = excluded.return_pct,
    active_positions = excluded.active_positions,
    closed_positions = excluded.closed_positions,
    pending_notifications = excluded.pending_notifications,
    last_context_at = excluded.last_context_at,
    last_scan_at = excluded.last_scan_at,
    last_monitor_at = excluded.last_monitor_at,
    btc_router = excluded.btc_router,
    breadth_above_50 = excluded.breadth_above_50,
    last_scan_summary = excluded.last_scan_summary,
    last_error = excluded.last_error,
    updated_at = excluded.updated_at;
end;
$$;

create or replace function public.teleeg_accept_candidate(p_signal_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_candidate public.teleeg_candidates%rowtype;
  v_account public.teleeg_account%rowtype;
  v_reason text;
  v_quantity numeric;
  v_risk numeric;
  v_notional numeric;
begin
  perform pg_advisory_xact_lock(hashtext('teleeg-portfolio'));
  select * into v_candidate from public.teleeg_candidates
    where signal_id = p_signal_id for update;
  if not found then return jsonb_build_object('accepted', false, 'reason', 'candidate-not-found'); end if;
  if v_candidate.status <> 'pending' then
    return jsonb_build_object('accepted', v_candidate.status = 'accepted', 'reason', coalesce(v_candidate.decision_reason, v_candidate.status));
  end if;
  select * into v_account from public.teleeg_account where id = 1 for update;

  if v_candidate.expires_at < now() then v_reason := 'signal-expired';
  elsif exists (select 1 from public.teleeg_positions where market_id = v_candidate.market_id and status = 'open') then v_reason := 'symbol-already-open';
  elsif exists (
    select 1 from public.teleeg_cooldowns
    where market_id = v_candidate.market_id
      and last_exit_time + make_interval(hours => v_account.cooldown_hours) > v_candidate.signal_time
  ) then v_reason := 'symbol-cooldown';
  elsif (select count(*) from public.teleeg_positions where status = 'open') >= v_account.position_cap then v_reason := 'portfolio-cap';
  elsif (select count(*) from public.teleeg_positions where status = 'open' and side = v_candidate.side) >= v_account.side_cap then v_reason := 'side-cap';
  elsif (select count(*) from public.teleeg_candidates
         where signal_time = v_candidate.signal_time and side = v_candidate.side and status = 'accepted') >= v_account.timestamp_side_cap
    then v_reason := 'timestamp-side-cap';
  end if;

  if v_reason is null then
    v_quantity := floor(
      (v_account.equity * v_account.risk_fraction / abs(v_candidate.entry - v_candidate.stop))
      / v_candidate.step_size
    ) * v_candidate.step_size;
    if v_quantity <= 0 or v_quantity < v_candidate.min_qty then
      v_reason := 'quantity-below-market-minimum';
    end if;
  end if;

  if v_reason is not null then
    update public.teleeg_candidates set status = 'rejected', decision_reason = v_reason, decided_at = now()
      where signal_id = p_signal_id;
    return jsonb_build_object('accepted', false, 'reason', v_reason);
  end if;

  v_risk := v_quantity * abs(v_candidate.entry - v_candidate.stop);
  v_notional := v_quantity * v_candidate.entry;
  insert into public.teleeg_positions (
    signal_id, model_version, mode, market_id, symbol, side, family, route,
    edge_segment, edge_score, signal_time, entry, stop, target, target_r,
    stop_pct, quantity, notional_usdt, risk_usdt, last_funding_time,
    last_checked_at, features
  ) values (
    v_candidate.signal_id, v_account.model_version, v_account.mode,
    v_candidate.market_id, v_candidate.symbol, v_candidate.side,
    v_candidate.family, v_candidate.route, v_candidate.edge_segment,
    v_candidate.edge_score, v_candidate.signal_time, v_candidate.entry,
    v_candidate.stop, v_candidate.target, v_candidate.target_r,
    v_candidate.stop_pct, v_quantity, v_notional, v_risk,
    v_candidate.signal_time, v_candidate.signal_time, v_candidate.features
  );
  update public.teleeg_candidates set status = 'accepted', decision_reason = 'accepted', decided_at = now()
    where signal_id = p_signal_id;
  insert into public.teleeg_outbox (
    event_key, event_type, position_signal_id, subject, message, payload
  ) values (
    'entry:' || v_candidate.signal_id,
    'entry', v_candidate.signal_id,
    '[TeleEdge入场提醒] ' || v_candidate.market_id || ' '
      || case when v_candidate.side = 'long' then '看涨' else '看跌' end,
    format(E'TeleEdge 模拟交易提醒\n\n交易品种：%s\n方向：%s\n参考入场价：%s\n风险保护价：%s\n目标价格：%s\n参考数量：%s\n本次最多计划亏损：%s USDT\n信号时间：%s\n\n请注意：\n- 这是模拟交易提醒，系统不会自动下单。\n- 价格先到目标价格，按盈利结束。\n- 价格先到风险保护价，按亏损结束。\n- 如果同一分钟内两个价格都碰到，按风险保护价计算。\n- 如果两个价格都没碰到，会继续持有，不会因为时间到了而结束。',
      v_candidate.market_id,
      case when v_candidate.side = 'long' then '看涨（做多）' else '看跌（做空）' end,
      v_candidate.entry, v_candidate.stop, v_candidate.target,
      v_quantity, round(v_risk, 2), v_candidate.signal_time),
    jsonb_build_object('signal_id', v_candidate.signal_id, 'side', v_candidate.side,
      'market_id', v_candidate.market_id, 'entry', v_candidate.entry,
      'stop', v_candidate.stop, 'target', v_candidate.target,
      'quantity', v_quantity, 'risk_usdt', v_risk)
  ) on conflict (event_key) do nothing;
  update public.teleeg_account set updated_at = now() where id = 1;
  return jsonb_build_object('accepted', true, 'reason', 'accepted', 'quantity', v_quantity, 'risk_usdt', v_risk);
end;
$$;

create or replace function public.teleeg_settle_position(
  p_signal_id text,
  p_exit_reason text,
  p_exit_price numeric,
  p_exit_time timestamptz,
  p_ambiguous boolean,
  p_funding_pnl numeric,
  p_last_funding_time timestamptz,
  p_gross_pnl numeric,
  p_modeled_cost numeric,
  p_net_pnl numeric,
  p_net_r numeric
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_position public.teleeg_positions%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('teleeg-portfolio'));
  select * into v_position from public.teleeg_positions
    where signal_id = p_signal_id and status = 'open' for update;
  if not found then return false; end if;

  update public.teleeg_positions set
    status = 'closed', exit_reason = p_exit_reason, exit_price = p_exit_price,
    exit_time = p_exit_time, ambiguous_same_minute = p_ambiguous,
    funding_pnl_usdt = p_funding_pnl, last_funding_time = p_last_funding_time,
    last_checked_at = p_exit_time, gross_pnl_usdt = p_gross_pnl,
    modeled_cost_usdt = p_modeled_cost, net_pnl_usdt = p_net_pnl,
    net_r = p_net_r, updated_at = now()
  where signal_id = p_signal_id;

  insert into public.teleeg_cooldowns (market_id, last_exit_time, updated_at)
    values (v_position.market_id, p_exit_time, now())
  on conflict (market_id) do update set
    last_exit_time = greatest(public.teleeg_cooldowns.last_exit_time, excluded.last_exit_time),
    updated_at = now();

  update public.teleeg_account set
    equity = equity + p_net_pnl,
    realized_pnl = realized_pnl + p_net_pnl,
    updated_at = now()
  where id = 1;

  insert into public.teleeg_outbox (
    event_key, event_type, position_signal_id, subject, message, payload
  ) values (
    'exit:' || p_signal_id,
    'exit', p_signal_id,
    '[TeleEdge交易结果] ' || v_position.market_id || ' '
      || case when p_exit_reason = 'tp' then '达到目标价格' else '触发风险保护' end,
    format(E'TeleEdge 模拟交易结果\n\n交易品种：%s\n方向：%s\n结果：%s\n参考入场价：%s\n结束价格：%s\n价格变化产生的收益：%s USDT\n持仓期间费用：%s USDT\n估算交易手续费：%s USDT\n最终收益：%s USDT\n结束时间：%s\n\n说明：以上是模拟交易结果，不代表真实账户已经产生相同收益或亏损。',
      v_position.market_id,
      case when v_position.side = 'long' then '看涨（做多）' else '看跌（做空）' end,
      case when p_exit_reason = 'tp' then '已达到目标价格，按盈利结束' else '已触发风险保护价格，按亏损结束' end,
      v_position.entry, p_exit_price,
      round(p_gross_pnl, 2), round(p_funding_pnl, 2),
      round(p_modeled_cost, 2), round(p_net_pnl, 2), p_exit_time),
    jsonb_build_object('signal_id', p_signal_id, 'reason', p_exit_reason,
      'market_id', v_position.market_id, 'exit_price', p_exit_price,
      'net_pnl_usdt', p_net_pnl, 'net_r', p_net_r)
  ) on conflict (event_key) do nothing;
  return true;
end;
$$;

create or replace function public.teleeg_format_outbox_chinese()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_position public.teleeg_positions%rowtype;
begin
  select * into v_position
  from public.teleeg_positions
  where signal_id = new.position_signal_id;

  if new.event_type = 'entry' then
    new.subject := '[TeleEdge入场提醒] ' || v_position.market_id || ' '
      || case when v_position.side = 'long' then '看涨' else '看跌' end;
    new.message := format(
      E'TeleEdge 模拟交易提醒\n\n交易品种：%s\n方向：%s\n参考入场价：%s\n风险保护价：%s\n目标价格：%s\n参考数量：%s\n本次最多计划亏损：%s USDT\n信号时间：%s\n\n请注意：\n- 这是模拟交易提醒，系统不会自动下单。\n- 价格先到目标价格，按盈利结束。\n- 价格先到风险保护价，按亏损结束。\n- 如果同一分钟内两个价格都碰到，按风险保护价计算。\n- 如果两个价格都没碰到，会继续持有，不会因为时间到了而结束。',
      v_position.market_id,
      case when v_position.side = 'long' then '看涨（做多）' else '看跌（做空）' end,
      v_position.entry,
      v_position.stop,
      v_position.target,
      v_position.quantity,
      round(v_position.risk_usdt, 2),
      v_position.signal_time
    );
  elsif new.event_type = 'exit' then
    new.subject := '[TeleEdge交易结果] ' || v_position.market_id || ' '
      || case when v_position.exit_reason = 'tp' then '达到目标价格' else '触发风险保护' end;
    new.message := format(
      E'TeleEdge 模拟交易结果\n\n交易品种：%s\n方向：%s\n结果：%s\n参考入场价：%s\n结束价格：%s\n价格变化产生的收益：%s USDT\n持仓期间费用：%s USDT\n估算交易手续费：%s USDT\n最终收益：%s USDT\n结束时间：%s\n\n说明：以上是模拟交易结果，不代表真实账户已经产生相同收益或亏损。',
      v_position.market_id,
      case when v_position.side = 'long' then '看涨（做多）' else '看跌（做空）' end,
      case when v_position.exit_reason = 'tp'
        then '已达到目标价格，按盈利结束'
        else '已触发风险保护价格，按亏损结束'
      end,
      v_position.entry,
      v_position.exit_price,
      round(v_position.gross_pnl_usdt, 2),
      round(v_position.funding_pnl_usdt, 2),
      round(v_position.modeled_cost_usdt, 2),
      round(v_position.net_pnl_usdt, 2),
      v_position.exit_time
    );
  end if;

  return new;
end;
$$;

revoke all on function public.teleeg_format_outbox_chinese() from public, anon, authenticated;

drop trigger if exists teleeg_outbox_format_chinese on public.teleeg_outbox;
create trigger teleeg_outbox_format_chinese
before insert on public.teleeg_outbox
for each row execute function public.teleeg_format_outbox_chinese();

alter table public.teleeg_account enable row level security;
alter table public.teleeg_context enable row level security;
alter table public.teleeg_markets enable row level security;
alter table public.teleeg_candidates enable row level security;
alter table public.teleeg_positions enable row level security;
alter table public.teleeg_cooldowns enable row level security;
alter table public.teleeg_job_runs enable row level security;
alter table public.teleeg_outbox enable row level security;
alter table public.teleeg_public_status enable row level security;

revoke all on table public.teleeg_account from anon, authenticated;
revoke all on table public.teleeg_context from anon, authenticated;
revoke all on table public.teleeg_markets from anon, authenticated;
revoke all on table public.teleeg_candidates from anon, authenticated;
revoke all on table public.teleeg_positions from anon, authenticated;
revoke all on table public.teleeg_cooldowns from anon, authenticated;
revoke all on table public.teleeg_job_runs from anon, authenticated;
revoke all on table public.teleeg_outbox from anon, authenticated;
revoke all on table public.teleeg_public_status from anon, authenticated;
grant select on table public.teleeg_public_status to anon, authenticated;

drop policy if exists teleeg_public_status_read on public.teleeg_public_status;
create policy teleeg_public_status_read on public.teleeg_public_status
  for select to anon, authenticated using (true);

grant all on table public.teleeg_account to service_role;
grant all on table public.teleeg_context to service_role;
grant all on table public.teleeg_markets to service_role;
grant all on table public.teleeg_candidates to service_role;
grant all on table public.teleeg_positions to service_role;
grant all on table public.teleeg_cooldowns to service_role;
grant all on table public.teleeg_job_runs to service_role;
grant all on table public.teleeg_outbox to service_role;
grant all on table public.teleeg_public_status to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke all on function public.teleeg_refresh_public_status() from public, anon, authenticated;
revoke all on function public.teleeg_accept_candidate(text) from public, anon, authenticated;
revoke all on function public.teleeg_settle_position(text, text, numeric, timestamptz, boolean, numeric, timestamptz, numeric, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.teleeg_refresh_public_status() to service_role;
grant execute on function public.teleeg_accept_candidate(text) to service_role;
grant execute on function public.teleeg_settle_position(text, text, numeric, timestamptz, boolean, numeric, timestamptz, numeric, numeric, numeric, numeric) to service_role;

select public.teleeg_refresh_public_status();
