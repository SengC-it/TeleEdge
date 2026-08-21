# M4 Formal Dataset Quality Report

Status: **M4-INCOMPLETE**. This report records dataset construction and gate results only. No strategy run, optimization, or profitability conclusion was performed.

## Discovery snapshot

- Backtest start: `2021-01-01T00:00:00Z`
- Snapshot end: `2026-08-01T00:00:00Z` (last complete monthly archive boundary)
- Source: Binance Data Vision USD-M monthly archive-prefix listing; current `exchangeInfo` is stored only as a cross-check.
- Discovered archive symbols: 830
- Core symbols: 70
- Expanded/non-core symbols: 760
- Archive-only symbols not present in current perpetual exchangeInfo: 180
- Active symbols by year: 2021 296; 2022 315; 2023 408; 2024 537; 2025 761; 2026 761

Generated evidence is kept outside Git under `data/backtest/source/`:

- `archive-index.json` records the source endpoints, snapshot, archive prefixes, month window, and SHA256.
- `current-exchangeInfo.json` records the contemporaneous cross-check and SHA256.
- `quality-report.json` records counts, missing artifacts, rows, bytes, and verifier output.

The discovery command was:

```powershell
npm run backtest:formal:discover -- --snapshot-end 2026-08-01T00:00:00Z --rate-limit-ms 100 --concurrency 4
```

Discovery intentionally downloaded no candles. Therefore the discovery manifest has 0 derived artifacts and reports 830 missing price, 830 missing funding, and 830 missing 1m artifacts. `npm run backtest:verify-data -- --strict` exited 1 with `status=M4-INCOMPLETE`, `complete=false`, and `artifacts=0`.

## Downloader validation

A one-month BTC-only build validated the real source path without representing formal OOS:

- Window: `2021-01-01T00:00:00Z` to `2021-02-01T00:00:00Z`
- 1h price rows: 744
- Funding event rows: 93
- 1m rows: 44,640
- Derived artifact bytes: 1,195,198
- SHA256, row count, continuity, and active-window coverage: passed
- Re-running the same command reused the completed artifacts through the progress/resume path

This validation remains `formalOosAllowed=false` because it is one symbol, has no expanded market, and does not satisfy the historical lifecycle gate.

## Remaining strict-gate blockers

1. The archive index provides historical symbol evidence, but exact historical delivery/delist evidence has not been supplied for all 180 archive-only symbols. The builder therefore keeps `historicalDelistingsResolved=false`; archive last-kline boundaries are explicitly marked inferred.
2. The complete 830-symbol 1h/1m/funding artifact set was not silently substituted with a partial set. The formal downloader supports checksum verification, retries, `.part` resume, monthly pagination, per-symbol lifecycle windows, and quality reporting, but the full artifact build remains a separate large data acquisition step.
3. Until every lifecycle and required artifact passes the strict verifier, formal V7.5 vs V8 OOS is forbidden. M4 remains incomplete and no profitability statement is valid.
