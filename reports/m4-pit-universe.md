# M4 PIT Universe Closure

Status: **M4_BLOCKED**

Development window: 2024-01-01T00:00:00.000Z → 2026-01-01T00:00:00.000Z (end exclusive). Snapshot: 2026-08-01T00:00:00.000Z.

This report uses the union of actual Binance Data Vision USD-M archive evidence and the current exchangeInfo cross-check. Current exchangeInfo is never used as the sole historical universe source. Archive first/last observations are diagnostics only and cannot certify an in-window listing or delisting.

## Universe

- Discovered symbols: 850
- Current symbols: 820
- Historical archive-only symbols: 30
- Listed during Development: 384
- Delisted during Development: 77
- PIT window resolved: 455/850
- Unresolved Development lifecycle: 395
- M4_PIT_WINDOW_COMPLETE: **false**
- M4_GLOBAL_COMPLETE: **false**
- Manifest strict data contract ready: **false**

## Monthly PIT universe

| Month | PIT eligible | Core | Expanded |
|---|---:|---:|---:|
| 2024-01 | 160 | 36 | 124 |
| 2024-02 | 165 | 37 | 128 |
| 2024-03 | 165 | 37 | 128 |
| 2024-04 | 167 | 37 | 130 |
| 2024-05 | 168 | 37 | 131 |
| 2024-06 | 171 | 37 | 134 |
| 2024-07 | 172 | 38 | 134 |
| 2024-08 | 175 | 38 | 137 |
| 2024-09 | 177 | 39 | 138 |
| 2024-10 | 182 | 40 | 142 |
| 2024-11 | 183 | 40 | 143 |
| 2024-12 | 192 | 40 | 152 |
| 2025-01 | 198 | 42 | 156 |
| 2025-02 | 203 | 43 | 160 |
| 2025-03 | 216 | 43 | 173 |
| 2025-04 | 222 | 43 | 179 |
| 2025-05 | 228 | 43 | 185 |
| 2025-06 | 233 | 43 | 190 |
| 2025-07 | 239 | 43 | 196 |
| 2025-08 | 241 | 43 | 198 |
| 2025-09 | 253 | 44 | 209 |
| 2025-10 | 258 | 44 | 214 |
| 2025-11 | 263 | 46 | 217 |
| 2025-12 | 268 | 46 | 222 |

## Monthly PIT liquidity eligibility

Fixed rule: completed point-in-time 30-day average quote volume ≥ 20,000,000 USDT. Missing liquidity history is fail-closed and is not inferred from future volume.

| Month | Liquidity-eligible | Core | Expanded | Unknown |
|---|---:|---:|---:|---:|
| 2024-01 | 0 | 0 | 0 | 160 |
| 2024-02 | 0 | 0 | 0 | 165 |
| 2024-03 | 0 | 0 | 0 | 165 |
| 2024-04 | 0 | 0 | 0 | 167 |
| 2024-05 | 0 | 0 | 0 | 168 |
| 2024-06 | 0 | 0 | 0 | 171 |
| 2024-07 | 0 | 0 | 0 | 172 |
| 2024-08 | 0 | 0 | 0 | 175 |
| 2024-09 | 0 | 0 | 0 | 177 |
| 2024-10 | 0 | 0 | 0 | 182 |
| 2024-11 | 0 | 0 | 0 | 183 |
| 2024-12 | 0 | 0 | 0 | 192 |
| 2025-01 | 0 | 0 | 0 | 198 |
| 2025-02 | 0 | 0 | 0 | 203 |
| 2025-03 | 0 | 0 | 0 | 216 |
| 2025-04 | 0 | 0 | 0 | 222 |
| 2025-05 | 0 | 0 | 0 | 228 |
| 2025-06 | 0 | 0 | 0 | 233 |
| 2025-07 | 0 | 0 | 0 | 239 |
| 2025-08 | 0 | 0 | 0 | 241 |
| 2025-09 | 0 | 0 | 0 | 253 |
| 2025-10 | 0 | 0 | 0 | 258 |
| 2025-11 | 0 | 0 | 0 | 263 |
| 2025-12 | 0 | 0 | 0 | 268 |

