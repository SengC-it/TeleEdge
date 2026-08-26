# V8.1 Development Research Replay

Status: **RESEARCH_FAIL**. Research-only paper simulation; no Holdout was run.

## Boundary and execution

- Development: 2025-01-01T00:00:00.000Z through 2026-01-01T00:00:00.000Z (end exclusive)
- Scan cadence: 4h; decision latency: 20 minutes
- Fill and settlement: first executable 1m bar at/after decision time, completed 1m first-touch, same-minute TP+SL => SL
- Execution proxy: false; fees/funding/cost modeled: true
- Holdout: **NOT RUN** (2026-01-01T00:00:00.000Z through 2026-07-15T00:00:00.000Z)

## Development universe

- Requested: 388; selected/processed: 150/150
- Selection: stratified-fallback; 37 core / 113 expanded
- Formal universe gate: PASS (minimum 150)
- M4 remains: **M4-INCOMPLETE**

## Monthly research counts

| Month | Raw | Independent | Standalone executable | Qualified candidate | Qualified executable | High candidate | High executable | Long | Short |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2025-01 | 2328 | 1234 | 842 | 0 | 0 | 0 | 0 | 526 | 708 |
| 2025-02 | 2029 | 1046 | 635 | 0 | 0 | 0 | 0 | 440 | 606 |
| 2025-03 | 2373 | 1208 | 843 | 0 | 0 | 0 | 0 | 575 | 633 |
| 2025-04 | 2645 | 1256 | 874 | 0 | 0 | 0 | 0 | 652 | 604 |
| 2025-05 | 2797 | 1373 | 966 | 24 | 12 | 0 | 0 | 764 | 609 |
| 2025-06 | 3066 | 1692 | 1299 | 70 | 46 | 0 | 0 | 703 | 989 |
| 2025-07 | 3649 | 1705 | 1249 | 8 | 1 | 0 | 0 | 1028 | 677 |
| 2025-08 | 3602 | 1763 | 1346 | 12 | 1 | 0 | 0 | 978 | 785 |
| 2025-09 | 3938 | 2002 | 1431 | 9 | 0 | 0 | 0 | 1016 | 986 |
| 2025-10 | 4439 | 2219 | 1469 | 9 | 1 | 0 | 0 | 999 | 1220 |
| 2025-11 | 4374 | 2126 | 1414 | 15 | 3 | 0 | 0 | 896 | 1230 |
| 2025-12 | 3958 | 2113 | 1515 | 8 | 3 | 0 | 0 | 916 | 1197 |

The monthly standaloneExecutable and separately named OOF candidate/executable columns are the formal research denominators; the legacy qualified/high-confidence columns remain available as ex-ante opportunity counts.

## Frozen baseline comparison

| Model | Ranked | Accepted | Trades | Net PnL | Exp R | PF | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|
| v75 | 22 | 17 | 17 | -234.25 | -0.234 | 0.678 | 3.76% |
| v8 | 23 | 18 | 18 | -185.26 | -0.174 | 0.745 | 3.76% |
| v81Incremental | 0 | 0 | 0 | 0.00 | n/a | n/a | 0.00% |
| v81 | 23 | 18 | 18 | -185.26 | -0.174 | 0.745 | 3.76% |

V8.1 combined = frozen V8 Shadow ranked signals plus only Development Alpha rows whose attribution status is KEEP. WATCH/REJECT rows are excluded from the incremental sleeve. The all-new research sleeve is audited separately below.

## V8.1 combined metrics

- Trades: 18; win rate: 33.33%; PF: 0.745; expectancy: -0.174R
- Net PnL: -185.26 USDT (-1.85%); max DD: 379.55 USDT / 3.76%
- Unique symbols: 15; ranked signal increase vs V8: 0.00%

## Standalone Alpha Outcomes (tier-independent)

| Alpha | Observations | Executable outcomes | Symbols | Trades | Net PnL | Exp R | PF |
|---|---:|---:|---:|---:|---:|---:|---:|
| trend_pullback_continuation | 3036 | 2445 | 119 | 2408 | 2108.25 | 0.015 | 1.022 |
| volatility_expansion | 4272 | 2220 | 115 | 2117 | 7903.28 | 0.062 | 1.096 |
| failed_breakout_reversal | 5197 | 4203 | 119 | 4182 | -2876.77 | -0.011 | 0.983 |
| mean_reversion_extreme | 15 | 7 | 6 | 7 | 338.89 | 0.807 | 3.741 |
| funding_price_divergence | 2149 | 1566 | 119 | 1542 | -2148.13 | -0.023 | 0.965 |
| relative_strength_btc_rotation | 5068 | 3442 | 118 | 3369 | 5086.66 | 0.025 | 1.039 |

