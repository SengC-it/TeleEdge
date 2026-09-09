import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {H1, H4, CORE_MARKETS} from '../src/config.mjs';
import {simulateCanonicalOutcome} from '../src/profit-engine/canonical-outcome.mjs';
import {auditProductionIsolation, auditRepoNoOrder} from '../src/profit-engine/audits.mjs';
import {
  OBSERVED_PIT_HISTORY_HOURS,
  OBSERVED_PIT_LIQUIDITY_THRESHOLD_USDT,
  observedTradabilityCodeAt,
  buildObservedMarket,
  buildObservedPITSnapshots,
  isPlainCryptoArchiveSymbol,
  observedAnnouncementEvidenceIsUsdM,
  observedPitGate,
  observedTradabilityAt,
  normalizeHourlyRows,
} from '../src/m4/observed-pit-universe.mjs';
import {CANONICAL_OUTCOME_CONTRACT} from '../src/profit-engine/labels.mjs';
import {EVENT_DEFINITIONS, EVENT_FAMILIES, EVENT_KEEP_GATE} from '../src/m4/event-engine.mjs';
import {rangeFromObjectIndex, readGzipObjectIndex} from '../scripts/run-observed-pit-event.mjs';

const start = Date.parse('2024-01-01T00:00:00.000Z');

function hourlyRows(count, {from = start, quoteVolume = 1_000_000, gaps = []} = {}) {
  const gapSet = new Set(gaps);
  return Array.from({length: count}, (_, index) => gapSet.has(index) ? null : ({
    t: from + index * H1,
    o: 100,
    h: 102,
    l: 98,
    c: 101,
    q: quoteVolume,
  })).filter(Boolean);
}

function syntheticMarket(rows, symbol = 'TESTUSDT') {
  const normalized = normalizeHourlyRows(rows);
  const market = buildObservedMarket({symbol, rows: normalized.rows, priceFile: null, invalidRows: normalized.invalidRows, duplicateRows: normalized.duplicateRows});
  // Unit fixtures are in-memory artifacts; their integrity is explicitly
  // declared so the membership contract is tested independently of I/O.
  market.dataIntegrity.priceComplete = true;
  market.artifacts.price.present = true;
  market.artifacts.price.nonEmpty = true;
  market.artifacts.price.hashVerified = true;
  return market;
}

function featurePoint(timestamp, overrides = {}) {
  return {
    signalTime: timestamp,
    close: 100,
    ema50: 99,
    ema200: 98,
    atr: 2,
    priorLow4: 97,
    priorHigh4: 103,
    previousClose: 99,
    return4: 0.01,
    regime: 'bull',
    fundingValid: false,
    ...overrides,
  };
}

test('observed PIT excludes pre-listing timestamps and requires a 30d warm-up', () => {
  const rows = hourlyRows(OBSERVED_PIT_HISTORY_HOURS + 1);
  const market = syntheticMarket(rows);
  const beforeWarmup = start + (OBSERVED_PIT_HISTORY_HOURS - 1) * H1;
  const afterWarmup = start + OBSERVED_PIT_HISTORY_HOURS * H1;
  assert.equal(observedTradabilityAt(market, start - H1).finalEligible, false);
  assert.equal(observedTradabilityAt(market, beforeWarmup, {featurePoint: featurePoint(beforeWarmup)}).historyReady, false);
  assert.equal(observedTradabilityAt(market, afterWarmup, {featurePoint: featurePoint(afterWarmup)}).historyReady, true);
});

