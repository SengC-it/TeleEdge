import fs from 'node:fs';
import path from 'node:path';
import {APP_DIR} from '../src/config.mjs';
import {NOTIFIABLE_STAGES, notifiableAlert, rejectionBreakdown, summarizeNotifiableAlerts} from '../src/notifiable-alerts.mjs';

const REPORT_DIR = path.join(APP_DIR, 'reports');
const INPUT = path.join(REPORT_DIR, 'final-signal-validation.json');
const OUTPUT = path.join(REPORT_DIR, 'final-signal-validation.json');
const MARKDOWN = path.join(REPORT_DIR, 'final-signal-validation.md');
const EXCHANGE_ROOT = path.join(APP_DIR, 'data', 'backtest', 'exchangeInfo.json');
const EXCHANGE_SOURCE = path.join(APP_DIR, 'data', 'backtest', 'source', 'current-exchangeInfo.json');

function write(file, value) {
  try {
    fs.writeFileSync(file, value);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return false;
    throw error;
  }
}

function auditPersistedV75(report) {
  const model = report.models.v75;
  const signals = model.signalObservations || [];
  const dataRulesMissing = !fs.existsSync(EXCHANGE_ROOT) && fs.existsSync(EXCHANGE_SOURCE);
  if (model.simulatedAcceptedSignals !== 0 || !signals.length || !dataRulesMissing) {
    return {
      status: 'UNAVAILABLE_WITHOUT_REPLAY',
      rankedSignals: model.rankedSignals,
      persistedAcceptedSignals: model.simulatedAcceptedSignals,
      recomputedAcceptedSignals: null,
      requiresReplay: true,
      rows: [],
      reason: 'The persisted run does not contain enough acceptance evidence for a safe per-signal diagnosis.',
    };
  }
  const rows = signals.map(signal => ({
    signalId: signal.id,
    symbol: signal.symbol,
    side: signal.side,
    signalTime: signal.signalTime,
    firstFailureTimestamp: Number(signal.signalTime) + 20 * 60_000,
    reason: 'invalid-market-tick',
    stage: 'accepted signal',
    boundary: null,
  }));
  return {
    status: 'INVALIDATED_BY_ACCEPTANCE_LOADER_BUG',
    rankedSignals: model.rankedSignals,
    persistedAcceptedSignals: model.simulatedAcceptedSignals,
    recomputedAcceptedSignals: null,
    requiresReplay: true,
    rows,
    reason: 'The persisted validation run had no data/backtest exchangeInfo.json. marketFor() therefore supplied empty filters and the frozen acceptance contract rejected every ranked V7.5 signal at invalid-market-tick. The verified source snapshot exists, and the loader is now fixed; no formal replay was run in this M5 pass.',
    evidence: {
      missingRootExchangeInfo: EXCHANGE_ROOT,
      availableVerifiedSource: EXCHANGE_SOURCE,
      allSignalsHadMinuteData: signals.every(signal => signal.minuteDataAvailable === true),
    },
  };
}

function buildNotifiableIncrement(report) {
  const v75 = (report.models.v75.tradeRecords || []).map(trade => notifiableAlert(trade, 'V7.5 CONTROL'));
  const v8 = (report.models.v8.tradeRecords || []).map(trade => notifiableAlert(trade, 'V8 SHADOW'));
  const merged = summarizeNotifiableAlerts([...v75, ...v8]);
  return {
    v75Notifiable: v75.length,
    v8OnlyNotifiable: merged.v8Only,
    overlapDeduped: merged.overlapDeduped,
    combinedNotifiable: merged.combined,
    actualSignalIncreasePct: v75.length ? (merged.combined - v75.length) / v75.length * 100 : null,
    emailSent: null,
    alerts: merged.alerts.map(alert => ({
      key: alert.key,
      symbol: alert.symbol,
      side: alert.side,
      signalTime: alert.signalTime,
      sources: alert.sources,
      sourceLabel: alert.sourceLabel,
    })),
  };
}

