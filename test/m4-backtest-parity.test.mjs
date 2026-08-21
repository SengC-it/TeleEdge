import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {DAY, H1} from '../src/config.mjs';
import {settleOnCompletedBars} from '../src/backtest.mjs';
import {advanceModelTo, buildCoreBreadth, processCandidates} from '../scripts/backtest.mjs';
import {fetchPaged} from '../scripts/fetch-backtest-data.mjs';
import {activeWindowForMarket, continuityIssues, hasCompleteSeries} from '../scripts/backtest-data.mjs';
import {verifyBacktestManifest} from '../scripts/verify-backtest-data.mjs';
import {acceptCandidates, evaluateCandidateAcceptance} from '../src/portfolio.mjs';

const market = symbol => ({
  symbol,
  filters: [
    {filterType: 'PRICE_FILTER', tickSize: '0.01'},
    {filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001'},
  ],
});

const candidate = (symbol, edgeScore) => ({
  id: `${symbol}-signal`,
  t: 1_000_000,
  marketId: symbol,
  symbol: symbol.replace(/USDT$/, ''),
  side: 'long',
  family: 'dailyBreakout',
  route: 'test',
  entry: 100,
  sl: 95,
  target: 110,
  targetR: 2,
  stopPct: 0.05,
  edgeScore,
  edgeSegment: 'test',
  eventScore: edgeScore,
  dayVolume: 100_000_000,
  fundingZ: 0,
  breadthAbove50: 0.6,
  breadthMomentum5d: 0.1,
  btcRouter: 'bull',
  btcRouterStrength: 0.1,
});

const model = () => ({
  name: 'V7.5 Control',
  v8: false,
  equity: 10_000,
  peakEquity: 10_000,
  open: [],
  trades: [],
  signalEvents: [],
  allocations: [],
  knownSignalIds: new Set(),
  cooldowns: {},
  rejectionReasons: {},
  acceptedSignals: 0,
});

const dataFor = symbol => ({
  market: market(symbol),
  h1: [{t: 1_000_000 + 20 * 60_000, o: 100, h: 101, l: 99, c: 100}],
  m1: [],
  funding: [],
});

test('backtest ranks all same-cycle markets globally and is input-order independent', () => {
  const rows = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT', 'EEEUSDT'];
  const candidates = rows.map((symbol, index) => candidate(symbol, index + 1));
  const dataBySymbol = new Map(rows.map(symbol => [symbol, dataFor(symbol)]));
  const run = input => {
    const state = model();
    processCandidates(state, input, dataBySymbol, {executionProxy: true, endTime: 4_000_000});
    return state.open.map(position => position.marketId);
  };
  assert.deepEqual(run(candidates), ['EEEUSDT', 'DDDUSDT', 'CCCUSDT']);
  assert.deepEqual(run([...candidates].reverse()), ['EEEUSDT', 'DDDUSDT', 'CCCUSDT']);
});

test('decision-time advancement releases capacity before acceptance', () => {
  const base = Date.parse('2026-01-01T00:00:00Z');
  const state = model();
  const oldPosition = {
    id: 'old', marketId: 'OLDUSDT', symbol: 'OLD', side: 'long', status: 'open',
    fillTime: base, entry: 100, stop: 95, target: 105, quantity: 1, riskUsdt: 5, fundingPnlUsdt: 0,
  };
  state.open = [
    oldPosition,
    ...Array.from({length: 6}, (_, index) => ({id: `long-${index}`, marketId: `LONG${index}USDT`, side: 'long', status: 'open', riskUsdt: 1})),
    ...Array.from({length: 3}, (_, index) => ({id: `short-${index}`, marketId: `SHORT${index}USDT`, side: 'short', status: 'open', riskUsdt: 1})),
  ];
  const dataBySymbol = new Map([
    ['OLDUSDT', {
      market: market('OLDUSDT'), h1: [], funding: [],
      m1: [{t: base + 10 * 60_000, h: 106, l: 99, o: 100, c: 105}],
      execution: {oneMinuteComplete: true},
    }],
    ['NEWUSDT', {
      market: market('NEWUSDT'), h1: [], funding: [],
      m1: [{t: base + 20 * 60_000, h: 101, l: 99, o: 100, c: 100}],
      execution: {oneMinuteComplete: true},
    }],
  ]);
  const decisionTime = base + 20 * 60_000;
  advanceModelTo(state, dataBySymbol, decisionTime, {preferMinute: true});
  assert.equal(state.trades[0].exitReason, 'tp');
  assert.equal(state.open.length, 9);
  const next = {...candidate('NEWUSDT', 1), id: 'new-signal', t: base};
  processCandidates(state, [next], dataBySymbol, {endTime: base + H1, rankedCandidates: [next]});
  assert.equal(state.open.some(position => position.marketId === 'NEWUSDT'), true);
});

test('local and backtest acceptance share fill, tick, step, minimum and risk outputs', () => {
  const base = Date.parse('2026-01-02T00:00:00Z');
  const decisionTime = base + 20 * 60_000;
  const marketId = 'PARITYUSDT';
  const item = {...candidate(marketId, 1), id: 'parity-signal', t: base, fillTime: decisionTime, fillPrice: 101};
  const marketData = market(marketId);
  const contract = evaluateCandidateAcceptance(item, {
    activePositions: [], cooldowns: {}, equityUsdt: 10_000, market: marketData,
    decisionTime, fillTime: decisionTime, fillPrice: 101, strictFill: true,
  });
  const local = acceptCandidates([item], {
    equityUsdt: 10_000, positions: [], closedPositions: [], processedSignalIds: [], cooldowns: {},
  }, new Map([[marketId, marketData]]), {decisionTime, strictFill: true});
  const state = model();
  const dataBySymbol = new Map([[marketId, {
    market: marketData,
    h1: [], funding: [],
    m1: [{t: decisionTime, h: 102, l: 100, o: 101, c: 101}],
    execution: {oneMinuteComplete: true},
  }]]);
  processCandidates(state, [item], dataBySymbol, {endTime: base + H1, rankedCandidates: [item]});
  const localPosition = local.accepted[0];
  const backtestPosition = state.open[0];
  assert.equal(contract.accepted, true);
  assert.equal(local.accepted.length, 1);
  assert.equal(state.acceptedSignals, 1);
  for (const field of ['quantity', 'stop', 'target', 'stopPct', 'effectiveTargetR', 'riskUsdt', 'notionalUsdt']) {
    assert.equal(backtestPosition[field], localPosition[field], field);
  }
});

function dailySeries(direction) {
  return Array.from({length: 60}, (_, index) => {
    const close = direction === 'up' ? 100 + index : 200 - index;
    return {t: (index + 1) * DAY, o: close, h: close + 1, l: close - 1, c: close, q: 1};
  });
}

test('backtest breadth is invariant to expanded/non-core markets', () => {
  const core = new Map([
    ['BTCUSDT', dailySeries('up')],
    ['ETHUSDT', dailySeries('down')],
  ]);
  const extended = new Map(core);
  for (let index = 0; index < 50; index++) extended.set(`NONCORE${index}USDT`, dailySeries(index % 2 ? 'up' : 'down'));
  assert.deepEqual([...buildCoreBreadth(core)], [...buildCoreBreadth(extended)]);
});

test('1m Binance pagination advances by one minute without gaps or duplicates', async () => {
  const step = 60_000;
  const total = 2_000;
  const rawRows = Array.from({length: total}, (_, index) => [index * step, '100', '101', '99', '100', '0', '0', '0']);
  const starts = [];
  const rows = await fetchPaged('/fapi/v1/klines', {
    symbol: 'BTCUSDT', interval: '1m', startTime: 0, endTime: total * step,
  }, {
    rowLimit: 1_500,
    mapRow: row => ({t: Number(row[0])}),
    fetchPage: async url => {
      const start = Number(url.searchParams.get('startTime'));
      starts.push(start);
      const offset = start / step;
      return rawRows.slice(offset, offset + 1_500);
    },
  });
  assert.deepEqual(starts, [0, 1_500 * step]);
  assert.equal(rows.length, total);
  assert.equal(new Set(rows.map(row => row.t)).size, total);
  assert.deepEqual(rows.slice(1).map((row, index) => row.t - rows[index].t), new Array(total - 1).fill(step));
});

test('artifact verification reports timestamp continuity failures in addition to hash failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleedge-backtest-'));
  try {
    const relative = 'minute/BTCUSDT.json.gz';
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const rows = [{t: 0}, {t: 120_000}];
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(rows)));
    const manifest = {
      status: 'COMPLETE',
      universe: {pointInTime: true, historicalDelistingsResolved: true},
      execution: {preferredInterval: '1m', oneMinuteAvailable: true},
      artifacts: [{path: relative, kind: 'minute', interval: '1m', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}],
    };
    const result = verifyBacktestManifest(manifest, root);
    assert.equal(result.mismatched.length, 0);
    assert.equal(result.continuity.length, 1);
    assert.equal(result.complete, false);
    assert.equal(continuityIssues(rows, '1m')[0].reason, 'non-contiguous-timestamp');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('per-symbol active windows allow later-listed and delisted markets to verify independently', () => {
  const globalStart = 0;
  const globalEnd = 5 * 60_000;
  const lifecycle = activeWindowForMarket({
    symbol: 'LATEUSDT',
    market: {onboardDate: 2 * 60_000},
    manifest: {markets: [{symbol: 'LATEUSDT', activeStart: 2 * 60_000, activeEnd: 5 * 60_000}]},
    startTime: globalStart,
    endTime: globalEnd,
  });
  const rows = [2, 3, 4].map(minute => ({t: minute * 60_000}));
  assert.equal(lifecycle.eligibleStart, 2 * 60_000);
  assert.equal(lifecycle.eligibleEnd, globalEnd);
  assert.equal(hasCompleteSeries(rows, '1m', lifecycle.eligibleStart, lifecycle.eligibleEnd), true);
  assert.equal(hasCompleteSeries(rows, '1m', globalStart, globalEnd), false);
});

