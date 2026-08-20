-- Keep V8 shadow signals, positions, and equity completely outside V7.5.
create table if not exists public.teleeg_v8_shadow_account (
  id smallint primary key default 1 check (id = 1),
  model_version text not null default 'V8-shadow-research-20260819',
  mode text not null default 'paper-shadow' check (mode = 'paper-shadow'),
  starting_equity numeric(24, 8) not null default 10000,
  equity numeric(24, 8) not null default 10000,
  peak_equity numeric(24, 8) not null default 10000,
  realized_pnl numeric(24, 8) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.teleeg_v8_shadow_signals (
  signal_id text primary key,
  cycle_time timestamptz not null,
  signal_time timestamptz not null,
  market_id text not null,
  symbol text not null,
  side text not null check (side in ('long', 'short')),
  alpha text not null check (alpha in ('bull', 'bear', 'reversal')),
  family text not null,
  route text not null,
  edge_segment text not null,
  signal_price numeric not null,
  stop numeric not null,
  target numeric not null,
  target_r numeric not null,
  stop_pct numeric not null,
  edge_score numeric not null,
  event_score numeric not null,
  day_volume numeric not null,
  features jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  decision_reason text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists public.teleeg_v8_shadow_positions (
  signal_id text primary key references public.teleeg_v8_shadow_signals(signal_id),
  model_version text not null default 'V8-shadow-research-20260819',
  mode text not null default 'paper-shadow' check (mode = 'paper-shadow'),
  market_id text not null,
  symbol text not null,
  side text not null check (side in ('long', 'short')),
  alpha text not null check (alpha in ('bull', 'bear', 'reversal')),
  family text not null,
  signal_time timestamptz not null,
  signal_price numeric not null,
  decision_time timestamptz not null,
  fill_time timestamptz not null,
  fill_price numeric not null,
  entry numeric not null,
  stop numeric not null,
  target numeric not null,
  target_r numeric not null,
  effective_target_r numeric not null,
  quantity numeric not null default 1,
  risk_usdt numeric not null,
  funding_pnl_usdt numeric not null default 0,
  last_funding_time timestamptz not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  exit_reason text check (exit_reason is null or exit_reason in ('tp', 'sl')),
  exit_price numeric,
  exit_time timestamptz,
  ambiguous_same_minute boolean,
  gross_pnl_usdt numeric,
  modeled_cost_usdt numeric,
  net_pnl_usdt numeric,
  net_r numeric,
  opened_at timestamptz not null,
  last_checked_at timestamptz not null,
  features jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create unique index if not exists teleeg_v8_shadow_one_open_market_idx
  on public.teleeg_v8_shadow_positions (market_id) where status = 'open';
create index if not exists teleeg_v8_shadow_signals_cycle_idx
  on public.teleeg_v8_shadow_signals (cycle_time, status, side, edge_score desc, event_score desc);
create index if not exists teleeg_v8_shadow_positions_status_idx
  on public.teleeg_v8_shadow_positions (status, opened_at);

insert into public.teleeg_v8_shadow_account (id) values (1) on conflict (id) do nothing;
alter table public.teleeg_v8_shadow_account add column if not exists peak_equity numeric(24, 8) not null default 10000;
update public.teleeg_v8_shadow_account set peak_equity = greatest(peak_equity, equity) where id = 1;
alter table public.teleeg_v8_shadow_account enable row level security;
alter table public.teleeg_v8_shadow_signals enable row level security;
alter table public.teleeg_v8_shadow_positions enable row level security;
revoke all on table public.teleeg_v8_shadow_account from anon, authenticated;
revoke all on table public.teleeg_v8_shadow_signals from anon, authenticated;
revoke all on table public.teleeg_v8_shadow_positions from anon, authenticated;
grant all on table public.teleeg_v8_shadow_account to service_role;
grant all on table public.teleeg_v8_shadow_signals to service_role;
grant all on table public.teleeg_v8_shadow_positions to service_role;
