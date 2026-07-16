import {appendNdjson, EVENTS_FILE, OUTBOX_FILE} from './storage.mjs';
import {runtimeConfig} from './config.mjs';

function renderEntry(position) {
  return [
    `[Tele-Signal] ${position.side.toUpperCase()} ${position.marketId}`,
    `策略: ${position.family} / ${position.edgeSegment}`,
    `入场: ${position.entry}`,
    `止损: ${position.stop}`,
    `止盈: ${position.target} (${position.targetR}R)`,
    `数量: ${position.quantity}`,
    `计划风险: ${position.riskUsdt.toFixed(2)} USDT`,
    `信号K线收盘: ${new Date(position.signalTime).toISOString()}`,
    '结算规则: TP/SL先触达者；同一1m K线同时触达时按SL；无时间平仓。',
  ].join('\n');
}

function renderExit(position) {
  return [
    `[Tele-Alerts] ${position.exitReason.toUpperCase()} ${position.marketId}`,
    `方向: ${position.side.toUpperCase()}`,
    `入场/出场: ${position.entry} / ${position.exitPrice}`,
    `毛盈亏: ${position.grossPnlUsdt.toFixed(2)} USDT`,
    `资金费: ${position.fundingPnlUsdt.toFixed(2)} USDT`,
    `模型交易成本: ${position.modeledCostUsdt.toFixed(2)} USDT`,
    `净盈亏: ${position.netPnlUsdt.toFixed(2)} USDT`,
    `结算时间: ${new Date(position.exitTime).toISOString()}`,
  ].join('\n');
}

export async function notify(type, payload, now = Date.now()) {
  const event = {eventId: `${type}-${payload.id}-${now}`, type, at: now, payload};
  appendNdjson(EVENTS_FILE, event);
  const message = type === 'entry' ? renderEntry(payload) : renderExit(payload);
  const outbox = {...event, subject: message.split('\n')[0], message, delivered: false};
  appendNdjson(OUTBOX_FILE, outbox);
  if (!runtimeConfig.webhookUrl) return {delivered: false, channel: 'local-outbox'};
  const response = await fetch(runtimeConfig.webhookUrl, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(outbox),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Notification webhook returned HTTP ${response.status}`);
  return {delivered: true, channel: 'webhook'};
}
