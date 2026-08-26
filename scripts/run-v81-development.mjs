import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {APP_DIR, DAY} from '../src/config.mjs';
import {RESEARCH_ALPHA_IDS} from '../src/v81/alpha-registry.mjs';
import {dedupeResearchEpisodes} from '../src/v81/episodes.mjs';
import {breakdownMetrics, calculateResearchMetrics, alphaAttribution, validateTierMonotonicity} from '../src/v81/metrics.mjs';
import {rankResearchCandidates} from '../src/v81/dedupe.mjs';
import {simulatePortfolio} from '../src/v81/portfolio.mjs';
import {rankCandidates} from '../src/portfolio.mjs';
import {candidateCycles, createDevelopmentDataAccess, researchConfig, runDevelopmentReplay} from '../src/v81/replay.mjs';
import {jsonSha256, strategyTreeSha256} from '../src/v81/provenance.mjs';
import {runBacktest} from './backtest.mjs';

const defaultStart = Date.parse('2025-01-01T00:00:00Z');
const defaultEnd = Date.parse('2026-01-01T00:00:00Z');
const holdoutStart = Date.parse('2026-01-01T00:00:00Z');
const holdoutEnd = Date.parse('2026-07-15T00:00:00Z');

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

function pct(value) {
  return value == null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(2)}%`;
}

function number(value, digits = 3) {
  return value == null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

function sumMonthly(months, field) {
  return Object.values(months || {}).reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
}

function* cyclesFromRows(rows) {
  const sorted = [...(rows || [])].sort((a, b) => Number(a.t) - Number(b.t)
    || String(a.side || '').localeCompare(String(b.side || ''))
    || String(a.id || '').localeCompare(String(b.id || '')));
  let currentTime = null;
  let batch = [];
  for (const row of sorted) {
    if (currentTime != null && Number(row.t) !== currentTime) {
      if (batch.length) yield batch;
      batch = [];
    }
    currentTime = Number(row.t);
    batch.push(row);
  }
  if (batch.length) yield batch;
}

function baselineCandidate(event, modelName, index) {
  const marketId = event.marketId || event.symbol;
  const signalTime = Number(event.signalTime);
  const alpha = event.alpha && event.alpha !== 'unknown'
    ? event.alpha
    : event.family || (modelName === 'V7.5 Control' ? 'v75_control' : 'v8_shadow');
  return {
    id: event.id || `${modelName}|${marketId}|${event.side}|${signalTime}|${index}`,
    modelVersion: event.model || modelName,
    alpha,
    alphaSources: [alpha],
    family: event.family || alpha,
    marketId,
    symbol: event.symbol || marketId,
    side: event.side,
    t: signalTime,
    signalPrice: event.signalPrice,
    entry: event.signalPrice,
    sl: event.stop,
    stopPct: event.stopPct,
    targetR: event.targetR,
    target: event.target,
    edgeScore: event.edgeScore,
    eventScore: event.eventScore,
    dayVolume: event.dayVolume,
    core: Boolean(event.core),
    regime: event.regime || event.btcRouter || 'unknown',
    btcRouter: event.btcRouter || event.regime || 'unknown',
    features: {regime: event.regime || event.btcRouter || 'unknown', btcRouter: event.btcRouter || event.regime || 'unknown'},
  };
}

function independentBaselineEvents(model, modelName) {
  const rows = (model?.rawCandidateEvents || []).map((event, index) => {
    const candidate = baselineCandidate(event, modelName, index);
    return {...candidate, alpha: event.family || candidate.alpha};
  });
  return dedupeResearchEpisodes(rows);
}

function baselineSummary(model, portfolio, modelName, options) {
  const rawEvents = model?.rawCandidateEvents || [];
  const rankedEvents = model?.signalEvents || [];
  const independentEvents = independentBaselineEvents(model, modelName);
  const metrics = calculateResearchMetrics(portfolio.closedTrades, independentEvents, options);
  return {
    model: modelName,
    rawEvents: rawEvents.length,
    independentObservations: independentEvents.length,
    qualifiedOpportunities: rankedEvents.length,
    highConfidence: null,
    rankedSignals: rankedEvents.length,
    acceptedSignals: portfolio.accepted.length,
    rejectedSignals: portfolio.rejected.length,
    trades: portfolio.closedTrades.length,
    metrics,
  };
}

function modelMetrics(portfolio, options) {
  return calculateResearchMetrics(portfolio?.closedTrades || [], [], options);
}

function positiveFamily(row) {
  return row.trades >= 30
    && Number(row.netPnlUsdt) > 0
    && Number(row.expectancyR) > 0
    && Number(row.profitFactor) > 1;
}

function reusableBaseline(file, {symbols, start, end, dataRoot}) {
  if (process.argv.includes('--rerun-baseline') || !fs.existsSync(file)) return null;
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expectedRoot = path.relative(APP_DIR, dataRoot).replaceAll('\\', '/') || '.';
    const sameSymbols = JSON.stringify(report.data?.symbols || []) === JSON.stringify(symbols);
    const sameBoundary = report.data?.snapshotEnd === new Date(end).toISOString();
    const usableModels = Array.isArray(report.models) && report.models.length === 2
      && report.models.every(model => Array.isArray(model.signalEvents) && Array.isArray(model.rawCandidateEvents));
    if (report.data?.mode !== 'formal' || report.data?.executionProxy !== false || report.data?.dataRoot !== expectedRoot || !sameBoundary || !sameSymbols || !usableModels) return null;
    return report;
  } catch {
    return null;
  }
}

function markdownReport(report) {
  const months = Object.entries(report.monthlyFrequency.months)
    .map(([month, row]) => `| ${month} | ${row.rawEvents} | ${row.independentResearchObservations} | ${row.qualified} | ${row.highConfidence} | ${row.long} | ${row.short} |`)
    .join('\n');
  const alphaRows = Object.entries(report.alphaAttribution)
    .map(([alpha, row]) => `| ${alpha} | ${row.observations} | ${row.qualified} | ${row.trades} | ${number(row.netPnlUsdt, 2)} | ${number(row.expectancyR)} | ${number(row.profitFactor)} | ${row.status} |`)
    .join('\n');
  const comparisonRows = Object.entries(report.baselineComparison)
    .map(([name, row]) => `| ${name} | ${row.rankedSignals} | ${row.acceptedSignals} | ${row.trades} | ${number(row.metrics.netPnlUsdt, 2)} | ${number(row.metrics.expectancyR)} | ${number(row.metrics.profitFactor)} | ${pct(row.metrics.maxDrawdownPct)} |`)
    .join('\n');
  return `# V8.1 Development Research Replay

