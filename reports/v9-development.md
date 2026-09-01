# TeleEdge V9 Multi-Factor Derivatives Research

Status: **RESEARCH_FAIL**. Research-only Development package; no V8.1 Holdout and no Production change.

## Boundary and provenance

- Development: 2024-01-01T00:00:00.000Z → 2026-01-01T00:00:00.000Z (end exclusive)
- Holdout: **NOT RUN** (2026-01-01T00:00:00.000Z → 2026-07-15T00:00:00.000Z)
- Scan: 4h; decision latency: 20m; fill/settlement: 1m / 1m; proxy=false
- Universe: 150 selected (37 core / 113 expanded), hash ec12cd57cca7022ed6c8f2c26a10ff34424a8513fbd6be091bdb359c06dc9b43
- M4: **M4-INCOMPLETE**
- No-order audit: true
- Strategy tree SHA256: 6e1a44992886f141ad6fdf09c3a387036f7df7303b52bfba8c132344534b60e0; V9 code SHA256: 5928ed3d4252e5a8ded34d91504e1181ff64532b5ab33095c265effe192e77b1; data manifest SHA256: 7233391a3f30a931ebd9849239ac428b6bc6fdb6b34e8d2c8b0c250e0adaee43

## Data availability

- taker-buy volume / enhanced 1h klines: available — required by FLOW and cross-sectional families
- premiumIndex / mark / index 1h archives: available — required only by PREMIUM_DISLOCATION
- historical open interest: available — 22/150 symbols have complete official 5m metrics; symbols with gaps fail closed
- global/top/taker long-short ratios: available — 22/150 symbols have complete official 5m metrics; symbols with gaps fail closed
- funding / 1m execution / first-touch: available — reused local normalized M4 artifacts; inherited M4 limitations remain

## Monthly counts

| Month | Raw | Independent | Standalone executable | OOF candidate | OOF executable | Long | Short |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2024-01 | 2743 | 752 | 475 | 0 | 0 | 309 | 443 |
| 2024-02 | 3240 | 923 | 655 | 0 | 0 | 368 | 555 |
| 2024-03 | 3255 | 925 | 629 | 0 | 0 | 390 | 535 |
| 2024-04 | 3227 | 892 | 613 | 0 | 0 | 372 | 520 |
| 2024-05 | 3662 | 1057 | 833 | 0 | 0 | 428 | 629 |
| 2024-06 | 3632 | 1057 | 774 | 0 | 0 | 433 | 624 |
| 2024-07 | 3692 | 1082 | 796 | 80 | 57 | 455 | 627 |
| 2024-08 | 3772 | 1138 | 856 | 103 | 85 | 477 | 661 |
| 2024-09 | 4007 | 1213 | 964 | 88 | 80 | 507 | 706 |
| 2024-10 | 4774 | 1386 | 1036 | 86 | 64 | 554 | 832 |
| 2024-11 | 4474 | 1282 | 903 | 69 | 58 | 520 | 762 |
| 2024-12 | 5325 | 1558 | 1067 | 75 | 56 | 595 | 963 |
| 2025-01 | 5882 | 1820 | 1273 | 168 | 122 | 711 | 1109 |
| 2025-02 | 5295 | 1694 | 1136 | 231 | 180 | 722 | 972 |
| 2025-03 | 6846 | 2021 | 1439 | 297 | 208 | 877 | 1144 |
| 2025-04 | 6960 | 2103 | 1558 | 259 | 183 | 915 | 1188 |
| 2025-05 | 8406 | 2518 | 1753 | 229 | 158 | 1038 | 1480 |
| 2025-06 | 10295 | 2996 | 2357 | 365 | 272 | 1320 | 1676 |
| 2025-07 | 11999 | 3332 | 2513 | 286 | 232 | 1433 | 1899 |
| 2025-08 | 13088 | 3656 | 2806 | 441 | 375 | 1509 | 2147 |
| 2025-09 | 15004 | 3954 | 2795 | 533 | 418 | 1602 | 2352 |
| 2025-10 | 15318 | 4087 | 2825 | 454 | 336 | 1708 | 2379 |
| 2025-11 | 15591 | 4128 | 2887 | 682 | 453 | 1723 | 2405 |
| 2025-12 | 19957 | 4915 | 3704 | 947 | 714 | 2078 | 2837 |

## Alpha standalone

