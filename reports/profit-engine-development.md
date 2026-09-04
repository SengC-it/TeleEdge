# TeleEdge Profit Research Engine R1–R3

Status: **RESEARCH_FAIL**. Research-only Development; Holdout was not run and Production was not changed.

## Boundary and provenance

- Development: 2024-01-01T00:00:00.000Z → 2026-01-01T00:00:00.000Z (end exclusive)
- Holdout: **BLOCKED_RESEARCH_FAIL** (2026-01-01T00:00:00.000Z → 2026-07-15T00:00:00.000Z)
- Universe: 150 symbols (37 core / 113 expanded), hash ec12cd57cca7022ed6c8f2c26a10ff34424a8513fbd6be091bdb359c06dc9b43
- M4: **M4-INCOMPLETE**; PIT usable symbols: 126
- Execution: 4h signal cadence; 20m decision latency; 1m fill/settlement; same-minute TP+SL=SL; executionProxy=false
- No-order audit: PASS; Production isolation: PASS

## Proposal and canonical outcome counts

| Layer | Count |
|---|---:|
| Raw primitive triggers | 633262 |
| V8 baseline proposals | 74 |
| Raw proposals | 633336 |
| Merged proposals | 385638 |
| Independent proposals | 29724 |
| Canonical executable outcomes | 22072 |
| Vertical MTM outcomes | 5999 |
| TP outcomes | 4681 |
| SL outcomes | 11392 |
| OOF qualified executable | 0 |

## Signal frequency

| Month | Raw | Independent | Executable | R1 active | R2 positive | R3 qualified | High confidence | Portfolio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2024-01 | 11051 | 565 | 424 | 0 | 0 | 0 | 0 | 0 |
| 2024-02 | 12844 | 598 | 417 | 0 | 0 | 0 | 0 | 0 |
| 2024-03 | 14643 | 669 | 497 | 0 | 0 | 0 | 0 | 0 |
| 2024-04 | 15165 | 692 | 525 | 0 | 0 | 0 | 0 | 0 |
| 2024-05 | 15403 | 729 | 566 | 0 | 0 | 0 | 0 | 0 |
| 2024-06 | 14876 | 706 | 538 | 0 | 0 | 0 | 0 | 0 |
| 2024-07 | 15962 | 734 | 578 | 239 | 249 | 0 | 0 | 0 |
| 2024-08 | 16713 | 769 | 593 | 223 | 255 | 0 | 0 | 0 |
| 2024-09 | 15773 | 743 | 583 | 282 | 243 | 0 | 0 | 0 |
| 2024-10 | 17527 | 820 | 621 | 344 | 265 | 0 | 0 | 0 |
| 2024-11 | 19787 | 889 | 669 | 273 | 269 | 0 | 0 | 0 |
| 2024-12 | 22644 | 1042 | 771 | 410 | 353 | 0 | 0 | 0 |
| 2025-01 | 24302 | 1143 | 847 | 382 | 386 | 0 | 0 | 0 |
| 2025-02 | 24199 | 1138 | 781 | 287 | 375 | 0 | 0 | 0 |
| 2025-03 | 27322 | 1278 | 908 | 445 | 384 | 0 | 0 | 0 |
| 2025-04 | 27944 | 1285 | 974 | 579 | 429 | 0 | 0 | 0 |
| 2025-05 | 32692 | 1517 | 1139 | 718 | 473 | 0 | 0 | 0 |
| 2025-06 | 35348 | 1634 | 1253 | 867 | 629 | 0 | 0 | 0 |
| 2025-07 | 39608 | 1839 | 1341 | 779 | 498 | 0 | 0 | 0 |
| 2025-08 | 40478 | 1950 | 1483 | 957 | 637 | 0 | 0 | 0 |
| 2025-09 | 43802 | 2091 | 1483 | 1009 | 624 | 0 | 0 | 0 |
| 2025-10 | 48590 | 2257 | 1599 | 138 | 617 | 0 | 0 | 0 |
| 2025-11 | 48093 | 2278 | 1695 | 150 | 675 | 0 | 0 | 0 |
| 2025-12 | 48570 | 2358 | 1690 | 221 | 634 | 0 | 0 | 0 |

