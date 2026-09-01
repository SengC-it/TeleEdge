# TeleEdge V9 Multi-Factor Derivatives Research

Status: **RESEARCH_FAIL**. Research-only Development package; no V8.1 Holdout and no Production change.

## Boundary and provenance

- Development: 2024-01-01T00:00:00.000Z → 2026-01-01T00:00:00.000Z (end exclusive)
- Holdout: **NOT RUN** (2026-01-01T00:00:00.000Z → 2026-07-15T00:00:00.000Z)
- Scan: 4h; decision latency: 20m; fill/settlement: 1m / 1m; proxy=false
- Universe: 150 selected (37 core / 113 expanded), hash ec12cd57cca7022ed6c8f2c26a10ff34424a8513fbd6be091bdb359c06dc9b43
- M4: **M4-INCOMPLETE**
- No-order audit: true
- Strategy tree SHA256: 6e1a44992886f141ad6fdf09c3a387036f7df7303b52bfba8c132344534b60e0; V9 code SHA256: 8aaeb255cc47d54c714352288170735039f1dc7436422def0c0d54edf7e6d08b; data manifest SHA256: 7233391a3f30a931ebd9849239ac428b6bc6fdb6b34e8d2c8b0c250e0adaee43

## Data availability

- taker-buy volume / enhanced 1h klines: available — required by FLOW and cross-sectional families
- premiumIndex / mark / index 1h archives: available — required only by PREMIUM_DISLOCATION
- historical open interest: available — 128/150 symbols have at least 1 fresh PIT metric observations; each signal checks local continuity
- global/top/taker long-short ratios: available — 128/150 symbols enter the local PIT metrics pipeline; stale and gapped lookbacks fail closed per signal
- funding / 1m execution / first-touch: available — reused local normalized M4 artifacts; inherited M4 limitations remain

## PIT metrics integrity

- Symbols with rows: 128; valid-archive symbols: 128; symbols with any gap: 106; zero-gap symbols: 22; PIT-usable symbols: 128.
- Total rows: 13321268; expected rows: 13325696; missing timestamps: 4487; duplicate timestamps: 0.
- Source-order irregularities: 1387; largest gap: 37800000ms; coverage: 99.966328%.
- Signal rejection counts: current stale 64; 1h gap 32; 4h gap 32; 12h gap 319; rolling-history gap 32.

## Monthly counts

| Month | Raw | Independent | Standalone executable | OOF candidate | OOF executable | Long | Short |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2024-01 | 7629 | 1308 | 936 | 0 | 0 | 573 | 735 |
| 2024-02 | 8498 | 1499 | 1139 | 0 | 0 | 662 | 837 |
| 2024-03 | 9209 | 1555 | 1120 | 0 | 0 | 706 | 849 |
| 2024-04 | 9348 | 1542 | 1147 | 0 | 0 | 684 | 858 |
| 2024-05 | 10172 | 1751 | 1449 | 0 | 0 | 783 | 968 |
| 2024-06 | 9861 | 1737 | 1360 | 0 | 0 | 760 | 977 |
| 2024-07 | 10289 | 1767 | 1395 | 182 | 137 | 793 | 974 |
| 2024-08 | 10527 | 1849 | 1467 | 221 | 179 | 824 | 1025 |
| 2024-09 | 10672 | 1913 | 1604 | 199 | 177 | 867 | 1046 |
| 2024-10 | 12086 | 2163 | 1720 | 231 | 168 | 938 | 1225 |
| 2024-11 | 12250 | 2102 | 1563 | 199 | 137 | 938 | 1164 |
| 2024-12 | 14597 | 2549 | 1818 | 238 | 135 | 1081 | 1468 |
| 2025-01 | 16071 | 2885 | 2132 | 429 | 312 | 1234 | 1651 |
| 2025-02 | 15344 | 2774 | 1872 | 466 | 333 | 1255 | 1519 |
| 2025-03 | 18202 | 3194 | 2385 | 551 | 399 | 1444 | 1750 |
| 2025-04 | 18196 | 3296 | 2544 | 521 | 396 | 1503 | 1793 |
| 2025-05 | 21827 | 3933 | 2913 | 481 | 332 | 1746 | 2187 |
| 2025-06 | 24761 | 4539 | 3729 | 799 | 639 | 2077 | 2462 |
| 2025-07 | 28333 | 5085 | 3974 | 623 | 491 | 2311 | 2774 |
| 2025-08 | 30472 | 5481 | 4391 | 919 | 760 | 2421 | 3060 |
| 2025-09 | 32892 | 5853 | 4328 | 1059 | 821 | 2564 | 3289 |
| 2025-10 | 33671 | 6036 | 4356 | 974 | 708 | 2677 | 3359 |
| 2025-11 | 33102 | 6009 | 4438 | 1289 | 893 | 2654 | 3355 |
| 2025-12 | 37420 | 6788 | 5330 | 1602 | 1252 | 2993 | 3795 |

## Alpha standalone

