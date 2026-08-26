import assert from 'node:assert/strict';
import test from 'node:test';
import {H4} from '../src/config.mjs';
import {ALPHA_REGISTRY, RESEARCH_ALPHA_IDS, validateAlphaRegistry} from '../src/v81/alpha-registry.mjs';
import {fourHourBars, prepareFeatureSeries} from '../src/v81/features.mjs';
import {scoreCandidate} from '../src/v81/scoring.mjs';
import {createMonthlyFrequency, frequencySummary, calculateResearchMetrics} from '../src/v81/metrics.mjs';
import {mergeResearchCandidates, rankResearchCandidates} from '../src/v81/dedupe.mjs';
import {simulatePortfolio} from '../src/v81/portfolio.mjs';
import {settleOnCompletedBars} from '../src/backtest.mjs';

test('V8.1 registry contains immutable metadata for all baseline and research alpha ids', () => {
  const result = validateAlphaRegistry();
  assert.equal(result.valid, true, result.errors.join(','));
  assert.equal(Object.isFrozen(ALPHA_REGISTRY), true);
  assert.equal(RESEARCH_ALPHA_IDS.length, 6);
  for (const id of RESEARCH_ALPHA_IDS) {
    assert.ok(ALPHA_REGISTRY[id].requiredInputs.length > 0);
    assert.ok(ALPHA_REGISTRY[id].description);
  }
});

test('feature at a completed bar is invariant to data appended after that bar', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const rows = Array.from({length: 260}, (_, index) => {
    const close = 100 + index * 0.08;
    return {t: start + index * H4, o: close - 0.1, h: close + 0.4, l: close - 0.4, c: close, q: 1_000_000};
  });
  rows[259].h = 10_000;
  const short = prepareFeatureSeries(rows.slice(0, 220));
  const full = prepareFeatureSeries(rows);
  const left = short.points.at(-1);
  const right = full.points[219];
  for (const key of ['signalTime', 'close', 'ema20', 'ema50', 'ema200', 'atr', 'adx', 'rsi', 'regime', 'return12']) assert.equal(left[key], right[key], key);
});

test('tier scoring and deterministic ranking are stable under input order changes', () => {
  const base = {
    modelVersion: 'V8.1-research-1', marketId: 'XUSDT', symbol: 'X', side: 'long', t: 100,
    family: 'v81_test', stopPct: 0.04, eventScore: 1, dayVolume: 100,
    features: {return12: 0.05, volumeRatio: 2, rangeRatio: 1.5, fundingZ: 1, adx: 30, regime: 'bull', btcRegime: 'bull'},
  };
  const scored = scoreCandidate({...base, id: 'x'});
  assert.equal(scored.tier, scoreCandidate({...base, id: 'x'}).tier);
  const candidates = Array.from({length: 5}, (_, index) => ({...scored, id: `id-${index}`, marketId: `M${index}USDT`, edgeScore: 100 - index, confidenceScore: 90 - index, t: 500}));
  const first = rankResearchCandidates(candidates).map(row => row.id);
  const second = rankResearchCandidates([...candidates].reverse()).map(row => row.id);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['id-0', 'id-1', 'id-2']);
});

test('research dedupe merges alpha sources into one notifiable alert', () => {
  const rows = [
    {id: 'b', alpha: 'volatility_expansion', marketId: 'XUSDT', side: 'short', t: 1, edgeScore: 70, confidenceScore: 70},
    {id: 'a', alpha: 'trend_pullback_continuation', marketId: 'XUSDT', side: 'short', t: 1, edgeScore: 80, confidenceScore: 70},
  ];
  const merged = mergeResearchCandidates(rows);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].alphaSources, ['trend_pullback_continuation', 'volatility_expansion']);
  assert.equal(merged[0].alpha, 'trend_pullback_continuation');
  assert.equal(merged[0].alphaOverlap, true);
});

test('monthly frequency keeps zero months and deterministic summary statistics', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const end = Date.parse('2026-01-01T00:00:00Z');
  const monthly = createMonthlyFrequency(start, end);
  recordForTest(monthly, start, 'long');
  recordForTest(monthly, Date.parse('2025-03-01T00:00:00Z'), 'short');
  const summary = frequencySummary(monthly);
  assert.equal(Object.keys(summary.months).length, 12);
  assert.equal(summary.research.zeroMonths, 10);
  assert.equal(summary.research.mean, 2 / 12);
  assert.equal(summary.research.median, 0);
});

