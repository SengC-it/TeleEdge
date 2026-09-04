import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPitUniverseFromFiles,
  buildPitUniverseAt,
  isPitMarketDataAvailableAt,
  listingAgeDaysAt,
  liquidityEligibilityAt,
  monthlyLiquidityCounts,
  monthlyPitCounts,
  resolvePitWindow,
  isCryptoUsdMPerpetual,
  M4_LIQUIDITY_THRESHOLD_USDT,
} from '../src/m4/pit-universe.mjs';
import {buildEventSnapshots, eventOutcome, runEventResearch} from '../scripts/run-m4-event-regime.mjs';
import {buildLifecycleEpisodes} from '../scripts/fetch-binance-lifecycle-evidence.mjs';
import {DAY, H1} from '../src/config.mjs';
import {
  EVENT_DEFINITIONS,
  detectBreadthRegimeTransitions,
  detectDispersionRotations,
  detectEvents,
  detectLeverageStressTransitions,
  detectTrendRegimeTransitions,
  detectVolatilityShocks,
  dedupeEventEpisodes,
  evaluateEventKeepGate,
  matchEventControls,
  purgeEventLabels,
  summarizeEventOutcomes,
} from '../src/m4/event-engine.mjs';
import {buildForwardSnapshot, completedOneHourKlines, writeImmutableForwardSnapshot} from '../scripts/capture-forward-research-snapshot.mjs';

const SHA = 'a'.repeat(64);
const START = Date.parse('2024-01-01T00:00:00Z');
const END = Date.parse('2026-01-01T00:00:00Z');

function archive(months) {
  return {klines: months.map(month => `data/futures/um/monthly/klines/TESTUSDT/1h/TESTUSDT-1h-${month}.zip`)};
}

function lifecycle(listing, delist, {listingExact = true, delistExact = true} = {}) {
  return {
    ...(listing == null ? {} : {listingEvidenceTimestamp: new Date(listing).toISOString(), listingEvidenceExact: listingExact, listingEvidenceSource: 'official-listing', listingEvidenceUrl: 'https://example.invalid/listing', listingEvidencePath: 'source/listing.json', listingEvidenceSha256: SHA}),
    ...(delist == null ? {} : {delistEvidenceTimestamp: new Date(delist).toISOString(), delistEvidenceExact: delistExact, delistEvidenceSource: 'official-delist', delistEvidenceUrl: 'https://example.invalid/delist', delistEvidencePath: 'source/delist.json', delistEvidenceSha256: SHA}),
  };
}

function market(overrides = {}) {
  return resolvePitWindow({
    symbol: 'TESTUSDT',
    start: START,
    end: END,
    archiveRecord: archive(['2023-12', '2024-01', '2024-02', '2025-12']),
    firstObserved: Date.parse('2023-12-01T00:00:00Z'),
    lastObserved: Date.parse('2025-12-31T23:00:00Z'),
    lifecycleRecord: lifecycle(null, Date.parse('2026-02-01T00:00:00Z')),
    ...overrides,
  });
}

test('PIT accepts a pre-Development market without an exact ancient listing minute', () => {
  const row = market({lifecycleRecord: lifecycle(null, Date.parse('2026-02-01T00:00:00Z'))});
  assert.equal(row.activeBeforeDevelopment, true);
  assert.equal(row.entryBoundaryResolved, true);
  assert.equal(row.pitWindowResolved, true);
  assert.equal(listingAgeDaysAt(row, START), null);
});

