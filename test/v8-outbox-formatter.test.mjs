import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ALERT_SOURCES, mergeNotifiableAlerts, notifiableAlert} from '../src/notifiable-alerts.mjs';

const migrationSource = fs.readFileSync(new URL('../supabase/migrations/20260824091355_teleeg_v8_outbox_formatter_guard.sql', import.meta.url), 'utf8');

function applyFormatter(row, position) {
  if (row.position_signal_id == null || row.v8_position_signal_id != null) return {...row};
  if (!position) return {...row};
  const formatted = {...row};
  if (row.event_type === 'entry') {
    formatted.subject = `[TeleEdge入场提醒] ${position.market_id} ${position.side === 'long' ? '看涨' : '看跌'}`;
    formatted.message = `TeleEdge 模拟交易提醒\n\n交易品种：${position.market_id}`;
  } else if (row.event_type === 'exit') {
    formatted.subject = `[TeleEdge交易结果] ${position.market_id}`;
  }
  return formatted;
}

test('formatter migration guards V8 rows before the V7 position lookup', () => {
  assert.match(migrationSource, /if new\.position_signal_id is null\s+or new\.v8_position_signal_id is not null then\s+return new;/);
  assert.match(migrationSource, /if not found then\s+return new;\s+end if;/);
  assert.doesNotMatch(migrationSource, /drop trigger/i);
});

test('V7.5-only rows retain the Chinese formatter and non-null fields', () => {
  const result = applyFormatter({
    event_type: 'entry',
    position_signal_id: 'control-1',
    v8_position_signal_id: null,
    subject: 'original subject',
    message: 'original message',
  }, {market_id: 'BTCUSDT', side: 'long'});
  assert.match(result.subject, /TeleEdge入场提醒/);
  assert.match(result.message, /TeleEdge 模拟交易提醒/);
  assert.ok(result.subject);
  assert.ok(result.message);
});

test('V8-only rows preserve the RPC subject and message', () => {
  const input = {
    event_type: 'entry',
    position_signal_id: null,
    v8_position_signal_id: 'shadow-1',
    subject: 'V8 smoke subject',
    message: 'V8 smoke message',
  };
  assert.deepEqual(applyFormatter(input, null), input);
});

test('a nonexistent V7 control position fails safe without nulling fields', () => {
  const input = {
    event_type: 'entry',
    position_signal_id: 'missing-control',
    v8_position_signal_id: null,
    subject: 'fallback subject',
    message: 'fallback message',
  };
  assert.deepEqual(applyFormatter(input, undefined), input);
});

test('overlap remains one notifiable alert with both model sources', () => {
  const signal = {marketId: 'BTCUSDT', side: 'long', signalTime: 2_000};
  const merged = mergeNotifiableAlerts([
    notifiableAlert(signal, ALERT_SOURCES.control),
    notifiableAlert({...signal, id: 'shadow'}, ALERT_SOURCES.shadow),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources, [ALERT_SOURCES.control, ALERT_SOURCES.shadow]);
  assert.equal(merged[0].sourceLabel, 'V7.5 CONTROL + V8 SHADOW');
});
