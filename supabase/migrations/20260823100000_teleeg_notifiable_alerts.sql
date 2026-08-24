-- Make advisory notifications a single deduplicated stream for V7.5 and V8.
-- This is an advisory-only outbox change; it does not create an order path.

alter table public.teleeg_outbox
  alter column position_signal_id drop not null;
alter table public.teleeg_outbox
  add column if not exists v8_position_signal_id text references public.teleeg_v8_shadow_positions(signal_id);
alter table public.teleeg_outbox
  add column if not exists alert_key text;
alter table public.teleeg_outbox
  add column if not exists sources jsonb not null default '["V7.5 CONTROL"]'::jsonb;
alter table public.teleeg_outbox
  add column if not exists alert_classification text not null default 'V7.5 CONTROL';

update public.teleeg_outbox outbox
set alert_key = position.market_id || '|' || position.side || '|' || floor(extract(epoch from position.signal_time) * 1000)::bigint,
    sources = '["V7.5 CONTROL"]'::jsonb,
    alert_classification = 'V7.5 CONTROL'
from public.teleeg_positions position
where outbox.event_type = 'entry'
  and outbox.position_signal_id = position.signal_id
  and outbox.alert_key is null;

create index if not exists teleeg_outbox_v8_position_idx
  on public.teleeg_outbox (v8_position_signal_id);
create unique index if not exists teleeg_outbox_alert_key_uidx
  on public.teleeg_outbox (alert_key);

create or replace function public.teleeg_outbox_prepare_advisory_alert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_position public.teleeg_positions%rowtype;
begin
  if new.event_type <> 'entry' or new.position_signal_id is null or new.v8_position_signal_id is not null then
    return new;
  end if;
  select * into v_position from public.teleeg_positions where signal_id = new.position_signal_id;
  if not found then return new; end if;
  new.alert_key := coalesce(new.alert_key, v_position.market_id || '|' || v_position.side || '|' || floor(extract(epoch from v_position.signal_time) * 1000)::bigint);
  new.sources := '["V7.5 CONTROL"]'::jsonb;
  new.alert_classification := 'V7.5 CONTROL';
  new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object('alert_key', new.alert_key, 'sources', new.sources, 'source_label', new.alert_classification);
  if exists (select 1 from public.teleeg_outbox where alert_key = new.alert_key) then
    update public.teleeg_outbox
    set position_signal_id = coalesce(position_signal_id, new.position_signal_id),
        sources = case when sources @> '["V8 SHADOW"]'::jsonb then '["V7.5 CONTROL", "V8 SHADOW"]'::jsonb else '["V7.5 CONTROL"]'::jsonb end,
        alert_classification = case when sources @> '["V8 SHADOW"]'::jsonb then 'V7.5 CONTROL + V8 SHADOW' else 'V7.5 CONTROL' end,
        payload = payload || jsonb_build_object(
          'sources', case when sources @> '["V8 SHADOW"]'::jsonb then '["V7.5 CONTROL", "V8 SHADOW"]'::jsonb else '["V7.5 CONTROL"]'::jsonb end,
          'source_label', case when sources @> '["V8 SHADOW"]'::jsonb then 'V7.5 CONTROL + V8 SHADOW' else 'V7.5 CONTROL' end
        )
    where alert_key = new.alert_key;
    return null;
  end if;
  return new;
end;
$$;

revoke all on function public.teleeg_outbox_prepare_advisory_alert() from public, anon, authenticated;
drop trigger if exists teleeg_outbox_prepare_advisory_alert on public.teleeg_outbox;
create trigger teleeg_outbox_prepare_advisory_alert
before insert on public.teleeg_outbox
for each row execute function public.teleeg_outbox_prepare_advisory_alert();

create or replace function public.teleeg_queue_advisory_alert(
  p_alert_key text,
  p_model_source text,
  p_market_id text,
  p_side text,
  p_signal_time timestamptz,
  p_subject text,
  p_message text,
  p_payload jsonb default '{}'::jsonb,
  p_position_signal_id text default null,
  p_v8_position_signal_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_existing_id bigint;
  v_sources jsonb;
  v_classification text;
begin
  if p_model_source not in ('V7.5 CONTROL', 'V8 SHADOW') then raise exception 'invalid advisory model source'; end if;
  if nullif(p_alert_key, '') is null or p_market_id is null or p_side is null or p_signal_time is null then raise exception 'incomplete advisory alert identity'; end if;
  if p_position_signal_id is null and p_v8_position_signal_id is null then raise exception 'advisory alert position reference is required'; end if;
  select id into v_existing_id from public.teleeg_outbox where alert_key = p_alert_key for update;
  insert into public.teleeg_outbox (
    event_key, event_type, position_signal_id, v8_position_signal_id, alert_key,
    sources, alert_classification, subject, message, payload
  ) values (
    'entry:' || case when p_model_source = 'V8 SHADOW' then 'v8:' else '' end || coalesce(p_position_signal_id, p_v8_position_signal_id),
    'entry', p_position_signal_id, p_v8_position_signal_id, p_alert_key,
    case when p_model_source = 'V8 SHADOW' then '["V8 SHADOW"]'::jsonb else '["V7.5 CONTROL"]'::jsonb end,
    case when p_model_source = 'V8 SHADOW' then 'V8 SHADOW / EXPERIMENTAL' else p_model_source end, p_subject, p_message,
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('alert_key', p_alert_key)
  )
  on conflict (alert_key) do update set
    position_signal_id = coalesce(public.teleeg_outbox.position_signal_id, excluded.position_signal_id),
    v8_position_signal_id = coalesce(public.teleeg_outbox.v8_position_signal_id, excluded.v8_position_signal_id),
    sources = case
      when (public.teleeg_outbox.sources @> '["V7.5 CONTROL"]'::jsonb and excluded.sources @> '["V8 SHADOW"]'::jsonb)
        or (public.teleeg_outbox.sources @> '["V8 SHADOW"]'::jsonb and excluded.sources @> '["V7.5 CONTROL"]'::jsonb)
        then '["V7.5 CONTROL", "V8 SHADOW"]'::jsonb
      when excluded.sources @> '["V7.5 CONTROL"]'::jsonb then '["V7.5 CONTROL"]'::jsonb
      else '["V8 SHADOW"]'::jsonb
    end,
    alert_classification = case
      when (public.teleeg_outbox.sources @> '["V7.5 CONTROL"]'::jsonb and excluded.sources @> '["V8 SHADOW"]'::jsonb)
        or (public.teleeg_outbox.sources @> '["V8 SHADOW"]'::jsonb and excluded.sources @> '["V7.5 CONTROL"]'::jsonb)
        then 'V7.5 CONTROL + V8 SHADOW'
      when excluded.sources @> '["V7.5 CONTROL"]'::jsonb then 'V7.5 CONTROL'
      else 'V8 SHADOW / EXPERIMENTAL'
    end,
    payload = public.teleeg_outbox.payload || excluded.payload;
  select sources, alert_classification into v_sources, v_classification from public.teleeg_outbox where alert_key = p_alert_key;
  return jsonb_build_object('notifiable', true, 'deduped', v_existing_id is not null, 'sources', v_sources, 'sourceLabel', v_classification);
end;
$$;

revoke all on function public.teleeg_queue_advisory_alert(text, text, text, text, timestamptz, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.teleeg_queue_advisory_alert(text, text, text, text, timestamptz, text, text, jsonb, text, text) to service_role;
