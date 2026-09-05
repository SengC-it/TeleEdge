# M4 PIT Universe Closure

Status: **M4_BLOCKED**

Development window: 2024-01-01T00:00:00.000Z → 2026-01-01T00:00:00.000Z (end exclusive). Snapshot: 2026-08-01T00:00:00.000Z.

This report uses the union of actual Binance Data Vision USD-M archive evidence and the current exchangeInfo cross-check. Current exchangeInfo is never used as the sole historical universe source. Archive first/last observations are diagnostics only and cannot certify an in-window listing or delisting.

## Universe

- Global discovered symbols: 850
- Development archive symbols: 618
- Development-relevant crypto perpetual symbols: 619
- Current symbols: 648
- Historical archive-only symbols: 19
- Excluded TradFi perpetual symbols: 169
- Listed during Development: 375
- Delisted during Development: 74
- PIT window resolved: 653/681
- Unresolved Development lifecycle: 28
- Development-active episodes: 622
- Multi-episode/relisted symbols: 2
- Relist episode classification: 3
- True lifecycle conflicts: 13
- Ambiguous evidence matches: 1
- Hourly boundary straddles accepted: 0
- Archive interval alignments: 608
- M4_PIT_WINDOW_COMPLETE: **false**
- M4_GLOBAL_COMPLETE: **false**
- M4 window data contract ready: **false**
- Legacy manifest data contract diagnostic: **false**

## Monthly PIT universe

| Month | PIT eligible | Core | Expanded |
|---|---:|---:|---:|
| 2024-01 | 242 | 40 | 202 |
| 2024-02 | 250 | 41 | 209 |
| 2024-03 | 258 | 41 | 217 |
| 2024-04 | 262 | 43 | 219 |
| 2024-05 | 263 | 43 | 220 |
| 2024-06 | 261 | 43 | 218 |
| 2024-07 | 259 | 44 | 215 |
| 2024-08 | 274 | 44 | 230 |
| 2024-09 | 292 | 44 | 248 |
| 2024-10 | 301 | 45 | 256 |
| 2024-11 | 320 | 46 | 274 |
| 2024-12 | 346 | 49 | 297 |
| 2025-01 | 359 | 51 | 308 |
| 2025-02 | 365 | 52 | 313 |
| 2025-03 | 385 | 52 | 333 |
| 2025-04 | 403 | 52 | 351 |
| 2025-05 | 420 | 54 | 366 |
| 2025-06 | 438 | 55 | 383 |
| 2025-07 | 458 | 55 | 403 |
| 2025-08 | 475 | 57 | 418 |
| 2025-09 | 504 | 58 | 446 |
| 2025-10 | 525 | 60 | 465 |
| 2025-11 | 535 | 64 | 471 |
| 2025-12 | 537 | 65 | 472 |

## Monthly PIT liquidity eligibility

Fixed rule: completed point-in-time 30-day average quote volume ≥ 20,000,000 USDT. Missing liquidity history is fail-closed and is not inferred from future volume.

| Month | Liquidity-eligible | Core | Expanded | Unknown |
|---|---:|---:|---:|---:|
| 2024-01 | 141 | 35 | 106 | 16 |
| 2024-02 | 157 | 37 | 120 | 17 |
| 2024-03 | 221 | 40 | 181 | 14 |
| 2024-04 | 176 | 38 | 138 | 15 |
| 2024-05 | 150 | 40 | 110 | 13 |
| 2024-06 | 132 | 38 | 94 | 13 |
| 2024-07 | 124 | 39 | 85 | 9 |
| 2024-08 | 123 | 40 | 83 | 23 |
| 2024-09 | 118 | 38 | 80 | 26 |
| 2024-10 | 133 | 39 | 94 | 16 |
| 2024-11 | 201 | 44 | 157 | 29 |
| 2024-12 | 224 | 46 | 178 | 34 |
| 2025-01 | 177 | 46 | 131 | 29 |
| 2025-02 | 174 | 49 | 125 | 17 |
| 2025-03 | 145 | 48 | 97 | 30 |
| 2025-04 | 157 | 48 | 109 | 28 |
| 2025-05 | 179 | 47 | 132 | 29 |
| 2025-06 | 139 | 50 | 89 | 26 |
| 2025-07 | 189 | 51 | 138 | 28 |
| 2025-08 | 170 | 49 | 121 | 26 |
| 2025-09 | 164 | 52 | 112 | 39 |
| 2025-10 | 184 | 54 | 130 | 34 |
| 2025-11 | 160 | 56 | 104 | 21 |
| 2025-12 | 122 | 53 | 69 | 21 |

## Lifecycle blockers

