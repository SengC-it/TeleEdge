-- TeleEdge scheduler. The worker token stays in Vault and is never exposed to clients.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare
  v_token text;
begin
  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'teleeg_worker_token' limit 1;
  if v_token is null then
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    perform vault.create_secret(v_token, 'teleeg_worker_token', 'TeleEdge cron to Edge Function authentication');
  end if;
  update public.teleeg_account
    set cron_token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'), updated_at = now()
    where id = 1;
end;
$$;

create or replace function public.teleeg_invoke_worker(p_body jsonb)
returns bigint
language sql
security definer
set search_path = public, pg_catalog, net, vault
as $$
  select net.http_post(
    url := 'https://jfvbikivtpfjgfsnggiz.supabase.co/functions/v1/teleeg-worker',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-teleeg-token', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'teleeg_worker_token' limit 1
      )
    ),
    body := p_body,
    timeout_milliseconds := 300000
  );
$$;

revoke all on function public.teleeg_invoke_worker(jsonb) from public, anon, authenticated;
grant execute on function public.teleeg_invoke_worker(jsonb) to service_role;

do $$
declare
  v_job record;
  v_shard integer;
begin
  for v_job in select jobid from cron.job where jobname like 'teleeg-%'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;

  perform cron.schedule(
    'teleeg-context',
    '1 */4 * * *',
    $job$select public.teleeg_invoke_worker('{"action":"context"}'::jsonb);$job$
  );

  for v_shard in 0..11 loop
    perform cron.schedule(
      format('teleeg-scan-%s', v_shard),
      format('%s */4 * * *', v_shard + 5),
      format(
        $job$select public.teleeg_invoke_worker('{"action":"scan","shard":%s}'::jsonb);$job$,
        v_shard
      )
    );
  end loop;

  perform cron.schedule(
    'teleeg-finalize',
    '20 */4 * * *',
    $job$select public.teleeg_invoke_worker('{"action":"finalize"}'::jsonb);$job$
  );

  perform cron.schedule(
    'teleeg-monitor',
    '* * * * *',
    $job$select public.teleeg_invoke_worker('{"action":"monitor"}'::jsonb);$job$
  );

  perform cron.schedule(
    'teleeg-retention',
    '35 3 * * *',
    $job$
      delete from public.teleeg_job_runs where started_at < now() - interval '30 days';
      delete from public.teleeg_candidates
        where status = 'rejected' and decided_at < now() - interval '90 days';
    $job$
  );
end;
$$;