## Nested folds

| Fold | Train | Validation | Inner OOF | Meta OOF | Selected config |
|---|---:|---:|---:|---:|---|
| fold-1 | 2871 | 1754 | 1349 | 1009 | NO QUALIFIED CONFIG |
| fold-2 | 4630 | 2061 | 2177 | 1653 | NO QUALIFIED CONFIG |
| fold-3 | 6628 | 2536 | 3188 | 2431 | NO QUALIFIED CONFIG |
| fold-4 | 9197 | 3366 | 4631 | 3680 | NO QUALIFIED CONFIG |
| fold-5 | 12470 | 4307 | 6656 | 5337 | NO QUALIFIED CONFIG |
| fold-6 | 16728 | 4984 | 9494 | 7671 | NO QUALIFIED CONFIG |

## R1 Market Opportunity

- Top 30%: density 0.3211, expectancy -0.0311, PF 0.9463
- Bottom 30%: density 0.3121, expectancy -0.0542, PF 0.9022
- Verdict: **PASS**

## R2 Cross-sectional Edge

- Mean monthly Spearman IC: 0.1718; median: 0.1936; positive months: 1.0000
- Top quintile: expectancy -0.0168, PF 0.9692; bottom quintile: expectancy -0.0093, PF 0.9842
- Verdict: **FAIL**

## R3 Meta Edge

- Brier 0.2378; base Brier 0.2384; skill 0.0026; log loss 0.6685; monotonicity FAIL
- Verdict: **FAIL**

## Portfolio

- Trades 0; win rate —; PF —; expectancy —; net PnL 0.0000; return 0.0000; DD 0.0000; symbols 0
- Verdict: **FAIL**

## Leakage and isolation audit

- lookaheadFree: PASS
- labelLeakageFree: PASS
- eventOverlapFree: PASS
- normalizationLeakageFree: PASS
- outerValidationUntuned: PASS
- innerOuterLeakageFree: PASS
- stalePitFree: FAIL
- thresholdSearchCount: PASS
- outerEventEndPurge: PASS
- innerEventEndPurge: PASS

## Gate

| Check | Result |
|---|---|
| r1 | PASS |
| r2 | FAIL |
| r3 | FAIL |
| qualifiedOofExecutable | FAIL |
| candidateTrades | FAIL |
| qualifiedMonthlyMean | FAIL |
| qualifiedMonthlyPreferred | FAIL |
| uniqueSymbols | FAIL |
| profitFactor | FAIL |
| expectancy | FAIL |
| positivePnl | FAIL |
| return | FAIL |
| drawdown | PASS |
| positiveMonths | FAIL |
| concentration | PASS |
| beatsV8 | FAIL |
| repoNoOrderAudit | PASS |
| productionIsolation | PASS |
| frozenUniverse | PASS |
| pitMinimum | PASS |
| executionProxy | FAIL |
| nestedPurge | PASS |
| lookaheadFree | PASS |
| labelLeakageFree | PASS |
| eventOverlapFree | PASS |
| normalizationLeakageFree | PASS |
| outerValidationUntuned | PASS |
| innerOuterLeakageFree | PASS |
| stalePitFree | FAIL |
| thresholdSearchCount | PASS |
| outerEventEndPurge | PASS |
| innerEventEndPurge | PASS |

## Known limitations

- M4 remains INCOMPLETE: the inherited dataset is not a strict point-in-time universe with resolved historical delistings and has known local gaps.
- The frozen 150-symbol selection is used as provided; historical survivorship and delisting bias are not cleared by this Development run.
- This task does not run the 2026-01-01 to 2026-07-15 Holdout and does not make a profitability or Production recommendation.
- V8_BASELINE is an additional proposal source; its original trade outcome is not used as a Profit Engine label. All proposals receive the canonical 72-hour outcome.
- The model layer is research-only; all user decisions remain manual and no Binance order endpoint is present.
