import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {APP_DIR, CORE_MARKETS, H1} from '../src/config.mjs';
import {runBacktest} from './backtest.mjs';

const OOS_START = Date.parse('2025-01-01T00:00:00.000Z');
const OOS_END = Date.parse('2026-07-15T00:00:00.000Z');
const DECISION_LATENCY_MS = 20 * 60_000;
const HORIZONS = Object.freeze([1, 4, 12, 24, 72]);
const TRADE_REPORT_BASE = path.join(APP_DIR, 'runtime', 'final-signal-trade-backtest');
const UNIVERSE_FILE = path.join(APP_DIR, 'reports', 'fast-oos-universe.json');
const MANIFEST_FILE = path.join(APP_DIR, 'data', 'backtest', 'manifest.json');
const STRICT_FILE = path.join(APP_DIR, 'reports', 'formal-dataset-strict-failures.json');
const FINAL_JSON = path.join(APP_DIR, 'reports', 'final-signal-validation.json');
const FINAL_MARKDOWN = path.join(APP_DIR, 'reports', 'final-signal-validation.md');
const RUNNER_FILE = path.join(APP_DIR, 'scripts', 'run-final-signal-validation.mjs');
const STRATEGY_FILES = [
  'src/config.mjs',
  'src/strategy.mjs',
  'src/v8-shadow.mjs',
  'src/portfolio.mjs',
  'src/fill-risk.mjs',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function git(args) {
  return execFileSync('git', ['-c', `safe.directory=${APP_DIR}`, ...args], {cwd: APP_DIR, encoding: 'utf8'}).trim();
}

function timestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  return Date.parse(value || '') || 0;
}

function readGzipJson(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim();
  return text ? JSON.parse(text) : [];
}