test('post-delist disappearance and relisting require a fresh contiguous warm-up', () => {
  const first = hourlyRows(OBSERVED_PIT_HISTORY_HOURS + 1);
  const relistStart = first.at(-1).t + 2 * H1;
  const second = hourlyRows(OBSERVED_PIT_HISTORY_HOURS + 1, {from: relistStart});
  const market = syntheticMarket([...first, ...second]);
  const duringGap = first.at(-1).t + H1 + H1;
  assert.equal(observedTradabilityAt(market, duringGap, {featurePoint: featurePoint(duringGap)}).finalEligible, false);
  const beforeRelistWarmup = relistStart + (OBSERVED_PIT_HISTORY_HOURS - 1) * H1;
  assert.equal(observedTradabilityAt(market, beforeRelistWarmup, {featurePoint: featurePoint(beforeRelistWarmup)}).historyReady, false);
  const afterRelistWarmup = relistStart + OBSERVED_PIT_HISTORY_HOURS * H1;
  assert.equal(observedTradabilityAt(market, afterRelistWarmup, {featurePoint: featurePoint(afterRelistWarmup)}).historyReady, true);
});

test('future rows and future volume do not change a historical PIT decision', () => {
  const historicalRows = hourlyRows(OBSERVED_PIT_HISTORY_HOURS + 1);
  const timestamp = start + OBSERVED_PIT_HISTORY_HOURS * H1;
  const baseline = syntheticMarket(historicalRows);
  const withFuture = syntheticMarket([...historicalRows, ...hourlyRows(100, {from: timestamp + H4, quoteVolume: 10_000_000_000})]);
  const point = featurePoint(timestamp);
  assert.deepEqual(observedTradabilityAt(withFuture, timestamp, {featurePoint: point}), observedTradabilityAt(baseline, timestamp, {featurePoint: point}));
});

test('local gap fails closed for one symbol without globally blocking another', () => {
  const timestamp = start + OBSERVED_PIT_HISTORY_HOURS * H1;
  const broken = syntheticMarket(hourlyRows(OBSERVED_PIT_HISTORY_HOURS + 1, {gaps: [400]}), 'BROKENUSDT');
  const good = syntheticMarket(hourlyRows(OBSERVED_PIT_HISTORY_HOURS + 1), 'GOODUSDT');
  const brokenStatus = observedTradabilityAt(broken, timestamp, {featurePoint: featurePoint(timestamp)});
  const goodStatus = observedTradabilityAt(good, timestamp, {featurePoint: featurePoint(timestamp)});
  assert.equal(brokenStatus.finalEligible, false);
  assert.equal(brokenStatus.dataLoss, true);
  assert.equal(goodStatus.finalEligible, true);
});

test('PIT liquidity uses only trailing completed rows and passes the exact threshold', () => {
  const timestamp = start + OBSERVED_PIT_HISTORY_HOURS * H1;
  const hourlyVolume = OBSERVED_PIT_LIQUIDITY_THRESHOLD_USDT / 24;
  const market = syntheticMarket(hourlyRows(OBSERVED_PIT_HISTORY_HOURS + 1, {quoteVolume: hourlyVolume}));
  const status = observedTradabilityAt(market, timestamp, {featurePoint: featurePoint(timestamp)});
  assert.ok(Math.abs(status.averageDailyQuoteVolume - OBSERVED_PIT_LIQUIDITY_THRESHOLD_USDT) < 1e-6);
  assert.equal(status.liquidityReady, true);
});

test('archive union does not depend on current exchangeInfo survival', () => {
  assert.equal(isPlainCryptoArchiveSymbol('HISTORICALUSDT', new Map()), true);
  assert.equal(isPlainCryptoArchiveSymbol('AAPLUSDT', new Map([['AAPLUSDT', {contractType: 'TRADIFI_PERPETUAL', quoteAsset: 'USDT', underlyingType: 'EQUITY'}]])), false);
});

test('spot delisting evidence is not USD-M perpetual evidence', () => {
  assert.equal(observedAnnouncementEvidenceIsUsdM({product: 'Spot', title: 'Binance will delist AKRO/USDT spot trading pair'}), false);
  assert.equal(observedAnnouncementEvidenceIsUsdM({product: 'USD-M Futures', title: 'USD-M perpetual contract notice'}), true);
});

