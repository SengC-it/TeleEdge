import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateResearchRisk} from '../src/risk.mjs';

const candidate = overrides => ({
  side: 'long',
  btcRouter: 'bull',
  edgeScore: 0.7,
  stopPct: 0.05,
  dayVolume: 100_000_000,
  ...overrides,
});

test('research allocator scales risk with edge/liquidity/volatility inputs', () => {
  const strong = allocateResearchRisk({equityUsdt: 10_000, candidate: candidate({edgeScore: 0.9, stopPct: 0.03, dayVolume: 200_000_000})});
  const weak = allocateResearchRisk({equityUsdt: 10_000, candidate: candidate({edgeScore: 0.1, stopPct: 0.12, dayVolume: 20_000_000})});
  assert.equal(strong.accepted, true);
  assert.equal(weak.accepted, true);
  assert.ok(strong.riskUsdt > weak.riskUsdt);
});

test('research allocator applies correlated risk and drawdown stops', () => {
  const blocked = allocateResearchRisk({
    equityUsdt: 10_000,
    peakEquityUsdt: 10_000,
    candidate: candidate({}),
    openPositions: [{side: 'long', btcRouter: 'bull', riskUsdt: 300}],
  });
  const stopped = allocateResearchRisk({
    equityUsdt: 8_700,
    peakEquityUsdt: 10_000,
    candidate: candidate({}),
  });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, 'correlated-risk-cap');
  assert.equal(stopped.accepted, false);
  assert.equal(stopped.reason, 'drawdown-stop');
});
