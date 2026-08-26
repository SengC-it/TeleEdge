# V8.1 Development Research Replay

Status: **RESEARCH_FAIL**. This is a paper/simulation research artifact only.

## Boundary and execution

- Development: 2025-01-01T00:00:00.000Z through 2026-01-01T00:00:00.000Z (end exclusive)
- Scan cadence: 4h
- Decision latency: 20 minutes
- Fill/settlement: completed 1m data, first executable minute, same-minute TP+SL => SL
- Execution proxy: false
- Holdout: **NOT RUN** (2026-01-01T00:00:00.000Z through 2026-07-15T00:00:00.000Z)

## Universe

- Source: reports/fast-oos-universe.json
- Mode: stratified-fallback
- Symbols: 50 (20 core / 30 expanded)
- Processed partitions: 50

## Counts

- Research observations: 13551 (1129.250 / month mean; 1075.500 median)
- Qualified alerts: 10988 (915.667 / month mean; 875.000 median)
- High confidence: 2596 (216.333 / month mean)

## Monthly frequency

| Month | Research | Qualified | High confidence | Unique alerts | Long | Short |
|---|---:|---:|---:|---:|---:|---:|
| 2025-01 | 883 | 691 | 174 | 691 | 327 | 556 |
| 2025-02 | 694 | 585 | 142 | 585 | 224 | 470 |
| 2025-03 | 808 | 661 | 165 | 661 | 329 | 479 |
| 2025-04 | 846 | 678 | 167 | 678 | 415 | 431 |
| 2025-05 | 878 | 725 | 177 | 725 | 530 | 348 |
| 2025-06 | 1012 | 809 | 167 | 809 | 398 | 614 |
| 2025-07 | 1139 | 941 | 219 | 941 | 765 | 374 |
| 2025-08 | 1193 | 980 | 174 | 980 | 656 | 537 |
| 2025-09 | 1379 | 1097 | 303 | 1097 | 794 | 585 |
| 2025-10 | 1628 | 1324 | 320 | 1324 | 706 | 922 |
| 2025-11 | 1636 | 1338 | 318 | 1338 | 581 | 1055 |
| 2025-12 | 1455 | 1159 | 270 | 1159 | 610 | 845 |

## Portfolio metrics

| Metric | Value |
|---|---:|
| Trades | 870 |
| Win rate | 33.79% |
| Profit factor | 0.900 |
| Expectancy (R) | -0.067 |
| Net PnL (USDT) | -3201.93 |
| Net return | -32.02% |
| Max drawdown (USDT) | 5040.74 |
| Max drawdown | 50.41% |
| Unique symbols | 42 |

## Alpha attribution

| Alpha | Observations | Qualified | Trades | Expectancy R | PF | Status |
|---|---:|---:|---:|---:|---:|---|
| trend_pullback_continuation | 3512 | 3109 | 188 | -0.162 | 0.777 | REJECT |
| volatility_expansion | 2429 | 2421 | 96 | -0.124 | 0.820 | REJECT |
| failed_breakout_reversal | 2885 | 2218 | 221 | -0.064 | 0.904 | REJECT |
| mean_reversion_extreme | 5 | 4 | 1 | -1.020 | 0.000 | WATCH |
| funding_price_divergence | 861 | 688 | 48 | 0.208 | 1.368 | KEEP |
| relative_strength_btc_rotation | 3859 | 3615 | 316 | -0.035 | 0.947 | REJECT |

## Gate and limitations

- Development gate: **RESEARCH_FAIL**
- Positive alpha families with sufficient sample: 1
- Source code SHA: 6873171499057c5696f6bdb67dea0a72f1a54a9e
- Frozen config SHA256: 0f9d9b9674ae8214622c48250311c2815aeb60cbf27a73ba6d4c4cb10bd53d5b
- Baseline V7.5/V8 semantics remain frozen; this phase does not rewrite or deploy them.
- Survivorship, lifecycle, and strict artifact limitations are inherited from the verified clean-eligible input manifest; this report does not upgrade M4 to complete.
- Results are not a profitability conclusion and must not be used as Holdout evidence.
