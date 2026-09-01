import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {APP_DIR, DAY, H1} from '../src/config.mjs';
import {runBacktest} from './backtest.mjs';
import {createV9DataAccess, createV9OutcomeDataAccess, runV9Replay, mergeV9RankedWithBaseline} from '../src/v9/replay.mjs';
import {V9_ALPHA_IDS, V9_SCORECARD} from '../src/v9/registry.mjs';
import {calculateResearchMetrics, breakdownMetrics, alphaAttribution, createMonthlyFrequency, frequencySummary, recordMonthlyObservation, validateTierMonotonicity} from '../src/v81/metrics.mjs';
import {mergeResearchCandidates, rankResearchCandidates} from '../src/v81/dedupe.mjs';
import {simulatePortfolio} from '../src/v81/portfolio.mjs';
import {runPurgedWalkForward, PURGE_DURATION_MS} from '../src/v81/walk-forward.mjs';
import {jsonSha256, strategyTreeSha256} from '../src/v81/provenance.mjs';

const DEFAULT_START = Date.parse('2024-01-01T00:00:00Z');
const DEFAULT_END = Date.parse('2026-01-01T00:00:00Z');
const HOLDOUT_START = Date.parse('2026-01-01T00:00:00Z');
const HOLDOUT_END = Date.parse('2026-07-15T00:00:00Z');

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

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, value, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function gitSha() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: APP_DIR, encoding: 'utf8'}).trim(); } catch { return 'uncommitted-working-tree'; }
}

function hashFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    if (!fs.existsSync(file)) continue;
    hash.update(path.relative(APP_DIR, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function number(value, digits = 4) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(Number(value).toFixed(digits));
}

function pct(value) { return value == null || !Number.isFinite(Number(value)) ? null : number(Number(value) * 100, 3); }

function baselineCandidate(event, modelName, index) {
  const marketId = event.marketId || event.symbol;
  const signalTime = Number(event.signalTime ?? event.t);
  const alpha = event.alpha || event.family || (modelName === 'V7.5 Control' ? 'v75_control' : 'v8_shadow');
  return {
    id: event.id || `${modelName}|${marketId}|${event.side}|${signalTime}|${index}`,
    modelVersion: event.model || modelName, alpha, alphaSources: [alpha], family: event.family || alpha,
    marketId, symbol: event.symbol || marketId, side: event.side, t: signalTime, signalTime,
    signalPrice: event.signalPrice ?? event.entry, entry: event.signalPrice ?? event.entry, sl: event.stop ?? event.sl,
    stopPct: event.stopPct, targetR: event.targetR, target: event.target, edgeScore: event.edgeScore,
    eventScore: event.eventScore, dayVolume: event.dayVolume, core: Boolean(event.core),
    regime: event.regime || event.btcRouter || 'unknown', btcRouter: event.btcRouter || event.regime || 'unknown',
    features: {regime: event.regime || event.btcRouter || 'unknown', btcRegime: event.btcRouter || event.regime || 'unknown'},
  };
}

function baselineRows(model, name) {
  return (model?.signalEvents || []).map((event, index) => baselineCandidate(event, name, index));
}

function foldList(start, end) {
  const result = [];
  let validationStart = new Date(start);
  validationStart.setUTCMonth(validationStart.getUTCMonth() + 6);
  validationStart.setUTCDate(1);
  while (validationStart.getTime() < end) {
    const next = new Date(validationStart);
    next.setUTCMonth(next.getUTCMonth() + 3);
    result.push({
      id: `v9-${result.length + 1}`,
      trainStart: start, trainEnd: validationStart.getTime(),
      validationStart: validationStart.getTime(), validationEnd: Math.min(end, next.getTime()),
    });
    validationStart = next;
  }
  return result.filter(fold => fold.validationStart < fold.validationEnd);
}

function monthlyRows(start, end, rows, field) {
  const monthly = createMonthlyFrequency(start, end);
  for (const row of rows || []) recordMonthlyObservation(monthly, {t: row.signalTime ?? row.t, side: row.side, alpha: row.alpha, regime: row.regime || row.btcRouter}, field);
  return monthly;
}

function addMonthly(monthly, rows, field) {
  for (const row of rows || []) recordMonthlyObservation(monthly, {t: row.signalTime ?? row.t, side: row.side, alpha: row.alpha, regime: row.regime || row.btcRouter}, field);
}

function standaloneAlphaReport(alpha, observations, outcomes, options) {
  const observed = observations.filter(row => row.alpha === alpha);
  const executable = outcomes.filter(row => row.alpha === alpha && row.executable);
  const metrics = calculateResearchMetrics(executable, observed, options);
  return {
    alpha, observations: observed.length, executableOutcomes: executable.length,
    uniqueSymbols: new Set(executable.map(row => row.marketId || row.symbol)).size, metrics,
    bySide: breakdownMetrics(executable, row => row.side || 'unknown', options),
    byRegime: breakdownMetrics(executable, row => row.regime || row.btcRouter || 'unknown', options),
  };
}

function alphaStatus(row) {
  return row?.status || row?.qualifiedStatus || 'WATCH';
}

function classifyV9Alpha(row) {
  const metrics = row?.qualifiedOofExecutable || {};
  const sample = Number(metrics.sample || 0);
  const uniqueSymbols = Number(metrics.uniqueSymbols || 0);
  const netPnlUsdt = Number(metrics.netPnlUsdt || 0);
  const profitFactor = Number(metrics.profitFactor);
  const expectancyR = Number(metrics.expectancyR);
  const lowerCi = Number(metrics.expectancyR95CI?.[0]);
  if (sample >= 30 && uniqueSymbols >= 10 && (netPnlUsdt <= 0 || expectancyR <= 0 || profitFactor < 1)) return 'REJECT';
  if (sample >= 30 && uniqueSymbols >= 10 && netPnlUsdt > 0 && profitFactor >= 1.3 && expectancyR >= 0.15 && lowerCi > 0) return 'KEEP';
  return 'WATCH';
}

function compareMetrics(trades, observations, start, end) {
  return calculateResearchMetrics(trades || [], observations || [], {initialEquity: 10_000, start, end});
}

function modelComparison(baseline, v9Metrics, combinedMetrics) {
  const output = {};
  for (const name of ['V7.5 Control', 'V8 Shadow']) {
    const model = baseline?.models?.find(item => item.model === name);
    const metrics = model?.full || {};
    const tradeRows = Array.isArray(model?.trades) ? model.trades : [];
    output[name] = {
      rankedSignals: model?.rankedSignalCount || model?.signalEvents?.length || 0,
      acceptedSignals: model?.acceptedSignalCount || model?.acceptedSignals || 0,
      trades: metrics.trades || 0, netPnlUsdt: metrics.netPnlUsdt ?? null,
      expectancyR: metrics.netExpectancyR ?? metrics.expectancyR ?? null,
      profitFactor: metrics.profitFactor ?? null, maxDrawdownPct: metrics.maxDrawdownPct ?? null,
      uniqueSymbols: metrics.uniqueSymbols ?? new Set(tradeRows.map(row => row.marketId || row.symbol)).size,
    };
  }
  output.V9 = {rankedSignals: v9Metrics.rankedSignals, acceptedSignals: v9Metrics.acceptedSignals, trades: v9Metrics.trades, netPnlUsdt: v9Metrics.netPnlUsdt, expectancyR: v9Metrics.expectancyR, profitFactor: v9Metrics.profitFactor, maxDrawdownPct: v9Metrics.maxDrawdownPct, uniqueSymbols: v9Metrics.uniqueSymbols};
  output['V8+V9'] = {rankedSignals: combinedMetrics.rankedSignals, acceptedSignals: combinedMetrics.acceptedSignals, trades: combinedMetrics.trades, netPnlUsdt: combinedMetrics.netPnlUsdt, expectancyR: combinedMetrics.expectancyR, profitFactor: combinedMetrics.profitFactor, maxDrawdownPct: combinedMetrics.maxDrawdownPct, uniqueSymbols: combinedMetrics.uniqueSymbols};
  return output;
}

function positiveMonths(metrics) {
  const months = Object.values(metrics?.monthlyPnl || {});
  return months.length ? months.filter(value => Number(value) > 0).length / months.length : null;
}

function concentration(trades) {
  const total = Math.abs((trades || []).reduce((sum, row) => sum + (Number(row.netPnlUsdt) || 0), 0));
  if (!(total > 0)) return null;
  const bySymbol = new Map();
  for (const trade of trades || []) bySymbol.set(trade.marketId || trade.symbol, (bySymbol.get(trade.marketId || trade.symbol) || 0) + (Number(trade.netPnlUsdt) || 0));
  return Math.max(...[...bySymbol.values()].map(value => Math.abs(value))) / total;
}

function gateReport({oofAlpha, oofQualifiedExecutable, rankedCandidates, candidateMetrics, v8Metrics, tierMonotonicity, walkForward, executionProxy, noOrderAudit, keepAlphaIds, trades, usableMetricsSymbols = 0, qualifiedExecutableFrequency = 0}) {
  const monthly = Object.values(candidateMetrics.monthlyPnl || {});
  const concentrationValue = concentration(trades);
  const checks = {
    independentKeepAtLeast2: keepAlphaIds.length >= 2,
    usableMetricsSymbolsAtLeast100: usableMetricsSymbols >= 100,
    oofQualifiedExecutableAtLeast100: oofQualifiedExecutable.length >= 100,
    qualifiedExecutableFrequencyAtLeast8PerMonth: qualifiedExecutableFrequency >= 8,
    candidatePortfolioTradesAtLeast60: candidateMetrics.trades >= 60,
    candidatePortfolioSymbolsAtLeast30: candidateMetrics.uniqueSymbols >= 30,
    candidatePortfolioProfitFactorAtLeast150: Number(candidateMetrics.profitFactor) >= 1.5,
    candidatePortfolioExpectancyAtLeast020: Number(candidateMetrics.expectancyR) >= 0.2,
    candidatePortfolioNetPnlPositive: Number(candidateMetrics.netPnlUsdt) > 0,
    candidatePortfolioReturnPreferred5Pct: Number(candidateMetrics.netReturn) >= 0.05,
    drawdownAtMost6Pct: Number(candidateMetrics.maxDrawdownPct) <= 0.06,
    positiveMonthsAtLeast60Pct: Number(positiveMonths(candidateMetrics)) >= 0.6,
    concentrationAtMost25Pct: concentrationValue != null && concentrationValue <= 0.25,
    tierMonotonicity: Boolean(tierMonotonicity?.sufficientSample && tierMonotonicity?.valid),
    v9CandidateBeatsFrozenV8: Number(candidateMetrics.netPnlUsdt) > Number(v8Metrics.netPnlUsdt),
    purgeChecks: Boolean(walkForward.checks.timeOrdered && walkForward.checks.purgeEnforced && walkForward.checks.labelOverlapFree && walkForward.checks.validationFrozen),
    executionProxyDisabled: executionProxy === false,
    noOrderAudit: noOrderAudit === true,
  };
  return {decision: Object.values(checks).every(Boolean) ? 'RESEARCH_READY_FOR_FUTURE_HOLDOUT' : 'RESEARCH_FAIL', checks, keepAlphaIds, oofAlpha: Object.fromEntries(V9_ALPHA_IDS.map(alpha => [alpha, {status: alphaStatus(oofAlpha[alpha]), qualifiedExecutable: oofAlpha[alpha]?.qualifiedOofExecutable?.sample || 0}]))};
}

function compactMetrics(metrics) {
  return {
    trades: metrics?.trades || 0, wins: metrics?.wins || 0, losses: metrics?.losses || 0,
    uniqueSymbols: metrics?.uniqueSymbols || 0, netPnlUsdt: number(metrics?.netPnlUsdt, 4), netReturn: number(metrics?.netReturn, 6),
    expectancyR: number(metrics?.expectancyR ?? metrics?.netExpectancyR, 6), profitFactor: number(metrics?.profitFactor, 6),
    maxDrawdownUsdt: number(metrics?.maxDrawdownUsdt, 4), maxDrawdownPct: number(metrics?.maxDrawdownPct, 6),
    winRate: number(metrics?.winRate, 6), expectancyR95CI: metrics?.expectancyR95CI || null, monthlyPnl: metrics?.monthlyPnl || {},
  };
}

function markdown(report) {
  const alphaRows = Object.values(report.alphaStandalone).map(row => `| ${row.alpha} | ${row.observations} | ${row.executableOutcomes} | ${row.uniqueSymbols} | ${row.metrics.trades} | ${row.metrics.netPnlUsdt ?? '—'} | ${row.metrics.expectancyR ?? '—'} | ${row.metrics.profitFactor ?? '—'} |`).join('\n');
  const oofRows = Object.entries(report.alphaOof).map(([alpha, row]) => `| ${alpha} | ${row.status} | ${row.qualifiedOofExecutable?.sample ?? 0} | ${row.qualifiedOofExecutable?.expectancyR ?? '—'} | ${row.qualifiedOofExecutable?.profitFactor ?? '—'} |`).join('\n');
  const comparisonRows = [...Object.entries(report.modelComparison), ['V9 standalone (non-portfolio)', {...report.v9Standalone, rankedSignals: report.v9Standalone.independentObservations, acceptedSignals: report.v9Standalone.executableOutcomes}]].map(([name, row]) => `| ${name} | ${row.rankedSignals} | ${row.acceptedSignals} | ${row.trades} | ${row.netPnlUsdt ?? '—'} | ${row.expectancyR ?? '—'} | ${row.profitFactor ?? '—'} | ${row.maxDrawdownPct ?? '—'} |`).join('\n');
  const gateRows = Object.entries(report.gate.checks).map(([key, value]) => `| ${key} | ${value ? 'PASS' : 'FAIL'} |`).join('\n');
  return `# TeleEdge V9 Multi-Factor Derivatives Research\n\nStatus: **${report.status}**. Research-only Development package; no V8.1 Holdout and no Production change.\n\n## Boundary and provenance\n\n- Development: ${report.boundary.start} → ${report.boundary.end} (end exclusive)\n- Holdout: **NOT RUN** (${report.holdout.start} → ${report.holdout.end})\n- Scan: ${report.execution.scanCadenceHours}h; decision latency: ${report.execution.decisionLatencyMinutes}m; fill/settlement: ${report.execution.fillInterval} / ${report.execution.settlementInterval}; proxy=${report.execution.executionProxy}\n- Universe: ${report.universe.selected} selected (${report.universe.core} core / ${report.universe.expanded} expanded), hash ${report.universe.symbolsHash}\n- M4: **${report.dataIntegrity.m4Status}**\n- No-order audit: ${report.noOrderAudit}\n- Strategy tree SHA256: ${report.provenance.strategyTreeSha256}; V9 code SHA256: ${report.provenance.v9CodeSha256}; data manifest SHA256: ${report.provenance.datasetManifestSha256}\n\n## Data availability\n\n${report.dataAvailability.map(row => `- ${row.name}: ${row.available ? 'available' : 'unavailable'} — ${row.reason}`).join('\n')}\n\n## Monthly counts\n\n| Month | Raw | Independent | Standalone executable | OOF candidate | OOF executable | Long | Short |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${Object.entries(report.monthlyFrequency.months).map(([month, row]) => `| ${month} | ${row.rawEvents} | ${row.independentResearchObservations} | ${row.standaloneExecutable} | ${row.oofQualifiedCandidates} | ${row.oofQualifiedExecutable} | ${row.long} | ${row.short} |`).join('\n')}\n\n## Alpha standalone\n\n| Alpha | Observations | Executable | Symbols | Trades | Net PnL | Exp R | PF |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${alphaRows || '| none | 0 | 0 | 0 | 0 | — | — | — |'}\n\n## Purged OOF\n\n| Alpha | Status | Qualified executable | Exp R | PF |\n|---|---|---:|---:|---:|\n${oofRows || '| none | WATCH | 0 | — | — |'}\n\nFolds: ${report.walkForward.folds.length}; purge: ${report.walkForward.spec.purgeDurationHours}h; checks: ${JSON.stringify(report.walkForward.checks)}.\n\n## Model comparison\n\n| Model | Ranked | Accepted | Trades | Net PnL | Exp R | PF | DD |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${comparisonRows}\n\n## Gate\n\nDecision: **${report.gate.decision}**\n\n| Check | Result |\n|---|---|\n${gateRows}\n\nThe selection rule is preregistered: a V9 alpha may enter the future Holdout candidate set only when its purged OOF qualified executable attribution is KEEP; if the Development Gate fails, no Holdout candidate is selected. No ad-hoc best-profit selection is permitted.\n\n## Limitations\n\n${report.knownLimitations.map(row => `- ${row}`).join('\n')}\n`;
}

async function main() {
  const progress = label => { if (process.env.V9_PROGRESS === '1') console.error(`[v9] ${label}`); };
  const start = dateValue(cliValue('--start', null), DEFAULT_START);
  const end = dateValue(cliValue('--end', null), DEFAULT_END);
  if (start !== DEFAULT_START || end !== DEFAULT_END) throw new Error('V9 Development is locked to 2024-01-01 through 2025-12-31');
  const dataRoot = path.resolve(cliValue('--data-root', path.join(APP_DIR, 'data', 'backtest')));
  const enhancedRoot = path.resolve(cliValue('--enhanced-root', path.join(APP_DIR, 'data', 'v9-development')));
  const outputDir = path.resolve(cliValue('--output-dir', path.join(APP_DIR, 'data', 'v9-development')));
  const reportsDir = path.resolve(cliValue('--reports-dir', path.join(APP_DIR, 'reports')));
  const maxSymbols = Number(cliValue('--max-symbols', 150)) || 150;
  const workerCount = Math.max(1, Number(cliValue('--workers', 2)) || 2);
  progress('replay:start');
  const replay = await runV9Replay({dataRoot, enhancedRoot, appDir: APP_DIR, start, end, maxSymbols, workerCount});
  progress('replay:done');
  const options = {initialEquity: 10_000, start, end};
  const standaloneExecutable = replay.standaloneOutcomes.filter(row => row.executable);
  const standaloneMetrics = calculateResearchMetrics(standaloneExecutable, replay.independentObservations, options);
  const alphaStandalone = Object.fromEntries(V9_ALPHA_IDS.map(alpha => [alpha, standaloneAlphaReport(alpha, replay.independentObservations, replay.standaloneOutcomes, options)]));
  const walkForward = runPurgedWalkForward({observations: replay.independentObservations, outcomes: replay.standaloneOutcomes, folds: foldList(start, end), purgeDurationMs: PURGE_DURATION_MS});
  progress('walk-forward:done');
  const oofRows = walkForward.oofRows;
  const oofOutcomes = walkForward.oofOutcomes;
  const oofExecutable = oofOutcomes.filter(row => row.executable);
  const alphaOof = Object.fromEntries(Object.entries(alphaAttribution(V9_ALPHA_IDS, oofRows, oofExecutable, options)).map(([alpha, row]) => [alpha, {...row, status: classifyV9Alpha(row)}]));
  const keepAlphaIds = V9_ALPHA_IDS.filter(alpha => alphaOof[alpha]?.status === 'KEEP');
  const oofQualifiedRows = oofRows.filter(row => row.tier === 'A' || row.tier === 'B');
  const oofQualifiedExecutable = oofExecutable.filter(row => row.tier === 'A' || row.tier === 'B');
  const keepRows = oofQualifiedRows.filter(row => keepAlphaIds.includes(row.alpha));
  const v9DataAccess = createV9OutcomeDataAccess(dataRoot, replay.marketBySymbol, start, end, replay.standaloneOutcomes);
  const v9Portfolio = await simulatePortfolio((function* () { for (const row of rankResearchCandidates(keepRows)) yield [row]; })(), v9DataAccess, {endTime: end, ranker: rankResearchCandidates});
  const v9PortfolioMetrics = compareMetrics(v9Portfolio.closedTrades, keepRows, start, end);
  const baselineFile = path.join(outputDir, 'frozen-baseline.json');
  let baseline = null;
  if (fs.existsSync(baselineFile) && !process.argv.includes('--rerun-baseline')) {
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  } else {
    baseline = await runBacktest({symbols: replay.universe.symbols, start, end, scanIntervalHours: 4, outputBase: path.join(outputDir, 'frozen-baseline'), mode: 'formal', executionProxy: false, allowExternalCache: false, lazyMinute: true, dataRoot, eventStorage: 'all'});
  }
  progress('baseline:done');
  const v8Model = baseline.models.find(model => model.model === 'V8 Shadow');
  const v75Model = baseline.models.find(model => model.model === 'V7.5 Control');
  const v8BaselineRows = baselineRows(v8Model, 'V8 Shadow');
  const selectedV9 = replay.rankedCandidates.filter(row => keepAlphaIds.includes(row.alpha));
  const combinedRows = mergeV9RankedWithBaseline(selectedV9, v8BaselineRows);
  const v8Metrics = compactMetrics(v8Model?.full || {});
  const v75Metrics = compactMetrics(v75Model?.full || {});
  v8Metrics.uniqueSymbols = new Set((v8Model?.trades || []).map(row => row.marketId || row.symbol)).size;
  v75Metrics.uniqueSymbols = new Set((v75Model?.trades || []).map(row => row.marketId || row.symbol)).size;
  const v9StandaloneMetrics = compactMetrics(standaloneMetrics);
  const v9CandidateMetrics = compactMetrics(v9PortfolioMetrics);
  let combinedPortfolio;
  let combinedMetrics;
  if (!selectedV9.length) {
    combinedPortfolio = {
      accepted: Array.from({length: Number(v8Model?.acceptedSignalCount || 0)}),
      closedTrades: Array.from({length: Number(v8Metrics.trades || 0)}),
    };
    combinedMetrics = {...v8Metrics};
  } else {
    progress('combined:start');
    const combinedDataAccess = createV9DataAccess(dataRoot, replay.marketBySymbol, start, end);
    combinedPortfolio = await simulatePortfolio((function* () { for (const cycle of [combinedRows]) yield cycle; })(), combinedDataAccess, {endTime: end, ranker: rankResearchCandidates});
    combinedMetrics = compactMetrics(compareMetrics(combinedPortfolio.closedTrades, combinedRows, start, end));
    progress('combined:done');
  }
  const monthly = JSON.parse(JSON.stringify(monthlyRows(start, end, replay.rawCandidates, 'rawEvents')));
  addMonthly(monthly, replay.independentObservations, 'independentResearchObservations');
  addMonthly(monthly, standaloneExecutable, 'standaloneExecutable');
  addMonthly(monthly, oofQualifiedRows, 'oofQualifiedCandidates');
  addMonthly(monthly, oofQualifiedExecutable, 'oofQualifiedExecutable');
  addMonthly(monthly, oofRows.filter(row => row.tier === 'A'), 'oofHighConfidenceCandidates');
  addMonthly(monthly, oofExecutable.filter(row => row.tier === 'A'), 'oofHighConfidenceExecutable');
  const tierMetrics = Object.fromEntries(['A', 'B', 'C'].map(tier => [tier, calculateResearchMetrics(standaloneExecutable.filter(row => row.tier === tier), [], options)]));
  const tierMonotonicity = validateTierMonotonicity(tierMetrics, {minimumSamples: 30});
  const noOrderAudit = !/createOrder|placeOrder|newOrder|fapi\/v\d+\/order|orderSubmission/i.test(fs.readdirSync(path.join(APP_DIR, 'src', 'v9')).map(name => fs.readFileSync(path.join(APP_DIR, 'src', 'v9', name), 'utf8')).join('\n'));
  const walkForwardReport = {spec: walkForward.spec, folds: walkForward.folds, checks: walkForward.checks};
  const dataManifestFile = path.join(enhancedRoot, 'manifest.json');
  const dataManifest = fs.existsSync(dataManifestFile) ? JSON.parse(fs.readFileSync(dataManifestFile, 'utf8')) : {};
  const artifactTimestamp = value => {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : NaN;
  };
  const overlappingArtifact = row => {
    const first = artifactTimestamp(row.firstTimestamp ?? row.firstObserved ?? row.activeStart);
    const last = artifactTimestamp(row.lastTimestamp ?? row.lastObserved ?? row.activeEnd);
    return Number(row.rows) > 0 && row.sha256 && Number.isFinite(first) && Number.isFinite(last) && first < end && last >= start;
  };
  const usableDevelopmentSymbols = new Set((dataManifest.artifacts || []).filter(row => row.kind === 'taker-1h' && overlappingArtifact(row)).map(row => row.symbol)).size;
  const usableMetricsSymbols = new Set((dataManifest.artifacts || []).filter(row => row.kind === 'metrics' && overlappingArtifact(row) && row.invalidArchiveDates?.length === 0 && row.continuity?.complete).map(row => row.symbol)).size;
  const metricsArtifacts = (dataManifest.artifacts || []).filter(row => row.kind === 'metrics');
  const metricsData = {
    symbolsWithRows: metricsArtifacts.filter(row => Number(row.rows) > 0).length,
    usableSymbols: usableMetricsSymbols,
    rows: metricsArtifacts.reduce((sum, row) => sum + Number(row.rows || 0), 0),
    missingArchiveDates: metricsArtifacts.reduce((sum, row) => sum + (row.missingArchiveDates?.length || 0), 0),
    invalidArchiveDates: metricsArtifacts.reduce((sum, row) => sum + (row.invalidArchiveDates?.length || 0), 0),
    outOfOrderArchiveDates: metricsArtifacts.reduce((sum, row) => sum + (row.outOfOrderArchiveDates?.length || 0), 0),
    missingTimestamps: metricsArtifacts.reduce((sum, row) => sum + Number(row.continuity?.missingTimestamps || 0), 0),
    largestGapMs: Math.max(0, ...metricsArtifacts.map(row => Number(row.continuity?.largestGapMs || 0))),
  };
  const qualifiedExecutableFrequency = oofQualifiedExecutable.length / Math.max(1, Object.keys(monthly).length);
  const gate = gateReport({oofAlpha: alphaOof, oofQualifiedExecutable, rankedCandidates: replay.rankedCandidates, candidateMetrics: v9CandidateMetrics, v8Metrics, tierMonotonicity, walkForward, executionProxy: false, noOrderAudit, keepAlphaIds, trades: v9Portfolio.closedTrades, usableMetricsSymbols, qualifiedExecutableFrequency});
  const report = {
    reportVersion: 'v9-development-1', status: gate.decision, V9_RESEARCH_EXHAUSTED: gate.decision === 'RESEARCH_FAIL', generatedAt: new Date().toISOString(),
    engine: {version: 'V9-research-1', researchOnly: true, currentV81AlphaSetExhausted: true},
    boundary: {start: new Date(start).toISOString(), end: new Date(end).toISOString()},
    holdout: {status: 'NOT RUN', start: new Date(HOLDOUT_START).toISOString(), end: new Date(HOLDOUT_END).toISOString()},
    execution: {scanCadenceHours: 4, decisionLatencyMinutes: 20, fillInterval: '1m', settlementInterval: '1m', executionProxy: false, sameMinuteTpSl: 'sl', feesFundingModeled: true},
    universe: {source: replay.universe.source, requested: replay.universe.requestedSymbols, selected: replay.universe.symbols.length, usableDevelopmentSymbols, processed: replay.universe.symbols.length, core: replay.universe.symbols.filter(symbol => replay.marketBySymbol.get(symbol)?.core).length, expanded: replay.universe.symbols.filter(symbol => !replay.marketBySymbol.get(symbol)?.core).length, mode: replay.universe.selectionMode, symbolsHash: replay.universe.symbolsHash, expectedHash: replay.universe.expectedHash, symbols: replay.universe.symbols},
    dataAvailability: [
      {name: 'taker-buy volume / enhanced 1h klines', available: Boolean(dataManifest.dataAvailability?.takerBuyVolume?.available), reason: 'required by FLOW and cross-sectional families'},
      {name: 'premiumIndex / mark / index 1h archives', available: Boolean(dataManifest.dataAvailability?.premiumIndex?.available && dataManifest.dataAvailability?.markPrice?.available && dataManifest.dataAvailability?.indexPrice?.available), reason: 'required only by PREMIUM_DISLOCATION'},
      {name: 'historical open interest', available: metricsData.usableSymbols > 0, reason: `${metricsData.usableSymbols}/150 symbols have complete official 5m metrics; symbols with gaps fail closed`},
      {name: 'global/top/taker long-short ratios', available: metricsData.usableSymbols > 0, reason: `${metricsData.usableSymbols}/150 symbols have complete official 5m metrics; symbols with gaps fail closed`},
      {name: 'funding / 1m execution / first-touch', available: true, reason: 'reused local normalized M4 artifacts; inherited M4 limitations remain'},
    ],
    counts: {rawCandidates: replay.counts.rawCandidates, independentObservations: replay.counts.independentObservations, rankedCandidates: replay.counts.rankedCandidates, standaloneExecutableOutcomes: standaloneExecutable.length, standaloneRejectedOutcomes: replay.counts.standaloneRejected, oofRows: oofRows.length, oofExecutableOutcomes: oofExecutable.length, oofQualifiedCandidates: oofQualifiedRows.length, oofQualifiedExecutable: oofQualifiedExecutable.length, qualifiedExecutablePerMonth: number(qualifiedExecutableFrequency, 4), keepAlphaIds: keepAlphaIds.length, v9PortfolioAccepted: v9Portfolio.accepted.length, v9PortfolioTrades: v9Portfolio.closedTrades.length, usableMetricsSymbols, metricsRows: metricsData.rows, metricsMissingTimestamps: metricsData.missingTimestamps},
    monthlyFrequency: frequencySummary(monthly),
    alphaStandalone: Object.fromEntries(Object.entries(alphaStandalone).map(([alpha, row]) => [alpha, {...row, metrics: compactMetrics(row.metrics)}])),
    alphaOof,
    v9Standalone: {...v9StandaloneMetrics, independentObservations: replay.independentObservations.length, executableOutcomes: standaloneExecutable.length},
    v9CandidatePortfolio: {...v9CandidateMetrics, rankedSignals: selectedV9.length, acceptedSignals: v9Portfolio.accepted.length, trades: v9Portfolio.closedTrades.length},
    modelComparison: modelComparison(baseline, {...v9CandidateMetrics, rankedSignals: selectedV9.length, acceptedSignals: v9Portfolio.accepted.length, trades: v9Portfolio.closedTrades.length}, {...combinedMetrics, rankedSignals: combinedRows.length, acceptedSignals: combinedPortfolio.accepted.length, trades: combinedPortfolio.closedTrades.length}),
    v75Baseline: v75Metrics, v8Baseline: v8Metrics, v8PlusV9: combinedMetrics,
    selectedFutureHoldoutCandidate: gate.decision === 'RESEARCH_READY_FOR_FUTURE_HOLDOUT' ? keepAlphaIds : [],
    candidateStats: {standalone: v9StandaloneMetrics, candidatePortfolio: v9CandidateMetrics, combined: combinedMetrics, monthlyPositiveNegativeZero: {positive: Object.values(v9CandidateMetrics.monthlyPnl).filter(value => value > 0).length, negative: Object.values(v9CandidateMetrics.monthlyPnl).filter(value => value < 0).length, zero: Object.values(v9CandidateMetrics.monthlyPnl).filter(value => value === 0).length}, longShort: breakdownMetrics(standaloneExecutable, row => row.side || 'unknown', options), regimes: breakdownMetrics(standaloneExecutable, row => row.regime || row.btcRouter || 'unknown', options), concentrationPct: pct(concentration(v9Portfolio.closedTrades))},
    walkForward: walkForwardReport,
    purge: {method: 'event-end-aware', embargoHours: PURGE_DURATION_MS / H1, noFutureOutcomeInScore: true},
    tierMonotonicity,
    gate,
    requiredAlphaCoverage: V9_ALPHA_IDS,
    observedAlphaCoverage: [...new Set(replay.rankedCandidates.map(row => row.alpha))].sort(),
    provenance: {strategyTreeSha256: strategyTreeSha256(APP_DIR), v9CodeSha256: hashFiles(fs.readdirSync(path.join(APP_DIR, 'src', 'v9')).map(name => path.join(APP_DIR, 'src', 'v9', name))), developmentRunCodeCommit: gitSha(), frozenConfigSha256: jsonSha256({registry: V9_ALPHA_IDS, scorecard: V9_SCORECARD, targetR: 2, scanCadenceHours: 4, decisionLatencyMinutes: 20}), datasetManifestSha256: fs.existsSync(dataManifestFile) ? crypto.createHash('sha256').update(fs.readFileSync(dataManifestFile)).digest('hex') : null, reportCommit: gitSha()},
    dataIntegrity: {m4Status: dataManifest.status || 'M4-INCOMPLETE', pointInTime: Boolean(dataManifest.universe?.pointInTime), historicalDelistingsResolved: Boolean(dataManifest.universe?.historicalDelistingsResolved), expandedNonCoreCovered: Boolean(dataManifest.universe?.expandedNonCoreCovered), metrics: metricsData, metricsUsableSymbols: usableMetricsSymbols, manifest: path.relative(APP_DIR, dataManifestFile).replaceAll('\\', '/')},
    noOrderAudit,
    knownLimitations: [
      'M4 remains incomplete: inherited universe/lifecycle manifest is not point-in-time and historical delisting/survivorship resolution is not complete.',
      'Development uses 150 deterministic V8.1 symbols; it does not run the 388-symbol universe.',
      `${usableDevelopmentSymbols} of 150 selected symbols have overlapping enhanced Development data; this exceeds the 100-symbol minimum but is below the preferred 150.`,
      `${usableMetricsSymbols} of 150 selected symbols have complete official 5m metrics continuity for the Development window; ${metricsData.missingTimestamps} timestamps are missing across the downloaded metrics artifacts and any gapped symbol is fail-closed for OI/crowding features.`,
      'The 2026-01-01 through 2026-07-15 Holdout was not run. No profitability or production-readiness conclusion is made.',
      'V7.5/V8 baselines are frozen same-window paper backtest references; V9 is research-only and does not alter Production.',
    ],
  };
  fs.mkdirSync(reportsDir, {recursive: true});
  writeJson(path.join(reportsDir, 'v9-development.json'), report);
  atomicWrite(path.join(reportsDir, 'v9-development.md'), `${markdown(report)}\n`);
  progress('report:done');
  console.log(JSON.stringify({status: report.status, universe: report.universe, counts: report.counts, v75Baseline: report.v75Baseline, v8Baseline: report.v8Baseline, v9Standalone: report.v9Standalone, v9CandidatePortfolio: report.v9CandidatePortfolio, v8PlusV9: report.v8PlusV9, gate: report.gate, holdout: report.holdout}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

export {classifyV9Alpha, foldList, gateReport, standaloneAlphaReport};
