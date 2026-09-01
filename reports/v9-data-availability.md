# V9 Derivatives Data Availability

Inventory only; no strategy optimization or Holdout was run.

- Development window: 2024-01-01T00:00:00.000Z through 2026-01-01T00:00:00.000Z
- Requested universe: 388; deterministic selection: 150; hash: ec12cd57cca7022ed6c8f2c26a10ff34424a8513fbd6be091bdb359c06dc9b43
- M4 status: **M4-INCOMPLETE**

| ID | Source | Available | Interval | Historical start | Historical end | Symbols | Public/no-auth | Archive/API | Complete | Used | Status/reason |
|---|---|---|---|---|---|---:|---|---|---|---|---|
| A | USD-M futures kline taker-buy volume | yes | 1h | 2024-01-01T00:00:00.000Z | 2025-12-31T23:00:00.000Z | 128/150 | yes | Binance Data Vision monthly/daily archive | no | yes | FLOW and cross-sectional feature input |
| B | USD-M aggTrades / public trades | yes | event | — | — | 0/150 | yes | Binance Data Vision archive | no | no | public source exists; not downloaded because no preregistered V9 feature requires it |
| C | USD-M premium index klines | yes | 1h | 2024-01-01T00:00:00.000Z | 2025-12-31T23:00:00.000Z | 128/150 | yes | Binance Data Vision monthly/daily archive | no | yes | PREMIUM_DISLOCATION input |
| D | USD-M mark price klines | yes | 1h | 2024-01-01T00:00:00.000Z | 2025-12-31T23:00:00.000Z | 128/150 | yes | Binance Data Vision monthly/daily archive | no | yes | mark/index spread input |
| E | USD-M index price klines | yes | 1h | 2024-01-01T00:00:00.000Z | 2025-12-31T23:00:00.000Z | 127/150 | yes | Binance Data Vision monthly/daily archive | no | yes | mark/index spread input |
| F | USD-M funding history | yes | event | 2024-01-01T00:00:00.000Z | 2026-01-01T00:00:00.000Z | 128/150 | yes | Binance Data Vision archive / normalized local artifact | no | yes | funding feature and execution cost model |
| G | Historical open interest | yes | 5m | 2024-01-01T00:00:00.000Z | 2025-12-31T23:55:00.000Z | 128/150 | yes | Binance Data Vision daily metrics archive | no | yes | daily metrics archives incomplete for the selected universe |
| H | Global long/short ratio | yes | 5m | 2024-01-01T00:00:00.000Z | 2025-12-31T23:55:00.000Z | 128/150 | yes | Binance Data Vision daily metrics archive | no | yes | daily metrics archives incomplete for the selected universe |
| I | Top trader long/short ratio | yes | 5m | 2024-01-01T00:00:00.000Z | 2025-12-31T23:55:00.000Z | 128/150 | yes | Binance Data Vision daily metrics archive | no | yes | daily metrics archives incomplete for the selected universe |
| J | Taker long/short ratio | yes | 5m | 2024-01-01T00:00:00.000Z | 2025-12-31T23:55:00.000Z | 128/150 | yes | Binance Data Vision daily metrics archive | no | yes | daily metrics archives incomplete for the selected universe |

## Metrics contract

Historical open interest and long/short ratios are sourced from the official daily metrics archives when present. Each row is parsed with UTC timestamps and strict numeric validation; per-symbol 5m continuity and PIT coverage are recorded in the V9 manifest. Missing/gapped symbols remain unavailable and no current-value proxy or future interpolation is substituted. Metrics availability alone does not make the inherited M4 dataset point-in-time complete.
