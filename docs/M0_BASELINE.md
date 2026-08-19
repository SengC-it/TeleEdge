# TeleEdge M0 baseline

Date: 2026-08-19

## Repository baseline

- Repository: `SengC-it/TeleEdge`
- Base commit: `b4aaaf7` (`Simplify dashboard wording in Chinese`)
- Control model declared by the repository: `V7.5-cap10-risk60-same3`
- Mode: paper only; no exchange order submission path is present.

## Local validation

```text
npm test   # 11 passed, 0 failed
npm run check   # passed
```

The existing regression suite already covers SL priority for same-minute TP/SL, completed cloud confirmation bars, ranking capacity, and the frozen short selector.

## Findings requiring this iteration

1. `src/portfolio.mjs` groups ranking only by `timestamp + side`; 5D/10D/20D breakout rows for one market can consume multiple ranking slots.
2. `src/service.mjs` creates paper positions with `signalTime` as both the opening/fill clock and the first monitor clock. The reference signal close is therefore treated as an executable fill.
3. `src/binance.mjs::fetchMinuteRange` and the cloud `minuteBars` path do not independently filter incomplete 1m candles before TP/SL evaluation.
4. `teleeg_positions` is the durable trade record, but the repository has no `teleeg-reviews` Edge Function. The dashboard currently exposes aggregate public status only.
5. Cloud mail delivery calls the Vercel production URL without a Vercel Deployment Protection bypass header. A protected deployment can return 401 before `api/send-mail.mjs` runs.
6. Scan summaries contain totals but no stage-level funnel keyed by family, side, regime, symbol/tier, and rejection reason.
7. V7.5 is the only runtime strategy/state namespace. There is no V8 shadow state or reproducible in-repository OOS report.

## Production evidence checked

- Vercel project `teleedge` latest production deployment was `READY`.
- A GET to `/api/send-mail` reached the function and returned its expected `405 method-not-allowed`; the reported 401 is therefore specific to protected server-to-server POST delivery, not a missing route.
- Vercel runtime-error query for `/api/send-mail` returned no retained errors in the available seven-day window, so the historical 401 cannot be reconstructed from retained logs.

This file is a control record only. It is not a claim that V7.5 is profitable; no valid OOS performance claim is made from this baseline.
