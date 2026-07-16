# TeleEdge

TeleEdge is the paper-only deployment of the frozen
`V7.5-cap10-risk60-same3` strategy. It scans the complete current Binance
USD-M USDT perpetual universe and never submits exchange orders.

## Production architecture

- Dashboard: [teleedge.vercel.app](https://teleedge.vercel.app)
- Durable state and scheduler: existing Supabase project `crypto-alerts`
- Edge worker: `teleeg-worker`
- Database isolation: every TeleEdge-owned table starts with `teleeg_`
- Notifications: durable `teleeg_outbox`; Gmail SMTP delivery runs through
  Vercel with the sender display name `TeleEdge`.

Supabase runs a market-context job every four hours, scans 12 staggered
full-universe shards, globally ranks the completed cycle, and monitors open
positions every minute. A Vault-held token authenticates database cron calls
to the Edge Function. Vercel only holds a public Supabase key and can read one
RLS-protected status row; it has no database administrator key.

## Frozen rules

- Long: confirmed daily close, 5/10/20-day breakout, 2R target.
- Short: confirmed 4h close, qualified funding-crowding and volume-shock
  reversal segments, selected 1.5R or 2R target.
- Portfolio: maximum 10 positions, 8 per side, 3 signals per timestamp/side,
  0.6% equity risk per entry, 72-hour symbol cooldown after exit.
- Settlement: TP/SL first touch. If both occur in one 1m candle, SL wins. If
  neither occurs, the position remains open with no time-based exit.
- Paper P&L includes public funding and a 0.15% round-trip stress cost.

## Repository layout

- `supabase/schema/teleeg.sql`: isolated cloud tables, RLS, portfolio RPCs.
- `supabase/schema/teleeg_cron.sql`: Vault authentication and schedules.
- `supabase/functions/teleeg-worker/`: cloud strategy and worker.
- `index.html`, `api/status.mjs`: Vercel status dashboard.
- `src/`: original local paper daemon retained for diagnostics.

## Verification

```powershell
npm test
npm run check
```

The initial production scan evaluated 524 contracts with zero market-data
errors. It produced no entry at that cycle because the BTC router was bearish
and core-market breadth was about 31.8%; no position was invented to make the
deployment appear active.

## Gmail SMTP

Set these server-only Vercel environment variables without committing them:

- `GMAIL_USER`
- `GMAIL_APP_PASSWORD`
- `TELEEDGE_EMAIL_TO` (optional; defaults to `GMAIL_USER`)

Messages use `smtp.gmail.com:465` and display the sender as
`TeleEdge <GMAIL_USER>`.

## Safety gate

Keep this project in paper mode for at least 8-12 weeks and compare live paper
signals, fills, funding, costs, profit factor, drawdown, and frequency with the
frozen validation. A future Binance executor must be a separate, explicitly
approved component with account-level limits and a kill switch.