| Symbol | Reason | Conflict class | First archive month | Last archive month |
|---|---|---|---|---|
| AERGOUSDT | listing-after-first-observed, entry-boundary-unresolved | TRUE_LIFECYCLE_CONFLICT, ENTRY_UNRESOLVED | 2024-09 | 2026-06 |
| AIAUSDT | entry-boundary-unresolved | ENTRY_UNRESOLVED, RELIST_EPISODE_DETECTED | 2025-09 | 2026-07 |
| AKROUSDT | delist-evidence-missing-for-in-window-delist, exit-boundary-unresolved | EVIDENCE_MATCH_AMBIGUOUS, EXIT_UNRESOLVED | 2021-01 | 2022-05 |
| ALLUSDT | entry-boundary-unresolved, exit-boundary-unresolved | ENTRY_UNRESOLVED, EXIT_UNRESOLVED | 2025-08 | 2026-07 |
| ARUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2021-09 | 2026-07 |
| BDXNUSDT | exit-boundary-unresolved | EXIT_UNRESOLVED | 2025-06 | 2026-03 |
| BNXUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2022-04 | 2026-07 |
| BTCDOMUSDT | exit-boundary-unresolved | EXIT_UNRESOLVED | 2021-06 | 2026-07 |
| COCOSUSDT | exit-boundary-unresolved | EXIT_UNRESOLVED | 2023-02 | 2024-07 |
| CTKUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2020-11 | 2026-07 |
| CVCUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2020-11 | 2026-07 |
| CVXUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2022-09 | 2026-07 |
| EOSUSDT | exit-boundary-unresolved | EXIT_UNRESOLVED | 2020-01 | 2026-07 |
| FRONTUSDT | exit-boundary-unresolved | EXIT_UNRESOLVED | 2023-09 | 2026-07 |
| GAIBUSDT | entry-boundary-unresolved | ENTRY_UNRESOLVED | 2025-11 | 2026-04 |
| GALUSDT | exit-boundary-unresolved | EXIT_UNRESOLVED | 2022-05 | 2024-08 |
| ICPUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2021-05 | 2026-07 |
| LITUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2021-02 | 2026-07 |
| MATICUSDT | exit-boundary-unresolved | EXIT_UNRESOLVED | 2020-10 | 2026-07 |
| MAVIAUSDT | entry-boundary-unresolved | ENTRY_UNRESOLVED, RELIST_EPISODE_DETECTED | 2024-02 | 2026-07 |
| PUMPUSDT | listing-after-first-observed, entry-boundary-unresolved | TRUE_LIFECYCLE_CONFLICT, ENTRY_UNRESOLVED | 2025-04 | 2026-07 |
| RADUSDT | delist-at-or-before-last-observed, exit-boundary-unresolved | TRUE_LIFECYCLE_CONFLICT, EXIT_UNRESOLVED | 2023-05 | 2026-07 |
| RNDRUSDT | exit-boundary-unresolved | EXIT_UNRESOLVED | 2023-02 | 2024-08 |
| ROSEUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2021-12 | 2026-07 |
| SLPUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2023-10 | 2026-07 |
| SXPUSDT | exit-boundary-unresolved | EXIT_UNRESOLVED | 2020-07 | 2026-05 |
| TLMUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2021-07 | 2026-07 |
| TOMOUSDT | exit-boundary-unresolved | EXIT_UNRESOLVED | 2020-10 | 2024-08 |

## Data gaps

