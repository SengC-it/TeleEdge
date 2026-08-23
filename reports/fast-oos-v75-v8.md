# M5 Fast OOS: V7.5 vs V8

## Decision: **NO-GO**

Validation gate: **SHADOW/INCONCLUSIVE**

- V7.5 OOS trades=0 (<100)
- V8 OOS trades=7 (<100)
- V7.5 Control has no executable OOS trades in this fast subset
- V8 95% expectancy interval includes zero
- unique traded symbols unavailable from frozen engine output
- CVaR95 unavailable from frozen engine output
- required Alpha not observed: funding_crowding_short, volume_shock_short
- V8 OOS signals did not increase (26 -> 16)
- M4 strict data gate remains incomplete

Production deployment was not performed. M4 remains INCOMPLETE.

## Reproducibility

- Strategy commit: `003b931fe1ad576a3d42858f18c5fb9a19d58ae9`
- Repository HEAD at run: `53ecd5dfa1a420d0ec44eacc59d1c6d7785c7f8e`
- Working tree dirty at run: **true**
- Config SHA256: `fdc4433881eafbc383795df9602b667d1f9b8033ef0d8f3c96e0d6814eb96dd8`
- Dataset snapshot: 2026-08-01T00:00:00.000Z
- Manifest SHA256: `79d4f0623b6a9cbdbbf756c3a71a2c3ab224d6d26457d5e5101e72bdd4342a3a`
- Backtest generated: 2026-08-23T02:26:48.238Z

## Universe and execution

- Clean eligible universe: **388** (37 core / 351 expanded)
- Executed subset: **50** (25 core / 25 expanded)
- OOS window: 2025-01-01T00:00:00.000Z → 2026-07-15T00:00:00.000Z
- Cadence: **4h**; decision latency: **20m**
- Fill/settlement: **1m 1m**, proxy **false**, same-minute TP+SL => SL
- Samples: 437385 1h rows; 26241970 1m rows; 93091 funding events

## V7.5 Control OOS

| Metric | Value |
|---|---:|
| Signals | 26 |
| Accepted signals (run total) | 0 |
| Trades | 0 |
| Wins / losses | 0 / 0 |
| Win rate | n/a |
| Net expectancy (R) | n/a |
| 95% CI | n/a |
| Profit factor | n/a |
| Max drawdown | 0.0000% / 0.0000 USDT |
| Net PnL | 0.0000 USDT |
| Fees/costs | 0.0000 USDT |
| Funding PnL | 0.0000 USDT |
| Avg holding | n/a h |

Observed Alpha: daily_breakout_long

## V8 Shadow OOS

| Metric | Value |
|---|---:|
| Signals | 16 |
| Accepted signals (run total) | 21 |
| Trades | 7 |
| Wins / losses | 4 / 3 |
| Win rate | 0.5714 |
| Net expectancy (R) | 0.6370 |
| 95% CI | -0.5581 … 1.8321 |
| Profit factor | 2.3693 |
| Max drawdown | 0.0137% / 137.2869 USDT |
| Net PnL | 201.5741 USDT |
| Fees/costs | 6.0514 USDT |
| Funding PnL | -14.6632 USDT |
| Avg holding | 664.0643 h |

Observed Alpha: v8_bear_trend_short, v8_daily_breakout_long

## Comparison

- OOS signals: 26 → 16 (-38.4615%)
- OOS trades: 0 → 7
- Net expectancy delta (V8−V7.5): 0.6370 R
- Profit factor delta (V8−V7.5): 2.3693

## Breakdowns and limitations

- OOS by-side/regime/family/Alpha/year breakdowns are copied from the frozen engine output in the JSON report.
- Month-level, unique-symbol, concentration/top-5, and CVaR95 fields are `null`: the frozen engine report does not expose trade-level records, so these are not reconstructed.
- Required Alpha coverage: daily_breakout_long, funding_crowding_short, volume_shock_short, v8_bear_trend_short
- Observed Alpha coverage: daily_breakout_long, v8_bear_trend_short, v8_daily_breakout_long
- Missing required coverage: funding_crowding_short, volume_shock_short

## M4 status

- strict complete: **false**; point-in-time: **false**; historical delistings resolved: **false**
- strict verifier exit: **1**
- failure inventory: continuity 120; coverage 698; funding windows 416; price boundary 162; 1m boundary 195
- M4 is deliberately not upgraded by this fast validation.

## Release readiness

- Production: **NO-GO**
- Shadow: **NO-GO: insufficient evidence**
- No deployment or real Binance order path was exercised.
- signal pipeline: **PASS** — frozen engine and worker candidate tests pass
- V7.5/V8 state isolation: **PASS** — state-isolation regression test passes
- history/reviews/email/dashboard contracts: **PASS** — existing history, reviews-token, funnel/public-status tests pass
- real Binance order path: **PASS** — static audit found market-data endpoints only; no order endpoint exercised
- production release gate: **BLOCKED** — M5 validation is SHADOW/INCONCLUSIVE and M4 remains incomplete
- Next gate: obtain a larger, full required-Alpha, trade-level-exposing OOS result before any release decision.
