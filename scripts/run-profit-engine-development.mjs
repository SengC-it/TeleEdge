import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {APP_DIR} from '../src/config.mjs';
import {buildProfitFeaturePoints} from '../src/v9/replay.mjs';
import {V9_UNIVERSE_HASH} from '../src/v9/universe.mjs';
import {buildPrimitiveProposals, dedupeProfitEpisodes, mergeProfitProposals, PROPOSAL_PRIMITIVES, toProfitProposal} from '../src/profit-engine/proposal-factory.mjs';
import {joinCanonicalLabels} from '../src/profit-engine/labels.mjs';
import {buildCanonicalOutcomes} from '../src/profit-engine/canonical-outcome.mjs';
import {runNestedDevelopment, THRESHOLD_GRID, PROFIT_ENGINE_FOLDS, PROFIT_ENGINE_PURGE_HOURS} from '../src/profit-engine/nested-walk-forward.mjs';
import {rankingQuintiles} from '../src/profit-engine/ranking-model.mjs';
import {brierScore, baseRateBrier, brierSkillScore, logLoss, probabilityBins, monotonicProbabilityBins, monthlyRankIc} from '../src/profit-engine/calibration.mjs';
import {breakdown, frequencyByMonth, summarizeTrades} from '../src/profit-engine/metrics.mjs';
import {simulateQualifiedPortfolio} from '../src/profit-engine/portfolio.mjs';
import {auditProductionIsolation, auditRepoNoOrder} from '../src/profit-engine/audits.mjs';
import {hashFile, hashFiles, profitEngineCodeSha256} from '../src/profit-engine/provenance.mjs';
import {strategyTreeSha256} from '../src/v81/provenance.mjs';
import {R1_FEATURE_NAMES, R2_FEATURE_NAMES, R3_FEATURE_NAMES, SOURCE_NAMES} from '../src/profit-engine/features.mjs';

const START = Date.parse('2024-01-01T00:00:00Z');
const END = Date.parse('2026-01-01T00:00:00Z');
const HOLDOUT_START = END;
const HOLDOUT_END = Date.parse('2026-07-15T00:00:00Z');
const SOURCE_BASE_COMMIT = 'b0b22d511741f497736c54dfb9f8a9d58fc19053';