## Purged walk-forward OOF Alpha decisions

| Alpha | All n / PF / Exp R | Qualified n / PF / Exp R | High n / PF / Exp R | Δ Exp R | Δ PF | Decision |
|---|---:|---:|---:|---:|---:|
| trend_pullback_continuation | 1850 / 1.038 / 0.025 | 1 / 0.000 / -1.024 | 0 / n/a / n/a | -1.050 | -1.038 | WATCH |
| volatility_expansion | 1632 / 1.056 / 0.037 | 59 / 0.934 / -0.045 | 0 / n/a / n/a | -0.082 | -0.122 | REJECT |
| failed_breakout_reversal | 3128 / 0.981 / -0.012 | 1 / 0.000 / -1.028 | 0 / n/a / n/a | -1.016 | -0.981 | WATCH |
| mean_reversion_extreme | 5 / 2.225 / 0.505 | 0 / n/a / n/a | 0 / n/a / n/a | n/a | n/a | WATCH |
| funding_price_divergence | 1187 / 0.971 / -0.019 | 1 / 0.000 / -0.923 | 0 / n/a / n/a | -0.903 | -0.971 | WATCH |
| relative_strength_btc_rotation | 2629 / 1.031 / 0.020 | 3 / 0.900 / -0.066 | 0 / n/a / n/a | -0.086 | -0.131 | WATCH |

- Folds: 4; purge/embargo: 72h
- Time ordered: true; purge enforced: true; label overlap free: true; frozen validation: true; complete OOF coverage: true

### Fold label lifecycle accounting

| Fold | Requested train observations | Train observations | Train executable labels | Excluded label overlap | Purged signals | Label overlap free |
|---|---:|---:|---:|---:|---:|---|
| fold-1 | 4744 | 4601 | 3005 | 76 | 143 | true |
| fold-2 | 7809 | 7626 | 5134 | 173 | 183 | true |
| fold-3 | 11277 | 11136 | 7783 | 161 | 141 | true |
| fold-4 | 15498 | 15228 | 10647 | 126 | 270 | true |

### Per-alpha OOF layer details

**trend_pullback_continuation**
- All OOF executable: sample=1850; symbols=119; wins/losses=652/1198; winRate=35.24%; PF=1.038; Exp=0.025R; 95% CI=[-0.040, 0.091]; net PnL=2822.32 USDT; max DD=69.52%; long=671; short=1179; regimes=bear,bull
- Qualified OOF executable: sample=1; symbols=1; wins/losses=0/1; winRate=0.00%; PF=0.000; Exp=-1.024R; 95% CI=n/a; net PnL=-61.44 USDT; max DD=0.61%; long=0; short=1; regimes=bear
- High-confidence OOF executable: sample=0; symbols=0; wins/losses=0/0; winRate=n/a; PF=n/a; Exp=n/aR; 95% CI=n/a; net PnL=0.00 USDT; max DD=0.00%; long=0; short=0; regimes=none

**volatility_expansion**
- All OOF executable: sample=1632; symbols=114; wins/losses=578/1054; winRate=35.42%; PF=1.056; Exp=0.037R; 95% CI=[-0.033, 0.106]; net PnL=3611.59 USDT; max DD=63.00%; long=895; short=737; regimes=bear,bull,sideways
- Qualified OOF executable: sample=59; symbols=34; wins/losses=19/40; winRate=32.20%; PF=0.934; Exp=-0.045R; 95% CI=[-0.406, 0.316]; net PnL=-159.77 USDT; max DD=9.78%; long=0; short=59; regimes=bear,sideways
- High-confidence OOF executable: sample=0; symbols=0; wins/losses=0/0; winRate=n/a; PF=n/a; Exp=n/aR; 95% CI=n/a; net PnL=0.00 USDT; max DD=0.00%; long=0; short=0; regimes=none

**failed_breakout_reversal**
- All OOF executable: sample=3128; symbols=119; wins/losses=1147/1981; winRate=36.67%; PF=0.981; Exp=-0.012R; 95% CI=[-0.060, 0.035]; net PnL=-2316.16 USDT; max DD=65.15%; long=1750; short=1378; regimes=bear,bull,sideways
- Qualified OOF executable: sample=1; symbols=1; wins/losses=0/1; winRate=0.00%; PF=0.000; Exp=-1.028R; 95% CI=n/a; net PnL=-61.69 USDT; max DD=0.62%; long=0; short=1; regimes=sideways
- High-confidence OOF executable: sample=0; symbols=0; wins/losses=0/0; winRate=n/a; PF=n/a; Exp=n/aR; 95% CI=n/a; net PnL=0.00 USDT; max DD=0.00%; long=0; short=0; regimes=none

