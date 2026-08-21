create or replace function public.teleeg_compact_scan_summary(p_summary jsonb)
returns jsonb
language sql
stable
set search_path = public, pg_catalog
as $$
  with reason_rows as (
    select key as reason, (value #>> '{}')::integer as count
    from jsonb_each(coalesce(p_summary->'funnel'->'rejectionReasons', '{}'::jsonb))
    order by (value #>> '{}')::integer desc, key
    limit 8
  )
  select jsonb_build_object(
    'stages', coalesce(p_summary->'funnel'->'stages', '{}'::jsonb),
    'topRejectionReasons', coalesce(
      (select jsonb_agg(jsonb_build_object('reason', reason, 'count', count) order by count desc, reason)
       from reason_rows),
      '[]'::jsonb
    ),
    'candidateCount', coalesce(p_summary->'candidates', '0'::jsonb),
    'acceptedCount', coalesce(p_summary->'accepted', '0'::jsonb),
    'v8Shadow', jsonb_build_object(
      'candidates', coalesce(p_summary->'v8Shadow'->'candidates', '0'::jsonb),
      'accepted', coalesce(p_summary->'v8Shadow'->'accepted', '0'::jsonb),
      'rejected', coalesce(p_summary->'v8Shadow'->'rejected', '0'::jsonb),
      'errors', coalesce(p_summary->'v8Shadow'->'errors', '0'::jsonb)
    )
  );
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
    (select count(*) from public.teleeg_outbox where status in ('pending', 'failed')),
    v_context.as_of, v_scan.completed_at, v_monitor.completed_at,
    v_context.btc_router, v_context.breadth_above_50,
    public.teleeg_compact_scan_summary(coalesce(v_scan.summary, '{}'::jsonb)),
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

revoke all on function public.teleeg_compact_scan_summary(jsonb) from public, anon, authenticated;
revoke all on function public.teleeg_refresh_public_status() from public, anon, authenticated;
grant execute on function public.teleeg_refresh_public_status() to service_role;
