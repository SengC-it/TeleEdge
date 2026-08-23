# SHADOW GO

## Final Signal Validation

**SHADOW GO**

- OOS window: 2025-01-01T00:00:00.000Z → 2026-07-15T00:00:00.000Z
- Universe: 388 clean eligible symbols; validation used 100 deterministic active-duration-stratified symbols
- Execution layer: 4h production scan cadence; 20-minute decision latency; 1m executable fill; executionProxy=false; 1m chronological first-touch; same-minute TP+SL => SL
- Signal-level 1m loading: lazy by symbol after a signal; no minimum-minute-row selection

| Model | Raw candidates | Ranked signals | Unique alerts | Sim accepted | Closed trades | Unique signal symbols | Expectancy R | PF | DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| V7.5 Control | 36 | 24 | 24 | 0 | 0 | 16 | n/a | n/a | 0.0000% |
| V8 Shadow | 32 | 32 | 32 | 24 | 24 | 17 | 0.8762 | 3.5791 | 1.7045% |

## Required headline metrics

- V7.5 signal count: **24**
- V8 signal count: **32**
- Combined unique signal count: **32**
- Signal increase: **33.3333%**
- V7.5 24h directional edge: **0.0181**
- V8 24h directional edge: **0.0143**
- V7.5 TP-first-SL: **71.4286%**
- V8 TP-first-SL: **66.6667%**

| Model | 24h directional edge | TP-first-SL | Sim expectancy R | PF | DD |
|---|---:|---:|---:|---:|---:|
| V7.5 Control | 0.0181 | 71.4286% | n/a | n/a | 0.0000% |
| V8 Shadow | 0.0143 | 66.6667% | 0.8762 | 3.5791 | 1.7045% |

## Signal increment

- V7.5-only alerts: 0
- V8-only alerts: 8
- Overlap alerts: 24
- Combined unique alerts: 32

## Signal quality

- Every ranked OOS alert is one observation. Directional return is positive when the future move agrees with the signal side.
- Full signal observations and dimension breakdowns are stored in the JSON report.
- V8 12h edge CI: [0.0007, 0.0197]; 24h edge CI: [-0.0075, 0.0361]

## Trade-level diagnostics

- V8 unique traded symbols: 16
- V8 CVaR95 net R: -1.0481
- V8 monthly rows: 10
- Trade records, top-five symbol/trade contributions, largest losses and monthly results are included in JSON.

## Reproducibility

- Repository commit SHA: `ef0ee30550d5225be646ae1c443098248c32da75`
- Strategy commit SHA: `003b931fe1ad576a3d42858f18c5fb9a19d58ae9`
- Runner SHA256: `378dfcc36d08ef36da3d78e02a4214c822d9952588c701315d1844b14dd0ffa3`
- Config SHA256: `fdc4433881eafbc383795df9602b667d1f9b8033ef0d8f3c96e0d6814eb96dd8`
- Manifest SHA256: `79d4f0623b6a9cbdbbf756c3a71a2c3ab224d6d26457d5e5101e72bdd4342a3a`
- Pre-run working tree dirty: **false**
- Generated report files are the only expected post-run working-tree changes and are committed separately.

## M4 boundary

- M4 full strict dataset remains INCOMPLETE research backlog and is not required for this signal-only gate.
- Current M4 strict result: incomplete; continuity failures 120; coverage failures 698.

## Signal Production Release Checklist

- V7.5 Control signal pipeline: **PASS** — frozen candidate generation and state-isolation tests pass
- V8 Shadow signal pipeline: **PASS** — frozen V8 shadow namespace and state-isolation tests pass
- history / reviews / email / dashboard: **PASS** — existing contract tests pass
- real-money automatic order path: **PASS** — static audit found no Binance order endpoint; system remains signal-only
- production signal gate: **SHADOW** — manual approval required; no deployment performed

## Gate reasons (2)

- V8 signal observations=32 (<100)
- V8 unique signal symbols=17 (<20)

No merge and no deployment were performed. The system remains signal-only advisory; trading decisions remain manual.


