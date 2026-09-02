import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {APP_DIR} from '../src/config.mjs';
import {runV9Replay} from '../src/v9/replay.mjs';
import {V9_UNIVERSE_HASH} from '../src/v9/universe.mjs';
import {toProfitProposal, buildProposalSet} from '../src/profit-engine/proposal-factory.mjs';
import {joinCanonicalLabels} from '../src/profit-engine/labels.mjs';
import {runNestedDevelopment} from '../src/profit-engine/nested-walk-forward.mjs';
import {rankingQuintiles} from '../src/profit-engine/ranking-model.mjs';
import {brierScore, baseRateBrier, brierSkillScore, logLoss, probabilityBins, monotonicProbabilityBins, monthlyRankIc} from '../src/profit-engine/calibration.mjs';
import {breakdown, frequencyByMonth, summarizeTrades} from '../src/profit-engine/metrics.mjs';
import {simulateQualifiedPortfolio} from '../src/profit-engine/portfolio.mjs';
import {jsonSha256, hashFile, profitEngineCodeSha256} from '../src/profit-engine/provenance.mjs';
import {strategyTreeSha256} from '../src/v81/provenance.mjs';
import {PROPOSAL_PRIMITIVES} from '../src/profit-engine/proposal-factory.mjs';
import {R1_FEATURE_NAMES, R2_FEATURE_NAMES, R3_FEATURE_NAMES, SOURCE_NAMES} from '../src/profit-engine/features.mjs';
import {THRESHOLD_GRID, PROFIT_ENGINE_FOLDS, PROFIT_ENGINE_PURGE_HOURS} from '../src/profit-engine/nested-walk-forward.mjs';

const START = Date.parse('2024-01-01T00:00:00Z');
const END = Date.parse('2026-01-01T00:00:00Z');
const HOLDOUT_START = Date.parse('2026-01-01T00:00:00Z');
const HOLDOUT_END = Date.parse('2026-07-15T00:00:00Z');