test('listing inside Development requires exact official listing evidence', () => {
  const row = market({
    archiveRecord: archive(['2024-02', '2024-03']),
    firstObserved: Date.parse('2024-02-01T00:00:00Z'),
    lastObserved: Date.parse('2024-03-31T23:00:00Z'),
    lifecycleRecord: lifecycle(null, Date.parse('2024-04-01T00:00:00Z')),
  });
  assert.equal(row.listingInsideDevelopment, false);
  assert.equal(row.entryBoundaryResolved, false);
  assert.equal(row.pitWindowResolved, false);
  const exact = market({
    archiveRecord: archive(['2024-02', '2024-03']),
    firstObserved: Date.parse('2024-02-01T00:00:00Z'),
    lastObserved: Date.parse('2024-03-31T23:00:00Z'),
    lifecycleRecord: lifecycle(Date.parse('2024-02-01T00:00:00Z'), Date.parse('2024-04-01T00:00:00Z')),
  });
  assert.equal(exact.listingInsideDevelopment, true);
  assert.equal(exact.pitWindowResolved, true);
  assert.equal(listingAgeDaysAt(exact, Date.parse('2024-03-01T00:00:00Z')), 29);
});

test('delist inside Development requires exact evidence and preserves the active window', () => {
  const delist = Date.parse('2025-05-15T09:00:00Z');
  const row = market({lifecycleRecord: lifecycle(null, delist), lastObserved: Date.parse('2025-05-15T08:59:00Z')});
  assert.equal(row.delistedInsideDevelopment, true);
  assert.equal(row.activeEnd, new Date(delist).toISOString());
  assert.equal(row.pitWindowResolved, true);
  const unresolved = market({lifecycleRecord: lifecycle(null, delist, {delistExact: false}), lastObserved: Date.parse('2025-05-15T08:59:00Z')});
  assert.equal(unresolved.pitWindowResolved, false);
});

test('current market snapshot resolves active-through-Development-end without inventing a delist', () => {
  const row = market({
    currentMarket: {symbol: 'TESTUSDT', quoteAsset: 'USDT', contractType: 'PERPETUAL', onboardDate: Date.parse('2023-01-01T00:00:00Z')},
    lifecycleRecord: {},
    snapshotTimestamp: Date.parse('2026-02-01T00:00:00Z'),
    archiveRecord: archive(['2023-12', '2024-01']),
    lastObserved: Date.parse('2024-01-31T23:00:00Z'),
  });
  assert.equal(row.activeThroughDevelopmentEnd, true);
  assert.equal(row.delistTimestamp, null);
  assert.equal(row.pitWindowResolved, true);
});

test('historically delisted markets remain eligible before their exact delist boundary', () => {
  const row = market({
    currentMarket: null,
    lifecycleRecord: lifecycle(Date.parse('2023-01-01T00:00:00Z'), Date.parse('2025-06-01T00:00:00Z')),
    lastObserved: Date.parse('2025-05-31T23:59:00Z'),
  });
  assert.equal(row.historicalDelisted, true);
  assert.equal(row.pitWindowResolved, true);
  assert.deepEqual(buildPitUniverseAt(Date.parse('2025-05-31T12:00:00Z'), [row], {requireData: false}), ['TESTUSDT']);
  assert.deepEqual(buildPitUniverseAt(Date.parse('2025-06-01T12:00:00Z'), [row], {requireData: false}), []);
});

test('dynamic PIT universe excludes a symbol before listing and after delisting', () => {
  const row = market({
    lifecycleRecord: lifecycle(Date.parse('2024-04-01T00:00:00Z'), Date.parse('2024-07-01T00:00:00Z')),
    archiveRecord: archive(['2024-04', '2024-05', '2024-06']),
    firstObserved: Date.parse('2024-04-01T00:00:00Z'),
    lastObserved: Date.parse('2024-06-30T23:59:00Z'),
  });
  assert.deepEqual(buildPitUniverseAt(Date.parse('2024-03-31T23:59:00Z'), [row], {requireData: false}), []);
  assert.deepEqual(buildPitUniverseAt(Date.parse('2024-04-01T00:00:00Z'), [row], {requireData: false}), ['TESTUSDT']);
  assert.deepEqual(buildPitUniverseAt(Date.parse('2024-07-01T00:00:00Z'), [row], {requireData: false}), []);
});

