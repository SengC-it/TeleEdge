create or replace function public.teleeg_format_outbox_chinese()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_position public.teleeg_positions%rowtype;
begin
  if new.position_signal_id is null
     or new.v8_position_signal_id is not null then
    return new;
  end if;

  select * into v_position from public.teleeg_positions where signal_id = new.position_signal_id;
  if not found then
    return new;
  end if;

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
