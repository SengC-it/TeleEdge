import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {H1, H4} from '../src/config.mjs';
import {aggregateEnhancedBars, assignCrossSectionalRanks, buildV9FeatureSeries, parseEnhancedKlineCsv, parseEnhancedKlineRow, rollingZ} from '../src/v9/features.mjs';
import {detectV9Alpha} from '../src/v9/alphas.mjs';
import {scoreV9Candidate} from '../src/v9/scoring.mjs';
import {V9_ALPHA_IDS, V9_ALPHA_REGISTRY, validateV9Registry} from '../src/v9/registry.mjs';
import {buildFundingQuery, simulateV9StandaloneObservation} from '../src/v9/replay.mjs';
import {auditMetricsContinuity, auditMetricsPIT, aggregateMetricsAt, parseBinanceMetricsCsv} from '../src/v9/metrics.mjs';
import {rankResearchCandidates} from '../src/v81/dedupe.mjs';
import {createProgressStore, dayList, metricsArchiveUrl} from '../scripts/fetch-v9-development-data.mjs';
import {classifyV9Alpha, gateReport} from '../scripts/run-v9-development.mjs';

function rawRow(t, buyQuote = 60, quote = 100) {
  return [t, '100', '102', '99', '101', '1', t + H1 - 1, String(quote), '10', '0.6', String(buyQuote), '0'];
}

function point(overrides = {}) {
  return {
    signalTime: Date.parse('2025-01-01T04:00:00Z'), close: 100, o: 99, h: 102, l: 98,
    atr: 2, priorHigh4: 101, priorLow4: 99, q: 1_000_000, volumeRatio: 1.5,
    regime: 'bull', btcRegime: 'bull', return3: 0.02, return12: 0.04,
    takerImbalance: 0.3, aggressiveVolumeZ: 2, failedBreakoutDown: false, failedBreakoutUp: false,
    crossSectionalReturnRank: 0.9, crossSectionalFlowRank: 0.85, fundingZ: 0,
    ...overrides,
  };
}

test('parses Binance 12-column kline taker-buy fields without confusing quote volume', () => {
  const row = parseEnhancedKlineRow(rawRow(1609488000000, 400, 1_000));
  assert.equal(row.t, 1609488000000);
  assert.equal(row.q, 1_000);
  assert.equal(row.takerBuyBase, 0.6);
  assert.equal(row.takerBuyQuote, 400);
});

test('parses enhanced kline CSV headers and removes duplicate timestamps', () => {
  const csv = [
    'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
    rawRow(1609488000000, 400, 1_000).join(','),
    rawRow(1609488000000, 450, 1_100).join(','),
  ].join('\n');
  const rows = parseEnhancedKlineCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].takerBuyQuote, 450);
});

test('aggregates only complete contiguous four-hour bars', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const rows = [0, 1, 2, 3, 5].map(offset => rawRow(start + offset * H1));
  const bars = aggregateEnhancedBars(rows, start + 8 * H1);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].takerBuyQuote, 240);
  assert.equal(bars[0].takerSellQuote, 160);
  assert.equal(bars[0].aggressiveVolume, 0.2);
});

test('rolling z-score uses prior observations only', () => {
  const prior = [1, 2, 3, 4, 5, 6, 7, 8];
  const score = rollingZ(9, prior);
  assert.notEqual(score, rollingZ(10, prior));
  assert.equal(rollingZ(9, prior.slice(0, 7)), null);
});

test('V9 feature math exposes taker ratios and leaves unavailable OI null', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const rows = Array.from({length: 48}, (_, index) => rawRow(start + index * H1, 60, 100));
  const result = buildV9FeatureSeries(rows, {endTime: start + 48 * H1});
  const last = result.points.at(-1);
  assert.equal(last.takerBuyRatio, 0.6);
  assert.equal(last.takerSellRatio, 0.4);
  assert.ok(Math.abs(last.takerImbalance - 0.2) < 1e-12);
  assert.equal(last.openInterest, null);
  assert.equal(last.oiZ, null);
  assert.equal(result.dataAvailability.openInterest, false);
});

