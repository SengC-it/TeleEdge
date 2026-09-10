# TeleEdge Frozen Forward Validation Runbook

Status: **PREPARED only**. Phase 1 does not activate a run, apply a migration, or deploy a function/Vercel.

## Future authorized launch

1. Apply the additive forward-validation migration.
2. Deploy the reviewed application/functions and run the smoke checks.
3. Verify `v75StrategySha256`, `v8StrategySha256`, and `strategyFreezeManifestSha256` against the freeze manifest.
4. Create a `PREPARED` run with the deployment reference.
5. Use an explicit authenticated activation operation; record `startedAt`.
6. Begin immutable signal collection. Only observations at or after `startedAt` are eligible; historical backfill is rejected.

## Lifecycle and invalidation

Runs move PREPARED → ACTIVE → COMPLETED only through explicit operations. A strategy fingerprint change while ACTIVE invalidates the run with `STRATEGY_MUTATION`; its sample is never mixed with a new run. Data-integrity failures invalidate or block evaluation.

## Evaluation

The final evaluation requires both 90 elapsed days and 50 combined independent closed signals. Open paper positions, manual decisions, history/backtest results, and invalid-quality signals are excluded from PF, expectancy, win rate, and realized PnL. The final gate requires PF ≥ 1.35, expectancy ≥ +0.15R, positive net PnL, max DD ≤ 6%, at least 10 unique symbols, unchanged hashes, and no data-integrity failure. Before both minimums, the verdict is `INSUFFICIENT_FORWARD_SAMPLE`; no PASS/FAIL/GO/STOP is shown.

## Evidence export

Research/admin export contains the run manifest, immutable signals, system-paper outcomes, metrics, manual decision ledger, and audit history. Manual ledger edits never change system-paper results.
