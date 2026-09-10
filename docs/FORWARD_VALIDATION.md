# Frozen Forward Validation Phase 1

This phase adds production-ready, signal-only infrastructure. It does not activate a run, apply the migration, deploy functions/Vercel, change V7.5/V8 logic, or connect to a private exchange API.

The only valid initial lifecycle is `PREPARED`. An explicit authenticated activation creates `startedAt` and `minimumEndAt = startedAt + 90 days`. Signals are rejected as historical backfill when observed before activation. The final evaluation requires both at least 90 days and at least 50 combined independent closed system-paper signals.

System Paper Ledger and Manual Decision Ledger are separate. Manual `SKIPPED`, `TAKEN`, and `WATCHED` records may be corrected only with an audit trail and never change system-paper outcomes or metrics. Open outcomes count as signals/open trades but never enter PF, expectancy, win rate, or realized PnL.

V7.5 remains `CONTROL`; V8 remains `SHADOW / EXPERIMENTAL`. A deterministic signal key makes retries idempotent. A shared overlap group combines the same symbol/side/signal-time opportunity while retaining both strategy rows. A 72-hour symbol/side refractory period prevents repeated opportunities from inflating the independent sample.

The additive migration is intentionally not applied in Phase 1. Future activation must verify the freeze manifest, apply the migration, deploy the reviewed build, smoke-test the read/write contracts, and confirm the no-order audit before starting a run.
