# TeleEdge backtest data and scope

`reports/teleedge-oos-backtest.*` is currently a **smoke/backtest sanity check** and is explicitly marked `M4-INCOMPLETE`. It is not a complete V7.5 Control OOS report: the five-symbol fixed sample does not establish the expanded/non-core funding-crowding and volume-shock universe, nor does it remove historical delisting/survivorship bias.

The clean-clone workflow has no dependency on `../v38_price_cache`, `../v38_funding_cache`, or `../v60_full_universe_cache`:

```powershell
npm run backtest:fetch -- --symbols BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT --include-1m
npm run backtest:verify-data
npm run backtest
```

`backtest:fetch` downloads bounded 1h klines, funding events, and an exchange-info snapshot. Add `--include-1m` to fetch the preferred execution data into the ignored `data/backtest/minute` directory. It writes `data/backtest/manifest.json` with the snapshot timestamp, source endpoints, row counts, and SHA256 for every artifact. `backtest:verify-data -- --strict` is the release gate for a future complete artifact and requires verified 1m execution data.

## Formal dataset build

The formal dataset builder uses the Binance Data Vision monthly archive index for the historical symbol set, not the current exchangeInfo response. It discovers bare USDT perpetual archive symbols and then records the actual archive keys/months returned for each symbol; the global `2021-01` through snapshot month list is never used as lifecycle evidence. Current exchangeInfo is only a lifecycle cross-check. The builder downloads monthly 1h klines, monthly 1m klines, and monthly funding events, verifies each source zip against its sibling `.CHECKSUM`, and writes resumable `.part` files plus `data/backtest/source/archive-index.json` and `data/backtest/source/current-exchangeInfo.json` as source evidence. Batched PowerShell discovery avoids one process per symbol, and the archive index is reused on resume when its snapshot matches. If a transient exchangeInfo JSON response is empty/unparseable during resume, the builder retries and then reuses the existing hashed exchangeInfo evidence instead of rewriting it. The default snapshot is the first UTC day of the current month, so the dataset ends at the last complete monthly archive; use an explicit UTC month boundary for reproducibility.

```powershell
npm run backtest:formal:discover -- --snapshot-end 2026-08-01T00:00:00Z
npm run backtest:formal -- --snapshot-end 2026-08-01T00:00:00Z --concurrency 16 --transform-concurrency 2 --rate-limit-ms 250
npm run backtest:verify-data -- --strict
```

The 1m formal artifacts are intentionally generated outside Git because a full 2021-to-snapshotEnd all-symbol dataset is large. The builder records source URLs, source checksum values, derived artifact hashes, row counts, lifecycle evidence, and a `quality-report.json` with core/expanded counts, historical-delisted counts, annual active counts, missing artifacts, rows, bytes, and verifier output. Download concurrency and CPU-bound ZIP/CSV/gzip transformation concurrency are separate controls; the latter uses bounded worker threads so the four-core development host is not limited to one synchronous transform. `--discover-only` creates the PIT archive-index/universe evidence without downloading candles; it is a discovery step, not a formal dataset.

Archive first/last kline observations identify symbols that existed historically, but they do not by themselves prove exact listing or delist timestamps. Each market record exposes `actualFirstArchiveMonth`, `actualLastArchiveMonth`, `firstObserved`, `lastObserved`, `listingEvidenceSource`, `delistEvidenceSource`, and `lifecycleExact`. Unless an external historical lifecycle evidence file supplies timestamped listing/onboard and delist/delivery evidence for every archive-only market, the manifest keeps `pointInTime=false` and `historicalDelistingsResolved=false`; inferred archive windows remain explicitly non-PIT. A failed strict gate blocks any formal OOS run; this phase does not tune parameters or report profitability.

Funding archives are event streams. The real Binance CSV fields are mapped as `calc_time -> t`, `last_funding_rate -> rate`, and `funding_interval_hours -> fundingIntervalHours`; because the archive has no mark price, `markPrice` is `null`. Backtest funding PnL therefore uses its existing `priceAt` fallback and never treats the interval value as a price. Progress snapshots are serialized through an atomic temp-file/rename writer so concurrent workers cannot overwrite one another.

The formal harness defaults to `BACKTEST_SCAN_INTERVAL_HOURS=4`. A strategy signal is generated at a completed candle, then `decision_time = signal_time + 20 minutes`; `fill_time` must be at or after that decision time. With 1m artifacts, the fill is the first eligible 1m open. A formal run never silently substitutes an hourly open when 1m data is absent.

Each scan cycle collects every available market before performing one V7.5 global breakout dedupe/rank and one V8 global dedupe/rank; the production edge/event/day-volume ordering and three-per-side cap therefore apply across the whole cycle. Breadth remains CORE-only even when expanded markets are available as trade candidates. The downloader advances Binance pagination by the requested candle interval, and artifact verification checks both SHA256 and timestamp continuity.

Every market has its own point-in-time `eligibleStart`/`eligibleEnd`. Signal features and execution coverage are evaluated inside that lifecycle window, so a later listing or a historical delivery does not force every other market to fail formal execution. Before each delayed acceptance, the harness advances open positions to `decision_time` and applies the shared local/backtest acceptance contract: symbol-open, 72-hour cooldown, portfolio/side caps, fill-risk revalidation, tick rounding, step-size round-down, and minimum quantity.

The strict manifest gate requires per-market price/funding (and, for formal execution, minute) artifacts with `symbol`, `kind`, `interval`, `activeStart`, `activeEnd`, `rows`, and SHA256, plus row-count, continuity, active-window, point-in-time-universe, delisting, and expanded-universe checks. Funding is verified as a monotonic event stream: artifact-level observed `fundingIntervalHours` is preferred, while the manifest's explicit documented 8-hour fallback is used only when metadata is absent; an event at `activeStart` is not required. An empty or short artifact cannot make M4 complete; the checked-in manifest intentionally remains `M4-INCOMPLETE`.

For the already available local research cache, use the explicitly named smoke command:

```powershell
npm run backtest:smoke
```

That command is intentionally the only path that reads the legacy workspace caches. It explicitly enables the 1h execution proxy, writes `executionProxy=true`, and records `smoke backtest (M4 INCOMPLETE)` plus the proxy provenance. It is not a formal execution result.

The report contains separate `requiredAlphaCoverage` and dynamically observed `observedAlphaCoverage` fields. Only signals/trades generated by that run contribute to `observedAlphaCoverage`; fixed BTC/ETH/SOL/BNB/XRP smoke data must not be presented as observed non-core short Alpha coverage.

Both control and shadow harnesses include the production Alpha families in code: daily breakout long, funding crowding short, volume shock short, and V8 bear trend short. A formal V7.5 vs V8 result remains blocked until the manifest contains a point-in-time universe with historical delistings resolved, the expanded/non-core artifacts, 4h cadence, 20-minute decision/fill latency with 1m execution, fees/funding/cost, sufficient OOS sample, and observed/validated required Alpha coverage. Until then, no report may call itself complete V7.5 Control OOS or claim V8 superiority.

Lookahead controls are part of the implementation: only completed hourly/4h bars enter a scan, fills use the first eligible 1m open after the 20-minute decision (or the explicitly labeled smoke 1h proxy), executable targets are recomputed from the fill and original stop, formal settlement uses the first touch across completed 1m candles after fill (SL wins only when TP and SL occur in the same minute), and funding events are cut at fill/exit time.
