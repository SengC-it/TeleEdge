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
import {rankResearchCandidates} from '../src/v81/dedupe.mjs';
import {createProgressStore} from '../scripts/fetch-v9-development-data.mjs';
import {classifyV9Alpha} from '../scripts/run-v9-development.mjs';

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
