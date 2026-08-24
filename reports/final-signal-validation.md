# SHADOW GO

## Production release validation boundary

- Production Release Status: **READY**
- M5 human gate: **SHADOW GO**; V8 remains Shadow and does not replace V7.5 Control.
- Corrective replay: **COMPLETED** with the same frozen OOS window, universe, cadence, latency, 1m fill/settlement and cost model.
- Release blocker: 

## Current persisted counts

| Model | Raw candidates | Ranked signals | Persisted accepted | Closed trades |
|---|---:|---:|---:|---:|
| V7.5 Control | 36 | 24 | 18 | 18 |
| V8 Shadow | 32 | 32 | 24 | 24 |

## V7.5 ranked rejection breakdown

- Audit status: **CORRECTIVE_REPLAY_VALIDATED**
- Corrective replay accounted for every ranked signal after the exchangeInfo loader fix. No invalid-market-tick rejection remains; the previous accepted=0 snapshot is retained only as invalidated audit history.
- Previous accepted=0 snapshot: **INVALIDATED_BY_LOADER_BUG**; it is not reused for current metrics.
- Category counts: {"fill unavailable":1,"slippage":0,"stop-risk":0,"cooldown":1,"position cap":0,"quantity/minQty":0,"symbol already open":4,"other":0}
- Raw reason counts: {"fill-stop-risk-out-of-bounds":1,"symbol-already-open":4,"symbol-cooldown":1}

| Signal ID | Symbol | Side | First failure | Category | Raw reason |
|---|---|---|---|---|---|
| 1MBABYDOGEUSDT\|v59_volume_shock_reversal\|short\|1753718400000 | 1MBABYDOGEUSDT | short | 2025-07-28T16:00:00.000Z | fill unavailable | fill-stop-risk-out-of-bounds |
| BNBUSDT\|v39_5d\|long\|1754697600000 | BNBUSDT | long | 2025-08-09T00:00:00.000Z | symbol already open | symbol-already-open |
| BNBUSDT\|v39_10d\|long\|1755043200000 | BNBUSDT | long | 2025-08-13T00:00:00.000Z | symbol already open | symbol-already-open |
| BNBUSDT\|v39_5d\|long\|1755734400000 | BNBUSDT | long | 2025-08-21T00:00:00.000Z | symbol already open | symbol-already-open |
| BNBUSDT\|v39_10d\|long\|1757808000000 | BNBUSDT | long | 2025-09-14T00:00:00.000Z | cooldown | symbol-cooldown |
| BNBUSDT\|v39_20d\|long\|1758153600000 | BNBUSDT | long | 2025-09-18T00:00:00.000Z | symbol already open | symbol-already-open |

## Notification stages

- candidate: V7.5=36, V8=32, user receipt=false
- ranked signal: V7.5=24, V8=32, user receipt=false
- accepted signal: V7.5=18, V8=24, user receipt=false
- notifiable alert: V7.5=18, V8=24, user receipt=true
- email sent: V7.5=n/a, V8=n/a, user receipt=true

- Ranked cross-model increment: V7.5-only=0, V8-only=8, overlap=24, combined=32, increase=33.3333%.
- Notifiable alert count from persisted accepted/trade evidence: V7.5=18, V8-only=7, overlap deduped=17, combined=25, actual increase=38.8889%.
- Email sent is not inferred from backtest acceptance; production delivery requires the outbox/mail run.

## Preview smoke

- V7.5 pipeline: **PASS**
- V8 Shadow pipeline: **PASS**
- overlap dedupe: **PASS**
- V8-only notification: **PASS**
- email/history/reviews/dashboard/status/Supabase contract: **PASS** in non-production preview smoke
- Binance order endpoint/createOrder/placeOrder/newOrder/live position write audit: **PASS**; signal-only advisory

M4 remains INCOMPLETE. No profitability conclusion is made. No merge and no deployment were performed.

