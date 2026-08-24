# TeleEdge pre-deployment contract

This document describes the Edge Function contract. This PR does not deploy either function or configure production secrets.

## Supabase JWT gateway settings

`supabase/config.toml` must contain:

```toml
[functions.teleeg-worker]
verify_jwt = false

[functions.teleeg-reviews]
verify_jwt = false
```

Both settings are intentional and independent:

- `teleeg-worker` is invoked by `pg_cron` with `x-teleeg-token`. The worker loads the stored SHA-256 hash, rejects a missing or incorrect token with `401`, and only then dispatches `context`, `scan`, `finalize`, `monitor`, or `mail`.
- `teleeg-reviews` is invoked by the Vercel server proxy with `x-teleeg-reviews-token`, validated against the server-only `TELEEDGE_REVIEWS_TOKEN` secret before any service-role query.

Neither function depends on a Supabase JWT. The two tokens are not interchangeable: the worker uses the Vault/cron token and its database hash; reviews uses the independent `TELEEDGE_REVIEWS_TOKEN`. Never copy either value into browser code, a public environment variable, a fixture, or the repository.

## Pre-deployment checks

1. Set the worker cron token through the existing Vault/cron setup so `teleeg_account.cron_token_hash` matches the value sent in `x-teleeg-token`.
2. Set the same randomly generated `TELEEDGE_REVIEWS_TOKEN` in the Vercel server environment and the `teleeg-reviews` Edge Function secret.
3. Run `npm test` and `npm run check`.
4. Verify worker requests with no token and an incorrect token return `401`; a correct worker token reaches the requested action. Verify that a reviews token does not authorize the worker and vice versa.
5. Confirm full funnel diagnostics remain in `teleeg_job_runs.summary.funnel`. The public `teleeg_public_status.last_scan_summary` is intentionally compact and excludes `byDimension`.
6. Apply the advisory-alert migration before enabling V8 notifications. It adds the shared `alert_key`, V8 position reference, source labels, and atomic outbox dedupe. A same-key V7.5/V8 acceptance creates one delivery item; V8-only items are labelled `V8 SHADOW / EXPERIMENTAL`.
7. Run `npm run preview:smoke`. This validates the V7.5 pipeline, V8 shadow pipeline, overlap dedupe, V8-only notification, email handoff, reviews, dashboard/status projection, Supabase read/write contract, and the no-order-path audit without contacting production.

No production deployment is part of this Draft PR acceptance round.
