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
| MARKET_VOLATILITY_SHOCK | REJECT | 277 | 180 | 142 | 0.7071616423207084 | -0.14126121565695882 | 0.1046378660720462 |
| DISPERSION_ROTATION | REJECT | 1740 | 1614 | 449 | 0.9337134544862894 | -0.033995706104394306 | -0.1353405360373386 |
| LEVERAGE_STRESS_TRANSITION | WATCH | 0 | 0 | 0 | — | — | — |
| TREND_REGIME_TRANSITION | REJECT | 97 | 84 | 60 | 0.8992544239112994 | -0.04417962649142935 | 0.2894508784280678 |

## Gate and audits

- Observed PIT gate: **OBSERVED_PIT_READY**
- Total KEEP / STRONG_KEEP: 0 / 0
- Event/month: 82.20833333333333 (median 83)
- Controls: matched 943; unmatched 1283; no reuse true
- Six-fold audit: PASS
- PIT invariant audit: true
- Announcement mismatch diagnostics: {"hardGate":false,"disagreementCount":null,"spotFuturesAmbiguityCount":null,"archiveAnnouncementMismatch":null,"spotFalseEvidenceRejected":true}
- Missing-data sensitivity: COMPUTED
- Holdout: **NOT RUN**

## Final interpretation

Event results are research diagnostics only; no Production promotion is implied.

## Provenance

- Event engine SHA-256: 1682df2ff2018ce0fa5a5102acf4d1b604a60ba71d3d32becc059928d2fffb22
- Frozen event configuration SHA-256: 1a691b6eab065b6493cf7f4a6279f3a9d69306bd07471c355107380888369ba8
- Dataset manifest SHA-256: 79d4f0623b6a9cbdbbf756c3a71a2c3ab224d6d26457d5e5101e72bdd4342a3a

## Fold and path diagnostics

- Derivative-ready min / mean / median: 112 / 166.90264477884176 / 163
- Leverage-valid snapshots: 4386

### BREADTH_REGIME_TRANSITION

- Fold metrics: [{"fold":0,"n":13,"profitFactor":0.3462070160926219,"expectancyR":-0.22319503916577374,"pnl":-166.6309390547873},{"fold":1,"n":18,"profitFactor":0.424927704460796,"expectancyR":-0.2901123150041426,"pnl":-306.59301911628404},{"fold":2,"n":11,"profitFactor":1.2997538591680995,"expectancyR":0.11277584404999366,"pnl":72.70671898949993},{"fold":3,"n":12,"profitFactor":1.5538522814857498,"expectancyR":0.16188254446002723,"pnl":111.45553931605804},{"fold":4,"n":10,"profitFactor":0.6642216291927583,"expectancyR":-0.14994190221347664,"pnl":-88.78838226865176},{"fold":5,"n":10,"profitFactor":2.005463497223925,"expectancyR":0.317991443329536,"pnl":191.78211259559964}]
- Sample folds / positive expectancy folds: 6 / 3
- MFE: {"n":74,"mean":0.03095535474241421,"median":0.0245419756159021,"max":0.10942948166679689}
- MAE: {"n":74,"mean":-0.03334015825851092,"median":-0.023924437783986396,"min":-0.175936215653693}

### MARKET_VOLATILITY_SHOCK

