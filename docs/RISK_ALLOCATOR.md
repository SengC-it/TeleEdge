# Research risk allocator

`src/risk.mjs` and the cloud worker’s parity module are V8 research infrastructure. They do not replace the V7.5 control’s frozen `riskFraction: 0.006`.

For each V8 candidate, the allocator adjusts a base risk budget using:

- edge score, liquidity, and stop-distance volatility;
- total open portfolio risk and same-side/same-BTC-regime correlated risk;
- equity drawdown throttle and hard stop;
- consecutive-loss throttle and hard stop.

The selected risk is converted to quantity from the executable fill and stop distance. Every accepted V8 position stores the allocation metadata in its isolated state/table. The cloud worker uses the same scalar defaults and remains `paper-shadow`; it never calls the V7.5 acceptance RPC and never emits V7.5 mail.

These thresholds are research defaults, not calibrated production parameters. They must be re-estimated and validated on a survivorship-controlled walk-forward sample before any model change is considered.
