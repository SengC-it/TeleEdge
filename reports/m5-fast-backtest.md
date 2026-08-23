# TeleEdge smoke backtest (M4 INCOMPLETE)

本报告由 `npm run backtest` 生成，数据快照时间为 2026-07-15T00:00:00.000Z。状态：**M4-INCOMPLETE**；仅用于研究，不构成盈利结论，也不改变 V7.5 paper 控制。

## OOS cohort（按 signal time）

| 模型 | Trades | Signals/月 | Win rate | Net expectancy (R) | Profit factor | Max drawdown | Funding PnL | Modeled costs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| V7.5 Control | 0 | 1.413 | —% | — | — | 0.0% | 0.00 | 0.00 |
| V8 Shadow | 7 | 0.870 | 57.1% | 0.637 | 2.369 | 1.4% | -14.66 | 6.05 |

V8 − V7.5 OOS expectancy: **0.637 R**；profit factor delta: **2.369**；max drawdown delta: **1.4 pp**。

## Walk-forward folds

| Fold | Model | Trades | Net expectancy (R) | Profit factor | Max drawdown |
|---|---|---:|---:|---:|---:|
| 2025 | V7.5 Control | 0 | — | — | 0.0% |
| 2026-H1 | V7.5 Control | 0 | — | — | 0.0% |
| 2025 | V8 Shadow | 5 | 0.095 | 1.146 | 1.4% |
| 2026-H1 | V8 Shadow | 2 | 1.992 | — | 0.0% |

## 设计与限制

- Scan cadence: 4h UTC windows；signal 后固定 20 分钟进入 decision，再取 decision_time 之后的可执行价格，禁止使用 signal close。
- Execution interval: 1m；executionProxy=false。正式数据缺少 1m 时不静默回退，只有显式 smoke proxy 才使用 1h。
- completed 1m bars; first touch by minute; SL priority when TP and SL occur in the same minute；资金费使用历史事件，缺少 mark price 时回退到事件前最近 1m close。
- V7.5 使用冻结 0.6% 风险；V8 使用独立 research allocator（edge/liquidity/volatility/portfolio correlation/drawdown/loss streak）。
- 当前样本为 50 个币种、437385 根 1h 价格记录和 93091 条资金费记录；这不是完整 V7.5 Control OOS。
- requiredAlphaCoverage: daily_breakout_long, funding_crowding_short, volume_shock_short, v8_bear_trend_short。observedAlphaCoverage（由实际 signals/trades 动态计算）：daily_breakout_long, v8_bear_trend_short, v8_daily_breakout_long。
- 固定五币种样本没有完成 expanded/non-core universe 和 point-in-time universe 验证；未观察到的 Alpha 不得称为已测试。
- 当前 exchangeInfo 快照无法证明没有历史退市 survivorship bias，结果不应外推到全市场。
- M4 INCOMPLETE：OOS 样本量不足（任一模型少于 30 笔），因此不报告统计显著的盈利或 V8 优越性结论。

## Splits

训练集：2021-01-01—2023-12-31；验证集：2024；walk-forward OOS：2025 及 2026-H1。参数在本次运行中没有用 OOS 调优。