test('strict artifact gate rejects empty or short required market artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleedge-backtest-gate-'));
  try {
    const relative = 'minute/NEWUSDT.json.gz';
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify([])));
    const manifest = {
      schemaVersion: 2,
      status: 'COMPLETE',
      universe: {
        symbols: ['NEWUSDT'], pointInTime: true, historicalDelistingsResolved: true,
        expandedNonCoreCovered: true, markets: [{symbol: 'NEWUSDT', activeStart: 0, activeEnd: 60_000}],
      },
      execution: {preferredInterval: '1m', oneMinuteAvailable: true},
      artifacts: [{
        path: relative, symbol: 'NEWUSDT', kind: 'minute', interval: '1m', activeStart: '1970-01-01T00:00:00.000Z', activeEnd: '1970-01-01T00:01:00.000Z', rows: 1,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      }],
    };
    const result = verifyBacktestManifest(manifest, root);
    assert.equal(result.complete, false);
    assert.equal(result.rowCounts.length, 1);
    assert.equal(result.coverage[0].firstIssues[0].reason, 'empty-artifact');
    assert.ok(result.missing.some(item => item.key === 'NEWUSDT|price'));
    assert.ok(result.missing.some(item => item.key === 'NEWUSDT|funding'));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('formal 1m settlement uses first touch by minute after fill', () => {
  const base = Date.parse('2026-01-01T16:00:00Z');
  const result = settleOnCompletedBars(
    {side: 'long', stop: 95, target: 105, fillTime: base + 31 * 60_000 + 30_000, entry: 100, quantity: 1, riskUsdt: 5},
    [
      {t: base + 32 * 60_000, h: 106, l: 99},
      {t: base + 51 * 60_000, h: 101, l: 94},
    ],
    [],
    {now: base + H1 + 1, barIntervalMs: 60_000},
  );
  assert.equal(result.trade.exitReason, 'tp');
  assert.equal(result.trade.exitTime, base + 33 * 60_000);
});