| Symbol | Artifact | Reason |
|---|---|---|
| 1MBABYDOGEUSDT | price | declared-active-start-after-lifecycle-start |
| 1MBABYDOGEUSDT | minute | declared-active-start-after-lifecycle-start |
| 1MBABYDOGEUSDT | minute | active-start-not-covered |
| 1MBABYDOGEUSDT | funding | declared-active-start-after-lifecycle-start |
| 2ZUSDT | minute | active-start-not-covered |
| AIAUSDT | price | declared-active-start-after-lifecycle-start |
| AIAUSDT | price | active-start-not-covered |
| AIAUSDT | minute | declared-active-start-after-lifecycle-start |
| AIAUSDT | minute | active-start-not-covered |
| AIAUSDT | funding | declared-active-start-after-lifecycle-start |
| AIAUSDT | funding | funding-start-outside-window |
| AKROUSDT | price | declared-active-end-before-lifecycle-end |
| AKROUSDT | price | active-end-not-covered |
| AKROUSDT | minute | declared-active-end-before-lifecycle-end |
| AKROUSDT | minute | active-end-not-covered |
| AKROUSDT | funding | declared-active-end-before-lifecycle-end |
| AKROUSDT | funding | funding-start-outside-window |
| ALLUSDT | price | declared-active-start-after-lifecycle-start |
| ALLUSDT | price | active-start-not-covered |
| ALLUSDT | minute | declared-active-start-after-lifecycle-start |
| ALLUSDT | minute | active-start-not-covered |
| ALLUSDT | funding | declared-active-start-after-lifecycle-start |
| ALLUSDT | funding | funding-start-outside-window |
| BDXNUSDT | minute | active-start-not-covered |
| COCOSUSDT | price | declared-active-end-before-lifecycle-end |
| COCOSUSDT | price | active-end-not-covered |
| COCOSUSDT | minute | declared-active-end-before-lifecycle-end |
| COCOSUSDT | minute | active-end-not-covered |
| COCOSUSDT | funding | declared-active-end-before-lifecycle-end |
| COCOSUSDT | funding | funding-end-window-not-covered |
| COMMONUSDT | minute | active-start-not-covered |
| CTKUSDT | price | active-end-not-covered |
| CTKUSDT | minute | active-end-not-covered |
| CVXUSDT | price | active-end-not-covered |
| CVXUSDT | minute | active-end-not-covered |
| DAMUSDT | minute | active-start-not-covered |
| DMCUSDT | price | active-start-not-covered |
| DMCUSDT | minute | active-start-not-covered |
| EOSUSDT | price | active-end-not-covered |
| EOSUSDT | minute | active-end-not-covered |
| EPTUSDT | minute | active-start-not-covered |
| EPTUSDT | funding | funding-start-outside-window |
| EVAAUSDT | minute | active-start-not-covered |
| FLOCKUSDT | minute | active-start-not-covered |
| FRONTUSDT | price | active-end-not-covered |
| FRONTUSDT | minute | active-end-not-covered |
| GAIBUSDT | price | missing-artifact |
| GAIBUSDT | price | observed-range-missing |
| GAIBUSDT | minute | missing-artifact |
| GAIBUSDT | minute | observed-range-missing |
| GAIBUSDT | funding | missing-artifact |
| GAIBUSDT | funding | funding-start-outside-window |
| GALUSDT | price | declared-active-end-before-lifecycle-end |
| GALUSDT | price | active-end-not-covered |
| GALUSDT | minute | declared-active-end-before-lifecycle-end |
| GALUSDT | minute | active-end-not-covered |
| GALUSDT | funding | declared-active-end-before-lifecycle-end |
| GALUSDT | funding | funding-end-window-not-covered |
| HMSTRUSDT | price | declared-active-start-after-lifecycle-start |
| HMSTRUSDT | price | active-start-not-covered |
| HMSTRUSDT | minute | declared-active-start-after-lifecycle-start |
| HMSTRUSDT | minute | active-start-not-covered |
| HMSTRUSDT | funding | declared-active-start-after-lifecycle-start |
| HMSTRUSDT | funding | funding-start-outside-window |
| JUPUSDT | funding | funding-start-outside-window |
| MATICUSDT | price | active-end-not-covered |
| MATICUSDT | minute | active-end-not-covered |
| MAVIAUSDT | price | declared-active-start-after-lifecycle-start |
| MAVIAUSDT | price | active-start-not-covered |
| MAVIAUSDT | minute | declared-active-start-after-lifecycle-start |
| MAVIAUSDT | minute | active-start-not-covered |
| MAVIAUSDT | funding | declared-active-start-after-lifecycle-start |
| MAVIAUSDT | funding | funding-start-outside-window |
| MAVIAUSDT | price | active-end-not-covered |
| MAVIAUSDT | minute | active-end-not-covered |
| MONUSDT | minute | active-start-not-covered |
| NEIROUSDT | minute | active-start-not-covered |
| RNDRUSDT | price | declared-active-end-before-lifecycle-end |
| RNDRUSDT | price | active-end-not-covered |
| RNDRUSDT | minute | declared-active-end-before-lifecycle-end |

## Integrity and provenance

- Required artifacts: price, minute, funding
- Active markets with complete artifact metadata: 586/619
- Data gaps: 98
- Hash failures: 3
- Liquidity metadata unknown: 10
- Liquidity eligible observations: 697865
- Liquidity rejected for insufficient 30-day history: 117504
- Liquidity rejected for gap: 22449
- Liquidity rejected below threshold: 767169
- PIT liquidity eligible monthly min/mean/max: 118 / 160.83333333333334 / 224
- PIT universe SHA-256: 704cd7bf8f0aa74810ce5ac884a78cfca73a81585633c7dcee93e79ef3b71683
- Universe evidence SHA-256: 10c601040b320b225ab1e72597a0f4b682c87da76a1e6c3f4da82a24d1fa5951
- Dataset manifest SHA-256: 79d4f0623b6a9cbdbbf756c3a71a2c3ab224d6d26457d5e5101e72bdd4342a3a

Formal Event Research status: **M4_BLOCKED; Event Research not run**.
