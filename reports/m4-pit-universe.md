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
- PIT window resolved: 316/681
- Unresolved Development lifecycle: 365
- Development-active episodes: 622
- Multi-episode/relisted symbols: 2
- Relist episode classification: 3
- True lifecycle conflicts: 352
- Ambiguous evidence matches: 1
- M4_PIT_WINDOW_COMPLETE: **false**
- M4_GLOBAL_COMPLETE: **false**
- M4 window data contract ready: **false**
- Legacy manifest data contract diagnostic: **false**

## Monthly PIT universe

| Month | PIT eligible | Core | Expanded |
|---|---:|---:|---:|
| 2024-01 | 159 | 36 | 123 |
| 2024-02 | 164 | 37 | 127 |
| 2024-03 | 164 | 37 | 127 |
| 2024-04 | 166 | 37 | 129 |
| 2024-05 | 167 | 37 | 130 |
| 2024-06 | 170 | 37 | 133 |
| 2024-07 | 171 | 38 | 133 |
| 2024-08 | 174 | 38 | 136 |
| 2024-09 | 176 | 38 | 138 |
| 2024-10 | 180 | 39 | 141 |
| 2024-11 | 181 | 39 | 142 |
| 2024-12 | 190 | 39 | 151 |
| 2025-01 | 196 | 41 | 155 |
| 2025-02 | 201 | 42 | 159 |
| 2025-03 | 213 | 42 | 171 |
| 2025-04 | 219 | 42 | 177 |
| 2025-05 | 225 | 42 | 183 |
| 2025-06 | 229 | 42 | 187 |
| 2025-07 | 235 | 42 | 193 |
| 2025-08 | 236 | 42 | 194 |
| 2025-09 | 247 | 43 | 204 |
| 2025-10 | 252 | 43 | 209 |
| 2025-11 | 257 | 45 | 212 |
| 2025-12 | 262 | 45 | 217 |

## Monthly PIT liquidity eligibility

Fixed rule: completed point-in-time 30-day average quote volume ≥ 20,000,000 USDT. Missing liquidity history is fail-closed and is not inferred from future volume.

| Month | Liquidity-eligible | Core | Expanded | Unknown |
|---|---:|---:|---:|---:|
| 2024-01 | 105 | 34 | 71 | 12 |
| 2024-02 | 116 | 35 | 81 | 13 |
| 2024-03 | 149 | 37 | 112 | 8 |
| 2024-04 | 122 | 35 | 87 | 10 |
| 2024-05 | 102 | 35 | 67 | 9 |
| 2024-06 | 88 | 33 | 55 | 11 |
| 2024-07 | 84 | 34 | 50 | 9 |
| 2024-08 | 85 | 35 | 50 | 11 |
| 2024-09 | 80 | 33 | 47 | 10 |
| 2024-10 | 87 | 34 | 53 | 11 |
| 2024-11 | 131 | 38 | 93 | 9 |
| 2024-12 | 141 | 39 | 102 | 17 |
| 2025-01 | 109 | 36 | 73 | 14 |
| 2025-02 | 104 | 39 | 65 | 13 |
| 2025-03 | 89 | 39 | 50 | 20 |
| 2025-04 | 93 | 39 | 54 | 14 |
| 2025-05 | 99 | 38 | 61 | 13 |
| 2025-06 | 84 | 39 | 45 | 12 |
| 2025-07 | 111 | 39 | 72 | 14 |
| 2025-08 | 109 | 39 | 70 | 9 |
| 2025-09 | 89 | 39 | 50 | 19 |
| 2025-10 | 96 | 41 | 55 | 11 |
| 2025-11 | 87 | 41 | 46 | 13 |
| 2025-12 | 73 | 39 | 34 | 13 |

## Lifecycle blockers

