# V8 Shadow

V8 is a paper-shadow research namespace. It runs on the same completed market data batch as V7.5, but its signal IDs, positions, equity, monitoring, and database tables are separate. It never calls the V7.5 acceptance RPC and never creates a notification outbox row.

The initial alpha labels are:

- `bull`: trend/breakout long candidates;
- `bear`: liquid/core trend short candidates under a BTC bear regime;
- `reversal`: the existing funding-crowding and volume-shock reversal families, namespaced for shadow comparison.

The bear thresholds in `src/config.mjs` and the corresponding cloud module are research starting points only. They are not an assertion that the parameters are optimal, and V8 must not replace V7.5 until the train → validation → walk-forward OOS report shows a statistically credible net-of-cost improvement.

Local V8 state lives under `state.v8Shadow`. Cloud state uses `teleeg_v8_shadow_account`, `teleeg_v8_shadow_signals`, and `teleeg_v8_shadow_positions`. The V7.5 `teleeg_account`, `teleeg_candidates`, `teleeg_positions`, and `teleeg_outbox` tables are not reused.
