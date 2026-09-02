import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {buildPrimitiveProposals, buildProposalSet, dedupeProfitEpisodes, mergeProfitProposals, primitiveDirectionsForPoint, PROPOSAL_PRIMITIVES, toProfitProposal} from '../src/profit-engine/proposal-factory.mjs';
import {CANONICAL_OUTCOME_CONTRACT, canonicalLabelFromOutcome, joinCanonicalLabels} from '../src/profit-engine/labels.mjs';
import {simulateCanonicalOutcome} from '../src/profit-engine/canonical-outcome.mjs';
import {fitOpportunityModel, buildOpportunityRows, opportunityDeciles} from '../src/profit-engine/opportunity-model.mjs';
import {fitRankingModel, rankCrossSection, rankingQuintiles} from '../src/profit-engine/ranking-model.mjs';
import {fitMetaEdgeModel} from '../src/profit-engine/meta-edge-model.mjs';
import {brierScore, baseRateBrier, brierSkillScore, logLoss, probabilityBins, monotonicProbabilityBins, spearman, monthlyRankIc} from '../src/profit-engine/calibration.mjs';
import {fitTrainNormalizer, normalizerSummary} from '../src/profit-engine/normalization.mjs';
import {metaCrossFit, runNestedDevelopment, selectThresholdConfig, thresholdCandidates, PROFIT_ENGINE_FOLDS} from '../src/profit-engine/nested-walk-forward.mjs';
import {simulateQualifiedPortfolio, PROFIT_PORTFOLIO_CONFIG} from '../src/profit-engine/portfolio.mjs';
import {frequencyByMonth, summarizeTrades} from '../src/profit-engine/metrics.mjs';
import {jsonSha256} from '../src/profit-engine/provenance.mjs';
import {auditRepoNoOrder} from '../src/profit-engine/audits.mjs';

const start = Date.parse('2024-01-01T00:00:00Z');

function candidate(id, t, overrides = {}) {
  return {id, marketId: `${id}USDT`, symbol: `${id}USDT`, side: 'long', t, signalTime: t, entry: 100, signalPrice: 100, sl: 95, stopPct: 0.05, targetR: 2, edgeScore: 10, eventScore: 2, dayVolume: 1000, family: 'research', features: {return12: 0.04, return3: 0.01, adx: 20, volumeRatio: 1.5, rangeRatio: 1.3, takerImbalance: 0.2, aggressiveVolumeZ: 1.5, fundingZ: 1.1, premiumZ: 0, oiZ: 0, crossSectionalReturnRank: 0.9, crossSectionalFlowRank: 0.8, regime: 'bull', ...overrides.features}, ...overrides};
}

function labelledRow(index, t = start + index * 7 * 86_400_000) {
  const row = candidate(`S${index}`, t, {side: index % 2 ? 'short' : 'long', edgeScore: index % 7, features: {return12: (index % 9 - 4) / 50, rangeRatio: 1 + (index % 4) / 10}});
  const netR = index % 3 === 0 ? 0.8 : index % 3 === 1 ? -0.35 : 0.15;
  return {...row, proposalSources: ['TREND_PRIMITIVE', 'FLOW_PRIMITIVE'], outcome: {labelUsable: true, netR, netPnlUsdt: netR * 60, positiveOpportunity: netR >= 0.5, exitTime: t + 20 * 60_000 + 2 * 86_400_000}, netR, netPnlUsdt: netR * 60, executable: true, decisionTime: t + 20 * 60_000, exitTime: t + 20 * 60_000 + 2 * 86_400_000};
}

