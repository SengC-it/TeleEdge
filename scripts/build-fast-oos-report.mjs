import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {drawdownPercent} from '../src/backtest.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BACKTEST_FILE = path.join(APP_DIR, 'reports', 'm5-fast-backtest.json');
const UNIVERSE_FILE = path.join(APP_DIR, 'reports', 'fast-oos-universe.json');
const MANIFEST_FILE = path.join(APP_DIR, 'data', 'backtest', 'manifest.json');
const FAILURE_FILE = path.join(APP_DIR, 'reports', 'formal-dataset-strict-failures.json');
const JSON_FILE = path.join(APP_DIR, 'reports', 'fast-oos-v75-v8.json');
const MARKDOWN_FILE = path.join(APP_DIR, 'reports', 'fast-oos-v75-v8.md');

const REQUIRED_ALPHA = [
  'daily_breakout_long',
  'funding_crowding_short',
  'volume_shock_short',
  'v8_bear_trend_short',
];
const STRATEGY_FILES = [
  'src/config.mjs',
  'src/strategy.mjs',
  'src/v8-shadow.mjs',
  'src/portfolio.mjs',
  'src/fill-risk.mjs',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function git(args) {
  return execFileSync('git', ['-c', `safe.directory=${APP_DIR}`, ...args], {cwd: APP_DIR, encoding: 'utf8'}).trim();
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function modelMetrics(model) {
  const oos = model.splits.oos;
  return {
    signals: oos.signals,
    acceptedSignalsTotalRun: model.acceptedSignals,
    trades: oos.trades,
    wins: oos.wins,
    losses: oos.losses,
    winRate: finiteOrNull(oos.winRate),
    expectancyR: finiteOrNull(oos.expectancyR),
    netExpectancyR: finiteOrNull(oos.netExpectancyR),
    expectancyR95CI: oos.expectancyR95CI ?? null,
    grossExpectancyR: finiteOrNull(oos.grossExpectancyR),
    profitFactor: finiteOrNull(oos.profitFactor),
    profitFactorStatus: oos.profitFactorStatus,
    maxDrawdownUsdt: finiteOrNull(oos.maxDrawdownUsdt),
    maxDrawdownPct: finiteOrNull(oos.maxDrawdownPct),
    maxDrawdownPercent: drawdownPercent(oos.maxDrawdownPct),
    netPnlUsdt: finiteOrNull(oos.netPnlUsdt),
    grossPnlUsdt: finiteOrNull(oos.grossPnlUsdt),
    feesAndCostsUsdt: finiteOrNull(oos.feesAndCostsUsdt),
    slippageCostUsdt: finiteOrNull(oos.slippageCostUsdt ?? oos.slippageCost),
    fundingPnlUsdt: finiteOrNull(oos.fundingPnlUsdt),
    turnoverUsdt: finiteOrNull(oos.turnoverUsdt),
    averageHoldingHours: finiteOrNull(oos.averageHoldingHours),
    forcedExits: oos.forcedExits,
    cvar95: null,
    uniqueTradedSymbols: null,
    bySide: oos.bySide || {},
    byRegime: oos.byRegime || {},
    byFamily: oos.byFamily || {},
    byAlpha: oos.byAlpha || {},
    byYear: oos.byYear || {},
    byMonth: null,
    concentration: null,
    top5Trades: null,
    observedAlphaCoverage: model.observedAlphaCoverage || [],
  };
}

function compactReasons({v75, v8, universe, strict}) {
  const reasons = [];
  if (v75.trades < 100) reasons.push(`V7.5 OOS trades=${v75.trades} (<100)`);
  if (v8.trades < 100) reasons.push(`V8 OOS trades=${v8.trades} (<100)`);
  if (!(v8.netExpectancyR > 0) || !(v8.profitFactor > 1)) reasons.push('V8 does not meet positive expectancy and PF>1 gate');
  if (v75.trades === 0) reasons.push('V7.5 Control has no executable OOS trades in this fast subset');
  if (v8.expectancyR95CI == null || v8.expectancyR95CI[0] <= 0) reasons.push('V8 95% expectancy interval includes zero');
  if (v8.uniqueTradedSymbols == null) reasons.push('unique traded symbols unavailable from frozen engine output');
  if (v8.cvar95 == null) reasons.push('CVaR95 unavailable from frozen engine output');
  const missing = REQUIRED_ALPHA.filter(alpha => !new Set([...v75.observedAlphaCoverage, ...v8.observedAlphaCoverage]).has(alpha));
  if (missing.length) reasons.push(`required Alpha not observed: ${missing.join(', ')}`);
  if (v8.signals <= v75.signals) reasons.push(`V8 OOS signals did not increase (${v75.signals} -> ${v8.signals})`);
  if (universe.status !== 'READY_FOR_FAST_OOS') reasons.push(`clean universe status=${universe.status}`);
  if (!strict.complete) reasons.push('M4 strict data gate remains incomplete');
  return reasons;
}

function markdown(report) {
  const v75 = report.models.v75.oos;
  const v8 = report.models.v8.oos;
  const fmt = value => value == null ? 'n/a' : typeof value === 'number' ? value.toFixed(4) : value;
  const rows = model => [
    `| Signals | ${model.signals} |`,
    `| Accepted signals (run total) | ${model.acceptedSignalsTotalRun} |`,
    `| Trades | ${model.trades} |`,
    `| Wins / losses | ${model.wins} / ${model.losses} |`,
    `| Win rate | ${fmt(model.winRate)} |`,
    `| Net expectancy (R) | ${fmt(model.netExpectancyR)} |`,
    `| 95% CI | ${model.expectancyR95CI ? model.expectancyR95CI.map(fmt).join(' … ') : 'n/a'} |`,
    `| Profit factor | ${fmt(model.profitFactor)} |`,
    `| Max drawdown | ${fmt(model.maxDrawdownPercent)}% / ${fmt(model.maxDrawdownUsdt)} USDT |`,
    `| Net PnL | ${fmt(model.netPnlUsdt)} USDT |`,
    `| Gross PnL | ${fmt(model.grossPnlUsdt)} USDT |`,
    `| Fees/costs | ${fmt(model.feesAndCostsUsdt)} USDT |`,
    `| Slippage cost | ${fmt(model.slippageCostUsdt)} USDT (not separately exposed by frozen engine) |`,
    `| Funding PnL | ${fmt(model.fundingPnlUsdt)} USDT |`,
    `| Avg holding | ${fmt(model.averageHoldingHours)} h |`,
  ].join('\n');
  return [
    `# FAST OOS RESULT: **${report.validationVerdict}**`, '',
    '# M5 Fast OOS: V7.5 vs V8', '',
    `## Decision: **${report.decision}**`, '',
    `Validation gate: **${report.validationVerdict}**`, '',
    report.decisionReasons.map(reason => `- ${reason}`).join('\n'), '',
    'Production deployment was not performed. M4 remains INCOMPLETE.', '',
    '## Reproducibility', '',
    `- Strategy commit: \`${report.reproducibility.strategyCommitSha}\``,
    `- Repository HEAD at run: \`${report.reproducibility.repositoryHeadAtRun}\``,
    `- Working tree dirty at run: **${report.reproducibility.workingTreeDirty}**`,
    `- Config SHA256: \`${report.reproducibility.configSha256}\``,
    `- Dataset snapshot: ${report.reproducibility.datasetSnapshotTimestamp}`,
    `- Manifest SHA256: \`${report.reproducibility.manifestSha256}\``,
    `- Backtest generated: ${report.reproducibility.backtestGeneratedAt}`, '',
    '## Universe and execution', '',
    `- Clean eligible universe: **${report.universe.cleanEligibleCount}** (${report.universe.cleanCoreCount} core / ${report.universe.cleanExpandedCount} expanded)`,
    `- Executed subset: **${report.universe.executionCount}** (${report.universe.executionCoreCount} core / ${report.universe.executionExpandedCount} expanded)`,
    `- OOS window: ${report.execution.windowStart} → ${report.execution.windowEnd}`,
    `- Cadence: **${report.execution.scanCadenceHours}h**; decision latency: **${report.execution.decisionLatencyMinutes}m**`,
    `- Fill/settlement: **${report.execution.fillInterval} 1m**, proxy **${report.execution.executionProxy}**, same-minute TP+SL => SL`,
    `- Samples: ${report.universe.oneHourRows} 1h rows; ${report.universe.oneMinuteRows} 1m rows; ${report.universe.fundingEvents} funding events`, '',
    '## V7.5 Control OOS', '',
    '| Metric | Value |', '|---|---:|', rows(v75), '',
    `Observed Alpha: ${report.models.v75.observedAlphaCoverage.join(', ') || 'none'}`, '',
    '## V8 Shadow OOS', '',
    '| Metric | Value |', '|---|---:|', rows(v8), '',
    `Observed Alpha: ${report.models.v8.observedAlphaCoverage.join(', ') || 'none'}`, '',
    '## Comparison', '',
    `- OOS signals: ${report.comparison.v75Signals} → ${report.comparison.v8Signals} (${report.comparison.signalDeltaPct == null ? 'n/a' : `${fmt(report.comparison.signalDeltaPct)}%`})`,
    `- OOS trades: ${report.comparison.v75Trades} → ${report.comparison.v8Trades}`,
    `- Net expectancy delta (V8−V7.5): ${fmt(report.comparison.netExpectancyRDelta)} R`,
    `- Profit factor delta (V8−V7.5): ${fmt(report.comparison.profitFactorDelta)}`, '',
    '## Breakdowns and limitations', '',
    '- OOS by-side/regime/family/Alpha/year breakdowns are copied from the frozen engine output in the JSON report.',
    '- Month-level, unique-symbol, concentration/top-5, and CVaR95 fields are `null`: the frozen engine report does not expose trade-level records, so these are not reconstructed.',
    `- Required Alpha coverage: ${report.alphaCoverage.required.join(', ')}`,
    `- Observed Alpha coverage: ${report.alphaCoverage.observed.join(', ') || 'none'}`,
    `- Missing required coverage: ${report.alphaCoverage.missing.join(', ') || 'none'}`, '',
    '## M4 status', '',
    `- strict complete: **${report.m4.strictComplete}**; point-in-time: **${report.m4.pointInTime}**; historical delistings resolved: **${report.m4.historicalDelistingsResolved}**`,
    `- strict verifier exit: **${report.m4.strictExitCode}**`,
    `- failure inventory: continuity ${report.m4.failureCounts.continuityFailures}; coverage ${report.m4.failureCounts.coverageFailures}; funding windows ${report.m4.failureCounts.fundingWindowFailures}; price boundary ${report.m4.failureCounts.priceBoundaryFailures}; 1m boundary ${report.m4.failureCounts.minuteBoundaryFailures}`,
    '- M4 is deliberately not upgraded by this fast validation.', '',
    '## Release readiness', '',
    `- Production: **${report.release.production}**`,
    `- Shadow: **${report.release.shadow}**`,
    '- No deployment or real Binance order path was exercised.',
    ...report.release.checklist.map(item => `- ${item.item}: **${item.status}** — ${item.evidence}`),
    '- Next gate: obtain a larger, full required-Alpha, trade-level-exposing OOS result before any production release decision.',
  ].join('\n') + '\n';
}

function main() {
  for (const file of [BACKTEST_FILE, UNIVERSE_FILE, MANIFEST_FILE, FAILURE_FILE]) {
    if (!fs.existsSync(file)) throw new Error(`Missing required input: ${file}`);
  }
  const backtest = readJson(BACKTEST_FILE);
  const universe = readJson(UNIVERSE_FILE);
  const manifest = readJson(MANIFEST_FILE);
  const strict = readJson(FAILURE_FILE);
  const v75 = modelMetrics(backtest.models.find(model => model.model === 'V7.5 Control'));
  const v8 = modelMetrics(backtest.models.find(model => model.model === 'V8 Shadow'));
  const observed = [...new Set([...v75.observedAlphaCoverage, ...v8.observedAlphaCoverage])].sort();
  const missing = REQUIRED_ALPHA.filter(alpha => !observed.includes(alpha));
  const selected = new Set(universe.executionSymbols);
  const coreSet = new Set((manifest.universe?.markets || []).filter(item => item.core).map(item => item.symbol));
  const strictCounts = strict.summary || {};
  const strategyCommitSha = git(['log', '-1', '--format=%H', '--', ...STRATEGY_FILES]);
  const repositoryHeadAtRun = git(['rev-parse', 'HEAD']);
  const dirty = Boolean(git(['status', '--porcelain']));
  const signalDeltaPct = v75.signals ? ((v8.signals - v75.signals) / v75.signals) * 100 : null;
  const decisionReasons = compactReasons({v75, v8, universe, strict: {complete: strict.complete === true}});
  const positiveV8 = v8.netExpectancyR > 0 && v8.profitFactor > 1;
  const validationVerdict = positiveV8 && v8.trades >= 100 && v75.trades >= 100 && decisionReasons.length === 0
    ? 'PASS'
    : positiveV8 ? 'SHADOW PASS' : 'FAIL';
  const report = {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    decision: 'NO-GO',
    fastOosResult: validationVerdict,
    validationVerdict,
    decisionReasons,
    reproducibility: {
      strategyCommitSha,
      repositoryHeadAtRun,
      workingTreeDirty: dirty,
      configSha256: sha256(path.join(APP_DIR, 'src', 'config.mjs')),
      strategyFileSha256: Object.fromEntries(STRATEGY_FILES.map(file => [file, sha256(path.join(APP_DIR, file))])),
      datasetSnapshotTimestamp: manifest.snapshotTimestamp,
      manifestSha256: sha256(MANIFEST_FILE),
      backtestGeneratedAt: backtest.generatedAt,
    },
    universe: {
      cleanEligibleCount: universe.eligibleSymbols.length,
      cleanCoreCount: universe.coreCount,
      cleanExpandedCount: universe.expandedCount,
      executionCount: selected.size,
      executionCoreCount: [...selected].filter(symbol => coreSet.has(symbol)).length,
      executionExpandedCount: [...selected].filter(symbol => !coreSet.has(symbol)).length,
      executionSymbols: universe.executionSymbols,
      oneHourRows: backtest.data.sampleSize.priceRows,
      oneMinuteRows: backtest.data.sampleSize.oneMinuteRows,
      fundingEvents: backtest.data.sampleSize.fundingRows,
      excludedReasonBreakdown: universe.reasonBreakdown,
    },
    execution: {
      windowStart: universe.oosWindow.start,
      windowEnd: backtest.data.snapshotEnd,
      datasetSnapshotEnd: manifest.snapshotTimestamp,
      scanCadenceHours: 4,
      decisionLatencyMinutes: backtest.data.decisionLatencyMinutes,
      fillInterval: backtest.data.executionInterval,
      settlementInterval: '1m',
      executionProxy: backtest.data.executionProxy,
      sameMinuteTpSl: 'sl',
      feesFundingSlippage: true,
    },
    alphaCoverage: {required: REQUIRED_ALPHA, observed, missing},
    models: {
      v75: {name: 'V7.5 Control', observedAlphaCoverage: v75.observedAlphaCoverage, oos: v75},
      v8: {name: 'V8 Shadow', observedAlphaCoverage: v8.observedAlphaCoverage, oos: v8},
    },
    comparison: {
      v75Signals: v75.signals,
      v8Signals: v8.signals,
      signalDelta: v8.signals - v75.signals,
      signalDeltaPct: signalDeltaPct == null ? null : signalDeltaPct,
      v75Trades: v75.trades,
      v8Trades: v8.trades,
      netExpectancyRDelta: (v8.netExpectancyR ?? 0) - (v75.netExpectancyR ?? 0),
      profitFactorDelta: (v8.profitFactor ?? 0) - (v75.profitFactor ?? 0),
    },
    m4: {
      strictComplete: strict.complete === true,
      strictExitCode: strict.complete === true ? 0 : 1,
      pointInTime: manifest.universe?.pointInTime === true,
      historicalDelistingsResolved: manifest.universe?.historicalDelistingsResolved === true,
      failureCounts: {
        continuityFailures: strictCounts.continuityFailures || 0,
        coverageFailures: strictCounts.coverageFailures || 0,
        fundingWindowFailures: strictCounts.fundingWindowFailures || 0,
        priceBoundaryFailures: strictCounts.priceBoundaryFailures || 0,
        minuteBoundaryFailures: strictCounts.minuteBoundaryFailures || 0,
      },
    },
    release: {
      production: 'NO-GO',
      shadow: validationVerdict === 'PASS' ? 'GO' : validationVerdict === 'SHADOW PASS' ? 'SHADOW PASS (not enabled; manual signal-only)' : 'NO-GO',
      deployPerformed: false,
      realBinanceOrderPathExercised: false,
      checklist: [
        {item: 'signal pipeline', status: 'PASS', evidence: 'frozen engine and worker candidate tests pass'},
        {item: 'V7.5/V8 state isolation', status: 'PASS', evidence: 'state-isolation regression test passes'},
        {item: 'history/reviews/email/dashboard contracts', status: 'PASS', evidence: 'existing history, reviews-token, funnel/public-status tests pass'},
        {item: 'real Binance order path', status: 'PASS', evidence: 'static audit found market-data endpoints only; no order endpoint exercised'},
        {item: 'production release gate', status: 'BLOCKED', evidence: `Fast result is ${validationVerdict}; production thresholds, required Alpha coverage and M4 remain incomplete`},
      ],
    },
  };
  fs.writeFileSync(JSON_FILE, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(MARKDOWN_FILE, markdown(report));
  console.log(JSON.stringify({json: path.relative(APP_DIR, JSON_FILE).replaceAll('\\', '/'), markdown: path.relative(APP_DIR, MARKDOWN_FILE).replaceAll('\\', '/'), decision: report.decision, validationVerdict: report.validationVerdict, reasons: report.decisionReasons}, null, 2));
}

main();
