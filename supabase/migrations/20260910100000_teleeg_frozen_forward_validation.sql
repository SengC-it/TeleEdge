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

alter table public.forward_validation_runs enable row level security;
alter table public.forward_validation_signals enable row level security;
alter table public.forward_validation_outcomes enable row level security;
alter table public.forward_manual_decisions enable row level security;
alter table public.forward_validation_audit enable row level security;

revoke all on table public.forward_validation_runs, public.forward_validation_signals, public.forward_validation_outcomes, public.forward_manual_decisions, public.forward_validation_audit from public, anon, authenticated;
grant all on table public.forward_validation_runs, public.forward_validation_signals, public.forward_validation_outcomes, public.forward_manual_decisions, public.forward_validation_audit to service_role;
