import test from 'node:test';
import assert from 'node:assert/strict';
import {H1, H4} from '../src/config.mjs';
import {makeScanTimes, resolveExecution} from '../scripts/backtest.mjs';

test('backtest scans every production 4h window and captures 4h short signals', () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  const scanTimes = makeScanTimes(start, start + 4 * H4, 4);
  assert.deepEqual(scanTimes.map(time => new Date(time).getUTCHours()), [0, 4, 8, 12]);

  const shortSignals = [0, 4, 8, 12].map(hour => ({t: start + hour * H1, side: 'short'}));
  const captured = shortSignals.filter(candidate => scanTimes.includes(candidate.t));
  assert.equal(captured.length, 4);
  assert.equal(scanTimes.includes(start + 2 * H1), false, 'non-window signal must not be silently treated as a scan');
});

test('backtest models 20-minute decision latency and requires 1m data for formal fills', () => {
  const signalTime = Date.parse('2026-01-01T04:00:00Z');
  const oneMinute = resolveExecution({
    m1: [{t: signalTime + 20 * 60_000, o: 101}],
    h1: [{t: signalTime + H1, o: 102}],
  }, {t: signalTime}, false);
  assert.equal(oneMinute.decisionTime, signalTime + 20 * 60_000);
  assert.equal(oneMinute.fillTime, signalTime + 20 * 60_000);
  assert.equal(oneMinute.interval, '1m');
  assert.equal(oneMinute.executionProxy, false);
  assert.ok(oneMinute.fillTime >= oneMinute.decisionTime);

  const unavailable = resolveExecution({m1: [], h1: [{t: signalTime + H1, o: 102}]}, {t: signalTime}, false);
  assert.equal(unavailable.accepted, false);
  assert.equal(unavailable.reason, 'execution-data-unavailable');

  const proxy = resolveExecution({m1: [], h1: [{t: signalTime + H1, o: 102}]}, {t: signalTime}, true);
  assert.equal(proxy.interval, '1h');
  assert.equal(proxy.executionProxy, true);
  assert.ok(proxy.fillTime >= proxy.decisionTime);

  const bounded = resolveExecution({m1: [{t: signalTime + 20 * 60_000, o: 101}], h1: []}, {t: signalTime}, false, signalTime + 10 * 60_000);
  assert.equal(bounded.accepted, false, 'fills after the sample end must not enter the report');
});