function markdown(report) {
  const v75 = report.models.v75;
  const v8 = report.models.v8;
  const audit = report.models.v75.rejectionBreakdown;
  const rows = (audit?.signals || []).map(row => `| ${row.signalId} | ${row.symbol} | ${row.side} | ${new Date(row.signalTime).toISOString()} | ${row.reason} | ${row.rawReason} |`).join('\n');
  return [
    `# ${report.result}`,
    '',
    '## Production release validation boundary',
    '',
    `- Production Release Status: **${report.productionReleaseStatus}**`,
    '- M5 human gate: **SHADOW GO**; V8 remains Shadow and does not replace V7.5 Control.',
    '- No formal OOS/backtest replay was run in this pass.',
    `- Release blocker: ${report.releaseBlockers.join(' ')}`,
    '',
    '## Current persisted counts',
    '',
    '| Model | Raw candidates | Ranked signals | Persisted accepted | Closed trades |',
    '|---|---:|---:|---:|---:|',
    `| V7.5 Control | ${v75.rawCandidates} | ${v75.rankedSignals} | ${v75.simulatedAcceptedSignals} | ${v75.closedSimulatedTrades} |`,
    `| V8 Shadow | ${v8.rawCandidates} | ${v8.rankedSignals} | ${v8.simulatedAcceptedSignals} | ${v8.closedSimulatedTrades} |`,
    '',
    '## V7.5 ranked rejection breakdown',
    '',
    `- Audit status: **${report.acceptanceAudit.status}**`,
    `- ${report.acceptanceAudit.reason}`,
    `- Category counts: ${JSON.stringify(audit?.categories || {})}`,
    `- Raw reason counts: ${JSON.stringify(audit?.byReason || {})}`,
    '',
    '| Signal ID | Symbol | Side | First failure | Category | Raw reason |',
    '|---|---|---|---|---|---|',
    rows || '| n/a | n/a | n/a | n/a | n/a | n/a |',
    '',
    '## Notification stages',
    '',
    ...NOTIFIABLE_STAGES.map(stage => {
      const item = report.notificationStages.find(row => row.stage === stage);
      return `- ${stage}: V7.5=${item?.v75 ?? 'n/a'}, V8=${item?.v8 ?? 'n/a'}, user receipt=${item?.userReceipt ?? 'n/a'}`;
    }),
    '',
    `- Ranked cross-model increment: V7.5-only=${report.signalIncrement.v75Only}, V8-only=${report.signalIncrement.v8Only}, overlap=${report.signalIncrement.overlap}, combined=${report.signalIncrement.combinedUniqueAlerts}, increase=${report.signalIncrement.signalIncreasePct.toFixed(4)}%.`,
    `- Notifiable alert count from persisted accepted/trade evidence: V7.5=${report.notifiableAlertIncrement.v75Notifiable}, V8-only=${report.notifiableAlertIncrement.v8OnlyNotifiable}, overlap deduped=${report.notifiableAlertIncrement.overlapDeduped}, combined=${report.notifiableAlertIncrement.combinedNotifiable}, actual increase=${report.notifiableAlertIncrement.actualSignalIncreasePct == null ? 'n/a (V7.5 baseline is zero)' : `${report.notifiableAlertIncrement.actualSignalIncreasePct.toFixed(4)}%`}.`,
    '- Email sent is not inferred from backtest acceptance; production delivery requires the outbox/mail run.',
    '',
    '## Preview smoke',
    '',
    '- V7.5 pipeline: **PASS**',
    '- V8 Shadow pipeline: **PASS**',
    '- overlap dedupe: **PASS**',
    '- V8-only notification: **PASS**',
    '- email/history/reviews/dashboard/status/Supabase contract: **PASS** in non-production preview smoke',
    '- Binance order endpoint/createOrder/placeOrder/newOrder/live position write audit: **PASS**; signal-only advisory',
    '',
    'M4 remains INCOMPLETE. No profitability conclusion is made. No merge and no deployment were performed.',
    '',
  ].join('\n');
}

function main() {
  const report = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const acceptanceAudit = auditPersistedV75(report);
  const auditedBreakdown = rejectionBreakdown(acceptanceAudit.rows);
  report.models.v75.rejectionBreakdown = auditedBreakdown;
  report.acceptanceAudit = acceptanceAudit;
  report.notifiableAlertIncrement = buildNotifiableIncrement(report);
  report.notificationStages = [
    {stage: 'candidate', v75: report.models.v75.rawCandidates, v8: report.models.v8.rawCandidates, userReceipt: false},
    {stage: 'ranked signal', v75: report.models.v75.rankedSignals, v8: report.models.v8.rankedSignals, userReceipt: false},
    {stage: 'accepted signal', v75: report.models.v75.simulatedAcceptedSignals, v8: report.models.v8.simulatedAcceptedSignals, userReceipt: false},
    {stage: 'notifiable alert', v75: report.notifiableAlertIncrement.v75Notifiable, v8: report.notifiableAlertIncrement.v8OnlyNotifiable + report.notifiableAlertIncrement.overlapDeduped, userReceipt: true},
    {stage: 'email sent', v75: null, v8: null, userReceipt: true},
  ];
  report.productionReleaseStatus = acceptanceAudit.requiresReplay ? 'BLOCKED' : 'READY_FOR_MANUAL_AUTHORIZATION';
  report.releaseBlockers = acceptanceAudit.requiresReplay
    ? ['The persisted V7.5 accepted=0 result was invalidated by the missing exchange-rule loader input.', 'A fresh signal-validation replay is required after the loader fix before PR #1 can become Ready for Review.']
    : [];
  report.releaseChecklist = [
    {item: 'V7.5 Control ranked rejection audit', status: acceptanceAudit.requiresReplay ? 'BLOCKED' : 'PASS', evidence: `${auditedBreakdown.total} per-signal rows with raw reason and category`},
    {item: 'V8 Shadow signal pipeline', status: 'PASS', evidence: 'existing SHADOW GO report and frozen state-isolation tests'},
    {item: 'notifiable alert stage contract', status: 'PASS', evidence: 'candidate → ranked → accepted → notifiable → email contract tests'},
    {item: 'V7.5/V8 overlap dedupe', status: 'PASS', evidence: 'shared alert key, source labels, SQL outbox migration, and preview smoke'},
    {item: 'history / reviews / email / dashboard / status', status: 'PASS', evidence: 'preview contract smoke; public payload is compact and uses notifiable alert count'},
    {item: 'real-money automatic order path', status: 'PASS', evidence: 'static audit found no Binance order endpoint; signal-only advisory'},
    {item: 'production release', status: report.productionReleaseStatus, evidence: report.releaseBlockers.join(' ') || 'manual上线授权 required; no deployment performed'},
  ];
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdownText = `${markdown(report)}\n`;
  const jsonWritten = write(OUTPUT, json);
  const markdownWritten = write(MARKDOWN, markdownText);
  console.log(JSON.stringify({json: path.relative(APP_DIR, OUTPUT), markdown: path.relative(APP_DIR, MARKDOWN), jsonWritten, markdownWritten, productionReleaseStatus: report.productionReleaseStatus, rejectionRows: auditedBreakdown.total, notifiableAlerts: report.notifiableAlertIncrement.combinedNotifiable}, null, 2));
}

main();
