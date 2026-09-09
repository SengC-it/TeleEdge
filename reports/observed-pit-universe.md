# Observed-Tradability PIT Universe

Status: **OBSERVED_PIT_READY**

This is the observed-tradability research universe. Binance Data Vision archive union is the source of candidate symbols; current exchangeInfo is classification/filter metadata only and announcements are diagnostics only.

Development window: 2024-01-01T00:00:00.000Z → 2026-01-01T00:00:00.000Z (end exclusive).

## Universe and coverage

- Archive-union symbols: 678
- Archive-union symbols excluded as non-crypto/non-USDT/delivery: 152
- Price-bearing observed markets: 676
- Current exchangeInfo overlap: 647
- Observed historical stop before Development end: 26
- Core / expanded observed markets: 66 / 612
- PIT mean / median / min / max: 166.90264477884176 / 163 / 112 / 254
- Monthly median minimum: 117
- BTC required coverage: 1
- Data-loss observations (non-critical diagnostics): 250021
- Gate: **OBSERVED_PIT_READY**

## Monthly PIT diagnostics

| Month | PIT median | PIT mean | PIT min | Core median | Expanded median |
|---|---:|---:|---:|---:|---:|
| 2024-01 | 166 | 164.8494623655914 | 149 | 36 | 130 |
| 2024-02 | 140 | 140.66666666666666 | 126 | 35 | 105 |
| 2024-03 | 225 | 214.6236559139785 | 165 | 40 | 185 |
| 2024-04 | 216 | 211.95 | 185 | 39 | 177 |
| 2024-05 | 156.5 | 163.13440860215053 | 148 | 40 | 116.5 |
| 2024-06 | 157 | 155.5888888888889 | 141 | 40 | 117 |
| 2024-07 | 133 | 132.747311827957 | 126 | 39 | 93 |
| 2024-08 | 132 | 131.76344086021504 | 127 | 40 | 92.5 |
| 2024-09 | 117 | 117.9 | 112 | 39 | 78 |
| 2024-10 | 138.5 | 136.10752688172042 | 122 | 39 | 98 |
| 2024-11 | 154 | 160.2 | 135 | 43 | 111 |
| 2024-12 | 247 | 241.13978494623655 | 208 | 46 | 201 |
| 2025-01 | 193 | 195.15591397849462 | 181 | 47 | 146 |
| 2025-02 | 180 | 181.625 | 172 | 46 | 133 |
| 2025-03 | 160 | 161.7311827956989 | 148 | 49 | 111 |
| 2025-04 | 143.5 | 146.7111111111111 | 137 | 48 | 96 |
| 2025-05 | 177 | 171.84408602150538 | 147 | 48 | 130 |
| 2025-06 | 152 | 160.8 | 140 | 49 | 103 |
| 2025-07 | 153 | 159.75806451612902 | 137 | 50 | 104 |
| 2025-08 | 187 | 186.33333333333334 | 173 | 50 | 137 |
| 2025-09 | 166 | 165.76111111111112 | 158 | 49 | 116 |
| 2025-10 | 182 | 180.6290322580645 | 165 | 52 | 129 |
| 2025-11 | 176 | 177.90555555555557 | 164 | 55 | 120 |
| 2025-12 | 147 | 145.2311827956989 | 123 | 54 | 91.5 |

Every 4h snapshot writes compact diagnostics to observed-pit-snapshots.ndjson: archiveObservedSymbols, historyReadySymbols, liquidityReadySymbols, featureReadySymbols, finalPitSymbols, and local data-loss symbols.

## Artifact contract

- price: present 676/678, non-empty 676/678, hash-verified 676/678, missing 2, hash failures 2
- minute: present 676/678, non-empty 676/678, hash-verified 414/678, missing 2, hash failures 0
- funding: present 677/678, non-empty 677/678, hash-verified 676/678, missing 1, hash failures 0

## PIT invariants and diagnostics

- Future rows / future listing / future delisting knowledge / future volume: **true**
- Current exchangeInfo invariant: **true**
- Announcement evidence invariant: **true**
- Announcement evidence is not a membership hard gate: **true**
- Spot false-evidence fixture rejected as USD-M evidence: **true**

## Provenance

- Observed PIT universe SHA-256: 469647eb612e088fe7acc86dc26c61ab6fa6309692bea1ae8c674e38de18e4ee
- Archive index SHA-256: 7ff9cd5758ae99eaf66a6224ce75ae281007fd5a769cb076fabbb497cf49b169
- Dataset manifest SHA-256: 79d4f0623b6a9cbdbbf756c3a71a2c3ab224d6d26457d5e5101e72bdd4342a3a