Status: **${report.gate.decision}**. Research-only paper simulation; no Holdout was run.

## Boundary and execution

- Development: ${new Date(report.boundary.start).toISOString()} through ${new Date(report.boundary.end).toISOString()} (end exclusive)
- Scan cadence: ${report.execution.scanCadenceHours}h; decision latency: ${report.execution.decisionLatencyMinutes} minutes
- Fill and settlement: first executable 1m bar at/after decision time, completed 1m first-touch, same-minute TP+SL => SL
- Execution proxy: ${report.execution.executionProxy}; fees/funding/cost modeled: ${report.execution.feesFundingModeled}
- Holdout: **NOT RUN** (${new Date(report.holdout.start).toISOString()} through ${new Date(report.holdout.end).toISOString()})

## Development universe

- Requested: ${report.universe.requested}; selected/processed: ${report.universe.symbols}/${report.universe.processed}
- Selection: ${report.universe.mode}; ${report.universe.core} core / ${report.universe.expanded} expanded
- Formal universe gate: ${report.gate.checks.formalUniverse ? 'PASS' : 'FAIL'} (minimum ${report.gate.minimumFormalUniverse})
- M4 remains: **${report.dataIntegrity.m4Status}**

## Monthly opportunity counts

| Month | Raw | Independent | Qualified A/B | High confidence A | Long | Short |
|---|---:|---:|---:|---:|---:|---:|
${months}

## Frozen baseline comparison

| Model | Ranked | Accepted | Trades | Net PnL | Exp R | PF | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|
${comparisonRows}