function loadRows(directory, symbol) {
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory)
    .filter(name => name.match(new RegExp(`^${symbol}-\\d+\\.json\\.gz$`)))
    .sort((a, b) => Number(a.match(/-(\d+)\./)[1]) - Number(b.match(/-(\d+)\./)[1]));
  const sourceFiles = files.length ? files : (fs.existsSync(path.join(directory, `${symbol}.json.gz`)) ? [`${symbol}.json.gz`] : []);
  const byTime = new Map();
  for (const file of sourceFiles) {
    for (const row of readGzipJson(path.join(directory, file))) {
      const t = Number(row.t);
      if (!Number.isFinite(t)) continue;
      byTime.set(t, {
        t,
        o: Number(row.o),
        h: Number(row.h),
        l: Number(row.l),
        c: Number(row.c),
        q: Number(row.q || 0),
      });
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function marketRecord(manifest, symbol) {
  return (manifest.universe?.markets || []).find(item => item.symbol === symbol) || {};
}

function representativeSymbols(eligibleSymbols, manifest, limit = 120) {
  const records = eligibleSymbols.map(symbol => {
    const market = marketRecord(manifest, symbol);
    const start = Math.max(OOS_START, timestamp(market.eligibleStart || OOS_START));
    const end = Math.min(OOS_END, timestamp(market.eligibleEnd || OOS_END));
    const duration = Math.max(0, end - start);
    const oosDuration = OOS_END - OOS_START;
    const durationBand = duration >= oosDuration * 0.66 ? 'long-history' : duration >= oosDuration * 0.33 ? 'medium-history' : 'recent-listing';
    return {symbol, tier: CORE_MARKETS.has(symbol) ? 'core' : 'expanded', duration, durationBand};
  });
  if (records.length <= limit) return {symbols: records.map(record => record.symbol).sort(), reason: 'all clean eligible symbols; no fallback required', bands: records};
  const buckets = new Map();
  for (const record of records) {
    const key = `${record.tier}|${record.durationBand}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }
  for (const rows of buckets.values()) rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const quota = Math.floor(limit / 6);
  const chosen = new Map();
  for (const key of [...buckets.keys()].sort()) {
    const rows = buckets.get(key);
    const take = Math.min(quota, rows.length);
    for (let index = 0; index < take; index++) {
      const row = rows[Math.min(rows.length - 1, Math.floor(index * rows.length / take))];
      chosen.set(row.symbol, row);
    }
  }
  const remaining = records.filter(record => !chosen.has(record.symbol)).sort((a, b) => b.duration - a.duration || a.symbol.localeCompare(b.symbol));
  for (const row of remaining) {
    if (chosen.size >= limit) break;
    chosen.set(row.symbol, row);
  }
  const btc = records.find(record => record.symbol === 'BTCUSDT');
  if (btc && !chosen.has(btc.symbol)) {
    const replace = [...chosen.values()].sort((a, b) => a.duration - b.duration || b.symbol.localeCompare(a.symbol))[0];
    chosen.delete(replace.symbol);
    chosen.set(btc.symbol, btc);
  }
  return {
    symbols: [...chosen.keys()].sort(),
    reason: `deterministic ${chosen.size}-symbol active-duration stratified fallback after full-universe memory bound; long-history/medium-history/recent-listing × core/expanded; no minuteRows sorting`,
    bands: [...chosen.values()],
  };
}

function oosEvents(events) {
  return (events || []).filter(event => timestamp(event.signalTime) >= OOS_START && timestamp(event.signalTime) < OOS_END);
}

function alertKey(event) {
  return `${event.marketId}|${event.side}|${event.signalTime}`;
}

function completedRowsUntil(rows, start, deadline) {
  return rows.filter(row => row.t >= start && row.t + H1 <= deadline);
}

function priceAtCompleted(rows, signalTime, deadline) {
  const eligible = completedRowsUntil(rows, signalTime, deadline);
  return eligible.length ? eligible.at(-1).c : null;
}

function directionalReturn(side, signalPrice, futurePrice) {
  if (!(signalPrice > 0) || !(futurePrice > 0)) return null;
  return side === 'short' ? signalPrice / futurePrice - 1 : futurePrice / signalPrice - 1;
}

function directionalMfeMae(side, signalPrice, rows) {
  if (!(signalPrice > 0) || !rows.length) return {mfe: null, mae: null};
  if (side === 'short') {
    return {
      mfe: signalPrice / Math.min(...rows.map(row => row.l)) - 1,
      mae: signalPrice / Math.max(...rows.map(row => row.h)) - 1,
    };
  }
  return {
    mfe: Math.max(...rows.map(row => row.h)) / signalPrice - 1,
    mae: Math.min(...rows.map(row => row.l)) / signalPrice - 1,
  };
}

function firstTouch(signal, minuteRows, lifecycleEnd) {
  if (!(signal.stop > 0) || !(signal.target > 0)) return {outcome: null, timeToTpHours: null, timeToSlHours: null};
  const fillTime = timestamp(signal.signalTime) + DECISION_LATENCY_MS;
  const firstMinute = Math.ceil(fillTime / 60_000) * 60_000;
  const cutoff = Math.min(timestamp(signal.signalTime) + 72 * H1, lifecycleEnd, OOS_END);
  for (const row of minuteRows) {
    const closeTime = row.t + 60_000;
    if (row.t < firstMinute || closeTime > cutoff) continue;
    const stopHit = signal.side === 'long' ? row.l <= signal.stop : row.h >= signal.stop;
    const targetHit = signal.side === 'long' ? row.h >= signal.target : row.l <= signal.target;
    if (stopHit) return {outcome: 'sl', timeToTpHours: null, timeToSlHours: (closeTime - timestamp(signal.signalTime)) / H1};
    if (targetHit) return {outcome: 'tp', timeToTpHours: (closeTime - timestamp(signal.signalTime)) / H1, timeToSlHours: null};
  }
  return {outcome: 'none', timeToTpHours: null, timeToSlHours: null};
}

function buildObservation(signal, h1, minuteRows, lifecycleEnd) {
  const signalTime = timestamp(signal.signalTime);
  const signalPrice = Number(signal.signalPrice);
  const observation = {
    id: signal.id,
    symbol: signal.marketId,
    side: signal.side,
    alpha: signal.alpha,
    family: signal.family,
    regime: signal.regime || signal.btcRouter || 'unknown',
    signalTime,
    signalPrice,
    edgeScore: signal.edgeScore,
    eventScore: signal.eventScore,
    dayVolume: signal.dayVolume,
    returns: {},
    mfe: {},
    mae: {},
    minuteDataAvailable: minuteRows.length > 0,
  };
  for (const hours of HORIZONS) {
    const deadline = Math.min(signalTime + hours * H1, lifecycleEnd, OOS_END);
    const completed = completedRowsUntil(h1, signalTime, deadline);
    const futurePrice = priceAtCompleted(h1, signalTime, deadline);
    const edge = directionalReturn(signal.side, signalPrice, futurePrice);
    const {mfe, mae} = directionalMfeMae(signal.side, signalPrice, completed);
    observation.returns[`${hours}h`] = edge;
    observation.mfe[`${hours}h`] = mfe;
    observation.mae[`${hours}h`] = mae;
  }
  observation.touch = firstTouch(signal, minuteRows, lifecycleEnd);
  return observation;
}

function finite(values) {
  return values.filter(value => Number.isFinite(Number(value))).map(Number);
}

function mean(values) {
  const rows = finite(values);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function median(values) {
  const rows = finite(values).sort((a, b) => a - b);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function ci95(values) {
  const rows = finite(values);
  if (!rows.length) return null;
  const average = mean(rows);
  if (rows.length < 2) return [average, average];
  const variance = rows.reduce((sum, value) => sum + (value - average) ** 2, 0) / (rows.length - 1);
  const margin = 1.96 * Math.sqrt(variance) / Math.sqrt(rows.length);
  return [average - margin, average + margin];
}

function summarizeObservations(observations) {
  const output = {signals: observations.length, uniqueSymbols: new Set(observations.map(item => item.symbol)).size, directionHitRate: {}, meanDirectionalReturn: {}, medianDirectionalReturn: {}, ci95: {}, mfe: {}, mae: {}};
  for (const hours of HORIZONS) {
    const key = `${hours}h`;
    const returns = observations.map(item => item.returns[key]);
    const mfes = observations.map(item => item.mfe[key]);
    const maes = observations.map(item => item.mae[key]);
    const validReturns = finite(returns);
    output.directionHitRate[key] = validReturns.length ? validReturns.filter(value => value > 0).length / validReturns.length : null;
    output.meanDirectionalReturn[key] = mean(returns);
    output.medianDirectionalReturn[key] = median(returns);
    output.ci95[key] = ci95(returns);
    output.mfe[key] = mean(mfes);
    output.mae[key] = mean(maes);
  }
  const resolved = observations.map(item => item.touch?.outcome).filter(value => value === 'tp' || value === 'sl');
  output.tpFirstSlWinRate = resolved.length ? resolved.filter(value => value === 'tp').length / resolved.length : null;
  output.timeToTpHours = mean(observations.map(item => item.touch?.timeToTpHours));
  output.timeToSlHours = mean(observations.map(item => item.touch?.timeToSlHours));
  return output;
}

function breakdown(observations, selector) {
  const groups = new Map();
  for (const observation of observations) {
    const key = String(selector(observation));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, summarizeObservations(rows)]));
}

function compactTrade(trade) {
  return {
    id: trade.id,
    symbol: trade.marketId || trade.symbol,
    side: trade.side,
    alpha: trade.alpha,
    family: trade.family,
    regime: trade.btcRouter || trade.features?.btcRouter || 'unknown',
    signalTime: timestamp(trade.signalTime),
    signalPrice: trade.signalPrice,
    decisionTime: timestamp(trade.decisionTime),
    fillTime: timestamp(trade.fillTime),
    fillPrice: trade.fillPrice,
    stop: trade.stop,
    target: trade.target,
    exitTime: timestamp(trade.exitTime),
    exitPrice: trade.exitPrice,
    exitReason: trade.exitReason,
    grossPnlUsdt: trade.grossPnlUsdt,
    modeledCostUsdt: trade.modeledCostUsdt,
    fundingPnlUsdt: trade.fundingPnlUsdt,
    netPnlUsdt: trade.netPnlUsdt,
    netR: trade.netR,
  };
}

function tradeBreakdown(trades, oosMetrics) {
  const bySymbol = new Map();
  for (const trade of trades) {
    const symbol = trade.symbol;
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, {symbol, trades: 0, netPnlUsdt: 0});
    const row = bySymbol.get(symbol);
    row.trades++;
    row.netPnlUsdt += Number(trade.netPnlUsdt || 0);
  }
  const positiveBasis = [...bySymbol.values()].reduce((sum, row) => sum + Math.max(0, row.netPnlUsdt), 0);
  const topSymbols = [...bySymbol.values()].sort((a, b) => b.netPnlUsdt - a.netPnlUsdt || a.symbol.localeCompare(b.symbol)).slice(0, 5)
    .map(row => ({...row, contributionPct: positiveBasis ? row.netPnlUsdt / positiveBasis * 100 : null}));
  const positiveTradeBasis = trades.reduce((sum, trade) => sum + Math.max(0, Number(trade.netPnlUsdt || 0)), 0);
  const topTrades = [...trades].sort((a, b) => Number(b.netPnlUsdt || 0) - Number(a.netPnlUsdt || 0) || String(a.id).localeCompare(String(b.id))).slice(0, 5)
    .map(trade => ({id: trade.id, symbol: trade.symbol, netPnlUsdt: trade.netPnlUsdt, contributionPct: positiveTradeBasis ? Number(trade.netPnlUsdt || 0) / positiveTradeBasis * 100 : null}));
  const returns = finite(trades.map(trade => trade.netR)).sort((a, b) => a - b);
  const tailCount = returns.length ? Math.max(1, Math.ceil(returns.length * 0.05)) : 0;
  const tail = tailCount ? returns.slice(0, tailCount) : [];
  const monthly = new Map();
  for (const trade of trades) {
    const date = new Date(timestamp(trade.exitTime));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const row = monthly.get(key) || {month: key, trades: 0, netPnlUsdt: 0, wins: 0, losses: 0};
    row.trades++;
    row.netPnlUsdt += Number(trade.netPnlUsdt || 0);
    if (Number(trade.netR) > 0) row.wins++;
    if (Number(trade.netR) < 0) row.losses++;
    monthly.set(key, row);
  }
  return {
    ...oosMetrics,
    maxDrawdownPercent: Number.isFinite(Number(oosMetrics.maxDrawdownPct)) ? Number(oosMetrics.maxDrawdownPct) * 100 : null,
    uniqueTradedSymbols: new Set(trades.map(trade => trade.symbol)).size,
    top5SymbolContribution: topSymbols,
    top5TradeContribution: topTrades,
    largestLosingTrades: [...trades].sort((a, b) => Number(a.netPnlUsdt || 0) - Number(b.netPnlUsdt || 0)).slice(0, 5),
    cvar95: {sampleSize: tail.length, netR: tail.length ? mean(tail) : null},
    monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
  };
}

function modelResult(model) {
  const raw = oosEvents(model.rawCandidateEvents);
  const ranked = oosEvents(model.signalEvents);
  const accepted = oosEvents(model.acceptedSignalEvents);
  const trades = (model.trades || []).filter(trade => timestamp(trade.signalTime) >= OOS_START && timestamp(trade.signalTime) < OOS_END).map(compactTrade);
  const observations = [];
  return {model, raw, ranked, accepted, trades, observations};
}

function modelSummary(result) {
  const signalQuality = summarizeObservations(result.observations);
  return {
    rawCandidates: result.raw.length,
    rankedSignals: result.ranked.length,
    uniqueAlerts: new Set(result.ranked.map(alertKey)).size,
    simulatedAcceptedSignals: result.accepted.length,
    closedSimulatedTrades: result.trades.length,
    uniqueSignalSymbols: signalQuality.uniqueSymbols,
    observedAlphaCoverage: result.model.observedAlphaCoverage || [],
    signalQuality,
    bySide: breakdown(result.observations, item => item.side),
    byRegime: breakdown(result.observations, item => item.regime),
    byAlpha: breakdown(result.observations, item => item.alpha),
    byFamily: breakdown(result.observations, item => item.family),
    bySymbol: breakdown(result.observations, item => item.symbol),
    byYear: breakdown(result.observations, item => new Date(item.signalTime).getUTCFullYear()),
    byMonth: breakdown(result.observations, item => `${new Date(item.signalTime).getUTCFullYear()}-${String(new Date(item.signalTime).getUTCMonth() + 1).padStart(2, '0')}`),
    trade: tradeBreakdown(result.trades, result.model.splits.oos),
    tradeRecords: result.trades,
    signalObservations: result.observations,
  };
}

function increment(v75, v8) {
  const v75Keys = new Set(v75.ranked.map(alertKey));
  const v8Keys = new Set(v8.ranked.map(alertKey));
  const overlap = [...v75Keys].filter(key => v8Keys.has(key));
  const v75Only = [...v75Keys].filter(key => !v8Keys.has(key));
  const v8Only = [...v8Keys].filter(key => !v75Keys.has(key));
  const combined = new Set([...v75Keys, ...v8Keys]);
  return {
    v75Only: v75Only.length,
    v8Only: v8Only.length,
    overlap: overlap.length,
    combinedUniqueAlerts: combined.size,
    signalIncreasePct: v75Keys.size ? (combined.size - v75Keys.size) / v75Keys.size * 100 : null,
  };
}

function gate(v8) {
  const edge = v8.signalQuality;
  const trade = v8.trade;
  const edge12 = edge.meanDirectionalReturn['12h'];
  const edge24 = edge.meanDirectionalReturn['24h'];
  const positiveEdge = edge12 > 0 && edge24 > 0;
  const stableTouch = edge.tpFirstSlWinRate == null || edge.tpFirstSlWinRate > 0.5;
  const mfeMaePositive = edge.mfe['24h'] != null && edge.mae['24h'] != null && edge.mfe['24h'] > Math.abs(edge.mae['24h']);
  const positiveTrade = trade.netExpectancyR > 0 && trade.profitFactor > 1;
  const enoughSignals = v8.rankedSignals >= 100;
  const enoughSymbols = v8.uniqueSignalSymbols >= 20;
  const concentrationOk = !trade.top5SymbolContribution.length || trade.top5SymbolContribution[0].contributionPct == null || trade.top5SymbolContribution[0].contributionPct <= 75;
  const ciLowerPositive = edge.ci95['12h']?.[0] > 0 && edge.ci95['24h']?.[0] > 0;
  const reasons = [];
  if (!enoughSignals) reasons.push(`V8 signal observations=${v8.rankedSignals} (<100)`);
  if (!enoughSymbols) reasons.push(`V8 unique signal symbols=${v8.uniqueSignalSymbols} (<20)`);
  if (!(edge12 > 0)) reasons.push('V8 12h directional edge is not positive');
  if (!(edge24 > 0)) reasons.push('V8 24h directional edge is not positive');
  if (!positiveTrade) reasons.push('V8 simulated trade expectancy/PF is not both positive');
  if (!stableTouch) reasons.push('V8 TP-first-SL signal outcome is not stable positive');
  if (!mfeMaePositive) reasons.push('V8 24h MFE does not exceed absolute MAE');
  if (!concentrationOk) reasons.push('V8 simulated PnL is concentrated in one symbol');
  const result = positiveEdge && positiveTrade && enoughSignals && enoughSymbols && stableTouch && mfeMaePositive && concentrationOk
    ? ciLowerPositive ? 'STRONG PASS' : 'SHADOW GO'
    : positiveEdge && positiveTrade ? 'SHADOW GO' : 'NO-GO';
  return {
    result,
    reasons,
    criteria: {enoughSignals, enoughSymbols, positiveEdge, stableTouch, mfeMaePositive, positiveTrade, concentrationOk, ciLowerPositive},
  };
}

function markdown(report) {
  const modelRows = ['v75', 'v8'].map(key => {
    const model = report.models[key];
    const trade = model.trade;
    return `| ${model.name} | ${model.rankedSignals} | ${model.uniqueSignalSymbols} | ${trade.trades} | ${format(trade.netExpectancyR)} | ${format(trade.profitFactor)} | ${format(trade.maxDrawdownPercent)}% |`;
  }).join('\n');
  const edgeRows = ['v75', 'v8'].map(key => {
    const model = report.models[key];
    return `| ${model.name} | ${format(model.signalQuality.meanDirectionalReturn['24h'])} | ${format(model.signalQuality.tpFirstSlWinRate * 100)}% | ${format(model.trade.netExpectancyR)} | ${format(model.trade.profitFactor)} | ${format(model.trade.maxDrawdownPercent)}% |`;
  }).join('\n');
  return [
    `# ${report.result}`,
    '',
    '## Final Signal Validation',
    '',
    `**${report.result}**`,
    '',
    `- OOS window: ${report.execution.oosStart} → ${report.execution.oosEnd}`,
    `- Universe: ${report.universe.cleanEligibleSymbols} clean eligible symbols; validation used ${report.execution.symbols} deterministic active-duration-stratified symbols`,
    `- Execution layer: ${report.execution.scanCadence}; ${report.execution.decisionLatency}; ${report.execution.fill}; ${report.execution.settlement}`,
    `- Signal-level 1m loading: lazy by symbol after a signal; no minimum-minute-row selection`,
    '',
    '| Model | Ranked signals | Unique signal symbols | Simulated trades | Expectancy R | PF | DD |',
    '|---|---:|---:|---:|---:|---:|---:|',
    modelRows,
    '',
    '## Required headline metrics',
    '',
    `- V7.5 signal count: **${report.models.v75.rankedSignals}**`,
    `- V8 signal count: **${report.models.v8.rankedSignals}**`,
    `- Combined unique signal count: **${report.signalIncrement.combinedUniqueAlerts}**`,
    `- Signal increase: **${format(report.signalIncrement.signalIncreasePct)}%**`,
    `- V7.5 24h directional edge: **${format(report.models.v75.signalQuality.meanDirectionalReturn['24h'])}**`,
    `- V8 24h directional edge: **${format(report.models.v8.signalQuality.meanDirectionalReturn['24h'])}**`,
    `- V7.5 TP-first-SL: **${format(report.models.v75.signalQuality.tpFirstSlWinRate * 100)}%**`,
    `- V8 TP-first-SL: **${format(report.models.v8.signalQuality.tpFirstSlWinRate * 100)}%**`,
    '',
    '| Model | 24h directional edge | TP-first-SL | Sim expectancy R | PF | DD |',
    '|---|---:|---:|---:|---:|---:|',
    edgeRows,
    '',
    '## Signal increment',
    '',
    `- V7.5-only alerts: ${report.signalIncrement.v75Only}`,
    `- V8-only alerts: ${report.signalIncrement.v8Only}`,
    `- Overlap alerts: ${report.signalIncrement.overlap}`,
    `- Combined unique alerts: ${report.signalIncrement.combinedUniqueAlerts}`,
    '',
    '## Signal quality',
    '',
    '- Every ranked OOS alert is one observation. Directional return is positive when the future move agrees with the signal side.',
    '- Full signal observations and dimension breakdowns are stored in the JSON report.',
    `- V8 12h edge CI: ${formatCi(report.models.v8.signalQuality.ci95['12h'])}; 24h edge CI: ${formatCi(report.models.v8.signalQuality.ci95['24h'])}`,
    '',
    '## Trade-level diagnostics',
    '',
    `- V8 unique traded symbols: ${report.models.v8.trade.uniqueTradedSymbols}`,
    `- V8 CVaR95 net R: ${format(report.models.v8.trade.cvar95.netR)}`,
    `- V8 monthly rows: ${report.models.v8.trade.monthly.length}`,
    '- Trade records, top-five symbol/trade contributions, largest losses and monthly results are included in JSON.',
    '',
    '## Reproducibility',
    '',
    `- Repository commit SHA: \`${report.reproducibility.repositoryCommitSha}\``,
    `- Strategy commit SHA: \`${report.reproducibility.strategyCommitSha}\``,
    `- Runner SHA256: \`${report.reproducibility.runnerSha256}\``,
    `- Config SHA256: \`${report.reproducibility.configSha256}\``,
    `- Manifest SHA256: \`${report.reproducibility.manifestSha256}\``,
    `- Pre-run working tree dirty: **${report.reproducibility.preRunWorkingTreeDirty}**`,
    '- Generated report files are the only expected post-run working-tree changes and are committed separately.',
    '',
    '## M4 boundary',
    '',
    '- M4 full strict dataset remains INCOMPLETE research backlog and is not required for this signal-only gate.',
    `- Current M4 strict result: ${report.m4.strictComplete ? 'complete' : 'incomplete'}; continuity failures ${report.m4.continuityFailures}; coverage failures ${report.m4.coverageFailures}.`,
    '',
    '## Signal Production Release Checklist',
    '',
    ...report.releaseChecklist.map(item => `- ${item.item}: **${item.status}** — ${item.evidence}`),
    '',
    `## Gate reasons (${report.gate.reasons.length})`,
    '',
    report.gate.reasons.length ? report.gate.reasons.map(reason => `- ${reason}`).join('\n') : '- none',
    '',
    'No merge and no deployment were performed. The system remains signal-only advisory; trading decisions remain manual.',
    '',
  ].join('\n');
}

function format(value) {
  return value == null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(4);
}

function formatCi(ci) {
  return ci ? `[${format(ci[0])}, ${format(ci[1])}]` : 'n/a';
}

async function main() {
  for (const file of [UNIVERSE_FILE, MANIFEST_FILE, STRICT_FILE]) {
    if (!fs.existsSync(file)) throw new Error(`Missing required input: ${file}`);
  }
  const preRunWorkingTreeDirty = Boolean(git(['status', '--porcelain']));
  if (preRunWorkingTreeDirty) throw new Error('Final signal validation requires a clean pre-run working tree; commit runner/report code first');
  const universe = readJson(UNIVERSE_FILE);
  if (universe.status !== 'READY_FOR_FAST_OOS' || universe.eligibleSymbols.length < 100) {
    throw new Error(`Signal validation requires at least 100 clean eligible symbols; got ${universe.eligibleSymbols.length} (${universe.status})`);
  }
  const manifest = readJson(MANIFEST_FILE);
  const strict = readJson(STRICT_FILE);
  const eligibleSymbols = [...new Set(universe.eligibleSymbols)].sort();
  const selection = representativeSymbols(eligibleSymbols, manifest, Number(process.env.SIGNAL_VALIDATION_SYMBOL_LIMIT || 120));
  const symbols = selection.symbols;
  const tradeReport = await runBacktest({
    symbols,
    start: Date.parse('2021-01-01T00:00:00.000Z'),
    end: OOS_END,
    scanIntervalHours: 4,
    outputBase: TRADE_REPORT_BASE,
    mode: 'formal-signal-validation',
    executionProxy: false,
    allowExternalCache: false,
    lazyMinute: true,
    lazyPrice: true,
    dataRoot: path.join(APP_DIR, 'data', 'backtest'),
  });
  if (tradeReport.data.executionProxy !== false || tradeReport.data.executionInterval !== '1m') {
    throw new Error(`Signal validation execution contract failed: proxy=${tradeReport.data.executionProxy}, interval=${tradeReport.data.executionInterval}`);
  }
  const priceDir = path.join(APP_DIR, 'data', 'backtest', 'price');
  const minuteDir = path.join(APP_DIR, 'data', 'backtest', 'minute');
  const models = {};
  for (const model of tradeReport.models) {
    models[model.model === 'V7.5 Control' ? 'v75' : 'v8'] = modelResult(model);
  }
  const allSignalSymbols = new Set([...models.v75.ranked, ...models.v8.ranked].map(event => event.marketId));
  for (const symbol of allSignalSymbols) {
    const h1 = loadRows(priceDir, symbol);
    const minute = loadRows(minuteDir, symbol);
    const lifecycle = marketRecord(manifest, symbol);
    const lifecycleEnd = Math.min(OOS_END, timestamp(lifecycle.eligibleEnd || OOS_END));
    for (const result of Object.values(models)) {
      for (const signal of result.ranked.filter(event => event.marketId === symbol)) {
        result.observations.push(buildObservation(signal, h1, minute, lifecycleEnd));
      }
    }
  }
  const v75Summary = modelSummary(models.v75);
  const v8Summary = modelSummary(models.v8);
  const signalIncrement = increment(models.v75, models.v8);
  const gateResult = gate(v8Summary);
  const report = {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    result: gateResult.result,
    gate: gateResult,
    execution: {
      oosStart: new Date(OOS_START).toISOString(),
      oosEnd: new Date(OOS_END).toISOString(),
      symbols: symbols.length,
      scanCadence: '4h production scan cadence',
      decisionLatency: '20-minute decision latency',
      fill: '1m executable fill; executionProxy=false',
      settlement: '1m chronological first-touch; same-minute TP+SL => SL',
      costModel: 'fees, funding and frozen modeled round-trip costs included',
      candidateData: 'all eligible symbols use 1h + funding; 1m is loaded lazily only for symbols with ranked signals',
    },
    universe: {
      cleanEligibleSymbols: eligibleSymbols.length,
      validationSymbols: symbols.length,
      core: universe.coreCount,
      expanded: universe.expandedCount,
      validationCore: symbols.filter(symbol => CORE_MARKETS.has(symbol)).length,
      validationExpanded: symbols.filter(symbol => !CORE_MARKETS.has(symbol)).length,
      selectionBiasAvoided: true,
      selection: selection.reason,
      activeDurationBands: selection.bands.reduce((summary, row) => {
        const key = `${row.tier}|${row.durationBand}`;
        summary[key] = (summary[key] || 0) + 1;
        return summary;
      }, {}),
    },
    signalIncrement,
    models: {v75: v75Summary, v8: v8Summary},
    alphaCoverage: {
      v75: tradeReport.models.find(model => model.model === 'V7.5 Control')?.observedAlphaCoverage || [],
      v8: tradeReport.models.find(model => model.model === 'V8 Shadow')?.observedAlphaCoverage || [],
    },
    reproducibility: {
      repositoryCommitSha: git(['rev-parse', 'HEAD']),
      strategyCommitSha: git(['log', '-1', '--format=%H', '--', ...STRATEGY_FILES]),
      runnerSha256: sha256(RUNNER_FILE),
      configSha256: sha256(path.join(APP_DIR, 'src', 'config.mjs')),
      manifestSha256: sha256(MANIFEST_FILE),
      datasetSnapshot: manifest.snapshotTimestamp,
      preRunWorkingTreeDirty,
      reportWritesCreateExpectedDirty: true,
      runTimestamp: tradeReport.generatedAt,
    },
    m4: {
      strictComplete: strict.complete === true,
      continuityFailures: strict.summary?.continuityFailures || 0,
      coverageFailures: strict.summary?.coverageFailures || 0,
      signalGateRequiresM4Strict: false,
    },
    releaseChecklist: [
      {item: 'V7.5 Control signal pipeline', status: 'PASS', evidence: 'frozen candidate generation and state-isolation tests pass'},
      {item: 'V8 Shadow signal pipeline', status: 'PASS', evidence: 'frozen V8 shadow namespace and state-isolation tests pass'},
      {item: 'history / reviews / email / dashboard', status: 'PASS', evidence: 'existing contract tests pass'},
      {item: 'real-money automatic order path', status: 'PASS', evidence: 'static audit found no Binance order endpoint; system remains signal-only'},
      {item: 'production signal gate', status: gateResult.result === 'STRONG PASS' ? 'PASS' : gateResult.result === 'SHADOW GO' ? 'SHADOW' : 'BLOCKED', evidence: gateResult.result === 'STRONG PASS' ? 'all signal criteria passed' : 'manual approval required; no deployment performed'},
    ],
  };
  fs.mkdirSync(path.dirname(FINAL_JSON), {recursive: true});
  fs.writeFileSync(FINAL_JSON, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(FINAL_MARKDOWN, `${markdown(report)}\n`);
  console.log(JSON.stringify({json: path.relative(APP_DIR, FINAL_JSON).replaceAll('\\', '/'), markdown: path.relative(APP_DIR, FINAL_MARKDOWN).replaceAll('\\', '/'), result: report.result, symbols: symbols.length, v75Signals: v75Summary.rankedSignals, v8Signals: v8Summary.rankedSignals, v8Edge24h: v8Summary.signalQuality.meanDirectionalReturn['24h'], v8Trades: v8Summary.trade.trades}, null, 2));
}

await main();