| Alpha | Observations | Executable | Symbols | Trades | Net PnL | Exp R | PF |
|---|---:|---:|---:|---:|---:|---:|---:|
| FLOW_MOMENTUM | 9428 | 7657 | 124 | 7526 | 17816.2047 | 0.039551 | 1.059286 |
| FLOW_REVERSAL | 10687 | 8515 | 123 | 8396 | 10612.8221 | 0.021137 | 1.031337 |
| OI_TREND_CONFIRMATION | 27904 | 22851 | 126 | 22602 | -24805.1598 | -0.018307 | 0.973406 |
| CROWDED_UNWIND | 136 | 114 | 60 | 113 | -712.6188 | -0.104725 | 0.852616 |
| PREMIUM_DISLOCATION | 18115 | 12235 | 126 | 12118 | -23142.2232 | -0.03176 | 0.953963 |
| CROSS_SECTIONAL_FLOW_STRENGTH | 11338 | 7738 | 124 | 7640 | -3408.0993 | -0.007839 | 0.989108 |

## Purged OOF

| Alpha | Status | Qualified executable | Exp R | PF |
|---|---|---:|---:|---:|
| FLOW_MOMENTUM | WATCH | 2492 | 0.03442358355707048 | 1.0517843766909911 |
| FLOW_REVERSAL | WATCH | 2609 | 0.01950283066897255 | 1.0291325217787815 |
| OI_TREND_CONFIRMATION | WATCH | 1165 | 0.08340138806357313 | 1.1289055676621773 |
| CROWDED_UNWIND | WATCH | 24 | -0.2856078668877285 | 0.6314296956183533 |
| PREMIUM_DISLOCATION | WATCH | 603 | 0.04358539075003002 | 1.0662491767809188 |
| CROSS_SECTIONAL_FLOW_STRENGTH | WATCH | 1155 | 0.02831272242026142 | 1.042483688869423 |

Folds: 6; purge: 72h; checks: {"timeOrdered":true,"purgeEnforced":true,"labelOverlapFree":true,"validationFrozen":true,"completeValidationCoverage":true}.

## Model comparison

| Model | Ranked | Accepted | Trades | Net PnL | Exp R | PF | DD |
|---|---:|---:|---:|---:|---:|---:|---:|
| V7.5 Control | 69 | 40 | 40 | 146.1859386497888 | 0.06274916712484041 | 1.1013395817758025 | 0.02425431757674978 |
| V8 Shadow | 74 | 46 | 46 | 135.99321825420805 | 0.08100761366015327 | 1.133756691937492 | 0.0237432950472421 |
| V9 | 0 | 0 | 0 | 0 | — | — | 0 |
| V8+V9 | 74 | 46 | 46 | 135.9932 | 0.081008 | 1.133757 | 0.023743 |
| V9 standalone (non-portfolio) | 77608 | 59110 | 58395 | -23639.0741 | -0.006768 | 0.990119 | 3.7735 |

## Gate

Decision: **RESEARCH_FAIL**

| Check | Result |
|---|---|
| independentKeepAtLeast2 | FAIL |
| usableMetricsSymbolsAtLeast100 | PASS |
| oofQualifiedExecutableAtLeast100 | PASS |
| qualifiedExecutableFrequencyAtLeast8PerMonth | PASS |
| candidatePortfolioTradesAtLeast60 | FAIL |
| candidatePortfolioSymbolsAtLeast30 | FAIL |
| candidatePortfolioProfitFactorAtLeast150 | FAIL |
| candidatePortfolioExpectancyAtLeast020 | FAIL |
| candidatePortfolioNetPnlPositive | FAIL |
| candidatePortfolioReturnPreferred5Pct | FAIL |
| drawdownAtMost6Pct | PASS |
| positiveMonthsAtLeast60Pct | FAIL |
| concentrationAtMost25Pct | FAIL |
| tierMonotonicity | PASS |
| v9CandidateBeatsFrozenV8 | FAIL |
| purgeChecks | PASS |
| executionProxyDisabled | PASS |
| noOrderAudit | PASS |

The selection rule is preregistered: a V9 alpha may enter the future Holdout candidate set only when its purged OOF qualified executable attribution is KEEP; if the Development Gate fails, no Holdout candidate is selected. No ad-hoc best-profit selection is permitted.

## Limitations

- M4 remains incomplete: inherited universe/lifecycle manifest is not point-in-time and historical delisting/survivorship resolution is not complete.
- Development uses 150 deterministic V8.1 symbols; it does not run the 388-symbol universe.
- 128 of 150 selected symbols have overlapping enhanced Development data; this exceeds the 100-symbol minimum but is below the preferred 150.
- 128 of 150 selected symbols have at least 1 fresh local PIT metrics observations; 106 symbols contain continuity gaps, which are handled per signal rather than disabling the whole symbol.
- The 2026-01-01 through 2026-07-15 Holdout was not run. No profitability or production-readiness conclusion is made.
- V7.5/V8 baselines are frozen same-window paper backtest references; V9 is research-only and does not alter Production.
