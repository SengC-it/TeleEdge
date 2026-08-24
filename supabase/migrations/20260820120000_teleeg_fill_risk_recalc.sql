-- Recompute executable risk levels after the paper fill. The signal target is
-- not a valid executable target once the fill moves away from signal_price.
alter table public.teleeg_positions add column if not exists effective_target_r numeric;
update public.teleeg_positions
set effective_target_r = coalesce(effective_target_r, target_r)
where effective_target_r is null;
alter table public.teleeg_positions alter column effective_target_r set not null;

alter table public.teleeg_v8_shadow_positions add column if not exists effective_target_r numeric;
update public.teleeg_v8_shadow_positions
set effective_target_r = coalesce(effective_target_r, target_r)
where effective_target_r is null;
alter table public.teleeg_v8_shadow_positions alter column effective_target_r set not null;

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
  v_stop numeric;
  v_target numeric;
  v_stop_pct numeric;
  v_effective_target_r numeric;
  v_tick_size numeric;
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
  v_tick_size := v_candidate.tick_size;
  v_decision_time := coalesce(v_candidate.decision_time, now());
  v_fill_time := coalesce(v_candidate.fill_time, v_decision_time);

  if v_candidate.expires_at < now() then v_reason := 'signal-expired';
  elsif v_fill_price is null or v_fill_price <= 0 then v_reason := 'fill-price-unavailable';
  elsif v_fill_time < v_candidate.signal_time then v_reason := 'invalid-fill-time';
  elsif v_tick_size is null or v_tick_size <= 0 then v_reason := 'invalid-market-tick';
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
    v_fill_price := round(v_fill_price / v_tick_size) * v_tick_size;
    v_stop := round(v_candidate.stop / v_tick_size) * v_tick_size;
    v_stop_pct := abs(v_fill_price - v_stop) / v_fill_price;
    if v_candidate.side = 'long' and v_stop >= v_fill_price then
      v_reason := 'invalid-fill-or-stop';
    elsif v_candidate.side = 'short' and v_stop <= v_fill_price then
      v_reason := 'invalid-fill-or-stop';
    elsif v_stop_pct > (case when v_candidate.family = 'fundingCrowdingReversal' then 0.08
                            when v_candidate.family = 'volumeShockReversal' then 0.10
                            else 0.12 end)
       or v_stop_pct < 0.02 then
      v_reason := 'fill-stop-risk-out-of-bounds';
    else
      v_target := round((v_fill_price
        + (case when v_candidate.side = 'long' then 1 else -1 end)
        * v_candidate.target_r * abs(v_fill_price - v_stop)) / v_tick_size) * v_tick_size;
      v_effective_target_r := abs(v_target - v_fill_price) / abs(v_fill_price - v_stop);
      if (v_candidate.side = 'long' and v_target <= v_fill_price)
         or (v_candidate.side = 'short' and v_target >= v_fill_price)
         or v_effective_target_r < v_candidate.target_r * 0.95 then
        v_reason := 'fill-target-risk-too-low';
      end if;
    end if;
  end if;

  if v_reason is null then
    v_quantity := floor(
      (v_account.equity * v_account.risk_fraction / abs(v_fill_price - v_stop))
      / v_candidate.step_size
    ) * v_candidate.step_size;
    if v_quantity <= 0 or v_quantity < v_candidate.min_qty then v_reason := 'quantity-below-market-minimum'; end if;
  end if;

  if v_reason is not null then
    update public.teleeg_candidates set status = 'rejected', decision_reason = v_reason, decided_at = now()
      where signal_id = p_signal_id;
    return jsonb_build_object('accepted', false, 'reason', v_reason);
  end if;

  v_risk := v_quantity * abs(v_fill_price - v_stop);
  v_notional := v_quantity * v_fill_price;
  insert into public.teleeg_positions (
    signal_id, model_version, mode, market_id, symbol, side, family, route,
    edge_segment, edge_score, signal_time, signal_price, decision_time,
    fill_time, fill_price, opened_at, entry, stop, target, target_r, effective_target_r,
    stop_pct, quantity, notional_usdt, risk_usdt, last_funding_time,
    last_checked_at, features
  ) values (
    v_candidate.signal_id, v_account.model_version, v_account.mode,
    v_candidate.market_id, v_candidate.symbol, v_candidate.side,
    v_candidate.family, v_candidate.route, v_candidate.edge_segment,
    v_candidate.edge_score, v_candidate.signal_time, v_signal_price, v_decision_time,
    v_fill_time, v_fill_price, v_decision_time, v_fill_price, v_stop, v_target, v_candidate.target_r, v_effective_target_r,
    v_stop_pct, v_quantity, v_notional, v_risk,
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
    format(E'TeleEdge 模拟交易提醒\n\n交易品种：%s\n方向：%s\n信号参考价：%s\n模拟成交价：%s\n风险保护价：%s\n目标价格：%s\n参考数量：%s\n本次最多计划亏损：%s USDT\n信号时间：%s\n模拟成交时间：%s',
      v_candidate.market_id,
      case when v_candidate.side = 'long' then '看涨（做多）' else '看跌（做空）' end,
      v_signal_price, v_fill_price, v_stop, v_target,
      v_quantity, round(v_risk, 2), v_candidate.signal_time, v_fill_time),
    jsonb_build_object('signal_id', v_candidate.signal_id, 'side', v_candidate.side,
      'market_id', v_candidate.market_id, 'signal_price', v_signal_price,
      'fill_price', v_fill_price, 'stop', v_stop, 'target', v_target,
      'effective_target_r', v_effective_target_r, 'quantity', v_quantity, 'risk_usdt', v_risk)
  ) on conflict (event_key) do nothing;
  update public.teleeg_account set updated_at = now() where id = 1;
  return jsonb_build_object('accepted', true, 'reason', 'accepted', 'quantity', v_quantity, 'risk_usdt', v_risk,
    'target', v_target, 'effective_target_r', v_effective_target_r, 'stop_pct', v_stop_pct);
end;
$$;

revoke all on function public.teleeg_accept_candidate(text) from public, anon, authenticated;
grant execute on function public.teleeg_accept_candidate(text) to service_role;
