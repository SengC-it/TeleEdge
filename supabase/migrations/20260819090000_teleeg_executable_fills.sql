-- P0: keep signal reference prices separate from executable paper fills.
alter table public.teleeg_candidates add column if not exists signal_price numeric;
alter table public.teleeg_candidates add column if not exists decision_time timestamptz;
alter table public.teleeg_candidates add column if not exists fill_time timestamptz;
alter table public.teleeg_candidates add column if not exists fill_price numeric;
alter table public.teleeg_positions add column if not exists signal_price numeric;
alter table public.teleeg_positions add column if not exists decision_time timestamptz;
alter table public.teleeg_positions add column if not exists fill_time timestamptz;
alter table public.teleeg_positions add column if not exists fill_price numeric;
alter table public.teleeg_positions add column if not exists effective_target_r numeric;

update public.teleeg_candidates
set signal_price = coalesce(signal_price, entry)
where signal_price is null;

update public.teleeg_positions
set signal_price = coalesce(signal_price, entry),
    decision_time = coalesce(decision_time, opened_at, signal_time),
    fill_time = coalesce(fill_time, opened_at, signal_time),
    fill_price = coalesce(fill_price, entry)
where signal_price is null or decision_time is null or fill_time is null or fill_price is null;

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
  v_signal_price numeric;
  v_fill_price numeric;
  v_decision_time timestamptz;
  v_fill_time timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('teleeg-portfolio'));
  select * into v_candidate from public.teleeg_candidates
    where signal_id = p_signal_id for update;
  if not found then return jsonb_build_object('accepted', false, 'reason', 'candidate-not-found'); end if;
  if v_candidate.status <> 'pending' then
    return jsonb_build_object('accepted', v_candidate.status = 'accepted', 'reason', coalesce(v_candidate.decision_reason, v_candidate.status));
  end if;
  select * into v_account from public.teleeg_account where id = 1 for update;
  v_signal_price := coalesce(v_candidate.signal_price, v_candidate.entry);
  v_fill_price := v_candidate.fill_price;
  v_decision_time := coalesce(v_candidate.decision_time, now());
  v_fill_time := coalesce(v_candidate.fill_time, v_decision_time);

  if v_candidate.expires_at < now() then v_reason := 'signal-expired';
  elsif v_fill_price is null or v_fill_price <= 0 then v_reason := 'fill-price-unavailable';
  elsif v_fill_time < v_candidate.signal_time then v_reason := 'invalid-fill-time';
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
      (v_account.equity * v_account.risk_fraction / abs(v_fill_price - v_candidate.stop))
      / v_candidate.step_size
    ) * v_candidate.step_size;
    if v_quantity <= 0 or v_quantity < v_candidate.min_qty then v_reason := 'quantity-below-market-minimum'; end if;
  end if;

  if v_reason is not null then
    update public.teleeg_candidates set status = 'rejected', decision_reason = v_reason, decided_at = now()
      where signal_id = p_signal_id;
    return jsonb_build_object('accepted', false, 'reason', v_reason);
  end if;

  v_risk := v_quantity * abs(v_fill_price - v_candidate.stop);
  v_notional := v_quantity * v_fill_price;
  insert into public.teleeg_positions (
    signal_id, model_version, mode, market_id, symbol, side, family, route,
    edge_segment, edge_score, signal_time, signal_price, decision_time,
    fill_time, fill_price, opened_at, entry, stop, target, target_r,
    stop_pct, quantity, notional_usdt, risk_usdt, last_funding_time,
    last_checked_at, features
  ) values (
    v_candidate.signal_id, v_account.model_version, v_account.mode,
    v_candidate.market_id, v_candidate.symbol, v_candidate.side,
    v_candidate.family, v_candidate.route, v_candidate.edge_segment,
    v_candidate.edge_score, v_candidate.signal_time, v_signal_price, v_decision_time,
    v_fill_time, v_fill_price, v_decision_time, v_fill_price, v_candidate.stop, v_candidate.target, v_candidate.target_r,
    v_candidate.stop_pct, v_quantity, v_notional, v_risk,
    v_fill_time, v_fill_time, v_candidate.features
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
    format(E'TeleEdge 模拟交易提醒\n\n交易品种：%s\n方向：%s\n信号参考价：%s\n模拟成交价：%s\n风险保护价：%s\n目标价格：%s\n参考数量：%s\n本次最多计划亏损：%s USDT\n信号时间：%s\n模拟成交时间：%s\n\n请注意：\n- 这是模拟交易提醒，系统不会自动下单。\n- 价格先到目标价格，按盈利结束。\n- 价格先到风险保护价，按亏损结束。\n- 如果同一分钟内两个价格都碰到，按风险保护价计算。\n- 如果两个价格都没碰到，会继续持有，不会因为时间到了而结束。',
      v_candidate.market_id,
      case when v_candidate.side = 'long' then '看涨（做多）' else '看跌（做空）' end,
      v_signal_price, v_fill_price, v_candidate.stop, v_candidate.target,
      v_quantity, round(v_risk, 2), v_candidate.signal_time, v_fill_time),
    jsonb_build_object('signal_id', v_candidate.signal_id, 'side', v_candidate.side,
      'market_id', v_candidate.market_id, 'signal_price', v_signal_price,
      'fill_price', v_fill_price, 'stop', v_candidate.stop, 'target', v_candidate.target,
      'quantity', v_quantity, 'risk_usdt', v_risk)
  ) on conflict (event_key) do nothing;
  update public.teleeg_account set updated_at = now() where id = 1;
  return jsonb_build_object('accepted', true, 'reason', 'accepted', 'quantity', v_quantity, 'risk_usdt', v_risk);
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
  select * into v_position from public.teleeg_positions where signal_id = new.position_signal_id;
  if new.event_type = 'entry' then
    new.subject := '[TeleEdge入场提醒] ' || v_position.market_id || ' '
      || case when v_position.side = 'long' then '看涨' else '看跌' end;
    new.message := format(
      E'TeleEdge 模拟交易提醒\n\n交易品种：%s\n方向：%s\n信号参考价：%s\n模拟成交价：%s\n风险保护价：%s\n目标价格：%s\n参考数量：%s\n本次最多计划亏损：%s USDT\n信号时间：%s\n模拟成交时间：%s',
      v_position.market_id,
      case when v_position.side = 'long' then '看涨（做多）' else '看跌（做空）' end,
      v_position.signal_price, v_position.fill_price, v_position.stop, v_position.target,
      v_position.quantity, round(v_position.risk_usdt, 2), v_position.signal_time, v_position.fill_time);
  elsif new.event_type = 'exit' then
    new.subject := '[TeleEdge交易结果] ' || v_position.market_id || ' '
      || case when v_position.exit_reason = 'tp' then '达到目标价格' else '触发风险保护' end;
  end if;
  return new;
end;
$$;

revoke all on function public.teleeg_accept_candidate(text) from public, anon, authenticated;
grant execute on function public.teleeg_accept_candidate(text) to service_role;