test('parses official Binance daily metrics fields with UTC create_time', () => {
  const csv = [
    'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio',
    '2024-01-01 00:00:00,BTCUSDT,74006.26600000,3131493738.89740000,1.36820310,1.25366800,1.50710938,1.31174499',
  ].join('\n');
  const parsed = parseBinanceMetricsCsv(csv, {expectedSymbol: 'BTCUSDT', strict: true});
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].t, Date.parse('2024-01-01T00:00:00Z'));
  assert.equal(parsed.rows[0].openInterest, 74006.266);
  assert.equal(parsed.rows[0].openInterestValue, 3131493738.8974);
  assert.equal(parsed.rows[0].topTraderAccountRatio, 1.3682031);
  assert.equal(parsed.rows[0].topTraderPositionRatio, 1.253668);
  assert.equal(parsed.rows[0].globalLongShortRatio, 1.50710938);
  assert.equal(parsed.rows[0].takerLongShortRatio, 1.31174499);
});

test('metrics parser detects invalid timestamps, NaN, duplicates, and out-of-order rows', () => {
  const header = 'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio';
  const row = (time, oi = '10') => `${time},BTCUSDT,${oi},20,1.1,1.2,1.3,1.4`;
  const parsed = parseBinanceMetricsCsv([header, row('2024-01-01 00:05:00'), row('2024-01-01 00:05:00'), row('2024-01-01 00:00:00'), row('bad', 'NaN')].join('\n'), {expectedSymbol: 'BTCUSDT'});
  assert.equal(parsed.diagnostics.duplicates, 1);
  assert.equal(parsed.diagnostics.outOfOrder, 1);
  assert.ok(parsed.errors.some(error => error.type === 'invalid-timestamp'));
  assert.ok(parsed.errors.some(error => error.type === 'duplicate-timestamp'));
  assert.ok(parsed.errors.some(error => error.type === 'out-of-order'));
  assert.throws(() => parseBinanceMetricsCsv([header, row('bad')].join('\n'), {expectedSymbol: 'BTCUSDT', strict: true}), /Invalid Binance metrics CSV/);
});

test('metrics continuity reports missing 5m intervals without interpolation', () => {
  const start = Date.parse('2024-01-01T00:00:00Z');
  const rows = [0, 1, 3, 4].map(index => ({t: start + index * 5 * 60_000, openInterest: 1}));
  const audit = auditMetricsContinuity(rows, {activeStart: start, activeEnd: start + 5 * 5 * 60_000});
  assert.equal(audit.totalRows, 4);
  assert.equal(audit.uniqueRows, 4);
  assert.equal(audit.missingTimestamps, 1);
  assert.equal(audit.missingIntervals[0].start, start + 2 * 5 * 60_000);
  assert.equal(audit.complete, false);
});

test('PIT metrics aggregation never uses a future observation', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const rows = [0, 1, 2, 3].map(index => ({
    t: start + index * 5 * 60_000, openInterest: 100 + index, openInterestValue: 1_000 + index,
    topTraderAccountRatio: 1 + index / 100, topTraderPositionRatio: 1 + index / 100,
    globalLongShortRatio: 1 + index / 100, takerLongShortRatio: 1 + index / 100,
  }));
  const result = aggregateMetricsAt(rows, start + 2 * 5 * 60_000 + 1, {priceMove: 0.01});
  assert.equal(result.available, true);
  assert.equal(result.state.t, start + 2 * 5 * 60_000);
  assert.equal(result.oi, 102);
  assert.equal(result.globalLongShortRatio, 1.02);
});

test('metrics z-score history excludes the current observation', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const rows = Array.from({length: 120}, (_, index) => ({
    t: start + index * 5 * 60_000, openInterest: 100 + index,
    globalLongShortRatio: 1 + index / 100,
  }));
  const result = aggregateMetricsAt(rows, rows.at(-1).t, {priceMove: 0.01});
  assert.equal(result.available, true);
  assert.equal(result.state.t, rows.at(-1).t);
  assert.equal(result.oiHistoryAvailable, true);
  assert.equal(result.ratioHistoryAvailable, true);
});

