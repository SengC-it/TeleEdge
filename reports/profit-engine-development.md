# TeleEdge Profit Research Engine R1–R3

Status: **RESEARCH_FAIL**. Research-only Development; Holdout was not run and Production was not changed.

## Boundary and provenance

- Development: 2024-01-01T00:00:00.000Z → 2026-01-01T00:00:00.000Z (end exclusive)
- Holdout: **BLOCKED_RESEARCH_FAIL** (2026-01-01T00:00:00.000Z → 2026-07-15T00:00:00.000Z)
- Universe: 150 symbols (37 core / 113 expanded), hash ec12cd57cca7022ed6c8f2c26a10ff34424a8513fbd6be091bdb359c06dc9b43
- M4: **M4-INCOMPLETE**; PIT usable symbols: 126
- Execution: 4h signal cadence; 20m decision latency; 1m fill/settlement; same-minute TP+SL=SL; executionProxy=false
- No-order audit: PASS

## Proposal and outcome counts

| Layer | Count |
|---|---:|
| Raw proposals | 435503 |
| Merged proposals | 65576 |
| Independent proposals | 27936 |
| Executable canonical outcomes | 21987 |
| OOF qualified executable | 0 |

## Signal frequency

| Month | Raw | Independent | Executable | R1 active | R2 positive | R3 qualified | High confidence | Portfolio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2024-01 | 7629 | 555 | 451 | 0 | 0 | 0 | 0 | 0 |
| 2024-02 | 8498 | 566 | 461 | 0 | 0 | 0 | 0 | 0 |
| 2024-03 | 9209 | 619 | 472 | 0 | 0 | 0 | 0 | 0 |
| 2024-04 | 9348 | 650 | 514 | 0 | 0 | 0 | 0 | 0 |
| 2024-05 | 10172 | 686 | 582 | 0 | 0 | 0 | 0 | 0 |
| 2024-06 | 9861 | 675 | 561 | 0 | 0 | 0 | 0 | 0 |
| 2024-07 | 10289 | 685 | 566 | 213 | 130 | 0 | 0 | 0 |
| 2024-08 | 10527 | 715 | 583 | 353 | 154 | 0 | 0 | 0 |
| 2024-09 | 10672 | 692 | 604 | 293 | 154 | 0 | 0 | 0 |
| 2024-10 | 12086 | 773 | 647 | 266 | 238 | 0 | 0 | 0 |
| 2024-11 | 12250 | 811 | 630 | 420 | 233 | 0 | 0 | 0 |
| 2024-12 | 14597 | 984 | 724 | 531 | 244 | 0 | 0 | 0 |
| 2025-01 | 16071 | 1069 | 827 | 517 | 366 | 0 | 0 | 0 |
| 2025-02 | 15344 | 1068 | 717 | 429 | 244 | 0 | 0 | 0 |
| 2025-03 | 18202 | 1171 | 913 | 518 | 291 | 0 | 0 | 0 |
| 2025-04 | 18196 | 1191 | 947 | 364 | 287 | 0 | 0 | 0 |
| 2025-05 | 21827 | 1414 | 1137 | 632 | 446 | 0 | 0 | 0 |
| 2025-06 | 24761 | 1543 | 1318 | 666 | 468 | 0 | 0 | 0 |
| 2025-07 | 28333 | 1748 | 1406 | 770 | 641 | 0 | 0 | 0 |
| 2025-08 | 30472 | 1823 | 1521 | 840 | 705 | 0 | 0 | 0 |
| 2025-09 | 32892 | 1978 | 1500 | 789 | 694 | 0 | 0 | 0 |
| 2025-10 | 33671 | 2119 | 1580 | 753 | 658 | 0 | 0 | 0 |
| 2025-11 | 33102 | 2181 | 1670 | 923 | 775 | 0 | 0 | 0 |
| 2025-12 | 37420 | 2220 | 1656 | 827 | 783 | 0 | 0 | 0 |

## Nested folds

| Fold | Train | Validation | Inner OOF | Selected config |
|---|---:|---:|---:|---|
| fold-1 | 2913 | 1753 | 1352 | NO QUALIFIED CONFIG |
| fold-2 | 4670 | 2001 | 2187 | NO QUALIFIED CONFIG |
| fold-3 | 6606 | 2457 | 3142 | NO QUALIFIED CONFIG |
| fold-4 | 9070 | 3402 | 4577 | NO QUALIFIED CONFIG |
| fold-5 | 12348 | 4427 | 6534 | NO QUALIFIED CONFIG |
| fold-6 | 16773 | 4906 | 9508 | NO QUALIFIED CONFIG |

## R1 Market Opportunity

- Top 30%: density 0.3518, expectancy 0.0427, PF 1.0644
- Bottom 30%: density 0.3154, expectancy -0.0817, PF 0.8844
- Verdict: **PASS**

## R2 Cross-sectional Edge

- Mean monthly Spearman IC: 0.2192; median: 0.2463; positive months: 1.0000
- Top quintile: expectancy 0.0002, PF 1.0004; bottom quintile: expectancy -0.0111, PF 0.9839
- Verdict: **PASS**

## R3 Meta Edge

- Brier 0.2259; base Brier 0.2255; skill -0.0019; log loss 0.6931
- Verdict: **FAIL**

## Portfolio

- Trades 0; win rate —; PF —; expectancy —; net PnL 0.0000; return 0.0000; DD 0.0000; symbols 0
- Verdict: **FAIL**

## Gate

| Check | Result |
|---|---|
| r1 | PASS |
| r2 | PASS |
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
| noOrderAudit | FAIL |
| frozenUniverse | PASS |
| pitMinimum | PASS |
| executionProxy | PASS |
| nestedPurge | PASS |

## Known limitations

- M4 remains INCOMPLETE: the inherited dataset is not a strict point-in-time universe with resolved historical delistings and has known local gaps.
- The frozen 150-symbol selection is used as provided; historical survivorship and delisting bias are not cleared by this Development run.
- This task does not run the 2026-01-01 to 2026-07-15 Holdout and does not make a profitability or Production recommendation.
- V8_BASELINE proposals are included for source coverage; baseline metrics remain the frozen V8 Development artifact and are not retuned.
- The model layer is research-only; all user decisions remain manual and no Binance order endpoint is present.
