# Observed PIT Event / Regime Development

Final decision: **EVENT_RESEARCH_FAIL**

No strategy thresholds, event families, Production code, scheduler, secrets, or Holdout were changed. The five event families and KEEP gates are frozen from PR #8.

## Pipeline

Data Vision archive union → observed PIT membership at each completed 4h timestamp → feature-only points → frozen event detector → canonical 72h outcomes → exact controls → six-fold event-end purge/evaluation.

Outcome contract: {"decisionLatencyMinutes":20,"executionInterval":"1m","targetR":2,"verticalBarrierHours":72,"sameMinuteTpSl":"SL","noInterpolation":true,"researchOnly":true}

## Family results

| Family | Status | Raw | Independent | Executable | PF | Expectancy R | Control uplift R |
|---|---|---:|---:|---:|---:|---:|---:|
| BREADTH_REGIME_TRANSITION | REJECT | 112 | 95 | 74 | 0.8897024333220311 | -0.04405320202701042 | -0.24984631611890168 |
| MARKET_VOLATILITY_SHOCK | WATCH | 0 | 0 | 0 | — | — | — |
| DISPERSION_ROTATION | WATCH | 0 | 0 | 0 | — | — | — |
| LEVERAGE_STRESS_TRANSITION | WATCH | 0 | 0 | 0 | — | — | — |
| TREND_REGIME_TRANSITION | REJECT | 97 | 84 | 60 | 0.8992544239112994 | -0.04417962649142935 | 0.2894508784280678 |

## Gate and audits

- Observed PIT gate: **OBSERVED_PIT_READY**
- Total KEEP / STRONG_KEEP: 0 / 0
- Event/month: 7.458333333333333 (median 8)
- Controls: matched 184; unmatched 25; no reuse true
- Six-fold audit: PASS
- PIT invariant audit: true
- Announcement mismatch diagnostics: {"hardGate":false,"disagreementCount":null,"spotFuturesAmbiguityCount":null,"archiveAnnouncementMismatch":null,"spotFalseEvidenceRejected":true}
- Missing-data sensitivity: COMPUTED
- Holdout: **NOT RUN**

## Final interpretation

Event results are research diagnostics only; no Production promotion is implied.

## Provenance

- Event engine SHA-256: 9857c3e5ea6435b4165da65650f50b6f0781cecd6430a6663a75d9cce26aefdf
- Frozen event configuration SHA-256: 1a691b6eab065b6493cf7f4a6279f3a9d69306bd07471c355107380888369ba8
- Dataset manifest SHA-256: 79d4f0623b6a9cbdbbf756c3a71a2c3ab224d6d26457d5e5101e72bdd4342a3a