function metricRows(count, skipped = []) {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const skip = new Set(skipped);
  return Array.from({length: count}, (_, index) => {
    if (skip.has(index)) return null;
    return {
      t: start + index * 5 * 60_000, openInterest: 100 + index, openInterestValue: 1_000 + index,
      topTraderAccountRatio: 1.1, topTraderPositionRatio: 1.1,
      globalLongShortRatio: 1.1, takerLongShortRatio: 1.1,
    };
  }).filter(Boolean);
}

test('one historical metrics gap does not globally disable a symbol', () => {
  const rows = metricRows(300, [100, 101, 102]);
  const result = aggregateMetricsAt(rows, rows.at(-1).t, {priceMove: 0.01});
  assert.equal(result.available, true);
  assert.equal(result.oiHistoryAvailable, true);
  assert.equal(result.ratioHistoryAvailable, true);
});

test('stale current metrics fail closed without future interpolation', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const rows = metricRows(2);
  const stale = aggregateMetricsAt(rows, start + 16 * 60_000);
  assert.equal(stale.available, false);
  assert.deepEqual(stale.diagnostics.rejections, ['current-stale']);
  const futureOnly = aggregateMetricsAt([{...rows[0], t: start + 20 * 60_000}], start + 10 * 60_000);
  assert.equal(futureOnly.available, false);
  assert.deepEqual(futureOnly.diagnostics.rejections, ['current-stale']);
});

test('1h, 4h, and 12h metrics lookbacks fail closed across local gaps', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const signalTime = start + 300 * 5 * 60_000;
  const oneHour = aggregateMetricsAt(metricRows(400, [286, 287, 288]), signalTime);
  assert.equal(oneHour.available, true);
  assert.equal(oneHour.oiChange1h, null);
  assert.ok(oneHour.diagnostics.rejections.includes('lookback-1h-gap'));
  const fourHour = aggregateMetricsAt(metricRows(400, [250, 251, 252]), signalTime);
  assert.equal(fourHour.oiChange4h, null);
  assert.ok(fourHour.diagnostics.rejections.includes('lookback-4h-gap'));
  const twelveHour = aggregateMetricsAt(metricRows(400, [154, 155, 156]), signalTime);
  assert.equal(twelveHour.oiChange12h, null);
  assert.ok(twelveHour.diagnostics.rejections.includes('lookback-12h-gap'));
});

test('rolling metric history resets at a gap and fails closed until minimum history returns', () => {
  const rows = metricRows(300, [290, 291, 292]);
  const result = aggregateMetricsAt(rows, rows.at(-1).t);
  assert.equal(result.available, true);
  assert.equal(result.oiHistoryAvailable, false);
  assert.equal(result.ratioHistoryAvailable, false);
  assert.ok(result.diagnostics.rejections.includes('rolling-history-gap'));
});

test('PIT metrics audit counts valid local observations rather than whole-window continuity', () => {
  const rows = metricRows(300, [100, 101, 102]);
  const start = Date.parse('2025-01-01T00:00:00Z');
  const audit = auditMetricsPIT(rows, {signalTimes: [start + 250 * 5 * 60_000, start + 290 * 5 * 60_000]});
  assert.equal(audit.validObservations, 2);
  assert.equal(audit.usable, true);
});

test('metrics archive URLs and day windows are deterministic', () => {
  assert.deepEqual(dayList(Date.parse('2024-01-01T12:00:00Z'), Date.parse('2024-01-03T00:00:00Z')), ['2024-01-01', '2024-01-02']);
  assert.equal(metricsArchiveUrl('BTCUSDT', '2024-01-01'), 'https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2024-01-01.zip');
});

