import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {APP_DIR, DAY} from '../src/config.mjs';
import {RESEARCH_ALPHA_IDS} from '../src/v81/alpha-registry.mjs';
import {breakdownMetrics, calculateResearchMetrics, alphaAttribution} from '../src/v81/metrics.mjs';
import {researchConfig, runDevelopmentReplay} from '../src/v81/replay.mjs';

const defaultStart = Date.parse('2025-01-01T00:00:00Z');
const defaultEnd = Date.parse('2026-01-01T00:00:00Z');

function cliValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function dateValue(value, fallback) {
  if (value == null) return fallback;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: APP_DIR, encoding: 'utf8'}).trim();
  } catch {
    return 'uncommitted-working-tree';
  }
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value, null, 2) + '\n').digest('hex');
}

function pct(value) {
  return value == null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(2)}%`;
}

function metricValue(value, digits = 3) {
  return value == null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

function markdownReport(report) {
  const rows = Object.entries(report.monthlyFrequency.months).map(([month, row]) => `| ${month} | ${row.research} | ${row.qualified} | ${row.highConfidence} | ${row.uniqueAlerts} | ${row.long} | ${row.short} |`).join('\n');
  const alphaRows = Object.entries(report.alphaAttribution).map(([alpha, row]) => `| ${alpha} | ${row.observations} | ${row.qualified} | ${row.trades} | ${metricValue(row.expectancyR)} | ${metricValue(row.profitFactor)} | ${row.status} |`).join('\n');
  return `# V8.1 Development Research Replay

Status: **${report.gate.decision}**. This is a paper/simulation research artifact only.

## Boundary and execution

- Development: ${new Date(report.boundary.start).toISOString()} through ${new Date(report.boundary.end).toISOString()} (end exclusive)
- Scan cadence: ${report.execution.scanCadenceHours}h
- Decision latency: ${report.execution.decisionLatencyMinutes} minutes
- Fill/settlement: completed 1m data, first executable minute, same-minute TP+SL => SL
- Execution proxy: ${report.execution.executionProxy}
- Holdout: **NOT RUN** (${new Date(report.holdout.start).toISOString()} through ${new Date(report.holdout.end).toISOString()})

## Universe

- Source: ${report.universe.source}
- Mode: ${report.universe.mode}
- Symbols: ${report.universe.symbols} (${report.universe.core} core / ${report.universe.expanded} expanded)
- Processed partitions: ${report.universe.processed}

## Counts

- Research observations: ${report.counts.researchObservations} (${metricValue(report.monthlyFrequency.research.mean)} / month mean; ${metricValue(report.monthlyFrequency.research.median)} median)
- Qualified alerts: ${report.counts.qualified} (${metricValue(report.monthlyFrequency.qualified.mean)} / month mean; ${metricValue(report.monthlyFrequency.qualified.median)} median)
- High confidence: ${report.counts.highConfidence} (${metricValue(report.monthlyFrequency.highConfidence.mean)} / month mean)

## Monthly frequency

| Month | Research | Qualified | High confidence | Unique alerts | Long | Short |
|---|---:|---:|---:|---:|---:|---:|
${rows}

## Portfolio metrics

| Metric | Value |
|---|---:|
| Trades | ${report.metrics.trades} |
| Win rate | ${pct(report.metrics.winRate)} |
| Profit factor | ${metricValue(report.metrics.profitFactor)} |
| Expectancy (R) | ${metricValue(report.metrics.expectancyR)} |
| Net PnL (USDT) | ${metricValue(report.metrics.netPnlUsdt, 2)} |
| Net return | ${pct(report.metrics.netReturn)} |
| Max drawdown (USDT) | ${metricValue(report.metrics.maxDrawdownUsdt, 2)} |
| Max drawdown | ${pct(report.metrics.maxDrawdownPct)} |
| Unique symbols | ${report.metrics.uniqueSymbols} |

## Alpha attribution

| Alpha | Observations | Qualified | Trades | Expectancy R | PF | Status |
|---|---:|---:|---:|---:|---:|---|
${alphaRows}

## Gate and limitations

