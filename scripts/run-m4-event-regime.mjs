import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {APP_DIR} from '../src/config.mjs';
import {CANONICAL_OUTCOME_CONTRACT} from '../src/profit-engine/labels.mjs';
import {auditProductionIsolation, auditRepoNoOrder} from '../src/profit-engine/audits.mjs';
import {
  EVENT_DEFINITION_VERSION,
  EVENT_DEFINITIONS,
  EVENT_FAMILIES,
  EVENT_KEEP_GATE,
  EVENT_REFRACTORY_HOURS,
  eventResearchGate,
} from '../src/m4/event-engine.mjs';
import {buildPitUniverseFromFiles, M4_DEVELOPMENT_END, M4_DEVELOPMENT_START, M4_LIQUIDITY_LOOKBACK_DAYS, M4_LIQUIDITY_THRESHOLD_USDT} from '../src/m4/pit-universe.mjs';

const DEFAULT_DATA_ROOT = path.join(APP_DIR, 'data', 'backtest');
const DEFAULT_REPORTS_DIR = path.join(APP_DIR, 'reports');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = {dataRoot: DEFAULT_DATA_ROOT, reportsDir: DEFAULT_REPORTS_DIR};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--data-root') result.dataRoot = path.resolve(argv[++index]);
    if (argv[index] === '--reports-dir') result.reportsDir = path.resolve(argv[++index]);
  }
  return result;
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, value, {flag: 'wx'});
  fs.renameSync(temporary, file);
}

function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pitMonthlyRange(months) {
  const values = Object.values(months || {}).map(row => Number(row.pitEligibleSymbols || 0));
  return {min: values.length ? Math.min(...values) : 0, mean: mean(values), max: values.length ? Math.max(...values) : 0};
}

function emptyFamilyReport(family) {
  return {
    family,
    status: 'NOT_RUN_M4_BLOCKED',
    raw: 0,
    independent: 0,
    executable: null,
    symbols: null,
    months: 0,
    long: null,
    short: null,
    marketRegimes: [],
    wins: null,
    losses: null,
    winRate: null,
    profitFactor: null,
    expectancyR: null,
    confidenceInterval: {lower: null, upper: null, level: 0.95},
    pnl: null,
    maxDrawdownPct: null,
    positiveFolds: null,
    eventControlExpectancyUpliftR: null,
    eventControlProfitFactorUplift: null,
    mfe: null,
    mae: null,
    forwardReturns: {h4: null, h12: null, h24: null, h72: null},
    eventStudy: 'NOT_RUN_M4_BLOCKED',
    control: 'NOT_RUN_M4_BLOCKED',
  };
}

function markdownPit(report) {
  const monthly = Object.entries(report.monthlyPitUniverse).map(([month, row]) => `| ${month} | ${row.pitEligibleSymbols} | ${row.core} | ${row.expanded} |`).join('\n');
  const liquidityMonthly = Object.entries(report.monthlyLiquidityEligible || {}).map(([month, row]) => `| ${month} | ${row.pitEligibleSymbols} | ${row.core} | ${row.expanded} | ${row.liquidityUnknown} |`).join('\n');
  const unresolved = report.unresolved.length
    ? report.unresolved.slice(0, 80).map(row => `| ${row.symbol} | ${row.reasons.join(', ')} | ${row.firstArchiveMonth || '—'} | ${row.lastArchiveMonth || '—'} |`).join('\n')
    : '| — | none | — | — |';
  const gaps = report.dataGaps.length
    ? report.dataGaps.slice(0, 80).map(row => `| ${row.symbol} | ${row.kind} | ${row.reason} |`).join('\n')
    : '| — | — | none |';
  return `# M4 PIT Universe Closure

Status: **${report.status}**

Development window: ${report.start} → ${report.end} (end exclusive). Snapshot: ${report.snapshotTimestamp || '—'}.

This report uses the union of actual Binance Data Vision USD-M archive evidence and the current exchangeInfo cross-check. Current exchangeInfo is never used as the sole historical universe source. Archive first/last observations are diagnostics only and cannot certify an in-window listing or delisting.

## Universe

- Discovered symbols: ${report.discoveredSymbols.length}
- Current symbols: ${report.currentSymbols.length}
- Historical archive-only symbols: ${report.historicalDelistedSymbols.length}
- Listed during Development: ${report.listedDuringDevelopment.length}
- Delisted during Development: ${report.delistedDuringDevelopment.length}
- PIT window resolved: ${report.markets.filter(row => row.pitWindowResolved).length}/${report.markets.length}
- Unresolved Development lifecycle: ${report.unresolved.length}
- M4_PIT_WINDOW_COMPLETE: **${report.m4PitWindowComplete}**
- M4_GLOBAL_COMPLETE: **${report.m4GlobalComplete}**
- Manifest strict data contract ready: **${report.manifestDataContractReady}**

## Monthly PIT universe

| Month | PIT eligible | Core | Expanded |
|---|---:|---:|---:|
${monthly || '| — | 0 | 0 | 0 |'}

## Monthly PIT liquidity eligibility

Fixed rule: completed point-in-time 30-day average quote volume ≥ 20,000,000 USDT. Missing liquidity history is fail-closed and is not inferred from future volume.

| Month | Liquidity-eligible | Core | Expanded | Unknown |
|---|---:|---:|---:|---:|
${liquidityMonthly || '| — | 0 | 0 | 0 | 0'}

## Lifecycle blockers

| Symbol | Reason | First archive month | Last archive month |
|---|---|---|---|
${unresolved}

## Data gaps

| Symbol | Artifact | Reason |
|---|---|---|
${gaps}

## Integrity and provenance

- Required artifacts: ${report.dataIntegrity.requiredArtifacts.join(', ')}
- Active markets with complete artifact metadata: ${report.dataIntegrity.completeActiveMarkets}/${report.dataIntegrity.activeMarkets}
- Data gaps: ${report.dataIntegrity.gaps}
- Hash failures: ${report.dataIntegrity.hashFailures}
- Liquidity metadata unknown: ${report.dataIntegrity.liquidityUnknown}
- PIT universe SHA-256: ${report.pitUniverseSha256}
- Universe evidence SHA-256: ${report.universeEvidenceSha256}
- Dataset manifest SHA-256: ${report.datasetManifestSha256 || '—'}

Formal Event Research status: **${report.m4PitWindowComplete ? 'eligible to run' : 'M4_BLOCKED; Event Research not run'}**.
`;
}