| Alpha | Observations | Executable | Symbols | Trades | Net PnL | Exp R | PF |
|---|---:|---:|---:|---:|---:|---:|---:|
| FLOW_MOMENTUM | 9428 | 7657 | 124 | 7526 | 17816.2047 | 0.039551 | 1.059286 |
| FLOW_REVERSAL | 10687 | 8515 | 123 | 8396 | 10612.8221 | 0.021137 | 1.031337 |
| OI_TREND_CONFIRMATION | 917 | 500 | 20 | 477 | 613.1455 | 0.021403 | 1.03214 |
| CROWDED_UNWIND | 4 | 2 | 2 | 2 | -122.3355 | -1.019484 | 0 |
| PREMIUM_DISLOCATION | 18115 | 12235 | 126 | 12118 | -23142.2232 | -0.03176 | 0.953963 |
| CROSS_SECTIONAL_FLOW_STRENGTH | 11338 | 7738 | 124 | 7640 | -3408.0993 | -0.007839 | 0.989108 |

## Purged OOF

| Alpha | Status | Qualified executable | Exp R | PF |
|---|---|---:|---:|---:|
| FLOW_MOMENTUM | WATCH | 1510 | 0.015456618085376456 | 1.0229635798613599 |
| FLOW_REVERSAL | WATCH | 1550 | 0.01967035740815574 | 1.0293034775898013 |
| OI_TREND_CONFIRMATION | WATCH | 25 | -0.06113855976703482 | 0.9117729994199892 |
| CROWDED_UNWIND | WATCH | 1 | -1.01353186646434 | 0 |
| PREMIUM_DISLOCATION | WATCH | 302 | 0.02560933592826065 | 1.0388683348246759 |
| CROSS_SECTIONAL_FLOW_STRENGTH | WATCH | 526 | 0.04693433695152645 | 1.0712622063391775 |

Folds: 6; purge: 72h; checks: {"timeOrdered":true,"purgeEnforced":true,"labelOverlapFree":true,"validationFrozen":true,"completeValidationCoverage":true}.

## Model comparison

| Model | Ranked | Accepted | Trades | Net PnL | Exp R | PF | DD |
|---|---:|---:|---:|---:|---:|---:|---:|
| V7.5 Control | 69 | 40 | 40 | 146.1859386497888 | 0.06274916712484041 | 1.1013395817758025 | 0.02425431757674978 |
| V8 Shadow | 74 | 46 | 46 | 135.99321825420805 | 0.08100761366015327 | 1.133756691937492 | 0.0237432950472421 |
| V9 | 0 | 0 | 0 | 0 | — | — | 0 |
| V8+V9 | 74 | 46 | 46 | 135.9932 | 0.081008 | 1.133757 | 0.023743 |
| V9 standalone (non-portfolio) | 50489 | 36647 | 36159 | 2369.5144 | 0.001066 | 1.001608 | 2.016746 |

## Gate

Decision: **RESEARCH_FAIL**

| Check | Result |
|---|---|
| independentKeepAtLeast2 | FAIL |
| usableMetricsSymbolsAtLeast100 | FAIL |
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
| tierMonotonicity | FAIL |
| v9CandidateBeatsFrozenV8 | FAIL |
| purgeChecks | PASS |
| executionProxyDisabled | PASS |
| noOrderAudit | PASS |

The selection rule is preregistered: a V9 alpha may enter the future Holdout candidate set only when its purged OOF qualified executable attribution is KEEP; if the Development Gate fails, no Holdout candidate is selected. No ad-hoc best-profit selection is permitted.

## Limitations

- M4 remains incomplete: inherited universe/lifecycle manifest is not point-in-time and historical delisting/survivorship resolution is not complete.
- Development uses 150 deterministic V8.1 symbols; it does not run the 388-symbol universe.
- 128 of 150 selected symbols have overlapping enhanced Development data; this exceeds the 100-symbol minimum but is below the preferred 150.
- 22 of 150 selected symbols have complete official 5m metrics continuity for the Development window; 4487 timestamps are missing across the downloaded metrics artifacts and any gapped symbol is fail-closed for OI/crowding features.
- The 2026-01-01 through 2026-07-15 Holdout was not run. No profitability or production-readiness conclusion is made.
- V7.5/V8 baselines are frozen same-window paper backtest references; V9 is research-only and does not alter Production.
