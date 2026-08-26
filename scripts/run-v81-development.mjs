import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {APP_DIR, DAY} from '../src/config.mjs';
import {RESEARCH_ALPHA_IDS} from '../src/v81/alpha-registry.mjs';
import {dedupeResearchEpisodes} from '../src/v81/episodes.mjs';
import {breakdownMetrics, calculateResearchMetrics, alphaAttribution, frequencySummary, recordMonthlyObservation, validateTierMonotonicity} from '../src/v81/metrics.mjs';
import {rankResearchCandidates} from '../src/v81/dedupe.mjs';
import {simulatePortfolio} from '../src/v81/portfolio.mjs';
import {rankCandidates} from '../src/portfolio.mjs';
import {createDevelopmentDataAccess, researchConfig, runDevelopmentReplay} from '../src/v81/replay.mjs';
import {jsonSha256, strategyTreeSha256} from '../src/v81/provenance.mjs';
import {runBacktest} from './backtest.mjs';
import {featureBucketMetrics, PURGE_DURATION_MS, runPurgedWalkForward} from '../src/v81/walk-forward.mjs';

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

function standaloneAlphaReport(alphaId, observations, outcomes, options) {
  const observed = observations.filter(row => row.alpha === alphaId);
  const executable = outcomes.filter(row => row.executable && row.alpha === alphaId);
  const metrics = calculateResearchMetrics(executable, observed, options);
  return {
    alpha: alphaId,
    tierIndependent: true,
    observations: observed.length,
    executableOutcomes: executable.length,
    uniqueSymbols: new Set(executable.map(row => row.marketId || row.symbol)).size,
    metrics,
    bySide: breakdownMetrics(executable, row => row.side || 'unknown', options),
    byRegime: breakdownMetrics(executable, row => row.regime || row.btcRouter || 'unknown', options),
    monthlyPnl: metrics.monthlyPnl,
  };
}