| Symbol | Reason | Conflict class | First archive month | Last archive month |
|---|---|---|---|---|
| 0GUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-09 | 2026-07 |
| 1000000BOBUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-06 | 2026-07 |
| 1000000MOGUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-11 | 2026-07 |
| 1000CATUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-10 | 2026-07 |
| 1000CHEEMSUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-11 | 2026-07 |
| 1000WHYUSDT | listing-after-first-observed, delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2024-11 | 2026-07 |
| 1000XUSDT | listing-after-first-observed, delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2024-11 | 2026-07 |
| 1MBABYDOGEUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-09 | 2026-07 |
| 2ZUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-10 | 2026-07 |
| 42USDT | listing-after-first-observed, delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2025-10 | 2026-07 |
| 4USDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-10 | 2026-07 |
| A2ZUSDT | delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2025-07 | 2026-07 |
| ACTUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-11 | 2026-07 |
| AERGOUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-09 | 2026-06 |
| AEROUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-12 | 2026-07 |
| AEVOUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-03 | 2026-07 |
| AGIXUSDT | delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2023-02 | 2026-07 |
| AGLDUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2023-07 | 2026-07 |
| AGTUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-05 | 2026-07 |
| AI16ZUSDT | listing-after-first-observed, delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2025-01 | 2026-07 |
| AIAUSDT | entry-boundary-unresolved | ENTRY_UNRESOLVED, RELIST_EPISODE_DETECTED | 2025-09 | 2026-07 |
| AINUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-07 | 2026-07 |
| AIOTUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-04 | 2026-07 |
| AIOUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-08 | 2026-07 |
| AIUSDT | listing-after-first-observed, delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2024-01 | 2026-07 |
| AIXBTUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-12 | 2026-07 |
| AKEUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-09 | 2026-07 |
| AKROUSDT | delist-evidence-missing-for-in-window-delist, exit-boundary-unresolved | EVIDENCE_MATCH_AMBIGUOUS, EXIT_UNRESOLVED | 2021-01 | 2022-05 |
| AKTUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-11 | 2026-07 |
| ALCHUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-01 | 2026-07 |
| ALLUSDT | entry-boundary-unresolved, exit-boundary-unresolved | ENTRY_UNRESOLVED, EXIT_UNRESOLVED | 2025-08 | 2026-07 |
| ALPACAUSDT | listing-after-first-observed, delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2024-08 | 2026-07 |
| ALPHAUSDT | delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2020-11 | 2026-07 |
| ALPINEUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-05 | 2026-07 |
| AMBUSDT | delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2023-03 | 2026-07 |
| ANTUSDT | delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2021-12 | 2024-07 |
| APRUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-10 | 2026-07 |
| ARKMUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2023-07 | 2026-07 |
| ARUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2021-09 | 2026-07 |
| ASRUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-05 | 2026-07 |
| ATAUSDT | delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2021-08 | 2026-07 |
| ATHUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-04 | 2026-07 |
| ATUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-10 | 2026-07 |
| AUDIOUSDT | delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2021-08 | 2024-07 |
| AVAAIUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-01 | 2026-07 |
| AXLUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-03 | 2026-07 |
| B2USDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-05 | 2026-07 |
| B3USDT | listing-after-first-observed, delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2025-02 | 2026-07 |
| BABYUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-04 | 2026-07 |
| BADGERUSDT | listing-after-first-observed, delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2023-11 | 2026-07 |
| BAKEUSDT | delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2021-05 | 2026-07 |
| BALUSDT | delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2020-09 | 2026-07 |
| BANANAS31USDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-03 | 2026-07 |
| BANKUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-04 | 2026-07 |
| BANUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-11 | 2026-07 |
| BASUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-08 | 2026-07 |
| BBUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-05 | 2026-07 |
| BDXNUSDT | exit-boundary-unresolved | EXIT_UNRESOLVED | 2025-06 | 2026-03 |
| BEAMXUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2023-11 | 2026-07 |
| BEATUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-11 | 2026-07 |
| BICOUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2023-09 | 2026-07 |
| BIDUSDT | listing-after-first-observed, delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2025-03 | 2026-07 |
| BIGTIMEUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2023-10 | 2026-07 |
| BIOUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-01 | 2026-07 |
| BLESSUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-09 | 2026-07 |
| BLUAIUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-10 | 2026-07 |
| BLUEBIRDUSDT | delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2022-11 | 2024-07 |
| BLZUSDT | delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2020-09 | 2026-07 |
| BMTUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-03 | 2026-07 |
| BNXUSDT | listing-after-first-observed, delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2022-04 | 2026-07 |
| BOBUSDT | listing-after-first-observed, delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2025-11 | 2026-07 |
| BOMEUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-03 | 2026-07 |
| BONDUSDT | listing-after-first-observed, delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2023-10 | 2026-07 |
| BRETTUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2024-08 | 2026-07 |
| BREVUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-12 | 2026-07 |
| BROCCOLIF3BUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-03 | 2026-07 |
| BRUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2025-03 | 2026-07 |
| BSVUSDT | listing-after-first-observed | TRUE_LIFECYCLE_CONFLICT | 2023-10 | 2026-07 |
| BSWUSDT | delist-at-or-before-last-observed | TRUE_LIFECYCLE_CONFLICT | 2024-09 | 2026-07 |
| BTCDOMUSDT | exit-boundary-unresolved | EXIT_UNRESOLVED | 2021-06 | 2026-07 |

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
| MONUSDT | minute | active-start-not-covered |
| NEIROUSDT | minute | active-start-not-covered |
| RNDRUSDT | price | declared-active-end-before-lifecycle-end |
| RNDRUSDT | price | active-end-not-covered |
| RNDRUSDT | minute | declared-active-end-before-lifecycle-end |
| RNDRUSDT | minute | active-end-not-covered |
| RNDRUSDT | funding | declared-active-end-before-lifecycle-end |
| RNDRUSDT | funding | funding-end-window-not-covered |
| SKATEUSDT | minute | active-start-not-covered |
| SXPUSDT | funding | funding-end-window-not-covered |
| TANSSIUSDT | minute | active-start-not-covered |

## Integrity and provenance

- Required artifacts: price, minute, funding
- Active markets with complete artifact metadata: 589/619
- Data gaps: 88
- Hash failures: 3
- Liquidity metadata unknown: 10
- Liquidity eligible observations: 697865
- Liquidity rejected for insufficient 30-day history: 117504
- Liquidity rejected for gap: 22449
- Liquidity rejected below threshold: 767169
- PIT liquidity eligible monthly min/mean/max: 73 / 101.375 / 149
- PIT universe SHA-256: 1f812fa13d83c0fb8cf642d257b96127876f881a98305254b8866f336a248f71
- Universe evidence SHA-256: 10c601040b320b225ab1e72597a0f4b682c87da76a1e6c3f4da82a24d1fa5951
- Dataset manifest SHA-256: 79d4f0623b6a9cbdbbf756c3a71a2c3ab224d6d26457d5e5101e72bdd4342a3a

Formal Event Research status: **M4_BLOCKED; Event Research not run**.
