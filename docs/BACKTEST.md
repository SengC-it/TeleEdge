# TeleEdge reproducible backtest

Run from the repository root:

```powershell
npm run backtest
```

The harness reads the frozen `v38_price_cache` and `v38_funding_cache` files, caps the sample at `v60_full_universe_cache/snapshotEnd.json`, and writes:

- `reports/teleedge-oos-backtest.json`
- `reports/teleedge-oos-backtest.md`

The default sample uses BTC/ETH/SOL/BNB/XRP, daily UTC scans, 2021-01-01 through 2026-07-15, and three cohorts: 2021–2023 train, 2024 validation, and 2025–2026-H1 OOS. It also emits expanding-window 2025 and 2026-H1 walk-forward rows.

Lookahead controls are part of the implementation: only completed hourly bars enter a scan, fills use the first post-signal hourly open, settlement is completed-bar-only with SL priority, and funding events are cut at fill/exit time. The cache has no historical mark price for every funding event, so the backtest records and reports fallback to the latest completed hourly close.

V7.5 is the frozen 0.6%-risk control. V8 uses a separate research allocator. The allocator is not a production approval: it is explicitly exposed so edge, liquidity, volatility, correlated-risk, drawdown, and loss-streak rules can be tested without changing the V7.5 control.

The fixed universe is deliberately labeled as survivorship-limited because the available exchange-info snapshot cannot reconstruct historical delistings. A small sample or positive expectancy is not a release criterion; use the report’s confidence intervals and limitations before any further research.
