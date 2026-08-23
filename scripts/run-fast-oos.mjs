import fs from 'node:fs';
import path from 'node:path';
import {APP_DIR} from '../src/config.mjs';
import {runBacktest} from './backtest.mjs';

const universePath = path.join(APP_DIR, 'reports', 'fast-oos-universe.json');
const outputBase = path.join(APP_DIR, 'reports', 'm5-fast-backtest');
const start = Date.parse('2021-01-01T00:00:00.000Z');
const end = Date.parse('2026-07-15T00:00:00.000Z');

if (!fs.existsSync(universePath)) throw new Error(`Missing ${universePath}; run npm run backtest:fast-universe first`);
const universe = JSON.parse(fs.readFileSync(universePath, 'utf8'));
const symbols = [...new Set(universe.executionSymbols || [])].sort();
if (symbols.length < 50) throw new Error(`Fast OOS execution universe has only ${symbols.length} symbols; refusing a smaller M5 run`);
if (universe.status !== 'READY_FOR_FAST_OOS') throw new Error(`Fast OOS universe is not ready: ${universe.status}`);

const report = await runBacktest({
  symbols,
  start,
  end,
  scanIntervalHours: 4,
  outputBase,
  mode: 'formal',
  executionProxy: false,
  allowExternalCache: false,
  dataRoot: path.join(APP_DIR, 'data', 'backtest'),
});

if (report.data.executionProxy !== false) throw new Error('M5 formal run unexpectedly used an execution proxy');
if (report.data.executionInterval !== '1m') throw new Error(`M5 formal run did not achieve 1m execution: ${report.data.executionInterval}`);
if (report.data.sampleSize.symbolsWithCompleteOneMinute !== symbols.length) {
  throw new Error(`M5 formal run has incomplete 1m execution coverage: ${report.data.sampleSize.symbolsWithCompleteOneMinute}/${symbols.length}`);
}

console.log(JSON.stringify({
  output: `${outputBase}.json`,
  symbols: symbols.length,
  scanIntervalHours: 4,
  decisionLatencyMinutes: 20,
  executionInterval: report.data.executionInterval,
  executionProxy: report.data.executionProxy,
  snapshotEnd: report.data.snapshotEnd,
  models: report.models.map(model => ({
    model: model.model,
    oosTrades: model.splits.oos.trades,
    oosExpectancyR: model.splits.oos.netExpectancyR,
    oosProfitFactor: model.splits.oos.profitFactor,
  })),
}, null, 2));