test('observed snapshots are non-empty and contain deterministic PIT ranks', () => {
  const timestamp = start + OBSERVED_PIT_HISTORY_HOURS * H1;
  const btc = syntheticMarket(hourlyRows(OBSERVED_PIT_HISTORY_HOURS + 1, {quoteVolume: 1_000_000}), 'BTCUSDT');
  const alt = syntheticMarket(hourlyRows(OBSERVED_PIT_HISTORY_HOURS + 1, {quoteVolume: 1_000_000}), 'ALTUSDT');
  const points = new Map([
    ['BTCUSDT', [featurePoint(timestamp, {return4: 0.02})]],
    ['ALTUSDT', [featurePoint(timestamp, {return4: -0.01})]],
  ]);
  const snapshots = buildObservedPITSnapshots({markets: [alt, btc], featurePointsBySymbol: points, start: timestamp, end: timestamp + H4});
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].finalPitSymbols, ['BTCUSDT', 'ALTUSDT']);
  assert.equal(snapshots[0].members[0].pitReturnRank, 1);
  assert.equal(snapshots[0].members[1].pitReturnRank, 0);
});

test('observed snapshot feature lookup follows signalTime across consecutive 4h windows', () => {
  const firstTimestamp = start + OBSERVED_PIT_HISTORY_HOURS * H1;
  const secondTimestamp = firstTimestamp + H4;
  const market = syntheticMarket(hourlyRows(OBSERVED_PIT_HISTORY_HOURS + 5), 'BTCUSDT');
  const snapshots = buildObservedPITSnapshots({
    markets: [market],
    featurePointsBySymbol: new Map([['BTCUSDT', [
      featurePoint(firstTimestamp, {return4: 0.01}),
      featurePoint(secondTimestamp, {return4: -0.01}),
    ]]]),
    start: firstTimestamp,
    end: secondTimestamp + H4,
  });
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.map(row => row.finalPitSymbols), [['BTCUSDT'], ['BTCUSDT']]);
  assert.deepEqual(snapshots.map(row => row.members[0].return4), [0.01, -0.01]);
});

test('compact PIT status codes preserve snapshot membership and diagnostics', () => {
  const firstTimestamp = start + OBSERVED_PIT_HISTORY_HOURS * H1;
  const secondTimestamp = firstTimestamp + H4;
  const market = syntheticMarket(hourlyRows(OBSERVED_PIT_HISTORY_HOURS + 5), 'BTCUSDT');
  const points = new Map([['BTCUSDT', [
    featurePoint(firstTimestamp, {return4: 0.01}),
    featurePoint(secondTimestamp, {return4: -0.01}),
  ]]]);
  const timestamps = [firstTimestamp, secondTimestamp];
  const codes = new Uint8Array(timestamps.map(timestamp => observedTradabilityCodeAt(market, timestamp, {featurePoint: points.get('BTCUSDT').find(point => point.signalTime === timestamp)})));
  const compact = buildObservedPITSnapshots({markets: [market], featurePointsBySymbol: points, pitStatusBySymbol: new Map([['BTCUSDT', codes]]), start: firstTimestamp, end: secondTimestamp + H4, includeSymbolLists: false});
  assert.deepEqual(compact.map(row => row.finalPitSymbols), [['BTCUSDT'], ['BTCUSDT']]);
  assert.deepEqual(compact.map(row => row.pitUniverseSize), [1, 1]);
  assert.deepEqual(compact.map(row => row.btcFinalEligible), [true, true]);
});

test('observed PIT gate fails on BTC critical data loss, not on a non-critical local issue', () => {
  const blocked = observedPitGate(Array.from({length: 12}, (_, index) => ({
    eventTime: start + index * 30 * H4,
    pitUniverseSize: 120,
    members: [],
    dataLossSymbols: ['BTCUSDT'],
    btcOtherwiseEligible: true,
    btcDataLoss: true,
  })));
  assert.equal(blocked.status, 'OBSERVED_PIT_DATA_BLOCKED');
  const pass = observedPitGate(Array.from({length: 12}, (_, index) => ({
    eventTime: start + index * 30 * H4,
    pitUniverseSize: 120,
    members: [],
    dataLossSymbols: ['BROKENUSDT'],
    btcOtherwiseEligible: true,
    btcDataLoss: false,
  })));
  assert.equal(pass.btcCoverage, 1);
});

