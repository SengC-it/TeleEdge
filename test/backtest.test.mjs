import test from 'node:test';
import assert from 'node:assert/strict';
import {accrueFunding, calculateMetrics, drawdownPercent, firstCompletedTouch, settleOnCompletedBars} from '../src/backtest.mjs';
import {observedAlphaCoverage, REQUIRED_ALPHA_COVERAGE} from '../scripts/backtest.mjs';
import {H1} from '../src/config.mjs';

test('backtest settlement excludes incomplete and pre-fill hourly bars with SL priority', () => {
  const position = {side: 'long', stop: 95, target: 110, fillTime: H1 + 1_800_000, entry: 100, quantity: 1, riskUsdt: 5};
  const touch = firstCompletedTouch(position, [
    {t: H1, closeTime: 2 * H1 - 1, h: 111, l: 90},
    {t: 2 * H1, closeTime: 3 * H1, h: 112, l: 90},
  ], 3 * H1 + 1);
  assert.deepEqual(touch, {reason: 'sl', price: 95, time: 3 * H1, ambiguous: true});
});

test('backtest funding uses side direction and mark-price fallback', () => {
  const result = accrueFunding(
    {side: 'long', entry: 100, fillTime: 0, quantity: 2, fundingPnlUsdt: 0},
    [{t: 100, rate: 0.001}],
    () => 110,
    200,
  );
  assert.equal(result.position.fundingPnlUsdt, -0.22);
  assert.equal(result.fallbackMarkPriceRows, 1);
});

test('backtest funding ignores funding interval as mark price and uses priceAt fallback', () => {
  const result = accrueFunding(
    {side: 'long', entry: 100, fillTime: 0, quantity: 2, fundingPnlUsdt: 0},
    [{t: 1609488000000, rate: 0.0001, fundingIntervalHours: 8, markPrice: null}],
    () => 50_000,
    1609488000000 + 1,
  );
  assert.equal(result.position.fundingPnlUsdt, -10);
  assert.equal(result.fallbackMarkPriceRows, 1);
  assert.notEqual(result.position.fundingPnlUsdt, -0.0016);
});

test('backtest metrics expose net expectancy CI, costs, funding and breakdowns', () => {
  const trades = [
    {signalTime: 1, fillTime: 1, exitTime: 2, side: 'long', family: 'a', alpha: 'control', btcRouter: 'bull', netR: 2, netPnlUsdt: 20, grossPnlUsdt: 22, fundingPnlUsdt: -1, modeledCostUsdt: 1, notionalUsdt: 100, riskUsdt: 10, exitReason: 'tp'},
    {signalTime: 3, fillTime: 3, exitTime: 4, side: 'short', family: 'b', alpha: 'bear', btcRouter: 'bear', netR: -1, netPnlUsdt: -10, grossPnlUsdt: -8, fundingPnlUsdt: -1, modeledCostUsdt: 1, notionalUsdt: 100, riskUsdt: 10, exitReason: 'sl'},
  ];
  const metrics = calculateMetrics(trades, {signals: 3, initialEquity: 1_000, periodStart: 0, periodEnd: 86_400_000 * 2});
  assert.equal(metrics.trades, 2);
  assert.equal(metrics.expectancyR, 0.5);
  assert.ok(Math.abs(metrics.expectancyR95CI[0] + 2.44) < 0.01);
  assert.ok(Math.abs(metrics.expectancyR95CI[1] - 3.44) < 0.01);
  assert.equal(metrics.fundingPnlUsdt, -2);
  assert.equal(metrics.bySide.long.trades, 1);
  assert.equal(metrics.profitFactor, 2);
});

test('settlement net R includes modeled cost and funding', () => {
  const result = settleOnCompletedBars(
    {side: 'short', entry: 100, stop: 105, target: 90, fillTime: 0, quantity: 2, riskUsdt: 10, fundingPnlUsdt: 0},
    [{t: 0, closeTime: H1, h: 106, l: 89}],
    [{t: 30_000, rate: 0.001, markPrice: 100}],
    {now: H1 + 1, costRate: 0.0015, priceAt: () => 100},
  );
  assert.equal(result.trade.exitReason, 'sl');
  assert.ok(result.trade.netPnlUsdt < 0);
  assert.ok(result.trade.netR < 0);
});

test('backtest drawdown ratio is rendered as a percentage at the report boundary', () => {
  const metrics = calculateMetrics([
    {signalTime: 1, fillTime: 1, exitTime: 2, side: 'long', netR: -1, netPnlUsdt: -137.28690683362402, grossPnlUsdt: -137.28690683362402, fundingPnlUsdt: 0, modeledCostUsdt: 0, notionalUsdt: 100, riskUsdt: 100},
  ], {signals: 1, initialEquity: 10_000, periodStart: 0, periodEnd: 86_400_000});
  assert.ok(Math.abs(metrics.maxDrawdownPct - 0.013728690683362402) < 1e-12);
  assert.ok(Math.abs(drawdownPercent(metrics.maxDrawdownPct) - 1.3728690683362402) < 1e-12);
});

test('backtest reports required and observed Alpha coverage separately', () => {
  assert.deepEqual(REQUIRED_ALPHA_COVERAGE, [
    'daily_breakout_long',
    'funding_crowding_short',
    'volume_shock_short',
    'v8_bear_trend_short',
  ]);
  assert.deepEqual(observedAlphaCoverage({
    signalEvents: [{alpha: 'daily_breakout_long'}, {alpha: 'v8_bear_trend_short'}],
    trades: [{alpha: 'daily_breakout_long'}],
  }), ['daily_breakout_long', 'v8_bear_trend_short']);
});
