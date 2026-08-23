# SHADOW GO

## Production release validation boundary

- Production Release Status: **BLOCKED**
- M5 human gate: **SHADOW GO**; V8 remains Shadow and does not replace V7.5 Control.
- No formal OOS/backtest replay was run in this pass.
- Release blocker: The persisted V7.5 accepted=0 result was invalidated by the missing exchange-rule loader input. A fresh signal-validation replay is required after the loader fix before PR #1 can become Ready for Review.

## Current persisted counts

| Model | Raw candidates | Ranked signals | Persisted accepted | Closed trades |
|---|---:|---:|---:|---:|
| V7.5 Control | 36 | 24 | 0 | 0 |
| V8 Shadow | 32 | 32 | 24 | 24 |

## V7.5 ranked rejection breakdown

- Audit status: **INVALIDATED_BY_ACCEPTANCE_LOADER_BUG**
- The persisted validation run had no data/backtest exchangeInfo.json. marketFor() therefore supplied empty filters and the frozen acceptance contract rejected every ranked V7.5 signal at invalid-market-tick. The verified source snapshot exists, and the loader is now fixed; no formal replay was run in this M5 pass.
- Category counts: {"fill unavailable":0,"slippage":0,"stop-risk":0,"cooldown":0,"position cap":0,"quantity/minQty":0,"symbol already open":0,"other":24}
- Raw reason counts: {"invalid-market-tick":24}

| Signal ID | Symbol | Side | First failure | Category | Raw reason |
|---|---|---|---|---|---|
| 1000CATUSDT|v59_volume_shock_reversal|short|1769601600000 | 1000CATUSDT | short | 2026-01-28T12:00:00.000Z | other | invalid-market-tick |
| 1MBABYDOGEUSDT|v59_volume_shock_reversal|short|1753718400000 | 1MBABYDOGEUSDT | short | 2025-07-28T16:00:00.000Z | other | invalid-market-tick |
| ACTUSDT|v59_volume_shock_reversal|short|1742932800000 | ACTUSDT | short | 2025-03-25T20:00:00.000Z | other | invalid-market-tick |
| ACTUSDT|v59_volume_shock_reversal|short|1754884800000 | ACTUSDT | short | 2025-08-11T04:00:00.000Z | other | invalid-market-tick |
| ADAUSDT|v39_10d|long|1757808000000 | ADAUSDT | long | 2025-09-14T00:00:00.000Z | other | invalid-market-tick |
| AEROUSDT|v59_volume_shock_reversal|short|1757088000000 | AEROUSDT | short | 2025-09-05T16:00:00.000Z | other | invalid-market-tick |
| ALTUSDT|v59_volume_shock_reversal|short|1755057600000 | ALTUSDT | short | 2025-08-13T04:00:00.000Z | other | invalid-market-tick |
| AUCTIONUSDT|v59_volume_shock_reversal|short|1753718400000 | AUCTIONUSDT | short | 2025-07-28T16:00:00.000Z | other | invalid-market-tick |
| BCHUSDT|v39_5d|long|1754697600000 | BCHUSDT | long | 2025-08-09T00:00:00.000Z | other | invalid-market-tick |
| BIGTIMEUSDT|v59_volume_shock_reversal|short|1753084800000 | BIGTIMEUSDT | short | 2025-07-21T08:00:00.000Z | other | invalid-market-tick |
| BNBUSDT|v39_5d|long|1754611200000 | BNBUSDT | long | 2025-08-08T00:00:00.000Z | other | invalid-market-tick |
| BNBUSDT|v39_5d|long|1754697600000 | BNBUSDT | long | 2025-08-09T00:00:00.000Z | other | invalid-market-tick |
| BNBUSDT|v39_10d|long|1755043200000 | BNBUSDT | long | 2025-08-13T00:00:00.000Z | other | invalid-market-tick |
| BNBUSDT|v39_5d|long|1755734400000 | BNBUSDT | long | 2025-08-21T00:00:00.000Z | other | invalid-market-tick |
| BNBUSDT|v39_10d|long|1757808000000 | BNBUSDT | long | 2025-09-14T00:00:00.000Z | other | invalid-market-tick |
| BNBUSDT|v39_20d|long|1758067200000 | BNBUSDT | long | 2025-09-17T00:00:00.000Z | other | invalid-market-tick |
| BNBUSDT|v39_20d|long|1758153600000 | BNBUSDT | long | 2025-09-18T00:00:00.000Z | other | invalid-market-tick |
| BTCUSDT|v39_10d|long|1755129600000 | BTCUSDT | long | 2025-08-14T00:00:00.000Z | other | invalid-market-tick |
| CAKEUSDT|v59_volume_shock_reversal|short|1749672000000 | CAKEUSDT | short | 2025-06-11T20:00:00.000Z | other | invalid-market-tick |
| CAKEUSDT|v39_10d|long|1757721600000 | CAKEUSDT | long | 2025-09-13T00:00:00.000Z | other | invalid-market-tick |
| DOGEUSDT|v39_10d|long|1759795200000 | DOGEUSDT | long | 2025-10-07T00:00:00.000Z | other | invalid-market-tick |
| HANAUSDT|v59_volume_shock_reversal|short|1772884800000 | HANAUSDT | short | 2026-03-07T12:00:00.000Z | other | invalid-market-tick |
| PARTIUSDT|v59_volume_shock_reversal|short|1768363200000 | PARTIUSDT | short | 2026-01-14T04:00:00.000Z | other | invalid-market-tick |
| SCRUSDT|v59_volume_shock_reversal|short|1755028800000 | SCRUSDT | short | 2025-08-12T20:00:00.000Z | other | invalid-market-tick |

## Notification stages

- candidate: V7.5=36, V8=32, user receipt=false
- ranked signal: V7.5=24, V8=32, user receipt=false
- accepted signal: V7.5=0, V8=24, user receipt=false
- notifiable alert: V7.5=0, V8=24, user receipt=true
- email sent: V7.5=n/a, V8=n/a, user receipt=true

- Ranked cross-model increment: V7.5-only=0, V8-only=8, overlap=24, combined=32, increase=33.3333%.
- Notifiable alert count from persisted accepted/trade evidence: V7.5=0, V8-only=24, overlap deduped=0, combined=24, actual increase=n/a (V7.5 baseline is zero).
- Email sent is not inferred from backtest acceptance; production delivery requires the outbox/mail run.

## Preview smoke

- V7.5 pipeline: **PASS**
- V8 Shadow pipeline: **PASS**
- overlap dedupe: **PASS**
- V8-only notification: **PASS**
- email/history/reviews/dashboard/status/Supabase contract: **PASS** in non-production preview smoke
- Binance order endpoint/createOrder/placeOrder/newOrder/live position write audit: **PASS**; signal-only advisory

M4 remains INCOMPLETE. No profitability conclusion is made. No merge and no deployment were performed.
