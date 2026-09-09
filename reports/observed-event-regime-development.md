# Observed PIT Event / Regime Development

Final decision: **OBSERVED_PIT_DATA_BLOCKED**

No strategy thresholds, event families, Production code, scheduler, secrets, or Holdout were changed. The five event families and KEEP gates are frozen from PR #8.

## Pipeline

Data Vision archive union → observed PIT membership at each completed 4h timestamp → feature-only points → frozen event detector → canonical 72h outcomes → exact controls → six-fold event-end purge/evaluation.

Outcome contract: {"decisionLatencyMinutes":20,"executionInterval":"1m","targetR":2,"verticalBarrierHours":72,"sameMinuteTpSl":"SL","noInterpolation":true,"researchOnly":true}

## Family results

| Family | Status | Raw | Independent | Executable | PF | Expectancy R | Control uplift R |
|---|---|---:|---:|---:|---:|---:|---:|
| BREADTH_REGIME_TRANSITION | NOT_RUN_OBSERVED_PIT_DATA_BLOCKED | — | — | — | — | — | — |
| MARKET_VOLATILITY_SHOCK | NOT_RUN_OBSERVED_PIT_DATA_BLOCKED | — | — | — | — | — | — |
| DISPERSION_ROTATION | NOT_RUN_OBSERVED_PIT_DATA_BLOCKED | — | — | — | — | — | — |
| LEVERAGE_STRESS_TRANSITION | NOT_RUN_OBSERVED_PIT_DATA_BLOCKED | — | — | — | — | — | — |
| TREND_REGIME_TRANSITION | NOT_RUN_OBSERVED_PIT_DATA_BLOCKED | — | — | — | — | — | — |

## Gate and audits

- Observed PIT gate: **OBSERVED_PIT_DATA_BLOCKED**
- Total KEEP / STRONG_KEEP: 0 / 0
- Event/month: — (median —)
- Controls: matched —; unmatched —; no reuse true
- Six-fold audit: NOT_RUN
- PIT invariant audit: true
- Announcement mismatch diagnostics: {"hardGate":false,"disagreementCount":null,"spotFuturesAmbiguityCount":null,"archiveAnnouncementMismatch":null,"spotFalseEvidenceRejected":true}
- Missing-data sensitivity: NOT_RUN_OBSERVED_PIT_DATA_BLOCKED
- Holdout: **NOT RUN**

## Final interpretation

Formal event metrics were not run because the observed PIT data gate failed; no profitability conclusion is made.

## Provenance

- Event engine SHA-256: 1682df2ff2018ce0fa5a5102acf4d1b604a60ba71d3d32becc059928d2fffb22
- Frozen event configuration SHA-256: 1a691b6eab065b6493cf7f4a6279f3a9d69306bd07471c355107380888369ba8
- Dataset manifest SHA-256: 79d4f0623b6a9cbdbbf756c3a71a2c3ab224d6d26457d5e5101e72bdd4342a3a

## Fold and path diagnostics

- Derivative-ready min / mean / median: 112 / 166.90264477884176 / 163
- Leverage-valid snapshots: 4386

### BREADTH_REGIME_TRANSITION

- Fold metrics: []
- Sample folds / positive expectancy folds: — / —
- MFE: null
- MAE: null

### MARKET_VOLATILITY_SHOCK

- Fold metrics: []
- Sample folds / positive expectancy folds: — / —
- MFE: null
- MAE: null

### DISPERSION_ROTATION

- Fold metrics: []
- Sample folds / positive expectancy folds: — / —
- MFE: null
- MAE: null

### LEVERAGE_STRESS_TRANSITION

- Fold metrics: []
- Sample folds / positive expectancy folds: — / —
- MFE: null
- MAE: null

### TREND_REGIME_TRANSITION

- Fold metrics: []
- Sample folds / positive expectancy folds: — / —
- MFE: null
- MAE: null