- Fold metrics: [{"fold":0,"n":25,"profitFactor":1.0021013674406807,"expectancyR":-0.0008523577860092769,"pnl":1.3732690783492743},{"fold":1,"n":23,"profitFactor":1.137493136535577,"expectancyR":0.05216279818644214,"pnl":76.1248799441378},{"fold":2,"n":25,"profitFactor":0.42235567717733835,"expectancyR":-0.3356151551357383,"pnl":-486.7195225331069},{"fold":3,"n":28,"profitFactor":0.6594174588711966,"expectancyR":-0.14978031567516673,"pnl":-247.70766708248277},{"fold":4,"n":18,"profitFactor":0.5738810839986874,"expectancyR":-0.20955494966203428,"pnl":-211.3355692469227},{"fold":5,"n":23,"profitFactor":0.571842120870028,"expectancyR":-0.21223092285701514,"pnl":-285.4098019110142}]
- Sample folds / positive expectancy folds: 6 / 1
- MFE: {"n":142,"mean":0.03534956032170051,"median":0.02550221729120189,"max":0.19193655558163436}
- MAE: {"n":142,"mean":-0.03721712922514308,"median":-0.028523239037099746,"min":-0.18530176389317043}

### DISPERSION_ROTATION

- Fold metrics: [{"fold":0,"n":76,"profitFactor":0.7927254192413521,"expectancyR":-0.1127769845466753,"pnl":-514.2733130363298},{"fold":1,"n":86,"profitFactor":1.2115330342397415,"expectancyR":0.09857367682657871,"pnl":508.28117129268924},{"fold":2,"n":129,"profitFactor":0.9446886074380053,"expectancyR":-0.028342420151319995,"pnl":-222.70531715048557},{"fold":3,"n":56,"profitFactor":0.9751132422856323,"expectancyR":-0.012872747536268199,"pnl":-42.92816987774858},{"fold":4,"n":67,"profitFactor":0.9526115859705014,"expectancyR":-0.023794251241627398,"pnl":-95.723289754418},{"fold":5,"n":35,"profitFactor":0.545895222209302,"expectancyR":-0.26283132936203285,"pnl":-552.1191315825233}]
- Sample folds / positive expectancy folds: 6 / 1
- MFE: {"n":449,"mean":0.09460702363895104,"median":0.0727634194831015,"max":0.561808409737591}
- MAE: {"n":449,"mean":-0.1067401093535338,"median":-0.07164160162446853,"min":-0.8847487001733099}

### LEVERAGE_STRESS_TRANSITION

- Fold metrics: [{"fold":0,"n":0,"profitFactor":null,"expectancyR":null,"pnl":0},{"fold":1,"n":0,"profitFactor":null,"expectancyR":null,"pnl":0},{"fold":2,"n":0,"profitFactor":null,"expectancyR":null,"pnl":0},{"fold":3,"n":0,"profitFactor":null,"expectancyR":null,"pnl":0},{"fold":4,"n":0,"profitFactor":null,"expectancyR":null,"pnl":0},{"fold":5,"n":0,"profitFactor":null,"expectancyR":null,"pnl":0}]
- Sample folds / positive expectancy folds: 0 / 0
- MFE: null
- MAE: null

### TREND_REGIME_TRANSITION

- Fold metrics: [{"fold":0,"n":10,"profitFactor":0.4743782436440192,"expectancyR":-0.2062042177647699,"pnl":-118.32118433941416},{"fold":1,"n":12,"profitFactor":1.8226584948253026,"expectancyR":0.2768723686421011,"pnl":193.87776857650314},{"fold":2,"n":9,"profitFactor":0.6103933213034689,"expectancyR":-0.12968956635947998,"pnl":-70.88748137453597},{"fold":3,"n":9,"profitFactor":0.6692979939676251,"expectancyR":-0.14708848564151555,"pnl":-73.71723856702316},{"fold":4,"n":8,"profitFactor":0.8649992756507953,"expectancyR":-0.08004362028664605,"pnl":-35.45384132641959},{"fold":5,"n":12,"profitFactor":0.872477582816116,"expectancyR":-0.06498770043676215,"pnl":-43.6469815760497}]
- Sample folds / positive expectancy folds: 6 / 1
- MFE: {"n":60,"mean":0.03269368178614263,"median":0.023904038622611368,"max":0.17594448311957134}
- MAE: {"n":60,"mean":-0.033865825002451784,"median":-0.024796061684268844,"min":-0.15371039523544028}