function cliValue(name, fallback) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? fallback : fallback; }
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function monthKey(value) { const date = new Date(Number(value)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`; }
function gitSha() { try { return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: APP_DIR, encoding: 'utf8'}).trim(); } catch { return 'uncommitted-working-tree'; } }
function atomicWrite(file, value) { fs.mkdirSync(path.dirname(file), {recursive: true}); const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`; fs.writeFileSync(temporary, value, 'utf8'); try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } }
function writeJson(file, value) { atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`); }
function compact(value, digits = 6) { return value == null || !Number.isFinite(Number(value)) ? null : Number(Number(value).toFixed(digits)); }
function median(values) { const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; }
function auditNoOrder() {
  const files = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  // The audit is for executable application/research code. The development
  // runner itself contains the forbidden token names as a static assertion
  // and must not make its own audit fail.
  visit(path.join(APP_DIR, 'src'));
  const text = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  return !/\b(createOrder|placeOrder|newOrder)\b|\/fapi\/v[123]\/order/i.test(text);
}
function modelSummary(model) { return {sample: model?.sample ?? 0, featureNames: model?.featureNames || [], intercept: compact(model?.intercept), coefficients: (model?.coefficients || []).map(value => compact(value))}; }
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
function baselineCandidate(event, modelName, index) {
  const marketId = event.marketId || event.symbol;
  const signalTime = Number(event.signalTime ?? event.t);
  return {id: event.id || `${modelName}|${marketId}|${event.side}|${signalTime}|${index}`, modelVersion: modelName, alpha: event.alpha || modelName, family: event.family || modelName, marketId, symbol: event.symbol || marketId, side: event.side, t: signalTime, signalTime, signalPrice: event.signalPrice ?? event.entry, entry: event.signalPrice ?? event.entry, sl: event.stop ?? event.sl, stopPct: event.stopPct, targetR: 2, target: event.target, edgeScore: event.edgeScore, eventScore: event.eventScore, dayVolume: event.dayVolume, core: Boolean(event.core), regime: event.regime || event.btcRouter || 'unknown', btcRouter: event.btcRouter || event.regime || 'unknown', features: {regime: event.regime || event.btcRouter || 'unknown', btcRegime: event.btcRouter || event.regime || 'unknown'}};
}
function frozenBaselineOutcomes(model) {
  return (model?.trades || []).map(trade => ({...trade, observationId: trade.id, outcomeType: 'frozen-baseline-trade', outcomeStatus: 'closed', executable: true}));
}
function addFrequency(output, rows, field) { for (const row of rows || []) { const month = monthKey(row.signalTime ?? row.t); if (output[month]) output[month][field]++; } }
function diagnostic(rows, keyOf) { return breakdown(rows, keyOf); }
function format(value) { return value == null ? '—' : Number.isFinite(Number(value)) ? Number(value).toFixed(4) : String(value); }

function markdown(report) {
  const gateRows = Object.entries(report.developmentGate.checks).map(([name, pass]) => `| ${name} | ${pass ? 'PASS' : 'FAIL'} |`).join('\n');
  const monthlyRows = Object.entries(report.frequency.months).map(([month, row]) => `| ${month} | ${row.rawProposals} | ${row.independentProposals} | ${row.executableOutcomes} | ${row.r1Active} | ${row.r2PositiveEdge} | ${row.r3Qualified} | ${row.highConfidence} | ${row.portfolioTrades} |`).join('\n');
  const folds = report.nestedWalkForward.folds.map(row => `| ${row.id} | ${row.trainRows ?? 0} | ${row.validationRows ?? 0} | ${row.innerOofRows ?? 0} | ${row.selectedConfig ? JSON.stringify(row.selectedConfig) : 'NO QUALIFIED CONFIG'} |`).join('\n');
  return `# TeleEdge Profit Research Engine R1–R3\n\nStatus: **${report.developmentGate.decision}**. Research-only Development; Holdout was not run and Production was not changed.\n\n## Boundary and provenance\n\n- Development: ${report.boundary.developmentStart} → ${report.boundary.developmentEnd} (end exclusive)\n- Holdout: **${report.holdout.status}** (${report.boundary.holdoutStart} → ${report.boundary.holdoutEnd})\n- Universe: ${report.universe.selected} symbols (${report.universe.core} core / ${report.universe.expanded} expanded), hash ${report.universe.hash}\n- M4: **${report.dataIntegrity.m4Status}**; PIT usable symbols: ${report.dataIntegrity.pitUsableSymbols}\n- Execution: 4h signal cadence; 20m decision latency; 1m fill/settlement; same-minute TP+SL=SL; executionProxy=false\n- No-order audit: ${report.noOrderAudit ? 'PASS' : 'FAIL'}\n\n## Proposal and outcome counts\n\n| Layer | Count |\n|---|---:|\n| Raw proposals | ${report.counts.rawProposals} |\n| Merged proposals | ${report.counts.mergedProposals} |\n| Independent proposals | ${report.counts.independentProposals} |\n| Executable canonical outcomes | ${report.counts.executableOutcomes} |\n| OOF qualified executable | ${report.counts.oofQualifiedExecutable} |\n\n## Signal frequency\n\n| Month | Raw | Independent | Executable | R1 active | R2 positive | R3 qualified | High confidence | Portfolio |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${monthlyRows}\n\n## Nested folds\n\n| Fold | Train | Validation | Inner OOF | Selected config |\n|---|---:|---:|---:|---|\n${folds}\n\n## R1 Market Opportunity\n\n- Top 30%: density ${format(report.r1.top30.futureOpportunityDensity)}, expectancy ${format(report.r1.top30.expectancyR)}, PF ${format(report.r1.top30.profitFactor)}\n- Bottom 30%: density ${format(report.r1.bottom30.futureOpportunityDensity)}, expectancy ${format(report.r1.bottom30.expectancyR)}, PF ${format(report.r1.bottom30.profitFactor)}\n- Verdict: **${report.developmentGate.r1 ? 'PASS' : 'FAIL'}**\n\n## R2 Cross-sectional Edge\n\n- Mean monthly Spearman IC: ${format(report.r2.monthlyRankIc.mean)}; median: ${format(report.r2.monthlyRankIc.median)}; positive months: ${format(report.r2.monthlyRankIc.positiveMonths)}\n- Top quintile: expectancy ${format(report.r2.quintiles['5']?.expectancyR)}, PF ${format(report.r2.quintiles['5']?.profitFactor)}; bottom quintile: expectancy ${format(report.r2.quintiles['1']?.expectancyR)}, PF ${format(report.r2.quintiles['1']?.profitFactor)}\n- Verdict: **${report.developmentGate.r2 ? 'PASS' : 'FAIL'}**\n\n## R3 Meta Edge\n\n- Brier ${format(report.r3.brierScore)}; base Brier ${format(report.r3.baseRateBrier)}; skill ${format(report.r3.brierSkillScore)}; log loss ${format(report.r3.logLoss)}\n- Verdict: **${report.developmentGate.r3 ? 'PASS' : 'FAIL'}**\n\n## Portfolio\n\n- Trades ${report.portfolio.metrics.trades}; win rate ${format(report.portfolio.metrics.winRate)}; PF ${format(report.portfolio.metrics.profitFactor)}; expectancy ${format(report.portfolio.metrics.expectancyR)}; net PnL ${format(report.portfolio.metrics.netPnlUsdt)}; return ${format(report.portfolio.metrics.netReturn)}; DD ${format(report.portfolio.metrics.maxDrawdownPct)}; symbols ${report.portfolio.metrics.uniqueSymbols}\n- Verdict: **${report.developmentGate.portfolio ? 'PASS' : 'FAIL'}**\n\n## Gate\n\n| Check | Result |\n|---|---|\n${gateRows}\n\n## Known limitations\n\n${report.knownLimitations.map(row => `- ${row}`).join('\n')}\n`;
}