test('archive inference cannot certify an in-window delist', () => {
  const row = market({
    currentMarket: null,
    archiveRecord: archive(['2023-12', '2024-01', '2024-12']),
    firstObserved: Date.parse('2023-12-01T00:00:00Z'),
    lastObserved: Date.parse('2024-12-31T23:00:00Z'),
    lifecycleRecord: {},
  });
  assert.equal(row.exitBoundaryResolved, false);
  assert.equal(row.pitWindowResolved, false);
  assert.ok(row.lifecycleConflictReasons.includes('exit-boundary-unresolved'));
});

test('lifecycle observation conflicts fail closed', () => {
  const row = market({
    lifecycleRecord: lifecycle(Date.parse('2024-02-01T00:00:00Z'), Date.parse('2025-01-01T00:00:00Z')),
    firstObserved: Date.parse('2024-01-01T00:00:00Z'),
  });
  assert.equal(row.noLifecycleConflict, false);
  assert.equal(row.pitWindowResolved, false);
  assert.ok(row.lifecycleConflictReasons.includes('listing-after-first-observed'));
});

test('monthly PIT counts are based on resolved lifecycle rather than current survival', () => {
  const resolved = market({lifecycleRecord: lifecycle(null, Date.parse('2025-05-01T00:00:00Z')), lastObserved: Date.parse('2025-04-30T23:00:00Z')});
  const unresolved = market({symbol: 'OTHERUSDT', lifecycleRecord: {}, currentMarket: null});
  const counts = monthlyPitCounts([resolved, unresolved], START, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(counts['2024-01'].pitEligibleSymbols, 1);
  assert.equal(counts['2025-06'].pitEligibleSymbols, 0);
});

test('PIT liquidity uses only completed point-in-time 30-day volume and fails closed when absent', () => {
  const row = {...market(), liquidityByMonth: {'2024-01': 21_000_000, '2024-02': 19_000_000}};
  assert.equal(liquidityEligibilityAt(row, Date.parse('2024-01-31T23:59:59Z')).eligible, true);
  assert.equal(liquidityEligibilityAt(row, Date.parse('2024-02-29T23:59:59Z')).eligible, false);
  assert.equal(liquidityEligibilityAt(market(), Date.parse('2024-01-31T23:59:59Z')).available, false);
  const counts = monthlyLiquidityCounts([row], START, Date.parse('2024-03-01T00:00:00Z'));
  assert.equal(counts['2024-01'].pitEligibleSymbols, 1);
  assert.equal(counts['2024-02'].pitEligibleSymbols, 0);
  assert.equal(counts['2024-02'].liquidityUnknown, 0);
});

test('dynamic PIT universe requires point-in-time data and never treats monthly liquidity as intramonth data', () => {
  const row = {
    ...market(),
    liquidityByMonth: {'2025-05': 21_000_000},
    data: {
      complete: true,
      artifacts: Object.fromEntries([
        ['price', {present: true, nonEmpty: true, firstTimestamp: START, lastTimestamp: END}],
        ['minute', {present: true, nonEmpty: true, firstTimestamp: START, lastTimestamp: END}],
        ['funding', {present: true, nonEmpty: true, firstTimestamp: START, lastTimestamp: END}],
      ]),
    },
  };
  assert.equal(isPitMarketDataAvailableAt(row, Date.parse('2025-05-31T12:00:00Z')), true);
  assert.deepEqual(buildPitUniverseAt(Date.parse('2025-05-31T12:00:00Z'), [row]), ['TESTUSDT']);
  assert.deepEqual(buildPitUniverseAt(Date.parse('2025-05-15T12:00:00Z'), [row], {requireLiquidity: true}), []);
  assert.deepEqual(buildPitUniverseAt(Date.parse('2025-05-31T12:00:00Z'), [row], {requireLiquidity: true}), []);
  assert.deepEqual(buildPitUniverseAt(Date.parse('2025-05-31T12:00:00Z'), [row], {requireData: false, requireLiquidity: true}), []);
});

test('breadth transition uses two completed confirmation observations', () => {
  const t = Date.parse('2025-01-01T00:00:00Z');
  const events = detectBreadthRegimeTransitions([
    {eventTime: t, breadthAbove50: 0.40},
    {eventTime: t + 4 * 3_600_000, breadthAbove50: 0.56},
    {eventTime: t + 8 * 3_600_000, breadthAbove50: 0.55},
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].sideHypothesis, 'long');
});

test('event detectors ignore incomplete observations instead of using them as confirmation', () => {
  const t = Date.parse('2025-01-01T00:00:00Z');
  const events = detectBreadthRegimeTransitions([
    {eventTime: t, breadthAbove50: 0.40},
    {eventTime: t + 4 * 3_600_000, breadthAbove50: 0.56},
    {eventTime: t + 8 * 3_600_000, breadthAbove50: 0.55, completed: false},
    {eventTime: t + 12 * 3_600_000, breadthAbove50: 0.55},
  ]);
  assert.equal(events.length, 0);
});

test('volatility shock separates directional events from nondirectional diagnostics', () => {
  const t = Date.parse('2025-01-01T00:00:00Z');
  const rows = detectVolatilityShocks([
    {eventTime: t, realizedVolZ: 2.1, directionalBreadth: 0.70, marketDirection: 'long'},
    {eventTime: t + 4 * 3_600_000, realizedVolZ: 2.2, directionalBreadth: 0.50, marketDirection: 'short'},
  ]);
  assert.equal(rows[0].sideHypothesis, 'long');
  assert.equal(rows[0].diagnostic, false);
  assert.equal(rows[1].sideHypothesis, null);
  assert.equal(rows[1].diagnostic, true);
});

test('dispersion rotation selects PIT top/bottom 10 percent with deterministic max three per side', () => {
  const members = Array.from({length: 30}, (_, index) => ({symbol: `S${String(index).padStart(2, '0')}USDT`, pitReturnRank: index / 29}));
  const events = detectDispersionRotations([{eventTime: 1, previousDispersionZ: 0.9, dispersionZ: 1.6, members}]);
  assert.equal(events.length, 6);
  assert.deepEqual(events.filter(row => row.sideHypothesis === 'long').map(row => row.symbol), ['S29USDT', 'S28USDT', 'S27USDT']);
  assert.deepEqual(events.filter(row => row.sideHypothesis === 'short').map(row => row.symbol), ['S00USDT', 'S01USDT', 'S02USDT']);
});

test('leverage stress requires two consistent dimensions and completed break direction', () => {
  const events = detectLeverageStressTransitions([{eventTime: 1, crowdingStressZ: 2.4, fundingZ: 2, premiumZ: 1.5, oiZ: 0.2, marketDirection: 'short'}]);
  assert.equal(events.length, 1);
  assert.equal(events[0].sideHypothesis, 'short');
  assert.deepEqual(events[0].features.consistentDimensions, ['funding', 'premium', 'oi']);
});

test('trend transition requires two completed bars in the new state', () => {
  const events = detectTrendRegimeTransitions([
    {eventTime: 1, marketRegime: 'SIDEWAYS'},
    {eventTime: 2, marketRegime: 'BULL'},
    {eventTime: 3, marketRegime: 'BULL'},
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].sideHypothesis, 'long');
});

test('event dedupe applies 72-hour refractory by family, direction, and symbol/market level', () => {
  const events = detectEvents([
    {eventTime: 1, breadthAbove50: 0.4},
    {eventTime: 2, breadthAbove50: 0.56},
    {eventTime: 3, breadthAbove50: 0.56},
  ]);
  const duplicate = {...events[0], eventId: 'duplicate', eventTime: events[0].eventTime + 24 * 3_600_000};
  const result = dedupeEventEpisodes([...events, duplicate]);
  assert.equal(result.independentEvents.length, 1);
  assert.equal(result.suppressedEvents.length, 1);
});

test('controls use deterministic exact strata and stable nearest-time tie break', () => {
  const event = {eventId: 'event', eventTime: Date.parse('2025-02-02T00:00:00Z'), sideHypothesis: 'long', marketRegime: 'BULL'};
  const controls = matchEventControls(event, [
    {id: 'b', signalTime: event.eventTime + 1, side: 'long', month: '2025-02', marketRegime: 'BULL'},
    {id: 'a', signalTime: event.eventTime - 1, side: 'long', month: '2025-02', marketRegime: 'BULL'},
    {id: 'wrong', signalTime: event.eventTime, side: 'short', month: '2025-02', marketRegime: 'BULL'},
  ]);
  assert.deepEqual(controls.map(row => row.id), ['a']);
});

test('event-end purge excludes labels that overlap the validation boundary', () => {
  const result = purgeEventLabels([
    {id: 'safe', exitTime: 1},
    {id: 'overlap', exitTime: Date.parse('2025-01-01T00:00:00Z') - 72 * 3_600_000},
  ], {validationStart: Date.parse('2025-01-01T00:00:00Z')});
  assert.equal(result.kept.length, 1);
  assert.equal(result.excludedByOutcomeOverlap, 1);
  assert.equal(result.labelOverlapFree, true);
  assert.equal(result.rawLabelOverlapFree, false);
});

test('event summary and gate do not convert a small positive point estimate into KEEP', () => {
  const summary = summarizeEventOutcomes([{symbol: 'A', executable: true, netR: 0.5, netPnlUsdt: 1}]);
  assert.equal(summary.executable, 1);
  assert.equal(evaluateEventKeepGate(summary), 'WATCH');
  assert.equal(EVENT_DEFINITIONS.MARKET_VOLATILITY_SHOCK.realizedVolZ, 2);
});

test('forward snapshot records immutable source hashes and refuses overwrite', () => {
  const snapshot = buildForwardSnapshot({
    captureTime: '2026-09-04T00:00:00.000Z',
    exchangeInfo: {symbols: [{symbol: 'BTCUSDT', quoteAsset: 'USDT', contractType: 'PERPETUAL'}]},
    requestedSymbols: ['BTCUSDT'],
    feeds: [{id: 'BTCUSDT:price-1h', url: 'https://example.invalid/klines', ok: true, sourceTimestamp: '2026-09-04T00:00:00.000Z', sha256: SHA, bytes: 10}],
  });
  assert.equal(snapshot.immutable, true);
  assert.equal(snapshot.pitStatus, 'SNAPSHOT_COMPLETE');
  assert.match(snapshot.snapshotSha256, /^[a-f0-9]{64}$/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleedge-forward-'));
  try {
    writeImmutableForwardSnapshot(root, snapshot);
    assert.throws(() => writeImmutableForwardSnapshot(root, snapshot), /already exists/);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('forward capture excludes an unfinished one-hour candle', () => {
  const capture = '2026-09-04T01:00:00.000Z';
  const rows = [
    [Date.parse('2026-09-03T23:00:00Z'), '1'],
    [Date.parse('2026-09-04T00:00:00Z'), '2'],
  ];
  assert.deepEqual(completedOneHourKlines(rows, capture).map(row => row[0]), [rows[0][0]]);
});

test('post-Development listings and pre-Development ended markets do not block the PIT window', () => {
  const post = resolvePitWindow({
    symbol: 'POSTUSDT', start: START, end: END,
    archiveRecord: {}, currentMarket: {symbol: 'POSTUSDT', quoteAsset: 'USDT', contractType: 'PERPETUAL', onboardDate: END + DAY},
    snapshotTimestamp: END + DAY,
  });
  assert.equal(post.likelyActiveInDevelopment, false);
  assert.equal(post.pitWindowResolved, true);
  const ended = resolvePitWindow({
    symbol: 'ENDEDUSDT', start: START, end: END,
    archiveRecord: archive(['2023-12']),
    firstObserved: START - DAY, lastObserved: START - 60_000,
    lifecycleRecord: lifecycle(START - 10 * DAY, START - 60_000),
  });
  assert.equal(ended.likelyActiveInDevelopment, false);
  assert.equal(ended.pitWindowResolved, true);
});

test('relisted markets retain multiple active episodes and do not use current onboard to erase history', () => {
  const firstListing = START - 100 * DAY;
  const firstDelist = START + 30 * DAY;
  const secondListing = START + 60 * DAY;
  const secondDelist = END + DAY;
  const row = resolvePitWindow({
    symbol: 'RELISTUSDT', start: START, end: END,
    archiveRecord: archive(['2023-12', '2024-01', '2024-03', '2024-12']),
    firstObserved: firstListing, lastObserved: END - DAY,
    currentMarket: {symbol: 'RELISTUSDT', quoteAsset: 'USDT', contractType: 'PERPETUAL', onboardDate: secondListing},
    snapshotTimestamp: END + DAY,
    lifecycleRecord: {activeEpisodes: [
      {...lifecycle(firstListing, firstDelist)},
      {...lifecycle(secondListing, secondDelist)},
    ]},
  });
  assert.equal(row.activeEpisodes.length, 2);
  assert.equal(row.activeEpisodes[0].delistTimestamp, new Date(firstDelist).toISOString());
  assert.equal(row.activeEpisodes[1].listingTimestamp, new Date(secondListing).toISOString());
  assert.equal(row.lifecycleConflictClasses.includes('RELIST_EPISODE_DETECTED'), true);
  assert.equal(row.pitWindowResolved, true);
});

test('PIT universe excludes TradFi perpetuals while admitting crypto USD-M perpetuals', () => {
  assert.equal(isCryptoUsdMPerpetual({quoteAsset: 'USDT', contractType: 'TRADIFI_PERPETUAL'}), false);
  assert.equal(isCryptoUsdMPerpetual({quoteAsset: 'USDT', contractType: 'PERPETUAL', underlyingType: 'EQUITY'}), false);
  assert.equal(isCryptoUsdMPerpetual({quoteAsset: 'USDT', contractType: 'PERPETUAL', underlyingType: 'COIN'}), true);
});

test('formal liquidity uses completed hourly quote volume, excludes future hours, and divides by 30 days', () => {
  const at = Date.parse('2024-03-01T00:00:00Z');
  const q = M4_LIQUIDITY_THRESHOLD_USDT / 24;
  const rows = Array.from({length: 720}, (_, index) => ({t: at - (720 - index) * H1, q, o: 1, h: 1, l: 1, c: 1}));
  rows.push({t: at, q: 1_000_000_000, o: 1, h: 1, l: 1, c: 1});
  const result = resolvePitWindow({
    symbol: 'LIQUSDT', start: START, end: END, archiveRecord: archive(['2024-01']),
    firstObserved: START, lastObserved: END - H1, lifecycleRecord: lifecycle(null, END + DAY), priceRows: rows,
  });
  const liquidity = liquidityEligibilityAt(result, at);
  assert.equal(liquidity.available, true);
  assert.equal(liquidity.volumeUsdt, M4_LIQUIDITY_THRESHOLD_USDT);
  assert.equal(liquidity.eligible, true);
});

test('formal liquidity is unavailable before 30 days and fails closed on an internal gap', () => {
  const at = Date.parse('2024-03-01T00:00:00Z');
  const q = M4_LIQUIDITY_THRESHOLD_USDT / 24;
  const shortRows = Array.from({length: 24}, (_, index) => ({t: at - (24 - index) * H1, q}));
  const short = resolvePitWindow({symbol: 'SHORTLIQUSDT', start: START, end: END, archiveRecord: archive(['2024-01']), firstObserved: START, lastObserved: END - H1, lifecycleRecord: lifecycle(null, END + DAY), priceRows: shortRows});
  assert.equal(liquidityEligibilityAt(short, at).reason, 'insufficient-30d-history');
  const fullRows = Array.from({length: 720}, (_, index) => ({t: at - (720 - index) * H1, q}));
  fullRows.splice(300, 1);
  const gapped = resolvePitWindow({symbol: 'GAPLIQUSDT', start: START, end: END, archiveRecord: archive(['2024-01']), firstObserved: START, lastObserved: END - H1, lifecycleRecord: lifecycle(null, END + DAY), priceRows: fullRows});
  assert.equal(liquidityEligibilityAt(gapped, at).reason, 'liquidity-window-gap');
});

test('event transition timestamp is the confirmation bar, not the crossing bar', () => {
  const t = Date.parse('2025-01-01T00:00:00Z');
  const breadth = detectBreadthRegimeTransitions([
    {eventTime: t, breadthAbove50: 0.40},
    {eventTime: t + 4 * H1, breadthAbove50: 0.56},
    {eventTime: t + 8 * H1, breadthAbove50: 0.55},
  ]);
  assert.equal(breadth[0].eventTime, t + 8 * H1);
  assert.equal(breadth[0].transitionStartTime, t + 4 * H1);
  const trend = detectTrendRegimeTransitions([
    {eventTime: t, marketRegime: 'SIDEWAYS'},
    {eventTime: t + H1, marketRegime: 'BULL'},
    {eventTime: t + 2 * H1, marketRegime: 'BULL'},
  ]);
  assert.equal(trend[0].eventTime, t + 2 * H1);
});

test('volatility direction uses positive/negative return breadth and never breadthAbove50 fallback', () => {
  const t = Date.parse('2025-01-01T00:00:00Z');
  assert.equal(detectVolatilityShocks([{eventTime: t, realizedVolZ: 2.1, breadthAbove50: 0.9, marketDirection: 'long'}])[0].sideHypothesis, null);
  assert.equal(detectVolatilityShocks([{eventTime: t, realizedVolZ: 2.1, positiveReturnBreadth: 0.70, negativeReturnBreadth: 0.10}])[0].sideHypothesis, 'long');
  assert.equal(detectVolatilityShocks([{eventTime: t, realizedVolZ: 2.1, positiveReturnBreadth: 0.10, negativeReturnBreadth: 0.70}])[0].sideHypothesis, 'short');
});

test('mixed-sign leverage dimensions do not create a leverage event', () => {
  const events = detectLeverageStressTransitions([{eventTime: 1, crowdingStressZ: 2.4, fundingZ: 2, premiumZ: 1.5, oiZ: -1, marketDirection: 'short'}]);
  assert.equal(events.length, 0);
});

test('market-level events use BTCUSDT as the fixed canonical instrument', () => {
  const t = Date.parse('2025-02-01T00:00:00Z');
  const event = {eventId: 'btc-event', eventTime: t, eventFamily: 'MARKET_VOLATILITY_SHOCK', level: 'market', sideHypothesis: 'long'};
  const result = eventOutcome(event, {marketDataBySymbol: new Map([['BTCUSDT', {
    entry: 100,
    stop: 95,
    market: {symbol: 'BTCUSDT', filters: [{filterType: 'PRICE_FILTER', tickSize: '0.01'}, {filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001'}]},
    minuteRows: [
      {t: t + 20 * 60_000, o: 100, h: 101, l: 99, c: 100},
      {t: t + 21 * 60_000, o: 100, h: 110, l: 99, c: 109},
    ],
  }]])});
  assert.equal(result.symbol, 'BTCUSDT');
  assert.equal(result.exitReason, 'TP');
});

test('market-level events are non-executable when BTCUSDT is not PIT active', () => {
  const event = {eventId: 'btc-unavailable', eventTime: Date.parse('2025-02-01T00:00:00Z'), eventFamily: 'MARKET_VOLATILITY_SHOCK', level: 'market', sideHypothesis: 'long'};
  assert.equal(eventOutcome(event, {marketDataBySymbol: {BTCUSDT: {pitActive: false, minuteRows: []}}}), null);
});

test('controls require exact strata, reject contamination, and do not reuse a row within a family fold', () => {
  const t = Date.parse('2025-02-01T00:00:00Z');
  const event = {eventId: 'event', eventFamily: 'BREADTH_REGIME_TRANSITION', eventTime: t, sideHypothesis: 'long', marketRegime: 'BULL', liquidityBucket: 'high', outerFold: 0};
  const used = new Set();
  const observations = [
    {id: 'usable', signalTime: t + 4 * 24 * H1, side: 'long', marketRegime: 'BULL', liquidityBucket: 'high', outerFold: 0},
    {id: 'missing-stratum', signalTime: t + 5 * 24 * H1, side: 'long', marketRegime: 'BULL', outerFold: 0},
    {id: 'near-event', signalTime: t - H1, side: 'long', marketRegime: 'BULL', liquidityBucket: 'high', outerFold: 0},
  ];
  assert.deepEqual(matchEventControls(event, observations, {usedControlIds: used, eventRows: [event]}).map(row => row.id), ['usable']);
  assert.deepEqual(matchEventControls(event, observations, {usedControlIds: used, eventRows: [event]}), []);
});

test('purged kept labels are overlap-free while the exclusion count remains auditable', () => {
  const validationStart = Date.parse('2025-01-01T00:00:00Z');
  const result = purgeEventLabels([
    {id: 'safe', exitTime: validationStart - 4 * 24 * H1},
    {id: 'overlap', exitTime: validationStart - 2 * H1},
  ], {validationStart});
  assert.equal(result.kept.length, 1);
  assert.equal(result.labelOverlapFree, true);
  assert.equal(result.rawLabelOverlapFree, false);
});

test('feature-only event runner produces a non-empty research result without V9 alpha filtering', () => {
  const t = Date.parse('2025-01-01T00:00:00Z');
  const snapshots = buildEventSnapshots({featurePoints: [
    {symbol: 'BTCUSDT', eventTime: t, return4: -1, above50: false, marketRegime: 'SIDEWAYS'},
    {symbol: 'ETHUSDT', eventTime: t, return4: -1, above50: false},
    {symbol: 'BTCUSDT', eventTime: t + 4 * H1, return4: 1, above50: true, marketRegime: 'BULL'},
    {symbol: 'ETHUSDT', eventTime: t + 4 * H1, return4: 1, above50: true},
    {symbol: 'BTCUSDT', eventTime: t + 8 * H1, return4: 1, above50: true, marketRegime: 'BULL'},
    {symbol: 'ETHUSDT', eventTime: t + 8 * H1, return4: 1, above50: true},
  ], start: t - H1, end: t + 12 * H1});
  assert.equal(snapshots.length, 3);
  const result = runEventResearch({
    snapshots,
    start: t - H1,
    end: t + 12 * H1,
    outcomeForEvent: event => ({executable: true, canonicalExecutable: true, labelUsable: true, netR: 0.2, netPnlUsdt: 1, exitTime: event.eventTime + H1, forwardReturns: {h4: 0.1, h12: 0.2, h24: 0.3, h72: 0.4}}),
  });
  assert.equal(result.status, 'COMPLETED');
  assert.ok(result.independentEvents.length > 0);
  assert.ok(Object.values(result.families).some(row => row.raw > 0));
});

test('empty source universe cannot pass the PIT gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleedge-empty-pit-'));
  const source = path.join(root, 'source');
  fs.mkdirSync(source, {recursive: true});
  try {
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({snapshotTimestamp: '2026-02-01T00:00:00Z', universe: {symbols: []}, artifacts: []}));
    fs.writeFileSync(path.join(source, 'archive-index.json'), JSON.stringify({symbolsWithActualArchives: [], actualArchiveKeysBySymbol: {}}));
    fs.writeFileSync(path.join(source, 'current-exchangeInfo.json'), JSON.stringify({symbols: []}));
    const result = buildPitUniverseFromFiles({appDir: root, dataRoot: root});
    assert.equal(result.status, 'M4_BLOCKED');
    assert.ok(result.blockers.some(row => row.reason === 'empty-pit-universe'));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