- Development gate: **${report.gate.decision}**
- Positive alpha families with sufficient sample: ${report.gate.positiveAlphaFamilies}
- Frozen config SHA256: ${report.frozenConfigSha256}
- Baseline V7.5/V8 semantics remain frozen; this phase does not rewrite or deploy them.
- Survivorship, lifecycle, and strict artifact limitations are inherited from the verified clean-eligible input manifest; this report does not upgrade M4 to complete.
- Results are not a profitability conclusion and must not be used as Holdout evidence.
`;
}

async function main() {
  const start = dateValue(cliValue('--start', null), defaultStart);
  const end = dateValue(cliValue('--end', null), defaultEnd);
  if (start !== defaultStart || end !== defaultEnd) throw new Error('V8.1 Development boundary is locked to 2025-01-01 through 2025-12-31');
  const dataRoot = path.resolve(cliValue('--data-root', process.env.V81_DATA_ROOT || path.join(APP_DIR, 'data', 'backtest')));
  const outputDir = path.resolve(cliValue('--output-dir', path.join(APP_DIR, 'data', 'v81-development')));
  const resume = process.argv.includes('--resume');
  const maxSymbols = Number(cliValue('--max-symbols', process.env.V81_MAX_SYMBOLS || 0)) || 0;
  const replay = await runDevelopmentReplay({dataRoot, appDir: APP_DIR, start, end, outputDir, resume, maxSymbols});
  const trades = replay.portfolio.closedTrades;
  const options = {initialEquity: 10_000, start, end};
  const metrics = calculateResearchMetrics(trades, replay.observations, options);
  const alpha = alphaAttribution(RESEARCH_ALPHA_IDS, replay.observations, trades, options);
  const bySide = breakdownMetrics(trades, row => row.side || 'unknown', options);
  const byRegime = breakdownMetrics(trades, row => row.regime || 'unknown', options);
  const positiveAlphaFamilies = Object.values(alpha).filter(row => row.trades >= 3 && Number(row.expectancyR) > 0).length;
  const gateChecks = {
    researchMean: replay.frequency.research.mean >= 30,
    qualifiedMean: replay.frequency.qualified.mean >= 10,
    positiveAlphaFamilies: positiveAlphaFamilies >= 3,
    portfolioProfitFactor: Number(metrics.profitFactor) >= 1.5,
    portfolioExpectancy: Number(metrics.expectancyR) >= 0.20,
    drawdown: Number(metrics.maxDrawdownPct) <= 0.05,
    symbolBreadth: Number(metrics.uniqueSymbols) >= 25,
    noExecutionProxy: true,
  };
  const gate = {decision: Object.values(gateChecks).every(Boolean) ? 'GO_TO_HOLDOUT' : 'RESEARCH_FAIL', checks: gateChecks, positiveAlphaFamilies};
  const config = researchConfig({start, end, sourceManifestSha256: replay.sourceManifestSha256, universeCount: replay.universe.symbols.length, universeMode: replay.universe.selectionMode, requestedUniverseCount: replay.universe.requestedSymbols});
  config.codeSha = gitSha();
  const frozenConfigSha256 = hashJson(config);
  const reportsDir = path.resolve(cliValue('--reports-dir', path.join(APP_DIR, 'reports')));
  fs.mkdirSync(reportsDir, {recursive: true});
  const report = {
    reportVersion: 'v81-development-1',
    status: 'DEVELOPMENT_ONLY',
    generatedAt: new Date().toISOString(),
    engine: {version: 'V8.1-research-1', codeSha: config.codeSha, researchOnly: true},
    boundary: {start, end, durationDays: (end - start) / DAY},
    holdout: {status: 'NOT RUN', start: Date.parse('2026-01-01T00:00:00Z'), end: Date.parse('2026-07-15T00:00:00Z')},
    universe: {source: replay.universe.source, mode: replay.universe.selectionMode, requested: replay.universe.requestedSymbols, symbols: replay.universe.symbols.length, core: replay.universe.symbols.filter(symbol => replay.universe.markets.get(symbol).core).length, expanded: replay.universe.symbols.filter(symbol => !replay.universe.markets.get(symbol).core).length, processed: replay.processedSymbols, btcContextRows: replay.btcContext.rows, btcContextPoints: replay.btcContext.points},
    execution: {scanCadenceHours: 4, decisionLatencyMinutes: 20, fillInterval: '1m', settlementInterval: '1m', executionProxy: false, sameMinuteTpSl: 'sl', feesFundingModeled: true},
    counts: {researchObservations: replay.observations.total, qualified: replay.frequency.qualified.mean * (end - start) / (DAY * 30.4375), highConfidence: replay.frequency.highConfidence.mean * (end - start) / (DAY * 30.4375), accepted: replay.portfolio.accepted.length, rejected: replay.portfolio.rejected.length, trades: trades.length, uniqueAlerts: Object.values(replay.monthly).reduce((sum, row) => sum + row.uniqueAlerts, 0)},
    monthlyFrequency: replay.frequency,
    metrics,
    breakdowns: {bySide, byRegime},
    alphaAttribution: alpha,
    gate,
    frozenConfigSha256,
    dataIntegrity: {sourceManifestSha256: replay.sourceManifestSha256, artifacts: 'existing verified manifest; raw partitions are local and ignored', researchArtifactDir: 'data/v81-development'},
    baselineAnchors: {v75: 'V7.5 CONTROL frozen; not changed', v8: 'V8 SHADOW / EXPERIMENTAL frozen; anchor metadata only in this replay'},
    knownLimitations: ['M4 strict formal dataset remains a separate gate and is not upgraded by Development replay.', 'V7.5/V8 production semantics are not recalibrated or modified.', 'No final Holdout was run.', 'Portfolio results are paper simulation, not a deployment or profitability conclusion.'],
  };
  report.counts.qualified = Object.values(replay.monthly).reduce((sum, row) => sum + row.qualified, 0);
  report.counts.highConfidence = Object.values(replay.monthly).reduce((sum, row) => sum + row.highConfidence, 0);
  writeJson(path.join(reportsDir, 'v81-frozen-config.json'), config);
  writeJson(path.join(reportsDir, 'v81-holdout-lock.json'), {status: 'HOLDOUT_NOT_RUN', lockedAt: new Date().toISOString(), holdout: report.holdout, frozenConfigSha256, codeSha: config.codeSha});
  writeJson(path.join(reportsDir, 'v81-development.json'), report);
  fs.writeFileSync(path.join(reportsDir, 'v81-development.md'), markdownReport(report), 'utf8');
  console.log(JSON.stringify({status: report.status, gate: gate.decision, universe: report.universe, counts: report.counts, metrics: {trades: metrics.trades, winRate: metrics.winRate, profitFactor: metrics.profitFactor, expectancyR: metrics.expectancyR, netPnlUsdt: metrics.netPnlUsdt, maxDrawdownPct: metrics.maxDrawdownPct}, frozenConfigSha256, holdout: 'NOT RUN'}, null, 2));
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/run-v81-development.mjs')) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
