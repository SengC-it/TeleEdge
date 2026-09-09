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
  addObservedSnapshotEventFeatures,
  observedTradabilityCodeAt,
  buildObservedMarket,
  buildObservedPITSnapshot,
  buildObservedPITSnapshots,
  isPlainCryptoArchiveSymbol,
  observedAnnouncementEvidenceIsUsdM,
  observedPitGate,
  observedPitDataLossSummary,
  observedPitInvariantAudit,
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

test('PIT invariant audit requires a non-empty historical comparison and reports changed snapshots', () => {
  const snapshots = [0, 1, 2].map(index => ({eventTime: start + index * H4, finalPitSymbols: ['BTCUSDT']}));
  const pass = observedPitInvariantAudit({snapshotsBefore: snapshots, snapshotsAfter: snapshots.map(row => ({...row, finalPitSymbols: [...row.finalPitSymbols]})), cutoff: start + 3 * H4});
  assert.equal(pass.comparedHistoricalSnapshots, 3);
  assert.equal(pass.changedHistoricalSnapshots, 0);
  assert.equal(pass.pass, true);
  const changed = observedPitInvariantAudit({snapshotsBefore: snapshots, snapshotsAfter: snapshots.map((row, index) => ({...row, finalPitSymbols: index === 1 ? [] : [...row.finalPitSymbols]})), cutoff: start + 3 * H4});
  assert.equal(changed.changedHistoricalSnapshots, 1);
  assert.equal(changed.pass, false);
  const empty = observedPitInvariantAudit({snapshotsBefore: snapshots, snapshotsAfter: [], cutoff: start + 3 * H4});
  assert.equal(empty.comparedHistoricalSnapshots, 0);
  assert.equal(empty.pass, false);
});

test('PIT data-loss retention gate counts corruption and fails closed below 95 percent', () => {
  const pass = observedPitGate(Array.from({length: 20}, (_, index) => ({
    eventTime: start + index * H4,
    pitUniverseSize: 120,
    otherwiseEligibleObservations: 100,
    corruptionLostObservations: 4,
    btcOtherwiseEligible: true,
    btcDataLoss: false,
  })));
  assert.equal(pass.otherwiseEligibleObservations, 2_000);
  assert.equal(pass.corruptionLostObservations, 80);
  assert.equal(pass.corruptionRetentionRate, 0.96);
  assert.equal(pass.corruptionPass, true);
  const blocked = observedPitGate(Array.from({length: 20}, (_, index) => ({
    eventTime: start + index * H4,
    pitUniverseSize: 120,
    otherwiseEligibleObservations: 100,
    corruptionLostObservations: 6,
    btcOtherwiseEligible: true,
    btcDataLoss: false,
  })));
  assert.equal(blocked.corruptionRetentionRate, 0.94);
  assert.equal(blocked.status, 'OBSERVED_PIT_DATA_BLOCKED');
});

test('compact PIT data-loss summary reports symbol and reason counts', () => {
  const timestamps = [start, start + H4];
  const markets = [{symbol: 'BROKENUSDT', dataIntegrity: {priceComplete: false}}];
  const summary = observedPitDataLossSummary({markets, timestamps, pitStatusBySymbol: new Map([['BROKENUSDT', Uint8Array.from([32, 32])]])});
  assert.deepEqual(summary.topLossSymbols, [{symbol: 'BROKENUSDT', count: 2}]);
  assert.equal(summary.topLossReasons[0].reason, 'missing-or-incomplete-price-artifact');
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

test('formal observed snapshots compute volatility and dispersion z-scores from prior completed history only', () => {
  const snapshots = Array.from({length: 9}, (_, index) => ({
    eventTime: start + index * H4,
    completed: true,
    volatilityProxy: 1,
    dispersionProxy: 1,
  }));
  snapshots[7].volatilityProxy = 1.2;
  snapshots[7].dispersionProxy = 1.2;
  snapshots[8].volatilityProxy = 10;
  snapshots[8].dispersionProxy = 10;
  const enriched = addObservedSnapshotEventFeatures(snapshots);
  assert.equal(enriched[7].realizedVolZ, null);
  assert.equal(enriched[8].realizedVolZ >= 2, true);
  assert.equal(enriched[8].dispersionZ >= 2, true);
  assert.equal(enriched[8].previousDispersionZ, null);
  const withFuture = addObservedSnapshotEventFeatures([...snapshots, {eventTime: start + 9 * H4, volatilityProxy: 10_000, dispersionProxy: 10_000}]);
  assert.equal(withFuture[8].realizedVolZ, enriched[8].realizedVolZ);
  assert.equal(withFuture[8].dispersionZ, enriched[8].dispersionZ);
});

test('formal observed snapshot event features reach both frozen volatility and dispersion detectors', async () => {
  const {detectDispersionRotations, detectVolatilityShocks} = await import('../src/m4/event-engine.mjs');
  const rows = Array.from({length: 9}, (_, index) => ({
    eventTime: start + index * H4,
    completed: true,
    volatilityProxy: 1,
    dispersionProxy: 1,
    positiveReturnBreadth: 0.70,
    negativeReturnBreadth: 0.10,
    members: [{symbol: 'AUSDT', pitReturnRank: 1}],
  }));
  rows[7].volatilityProxy = 1.2;
  rows[7].dispersionProxy = 1.2;
  rows[8].volatilityProxy = 10;
  rows[8].dispersionProxy = 10;
  const enriched = addObservedSnapshotEventFeatures(rows);
  // A transition fixture uses the historical z-score stream generated by the
  // same formal adapter; its detector thresholds remain the frozen 1 -> 1.5.
  enriched[8].previousDispersionZ = 0.9;
  enriched[8].dispersionZ = 1.6;
  assert.equal(detectVolatilityShocks(enriched).length, 1);
  assert.equal(detectDispersionRotations(enriched).length, 2);
});

test('leverage feature is unavailable below 100 derivative-ready PIT symbols and available at 100', () => {
  const member = index => ({symbol: `S${index}USDT`, fundingZ: 2, premiumZ: 1.5, oiZ: 1, fundingValid: true});
  const stats = {archiveObservedCount: 0, historyReadyCount: 0, liquidityReadyCount: 0, featureReadyCount: 0, dataLossCount: 0, otherwiseEligibleCount: 0, corruptionLostCount: 0, dataLossReasonCounts: {}, liquidityUnavailableMemberCount: 0, futureListedMemberCount: 0, postDelistMemberCount: 0, btcStatus: null};
  const build = members => buildObservedPITSnapshot({timestamp: start, precomputedMembers: members, precomputedStats: stats, includeSymbolLists: false});
  const below = build(Array.from({length: 99}, (_, index) => member(index)));
  const ready = build(Array.from({length: 100}, (_, index) => member(index)));
  assert.equal(below.derivativeReadyCount, 99);
  assert.equal(below.leverageFeatureAvailable, false);
  assert.equal(below.crowdingStressZ, null);
  assert.equal(ready.derivativeReadyCount, 100);
  assert.equal(ready.leverageFeatureAvailable, true);
  assert.equal(ready.crowdingStressZ, 2);
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