function addMonthlyField(monthly, rows, field) {
  for (const row of rows || []) {
    recordMonthlyObservation(monthly, {
      t: row.signalTime ?? row.t,
      side: row.side,
      alpha: row.alpha,
      regime: row.regime || row.btcRouter || row.features?.regime,
    }, field);
  }
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
    .map(([month, row]) => `| ${month} | ${row.rawEvents} | ${row.independentResearchObservations} | ${row.standaloneExecutable} | ${row.oofQualifiedCandidates} | ${row.oofQualifiedExecutable} | ${row.oofHighConfidenceCandidates} | ${row.oofHighConfidenceExecutable} | ${row.long} | ${row.short} |`)
    .join('\n');
  const standaloneAlphaRows = Object.entries(report.standaloneAlphaAttribution)
    .map(([alpha, row]) => `| ${alpha} | ${row.observations} | ${row.executableOutcomes} | ${row.uniqueSymbols} | ${row.metrics.trades} | ${number(row.metrics.netPnlUsdt, 2)} | ${number(row.metrics.expectancyR)} | ${number(row.metrics.profitFactor)} |`)
    .join('\n');
  const oofAlphaRows = Object.entries(report.oofAlphaAttribution)
    .map(([alpha, row]) => `| ${alpha} | ${row.allOofExecutable.sample} / ${number(row.allOofExecutable.profitFactor)} / ${number(row.allOofExecutable.expectancyR)} | ${row.qualifiedOofExecutable.sample} / ${number(row.qualifiedOofExecutable.profitFactor)} / ${number(row.qualifiedOofExecutable.expectancyR)} | ${row.highConfidenceOofExecutable.sample} / ${number(row.highConfidenceOofExecutable.profitFactor)} / ${number(row.highConfidenceOofExecutable.expectancyR)} | ${number(row.scoringEfficacy.deltaExpectancyR)} | ${number(row.scoringEfficacy.deltaProfitFactor)} | ${row.status} |`)
    .join('\n');
  const comparisonRows = Object.entries(report.baselineComparison)
    .map(([name, row]) => `| ${name} | ${row.rankedSignals} | ${row.acceptedSignals} | ${row.trades} | ${number(row.metrics.netPnlUsdt, 2)} | ${number(row.metrics.expectancyR)} | ${number(row.metrics.profitFactor)} | ${pct(row.metrics.maxDrawdownPct)} |`)
    .join('\n');
  const foldRows = report.walkForward.folds
    .map(fold => `| ${fold.id} | ${fold.requestedTrainObservations} | ${fold.trainObservations} | ${fold.trainExecutableLabels} | ${fold.excludedLabelOverlap} | ${fold.purgedSignals} | ${fold.labelOverlapFree} |`)
    .join('\n');
  const oofAlphaDetails = Object.entries(report.oofAlphaAttribution).map(([alpha, row]) => {
    const layer = (name, value) => `- ${name}: sample=${value.sample}; symbols=${value.uniqueSymbols}; wins/losses=${value.wins}/${value.losses}; winRate=${pct(value.winRate)}; PF=${number(value.profitFactor)}; Exp=${number(value.expectancyR)}R; 95% CI=${Array.isArray(value.expectancyR95CI) ? `[${number(value.expectancyR95CI[0])}, ${number(value.expectancyR95CI[1])}]` : 'n/a'}; net PnL=${number(value.netPnlUsdt, 2)} USDT; max DD=${pct(value.maxDrawdownPct)}; long=${value.long.trades}; short=${value.short.trades}; regimes=${Object.keys(value.byRegime).join(',') || 'none'}`;
    return `**${alpha}**\n${layer('All OOF executable', row.allOofExecutable)}\n${layer('Qualified OOF executable', row.qualifiedOofExecutable)}\n${layer('High-confidence OOF executable', row.highConfidenceOofExecutable)}`;
  }).join('\n\n');
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

## Monthly research counts

| Month | Raw | Independent | Standalone executable | Qualified candidate | Qualified executable | High candidate | High executable | Long | Short |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${months}

The monthly standaloneExecutable and separately named OOF candidate/executable columns are the formal research denominators; the legacy qualified/high-confidence columns remain available as ex-ante opportunity counts.

## Frozen baseline comparison

| Model | Ranked | Accepted | Trades | Net PnL | Exp R | PF | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|
${comparisonRows}

V8.1 combined = frozen V8 Shadow ranked signals plus only Development Alpha rows whose attribution status is KEEP. WATCH/REJECT rows are excluded from the incremental sleeve. The all-new research sleeve is audited separately below.

## V8.1 combined metrics

- Trades: ${report.v81.metrics.trades}; win rate: ${pct(report.v81.metrics.winRate)}; PF: ${number(report.v81.metrics.profitFactor)}; expectancy: ${number(report.v81.metrics.expectancyR)}R
- Net PnL: ${number(report.v81.metrics.netPnlUsdt, 2)} USDT (${pct(report.v81.metrics.netReturn)}); max DD: ${number(report.v81.metrics.maxDrawdownUsdt, 2)} USDT / ${pct(report.v81.metrics.maxDrawdownPct)}
- Unique symbols: ${report.v81.metrics.uniqueSymbols}; ranked signal increase vs V8: ${pct(report.comparison.v81VsV8.signalIncreasePct)}

## Standalone Alpha Outcomes (tier-independent)

| Alpha | Observations | Executable outcomes | Symbols | Trades | Net PnL | Exp R | PF |
|---|---:|---:|---:|---:|---:|---:|---:|
${standaloneAlphaRows}

## Purged walk-forward OOF Alpha decisions

| Alpha | All n / PF / Exp R | Qualified n / PF / Exp R | High n / PF / Exp R | Δ Exp R | Δ PF | Decision |
|---|---:|---:|---:|---:|---:|
${oofAlphaRows}

- Folds: ${report.walkForward.folds.length}; purge/embargo: ${report.walkForward.spec.purgeDurationHours}h
- Time ordered: ${report.walkForward.checks.timeOrdered}; purge enforced: ${report.walkForward.checks.purgeEnforced}; label overlap free: ${report.walkForward.checks.labelOverlapFree}; frozen validation: ${report.walkForward.checks.validationFrozen}; complete OOF coverage: ${report.walkForward.checks.completeValidationCoverage}

### Fold label lifecycle accounting

| Fold | Requested train observations | Train observations | Train executable labels | Excluded label overlap | Purged signals | Label overlap free |
|---|---:|---:|---:|---:|---:|---|
${foldRows}

### Per-alpha OOF layer details

${oofAlphaDetails}

## Gate

- Decision: **${report.gate.decision}**
- Standalone executable outcomes: ${report.standalone.executableOutcomes}; OOF qualified candidates: ${report.oofQualifiedCandidates.count}; OOF qualified executable: ${report.oofQualifiedExecutable.count}; OOF high-confidence candidates: ${report.oofHighConfidenceCandidates.count}; OOF high-confidence executable: ${report.oofHighConfidenceExecutable.count}
- Positive standalone families with sufficient sample: ${report.gate.positiveStandaloneAlphaFamilies}; OOF KEEP families: ${report.gate.keepAlphaIds.length}
- Tier monotonicity: ${report.tierMonotonicity.sufficientSample && report.tierMonotonicity.valid ? 'PASS' : report.tierMonotonicity.reason} (valid=${report.tierMonotonicity.valid}; sufficient=${report.tierMonotonicity.sufficientSample})
- Tier comparison: A=High Confidence, B=Qualified-B, C=Research-C
- Current V8.1 alpha set exhausted: ${report.currentV81AlphaSetExhausted}
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
  const standaloneOutcomes = replay.standaloneOutcomes || [];
  const standaloneExecutable = standaloneOutcomes.filter(row => row.executable);
  const allNewMetrics = calculateResearchMetrics(standaloneExecutable, replay.independentObservations, options);
  const standaloneAlpha = Object.fromEntries(RESEARCH_ALPHA_IDS.map(alphaId => [
    alphaId,
    standaloneAlphaReport(alphaId, replay.independentObservations, standaloneOutcomes, options),
  ]));
  const allNewQualifiedRows = replay.independentObservations.filter(candidate => candidate.tier === 'A' || candidate.tier === 'B');

  const walkForward = runPurgedWalkForward({
    observations: replay.independentObservations,
    outcomes: standaloneOutcomes,
    purgeDurationMs: PURGE_DURATION_MS,
  });
  const oofRows = walkForward.oofRows;
  const oofOutcomes = walkForward.oofOutcomes;
  const oofExecutable = oofOutcomes.filter(row => row.executable);
  const oofAlpha = alphaAttribution(RESEARCH_ALPHA_IDS, oofRows, oofExecutable, options);
  const keepAlphaIds = RESEARCH_ALPHA_IDS.filter(id => oofAlpha[id].status === 'KEEP');
  const oofQualifiedRows = oofRows.filter(candidate => candidate.tier === 'A' || candidate.tier === 'B');
  const oofQualifiedOutcomes = oofExecutable.filter(row => row.tier === 'A' || row.tier === 'B');
  const oofHighConfidenceRows = oofRows.filter(candidate => candidate.tier === 'A');
  const oofHighConfidenceOutcomes = oofExecutable.filter(row => row.tier === 'A');
  const keepRows = oofQualifiedRows.filter(candidate => keepAlphaIds.includes(candidate.alpha));
  const incrementalPortfolio = await simulatePortfolio(cyclesFromRows(keepRows), replay.dataAccess, {endTime: end, ranker: rankResearchCandidates});

  const monthly = JSON.parse(JSON.stringify(replay.monthly));
  addMonthlyField(monthly, standaloneExecutable, 'standaloneExecutable');
  addMonthlyField(monthly, oofQualifiedRows, 'oofQualifiedCandidates');
  addMonthlyField(monthly, oofQualifiedOutcomes, 'oofQualifiedExecutable');
  addMonthlyField(monthly, oofHighConfidenceRows, 'oofHighConfidenceCandidates');
  addMonthlyField(monthly, oofHighConfidenceOutcomes, 'oofHighConfidenceExecutable');
  const monthlyFrequency = frequencySummary(monthly);

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
  const tierMetrics = Object.fromEntries(['A', 'B', 'C'].map(tier => [tier, calculateResearchMetrics(oofExecutable.filter(row => row.tier === tier), [], options)]));
  const tierMonotonicity = validateTierMonotonicity(tierMetrics, {minimumSamples: 30});
  const bySide = breakdownMetrics(v81Portfolio.closedTrades, row => row.side || 'unknown', options);
  const byRegime = breakdownMetrics(v81Portfolio.closedTrades, row => row.regime || row.btcRouter || 'unknown', options);
  const positiveStandaloneAlphaFamilies = Object.values(standaloneAlpha).filter(row => positiveFamily(row.metrics)).length;
  const qualifiedCount = sumMonthly(monthly, 'qualified');
  const highConfidenceCount = sumMonthly(monthly, 'highConfidence');
  const rawCount = replay.observations.rawTotal;
  const independentCount = replay.observations.independentTotal;
  const combinedRanked = v81Portfolio.rankedCount;
  const signalIncreasePct = v8Summary.rankedSignals > 0 ? (combinedRanked - v8Summary.rankedSignals) / v8Summary.rankedSignals : null;
  const oofQualifiedCandidatesCount = oofQualifiedRows.length;
  const oofQualifiedExecutableCount = oofQualifiedOutcomes.length;
  const oofHighConfidenceCandidatesCount = oofHighConfidenceRows.length;
  const oofHighConfidenceExecutableCount = oofHighConfidenceOutcomes.length;
  const edgeAlphaCount = Object.values(oofAlpha).filter(row => row.status === 'KEEP' || row.status === 'WATCH').length;
  const currentV81AlphaSetExhausted = keepAlphaIds.length === 0 || edgeAlphaCount === 1;
  const gateChecks = {
    formalUniverse: replay.universe.symbols.length >= 150,
    incrementalAlphaFamilies: keepAlphaIds.length >= 2,
    oofQualifiedExecutable: oofQualifiedExecutableCount >= 60,
    qualifiedExecutableMean: monthlyFrequency.oofQualifiedExecutable.mean >= 5,
    tierMonotonicity: tierMonotonicity.sufficientSample && tierMonotonicity.valid,
    portfolioProfitFactor: Number(v81Metrics.profitFactor) >= 1.5,
    portfolioExpectancy: Number(v81Metrics.expectancyR) >= 0.20,
    drawdown: Number(v81Metrics.maxDrawdownPct) <= 0.05,
    symbolBreadth: Number(v81Metrics.uniqueSymbols) >= 25,
    frequencyIncrease: combinedRanked > v8Summary.rankedSignals,
    tradesIncrease: v81Metrics.trades > v8Summary.metrics.trades,
    pnlIncrease: v81Metrics.netPnlUsdt > v8Summary.metrics.netPnlUsdt,
    noExecutionProxy: baseline.data.executionProxy === false,
    noLookAheadOrLeakage: Object.values(walkForward.checks).every(Boolean),
    noOrderPath: true,
  };
  const gate = {
    decision: Object.values(gateChecks).every(Boolean) ? 'GO_TO_HOLDOUT' : 'RESEARCH_FAIL',
    checks: gateChecks,
    minimumFormalUniverse: 150,
    positiveStandaloneAlphaFamilies,
    keepAlphaIds,
    oofQualifiedCandidatesCount,
    oofQualifiedExecutableCount,
    oofHighConfidenceCandidatesCount,
    oofHighConfidenceExecutableCount,
    oofQualifiedExecutableMean: monthlyFrequency.oofQualifiedExecutable.mean,
    currentV81AlphaSetExhausted,
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
      walkForwardSpec: walkForward.spec,
      purgeDurationMs: PURGE_DURATION_MS,
      folds: walkForward.folds.map(fold => ({
        id: fold.id,
        train: fold.requestedTrain,
        trainUsed: fold.trainUsed,
        validation: fold.validation,
      })),
    },
  });
  const frozenConfigSha256 = jsonSha256(configBase);
  const report = {
    reportVersion: 'v81-development-3.1',
    status: 'DEVELOPMENT_ONLY',
    generatedAt: new Date().toISOString(),
    engine: {version: 'V8.1-research-3.1', codeSha: codeCommit, researchOnly: true},
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
      standaloneExecutableOutcomes: standaloneExecutable.length,
      standaloneRejectedOutcomes: standaloneOutcomes.length - standaloneExecutable.length,
      oofRows: oofRows.length,
      oofExecutableOutcomes: oofExecutable.length,
      oofQualifiedCandidates: oofQualifiedCandidatesCount,
      oofQualifiedExecutable: oofQualifiedExecutableCount,
      oofHighConfidenceCandidates: oofHighConfidenceCandidatesCount,
      oofHighConfidenceExecutable: oofHighConfidenceExecutableCount,
      qualified: qualifiedCount,
      highConfidence: highConfidenceCount,
      accepted: v81Portfolio.accepted.length,
      rejected: v81Portfolio.rejected.length,
      trades: v81Metrics.trades,
      uniqueAlerts: sumMonthly(replay.monthly, 'uniqueAlerts'),
      v81IncrementalTrades: incrementalMetrics.trades,
      v81CombinedRankedSignals: combinedRanked,
    },
    monthlyFrequency,
    standalone: {
      observations: replay.independentObservations.length,
      executableOutcomes: standaloneExecutable.length,
      rejectedOutcomes: standaloneOutcomes.length - standaloneExecutable.length,
      rejectionByReason: replay.standalone.counts.byReason,
      metrics: allNewMetrics,
    },
    standaloneAlphaAttribution: standaloneAlpha,
    featureEfficacy: featureBucketMetrics(standaloneExecutable, options),
    walkForward: {
      spec: walkForward.spec,
      folds: walkForward.folds,
      checks: walkForward.checks,
      oofRows: oofRows.length,
      oofOutcomes: oofOutcomes.length,
      oofExecutableOutcomes: oofExecutable.length,
    },
    oofQualifiedCandidates: {count: oofQualifiedCandidatesCount, rows: oofQualifiedRows.length},
    oofQualifiedExecutable: {count: oofQualifiedExecutableCount, rows: oofQualifiedOutcomes.length, metrics: calculateResearchMetrics(oofQualifiedOutcomes, oofQualifiedRows, options)},
    oofHighConfidenceCandidates: {count: oofHighConfidenceCandidatesCount, rows: oofHighConfidenceRows.length},
    oofHighConfidenceExecutable: {count: oofHighConfidenceExecutableCount, rows: oofHighConfidenceOutcomes.length, metrics: calculateResearchMetrics(oofHighConfidenceOutcomes, oofHighConfidenceRows, options)},
    oofAlphaAttribution: oofAlpha,
    baselineComparison: {
      v75: v75Summary,
      v8: v8Summary,
      v81Incremental: {rankedSignals: incrementalPortfolio.rankedCount, acceptedSignals: incrementalPortfolio.accepted.length, trades: incrementalMetrics.trades, metrics: incrementalMetrics},
      v81: {rankedSignals: combinedRanked, acceptedSignals: v81Portfolio.accepted.length, trades: v81Metrics.trades, metrics: v81Metrics},
    },
    v81AllNewAudit: {qualifiedRows: allNewQualifiedRows.length, observations: replay.independentObservations.length, executableOutcomes: standaloneExecutable.length, trades: allNewMetrics.trades, metrics: allNewMetrics, alphaAttribution: standaloneAlpha},
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
    currentV81AlphaSetExhausted,
    alphaAttribution: oofAlpha,
    gate,
    provenance: {
      strategyTreeSha256: strategyHash,
      developmentRunCodeCommit: codeCommit,
      reportCommit: codeCommit,
      frozenConfigSha256,
      datasetManifestSha256: replay.sourceManifestSha256,
      walkForwardSpec: walkForward.spec,
      purgeDurationMs: PURGE_DURATION_MS,
      folds: configBase.provenance.folds,
    },
    frozenConfigSha256,
    dataIntegrity: {sourceManifestSha256: replay.sourceManifestSha256, m4Status: 'M4-INCOMPLETE', artifactDir: path.relative(APP_DIR, outputDir).replaceAll('\\', '/')},
    baselineAnchors: {v75: 'V7.5 CONTROL frozen; replayed in the same Development universe and execution contract', v8: 'V8 SHADOW frozen; replayed in the same Development universe and execution contract'},
    baselineRun: {reused: Boolean(cachedBaseline), artifact: path.relative(APP_DIR, baselineFile).replaceAll('\\', '/')},
    knownLimitations: [
      'M4 strict formal dataset remains incomplete; this Development replay does not upgrade M4 or remove survivorship/lifecycle/data continuity limitations.',
      'The selected universe is the deterministic 150-symbol fallback from the 388-symbol eligible input; the full 388-symbol Development replay was not run in this artifact.',
      'V7.5 and V8 baseline event sets are generated by the frozen backtest and re-evaluated through the shared local acceptance/fill contract for comparability.',
      'Standalone Alpha outcomes are tier-independent; only OOF KEEP rows are included in the V8.1 combined result. WATCH and REJECT are excluded.',
      'Purged walk-forward calibration uses only preregistered feature buckets and freezes each fold model before validation; no random split, ML, or grid search was used.',
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
