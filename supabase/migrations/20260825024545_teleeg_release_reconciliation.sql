-- Reconcile the paper/shadow bookkeeping side effects from the release smoke.
-- This migration intentionally does not change strategy, acceptance, or settlement rules.

do $$
declare
  v_realized numeric;
begin
  perform pg_advisory_xact_lock(hashtext('teleeg-portfolio'));

  select coalesce(sum(p.net_pnl_usdt), 0)
    into v_realized
  from public.teleeg_positions as p
  where p.status = 'closed';

  update public.teleeg_account
  set realized_pnl = v_realized,
      equity = starting_equity + v_realized,
      updated_at = now()
  where id = 1;

  if exists (
    select 1
    from public.teleeg_v8_shadow_positions
  ) then
    raise exception 'V8 position state changed; manual reconciliation required';
  end if;

  update public.teleeg_v8_shadow_account
  set realized_pnl = 0,
      equity = starting_equity,
      peak_equity = starting_equity,
      updated_at = now()
  where id = 1;

  delete from public.teleeg_cooldowns as c
  where c.market_id in ('1000PEPEUSDT', '1000BONKUSDT')
    and c.last_exit_time >= timestamptz '2026-08-25 02:11:00+00'
    and c.last_exit_time <= timestamptz '2026-08-25 02:13:00+00'
    and not exists (
      select 1
      from public.teleeg_positions as p
      where p.market_id = c.market_id
        and p.status = 'closed'
        and p.exit_time = c.last_exit_time
    );
end;
$$;

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
    (select count(*) from public.teleeg_outbox
      where status = 'pending'
         or (status = 'failed' and attempts < 5)),
    v_context.as_of, v_scan.completed_at, v_monitor.completed_at,
    v_context.btc_router, v_context.breadth_above_50,
    public.teleeg_compact_scan_summary(coalesce(v_scan.summary, '{}'::jsonb)),
    case when v_error.completed_at is not null
      and v_error.completed_at > greatest(
        coalesce(v_scan.completed_at, '-infinity'::timestamptz),
        coalesce(v_monitor.completed_at, '-infinity'::timestamptz)
      ) then v_error.error else null end,
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

revoke all on function public.teleeg_refresh_public_status() from public, anon, authenticated;
grant execute on function public.teleeg_refresh_public_status() to service_role;