test('premium and mark-index features use completed point-in-time observations', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const rows = Array.from({length: 48}, (_, index) => rawRow(start + index * H1, 60, 100));
  const optionalTimes = Array.from({length: 12}, (_, index) => start + (index + 1) * H4);
  const result = buildV9FeatureSeries(rows, {
    endTime: start + 48 * H1,
    premium: optionalTimes.map((t, index) => ({t, premiumIndex: 0.001 + index * 0.0001})),
    mark: optionalTimes.map(t => ({t, markPrice: 101})),
    index: optionalTimes.map(t => ({t, indexPrice: 100})),
  });
  const last = result.points.at(-1);
  assert.ok(Math.abs(last.premiumChange - 0.0001) < 1e-12);
  assert.ok(Math.abs(last.markIndexSpread - 0.01) < 1e-12);
  assert.equal(last.premiumHistoryAvailable, true);
});

test('cross-sectional ranks are stable under input order and deterministic ties', () => {
  const t = Date.parse('2025-01-01T04:00:00Z');
  const make = symbol => [{signalTime: t, return12: symbol === 'A' ? 1 : 0, takerImbalance: 0}];
  const first = assignCrossSectionalRanks(new Map([['B', make('B')], ['A', make('A')], ['C', make('C')]]));
  const second = assignCrossSectionalRanks(new Map([['C', make('C')], ['A', make('A')], ['B', make('B')]]));
  assert.deepEqual([...first].map(([symbol, rows]) => [symbol, rows[0].crossSectionalReturnRank]).sort(), [...second].map(([symbol, rows]) => [symbol, rows[0].crossSectionalReturnRank]).sort());
  assert.equal(first.get('A')[0].crossSectionalReturnRank, 1);
  assert.equal(first.get('B')[0].crossSectionalReturnRank, 0.5);
});

test('V9 registry is fixed to six families and no more than two variants', () => {
  assert.deepEqual(validateV9Registry(), {valid: true, errors: []});
  assert.equal(V9_ALPHA_IDS.length, 6);
  assert.ok(V9_ALPHA_IDS.every(id => V9_ALPHA_REGISTRY[id].variants.length <= 2));
});

test('optional derivative alphas fail closed when true histories are absent', () => {
  const market = {symbol: 'TESTUSDT', baseAsset: 'TEST', core: false};
  assert.deepEqual(detectV9Alpha(point(), market, 'OI_TREND_CONFIRMATION', 'price-oi-alignment'), []);
  assert.deepEqual(detectV9Alpha(point(), market, 'CROWDED_UNWIND', 'funding-premium-unwind'), []);
  assert.deepEqual(detectV9Alpha(point(), market, 'PREMIUM_DISLOCATION', 'mean-reversion'), []);
});

test('OI trend detector distinguishes new positioning and unwind states', () => {
  const market = {symbol: 'TESTUSDT', baseAsset: 'TEST', core: false};
  const aligned = point({metricsAvailable: true, oiHistoryAvailable: true, openInterest: 100, oiChange: 0.02, oiZ: 1, oiState: 'new-long'});
  const liquidation = point({metricsAvailable: true, oiHistoryAvailable: true, openInterest: 100, oiChange: -0.02, oiZ: -1, oiState: 'long-liquidation', return3: -0.02});
  assert.equal(detectV9Alpha(aligned, market, 'OI_TREND_CONFIRMATION', 'price-oi-alignment')[0].side, 'long');
  assert.equal(detectV9Alpha(liquidation, market, 'OI_TREND_CONFIRMATION', 'price-oi-divergence')[0].side, 'short');
});

test('crowded unwind requires independent metrics dimensions', () => {
  const market = {symbol: 'TESTUSDT', baseAsset: 'TEST', core: false};
  const crowded = point({
    metricsAvailable: true, ratioHistoryAvailable: true, oiHistoryAvailable: true,
    premiumHistoryAvailable: true, fundingHistoryAvailable: true, fundingZ: 2, premiumZ: 2,
    oiChange: -0.02, oiState: 'long-liquidation', return3: -0.02,
    globalLongShortRatio: 1.2, topTraderAccountRatio: 1.1, topTraderPositionRatio: 1.15, takerLongShortRatio: 1.25,
  });
  const candidates = detectV9Alpha(crowded, market, 'CROWDED_UNWIND', 'funding-premium-unwind');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].side, 'short');
  assert.deepEqual(detectV9Alpha({...crowded, takerLongShortRatio: null}, market, 'CROWDED_UNWIND', 'funding-premium-unwind'), []);
});