## Lifecycle blockers

| Symbol | Reason | First archive month | Last archive month |
|---|---|---|---|
| 0GUSDT | listing-after-first-observed | 2025-09 | 2026-07 |
| 1000000BOBUSDT | listing-after-first-observed | 2025-06 | 2026-07 |
| 1000000MOGUSDT | listing-after-first-observed | 2024-11 | 2026-07 |
| 1000CATUSDT | listing-after-first-observed | 2024-10 | 2026-07 |
| 1000CHEEMSUSDT | listing-after-first-observed | 2024-11 | 2026-07 |
| 1000WHYUSDT | listing-after-first-observed, delist-at-or-before-last-observed | 2024-11 | 2026-07 |
| 1000XUSDT | listing-after-first-observed, delist-at-or-before-last-observed | 2024-11 | 2026-07 |
| 1MBABYDOGEUSDT | listing-after-first-observed | 2024-09 | 2026-07 |
| 2ZUSDT | listing-after-first-observed | 2025-10 | 2026-07 |
| 42USDT | listing-after-first-observed, delist-at-or-before-last-observed | 2025-10 | 2026-07 |
| 4USDT | listing-after-first-observed | 2025-10 | 2026-07 |
| A2ZUSDT | delist-at-or-before-last-observed | 2025-07 | 2026-07 |
| ACTUSDT | listing-after-first-observed | 2024-11 | 2026-07 |
| AERGOUSDT | entry-boundary-unresolved | 2024-09 | 2026-06 |
| AEROUSDT | listing-after-first-observed | 2024-12 | 2026-07 |
| AEVOUSDT | listing-after-first-observed | 2024-03 | 2026-07 |
| AGIXUSDT | delist-at-or-before-last-observed | 2023-02 | 2026-07 |
| AGLDUSDT | listing-after-first-observed | 2023-07 | 2026-07 |
| AGTUSDT | listing-after-first-observed | 2025-05 | 2026-07 |
| AI16ZUSDT | listing-after-first-observed, delist-at-or-before-last-observed | 2025-01 | 2026-07 |
| AIAUSDT | delist-at-or-before-last-observed | 2025-09 | 2026-07 |
| AINUSDT | listing-after-first-observed | 2025-07 | 2026-07 |
| AIOTUSDT | listing-after-first-observed | 2025-04 | 2026-07 |
| AIOUSDT | listing-after-first-observed | 2025-08 | 2026-07 |
| AIUSDT | listing-after-first-observed, delist-at-or-before-last-observed | 2024-01 | 2026-07 |
| AIXBTUSDT | listing-after-first-observed | 2024-12 | 2026-07 |
| AKEUSDT | listing-after-first-observed | 2025-09 | 2026-07 |
| AKROUSDT | delist-evidence-missing-for-in-window-delist | 2021-01 | 2022-05 |
| AKTUSDT | listing-after-first-observed | 2024-11 | 2026-07 |
| ALCHUSDT | listing-after-first-observed | 2025-01 | 2026-07 |
| ALLUSDT | listing-after-first-observed | 2025-08 | 2026-07 |
| ALPACAUSDT | listing-after-first-observed, delist-at-or-before-last-observed | 2024-08 | 2026-07 |
| ALPHAUSDT | delist-at-or-before-last-observed | 2020-11 | 2026-07 |
| ALPINEUSDT | listing-after-first-observed | 2025-05 | 2026-07 |
| AMBUSDT | delist-at-or-before-last-observed | 2023-03 | 2026-07 |
| ANTUSDT | delist-at-or-before-last-observed | 2021-12 | 2024-07 |
| APRUSDT | listing-after-first-observed | 2025-10 | 2026-07 |
| ARKMUSDT | listing-after-first-observed | 2023-07 | 2026-07 |
| ARUSDT | listing-after-first-observed | 2021-09 | 2026-07 |
| ASRUSDT | listing-after-first-observed | 2025-05 | 2026-07 |
| ATAUSDT | delist-at-or-before-last-observed | 2021-08 | 2026-07 |
| ATHUSDT | listing-after-first-observed | 2025-04 | 2026-07 |
| ATUSDT | listing-after-first-observed | 2025-10 | 2026-07 |
| AUDIOUSDT | delist-at-or-before-last-observed | 2021-08 | 2024-07 |
| AVAAIUSDT | listing-after-first-observed | 2025-01 | 2026-07 |
| AXLUSDT | listing-after-first-observed | 2024-03 | 2026-07 |
| B2USDT | listing-after-first-observed | 2025-05 | 2026-07 |
| B3USDT | listing-after-first-observed, delist-at-or-before-last-observed | 2025-02 | 2026-07 |
| BABYUSDT | listing-after-first-observed | 2025-04 | 2026-07 |
| BADGERUSDT | listing-after-first-observed, delist-at-or-before-last-observed | 2023-11 | 2026-07 |
| BAKEUSDT | delist-at-or-before-last-observed | 2021-05 | 2026-07 |
| BALUSDT | delist-at-or-before-last-observed | 2020-09 | 2026-07 |
| BANANAS31USDT | listing-after-first-observed | 2025-03 | 2026-07 |
| BANKUSDT | listing-after-first-observed | 2025-04 | 2026-07 |
| BANUSDT | listing-after-first-observed | 2024-11 | 2026-07 |
| BASUSDT | listing-after-first-observed | 2025-08 | 2026-07 |
| BBUSDT | listing-after-first-observed | 2024-05 | 2026-07 |
| BDXNUSDT | exit-boundary-unresolved | 2025-06 | 2026-03 |
| BEAMXUSDT | listing-after-first-observed | 2023-11 | 2026-07 |
| BEATUSDT | listing-after-first-observed | 2025-11 | 2026-07 |
| BICOUSDT | listing-after-first-observed | 2023-09 | 2026-07 |
| BIDUSDT | listing-after-first-observed, delist-at-or-before-last-observed | 2025-03 | 2026-07 |
| BIGTIMEUSDT | listing-after-first-observed | 2023-10 | 2026-07 |
| BIOUSDT | listing-after-first-observed | 2025-01 | 2026-07 |
| BLESSUSDT | listing-after-first-observed | 2025-09 | 2026-07 |
| BLUAIUSDT | listing-after-first-observed | 2025-10 | 2026-07 |
| BLUEBIRDUSDT | delist-at-or-before-last-observed | 2022-11 | 2024-07 |
| BLZUSDT | delist-at-or-before-last-observed | 2020-09 | 2026-07 |
| BMTUSDT | listing-after-first-observed | 2025-03 | 2026-07 |
| BNXUSDT | listing-after-first-observed, delist-at-or-before-last-observed | 2022-04 | 2026-07 |
| BOBUSDT | listing-after-first-observed, delist-at-or-before-last-observed | 2025-11 | 2026-07 |
| BOMEUSDT | listing-after-first-observed | 2024-03 | 2026-07 |
| BONDUSDT | listing-after-first-observed, delist-at-or-before-last-observed | 2023-10 | 2026-07 |
| BRETTUSDT | listing-after-first-observed | 2024-08 | 2026-07 |
| BREVUSDT | listing-after-first-observed | 2025-12 | 2026-07 |
| BROCCOLIF3BUSDT | listing-after-first-observed | 2025-03 | 2026-07 |
| BRUSDT | listing-after-first-observed | 2025-03 | 2026-07 |
| BSVUSDT | listing-after-first-observed | 2023-10 | 2026-07 |
| BSWUSDT | delist-at-or-before-last-observed | 2024-09 | 2026-07 |
| BTCSTUSDT | delist-at-or-before-last-observed, exit-boundary-unresolved | 2021-03 | 2026-06 |

