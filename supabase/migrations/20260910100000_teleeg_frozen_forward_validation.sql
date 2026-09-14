-- Additive, prepared-only infrastructure for the 90-day Frozen Forward Validation.
-- This migration is intentionally not applied by Phase 1.

create table if not exists public.forward_validation_runs (
  run_id text primary key,
  status text not null check (status in ('PREPARED', 'ACTIVE', 'COMPLETED', 'INVALIDATED')),
  prepared_at timestamptz not null,
  started_at timestamptz,
  ended_at timestamptz,
  minimum_end_at timestamptz,
  minimum_duration_days integer not null default 90 check (minimum_duration_days = 90),
  minimum_signals integer not null default 50 check (minimum_signals = 50),
  base_main_sha text not null,
  v75_strategy_sha256 text not null,
  v8_strategy_sha256 text not null,
  production_worker_sha256 text,
  strategy_freeze_manifest_sha256 text not null,
  deployment_reference text,
  notes text,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.forward_validation_signals (
  id text primary key,
  run_id text not null references public.forward_validation_runs(run_id),
  strategy text not null check (strategy in ('V7.5', 'V8')),
  strategy_hash text not null,
  origin text not null default 'forward-validation' check (origin = 'forward-validation'),
  symbol text not null,
  side text not null check (side in ('long', 'short')),
  signal_time timestamptz not null,
  observed_at timestamptz not null,
  signal_price numeric,
  reference_entry numeric not null,
  stop_loss numeric not null,
  take_profit numeric not null,
  stop_pct numeric,
  target_r numeric,
  market_regime text,
  score numeric,
  confidence numeric,
  funding jsonb,
  context jsonb,
  email_eligible boolean not null default false,
  email_sent boolean not null default false,
  email_sent_at timestamptz,
  overlap_group_id text,
  dedupe_key text not null unique,
  independent_id text,
  independent boolean not null default false,
  duplicate_of text references public.forward_validation_signals(id),
  data_quality_status text not null default 'VALID' check (data_quality_status in ('VALID', 'INVALID_SIGNAL_DATA')),
  created_at timestamptz not null default now()
);

create index if not exists forward_validation_signals_run_time_idx on public.forward_validation_signals(run_id, signal_time);
create index if not exists forward_validation_signals_independent_idx on public.forward_validation_signals(run_id, independent_id) where independent = true;

create table if not exists public.forward_validation_outcomes (
  signal_id text primary key references public.forward_validation_signals(id),
  run_id text not null references public.forward_validation_runs(run_id),
  position_id text,
  opened_at timestamptz not null,
  entry_price numeric not null,
  closed_at timestamptz,
  exit_price numeric,
  exit_reason text,
  gross_pnl numeric,
  fees_cost numeric,
  funding numeric,
  net_pnl numeric,
  gross_r numeric,
  net_r numeric,
  mfe numeric,
  mae numeric,
  duration interval,
  status text not null default 'open' check (status in ('open', 'closed')),
  settled_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists forward_validation_outcomes_run_status_idx on public.forward_validation_outcomes(run_id, status, closed_at);

create table if not exists public.forward_manual_decisions (
  decision_id text primary key,
  run_id text not null references public.forward_validation_runs(run_id),
  signal_id text not null references public.forward_validation_signals(id),
  decision text not null check (decision in ('SKIPPED', 'TAKEN', 'WATCHED')),
  actual_entry numeric,
  actual_size numeric,
  leverage numeric,
  actual_exit numeric,
  actual_exit_time timestamptz,
  actual_pnl numeric,
  notes text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.forward_validation_audit (
  audit_id bigint generated always as identity primary key,
  run_id text not null references public.forward_validation_runs(run_id),
  entity_type text not null,
  entity_id text not null,
  action text not null,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.forward_validation_protect_signal()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if new.signal_time is distinct from old.signal_time
    or new.side is distinct from old.side
    or new.reference_entry is distinct from old.reference_entry
    or new.stop_loss is distinct from old.stop_loss
    or new.take_profit is distinct from old.take_profit
    or new.strategy is distinct from old.strategy
    or new.strategy_hash is distinct from old.strategy_hash then
    raise exception 'forward validation signal core fields are immutable';
  end if;
  return new;
end;
$$;

create or replace function public.forward_validation_signal_audit_row()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if tg_op = 'INSERT' then
    insert into public.forward_validation_audit(run_id, entity_type, entity_id, action, before_value, after_value)
    values (new.run_id, 'signal', new.id, tg_op, null, to_jsonb(new));
    return new;
  end if;
  insert into public.forward_validation_audit(run_id, entity_type, entity_id, action, before_value, after_value)
  values (
    old.run_id, 'signal', old.id, tg_op, to_jsonb(old), to_jsonb(new)
  );
  return new;
end;
$$;

create or replace function public.forward_validation_manual_audit_row()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if tg_op = 'INSERT' then
    insert into public.forward_validation_audit(run_id, entity_type, entity_id, action, before_value, after_value)
    values (new.run_id, 'manual_decision', new.decision_id, tg_op, null, to_jsonb(new));
    return new;
  end if;
  insert into public.forward_validation_audit(run_id, entity_type, entity_id, action, before_value, after_value)
  values (
    old.run_id, 'manual_decision', old.decision_id, tg_op, to_jsonb(old), to_jsonb(new)
  );
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'forward_validation_signal_immutable') then
    create trigger forward_validation_signal_immutable before update on public.forward_validation_signals for each row execute function public.forward_validation_protect_signal();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'forward_validation_signal_audit') then
    create trigger forward_validation_signal_audit after insert or update on public.forward_validation_signals for each row execute function public.forward_validation_signal_audit_row();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'forward_validation_manual_audit') then
    create trigger forward_validation_manual_audit after insert or update on public.forward_manual_decisions for each row execute function public.forward_validation_manual_audit_row();
  end if;
end;
$$;

-- The production bridge uses these RPCs instead of direct table writes. They
-- are intentionally additive and fail closed for inactive/mutated runs.
create or replace function public.forward_validation_record_signal(p_run_id text, p_signal jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_run public.forward_validation_runs%rowtype;
  v_existing public.forward_validation_signals%rowtype;
  v_prior public.forward_validation_signals%rowtype;
  v_id text := nullif(p_signal->>'id', '');
  v_strategy text := p_signal->>'strategy';
  v_signal_time timestamptz := (p_signal->>'signal_time')::timestamptz;
  v_observed_at timestamptz := (p_signal->>'observed_at')::timestamptz;
  v_dedupe_key text := nullif(p_signal->>'dedupe_key', '');
  v_independent_id text;
  v_independent boolean;
  v_duplicate_of text;
begin
  select * into v_run from public.forward_validation_runs where run_id = p_run_id for update;
  if not found or v_run.status <> 'ACTIVE' then
    raise exception 'forward validation run is not ACTIVE';
  end if;
  if v_run.started_at is null then raise exception 'ACTIVE forward validation run has no started_at'; end if;
  if v_strategy not in ('V7.5', 'V8') then raise exception 'invalid forward strategy'; end if;
  if (v_strategy = 'V7.5' and p_signal->>'strategy_hash' <> v_run.v75_strategy_sha256)
    or (v_strategy = 'V8' and p_signal->>'strategy_hash' <> v_run.v8_strategy_sha256) then
    update public.forward_validation_runs
      set status = 'INVALIDATED', invalidated_at = now(), invalidation_reason = 'STRATEGY_MUTATION', updated_at = now()
      where run_id = p_run_id;
    return jsonb_build_object('recorded', false, 'invalidated', true, 'reason', 'STRATEGY_MUTATION');
  end if;
  if v_signal_time is null or v_observed_at is null
    or v_signal_time < v_run.started_at or v_observed_at < v_run.started_at or v_observed_at < v_signal_time then
    raise exception 'historical backfill is forbidden';
  end if;
  if v_dedupe_key is null then raise exception 'forward signal dedupe key is required'; end if;
  perform pg_advisory_xact_lock(hashtext('forward-validation|' || p_run_id || '|' || (p_signal->>'symbol') || '|' || (p_signal->>'side')));

  select * into v_existing from public.forward_validation_signals
    where dedupe_key = v_dedupe_key;
  if found then
    return jsonb_build_object('recorded', true, 'duplicate', true,
      'signal_id', v_existing.id, 'independent', v_existing.independent,
      'independent_id', v_existing.independent_id, 'overlap_group_id', v_existing.overlap_group_id);
  end if;

  select * into v_prior from public.forward_validation_signals
    where run_id = p_run_id
      and symbol = p_signal->>'symbol'
      and side = p_signal->>'side'
      and data_quality_status = 'VALID'
      and signal_time <= v_signal_time
      and signal_time > v_signal_time - interval '72 hours'
    order by signal_time desc, id asc limit 1;
  v_independent := not found;
  v_independent_id := coalesce(v_prior.independent_id,
    md5('independent|' || p_run_id || '|' || (p_signal->>'symbol') || '|' || (p_signal->>'side') || '|' || v_signal_time::text));
  v_duplicate_of := case when v_independent then null else v_prior.id end;
  insert into public.forward_validation_signals (
    id, run_id, strategy, strategy_hash, origin, symbol, side, signal_time, observed_at,
    signal_price, reference_entry, stop_loss, take_profit, stop_pct, target_r,
    market_regime, score, confidence, funding, context, email_eligible, email_sent,
    overlap_group_id, dedupe_key, independent_id, independent, duplicate_of, data_quality_status
  ) values (
    coalesce(v_id, v_dedupe_key), p_run_id, v_strategy, p_signal->>'strategy_hash',
    'forward-validation', p_signal->>'symbol', p_signal->>'side', v_signal_time, v_observed_at,
    (p_signal->>'signal_price')::numeric, (p_signal->>'reference_entry')::numeric,
    (p_signal->>'stop_loss')::numeric, (p_signal->>'take_profit')::numeric,
    (p_signal->>'stop_pct')::numeric, (p_signal->>'target_r')::numeric,
    p_signal->>'market_regime', (p_signal->>'score')::numeric, (p_signal->>'confidence')::numeric,
    p_signal->'funding', p_signal->'context', coalesce((p_signal->>'email_eligible')::boolean, false),
    coalesce((p_signal->>'email_sent')::boolean, false), p_signal->>'overlap_group_id', v_dedupe_key,
    v_independent_id, v_independent, v_duplicate_of, 'VALID'
  ) on conflict (dedupe_key) do nothing;
  select * into v_existing from public.forward_validation_signals where dedupe_key = v_dedupe_key;
  return jsonb_build_object('recorded', true, 'duplicate', v_existing.id <> coalesce(v_id, v_dedupe_key),
    'signal_id', v_existing.id, 'independent', v_existing.independent,
    'independent_id', v_existing.independent_id, 'overlap_group_id', v_existing.overlap_group_id);
end;
$$;

create or replace function public.forward_validation_record_outcome(p_run_id text, p_signal_id text, p_outcome jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_signal public.forward_validation_signals%rowtype;
  v_existing public.forward_validation_outcomes%rowtype;
  v_status text := coalesce(p_outcome->>'status', 'open');
begin
  select * into v_signal from public.forward_validation_signals
    where id = p_signal_id and run_id = p_run_id;
  if not found then raise exception 'forward signal not found'; end if;
  if v_status not in ('open', 'closed') then raise exception 'invalid forward outcome status'; end if;
  insert into public.forward_validation_outcomes (
    signal_id, run_id, position_id, opened_at, entry_price, closed_at, exit_price, exit_reason,
    gross_pnl, fees_cost, funding, net_pnl, gross_r, net_r, status, settled_at
  ) values (
    p_signal_id, p_run_id, p_outcome->>'position_id', (p_outcome->>'opened_at')::timestamptz,
    (p_outcome->>'entry_price')::numeric, (p_outcome->>'closed_at')::timestamptz,
    (p_outcome->>'exit_price')::numeric, p_outcome->>'exit_reason', (p_outcome->>'gross_pnl')::numeric,
    (p_outcome->>'fees_cost')::numeric, (p_outcome->>'funding')::numeric, (p_outcome->>'net_pnl')::numeric,
    (p_outcome->>'gross_r')::numeric, (p_outcome->>'net_r')::numeric, v_status,
    (p_outcome->>'settled_at')::timestamptz
  ) on conflict (signal_id) do update set
    position_id = coalesce(public.forward_validation_outcomes.position_id, excluded.position_id),
    closed_at = case when public.forward_validation_outcomes.status = 'open' and excluded.status = 'closed' then excluded.closed_at else public.forward_validation_outcomes.closed_at end,
    exit_price = case when public.forward_validation_outcomes.status = 'open' and excluded.status = 'closed' then excluded.exit_price else public.forward_validation_outcomes.exit_price end,
    exit_reason = case when public.forward_validation_outcomes.status = 'open' and excluded.status = 'closed' then excluded.exit_reason else public.forward_validation_outcomes.exit_reason end,
    gross_pnl = case when public.forward_validation_outcomes.status = 'open' and excluded.status = 'closed' then excluded.gross_pnl else public.forward_validation_outcomes.gross_pnl end,
    fees_cost = case when public.forward_validation_outcomes.status = 'open' and excluded.status = 'closed' then excluded.fees_cost else public.forward_validation_outcomes.fees_cost end,
    funding = case when public.forward_validation_outcomes.status = 'open' and excluded.status = 'closed' then excluded.funding else public.forward_validation_outcomes.funding end,
    net_pnl = case when public.forward_validation_outcomes.status = 'open' and excluded.status = 'closed' then excluded.net_pnl else public.forward_validation_outcomes.net_pnl end,
    gross_r = case when public.forward_validation_outcomes.status = 'open' and excluded.status = 'closed' then excluded.gross_r else public.forward_validation_outcomes.gross_r end,
    net_r = case when public.forward_validation_outcomes.status = 'open' and excluded.status = 'closed' then excluded.net_r else public.forward_validation_outcomes.net_r end,
    status = case when public.forward_validation_outcomes.status = 'open' and excluded.status = 'closed' then 'closed' else public.forward_validation_outcomes.status end,
    settled_at = case when public.forward_validation_outcomes.status = 'open' and excluded.status = 'closed' then excluded.settled_at else public.forward_validation_outcomes.settled_at end;
  select * into v_existing from public.forward_validation_outcomes where signal_id = p_signal_id;
  return jsonb_build_object('recorded', true, 'signal_id', p_signal_id, 'status', v_existing.status, 'closed_at', v_existing.closed_at);
end;
$$;

revoke all on function public.forward_validation_record_signal(text, jsonb) from public, anon, authenticated;
grant execute on function public.forward_validation_record_signal(text, jsonb) to service_role;
revoke all on function public.forward_validation_record_outcome(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.forward_validation_record_outcome(text, text, jsonb) to service_role;

alter table public.forward_validation_runs enable row level security;
alter table public.forward_validation_signals enable row level security;
alter table public.forward_validation_outcomes enable row level security;
alter table public.forward_manual_decisions enable row level security;
alter table public.forward_validation_audit enable row level security;

revoke all on table public.forward_validation_runs, public.forward_validation_signals, public.forward_validation_outcomes, public.forward_manual_decisions, public.forward_validation_audit from public, anon, authenticated;
grant all on table public.forward_validation_runs, public.forward_validation_signals, public.forward_validation_outcomes, public.forward_manual_decisions, public.forward_validation_audit to service_role;
