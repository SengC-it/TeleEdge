# V9 Derivatives Data Availability

Inventory only; no strategy optimization or Holdout was run.

- Development window: 2024-01-01T00:00:00.000Z through 2026-01-01T00:00:00.000Z
- Requested universe: 388; deterministic selection: 150; hash: ec12cd57cca7022ed6c8f2c26a10ff34424a8513fbd6be091bdb359c06dc9b43
- M4 status: **M4-INCOMPLETE**

| ID | Source | Available | Interval | Historical start | Historical end | Symbols | Public/no-auth | Archive/API | Complete | Used | Status/reason |
|---|---|---|---|---|---|---:|---|---|---|---|---|
| A | USD-M futures kline taker-buy volume | yes | 1h | 2024-01-01T00:00:00.000Z | 2026-01-01T00:00:00.000Z | 128/150 | yes | Binance Data Vision monthly/daily archive | no | yes | FLOW and cross-sectional feature input |
| B | USD-M aggTrades / public trades | yes | event | — | — | 0/150 | yes | Binance Data Vision archive | no | no | public source exists; not downloaded because no preregistered V9 feature requires it |
| C | USD-M premium index klines | yes | 1h | 2024-01-01T00:00:00.000Z | 2026-01-01T00:00:00.000Z | 128/150 | yes | Binance Data Vision monthly/daily archive | no | yes | PREMIUM_DISLOCATION input |
| D | USD-M mark price klines | yes | 1h | 2024-01-01T00:00:00.000Z | 2026-01-01T00:00:00.000Z | 128/150 | yes | Binance Data Vision monthly/daily archive | no | yes | mark/index spread input |
| E | USD-M index price klines | yes | 1h | 2024-01-01T00:00:00.000Z | 2026-01-01T00:00:00.000Z | 127/150 | yes | Binance Data Vision monthly/daily archive | no | yes | mark/index spread input |
| F | USD-M funding history | yes | event | 2024-01-01T00:00:00.000Z | 2026-01-01T00:00:00.000Z | 128/150 | yes | Binance Data Vision archive / normalized local artifact | no | yes | funding feature and execution cost model |
| G | Historical open interest | no | 5m/recent-only | — | — | 0/150 | yes | Binance public market-data API | no | no | no reliable 2024-2025 public history; OI family fail-closed |
| H | Global long/short ratio | no | 5m/recent-only | — | — | 0/150 | yes | Binance public market-data API | no | no | no reliable 2024-2025 public history; no proxy |
| I | Top trader long/short ratio | no | 5m/recent-only | — | — | 0/150 | yes | Binance public market-data API | no | no | no reliable 2024-2025 public history; no proxy |
| J | Taker long/short ratio | no | 5m/recent-only | — | — | 0/150 | yes | Binance public market-data API | no | no | no reliable 2024-2025 public history; no proxy |

## Explicit non-proxy boundary

Historical open interest and long/short ratio endpoints were observed to be recent-only for this window. They are marked unavailable; no current-value proxy is substituted. Data availability alone does not make the inherited M4 dataset point-in-time complete.