function market(symbol = 'TESTUSDT') {
  return {symbol, filters: [{filterType: 'PRICE_FILTER', tickSize: '0.01'}, {filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001'}]};
}

function minute(t, {o = 100, h = 101, l = 99, c = 100} = {}) { return {t, o, h, l, c}; }

test('proposal factory uses fixed preregistered primitives and merges source flags', () => {
  assert.equal(PROPOSAL_PRIMITIVES.FLOW_PRIMITIVE.takerImbalanceAbsMin, 0.12);
  const rows = [candidate('A', 1000), candidate('B', 1000, {marketId: 'AUSDT', symbol: 'AUSDT', id: 'B', edgeScore: 20, features: {fundingZ: 2}})];
  const merged = mergeProfitProposals(buildProposalSet(rows).raw);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'B');
  assert.deepEqual(merged[0].proposalSources, ['CROSS_SECTION_PRIMITIVE', 'CROWDING_PRIMITIVE', 'FLOW_PRIMITIVE', 'TREND_PRIMITIVE', 'VOLATILITY_PRIMITIVE']);
  assert.equal(merged[0].proposalSourceFlags.FLOW_PRIMITIVE, true);
});

test('proposal episode dedupe is deterministic and refractory is 72 hours', () => {
  const rows = [candidate('A', 0), candidate('A', 71 * 3_600_000, {id: 'late', marketId: 'AUSDT'}), candidate('A', 72 * 3_600_000, {id: 'next', marketId: 'AUSDT'})];
  const independent = dedupeProfitEpisodes(mergeProfitProposals(buildProposalSet(rows).raw));
  assert.deepEqual(independent.map(row => row.id), ['A', 'next']);
});

test('canonical labels enforce 20-minute decision and 72-hour barrier without changing production time exit', () => {
  const t = Date.parse('2024-01-01T00:00:00Z');
  const label = canonicalLabelFromOutcome({signalTime: t, decisionTime: t + 20 * 60_000, fillTime: t + 20 * 60_000, exitTime: t + 21 * 60_000, executable: true, canonicalExecutable: true, netR: 0.6, exitReason: 'tp'}, {developmentEnd: t + 72 * 3_600_000 + 20 * 60_000});
  assert.equal(CANONICAL_OUTCOME_CONTRACT.decisionLatencyMinutes, 20);
  assert.equal(label.labelUsable, true);
  assert.equal(label.positiveOpportunity, true);
  assert.equal(label.canonicalOutcomeType, 'TP');
  const censored = canonicalLabelFromOutcome({...label, exitTime: t + 1}, {developmentEnd: t + 1});
  assert.equal(censored.labelUsable, false);
});

test('canonical TP outcome uses the first executable 1m touch before 72h', () => {
  const t = Date.parse('2024-01-01T00:00:00Z');
  const row = candidate('TP', t, {marketId: 'TPUSDT', symbol: 'TPUSDT', side: 'long', sl: 95, stop: 95, family: 'research'});
  const decision = t + 20 * 60_000;
  const outcome = simulateCanonicalOutcome(row, {market: market('TPUSDT'), minuteRows: [minute(decision), minute(decision + 60_000, {h: 110, c: 109})]});
  assert.equal(outcome.canonicalExecutable, true);
  assert.equal(outcome.exitReason, 'TP');
  assert.equal(outcome.fillTime, decision);
  assert.equal(outcome.target, 110);
  assert.equal(outcome.canonicalDurationHours <= 72, true);
});

test('canonical fill ignores a price touch from a minute before decision time', () => {
  const t = Date.parse('2024-01-01T00:00:00Z');
  const decision = t + 20 * 60_000;
  const barrierMinute = decision + 72 * 3_600_000 - 60_000;
  const outcome = simulateCanonicalOutcome(candidate('FILL', t, {marketId: 'FILLUSDT', symbol: 'FILLUSDT'}), {
    market: market('FILLUSDT'),
    minuteRows: [
      minute(decision - 60_000, {h: 110, c: 110}),
      minute(decision, {h: 101, l: 99, c: 100}),
      minute(barrierMinute, {h: 101, l: 99, c: 100}),
    ],
  });
  assert.equal(outcome.fillTime, decision);
  assert.equal(outcome.exitReason, 'VERTICAL_MTM');
});

test('canonical SL and same-minute TP/SL outcomes prioritize the stop', () => {
  const t = Date.parse('2024-01-01T00:00:00Z');
  const decision = t + 20 * 60_000;
  const base = candidate('SL', t, {marketId: 'SLUSDT', symbol: 'SLUSDT', side: 'long', sl: 95, stop: 95, family: 'research'});
  const sl = simulateCanonicalOutcome(base, {market: market('SLUSDT'), minuteRows: [minute(decision, {h: 101, l: 95, c: 96})]});
  assert.equal(sl.exitReason, 'SL');
  const same = simulateCanonicalOutcome({...base, id: 'SAME', marketId: 'SAMEUSDT', symbol: 'SAMEUSDT'}, {market: market('SAMEUSDT'), minuteRows: [minute(decision, {h: 110, l: 95, c: 100})]});
  assert.equal(same.exitReason, 'SL');
  assert.equal(same.ambiguousSameMinute, true);
});

test('canonical vertical MTM is a completed close no later than the 72h barrier', () => {
  const t = Date.parse('2024-01-01T00:00:00Z');
  const decision = t + 20 * 60_000;
  const barrierMinute = decision + 72 * 3_600_000 - 60_000;
  const row = candidate('VERT', t, {marketId: 'VERTUSDT', symbol: 'VERTUSDT', side: 'long', sl: 95, stop: 95});
  const outcome = simulateCanonicalOutcome(row, {market: market('VERTUSDT'), minuteRows: [minute(decision), minute(barrierMinute, {o: 102, h: 103, l: 101, c: 102})]});
  assert.equal(outcome.exitReason, 'VERTICAL_MTM');
  assert.equal(outcome.canonicalDurationHours <= 72, true);
  assert.equal(outcome.exitTime <= outcome.canonicalBarrierTime, true);
});

test('canonical funding is truncated at the canonical exit and never treats interval metadata as price', () => {
  const t = Date.parse('2024-01-01T00:00:00Z');
  const decision = t + 20 * 60_000;
  const barrierMinute = decision + 72 * 3_600_000 - 60_000;
  const row = candidate('FUND', t, {marketId: 'FUNDUSDT', symbol: 'FUNDUSDT', side: 'long', sl: 95, stop: 95});
  const outcome = simulateCanonicalOutcome(row, {
    market: market('FUNDUSDT'),
    minuteRows: [minute(decision, {c: 100}), minute(decision + 8 * 3_600_000, {c: 105}), minute(barrierMinute, {c: 101})],
    fundingRows: [{t: decision + 8 * 3_600_000, rate: 0.01, fundingIntervalHours: 8, markPrice: null}, {t: barrierMinute + 3_600_000, rate: 0.50, fundingIntervalHours: 8, markPrice: null}],
  });
  assert.equal(outcome.exitReason, 'VERTICAL_MTM');
  assert.equal(outcome.fundingEvents, 1);
  assert.equal(outcome.fallbackMarkPriceRows, 1);
  assert.equal(outcome.fundingPnlUsdt < 0, true);
  assert.equal(outcome.fundingPnlUsdt > -8 * outcome.quantity, true);
  assert.equal(outcome.modeledCostUsdt > 0, true);
});

test('old V9 duration/outcome fields cannot become a canonical label', () => {
  const t = Date.parse('2024-01-01T00:00:00Z');
  const label = canonicalLabelFromOutcome({signalTime: t, fillTime: t + 20 * 60_000, exitTime: t + 21 * 60_000, executable: true, canonicalExecutable: false, netR: 1, exitReason: 'TP'}, {developmentEnd: t + 4 * 86_400_000});
  assert.equal(label.labelUsable, false);
  assert.equal(label.canonicalOutcomeType, 'TP');
  const long = canonicalLabelFromOutcome({signalTime: t, fillTime: t + 20 * 60_000, exitTime: t + 73 * 3_600_000, executable: true, canonicalExecutable: true, netR: 1, exitReason: 'TP'});
  assert.equal(long.labelUsable, false);
  assert.equal(long.canonicalDurationValid, false);
});

test('joining labels never selects a duplicate source outcome based on future profitability', () => {
  const proposal = {...candidate('A', start), primaryObservationId: 'winner'};
  const joined = joinCanonicalLabels([proposal], [{observationId: 'winner', executable: true, canonicalExecutable: true, netR: -1, fillTime: start + 20 * 60_000, exitTime: start + 86_400_000}, {observationId: 'other', executable: true, canonicalExecutable: true, netR: 9}], {developmentEnd: start + 4 * 86_400_000});
  assert.equal(joined[0].netR, -1);
});

test('broad feature-only points generate proposals without a V9 alpha detector', () => {
  const t = start + 100 * 86_400_000;
  const point = {signalTime: t, close: 100, atr: 2, priorLow4: 95, priorHigh4: 105, return12: 0.04, return3: 0.01, adx: 20, regime: 'bull', takerImbalance: 0.2, aggressiveVolumeZ: 1.5, rangeRatio: 1.3, volumeRatio: 1.5, fundingZ: 0, premiumZ: 0, oiZ: 0, crossSectionalReturnRank: 0.9, crossSectionalFlowRank: 0.8};
  const proposals = buildPrimitiveProposals(new Map([['BROADUSDT', [{...point, marketId: 'BROADUSDT'}]]]), new Map([['BROADUSDT', market('BROADUSDT')]]));
  assert.equal(proposals.length > 0, true);
  assert.equal(proposals.every(row => row.modelVersion === 'TELEEDGE-PROFIT-ENGINE-R1-R3'), true);
  assert.equal(proposals.some(row => row.proposalSources.includes('TREND_PRIMITIVE')), true);
});

test('primitive directions are explicitly symmetric for long and short', () => {
  const positive = primitiveDirectionsForPoint({return12: 0.04, return3: -0.01, adx: 20, regime: 'bull', takerImbalance: 0.2, rangeRatio: 1.3, volumeRatio: 1.3, fundingZ: 0, premiumZ: 0, oiZ: 0, crossSectionalReturnRank: 0.9, crossSectionalFlowRank: 0.8});
  const negative = primitiveDirectionsForPoint({return12: -0.04, return3: 0.01, adx: 20, regime: 'bear', takerImbalance: -0.2, rangeRatio: 1.3, volumeRatio: 1.3, fundingZ: 0, premiumZ: 0, oiZ: 0, crossSectionalReturnRank: 0.1, crossSectionalFlowRank: 0.2});
  assert.equal(positive.some(row => row.source === 'TREND_PRIMITIVE' && row.side === 'long'), true);
  assert.equal(positive.some(row => row.source === 'PULLBACK_PRIMITIVE' && row.side === 'long'), true);
  assert.equal(negative.some(row => row.source === 'TREND_PRIMITIVE' && row.side === 'short'), true);
  assert.equal(negative.some(row => row.source === 'PULLBACK_PRIMITIVE' && row.side === 'short'), true);
  assert.equal(negative.some(row => row.source === 'FLOW_PRIMITIVE' && row.side === 'short'), true);
});

test('merged primitive and V8 proposals use one deterministic stop and preserve sources', () => {
  const t = start + 100 * 86_400_000;
  const features = {close: 100, atr: 2, priorLow4: 95, priorHigh4: 105, return12: 0.04, adx: 20, regime: 'bull'};
  const one = toProfitProposal({id: 'primitive', marketId: 'MERGEUSDT', symbol: 'MERGEUSDT', side: 'long', signalTime: t, t, signalPrice: 100, entry: 100, sl: 80, features, proposalSources: ['TREND_PRIMITIVE']});
  const two = toProfitProposal({id: 'v8', marketId: 'MERGEUSDT', symbol: 'MERGEUSDT', side: 'long', signalTime: t, t, signalPrice: 100, entry: 100, sl: 70, features, proposalSources: ['V8_BASELINE'], modelVersion: 'V8 Shadow'});
  const merged = mergeProfitProposals([one, two]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].proposalSources, ['TREND_PRIMITIVE', 'V8_BASELINE']);
  assert.equal(merged[0].stop, 94);
  assert.equal(merged[0].targetR, 2);
});

test('V8 proposals receive the canonical research label instead of a frozen trade outcome', () => {
  const t = start + 100 * 86_400_000;
  const proposal = toProfitProposal({id: 'v8-canonical', marketId: 'V8USDT', symbol: 'V8USDT', side: 'long', t, signalTime: t, entry: 100, signalPrice: 100, sl: 95, targetR: 1.5, modelVersion: 'V8 Shadow', proposalSources: ['V8_BASELINE']}, {source: 'V8_BASELINE'});
  const joined = joinCanonicalLabels([proposal], [{observationId: proposal.id, canonicalExecutable: true, executable: true, fillTime: t + 20 * 60_000, exitTime: t + 2 * 3_600_000, exitReason: 'VERTICAL_MTM', netR: 0.25}], {developmentEnd: t + 4 * 86_400_000});
  assert.equal(joined[0].outcome.outcomeType, undefined);
  assert.equal(joined[0].outcome.canonicalOutcomeType, 'VERTICAL_MTM');
  assert.equal(joined[0].outcome.labelUsable, true);
});

test('normalization is train-only and records missing indicators', () => {
  const normalizer = fitTrainNormalizer([{x: 1}, {x: 2}], ['x'], {getValue: (row, name) => row[name]});
  assert.equal(normalizer.stats.x.median, 1.5);
  assert.equal(normalizer.transform({x: 100}).missing.x, false);
  assert.equal(normalizer.transform({}).missing.x, true);
  assert.equal(normalizerSummary(normalizer).stats.x.observed, 2);
});

test('R1 opportunity target and score deciles are ex-ante and deterministic', () => {
  const rows = Array.from({length: 20}, (_, index) => labelledRow(index));
  const opportunityRows = buildOpportunityRows(rows);
  const fitted = fitOpportunityModel(opportunityRows);
  const scored = opportunityRows.map((row, index) => ({...row, marketOpportunityScore: index / 20}));
  const deciles = opportunityDeciles(scored);
  assert.equal(opportunityRows.length, 20);
  assert.equal(fitted.model.type, 'ridge');
  assert.equal(deciles.deciles.length, 10);
  assert.equal(deciles.top30.sample > 0, true);
});

test('R2 ranking is global per timestamp/side with deterministic tie-breaks', () => {
  const rows = [0, 1, 2, 3, 4].map(index => ({...labelledRow(index, start), id: `candidate-${index}`, marketId: `M${index}USDT`, side: 'long', predictedNetR: 5 - index}));
  const ranked = rankCrossSection(rows);
  assert.deepEqual(ranked.slice(0, 3).map(row => row.id), ['candidate-0', 'candidate-1', 'candidate-2']);
  const model = fitRankingModel(rows);
  assert.equal(model.targetClip[0], -1.5);
  assert.equal(rankingQuintiles(ranked)['1'].sample, 1);
});

test('R3 uses low-dimensional stacked inputs and reports proper calibration', () => {
  const rows = Array.from({length: 20}, (_, index) => ({...labelledRow(index), r1Score: index / 20, predictedNetR: (index - 10) / 10, rankPercentile: index / 20, pPositiveNetR: 0.45 + index / 100}));
  const model = fitMetaEdgeModel(rows);
  assert.equal(model.model.type, 'logistic');
  assert.equal(model.model.featureNames.length < 20, true);
  const bins = probabilityBins(rows);
  assert.equal(bins.length, 4);
  assert.equal(typeof brierScore(rows), 'number');
  assert.equal(typeof baseRateBrier(rows), 'number');
  assert.equal(typeof brierSkillScore(rows), 'number');
  assert.equal(typeof logLoss(rows), 'number');
});

test('R3 meta cross-fit never scores a row with a model trained on that row', () => {
  const rows = Array.from({length: 90}, (_, index) => ({...labelledRow(index, start + index * 86_400_000), r1Oof: true, r2Oof: true, r1Score: index / 90, predictedNetR: (index % 15 - 5) / 10}));
  const crossed = metaCrossFit(rows);
  assert.equal(crossed.predictions.length > 0, true);
  assert.equal(crossed.predictions.every(row => row.r3Oof === true), true);
  assert.equal(crossed.predictions.every(row => !(row.r3TrainingRowIds || []).includes(row.id)), true);
  assert.equal(crossed.folds.every(row => row.selfTrainingRows === 0), true);
  assert.equal(selectThresholdConfig(crossed.predictions)?.r1ScoreThreshold == null || typeof selectThresholdConfig(crossed.predictions).r1ScoreThreshold === 'number', true);
  assert.equal(crossed.predictions.every(row => Number.isFinite(row.pPositiveNetR)), true);
});

test('nested walk-forward has six outer folds, 27 threshold combinations, inner OOF, and purge checks', () => {
  const rows = Array.from({length: 320}, (_, index) => labelledRow(index, start + index * 2 * 86_400_000));
  const result = runNestedDevelopment({rows, start, end: Date.parse('2026-01-01T00:00:00Z')});
  assert.equal(PROFIT_ENGINE_FOLDS.length, 6);
  assert.equal(thresholdCandidates().length, 27);
  assert.equal(result.thresholdGridSize, 27);
  assert.equal(result.folds.length, 6);
  assert.equal(result.checks.validationFrozen, true);
  assert.equal(result.checks.thresholdGridBounded, true);
  assert.equal(result.innerOof.length >= 1, true);
});

test('event-end purge excludes labels crossing the outer validation boundary', () => {
  const validationStart = Date.parse('2024-07-01T00:00:00Z');
  const row = {...labelledRow(0, validationStart - 80 * 3_600_000), outcome: {...labelledRow(0).outcome, exitTime: validationStart + 1}};
  const result = runNestedDevelopment({rows: [row], start: Date.parse('2024-01-01T00:00:00Z'), end: Date.parse('2024-10-01T00:00:00Z'), folds: [{id: 'fold-1', trainEnd: validationStart, validationStart, validationEnd: Date.parse('2024-10-01T00:00:00Z')}]});
  assert.equal(result.folds[0].trainRows, 0);
  assert.equal(result.checks.outerLabelOverlapFree, true);
});

test('repo-level no-order audit reports offending executable paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleedge-no-order-'));
  try {
    fs.writeFileSync(path.join(root, 'bad.mjs'), 'export function createOrder() { return null; }\n', 'utf8');
    const failed = auditRepoNoOrder(root, {roots: [root]});
    assert.equal(failed.pass, false);
    assert.deepEqual(failed.offendingPaths, ['bad.mjs']);
    fs.writeFileSync(path.join(root, 'bad.mjs'), 'export function marketData() { return null; }\n', 'utf8');
    assert.equal(auditRepoNoOrder(root, {roots: [root]}).pass, true);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('portfolio applies global top-three, caps, cooldown, and same-symbol conflict rules', () => {
  const t = start; const rows = Array.from({length: 5}, (_, index) => ({...labelledRow(index, t), id: `p${index}`, marketId: `M${index}USDT`, side: 'long', predictedNetR: 5 - index, pPositiveNetR: 0.8, r1Score: 0.8, qualified: true, executable: true}));
  const result = simulateQualifiedPortfolio(rows);
  assert.equal(result.accepted.length <= PROFIT_PORTFOLIO_CONFIG.sameTimestampSide, true);
  assert.equal(result.metrics.trades <= 3, true);
  const duplicate = {...rows[0], id: 'duplicate', signalTime: t + 73 * 3_600_000, decisionTime: t + 73 * 3_600_000 + 20 * 60_000, marketId: rows[0].marketId};
  const second = simulateQualifiedPortfolio([...rows.slice(0, 1), duplicate]);
  assert.equal(second.rejected.some(row => row.reason === 'symbol-cooldown'), true);
});

test('calibration and monthly rank IC are deterministic', () => {
  const rows = Array.from({length: 6}, (_, index) => ({signalTime: start + Math.floor(index / 2) * 31 * 86_400_000, predictedNetR: index, netR: index % 2 ? 1 : -1, outcome: {netR: index % 2 ? 1 : -1}, pPositiveNetR: 0.5 + index / 20}));
  assert.equal(spearman([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(monthlyRankIc(rows).months.length > 0, true);
  assert.equal(typeof monotonicProbabilityBins(probabilityBins(rows)), 'boolean');
});

test('summary and frequency metrics preserve explicit zero months', () => {
  const row = {...labelledRow(0), exitTime: start + 86_400_000};
  const summary = summarizeTrades([row], {start, end: start + 365 * 86_400_000});
  assert.equal(summary.trades, 1);
  const frequency = frequencyByMonth([], start, Date.parse('2025-01-01T00:00:00Z'));
  assert.equal(Object.keys(frequency).length, 12);
  assert.equal(Object.values(frequency).every(month => month.rawProposals === 0), true);
});

test('provenance hash is stable and holdout runner refuses by default', () => {
  assert.equal(jsonSha256({b: 2, a: 1}), jsonSha256({b: 2, a: 1}));
  assert.throws(() => execFileSync('node', ['scripts/run-profit-engine-holdout.mjs'], {cwd: process.cwd(), stdio: 'pipe'}));
});