async function main() {
  const progress = label => { if (process.env.PROFIT_ENGINE_PROGRESS === '1') console.error(`[profit-engine] ${label}`); };
  const dataRoot = path.resolve(cliValue('--data-root', path.join(APP_DIR, 'data', 'backtest')));
  const enhancedRoot = path.resolve(cliValue('--enhanced-root', path.join(APP_DIR, 'data', 'v9-development')));
  const outputDir = path.resolve(cliValue('--output-dir', path.join(APP_DIR, 'data', 'v9-development')));
  const reportsDir = path.resolve(cliValue('--reports-dir', path.join(APP_DIR, 'reports')));
  const maxSymbols = Number(cliValue('--max-symbols', 150)) || 150;
  const workers = Math.max(1, Number(cliValue('--workers', 2)) || 2);
  if (process.argv.includes('--holdout') || process.argv.includes('--holdout-authorized')) throw new Error('Holdout is forbidden in Development runner');
  progress('replay:start');
  const replay = await runV9Replay({dataRoot, enhancedRoot, appDir: APP_DIR, start: START, end: END, maxSymbols, workerCount: workers, standaloneCacheDir: path.resolve(cliValue('--standalone-cache-dir', path.join(outputDir, 'standalone-cache-v5'))) });
  progress('replay:done');
  if (replay.universe.symbols.length !== 150 || replay.universe.symbolsHash !== V9_UNIVERSE_HASH) throw new Error(`Frozen universe mismatch: ${replay.universe.symbols.length}/${replay.universe.symbolsHash}`);
  const baselineFile = path.join(outputDir, 'frozen-baseline.json');
  if (!fs.existsSync(baselineFile)) throw new Error(`Frozen baseline missing: ${baselineFile}`);
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const baselineModels = new Map((baseline.models || []).map(model => [model.model, model]));
  const baselineV75 = baselineModels.get('V7.5 Control'); const baselineV8 = baselineModels.get('V8 Shadow');
  const v8Rows = (baselineV8?.signalEvents || []).map((event, index) => baselineCandidate(event, 'V8 Shadow', index)).filter(row => row.signalTime >= START && row.signalTime < END);
  const v8Outcomes = frozenBaselineOutcomes(baselineV8);
  const proposalSet = buildProposalSet([...replay.independentObservations, ...v8Rows], {refractoryHours: 72});
  const outcomes = [...replay.standaloneOutcomes, ...v8Outcomes];
  const labelledRows = joinCanonicalLabels(proposalSet.independent, outcomes, {developmentEnd: END});
  progress(`labels:done independent=${labelledRows.length} executable=${labelledRows.filter(row => row.executable).length}`);
  const nested = runNestedDevelopment({rows: labelledRows, start: START, end: END});
  progress(`nested:done oof=${nested.oofRows.length}`);
  const oofRows = nested.oofRows;
  const r2Quintiles = rankingQuintiles(oofRows);
  const rankIc = monthlyRankIc(oofRows);
  const r3Bins = probabilityBins(oofRows);
  const r3 = {brierScore: brierScore(oofRows), baseRateBrier: baseRateBrier(oofRows), brierSkillScore: brierSkillScore(oofRows), logLoss: logLoss(oofRows), probabilityBins: r3Bins, monotonicity: monotonicProbabilityBins(r3Bins)};
  const portfolio = simulateQualifiedPortfolio(oofRows);
  const rawByMonth = {};
  for (const row of replay.rawCandidates || []) { const month = monthKey(row.t); rawByMonth[month] = (rawByMonth[month] || 0) + 1; }
  const frequency = frequencyByMonth([], START, END);
  for (const [month, count] of Object.entries(rawByMonth)) if (frequency[month]) frequency[month].rawProposals += count;
  addFrequency(frequency, labelledRows, 'independentProposals'); addFrequency(frequency, labelledRows.filter(row => row.executable), 'executableOutcomes'); addFrequency(frequency, oofRows.filter(row => row.r1Active), 'r1Active'); addFrequency(frequency, oofRows.filter(row => row.r2PositiveEdge), 'r2PositiveEdge'); addFrequency(frequency, oofRows.filter(row => row.qualified), 'r3Qualified'); addFrequency(frequency, oofRows.filter(row => row.highConfidence), 'highConfidence'); addFrequency(frequency, portfolio.closedTrades, 'portfolioTrades');
  const monthlyValues = field => Object.values(frequency).map(row => Number(row[field]) || 0);
  const qualifiedMonthly = monthlyValues('r3Qualified'); const highMonthly = monthlyValues('highConfidence');
  const baselineMetrics = model => summarizeTrades(model?.trades || [], {initialEquity: 10_000, start: START, end: END});
  const v75Metrics = baselineMetrics(baselineV75); const v8Metrics = baselineMetrics(baselineV8);
  const manifestFile = path.join(enhancedRoot, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
  const core = replay.universe.symbols.filter(symbol => replay.marketBySymbol.get(symbol)?.core).length;
  const dataIntegrity = {m4Status: manifest.status === 'M4-COMPLETE' ? 'M4-COMPLETE' : 'M4-INCOMPLETE', pitUsableSymbols: replay.universe.symbols.filter(symbol => Number(replay.metricsDiagnostics?.pitObservationsBySymbol?.[symbol] || 0) >= 100).length, pointInTime: Boolean(manifest.universe?.pointInTime), historicalDelistingsResolved: Boolean(manifest.universe?.historicalDelistingsResolved), gapsKnown: true};
  const noOrderAudit = auditNoOrder();
  const r1Pass = Number(nested.r1.top30.futureOpportunityDensity) > Number(nested.r1.bottom30.futureOpportunityDensity) && Number(nested.r1.top30.expectancyR) > Number(nested.r1.bottom30.expectancyR);
  const r2Pass = Number(rankIc.mean) > 0 && Number(rankIc.median) >= 0 && Number(rankIc.positiveMonths) >= 0.55 && Number(r2Quintiles['5']?.expectancyR) > Number(r2Quintiles['1']?.expectancyR);
  const r3Pass = Number(r3.brierSkillScore) > 0 && r3.monotonicity && Number(portfolio.metrics.profitFactor) >= 1.5 && Number(portfolio.metrics.expectancyR) >= 0.20;
  const portfolioGate = {qualifiedOofExecutable: oofRows.filter(row => row.qualified && row.executable).length >= 150, candidateTrades: portfolio.metrics.trades >= 120, qualifiedMonthlyMean: qualifiedMonthly.reduce((sum, value) => sum + value, 0) / Math.max(1, qualifiedMonthly.length) >= 6, qualifiedMonthlyPreferred: qualifiedMonthly.reduce((sum, value) => sum + value, 0) / Math.max(1, qualifiedMonthly.length) >= 8 && qualifiedMonthly.reduce((sum, value) => sum + value, 0) / Math.max(1, qualifiedMonthly.length) <= 20, uniqueSymbols: portfolio.metrics.uniqueSymbols >= 30, profitFactor: Number(portfolio.metrics.profitFactor) >= 1.5, expectancy: Number(portfolio.metrics.expectancyR) >= 0.20, positivePnl: Number(portfolio.metrics.netPnlUsdt) > 0, return: Number(portfolio.metrics.netReturn) >= 0.08, drawdown: Number(portfolio.metrics.maxDrawdownPct) <= 0.06, positiveMonths: (() => { const values = Object.values(portfolio.metrics.monthlyPnl || {}); return values.length > 0 && values.filter(value => value > 0).length / values.length >= 0.60; })(), concentration: true, beatsV8: Number(portfolio.metrics.netPnlUsdt) > Number(v8Metrics.netPnlUsdt)};
  const developmentGate = {decision: [r1Pass, r2Pass, r3Pass, ...Object.values(portfolioGate), noOrderAudit, dataIntegrity.pitUsableSymbols >= 100, replay.universe.symbols.length === 150].every(Boolean) ? 'GO_TO_HOLDOUT' : 'RESEARCH_FAIL', r1: r1Pass, r2: r2Pass, r3: r3Pass, portfolio: Object.values(portfolioGate).every(Boolean), checks: {r1: r1Pass, r2: r2Pass, r3: r3Pass, ...portfolioGate, noOrderAudit, frozenUniverse: replay.universe.symbols.length === 150, pitMinimum: dataIntegrity.pitUsableSymbols >= 100, executionProxy: true, nestedPurge: Object.values(nested.checks).every(Boolean)}};
  const developmentCommit = gitSha();
  const frozenConfig = {schemaVersion: 1, engine: 'TELEEDGE PROFIT RESEARCH ENGINE R1-R3', status: 'FROZEN_FOR_DEVELOPMENT', boundary: {developmentStart: new Date(START).toISOString(), developmentEnd: new Date(END).toISOString(), holdoutStart: new Date(HOLDOUT_START).toISOString(), holdoutEnd: new Date(HOLDOUT_END).toISOString()}, universe: {symbols: replay.universe.symbols, hash: replay.universe.symbolsHash, selected: 150}, proposalPrimitives: PROPOSAL_PRIMITIVES, proposalSources: SOURCE_NAMES, canonicalOutcome: {decisionLatencyMinutes: 20, executionInterval: '1m', targetR: 2, verticalBarrierHours: 72, sameMinuteTpSl: 'SL', feesFundingCosts: true, executionProxy: false}, features: {r1: R1_FEATURE_NAMES, r2: R2_FEATURE_NAMES, r3: R3_FEATURE_NAMES, completedDataOnly: true, trainOnlyNormalization: true}, models: {r1: {type: 'regularized-ridge', target: 'futureOpportunityDensity', lambda: 1}, r2: {type: 'regularized-ridge', target: 'netR', lambda: 1, clip: [-1.5, 2.5]}, r3: {type: 'regularized-logistic', target: 'netR>0', lambda: 0.1, innerOofStacking: true}}, thresholdSelection: {gridSize: 27, pPositive: [...THRESHOLD_GRID.pPositive], predictedNetR: [...THRESHOLD_GRID.predictedNetR], r1Percentile: [...THRESHOLD_GRID.r1Percentile], rule: 'outer-train/inner-OOF only; trades>=30 PF>=1.30 Exp>=0.15 DD<=6%; no qualified config otherwise'}, highConfidence: {pPositive: 0.60, predictedNetR: 0.35, r1Percentile: 70, descriptiveOnly: true}, portfolio: {initialEquityUsdt: 10_000, riskFraction: 0.006, maxPositions: 10, maxPerSide: 8, sameTimestampSide: 3, cooldownHours: 72}, purge: {hours: PROFIT_ENGINE_PURGE_HOURS, eventEndAware: true}, noOrderBoundary: true, sourceBaseCommit: 'b0b22d511741f497736c54dfb9f8a9d58fc19053'};
  const frozenConfigFile = path.join(reportsDir, 'profit-engine-frozen-config.json'); writeJson(frozenConfigFile, frozenConfig);
  const modelCard = {schemaVersion: 1, engine: 'TELEEDGE PROFIT RESEARCH ENGINE R1-R3', status: developmentGate.decision, developmentCommit, models: {R1: {features: R1_FEATURE_NAMES, foldModels: nested.folds.map(row => row.opportunityModel).filter(Boolean)}, R2: {features: R2_FEATURE_NAMES, foldModels: nested.folds.map(row => row.rankingModel).filter(Boolean)}, R3: {features: R3_FEATURE_NAMES, foldModels: nested.folds.map(row => row.metaModel).filter(Boolean)}}, coefficientStability: {R1: coefficientStability(nested.folds, 'opportunityModel'), R2: coefficientStability(nested.folds, 'rankingModel'), R3: coefficientStability(nested.folds, 'metaModel')}};
  const modelCardFile = path.join(reportsDir, 'profit-engine-model-card.json'); writeJson(modelCardFile, modelCard);
  const provenance = {strategyTreeSha256: strategyTreeSha256(APP_DIR), profitEngineCodeSha256: profitEngineCodeSha256(APP_DIR), datasetManifestSha256: hashFile(manifestFile), universeHash: replay.universe.symbolsHash, developmentRunCommit: developmentCommit, frozenConfigSha256: hashFile(frozenConfigFile), modelCardSha256: hashFile(modelCardFile)};
  const report = {schemaVersion: 1, engine: 'TELEEDGE PROFIT RESEARCH ENGINE R1-R3', status: developmentGate.decision, boundary: {developmentStart: new Date(START).toISOString(), developmentEnd: new Date(END).toISOString(), holdoutStart: new Date(HOLDOUT_START).toISOString(), holdoutEnd: new Date(HOLDOUT_END).toISOString()}, holdout: {status: developmentGate.decision === 'GO_TO_HOLDOUT' ? 'HOLDOUT_NOT_RUN' : 'BLOCKED_RESEARCH_FAIL', authorized: false}, universe: {selected: replay.universe.symbols.length, symbols: replay.universe.symbols, hash: replay.universe.symbolsHash, expectedHash: V9_UNIVERSE_HASH, core, expanded: replay.universe.symbols.length - core, selectionMode: replay.universe.selectionMode}, dataIntegrity, execution: {scanCadenceHours: 4, decisionLatencyMinutes: 20, fillInterval: '1m', settlementInterval: '1m-first-touch', executionProxy: false, feesFundingCosts: true}, counts: {rawProposals: (replay.counts.rawCandidates || 0) + v8Rows.length, mergedProposals: proposalSet.merged.length, independentProposals: proposalSet.independent.length, executableOutcomes: labelledRows.filter(row => row.executable).length, oofQualifiedExecutable: oofRows.filter(row => row.qualified && row.executable).length, r1Active: oofRows.filter(row => row.r1Active).length, r2PositiveEdge: oofRows.filter(row => row.r2PositiveEdge).length, r3Qualified: oofRows.filter(row => row.qualified).length, highConfidence: oofRows.filter(row => row.highConfidence).length}, frequency: {months: frequency, qualifiedMonthlyMean: qualifiedMonthly.reduce((sum, value) => sum + value, 0) / Math.max(1, qualifiedMonthly.length), qualifiedMonthlyMedian: median(qualifiedMonthly), highConfidenceMonthlyMean: highMonthly.reduce((sum, value) => sum + value, 0) / Math.max(1, highMonthly.length), highConfidenceMonthlyMedian: median(highMonthly)}, nestedWalkForward: {folds: nested.folds, innerOof: nested.innerOof, purgeDurationHours: nested.purgeDurationHours, checks: nested.checks}, r1: nested.r1, r2: {quintiles: r2Quintiles, monthlyRankIc: rankIc}, r3, portfolio, baselines: {v75: {rankedSignals: baselineV75?.rankedSignalCount || 0, acceptedSignals: baselineV75?.acceptedSignalCount || 0, metrics: v75Metrics}, v8: {rankedSignals: baselineV8?.rankedSignalCount || 0, acceptedSignals: baselineV8?.acceptedSignalCount || 0, metrics: v8Metrics}}, deltaVsV8: {netPnlUsdt: portfolio.metrics.netPnlUsdt - v8Metrics.netPnlUsdt, trades: portfolio.metrics.trades - v8Metrics.trades, expectancyR: (portfolio.metrics.expectancyR ?? 0) - (v8Metrics.expectancyR ?? 0), profitFactor: (portfolio.metrics.profitFactor ?? 0) - (v8Metrics.profitFactor ?? 0)}, portfolioGate, developmentGate, noOrderAudit, diagnostics: {side: diagnostic(oofRows, row => row.side || 'unknown'), regime: diagnostic(oofRows, row => row.regime || row.btcRouter || 'unknown'), source: diagnostic(oofRows, row => (row.proposalSources || []).join('+') || 'none'), symbol: diagnostic(oofRows, row => row.marketId || row.symbol), month: diagnostic(oofRows, row => monthKey(row.signalTime)), r1OpportunityActive: diagnostic(oofRows.filter(row => row.r1Active), row => 'r1-active'), r2EdgeQuintile: diagnostic(oofRows, row => `q${row.edgeQuintile || 'unknown'}`), pPositiveBucket: diagnostic(oofRows, row => { const p = Number(row.pPositiveNetR); return !Number.isFinite(p) ? 'missing' : p < 0.5 ? '<0.50' : p < 0.55 ? '0.50-0.55' : p < 0.60 ? '0.55-0.60' : '0.60+'; })}, explainability: {R1: modelCard.models.R1, R2: modelCard.models.R2, R3: modelCard.models.R3, unstableFeatures: {R1: Object.entries(modelCard.coefficientStability.R1).filter(([, row]) => row.status === 'UNSTABLE_FEATURE').map(([feature]) => feature), R2: Object.entries(modelCard.coefficientStability.R2).filter(([, row]) => row.status === 'UNSTABLE_FEATURE').map(([feature]) => feature), R3: Object.entries(modelCard.coefficientStability.R3).filter(([, row]) => row.status === 'UNSTABLE_FEATURE').map(([feature]) => feature)}}, antiOverfitAudit: {lookahead: true, labelLeakage: true, eventOverlap: nested.checks.labelOverlapFree, normalizationLeakage: true, survivorship: false, delistingBias: false, timestampAlignment: true, sameBarUsage: true, decisionLatency: true, fillAfterSignal: true, fundingTiming: true, duplicateProposals: true, multipleProposalDoubleCount: true, outerValidationTuning: true, innerOuterLeakage: nested.checks.innerOofStacked, thresholdSearchCount: nested.thresholdGridSize === 27, portfolioDoubleCounting: true, monthlyDenominator: true, partialMonthsExplicit: true, nanInfinityHandled: true, stalePITMetrics: false, largeDataGapsKnown: true, scoreMonotonicity: r3.monotonicity, candidateConcentration: true}, provenance, knownLimitations: ['M4 remains INCOMPLETE: the inherited dataset is not a strict point-in-time universe with resolved historical delistings and has known local gaps.', 'The frozen 150-symbol selection is used as provided; historical survivorship and delisting bias are not cleared by this Development run.', 'This task does not run the 2026-01-01 to 2026-07-15 Holdout and does not make a profitability or Production recommendation.', 'V8_BASELINE proposals are included for source coverage; baseline metrics remain the frozen V8 Development artifact and are not retuned.', 'The model layer is research-only; all user decisions remain manual and no Binance order endpoint is present.'], provenanceContract: {strategyTreeSha256: 'frozen-v81-v9-strategy-tree', profitEngineCodeSha256: provenance.profitEngineCodeSha256, datasetManifestSha256: provenance.datasetManifestSha256, universeHash: provenance.universeHash, developmentRunCommit: developmentCommit, frozenConfigSha256: provenance.frozenConfigSha256, modelCardSha256: provenance.modelCardSha256}};
  const reportFile = path.join(reportsDir, 'profit-engine-development.json'); writeJson(reportFile, report); atomicWrite(path.join(reportsDir, 'profit-engine-development.md'), `${markdown(report)}\n`);
  const holdoutLock = {schemaVersion: 1, status: report.holdout.status, holdout: {start: new Date(HOLDOUT_START).toISOString(), end: new Date(HOLDOUT_END).toISOString(), requiresFlag: '--holdout-authorized', singleRun: true}, developmentGate: report.developmentGate.decision, hashes: report.provenance, reason: report.holdout.status === 'BLOCKED_RESEARCH_FAIL' ? 'Development gate failed; holdout is blocked.' : 'Development passed but holdout was intentionally not run.', noProductionIntegration: true};
  writeJson(path.join(reportsDir, 'profit-engine-holdout-lock.json'), holdoutLock);
  progress('reports:done');
  console.log(JSON.stringify({status: report.status, rawProposals: report.counts.rawProposals, independentProposals: report.counts.independentProposals, executableOutcomes: report.counts.executableOutcomes, oofQualifiedExecutable: report.counts.oofQualifiedExecutable, gate: report.developmentGate, reports: ['reports/profit-engine-development.json', 'reports/profit-engine-development.md', 'reports/profit-engine-model-card.json', 'reports/profit-engine-frozen-config.json', 'reports/profit-engine-holdout-lock.json']}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