V8.1 combined = frozen V8 Shadow ranked signals plus only Development Alpha rows whose attribution status is KEEP. WATCH/REJECT rows are excluded from the incremental sleeve. The all-new research sleeve is audited separately below.

## V8.1 combined metrics

- Trades: ${report.v81.metrics.trades}; win rate: ${pct(report.v81.metrics.winRate)}; PF: ${number(report.v81.metrics.profitFactor)}; expectancy: ${number(report.v81.metrics.expectancyR)}R
- Net PnL: ${number(report.v81.metrics.netPnlUsdt, 2)} USDT (${pct(report.v81.metrics.netReturn)}); max DD: ${number(report.v81.metrics.maxDrawdownUsdt, 2)} USDT / ${pct(report.v81.metrics.maxDrawdownPct)}
- Unique symbols: ${report.v81.metrics.uniqueSymbols}; ranked signal increase vs V8: ${pct(report.comparison.v81VsV8.signalIncreasePct)}

## Alpha attribution

| Alpha | Independent observations | Qualified | Trades | Net PnL | Exp R | PF | Status |
|---|---:|---:|---:|---:|---:|---:|---|
${alphaRows}

## Gate

- Decision: **${report.gate.decision}**
- Positive families with sufficient sample: ${report.gate.positiveAlphaFamilies}; KEEP families: ${report.gate.keepAlphaIds.length}
- Tier monotonicity: ${report.tierMonotonicity.valid ? 'PASS' : 'FAIL'} (${report.tierMonotonicity.reason})
- Provenance: strategy tree ${report.provenance.strategyTreeSha256}; frozen config ${report.provenance.frozenConfigSha256}

## Limitations