function markdownEvent(report) {
  const rows = Object.values(report.families).map(row => `| ${row.family} | ${row.status} | ${row.independent ?? 0} | ${row.executable ?? '—'} | ${row.profitFactor ?? '—'} | ${row.expectancyR ?? '—'} | ${row.eventControlExpectancyUpliftR ?? '—'} |`).join('\n');
  return `# Event / Regime Conditional Research

Status: **${report.finalDecision}**. No ML, grid search, threshold optimization, Holdout, or Production change was performed.

Event definitions are frozen at ${report.eventDefinitionVersion}. Outcome contract: canonical 72h, 20-minute decision latency, 1m executable fill, deterministic stop, 2R target, chronological 1m first touch, same-minute TP+SL=SL, funding/fees/modeled cost.

## Family results

| Family | Status | Independent | Executable | PF | Expectancy R | Event-control uplift R |
|---|---|---:|---:|---:|---:|---:|
${rows}

## Gate

- Total KEEP: ${report.totalKeep}
- Total STRONG_KEEP: ${report.totalStrongKeep}
- Event/month mean and median: ${report.eventFrequency.mean} / ${report.eventFrequency.median}
- Holdout: **NOT RUN**
- M4 status: **${report.m4Status}**
- Final decision: **${report.finalDecision}**
`;
}

function buildEventReport(pit, audits) {
  const families = Object.fromEntries(EVENT_FAMILIES.map(family => [family, emptyFamilyReport(family)]));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    eventDefinitionVersion: EVENT_DEFINITION_VERSION,
    developmentWindow: {start: new Date(M4_DEVELOPMENT_START).toISOString(), end: new Date(M4_DEVELOPMENT_END).toISOString()},
    m4Status: pit.status,
    finalDecision: pit.m4PitWindowComplete ? eventResearchGate(families) : 'M4_BLOCKED',
    families,
    totalKeep: 0,
    totalStrongKeep: 0,
    eventFrequency: {mean: 0, median: 0, monthly: {}},
    eventStudy: {status: pit.m4PitWindowComplete ? 'IMPLEMENTATION_READY_NOT_EXECUTED' : 'NOT_RUN_M4_BLOCKED', horizons: ['4h', '12h', '24h', '72h']},
    controls: {method: 'deterministic exact month + side + regime + liquidity bucket matching; nearest timestamp, stable event id tie-break', audited: true},
    liquidity: {lookbackDays: M4_LIQUIDITY_LOOKBACK_DAYS, thresholdUsdt: M4_LIQUIDITY_THRESHOLD_USDT, completedOnly: true, pointInTime: true},
    walkForward: {outerFolds: 6, purgeHours: 72, eventEndAware: true, randomSplit: false, validationFrozen: true},
    outcomeContract: CANONICAL_OUTCOME_CONTRACT,
    gates: EVENT_KEEP_GATE,
    holdout: {status: 'NOT RUN', authorized: false},
    repoNoOrderAudit: audits.noOrder,
    productionIsolation: audits.isolation,
    knownLimitations: [
      'M4 PIT window is blocked until all Development-active archive symbols have resolved entry/exit boundaries and required data coverage.',
      'Event family metrics are intentionally not computed while M4 is blocked; no point estimate is presented as evidence.',
      'No Holdout was run and no Production configuration, schema, scheduler, SMTP or signal behavior was changed.',
    ],
  };
}

