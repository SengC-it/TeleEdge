# TeleEdge backtest data and scope

`reports/teleedge-oos-backtest.*` is currently a **smoke/backtest sanity check** and is explicitly marked `M4-INCOMPLETE`. It is not a complete V7.5 Control OOS report: the five-symbol fixed sample does not establish the expanded/non-core funding-crowding and volume-shock universe, nor does it remove historical delisting/survivorship bias.

The clean-clone workflow has no dependency on `../v38_price_cache`, `../v38_funding_cache`, or `../v60_full_universe_cache`:

```powershell
npm run backtest:fetch -- --symbols BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT
npm run backtest:verify-data
npm run backtest
```

`backtest:fetch` downloads point-in-time bounded 1h klines, funding events, and an exchange-info snapshot into the ignored `data/backtest/price` and `data/backtest/funding` artifact directories. It writes `data/backtest/manifest.json` with the snapshot timestamp, source endpoints, row counts, and SHA256 for every artifact. `backtest:verify-data -- --strict` is the release gate for a future complete artifact.

For the already available local research cache, use the explicitly named smoke command:

```powershell
npm run backtest:smoke
```

That command is intentionally the only path that reads the legacy workspace caches. It writes the report as `smoke backtest (M4 INCOMPLETE)` and records the external-cache provenance.

Both control and shadow harnesses include the production Alpha families in code: daily breakout long, funding crowding short, volume shock short, and V8 bear trend short. A formal V7.5 vs V8 result remains blocked until the manifest contains a point-in-time universe with historical delistings resolved and the expanded/non-core artifacts are present. Until then, no report may call itself complete V7.5 Control OOS or claim V8 superiority.

Lookahead controls are part of the implementation: only completed hourly bars enter a scan, fills use the first post-signal hourly open, executable targets are recomputed from the fill and original stop, settlement is completed-bar-only with SL priority, and funding events are cut at fill/exit time.