## Data gaps

| Symbol | Artifact | Reason |
|---|---|---|
| 2ZUSDT | minute | active-start-not-covered |
| AERGOUSDT | price | declared-active-start-after-lifecycle-start |
| AERGOUSDT | price | active-start-not-covered |
| AERGOUSDT | minute | declared-active-start-after-lifecycle-start |
| AERGOUSDT | minute | active-start-not-covered |
| AERGOUSDT | funding | declared-active-start-after-lifecycle-start |
| AERGOUSDT | funding | funding-start-outside-window |
| AIAUSDT | minute | active-start-not-covered |
| AKROUSDT | price | declared-active-end-before-lifecycle-end |
| AKROUSDT | price | active-end-not-covered |
| AKROUSDT | minute | declared-active-end-before-lifecycle-end |
| AKROUSDT | minute | active-end-not-covered |
| AKROUSDT | funding | declared-active-end-before-lifecycle-end |
| AKROUSDT | funding | funding-start-outside-window |
| BDXNUSDT | minute | active-start-not-covered |
| CATUSDT | price | active-start-not-covered |
| CATUSDT | minute | active-start-not-covered |
| CATUSDT | funding | funding-start-outside-window |
| COCOSUSDT | price | declared-active-end-before-lifecycle-end |
| COCOSUSDT | price | active-end-not-covered |
| COCOSUSDT | minute | declared-active-end-before-lifecycle-end |
| COCOSUSDT | minute | active-end-not-covered |
| COCOSUSDT | funding | declared-active-end-before-lifecycle-end |
| COCOSUSDT | funding | funding-end-window-not-covered |
| COMMONUSDT | minute | active-start-not-covered |
| DAMUSDT | minute | active-start-not-covered |
| DISUSDT | price | active-start-not-covered |
| DISUSDT | minute | active-start-not-covered |
| DISUSDT | funding | funding-start-outside-window |
| DMCUSDT | price | active-start-not-covered |
| DMCUSDT | minute | active-start-not-covered |
| EOSUSDT | price | active-end-not-covered |
| EOSUSDT | minute | active-end-not-covered |
| EPTUSDT | minute | active-start-not-covered |
| EPTUSDT | funding | funding-start-outside-window |
| EVAAUSDT | minute | active-start-not-covered |
| EWTUSDT | price | active-start-not-covered |
| EWTUSDT | minute | active-start-not-covered |
| EWTUSDT | funding | funding-start-outside-window |
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
| JUPUSDT | funding | funding-start-outside-window |
| LLYUSDT | price | active-start-not-covered |
| LLYUSDT | minute | active-start-not-covered |
| LLYUSDT | funding | funding-start-outside-window |
| MATICUSDT | price | active-end-not-covered |
| MATICUSDT | minute | active-end-not-covered |
| MONUSDT | minute | active-start-not-covered |
| MSTRUSDT | price | active-start-not-covered |
| MSTRUSDT | minute | active-start-not-covered |
| MSTRUSDT | funding | funding-start-outside-window |
| NEIROUSDT | minute | active-start-not-covered |
| RNDRUSDT | price | declared-active-end-before-lifecycle-end |
| RNDRUSDT | price | active-end-not-covered |
| RNDRUSDT | minute | declared-active-end-before-lifecycle-end |
| RNDRUSDT | minute | active-end-not-covered |
| RNDRUSDT | funding | declared-active-end-before-lifecycle-end |
| RNDRUSDT | funding | funding-end-window-not-covered |
| RVVUSDT | minute | active-start-not-covered |
| SKATEUSDT | minute | active-start-not-covered |
| SXPUSDT | funding | funding-end-window-not-covered |
| TANSSIUSDT | minute | active-start-not-covered |
| TERUSDT | price | active-start-not-covered |
| TERUSDT | minute | active-start-not-covered |
| TERUSDT | funding | funding-start-outside-window |
| TOMOUSDT | price | declared-active-end-before-lifecycle-end |
| TOMOUSDT | price | active-end-not-covered |

## Integrity and provenance

- Required artifacts: price, minute, funding
- Active markets with complete artifact metadata: 620/655
- Data gaps: 89
- Hash failures: 3
- Liquidity metadata unknown: 655
- PIT universe SHA-256: 6db7cfe9e2d726c9cac3210f93e13a706703b07bfafc82be7045fdbd46643bac
- Universe evidence SHA-256: 8e679aa4628a1ea30ada506087e1abde1f0696d0aeca6d20507dfc530810ebc7
- Dataset manifest SHA-256: 79d4f0623b6a9cbdbbf756c3a71a2c3ab224d6d26457d5e5101e72bdd4342a3a

Formal Event Research status: **M4_BLOCKED; Event Research not run**.