export function buildReports({appDir = APP_DIR, dataRoot = DEFAULT_DATA_ROOT, reportsDir = DEFAULT_REPORTS_DIR} = {}) {
  const pit = buildPitUniverseFromFiles({appDir, dataRoot, start: M4_DEVELOPMENT_START, end: M4_DEVELOPMENT_END});
  const audits = {noOrder: auditRepoNoOrder(appDir), isolation: auditProductionIsolation(appDir, 'research/profit-engine-r1-r3')};
  const pitReport = {
    reportVersion: 'm4-pit-universe-v1',
    generatedAt: new Date().toISOString(),
    ...pit,
    monthlyRange: pitMonthlyRange(pit.monthlyPitUniverse),
    discoveredHistoricalSymbols: pit.historicalDelistedSymbols?.length || 0,
    source: 'Binance official Data Vision USD-M archive index plus timestamped lifecycle evidence and exchangeInfo cross-check',
    survivorshipAudit: {currentListAlone: false, archiveUnionUsed: true, historicalDelistingsIncluded: (pit.historicalDelistedSymbols?.length || 0) > 0},
  };
  const eventReport = buildEventReport(pitReport, audits);
  const frozenConfig = {
    schemaVersion: 1,
    eventDefinitionVersion: EVENT_DEFINITION_VERSION,
    families: EVENT_DEFINITIONS,
    refractoryHours: EVENT_REFRACTORY_HOURS,
    outcomeContract: CANONICAL_OUTCOME_CONTRACT,
    controls: eventReport.controls,
    liquidity: {lookbackDays: M4_LIQUIDITY_LOOKBACK_DAYS, thresholdUsdt: M4_LIQUIDITY_THRESHOLD_USDT, completedOnly: true, pointInTime: true},
    walkForward: eventReport.walkForward,
    gates: EVENT_KEEP_GATE,
    developmentWindow: eventReport.developmentWindow,
    holdout: eventReport.holdout,
  };
  pitReport.provenance = {
    m4DatasetSha256: sha256(JSON.stringify({markets: pitReport.markets, dataIntegrity: pitReport.dataIntegrity})),
    pitUniverseSha256: pitReport.pitUniverseSha256 || null,
    eventEngineCodeSha256: sha256(fs.readFileSync(path.join(appDir, 'src', 'm4', 'event-engine.mjs'))),
    eventFrozenConfigSha256: sha256(JSON.stringify(frozenConfig)),
    datasetManifestSha256: pitReport.datasetManifestSha256 || null,
    universeEvidenceSha256: pitReport.universeEvidenceSha256 || null,
  };
  eventReport.provenance = {
    m4DatasetSha256: pitReport.provenance.m4DatasetSha256,
    pitUniverseSha256: pitReport.provenance.pitUniverseSha256,
    eventEngineCodeSha256: pitReport.provenance.eventEngineCodeSha256,
    eventFrozenConfigSha256: pitReport.provenance.eventFrozenConfigSha256,
    datasetManifestSha256: pitReport.provenance.datasetManifestSha256,
    universeEvidenceSha256: pitReport.provenance.universeEvidenceSha256,
  };
  writeJson(path.join(reportsDir, 'm4-pit-universe.json'), pitReport);
  atomicWrite(path.join(reportsDir, 'm4-pit-universe.md'), markdownPit(pitReport));
  writeJson(path.join(reportsDir, 'event-regime-development.json'), eventReport);
  atomicWrite(path.join(reportsDir, 'event-regime-development.md'), markdownEvent(eventReport));
  writeJson(path.join(reportsDir, 'event-regime-frozen-config.json'), frozenConfig);
  return {pit: pitReport, event: eventReport, frozenConfig};
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const result = buildReports(parseArgs());
    console.log(JSON.stringify({
      m4Status: result.pit.status,
      m4PitWindowComplete: result.pit.m4PitWindowComplete,
      m4GlobalComplete: result.pit.m4GlobalComplete,
      discoveredSymbols: result.pit.discoveredSymbols.length,
      unresolved: result.pit.unresolved.length,
      eventDecision: result.event.finalDecision,
      reports: ['reports/m4-pit-universe.json', 'reports/m4-pit-universe.md', 'reports/event-regime-development.json', 'reports/event-regime-development.md', 'reports/event-regime-frozen-config.json'],
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
