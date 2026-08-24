import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ALERT_SOURCES, NOTIFIABLE_STAGES, classifyRejection, mergeNotifiableAlerts, notifiableAlert, rejectionBreakdown, summarizeNotifiableAlerts} from '../src/notifiable-alerts.mjs';
import {buildReviewsPayload} from '../src/reviews.mjs';
import {compactFunnelSummary} from '../supabase/functions/teleeg-worker/funnel.mjs';
import {exchangeMarkets} from '../scripts/backtest.mjs';

const workerSource = fs.readFileSync(new URL('../supabase/functions/teleeg-worker/index.ts', import.meta.url), 'utf8');
const schemaSource = fs.readFileSync(new URL('../supabase/schema/teleeg.sql', import.meta.url), 'utf8');

test('production notification contract exposes the five explicit stages', () => {
  assert.deepEqual(NOTIFIABLE_STAGES, ['candidate', 'ranked signal', 'accepted signal', 'notifiable alert', 'email sent']);
});

test('same symbol/side/timestamp is one notifiable alert with merged model sources', () => {
  const signal = {id: 'control', marketId: 'BTCUSDT', side: 'long', signalTime: 1_700_000_000_000};
  const shadow = {...signal, id: 'shadow'};
  const merged = mergeNotifiableAlerts([
    {...notifiableAlert(signal, ALERT_SOURCES.control), stage: 'ranked signal'},
    notifiableAlert(signal, ALERT_SOURCES.control),
    notifiableAlert(shadow, ALERT_SOURCES.shadow),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources, [ALERT_SOURCES.control, ALERT_SOURCES.shadow]);
  assert.equal(merged[0].sourceLabel, 'V7.5 CONTROL + V8 SHADOW');
  assert.equal(summarizeNotifiableAlerts(merged).overlapDeduped, 1);
});

test('V8-only and V7.5-only alerts keep explicit labels', () => {
  const rows = summarizeNotifiableAlerts([
    notifiableAlert({marketId: 'ETHUSDT', side: 'short', signalTime: 1}, ALERT_SOURCES.shadow),
    notifiableAlert({marketId: 'SOLUSDT', side: 'long', signalTime: 2}, ALERT_SOURCES.control),
  ]);
  assert.equal(rows.v8Only, 1);
  assert.equal(rows.v75, 1);
  assert.equal(rows.overlapDeduped, 0);
  assert.equal(rows.combined, 2);
});

test('ranked is not accepted and accepted is not email sent', () => {
  const alerts = mergeNotifiableAlerts([
    {...notifiableAlert({marketId: 'BTCUSDT', side: 'long', signalTime: 1}, ALERT_SOURCES.control), stage: 'ranked signal'},
  ]);
  assert.equal(alerts.length, 0);
  assert.equal(classifyRejection('fill-price-unavailable'), 'fill unavailable');
  assert.equal(classifyRejection('symbol-cooldown'), 'cooldown');
  assert.equal(classifyRejection('quantity-below-market-minimum'), 'quantity/minQty');
  assert.equal(classifyRejection('invalid-market-tick'), 'other');
});

test('rejection breakdown preserves every ranked signal and raw reason', () => {
  const result = rejectionBreakdown([
    {id: 'a', symbol: 'AUSDT', side: 'long', signalTime: 1, reason: 'fill-price-unavailable'},
    {id: 'b', symbol: 'BUSDT', side: 'short', signalTime: 2, reason: 'symbol-already-open'},
  ]);
  assert.equal(result.total, 2);
  assert.equal(result.categories['fill unavailable'], 1);
  assert.equal(result.categories['symbol already open'], 1);
  assert.deepEqual(result.byReason, {'fill-price-unavailable': 1, 'symbol-already-open': 1});
  assert.equal(result.signals[1].rawReason, 'symbol-already-open');
});

test('backtest loads exchange filters from the verified source snapshot when root copy is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleedge-release-'));
  try {
    fs.mkdirSync(path.join(root, 'source'), {recursive: true});
    fs.writeFileSync(path.join(root, 'source', 'current-exchangeInfo.json'), JSON.stringify({symbols: [
      {symbol: 'BTCUSDT', baseAsset: 'BTC', onboardDate: 1, filters: [
        {filterType: 'PRICE_FILTER', tickSize: '0.10'},
        {filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001'},
      ]},
    ]}));
    const markets = exchangeMarkets(root, false);
    assert.equal(markets.get('BTCUSDT').filters[0].tickSize, '0.10');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('reviews include shadow history and its shared outbox notification state', () => {
  const payload = buildReviewsPayload([
    {signal_id: 'control', status: 'closed', market_id: 'BTCUSDT', exit_reason: 'tp', signal_time: '2026-08-01T00:00:00Z'},
  ], [
    {v8_position_signal_id: 'shadow', event_type: 'entry', status: 'sent', attempts: 1},
  ], [
    {signal_id: 'shadow', status: 'closed', market_id: 'ETHUSDT', exit_reason: 'sl', signal_time: '2026-08-02T00:00:00Z'},
  ]);
  assert.equal(payload.source, 'teleeg_positions+teleeg_v8_shadow_positions');
  assert.equal(payload.trades.length, 2);
  assert.equal(payload.trades[0].notificationStatus.entry.status, 'sent');
});

test('compact dashboard summary contains notifiable count but no full dimension payload', () => {
  const compact = compactFunnelSummary({
    candidates: 10,
    accepted: 2,
    notifiableAlerts: 1,
    emailSent: 1,
    funnel: {stages: {}, byDimension: {huge: {x: 1}}, rejectionReasons: {}},
    v8Shadow: {candidates: 3, accepted: 1, rejected: 2, errors: 0},
  });
  assert.equal(compact.notifiableAlertCount, 1);
  assert.equal(compact.emailSentCount, 1);
  assert.equal('byDimension' in compact, false);
});

test('cloud worker uses the shared advisory outbox contract for V8 notifications', () => {
  assert.match(workerSource, /teleeg_queue_advisory_alert/);
  assert.match(workerSource, /p_model_source: 'V8 SHADOW'/);
  assert.match(schemaSource, /v8_position_signal_id/);
  assert.match(schemaSource, /teleeg_outbox_alert_key_uidx/);
  assert.match(schemaSource, /teleeg_queue_advisory_alert/);
});

test('preview source audit keeps the system advisory-only', () => {
  const files = ['src/service.mjs', 'supabase/functions/teleeg-worker/index.ts', 'supabase/schema/teleeg.sql'];
  for (const file of files) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(createOrder|placeOrder|newOrder)\b|\/fapi\/v\d+\/order\b/i, file);
  }
});
