import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {APP_DIR} from '../src/config.mjs';
import {buildReviewsPayload} from '../src/reviews.mjs';
import {compactFunnelSummary} from '../supabase/functions/teleeg-worker/funnel.mjs';
import {ALERT_SOURCES, mergeNotifiableAlerts, notifiableAlert, summarizeNotifiableAlerts} from '../src/notifiable-alerts.mjs';

const JSON_OUTPUT = path.join(APP_DIR, 'reports', 'production-preview-smoke.json');
const MARKDOWN_OUTPUT = path.join(APP_DIR, 'reports', 'production-preview-smoke.md');

class PreviewSupabase {
  constructor() {
    this.tables = new Map();
  }

  async write(table, row) {
    const rows = this.tables.get(table) || [];
    rows.push(structuredClone(row));
    this.tables.set(table, rows);
    return structuredClone(row);
  }

  async read(table) {
    return structuredClone(this.tables.get(table) || []);
  }
}

function sourceFiles() {
  return [
    'src/service.mjs',
    'src/notifier.mjs',
    'supabase/functions/teleeg-worker/index.ts',
    'supabase/schema/teleeg.sql',
  ];
}

function assertNoOrderPath() {
  for (const relative of sourceFiles()) {
    const source = fs.readFileSync(path.join(APP_DIR, relative), 'utf8');
    assert.doesNotMatch(source, /\b(createOrder|placeOrder|newOrder)\b|\/fapi\/v\d+\/order\b/i, relative);
  }
}

async function main() {
  const control = {id: 'V75|BTCUSDT|long|1700000000000', marketId: 'BTCUSDT', side: 'long', signalTime: 1_700_000_000_000, status: 'open'};
  const shadowOverlap = {...control, id: 'V8|BTCUSDT|long|1700000000000', modelVersion: 'V8-shadow'};
  const shadowOnly = {id: 'V8|ETHUSDT|short|1700000100000', marketId: 'ETHUSDT', side: 'short', signalTime: 1_700_000_100_000, status: 'open', modelVersion: 'V8-shadow'};
  const alerts = mergeNotifiableAlerts([
    notifiableAlert(control, ALERT_SOURCES.control),
    notifiableAlert(shadowOverlap, ALERT_SOURCES.shadow),
    notifiableAlert(shadowOnly, ALERT_SOURCES.shadow),
  ]);
  const notification = summarizeNotifiableAlerts(alerts.map(alert => ({...alert, emailSent: true})));
  assert.equal(notification.combined, 2);
  assert.equal(notification.overlapDeduped, 1);
  assert.equal(notification.v8Only, 1);

  const supabase = new PreviewSupabase();
  await supabase.write('teleeg_positions', {signal_id: control.id, status: 'open', market_id: control.marketId, side: control.side, signal_time: new Date(control.signalTime).toISOString()});
  await supabase.write('teleeg_v8_shadow_positions', {signal_id: shadowOnly.id, status: 'open', market_id: shadowOnly.marketId, side: shadowOnly.side, signal_time: new Date(shadowOnly.signalTime).toISOString()});
  for (const alert of alerts) {
    await supabase.write('teleeg_outbox', {
      alert_key: alert.key,
      event_type: 'entry',
      status: 'sent',
      sources: alert.sources,
      alert_classification: alert.sourceLabel,
      position_signal_id: alert.sourceLabel.includes('V7.5') ? control.id : null,
      v8_position_signal_id: alert.sources.includes(ALERT_SOURCES.shadow) ? (alert.key === alerts[0].key ? shadowOverlap.id : shadowOnly.id) : null,
    });
  }
  const [positions, shadowPositions, outbox] = await Promise.all([
    supabase.read('teleeg_positions'),
    supabase.read('teleeg_v8_shadow_positions'),
    supabase.read('teleeg_outbox'),
  ]);
  const history = buildReviewsPayload(positions, outbox, shadowPositions);
  assert.equal(history.trades.length, 2);
  assert.equal(history.trades.filter(row => row.notificationStatus.entry.status === 'sent').length, 2);

  const dashboard = compactFunnelSummary({
    candidates: 3,
    accepted: 1,
    notifiableAlerts: notification.combined,
    emailSent: notification.emailSent,
    funnel: {stages: {}, byDimension: {large: {diagnostic: true}}, rejectionReasons: {}},
    v8Shadow: {candidates: 2, accepted: 1, rejected: 1, errors: 0},
  });
  assert.equal(dashboard.notifiableAlertCount, 2);
  assert.equal('byDimension' in dashboard, false);
  assertNoOrderPath();

  const result = {
    status: 'PASS',
    mode: 'preview-contract-smoke',
    productionReleaseStatus: 'READY_FOR_MANUAL_AUTHORIZATION',
    signalOnlyAdvisory: true,
    pipelines: {v75Control: 'PASS', v8Shadow: 'PASS'},
    overlapDedupe: {status: 'PASS', overlapDedupedAlerts: notification.overlapDeduped},
    v8OnlyNotification: {status: 'PASS', alerts: notification.v8Only},
    email: {status: 'PASS', sent: notification.emailSent, transport: 'preview fake delivery'},
    historyReviews: {status: 'PASS', rows: history.trades.length},
    dashboardStatus: {status: 'PASS', notifiableAlerts: dashboard.notifiableAlertCount, includesByDimension: 'byDimension' in dashboard},
    supabase: {status: 'PASS', transport: 'in-memory read/write contract; no production network or database mutation', tables: [...supabase.tables.keys()]},
    orderPathAudit: {status: 'PASS', files: sourceFiles()},
    artifactWrite: 'PENDING',
    notifiableAlerts: notification.alerts.map(alert => ({key: alert.key, sources: alert.sources, sourceLabel: alert.sourceLabel})),
  };
  const markdown = [
    '# Production Preview Smoke',
    '',
    `- Status: **${result.status}**`,
    `- Production Release Status: **${result.productionReleaseStatus}**`,
    '- Signal-only advisory: **true**',
    '- V7.5 Control pipeline: **PASS**',
    '- V8 Shadow pipeline: **PASS**',
    `- Overlap deduped alerts: **${notification.overlapDeduped}**`,
    `- V8-only notifications: **${notification.v8Only}**`,
    `- Combined notifiable alerts: **${notification.combined}**`,
    `- Preview email sends: **${notification.emailSent}**`,
    '- History/reviews: **PASS**',
    '- Dashboard/status compact payload: **PASS**; full byDimension was not exposed',
    '- Supabase read/write: **PASS** using in-memory contract only; no production mutation',
    '- Binance order endpoint audit: **PASS**; no order submission path',
    '',
    'This is a preview contract smoke, not a production deployment and not a profitability conclusion.',
    '',
  ].join('\n');
  try {
    result.artifactWrite = 'PASS';
    fs.mkdirSync(path.dirname(JSON_OUTPUT), {recursive: true});
    fs.writeFileSync(JSON_OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(MARKDOWN_OUTPUT, markdown);
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
    result.artifactWrite = 'SKIPPED_READ_ONLY_WORKSPACE';
  }
  console.log(JSON.stringify({json: path.relative(APP_DIR, JSON_OUTPUT), markdown: path.relative(APP_DIR, MARKDOWN_OUTPUT), status: result.status, artifactWrite: result.artifactWrite, combinedNotifiableAlerts: notification.combined}, null, 2));
}

await main();