test('canonical event outcome uses independent 72h contract and price fallback for null funding mark', () => {
  const signalTime = start + 10 * H1;
  const fillTime = signalTime + 20 * 60_000;
  const minuteRows = [
    {t: fillTime, o: 100, h: 106, l: 99, c: 105},
    {t: fillTime + MINUTE, o: 105, h: 105, l: 104, c: 104},
  ];
  const outcome = simulateCanonicalOutcome({
    id: 'canonical-test', marketId: 'BTCUSDT', symbol: 'BTCUSDT', side: 'long', family: 'dailyBreakout',
    signalTime, t: signalTime, entry: 100, sl: 97, targetR: 2,
  }, {
    market: {symbol: 'BTCUSDT', filters: [
      {filterType: 'PRICE_FILTER', tickSize: '0.1'},
      {filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001'},
    ]},
    minuteRows,
    fundingRows: [{t: fillTime, rate: 0.001, markPrice: null, fundingIntervalHours: 8}],
    equityUsdt: 10_000,
  });
  assert.equal(outcome.canonicalExecutable, true);
  assert.equal(outcome.exitReason, 'TP');
  assert.equal(outcome.canonicalDurationHours <= CANONICAL_OUTCOME_CONTRACT.verticalBarrierHours + 1 / 60, true);
  assert.equal(outcome.fallbackMarkPriceRows, 1);
  assert.notEqual(outcome.fillPrice, 8);
});

test('formal outcome artifact index materializes only the requested 1m window', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleedge-minute-index-'));
  const file = path.join(directory, 'BTCUSDT.json.gz');
  const rows = Array.from({length: 240}, (_, index) => ({
    t: start + index * MINUTE,
    o: 100 + index / 100,
    h: 101 + index / 100,
    l: 99 + index / 100,
    c: 100.5 + index / 100,
  }));
  try {
    const compressed = zlib.gzipSync(JSON.stringify(rows));
    fs.writeFileSync(file, compressed);
    const tracker = new Map();
    const index = readGzipObjectIndex(file, {
      rows: rows.length,
      sha256: crypto.createHash('sha256').update(compressed).digest('hex'),
    }, tracker, 'minute|BTCUSDT');
    const selected = rangeFromObjectIndex(index, start + 16 * MINUTE, start + 18 * MINUTE);
    assert.deepEqual(selected.map(row => row.t), [start + 16 * MINUTE, start + 17 * MINUTE, start + 18 * MINUTE]);
    assert.equal(tracker.get('minute|BTCUSDT').hashVerified, true);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('frozen event families, definitions, and KEEP thresholds remain unchanged', () => {
  assert.deepEqual(EVENT_FAMILIES, ['BREADTH_REGIME_TRANSITION', 'MARKET_VOLATILITY_SHOCK', 'DISPERSION_ROTATION', 'LEVERAGE_STRESS_TRANSITION', 'TREND_REGIME_TRANSITION']);
  assert.equal(EVENT_DEFINITIONS.DISPERSION_ROTATION.maxPerSide, 3);
  assert.equal(EVENT_KEEP_GATE.minimumExecutable, 60);
  assert.equal(CORE_MARKETS.has('BTCUSDT'), true);
});

test('repo no-order and production-isolation audits remain research-safe', () => {
  const noOrder = auditRepoNoOrder(process.cwd());
  assert.equal(noOrder.pass, true);
  const isolation = auditProductionIsolation(process.cwd(), 'research/m4-event-regime');
  assert.equal(isolation.pass, true);
});

const MINUTE = 60_000;
