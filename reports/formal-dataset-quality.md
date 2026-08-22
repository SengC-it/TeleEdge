# M4 Formal Dataset Quality Report

Status: **M4-INCOMPLETE**. The reproducible acquisition run and strict verification were completed, but the dataset did not pass the formal gate. No V7.5/V8 strategy run, optimization, or profitability conclusion was performed.

## Scope and provenance

- Backtest interval: `2021-01-01T00:00:00Z` through `2026-08-01T00:00:00Z`
- Source: Binance Data Vision USD-M monthly archive listings; current `exchangeInfo` is a cross-check only.
- Discovered archive symbols: 830
- Dataset symbols with actual archives: 829
- Symbol excluded because no actual archive was found: `LENDUSDT`
- Core symbols: 70
- Expanded/non-core symbols: 759
- Current symbols: 650
- Historical archive-only symbols: 179
- Lifecycle-exact symbols: 650
- Lifecycle-unresolved symbols: 179

The builder records actual first/last archive month and first/last observed price timestamp per market. It does not promote an archive observation or an inferred last kline into historical listing/delist evidence.

Evidence and hashes are stored outside Git under `data/backtest/source/`:

- `archive-index.json`: archive prefixes, actual archive keys, snapshot, requested month window, and source metadata; SHA-256 `7ff9cd5758ae99eaf66a6224ce75ae281007fd5a769cb076fabbb497cf49b169`
- `current-exchangeInfo.json`: contemporaneous exchange-info cross-check and SHA-256 recorded in `manifest.json`
- `manifest.json`: per-symbol lifecycle and per-artifact `symbol`, `kind`, `interval`, active window, rows, and SHA-256
- `quality-report.json`: generated counts and strict verifier result

## Universe quality

Resolved-lifecycle active symbols by year:

| Year | Active symbols |
| --- | ---: |
| 2021 | 116 |
| 2022 | 135 |
| 2023 | 228 |
| 2024 | 357 |
| 2025 | 581 |
| 2026 | 581 |

Lifecycle evidence coverage:

- Listing evidence: 650 / 829
- Delist/delivery evidence: 122 / 829
- Exact lifecycle: 650 / 829
- Unresolved lifecycle: 179 / 829
- `pointInTime`: `false`
- `historicalDelistingsResolved`: `false`

The 179 archive-only markets lack timestamped listing and/or delivery/delist evidence. Their active windows remain explicitly unresolved; they are not counted as resolved PIT lifecycle records.

## Downloaded artifacts

The resumable builder completed the available archive acquisition with checksum validation, retry, pagination, per-symbol active-window transformation, and serialized progress writes.

| Artifact | Files | Rows | Missing non-empty artifact |
| --- | ---: | ---: | --- |
| 1h price | 828 | 14,330,187 | `GAIBUSDT` |
| 1m execution/settlement | 828 | 859,795,074 | `GAIBUSDT` |
| funding events | 829 | 2,481,882 | none by row count |

- Total derived artifacts: 2,485
- Derived data bytes: 13,422,831,479 (~12.5 GiB)
- Funding is represented as an event stream; the manifest records the funding interval metadata/fallback contract. Funding rows are not treated as continuous candles.

The missing `GAIBUSDT` price and 1m artifacts, plus event-window/active-window violations, prevent the required-artifact contract from passing. “No missing funding file” does not mean funding coverage passed.

## Strict verifier

Command:

```powershell
npm run backtest:verify-data -- --strict
```

Result: exit code `1`.

| Check | Result |
| --- | ---: |
| `status` | `M4-INCOMPLETE` |
| `complete` | `false` |
| missing artifacts | 2 |
| SHA/hash mismatches | 0 |
| row-count failures | 0 |
| timestamp continuity failures | 120 |
| active-window/coverage failures | 728 |
| expanded/non-core artifact contract | failed |
| `formalOosAllowed` | `false` |

The coverage failures include funding event-window violations and price/1m active-window gaps. The expanded/non-core contract is not inferred from the manifest boolean; it is failed from the actual market/artifact checks.

## Gate decision and next work

M4 remains **INCOMPLETE**. Formal OOS is blocked until all required lifecycle evidence and active-window coverage pass, `GAIBUSDT` has complete price/1m artifacts, continuity and funding event-window failures are resolved, and the actual expanded/non-core artifact contract passes.

No formal V7.5 baseline or V8 result is reported from this dataset. Any five-coin or other reduced run remains smoke/sanity evidence only and must not be described as full V7.5 Control OOS.
