# TeleEdge — V7.5 paper deployment

This is the production-shaped, paper-only implementation of the frozen
`cap10_risk60_same3` research variant. It does not contain Binance API keys and
cannot submit real orders.

## Frozen trading rules

- Binance USD-M USDT perpetual universe, current `TRADING` contracts.
- Long engine: confirmed daily close, 5/10/20-day trend breakouts, 2R target.
  The 180-day listing-age and 30-day average quote-volume filters apply here.
- Short engines: confirmed 4h close, development-qualified funding-crowding and
  volume-shock reversal segments, 1.5R or 2R selected by the frozen edge score.
  To reproduce the validated model, shorts require 200 completed 4h bars and
  at least 20m USDT rolling 24h volume; the 180-day long filter is not added.
- Portfolio: at most 10 positions, 8 per side, 3 signals per timestamp/side,
  0.6% equity risk per entry, and 72h same-symbol cooldown after exit.
- TP/SL first touch settles the trade. If both occur in one 1m candle, SL wins.
  If neither occurs, the position remains open indefinitely.
- Paper P&L includes observed public funding rates and the 0.15% round-trip
  stress cost used by the research selector.

## Services

- `Tele-Signal`: scans completed candles, selects/ranks signals, sizes paper
  positions, and writes an entry notification.
- `Tele-Alerts`: checks open positions every minute and emits the first TP/SL
  settlement notification.
- Durable state: `runtime/state.json`.
- Audit log: `runtime/events.ndjson`.
- Notification queue: `runtime/outbox.ndjson`; set `NOTIFY_WEBHOOK_URL` to also
  POST every message to an external delivery service.
- Health: `http://127.0.0.1:8787/health`.
- Status/positions: `http://127.0.0.1:8787/status`.

## Commands

```powershell
npm test
npm run check
powershell -ExecutionPolicy Bypass -File scripts/scan-paper.ps1
powershell -ExecutionPolicy Bypass -File scripts/start-paper.ps1
powershell -ExecutionPolicy Bypass -File scripts/stop-paper.ps1
```

Copy `.env.example` to `.env` only when changing defaults. Keep `TELE_OFFLINE=0`
for the deployed paper service. The first full-universe scan can take several
minutes because it incrementally refreshes public Binance candles and funding.

## Promotion gate

Do not connect live order execution to this service. Run it as paper trading for
at least 8–12 weeks and compare signal timestamps, fills, costs, funding, PF,
drawdown, and frequency with the frozen research expectations. A future live
executor should be a separate, explicitly approved component with hard account
and kill-switch controls.