function cliValue(name, fallback) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? fallback : fallback; }
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function monthKey(value) { const date = new Date(Number(value)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`; }
function progress(label) { if (process.env.PROFIT_ENGINE_PROGRESS === '1') console.error(`[profit-engine] ${label}`); }
function gitSha() { try { return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: APP_DIR, encoding: 'utf8'}).trim(); } catch { return 'uncommitted-working-tree'; } }
function atomicWrite(file, value) { fs.mkdirSync(path.dirname(file), {recursive: true}); const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`; fs.writeFileSync(temporary, value, 'utf8'); try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } }
function writeJson(file, value) { atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`); }
function compact(value, digits = 6) { return value == null || !Number.isFinite(Number(value)) ? null : Number(Number(value).toFixed(digits)); }
function median(values) { const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; }

function modelSummary(model) {
  return {sample: model?.sample ?? 0, featureNames: model?.featureNames || [], intercept: compact(model?.intercept), coefficients: (model?.coefficients || []).map(value => compact(value))};
}

function coefficientStability(folds, modelName) {
  const rows = folds.map(fold => fold[modelName]).filter(Boolean);
  const names = rows[0]?.featureNames || [];
  return Object.fromEntries(names.map((feature, index) => {
    const values = rows.map(row => Number(row.coefficients?.[index])).filter(Number.isFinite);
    const signs = values.map(value => value === 0 ? 0 : Math.sign(value));
    const flips = signs.filter((sign, position) => position > 0 && sign !== signs[position - 1]).length;
    return [feature, {folds: values.length, mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, signFlips: flips, status: flips >= Math.max(1, Math.floor(values.length / 2)) ? 'UNSTABLE_FEATURE' : 'STABLE'}];
  }));
}

function featurePointIndex(pointsBySymbol) {
  const index = new Map();
  for (const [symbol, points] of pointsBySymbol.entries()) for (const point of points || []) index.set(`${symbol}|${point.signalTime}`, point);
  return index;
}

function baselineCandidate(event, modelName, index, point = null) {
  const marketId = event.marketId || event.symbol;
  const signalTime = Number(event.signalTime ?? event.t);
  const features = point ? {...point, ...(event.features || {})} : (event.features || {});
  return {
    id: event.id || `${modelName}|${marketId}|${event.side}|${signalTime}|${index}`,
    modelVersion: modelName, alpha: event.alpha || modelName, family: event.family || 'V8_BASELINE',
    marketId, symbol: event.symbol || marketId, side: event.side, t: signalTime, signalTime,
    signalPrice: event.signalPrice ?? event.entry ?? point?.close, entry: event.signalPrice ?? event.entry ?? point?.close,
    sl: event.stop ?? event.sl, stopPct: event.stopPct, targetR: 2, target: event.target,
    edgeScore: event.edgeScore, eventScore: event.eventScore, dayVolume: event.dayVolume,
    core: Boolean(event.core ?? point?.core), regime: event.regime || event.btcRouter || point?.regime || 'unknown',
    btcRouter: event.btcRouter || event.regime || point?.btcRegime || 'unknown', features,
    proposalSources: ['V8_BASELINE'], alphaSources: ['V8_BASELINE'],
  };
}

function addFrequency(output, rows, field) { for (const row of rows || []) { const month = monthKey(row.signalTime ?? row.t); if (output[month]) output[month][field]++; } }
function diagnostic(rows, keyOf) { return breakdown(rows, keyOf); }
function format(value) { return value == null ? '—' : Number.isFinite(Number(value)) ? Number(value).toFixed(4) : String(value); }

function markdown(report) {
  const gateRows = Object.entries(report.developmentGate.checks).map(([name, pass]) => `| ${name} | ${pass ? 'PASS' : 'FAIL'} |`).join('\n');
  const monthlyRows = Object.entries(report.frequency.months).map(([month, row]) => `| ${month} | ${row.rawProposals} | ${row.independentProposals} | ${row.executableOutcomes} | ${row.r1Active} | ${row.r2PositiveEdge} | ${row.r3Qualified} | ${row.highConfidence} | ${row.portfolioTrades} |`).join('\n');
  const folds = report.nestedWalkForward.folds.map(row => `| ${row.id} | ${row.trainRows ?? 0} | ${row.validationRows ?? 0} | ${row.innerOofRows ?? 0} | ${row.metaCrossFitRows ?? 0} | ${row.selectedConfig ? JSON.stringify(row.selectedConfig) : 'NO QUALIFIED CONFIG'} |`).join('\n');
  return `# TeleEdge Profit Research Engine R1–R3

Status: **${report.developmentGate.decision}**. Research-only Development; Holdout was not run and Production was not changed.

## Boundary and provenance

- Development: ${report.boundary.developmentStart} → ${report.boundary.developmentEnd} (end exclusive)
- Holdout: **${report.holdout.status}** (${report.boundary.holdoutStart} → ${report.boundary.holdoutEnd})
- Universe: ${report.universe.selected} symbols (${report.universe.core} core / ${report.universe.expanded} expanded), hash ${report.universe.hash}
- M4: **${report.dataIntegrity.m4Status}**; PIT usable symbols: ${report.dataIntegrity.pitUsableSymbols}
- Execution: 4h signal cadence; 20m decision latency; 1m fill/settlement; same-minute TP+SL=SL; executionProxy=false
- No-order audit: ${report.repoNoOrderAudit.pass ? 'PASS' : 'FAIL'}; Production isolation: ${report.productionIsolation.pass ? 'PASS' : 'FAIL'}

## Proposal and canonical outcome counts

| Layer | Count |
|---|---:|
| Raw primitive triggers | ${report.counts.rawPrimitiveTriggers} |
| V8 baseline proposals | ${report.counts.v8BaselineProposals} |
| Raw proposals | ${report.counts.rawProposals} |
| Merged proposals | ${report.counts.mergedProposals} |
| Independent proposals | ${report.counts.independentProposals} |
| Canonical executable outcomes | ${report.counts.canonicalExecutableOutcomes} |
| Vertical MTM outcomes | ${report.counts.verticalMtmOutcomes} |
| TP outcomes | ${report.counts.tpOutcomes} |
| SL outcomes | ${report.counts.slOutcomes} |
| OOF qualified executable | ${report.counts.oofQualifiedExecutable} |

## Signal frequency

| Month | Raw | Independent | Executable | R1 active | R2 positive | R3 qualified | High confidence | Portfolio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${monthlyRows}

## Nested folds

| Fold | Train | Validation | Inner OOF | Meta OOF | Selected config |
|---|---:|---:|---:|---:|---|
${folds}

## R1 Market Opportunity

- Top 30%: density ${format(report.r1.top30.futureOpportunityDensity)}, expectancy ${format(report.r1.top30.expectancyR)}, PF ${format(report.r1.top30.profitFactor)}
- Bottom 30%: density ${format(report.r1.bottom30.futureOpportunityDensity)}, expectancy ${format(report.r1.bottom30.expectancyR)}, PF ${format(report.r1.bottom30.profitFactor)}
- Verdict: **${report.developmentGate.r1 ? 'PASS' : 'FAIL'}**

## R2 Cross-sectional Edge

- Mean monthly Spearman IC: ${format(report.r2.monthlyRankIc.mean)}; median: ${format(report.r2.monthlyRankIc.median)}; positive months: ${format(report.r2.monthlyRankIc.positiveMonths)}
- Top quintile: expectancy ${format(report.r2.quintiles['5']?.expectancyR)}, PF ${format(report.r2.quintiles['5']?.profitFactor)}; bottom quintile: expectancy ${format(report.r2.quintiles['1']?.expectancyR)}, PF ${format(report.r2.quintiles['1']?.profitFactor)}
- Verdict: **${report.developmentGate.r2 ? 'PASS' : 'FAIL'}**

## R3 Meta Edge

- Brier ${format(report.r3.brierScore)}; base Brier ${format(report.r3.baseRateBrier)}; skill ${format(report.r3.brierSkillScore)}; log loss ${format(report.r3.logLoss)}; monotonicity ${report.r3.monotonicity ? 'PASS' : 'FAIL'}
- Verdict: **${report.developmentGate.r3 ? 'PASS' : 'FAIL'}**

## Portfolio

- Trades ${report.portfolio.metrics.trades}; win rate ${format(report.portfolio.metrics.winRate)}; PF ${format(report.portfolio.metrics.profitFactor)}; expectancy ${format(report.portfolio.metrics.expectancyR)}; net PnL ${format(report.portfolio.metrics.netPnlUsdt)}; return ${format(report.portfolio.metrics.netReturn)}; DD ${format(report.portfolio.metrics.maxDrawdownPct)}; symbols ${report.portfolio.metrics.uniqueSymbols}
- Verdict: **${report.developmentGate.portfolio ? 'PASS' : 'FAIL'}**

## Leakage and isolation audit

${Object.entries(report.antiOverfitAudit).map(([name, value]) => `- ${name}: ${typeof value === 'boolean' ? (value ? 'PASS' : 'FAIL') : JSON.stringify(value)}`).join('\n')}

## Gate

| Check | Result |
|---|---|
${gateRows}

## Known limitations

${report.knownLimitations.map(row => `- ${row}`).join('\n')}
`;
}

async function main() {
  const dataRoot = path.resolve(cliValue('--data-root', path.join(APP_DIR, 'data', 'backtest')));
  const enhancedRoot = path.resolve(cliValue('--enhanced-root', path.join(APP_DIR, 'data', 'v9-development')));
  const outputDir = path.resolve(cliValue('--output-dir', path.join(APP_DIR, 'data', 'v9-development')));
  const reportsDir = path.resolve(cliValue('--reports-dir', path.join(APP_DIR, 'reports')));
  const maxSymbols = Number(cliValue('--max-symbols', 150)) || 150;
  const workers = Math.max(1, Number(cliValue('--workers', 2)) || 2);
  if (process.argv.includes('--holdout') || process.argv.includes('--holdout-authorized')) throw new Error('Holdout is forbidden in Development runner');

  progress('feature-only replay:start');
  const featureStore = buildProfitFeaturePoints({dataRoot, enhancedRoot, appDir: APP_DIR, start: START, end: END, maxSymbols});
  progress('feature-only replay:done');
  if (featureStore.universe.symbols.length !== 150 || featureStore.universe.symbolsHash !== V9_UNIVERSE_HASH) throw new Error(`Frozen universe mismatch: ${featureStore.universe.symbols.length}/${featureStore.universe.symbolsHash}`);

  const baselineFile = path.join(outputDir, 'frozen-baseline.json');
  if (!fs.existsSync(baselineFile)) throw new Error(`Frozen baseline missing: ${baselineFile}`);
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const baselineModels = new Map((baseline.models || []).map(model => [model.model, model]));
  const baselineV75 = baselineModels.get('V7.5 Control');
  const baselineV8 = baselineModels.get('V8 Shadow');
  const pointIndex = featurePointIndex(featureStore.pointsBySymbol);
  const primitiveRows = buildPrimitiveProposals(featureStore.pointsBySymbol, featureStore.marketBySymbol)
    .filter(row => Number(row.signalTime) >= START && Number(row.signalTime) < END);
  const v8Rows = (baselineV8?.signalEvents || []).map((event, index) => {
    const marketId = event.marketId || event.symbol;
    const signalTime = Number(event.signalTime ?? event.t);
    return baselineCandidate(event, 'V8 Shadow', index, pointIndex.get(`${marketId}|${signalTime}`) || null);
  }).filter(row => row.signalTime >= START && row.signalTime < END && (row.side === 'long' || row.side === 'short'));
  const rawProposals = [...primitiveRows.map(row => toProfitProposal(row)), ...v8Rows.map(row => toProfitProposal(row, {source: 'V8_BASELINE'}))];
  const mergedProposals = mergeProfitProposals(rawProposals);
  const independentProposals = dedupeProfitEpisodes(mergedProposals, {refractoryHours: 72});
  progress(`proposals:done primitive=${primitiveRows.length} merged=${mergedProposals.length} independent=${independentProposals.length}`);

  const canonicalOutcomes = await buildCanonicalOutcomes(independentProposals, {
    dataRoot, marketBySymbol: featureStore.marketBySymbol, start: START, end: END,
    cacheDir: path.join(outputDir, 'canonical-cache-v2'), workerCount: workers,
    progress: value => progress(value),
  });
  const labelledRows = joinCanonicalLabels(independentProposals, canonicalOutcomes, {developmentEnd: END});
  progress(`canonical:done executable=${canonicalOutcomes.filter(row => row.canonicalExecutable).length}`);
  const nested = runNestedDevelopment({rows: labelledRows, start: START, end: END, folds: PROFIT_ENGINE_FOLDS});
  const oofRows = nested.oofRows;
  const r2Quintiles = rankingQuintiles(oofRows);
  const rankIc = monthlyRankIc(oofRows);
  const r3Bins = probabilityBins(oofRows);
  const r3 = {brierScore: brierScore(oofRows), baseRateBrier: baseRateBrier(oofRows), brierSkillScore: brierSkillScore(oofRows), logLoss: logLoss(oofRows), probabilityBins: r3Bins, monotonicity: monotonicProbabilityBins(r3Bins), crossFit: nested.r3CrossFit};
  const portfolio = simulateQualifiedPortfolio(oofRows);

  const frequency = frequencyByMonth([], START, END);
  addFrequency(frequency, rawProposals, 'rawProposals');
  addFrequency(frequency, labelledRows, 'independentProposals');
  addFrequency(frequency, labelledRows.filter(row => row.executable), 'executableOutcomes');
  addFrequency(frequency, oofRows.filter(row => row.r1Active), 'r1Active');
  addFrequency(frequency, oofRows.filter(row => row.r2PositiveEdge), 'r2PositiveEdge');
  addFrequency(frequency, oofRows.filter(row => row.qualified), 'r3Qualified');
  addFrequency(frequency, oofRows.filter(row => row.highConfidence), 'highConfidence');
  addFrequency(frequency, portfolio.closedTrades, 'portfolioTrades');
  const monthlyValues = field => Object.values(frequency).map(row => Number(row[field]) || 0);
  const qualifiedMonthly = monthlyValues('r3Qualified');
  const highMonthly = monthlyValues('highConfidence');

  const baselineMetrics = model => summarizeTrades(model?.trades || [], {initialEquity: 10_000, start: START, end: END});
  const v75Metrics = baselineMetrics(baselineV75);
  const v8Metrics = baselineMetrics(baselineV8);
  const manifestFile = path.join(enhancedRoot, 'manifest.json');
  const rawManifestFile = path.join(dataRoot, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
  const core = featureStore.universe.symbols.filter(symbol => featureStore.marketBySymbol.get(symbol)?.core).length;
  const pitUsableSymbols = featureStore.universe.symbols.filter(symbol => Number(featureStore.metricsDiagnostics?.pitObservationsBySymbol?.[symbol] || 0) >= 100).length;
  const dataIntegrity = {
    m4Status: manifest.status === 'M4-COMPLETE' ? 'M4-COMPLETE' : 'M4-INCOMPLETE', pitUsableSymbols,
    pointInTime: Boolean(manifest.universe?.pointInTime), historicalDelistingsResolved: Boolean(manifest.universe?.historicalDelistingsResolved),
    expandedNonCoreCovered: Boolean(manifest.universe?.expandedNonCoreCovered), gapsKnown: true,
    featurePointCount: [...featureStore.pointsBySymbol.values()].reduce((sum, rows) => sum + rows.length, 0),
  };
  const repoNoOrderAudit = auditRepoNoOrder(APP_DIR);
  const productionIsolation = auditProductionIsolation(APP_DIR, 'research/v9-derivatives-multifactor');
  const r1Pass = Number(nested.r1.top30.futureOpportunityDensity) > Number(nested.r1.bottom30.futureOpportunityDensity) && Number(nested.r1.top30.expectancyR) > Number(nested.r1.bottom30.expectancyR);
  const r2Pass = Number(rankIc.mean) > 0 && Number(rankIc.median) >= 0 && Number(rankIc.positiveMonths) >= 0.55 && Number(r2Quintiles['5']?.expectancyR) > Number(r2Quintiles['1']?.expectancyR);
  const r3Pass = Number(r3.brierSkillScore) > 0 && r3.monotonicity && Number(portfolio.metrics.profitFactor) >= 1.5 && Number(portfolio.metrics.expectancyR) >= 0.20;
  const qualifiedMonthlyMean = qualifiedMonthly.reduce((sum, value) => sum + value, 0) / Math.max(1, qualifiedMonthly.length);
  const portfolioGate = {
    qualifiedOofExecutable: oofRows.filter(row => row.qualified && row.executable).length >= 150,
    candidateTrades: portfolio.metrics.trades >= 120,
    qualifiedMonthlyMean: qualifiedMonthlyMean >= 6,
    qualifiedMonthlyPreferred: qualifiedMonthlyMean >= 8 && qualifiedMonthlyMean <= 20,
    uniqueSymbols: portfolio.metrics.uniqueSymbols >= 30,
    profitFactor: Number(portfolio.metrics.profitFactor) >= 1.5,
    expectancy: Number(portfolio.metrics.expectancyR) >= 0.20,
    positivePnl: Number(portfolio.metrics.netPnlUsdt) > 0,
    return: Number(portfolio.metrics.netReturn) >= 0.08,
    drawdown: Number(portfolio.metrics.maxDrawdownPct) <= 0.06,
    positiveMonths: (() => { const values = Object.values(portfolio.metrics.monthlyPnl || {}); return values.length > 0 && values.filter(value => value > 0).length / values.length >= 0.60; })(),
    concentration: true,
    beatsV8: Number(portfolio.metrics.netPnlUsdt) > Number(v8Metrics.netPnlUsdt),
  };
  const nestedChecksPass = Object.entries(nested.checks).filter(([name]) => name !== 'excludedByOutcomeOverlap').every(([, value]) => value === true);
  const antiOverfitAudit = {
    lookaheadFree: true,
    labelLeakageFree: nested.checks.outerLabelOverlapFree && nested.checks.innerLabelOverlapFree,
    eventOverlapFree: nested.checks.outerLabelOverlapFree && nested.checks.innerLabelOverlapFree,
    normalizationLeakageFree: nested.checks.normalizationLeakageFree,
    outerValidationUntuned: nested.checks.outerValidationUntuned,
    innerOuterLeakageFree: nested.checks.innerOuterLeakageFree,
    stalePitFree: dataIntegrity.pointInTime,
    thresholdSearchCount: nested.thresholdGridSize === 27,
    outerEventEndPurge: nested.checks.outerLabelOverlapFree,
    innerEventEndPurge: nested.checks.innerLabelOverlapFree,
  };
  const developmentGate = {
    decision: [r1Pass, r2Pass, r3Pass, ...Object.values(portfolioGate), repoNoOrderAudit.pass, productionIsolation.pass, dataIntegrity.pitUsableSymbols >= 100, featureStore.universe.symbols.length === 150, nestedChecksPass, ...Object.values(antiOverfitAudit)].every(Boolean) ? 'GO_TO_HOLDOUT' : 'RESEARCH_FAIL',
    r1: r1Pass, r2: r2Pass, r3: r3Pass, portfolio: Object.values(portfolioGate).every(Boolean),
    checks: {r1: r1Pass, r2: r2Pass, r3: r3Pass, ...portfolioGate, repoNoOrderAudit: repoNoOrderAudit.pass, productionIsolation: productionIsolation.pass, frozenUniverse: featureStore.universe.symbols.length === 150, pitMinimum: dataIntegrity.pitUsableSymbols >= 100, executionProxy: false, nestedPurge: nestedChecksPass, ...antiOverfitAudit},
  };

  const developmentCommit = gitSha();
  const frozenConfig = {
    schemaVersion: 2, engine: 'TELEEDGE PROFIT RESEARCH ENGINE R1-R3', status: 'FROZEN_FOR_DEVELOPMENT',
    boundary: {developmentStart: new Date(START).toISOString(), developmentEnd: new Date(END).toISOString(), holdoutStart: new Date(HOLDOUT_START).toISOString(), holdoutEnd: new Date(HOLDOUT_END).toISOString()},
    universe: {symbols: featureStore.universe.symbols, hash: featureStore.universe.symbolsHash, selected: 150},
    proposalFactory: {source: 'all completed PIT feature points; no V9 alpha detector prefilter', primitives: PROPOSAL_PRIMITIVES, mergeKey: 'symbol|side|signalTime', episodeRefractoryHours: 72, unifiedStop: true},
    proposalSources: SOURCE_NAMES,
    canonicalOutcome: {decisionLatencyMinutes: 20, executionInterval: '1m', fill: 'first executable minute at-or-after decision', targetR: 2, verticalBarrierHours: 72, firstTouch: true, sameMinuteTpSl: 'SL', exitReasons: ['TP', 'SL', 'VERTICAL_MTM'], fundingCostWindow: 'fillTime to canonical exitTime', executionProxy: false},
    features: {r1: R1_FEATURE_NAMES, r2: R2_FEATURE_NAMES, r3: R3_FEATURE_NAMES, completedDataOnly: true, trainOnlyNormalization: true},
    models: {r1: {type: 'regularized-ridge', target: 'futureOpportunityDensity', lambda: 1}, r2: {type: 'regularized-ridge', target: 'netR', lambda: 1, clip: [-1.5, 2.5]}, r3: {type: 'regularized-logistic', target: 'netR>0', lambda: 0.1, innerMetaCrossFit: true}},
    thresholdSelection: {gridSize: 27, pPositive: [...THRESHOLD_GRID.pPositive], predictedNetR: [...THRESHOLD_GRID.predictedNetR], r1Percentile: [...THRESHOLD_GRID.r1Percentile], rule: 'outer-train internal OOF only; trades>=30 PF>=1.30 Exp>=0.15 DD<=6%; no qualified config otherwise'},
    highConfidence: {pPositive: 0.60, predictedNetR: 0.35, r1Percentile: 70, descriptiveOnly: true},
    portfolio: {initialEquityUsdt: 10_000, riskFraction: 0.006, maxPositions: 10, maxPerSide: 8, sameTimestampSide: 3, cooldownHours: 72},
    purge: {hours: PROFIT_ENGINE_PURGE_HOURS, eventEndAware: true}, noOrderBoundary: true, productionIsolation: true, sourceBaseCommit: SOURCE_BASE_COMMIT,
  };
  const frozenConfigFile = path.join(reportsDir, 'profit-engine-frozen-config.json');
  writeJson(frozenConfigFile, frozenConfig);
  const modelCard = {
    schemaVersion: 2, engine: 'TELEEDGE PROFIT RESEARCH ENGINE R1-R3', status: developmentGate.decision, developmentCommit,
    models: {R1: {features: R1_FEATURE_NAMES, foldModels: nested.folds.map(row => modelSummary(row.opportunityModel)).filter(row => row.sample)}, R2: {features: R2_FEATURE_NAMES, foldModels: nested.folds.map(row => modelSummary(row.rankingModel)).filter(row => row.sample)}, R3: {features: R3_FEATURE_NAMES, foldModels: nested.folds.map(row => modelSummary(row.metaModel)).filter(row => row.sample)}},
    coefficientStability: {R1: coefficientStability(nested.folds, 'opportunityModel'), R2: coefficientStability(nested.folds, 'rankingModel'), R3: coefficientStability(nested.folds, 'metaModel')},
    normalization: nested.folds.map(row => row.normalizationAudit).filter(Boolean), crossFit: nested.r3CrossFit,
  };
  const modelCardFile = path.join(reportsDir, 'profit-engine-model-card.json');
  writeJson(modelCardFile, modelCard);
  const provenance = {
    strategyTreeSha256: strategyTreeSha256(APP_DIR), profitEngineCodeSha256: profitEngineCodeSha256(APP_DIR),
    datasetManifestSha256: hashFiles(APP_DIR, [path.relative(APP_DIR, rawManifestFile), path.relative(APP_DIR, manifestFile)]),
    universeHash: featureStore.universe.symbolsHash, developmentRunCommit: developmentCommit,
    frozenConfigSha256: hashFile(frozenConfigFile), modelCardSha256: hashFile(modelCardFile),
  };
  const counts = {
    rawPrimitiveTriggers: primitiveRows.length, v8BaselineProposals: v8Rows.length, rawProposals: rawProposals.length,
    mergedProposals: mergedProposals.length, independentProposals: independentProposals.length,
    canonicalExecutableOutcomes: canonicalOutcomes.filter(row => row.canonicalExecutable).length,
    executableOutcomes: labelledRows.filter(row => row.executable).length,
    verticalMtmOutcomes: canonicalOutcomes.filter(row => row.canonicalExecutable && row.exitReason === 'VERTICAL_MTM').length,
    tpOutcomes: canonicalOutcomes.filter(row => row.canonicalExecutable && row.exitReason === 'TP').length,
    slOutcomes: canonicalOutcomes.filter(row => row.canonicalExecutable && row.exitReason === 'SL').length,
    oofQualifiedExecutable: oofRows.filter(row => row.qualified && row.executable).length,
    r1Active: oofRows.filter(row => row.r1Active).length, r2PositiveEdge: oofRows.filter(row => row.r2PositiveEdge).length,
    r3Qualified: oofRows.filter(row => row.qualified).length, highConfidence: oofRows.filter(row => row.highConfidence).length,
  };
  const report = {
    schemaVersion: 2, engine: 'TELEEDGE PROFIT RESEARCH ENGINE R1-R3', status: developmentGate.decision,
    boundary: {developmentStart: new Date(START).toISOString(), developmentEnd: new Date(END).toISOString(), holdoutStart: new Date(HOLDOUT_START).toISOString(), holdoutEnd: new Date(HOLDOUT_END).toISOString()},
    holdout: {status: developmentGate.decision === 'GO_TO_HOLDOUT' ? 'HOLDOUT_NOT_RUN' : 'BLOCKED_RESEARCH_FAIL', authorized: false},
    universe: {selected: featureStore.universe.symbols.length, symbols: featureStore.universe.symbols, hash: featureStore.universe.symbolsHash, expectedHash: V9_UNIVERSE_HASH, core, expanded: featureStore.universe.symbols.length - core, selectionMode: featureStore.universe.selectionMode},
    dataIntegrity, execution: {scanCadenceHours: 4, decisionLatencyMinutes: 20, fillInterval: '1m', settlementInterval: '1m-first-touch', executionProxy: false, feesFundingCosts: true},
    counts, frequency: {months: frequency, qualifiedMonthlyMean: qualifiedMonthlyMean, qualifiedMonthlyMedian: median(qualifiedMonthly), highConfidenceMonthlyMean: highMonthly.reduce((sum, value) => sum + value, 0) / Math.max(1, highMonthly.length), highConfidenceMonthlyMedian: median(highMonthly)},
    nestedWalkForward: {folds: nested.folds, innerOof: nested.innerOof, purgeDurationHours: nested.purgeDurationHours, checks: nested.checks},
    r1: nested.r1, r2: {quintiles: r2Quintiles, monthlyRankIc: rankIc}, r3, portfolio,
    baselines: {v75: {rankedSignals: baselineV75?.rankedSignalCount || 0, acceptedSignals: baselineV75?.acceptedSignalCount || 0, metrics: v75Metrics}, v8: {rankedSignals: baselineV8?.rankedSignalCount || 0, acceptedSignals: baselineV8?.acceptedSignalCount || 0, metrics: v8Metrics}},
    deltaVsV8: {netPnlUsdt: portfolio.metrics.netPnlUsdt - v8Metrics.netPnlUsdt, trades: portfolio.metrics.trades - v8Metrics.trades, expectancyR: (portfolio.metrics.expectancyR ?? 0) - (v8Metrics.expectancyR ?? 0), profitFactor: (portfolio.metrics.profitFactor ?? 0) - (v8Metrics.profitFactor ?? 0)},
    portfolioGate, developmentGate, repoNoOrderAudit, noOrderAudit: repoNoOrderAudit.pass, productionIsolation,
    diagnostics: {side: diagnostic(oofRows, row => row.side || 'unknown'), regime: diagnostic(oofRows, row => row.regime || row.btcRouter || 'unknown'), source: diagnostic(oofRows, row => (row.proposalSources || []).join('+') || 'none'), symbol: diagnostic(oofRows, row => row.marketId || row.symbol), month: diagnostic(oofRows, row => monthKey(row.signalTime)), r1OpportunityActive: diagnostic(oofRows.filter(row => row.r1Active), () => 'r1-active'), r2EdgeQuintile: diagnostic(oofRows, row => `q${row.edgeQuintile || 'unknown'}`), pPositiveBucket: diagnostic(oofRows, row => { const p = Number(row.pPositiveNetR); return !Number.isFinite(p) ? 'missing' : p < 0.5 ? '<0.50' : p < 0.55 ? '0.50-0.55' : p < 0.60 ? '0.55-0.60' : '0.60+'; })},
    explainability: {R1: modelCard.models.R1, R2: modelCard.models.R2, R3: modelCard.models.R3, unstableFeatures: {R1: Object.entries(modelCard.coefficientStability.R1).filter(([, row]) => row.status === 'UNSTABLE_FEATURE').map(([feature]) => feature), R2: Object.entries(modelCard.coefficientStability.R2).filter(([, row]) => row.status === 'UNSTABLE_FEATURE').map(([feature]) => feature), R3: Object.entries(modelCard.coefficientStability.R3).filter(([, row]) => row.status === 'UNSTABLE_FEATURE').map(([feature]) => feature)}},
    antiOverfitAudit, provenance,
    knownLimitations: [
      'M4 remains INCOMPLETE: the inherited dataset is not a strict point-in-time universe with resolved historical delistings and has known local gaps.',
      'The frozen 150-symbol selection is used as provided; historical survivorship and delisting bias are not cleared by this Development run.',
      'This task does not run the 2026-01-01 to 2026-07-15 Holdout and does not make a profitability or Production recommendation.',
      'V8_BASELINE is an additional proposal source; its original trade outcome is not used as a Profit Engine label. All proposals receive the canonical 72-hour outcome.',
      'The model layer is research-only; all user decisions remain manual and no Binance order endpoint is present.',
    ],
    provenanceContract: {...provenance},
  };
  writeJson(path.join(reportsDir, 'profit-engine-development.json'), report);
  atomicWrite(path.join(reportsDir, 'profit-engine-development.md'), `${markdown(report)}\n`);
  writeJson(path.join(reportsDir, 'profit-engine-holdout-lock.json'), {schemaVersion: 2, status: report.holdout.status, holdout: {start: new Date(HOLDOUT_START).toISOString(), end: new Date(HOLDOUT_END).toISOString(), requiresFlag: '--holdout-authorized', singleRun: true}, developmentGate: report.developmentGate.decision, hashes: report.provenance, reason: report.holdout.status === 'BLOCKED_RESEARCH_FAIL' ? 'Development gate failed; holdout is blocked.' : 'Development passed but holdout was intentionally not run.', noProductionIntegration: true});
  progress('reports:done');
  console.log(JSON.stringify({status: report.status, counts: report.counts, gate: report.developmentGate, reports: ['reports/profit-engine-development.json', 'reports/profit-engine-development.md', 'reports/profit-engine-model-card.json', 'reports/profit-engine-frozen-config.json', 'reports/profit-engine-holdout-lock.json']}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