function recordForTest(monthly, t, side) {
  const row = {t, side, alpha: 'test', regime: 'sideways'};
  monthly[`${new Date(t).getUTCFullYear()}-${String(new Date(t).getUTCMonth() + 1).padStart(2, '0')}`].research++;
  monthly[Object.keys(monthly).find(key => key === `${new Date(t).getUTCFullYear()}-${String(new Date(t).getUTCMonth() + 1).padStart(2, '0')}`)][side]++;
}

function candidate(symbol, t, id = symbol) {
  return {
    id, modelVersion: 'V8.1-research-1', alpha: 'trend_pullback_continuation', alphaSources: ['trend_pullback_continuation'],
    marketId: symbol, symbol: symbol.replace('USDT', ''), side: 'long', family: 'v81_trend_pullback', t,
    signalPrice: 100, entry: 100, sl: 95, stopPct: 0.05, targetR: 2, target: 110, edgeScore: 80, confidenceScore: 80,
    tier: 'B', regime: 'bull', features: {},
  };
}

test('paper portfolio uses executable 1m fills, releases capacity, and enforces cooldown', async () => {
  const t = Date.parse('2025-06-01T00:00:00Z');
  const d1 = t + 20 * 60_000;
  const d2 = t + 4 * H4 + 20 * 60_000;
  const minute = new Map([
    ['BTCUSDT', [{t: d1, o: 100, h: 101, l: 99, c: 100}, {t: d1 + 60_000, o: 100, h: 110, l: 99, c: 110}, {t: d2, o: 100, h: 101, l: 99, c: 100}]],
    ['ETHUSDT', [{t: d2, o: 100, h: 101, l: 99, c: 100}]],
  ]);
  const marketBySymbol = new Map(['BTCUSDT', 'ETHUSDT'].map(symbol => [symbol, {symbol, filters: [
    {filterType: 'PRICE_FILTER', tickSize: '0.01'},
    {filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001'},
  ]}]));
  const data = {
    marketBySymbol,
    loadMinute: symbol => minute.get(symbol) || [],
    loadFunding: () => [],
    firstMinute: (symbol, decisionTime) => (minute.get(symbol) || []).find(row => row.t >= decisionTime) || null,
    priceAt: (symbol, timestamp) => (minute.get(symbol) || []).filter(row => row.t <= timestamp).at(-1)?.c || null,
    release: () => {},
  };
  const result = await simulatePortfolio([
    [candidate('BTCUSDT', t, 'btc-first')],
    [candidate('BTCUSDT', t + 4 * H4, 'btc-cooldown'), candidate('ETHUSDT', t + 4 * H4, 'eth-capacity')],
  ], data, {endTime: t + 5 * H4});
  assert.equal(result.accepted.length, 2);
  assert.equal(result.closedTrades.some(row => row.marketId === 'BTCUSDT' && row.exitReason === 'tp'), true);
  assert.equal(result.rejected.some(row => row.candidate.id === 'btc-cooldown' && row.reason === 'symbol-cooldown'), true);
  assert.equal(result.state.positions.length, 0);
});

test('same-minute TP and SL resolves to SL and later minutes preserve first touch order', () => {
  const position = {side: 'long', fillTime: 0, entry: 100, stop: 95, target: 105, quantity: 1, riskUsdt: 5, fundingPnlUsdt: 0, lastFundingTime: 0};
  const same = settleOnCompletedBars(position, [{t: 0, o: 100, h: 106, l: 94, c: 100}], [], {now: 120_000, costRate: 0, barIntervalMs: 60_000});
  assert.equal(same.trade.exitReason, 'sl');
  const later = settleOnCompletedBars(position, [{t: 0, o: 100, h: 101, l: 99, c: 100}, {t: 60_000, o: 100, h: 106, l: 99, c: 105}], [], {now: 180_000, costRate: 0, barIntervalMs: 60_000});
  assert.equal(later.trade.exitReason, 'tp');
});

test('empty research metrics are finite and explicit', () => {
  const metrics = calculateResearchMetrics([], [], {initialEquity: 10_000});
  assert.equal(metrics.trades, 0);
  assert.equal(metrics.netPnlUsdt, 0);
  assert.equal(metrics.profitFactor, null);
  assert.equal(Number.isNaN(metrics.maxDrawdownPct), false);
});