**mean_reversion_extreme**
- All OOF executable: sample=5; symbols=5; wins/losses=3/2; winRate=60.00%; PF=2.225; Exp=0.505R; 95% CI=[-0.724, 1.733]; net PnL=151.41 USDT; max DD=0.62%; long=0; short=5; regimes=sideways
- Qualified OOF executable: sample=0; symbols=0; wins/losses=0/0; winRate=n/a; PF=n/a; Exp=n/aR; 95% CI=n/a; net PnL=0.00 USDT; max DD=0.00%; long=0; short=0; regimes=none
- High-confidence OOF executable: sample=0; symbols=0; wins/losses=0/0; winRate=n/a; PF=n/a; Exp=n/aR; 95% CI=n/a; net PnL=0.00 USDT; max DD=0.00%; long=0; short=0; regimes=none

**funding_price_divergence**
- All OOF executable: sample=1187; symbols=119; wins/losses=424/763; winRate=35.72%; PF=0.971; Exp=-0.019R; 95% CI=[-0.096, 0.057]; net PnL=-1373.94 USDT; max DD=39.26%; long=821; short=366; regimes=bear,bull,sideways
- Qualified OOF executable: sample=1; symbols=1; wins/losses=0/1; winRate=0.00%; PF=0.000; Exp=-0.923R; 95% CI=n/a; net PnL=-55.37 USDT; max DD=0.55%; long=1; short=0; regimes=bull
- High-confidence OOF executable: sample=0; symbols=0; wins/losses=0/0; winRate=n/a; PF=n/a; Exp=n/aR; 95% CI=n/a; net PnL=0.00 USDT; max DD=0.00%; long=0; short=0; regimes=none

**relative_strength_btc_rotation**
- All OOF executable: sample=2629; symbols=118; wins/losses=982/1647; winRate=37.35%; PF=1.031; Exp=0.020R; 95% CI=[-0.032, 0.072]; net PnL=3151.74 USDT; max DD=90.72%; long=1110; short=1519; regimes=bear,bull,sideways
- Qualified OOF executable: sample=3; symbols=3; wins/losses=1/2; winRate=33.33%; PF=0.900; Exp=-0.066R; 95% CI=[-1.887, 1.755]; net PnL=-11.95 USDT; max DD=1.18%; long=0; short=3; regimes=bear
- High-confidence OOF executable: sample=0; symbols=0; wins/losses=0/0; winRate=n/a; PF=n/a; Exp=n/aR; 95% CI=n/a; net PnL=0.00 USDT; max DD=0.00%; long=0; short=0; regimes=none

## Gate

- Decision: **RESEARCH_FAIL**
- Standalone executable outcomes: 13883; OOF qualified candidates: 155; OOF qualified executable: 67; OOF high-confidence candidates: 0; OOF high-confidence executable: 0
- Positive standalone families with sufficient sample: 3; OOF KEEP families: 0
- Tier monotonicity: INSUFFICIENT (valid=false; sufficient=false)
- Tier comparison: A=High Confidence, B=Qualified-B, C=Research-C
- Current V8.1 alpha set exhausted: true
- Provenance: strategy tree 6e1a44992886f141ad6fdf09c3a387036f7df7303b52bfba8c132344534b60e0; frozen config 191ef4e21f0b00f3257868985173da1f5fc16729383b5db5c0fb3aab5c56ec1c

## Limitations

- M4 strict formal dataset remains incomplete; this Development replay does not upgrade M4 or remove survivorship/lifecycle/data continuity limitations.
- The selected universe is the deterministic 150-symbol fallback from the 388-symbol eligible input; the full 388-symbol Development replay was not run in this artifact.
- V7.5 and V8 baseline event sets are generated by the frozen backtest and re-evaluated through the shared local acceptance/fill contract for comparability.
- Standalone Alpha outcomes are tier-independent; only OOF KEEP rows are included in the V8.1 combined result. WATCH and REJECT are excluded.
- Purged walk-forward calibration uses only preregistered feature buckets and freezes each fold model before validation; no random split, ML, or grid search was used.
- No parameter optimization, strategy threshold change, Holdout, Production deployment, or real order path was run.
