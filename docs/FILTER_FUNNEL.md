# Filter funnel telemetry

Every scan summary now carries a `funnel` object. Each stage has:

- `reached`: observations that reached the stage;
- `passed`: observations that passed it;
- `rejected`: observations rejected at it.

The stages are `universe`, `history_valid`, `liquidity_valid`, `regime_valid`, `trend_valid`, `funding_valid`, `trigger_valid`, `stop_valid`, `edge_valid`, `ranked`, and `accepted`.

`byDimension` uses the tuple `family | side | regime | symbol | tier`, so the same counters can be inspected by strategy family, direction, BTC regime, market, and core/expanded tier. `rejectionReasons` is the aggregate reason index. Stage totals are intentionally not expected to sum to one another: a later stage contains only observations that reached it.

The local service records each strategy gate directly. The Edge worker records shard-level history, candidate-family gate passes, ranking, acceptance, and data errors; the finalize job merges all successful shard summaries into the full `teleeg_job_runs.summary.funnel` diagnostic. The public `teleeg_public_status.last_scan_summary` is a compact projection containing only `stages`, top rejection reasons, candidate/accepted counts, and a V8 shadow summary; it intentionally excludes `byDimension`. A missing candidate is reported as `no_candidate` rather than silently becoming a zero-candidate scan.

Funnel counts are diagnostic telemetry, not a reason to relax thresholds. They must be read together with net-of-cost backtest results and OOS sample size.