${report.knownLimitations.map(item => `- ${item}`).join('\n')}
`;
}

async function main() {
  const start = dateValue(cliValue('--start', null), defaultStart);
  const end = dateValue(cliValue('--end', null), defaultEnd);
  if (start !== defaultStart || end !== defaultEnd) throw new Error('V8.1 Development boundary is locked to 2025-01-01 through 2025-12-31');
  const mode = cliValue('--mode', process.env.V81_MODE || 'formal');
  if (!['formal', 'smoke'].includes(mode)) throw new Error(`Unsupported V8.1 mode: ${mode}`);
  const dataRoot = path.resolve(cliValue('--data-root', process.env.V81_DATA_ROOT || path.join(APP_DIR, 'data', 'backtest')));
  const outputDir = path.resolve(cliValue('--output-dir', path.join(APP_DIR, 'data', 'v81-development')));
  const reportsDir = path.resolve(cliValue('--reports-dir', path.join(APP_DIR, 'reports')));
  const resume = process.argv.includes('--resume');
  const maxSymbols = Number(cliValue('--max-symbols', process.env.V81_MAX_SYMBOLS || 150)) || 0;
  const codeCommit = gitSha();
  const strategyHash = strategyTreeSha256(APP_DIR);
  const replay = await runDevelopmentReplay({dataRoot, appDir: APP_DIR, start, end, outputDir, resume, maxSymbols, mode});
  if (mode === 'smoke') throw new Error('Smoke mode is diagnostic only and cannot produce V8.1 freeze artifacts');

  const options = {initialEquity: 10_000, start, end};
  const allNewTrades = replay.portfolio.closedTrades;
  const allNewMetrics = calculateResearchMetrics(allNewTrades, replay.observations, options);
  const alpha = alphaAttribution(RESEARCH_ALPHA_IDS, replay.observations, allNewTrades, options);
  const keepAlphaIds = RESEARCH_ALPHA_IDS.filter(id => alpha[id].status === 'KEEP');
  const allNewQualifiedRows = [...candidateCycles(replay.independentFiles, candidate => candidate.tier === 'A' || candidate.tier === 'B')].flat();
  const keepRows = allNewQualifiedRows.filter(candidate => keepAlphaIds.includes(candidate.alpha));
  const incrementalPortfolio = await simulatePortfolio(cyclesFromRows(keepRows), replay.dataAccess, {endTime: end, ranker: rankResearchCandidates});

  const baselineOutput = path.join(outputDir, 'frozen-baseline');
  const baselineFile = `${baselineOutput}.json`;
  const cachedBaseline = reusableBaseline(baselineFile, {symbols: replay.universe.symbols, start, end, dataRoot});
  const baseline = cachedBaseline || await runBacktest({
    symbols: replay.universe.symbols,
    start,
    end,
    scanIntervalHours: 4,
    outputBase: baselineOutput,
    mode: 'formal',
    executionProxy: false,
    allowExternalCache: false,
    lazyMinute: true,
    dataRoot,
    recordEventsFrom: start,
    recordEventsUntil: end,
    eventStorage: 'all',
  });
  const baselineModels = new Map(baseline.models.map(model => [model.model, model]));
  const baselineData = createDevelopmentDataAccess(dataRoot, replay.marketBySymbol, start, end);
  const baselinePortfolios = {};
  for (const [name, modelName] of [['v75', 'V7.5 Control'], ['v8', 'V8 Shadow']]) {
    const rows = (baselineModels.get(modelName)?.signalEvents || []).map((event, index) => baselineCandidate(event, modelName, index));
    baselinePortfolios[name] = await simulatePortfolio(cyclesFromRows(rows), baselineData, {endTime: end, ranker: rankCandidates});
  }
  const v75Summary = baselineSummary(baselineModels.get('V7.5 Control'), baselinePortfolios.v75, 'V7.5 Control', options);
  const v8Summary = baselineSummary(baselineModels.get('V8 Shadow'), baselinePortfolios.v8, 'V8 Shadow', options);
  const v8Rows = (baselineModels.get('V8 Shadow')?.signalEvents || []).map((event, index) => baselineCandidate(event, 'V8 Shadow', index));
  const v81Portfolio = await simulatePortfolio(cyclesFromRows([...v8Rows, ...keepRows]), baselineData, {endTime: end, ranker: rankCandidates});
  const v81Metrics = modelMetrics(v81Portfolio, options);
  const incrementalMetrics = modelMetrics(incrementalPortfolio, options);
  const tierMetrics = Object.fromEntries(['A', 'B', 'C'].map(tier => [tier, calculateResearchMetrics(allNewTrades.filter(row => row.tier === tier), [], options)]));
  const tierMonotonicity = validateTierMonotonicity(tierMetrics, {minimumSamples: 10});
  const bySide = breakdownMetrics(v81Portfolio.closedTrades, row => row.side || 'unknown', options);
  const byRegime = breakdownMetrics(v81Portfolio.closedTrades, row => row.regime || row.btcRouter || 'unknown', options);
  const positiveAlphaFamilies = Object.values(alpha).filter(positiveFamily).length;
  const qualifiedCount = sumMonthly(replay.monthly, 'qualified');
  const highConfidenceCount = sumMonthly(replay.monthly, 'highConfidence');
  const rawCount = replay.observations.rawTotal;
  const independentCount = replay.observations.independentTotal;
  const combinedRanked = v81Portfolio.rankedCount;
  const signalIncreasePct = v8Summary.rankedSignals > 0 ? (combinedRanked - v8Summary.rankedSignals) / v8Summary.rankedSignals : null;
  const gateChecks = {
    formalUniverse: replay.universe.symbols.length >= 150,
    researchMean: replay.frequency.independentResearchObservations.mean >= 30,
    qualifiedMean: replay.frequency.qualified.mean >= 10,
    positiveAlphaFamilies: positiveAlphaFamilies >= 3,
    incrementalAlphaFamilies: keepAlphaIds.length >= 2,
    tierMonotonicity: tierMonotonicity.valid,
    portfolioProfitFactor: Number(v81Metrics.profitFactor) >= 1.5,
    portfolioExpectancy: Number(v81Metrics.expectancyR) >= 0.20,
    drawdown: Number(v81Metrics.maxDrawdownPct) <= 0.05,
    symbolBreadth: Number(v81Metrics.uniqueSymbols) >= 25,
    frequencyIncrease: combinedRanked > v8Summary.rankedSignals,
    tradesIncrease: v81Metrics.trades > v8Summary.metrics.trades,
    pnlIncrease: v81Metrics.netPnlUsdt > v8Summary.metrics.netPnlUsdt,
    noExecutionProxy: baseline.data.executionProxy === false,
  };
  const gate = {
    decision: Object.values(gateChecks).every(Boolean) ? 'GO_TO_HOLDOUT' : 'RESEARCH_FAIL',
    checks: gateChecks,
    minimumFormalUniverse: 150,
    positiveAlphaFamilies,
    keepAlphaIds,
  };
  const configBase = researchConfig({
    start,
    end,
    sourceManifestSha256: replay.sourceManifestSha256,
    universeCount: replay.universe.symbols.length,
    universeMode: replay.universe.selectionMode,
    requestedUniverseCount: replay.universe.requestedSymbols,
    provenance: {
      strategyTreeSha256: strategyHash,
      developmentRunCodeCommit: codeCommit,
      reportCommit: codeCommit,
      datasetManifestSha256: replay.sourceManifestSha256,
    },
  });
  const frozenConfigSha256 = jsonSha256(configBase);
  const report = {
    reportVersion: 'v81-development-2',
    status: 'DEVELOPMENT_ONLY',
    generatedAt: new Date().toISOString(),
    engine: {version: 'V8.1-research-2', codeSha: codeCommit, researchOnly: true},
    boundary: {start, end, durationDays: (end - start) / DAY},
    holdout: {status: 'NOT RUN', start: holdoutStart, end: holdoutEnd},
    universe: {
      source: replay.universe.source,
      mode: replay.universe.selectionMode,
      requested: replay.universe.requestedSymbols,
      symbols: replay.universe.symbols.length,
      core: replay.universe.symbols.filter(symbol => replay.universe.markets.get(symbol).core).length,
      expanded: replay.universe.symbols.filter(symbol => !replay.universe.markets.get(symbol).core).length,
      processed: replay.processedSymbols,
      symbolsListSha256: crypto.createHash('sha256').update(replay.universe.symbols.join('\n')).digest('hex'),
    },
    execution: {scanCadenceHours: 4, decisionLatencyMinutes: 20, fillInterval: '1m', settlementInterval: '1m', executionProxy: false, sameMinuteTpSl: 'sl', feesFundingModeled: true},
    counts: {
      rawEvents: rawCount,
      independentResearchObservations: independentCount,
      qualified: qualifiedCount,
      highConfidence: highConfidenceCount,
      accepted: v81Portfolio.accepted.length,
      rejected: v81Portfolio.rejected.length,
      trades: v81Metrics.trades,
      uniqueAlerts: sumMonthly(replay.monthly, 'uniqueAlerts'),
      v81IncrementalTrades: incrementalMetrics.trades,
      v81CombinedRankedSignals: combinedRanked,
    },
    monthlyFrequency: replay.frequency,
    baselineComparison: {
      v75: v75Summary,
      v8: v8Summary,
      v81Incremental: {rankedSignals: incrementalPortfolio.rankedCount, acceptedSignals: incrementalPortfolio.accepted.length, trades: incrementalMetrics.trades, metrics: incrementalMetrics},
      v81: {rankedSignals: combinedRanked, acceptedSignals: v81Portfolio.accepted.length, trades: v81Metrics.trades, metrics: v81Metrics},
    },
    v81AllNewAudit: {qualifiedRows: allNewQualifiedRows.length, trades: allNewMetrics.trades, metrics: allNewMetrics, alphaAttribution: alpha},
    v81Incremental: {includedAlphaIds: keepAlphaIds, excludedAlphaIds: RESEARCH_ALPHA_IDS.filter(id => !keepAlphaIds.includes(id)), trades: incrementalMetrics.trades, metrics: incrementalMetrics},
    v81: {model: 'V8 frozen baseline + KEEP-only incremental sleeve', metrics: v81Metrics, trades: v81Portfolio.closedTrades},
    comparison: {
      v81VsV8: {
        signalIncreasePct,
        rankedSignalDelta: combinedRanked - v8Summary.rankedSignals,
        tradesDelta: v81Metrics.trades - v8Summary.metrics.trades,
        netPnlUsdtDelta: v81Metrics.netPnlUsdt - v8Summary.metrics.netPnlUsdt,
        maxDrawdownPctDelta: v81Metrics.maxDrawdownPct - v8Summary.metrics.maxDrawdownPct,
      },
    },
    metrics: v81Metrics,
    breakdowns: {bySide, byRegime},
    tierMetrics,
    tierMonotonicity,
    alphaAttribution: alpha,
    gate,
    provenance: {strategyTreeSha256: strategyHash, developmentRunCodeCommit: codeCommit, reportCommit: codeCommit, frozenConfigSha256, datasetManifestSha256: replay.sourceManifestSha256},
    frozenConfigSha256,
    dataIntegrity: {sourceManifestSha256: replay.sourceManifestSha256, m4Status: 'M4-INCOMPLETE', artifactDir: path.relative(APP_DIR, outputDir).replaceAll('\\', '/')},
    baselineAnchors: {v75: 'V7.5 CONTROL frozen; replayed in the same Development universe and execution contract', v8: 'V8 SHADOW frozen; replayed in the same Development universe and execution contract'},
    baselineRun: {reused: Boolean(cachedBaseline), artifact: path.relative(APP_DIR, baselineFile).replaceAll('\\', '/')},
    knownLimitations: [
      'M4 strict formal dataset remains incomplete; this Development replay does not upgrade M4 or remove survivorship/lifecycle/data continuity limitations.',
      'The selected universe is the deterministic 150-symbol fallback from the 388-symbol eligible input; the full 388-symbol Development replay was not run in this artifact.',
      'V7.5 and V8 baseline event sets are generated by the frozen backtest and re-evaluated through the shared local acceptance/fill contract for comparability.',
      'V8.1 all-new Alpha rows are an audit sleeve; only KEEP rows are included in the V8.1 combined result. WATCH and REJECT are excluded.',
      'No parameter optimization, strategy threshold change, Holdout, Production deployment, or real order path was run.',
    ],
  };
  const lockStatus = gate.decision === 'RESEARCH_FAIL' ? 'BLOCKED_RESEARCH_FAIL' : 'HOLDOUT_NOT_RUN';
  writeJson(path.join(reportsDir, 'v81-frozen-config.json'), {...configBase, frozenConfigSha256, hashScope: 'SHA256 of canonical config before report-only fingerprint fields'});
  writeJson(path.join(reportsDir, 'v81-holdout-lock.json'), {status: lockStatus, holdoutStatus: 'NOT RUN', lockedAt: new Date().toISOString(), holdout: report.holdout, frozenConfigSha256, strategyTreeSha256: strategyHash, developmentRunCodeCommit: codeCommit});
  writeJson(path.join(reportsDir, 'v81-development.json'), report);
  fs.writeFileSync(path.join(reportsDir, 'v81-development.md'), markdownReport(report), 'utf8');
  console.log(JSON.stringify({status: report.status, gate: gate.decision, universe: report.universe, counts: report.counts, baseline: {v75: {trades: v75Summary.trades, profitFactor: v75Summary.metrics.profitFactor, expectancyR: v75Summary.metrics.expectancyR, netPnlUsdt: v75Summary.metrics.netPnlUsdt, maxDrawdownPct: v75Summary.metrics.maxDrawdownPct}, v8: {trades: v8Summary.trades, profitFactor: v8Summary.metrics.profitFactor, expectancyR: v8Summary.metrics.expectancyR, netPnlUsdt: v8Summary.metrics.netPnlUsdt, maxDrawdownPct: v8Summary.metrics.maxDrawdownPct}}, v81: {trades: v81Metrics.trades, winRate: v81Metrics.winRate, profitFactor: v81Metrics.profitFactor, expectancyR: v81Metrics.expectancyR, netPnlUsdt: v81Metrics.netPnlUsdt, maxDrawdownPct: v81Metrics.maxDrawdownPct}, provenance: report.provenance, holdout: 'NOT RUN'}, null, 2));
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/run-v81-development.mjs')) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