test('V9 score is ex-ante and independent of outcome fields', () => {
  const market = {symbol: 'TESTUSDT', baseAsset: 'TEST', core: false};
  const [candidate] = detectV9Alpha(point(), market, 'FLOW_MOMENTUM', 'trend-confirmed');
  assert.ok(candidate);
  const before = scoreV9Candidate(candidate);
  const after = scoreV9Candidate({...candidate, outcome: {netR: 99}, exitTime: Date.now()});
  assert.equal(before.edgeScore, after.edgeScore);
  assert.equal(before.scoreVersion, 'v9-interpretable-scorecard-1');
});

test('global V9 ranking keeps only top three per timestamp and side independent of input order', () => {
  const rows = Array.from({length: 5}, (_, index) => ({id: `V9|${index}`, marketId: `S${index}USDT`, side: 'long', t: 1000, edgeScore: 50 + index, eventScore: 0, dayVolume: 1}));
  const first = rankResearchCandidates(rows).map(row => row.id);
  const second = rankResearchCandidates([...rows].reverse()).map(row => row.id);
  assert.deepEqual(first, ['V9|4', 'V9|3', 'V9|2']);
  assert.deepEqual(second, first);
});

test('global V9 ranking resolves exact ties by id independent of input order', () => {
  const rows = ['E', 'B', 'D', 'A', 'C'].map(id => ({id, marketId: `${id}USDT`, side: 'short', t: 1000, edgeScore: 80, eventScore: 7, dayVolume: 1_000_000}));
  assert.deepEqual(rankResearchCandidates(rows).map(row => row.id), ['A', 'B', 'C']);
  assert.deepEqual(rankResearchCandidates([...rows].reverse()).map(row => row.id), ['A', 'B', 'C']);
});

test('funding cashflow falls back to market price and never treats interval metadata as price', () => {
  const minuteRows = [
    {t: 0, o: 100, h: 100, l: 100, c: 100},
    {t: 480_000, o: 105, h: 105, l: 105, c: 105},
  ];
  const query = buildFundingQuery([
    {t: 480_000, rate: 0.001, fundingIntervalHours: 8, markPrice: null},
    {t: 540_000, rate: 0.002, fundingIntervalHours: 8, markPrice: 110},
  ], minuteRows);
  const result = query.query(-1, 600_000, 100);
  assert.ok(Math.abs(result.cashflow - 0.325) < 1e-12);
  assert.equal(result.fundingEvents, 2);
  assert.equal(result.fallbackMarkPriceRows, 1);
});

function executableCandidate(signalTime) {
  return {
    id: 'V9|TESTUSDT|long', marketId: 'TESTUSDT', symbol: 'TESTUSDT', side: 'long',
    t: signalTime, entry: 100, sl: 97, targetR: 2, family: 'FLOW_MOMENTUM', alpha: 'FLOW_MOMENTUM',
    edgeScore: 80, eventScore: 5, dayVolume: 1_000_000,
  };
}

