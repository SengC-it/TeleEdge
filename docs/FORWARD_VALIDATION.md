# Frozen Forward Validation

This branch wires the prepared forward-validation ledger to the accepted
V7.5 control and V8 shadow advisory paths. It does not activate a run, apply
the migration, deploy a function, deploy Vercel, or submit an order.

## Freeze boundary

`v75StrategySha256` and `v8StrategySha256` include the production worker
runtime dependencies used by their respective paths. `productionWorkerSha256`
is the digest of the complete `supabase/functions/teleeg-worker` runtime.
While the run is ACTIVE, a hash mismatch invalidates that run as
`STRATEGY_MUTATION`.

The only permitted worker changes in this wiring are the explicit
`forward-validation.mjs` bridge and its call sites in `index.ts`. A semantic
projection of `index.ts` is compared with `main`; strategy, risk, ranking,
acceptance, fill-risk, settlement, funding, and cost files remain frozen.

## Production adapter and lifecycle

The adapter maps the existing V7.5 candidate/position and V8 shadow
candidate/position shapes into the forward contract. It records only after an
accepted paper advisory and only when a run is `ACTIVE`; `PREPARED` is inert.
Signals are persisted through retry-safe RPCs with a shared 72-hour
`symbol + side` refractory domain. V7.5 and V8 keep separate signal/outcome
rows, while `overlap_group_id` and `independent_id` identify one opportunity
for combined metrics. Outcomes are recorded after the existing paper
settlement path closes a position; no second settlement algorithm is added.

Forward logging is best effort: a persistence timeout or duplicate retry is
observable but cannot suppress an accepted advisory, email eligibility, or
paper workflow. Historic backfill is rejected when either `observedAt` or
`signalTime` precedes the active run start.

## Database deployment gate

Migration `20260910100000_teleeg_frozen_forward_validation.sql` is additive and
prepared-only. It adds guarded service-role RPCs for active-run status,
strategy-hash and time-boundary checks, deterministic dedupe, 72-hour
independence, and open-to-closed outcome idempotency. It has **not** been
applied in this research change.

## API and dashboard

The admin API accepts both Fetch `Headers` and Node/Vercel header objects. Its
GET response exposes `manualDecisions` separately from system-paper outcomes.
The dashboard remains read-only and shows only persisted forward-validation
data.

This phase adds production-ready, signal-only infrastructure. It does not activate a run, apply the migration, deploy functions/Vercel, change V7.5/V8 logic, or connect to a private exchange API.

The only valid initial lifecycle is `PREPARED`. An explicit authenticated activation creates `startedAt` and `minimumEndAt = startedAt + 90 days`. Signals are rejected as historical backfill when observed before activation. The final evaluation requires both at least 90 days and at least 50 combined independent closed system-paper signals.

System Paper Ledger and Manual Decision Ledger are separate. Manual `SKIPPED`, `TAKEN`, and `WATCHED` records may be corrected only with an audit trail and never change system-paper outcomes or metrics. Open outcomes count as signals/open trades but never enter PF, expectancy, win rate, or realized PnL.

V7.5 remains `CONTROL`; V8 remains `SHADOW / EXPERIMENTAL`. A deterministic signal key makes retries idempotent. A shared overlap group combines the same symbol/side/signal-time opportunity while retaining both strategy rows. A 72-hour symbol/side refractory period prevents repeated opportunities from inflating the independent sample.

The additive migration is intentionally not applied in Phase 1. Future activation must verify the freeze manifest, apply the migration, deploy the reviewed build, smoke-test the read/write contracts, and confirm the no-order audit before starting a run.
