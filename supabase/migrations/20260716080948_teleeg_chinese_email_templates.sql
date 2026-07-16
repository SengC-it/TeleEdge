create or replace function public.teleeg_format_outbox_chinese()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_position public.teleeg_positions%rowtype;
begin
  select * into v_position
  from public.teleeg_positions
  where signal_id = new.position_signal_id;

  if new.event_type = 'entry' then
    new.subject := '[TeleEdge入场提醒] ' || v_position.market_id || ' '
      || case when v_position.side = 'long' then '看涨' else '看跌' end;
    new.message := format(
      E'TeleEdge 模拟交易提醒\n\n交易品种：%s\n方向：%s\n参考入场价：%s\n风险保护价：%s\n目标价格：%s\n参考数量：%s\n本次最多计划亏损：%s USDT\n信号时间：%s\n\n请注意：\n- 这是模拟交易提醒，系统不会自动下单。\n- 价格先到目标价格，按盈利结束。\n- 价格先到风险保护价，按亏损结束。\n- 如果同一分钟内两个价格都碰到，按风险保护价计算。\n- 如果两个价格都没碰到，会继续持有，不会因为时间到了而结束。',
      v_position.market_id,
      case when v_position.side = 'long' then '看涨（做多）' else '看跌（做空）' end,
      v_position.entry,
      v_position.stop,
      v_position.target,
      v_position.quantity,
      round(v_position.risk_usdt, 2),
      v_position.signal_time
    );
  elsif new.event_type = 'exit' then
    new.subject := '[TeleEdge交易结果] ' || v_position.market_id || ' '
      || case when v_position.exit_reason = 'tp' then '达到目标价格' else '触发风险保护' end;
    new.message := format(
      E'TeleEdge 模拟交易结果\n\n交易品种：%s\n方向：%s\n结果：%s\n参考入场价：%s\n结束价格：%s\n价格变化产生的收益：%s USDT\n持仓期间费用：%s USDT\n估算交易手续费：%s USDT\n最终收益：%s USDT\n结束时间：%s\n\n说明：以上是模拟交易结果，不代表真实账户已经产生相同收益或亏损。',
      v_position.market_id,
      case when v_position.side = 'long' then '看涨（做多）' else '看跌（做空）' end,
      case when v_position.exit_reason = 'tp'
        then '已达到目标价格，按盈利结束'
        else '已触发风险保护价格，按亏损结束'
      end,
      v_position.entry,
      v_position.exit_price,
      round(v_position.gross_pnl_usdt, 2),
      round(v_position.funding_pnl_usdt, 2),
      round(v_position.modeled_cost_usdt, 2),
      round(v_position.net_pnl_usdt, 2),
      v_position.exit_time
    );
  end if;

  return new;
end;
$$;

revoke all on function public.teleeg_format_outbox_chinese() from public, anon, authenticated;

drop trigger if exists teleeg_outbox_format_chinese on public.teleeg_outbox;
create trigger teleeg_outbox_format_chinese
before insert on public.teleeg_outbox
for each row execute function public.teleeg_format_outbox_chinese();