const testMarket = {
  symbol: 'TESTUSDT',
  filters: [
    {filterType: 'PRICE_FILTER', tickSize: '0.1'},
    {filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001'},
  ],
};

test('formal 1m settlement takes the earlier TP even when the later SL is in the same hour', () => {
  const signalTime = Date.parse('2025-01-01T16:00:00Z');
  const minuteRows = [
    {t: signalTime + 20 * 60_000, o: 100, h: 100.2, l: 99.8, c: 100},
    {t: signalTime + 32 * 60_000, o: 100, h: 106.1, l: 99.5, c: 105},
    {t: signalTime + 51 * 60_000, o: 105, h: 105, l: 96.9, c: 98},
  ];
  const outcome = simulateV9StandaloneObservation(executableCandidate(signalTime), {market: testMarket, minuteRows, activeEnd: signalTime + 2 * H1});
  assert.equal(outcome.executable, true);
  assert.equal(outcome.exitReason, 'tp');
  assert.equal(outcome.exitTime, signalTime + 33 * 60_000);
  assert.ok(outcome.modeledCostUsdt > 0);
});

test('formal 1m settlement resolves same-minute TP and SL to SL', () => {
  const signalTime = Date.parse('2025-01-01T16:00:00Z');
  const minuteRows = [
    {t: signalTime + 20 * 60_000, o: 100, h: 100.2, l: 99.8, c: 100},
    {t: signalTime + 32 * 60_000, o: 100, h: 106.1, l: 96.9, c: 100},
  ];
  const outcome = simulateV9StandaloneObservation(executableCandidate(signalTime), {market: testMarket, minuteRows, activeEnd: signalTime + 2 * H1});
  assert.equal(outcome.exitReason, 'sl');
  assert.equal(outcome.touch.ambiguous, true);
});

test('V9 OOF classification keeps strong lower-bound edge, watches uncertainty, and rejects negative edge', () => {
  const row = qualifiedOofExecutable => ({qualifiedOofExecutable});
  assert.equal(classifyV9Alpha(row({sample: 30, uniqueSymbols: 10, netPnlUsdt: 100, profitFactor: 1.5, expectancyR: 0.2, expectancyR95CI: [0.01, 0.4]})), 'KEEP');
  assert.equal(classifyV9Alpha(row({sample: 30, uniqueSymbols: 10, netPnlUsdt: 100, profitFactor: 1.5, expectancyR: 0.2, expectancyR95CI: [-0.01, 0.4]})), 'WATCH');
  assert.equal(classifyV9Alpha(row({sample: 30, uniqueSymbols: 10, netPnlUsdt: -1, profitFactor: 0.9, expectancyR: -0.1, expectancyR95CI: [-0.2, 0]})), 'REJECT');
});

test('V9 research gate fails closed below the 100-symbol metrics minimum', () => {
  const gate = gateReport({
    oofAlpha: {}, oofQualifiedExecutable: Array.from({length: 100}, () => ({})), rankedCandidates: [],
    candidateMetrics: {trades: 60, uniqueSymbols: 30, profitFactor: 2, expectancyR: 0.3, netPnlUsdt: 100, netReturn: 0.1, maxDrawdownPct: 0.01, monthlyPnl: Object.fromEntries(Array.from({length: 12}, (_, index) => [`2025-${String(index + 1).padStart(2, '0')}`, 1]))},
    v8Metrics: {netPnlUsdt: 0}, tierMonotonicity: {sufficientSample: true, valid: true},
    walkForward: {checks: {timeOrdered: true, purgeEnforced: true, labelOverlapFree: true, validationFrozen: true}},
    executionProxy: false, noOrderAudit: true, keepAlphaIds: ['A', 'B'], trades: Array.from({length: 60}, (_, index) => ({marketId: `S${index}`, netPnlUsdt: 2})),
    usableMetricsSymbols: 99, qualifiedExecutableFrequency: 8,
  });
  assert.equal(gate.decision, 'RESEARCH_FAIL');
  assert.equal(gate.checks.usableMetricsSymbolsAtLeast100, false);
});

test('progress updates are serialized and resumable under concurrent workers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleedge-v9-progress-'));
  const file = path.join(directory, 'progress.json');
  const progress = createProgressStore(file);
  await Promise.all(Array.from({length: 24}, (_, index) => progress.update(`S${index}`, {status: 'complete', completedKinds: ['taker-1h']})));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(saved.symbols).length, 24);
  assert.ok(Object.values(saved.symbols).every(row => row.status === 'complete'));
  fs.rmSync(directory, {recursive: true, force: true});
});

test('V9 source tree has no order submission path', () => {
  const directory = path.join(process.cwd(), 'src', 'v9');
  const source = fs.readdirSync(directory).map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n');
  assert.doesNotMatch(source, /createOrder|placeOrder|newOrder|fapi\/v\d+\/order|orderSubmission/i);
});
