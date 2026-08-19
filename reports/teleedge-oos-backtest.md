# TeleEdge OOS backtest

本报告由 `npm run backtest` 生成，数据冻结在 2026-07-15T00:00:00.000Z。它只用于研究，不构成盈利结论，也不改变 V7.5 paper 控制。

## OOS cohort（按 signal time）

| 模型 | Trades | Signals/月 | Win rate | Net expectancy (R) | Profit factor | Max drawdown | Funding PnL | Modeled costs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| V7.5 Control | 15 | 3.750 | 40.0% | 0.150 | 1.237 | 3.1% | -29.42 | 15.92 |
| V8 Shadow | 20 | 2.228 | 50.0% | 0.459 | 1.876 | 2.4% | -17.34 | 14.78 |

V8 − V7.5 OOS expectancy: **0.310 R**；profit factor delta: **0.639**；max drawdown delta: **-0.8 pp**。

## Walk-forward folds

| Fold | Model | Trades | Net expectancy (R) | Profit factor | Max drawdown |
|---|---|---:|---:|---:|---:|
| 2025 | V7.5 Control | 15 | 0.150 | 1.237 | 3.1% |
| 2026-H1 | V7.5 Control | 0 | — | — | 0.0% |
| 2025 | V8 Shadow | 16 | 0.077 | 1.117 | 2.4% |
| 2026-H1 | V8 Shadow | 4 | 1.989 | — | 0.0% |

## 设计与限制

- 信号只读取 scan time 之前的完整 1h 数据；成交使用 signal 后第一根 1h 的开盘价，禁止使用 signal close 作为成交价。
- SL/TP 在完整 1h bar 上结算，若同一 bar 同时触发，SL 优先；资金费使用历史事件，缺少 mark price 时回退到事件前最近 1h close。
- V7.5 使用冻结 0.6% 风险；V8 使用独立 research allocator（edge/liquidity/volatility/portfolio correlation/drawdown/loss streak）。
- 这是固定五币种、日频扫描的研究样本；当前 exchangeInfo 快照无法证明没有历史退市 survivorship bias，结果不应外推到全市场。
- OOS 样本量不足（任一模型少于 30 笔），因此不报告统计显著的盈利或 V8 优越性结论。

## Splits

训练集：2021-01-01—2023-12-31；验证集：2024；walk-forward OOS：2025 及 2026-H1。参数在本次运行中没有用 OOS 调优。

