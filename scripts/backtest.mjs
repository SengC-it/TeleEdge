import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {APP_DIR, CORE_MARKETS, DAY, H1, modelConfig, v8ShadowConfig, WORKSPACE_DIR} from '../src/config.mjs';
import {aggregate} from '../src/indicators.mjs';
import {buildBreadth, buildBtcEnvironment, generateLatestCandidates} from '../src/strategy.mjs';
import {generateV8ShadowCandidates} from '../src/v8-shadow.mjs';
import {recalculateFilledRisk} from '../src/fill-risk.mjs';
import {marketRules} from '../src/market-data.mjs';
import {rankCandidates} from '../src/portfolio.mjs';
import {allocateResearchRisk} from '../src/risk.mjs';
import {accrueFunding, calculateMetrics, cohortMetrics, priceAtOrBefore, settleOnCompletedBars} from '../src/backtest.mjs';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const SNAPSHOT_END = Date.parse('2026-07-15T00:00:00.000Z');
const INITIAL_EQUITY = 10_000;

function cliValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function dateValue(value, fallback) {
  if (value == null) return fallback;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function readGzipJson(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim();
  return text ? JSON.parse(text) : [];
}

function loadRows(directory, symbol, funding = false) {
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory)
    .filter(name => name.match(new RegExp(`^${symbol}-\\d+\\.json\\.gz$`)))
    .sort((a, b) => Number(a.match(/-(\d+)\./)[1]) - Number(b.match(/-(\d+)\./)[1]));
  const sourceFiles = files.length
    ? files
    : (fs.existsSync(path.join(directory, `${symbol}.json.gz`)) ? [`${symbol}.json.gz`] : []);
  const byTime = new Map();
  for (const file of sourceFiles) {
    for (const row of readGzipJson(path.join(directory, file))) {
      const t = Number(row.t ?? row.fundingTime);
      if (!Number.isFinite(t)) continue;
      byTime.set(t, funding ? {t, rate: Number(row.rate ?? row.fundingRate), markPrice: Number(row.markPrice) || null}
        : {t, o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c), q: Number(row.q || 0)});
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function completedSlice(rows, endTime, period = H1) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].t + period <= endTime) low = middle + 1;
    else high = middle;
  }
  return rows.slice(0, low);
}

function beforeSlice(rows, endTime) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].t < endTime) low = middle + 1;
    else high = middle;
  }
  return rows.slice(0, low);
}

function nextBar(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].t < timestamp) low = middle + 1;
    else high = middle;
  }
  return rows[low] ?? null;
}

function exchangeMarkets(dataRoot, externalCache) {
  const file = externalCache
    ? path.join(dataRoot, 'v60_full_universe_cache', 'exchangeInfo.json')
    : path.join(dataRoot, 'exchangeInfo.json');
  if (!fs.existsSync(file)) return new Map();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map((parsed.symbols || []).map(item => [item.symbol, item]));
}

function marketFor(symbol, exchange) {
  const item = exchange.get(symbol) || {};
  return {
    symbol,
    baseAsset: item.baseAsset || symbol.replace(/USDT$/, ''),
    onboardDate: Number(item.onboardDate) || 0,
    filters: item.filters || [],
    core: CORE_MARKETS.has(symbol),
  };
}

function makeScanTimes(start, end, stepDays) {
  const first = Math.ceil(start / DAY) * DAY;
  const step = Math.max(1, Math.round(stepDays)) * DAY;
  const output = [];
  for (let t = first; t < end; t += step) output.push(t);
  return output;
}

function signalEvent(candidate, model) {
  return {
    model,
    signalTime: candidate.t,
    marketId: candidate.marketId,
    side: candidate.side,
    family: candidate.family,
    alpha: candidate.alpha || (model === 'V7.5' ? 'control' : 'unknown'),
    btcRouter: candidate.btcRouter || 'unknown',
    edgeScore: candidate.edgeScore,
  };
}

function createModel(name, v8 = false) {
  return {
    name,
    v8,
    equity: INITIAL_EQUITY,
    peakEquity: INITIAL_EQUITY,
    open: [],
    trades: [],
    signalEvents: [],
    allocations: [],
    knownSignalIds: new Set(),
    rejectionReasons: {},
    acceptedSignals: 0,
  };
}

function recordReject(model, reason) {
  model.rejectionReasons[reason] = (model.rejectionReasons[reason] || 0) + 1;
}

function settleOpen(model, dataBySymbol, now, costRate) {
  const kept = [];
  for (const position of model.open) {
    const data = dataBySymbol.get(position.marketId);
    if (!data) {
      kept.push(position);
      continue;
    }
    const result = settleOnCompletedBars(position, data.h1, data.funding, {
      now,
      costRate,
      priceAt: timestamp => priceAtOrBefore(data.h1, timestamp, position.entry),
    });
    if (!result.closed) {
      kept.push(result.position);
      continue;
    }
    model.trades.push(result.trade);
    model.equity += result.trade.netPnlUsdt;
    model.peakEquity = Math.max(model.peakEquity, model.equity);
  }
  model.open = kept;
}

function createPosition(model, candidate, data, scanTime) {
  const fillBar = nextBar(data.h1, candidate.t);
  if (!fillBar || fillBar.t >= SNAPSHOT_END) return {reason: 'fill-price-unavailable'};
  const fillPrice = Number(fillBar.o);
  const filledRisk = recalculateFilledRisk({
    side: candidate.side,
    family: candidate.family,
    fillPrice,
    stop: candidate.sl,
    targetR: candidate.targetR,
    tickSize: marketRules(data.market).tickSize,
  });
  if (!filledRisk.accepted) return {reason: filledRisk.reason};
  const riskPerUnit = Math.abs(filledRisk.fillPrice - filledRisk.stop);

  let allocation;
  if (model.v8) {
    allocation = allocateResearchRisk({
      equityUsdt: model.equity,
      peakEquityUsdt: model.peakEquity,
      candidate: {...candidate, stopPct: filledRisk.stopPct},
      openPositions: model.open,
      closedPositions: model.trades,
    });
  } else {
    const riskUsdt = model.equity * modelConfig.riskFraction;
    allocation = {accepted: true, riskUsdt, riskFraction: modelConfig.riskFraction, method: 'frozen-control'};
  }
  if (!allocation.accepted) return {reason: allocation.reason, allocation};
  const quantity = allocation.riskUsdt / riskPerUnit;
  return {
    position: {
      id: candidate.id,
      modelVersion: model.v8 ? v8ShadowConfig.version : modelConfig.version,
      mode: model.v8 ? 'paper-shadow' : 'paper-backtest',
      status: 'open',
      marketId: candidate.marketId,
      symbol: candidate.symbol,
      side: candidate.side,
      alpha: candidate.alpha || (model.v8 ? 'unknown' : 'control'),
      family: candidate.family,
      route: candidate.route,
      signalTime: candidate.t,
      signalPrice: candidate.signalPrice ?? candidate.entry,
      decisionTime: scanTime,
      fillTime: fillBar.t,
      fillPrice: filledRisk.fillPrice,
      entry: filledRisk.fillPrice,
      stop: filledRisk.stop,
      target: filledRisk.target,
      targetR: filledRisk.targetR,
      effectiveTargetR: filledRisk.effectiveTargetR,
      stopPct: filledRisk.stopPct,
      quantity,
      notionalUsdt: filledRisk.fillPrice * quantity,
      riskUsdt: allocation.riskUsdt,
      fundingPnlUsdt: 0,
      lastFundingTime: fillBar.t,
      lastCheckedAt: fillBar.t,
      btcRouter: candidate.btcRouter,
      features: {...candidate.features, btcRouter: candidate.btcRouter, riskAllocation: allocation},
    },
    allocation,
  };
}

function processCandidates(model, candidates, dataBySymbol, scanTime) {
  const unseen = candidates.filter(candidate => !model.knownSignalIds.has(candidate.id));
  model.signalEvents.push(...unseen.map(candidate => signalEvent(candidate, model.name)));
  const ranked = rankCandidates(unseen);
  const cap = model.v8 ? v8ShadowConfig.positionCap : modelConfig.cap;
  const maxPerSide = model.v8 ? v8ShadowConfig.maxPerSide : modelConfig.maxPerSide;
  for (const candidate of ranked) {
    let reason = null;
    if (model.open.some(position => position.marketId === candidate.marketId)) reason = 'symbol-already-open';
    else if (model.open.length >= cap) reason = 'portfolio-cap';
    else if (model.open.filter(position => position.side === candidate.side).length >= maxPerSide) reason = 'side-cap';
    const data = dataBySymbol.get(candidate.marketId);
    const created = !reason && data ? createPosition(model, candidate, data, scanTime) : null;
    if (!reason && !created?.position) reason = created?.reason || 'market-data-unavailable';
    if (reason) {
      recordReject(model, reason);
      continue;
    }
    model.open.push(created.position);
    model.allocations.push(created.allocation);
    model.acceptedSignals++;
  }
  for (const candidate of unseen) model.knownSignalIds.add(candidate.id);
}

function closeAtEnd(model, dataBySymbol, endTime, costRate) {
  for (const position of model.open) {
    const data = dataBySymbol.get(position.marketId);
    if (!data) continue;
    const accrued = accrueFunding(position, data.funding, timestamp => priceAtOrBefore(data.h1, timestamp, position.entry), endTime + 1);
    const exitPrice = priceAtOrBefore(data.h1, endTime - 1, position.entry);
    const direction = position.side === 'long' ? 1 : -1;
    const grossPnlUsdt = direction * (exitPrice - position.entry) * position.quantity;
    const modeledCostUsdt = costRate * position.entry * position.quantity;
    const netPnlUsdt = grossPnlUsdt + accrued.position.fundingPnlUsdt - modeledCostUsdt;
    const trade = {
      ...accrued.position,
      status: 'closed',
      exitReason: 'end_of_sample',
      exitPrice,
      exitTime: endTime,
      ambiguousSameMinute: false,
      grossPnlUsdt,
      modeledCostUsdt,
      netPnlUsdt,
      netR: position.riskUsdt ? netPnlUsdt / position.riskUsdt : null,
    };
    model.trades.push(trade);
    model.equity += netPnlUsdt;
    model.peakEquity = Math.max(model.peakEquity, model.equity);
  }
  model.open = [];
}

function modelReport(model, start, end) {
  const segments = {
    train: [start, Date.parse('2024-01-01T00:00:00Z')],
    validation: [Date.parse('2024-01-01T00:00:00Z'), Date.parse('2025-01-01T00:00:00Z')],
    oos: [Date.parse('2025-01-01T00:00:00Z'), end],
  };
  const walkForward = {
    '2025': {
      trainingWindow: [start, Date.parse('2025-01-01T00:00:00Z')],
      oos: cohortMetrics(model.trades, model.signalEvents, Date.parse('2025-01-01T00:00:00Z'), Math.min(Date.parse('2026-01-01T00:00:00Z'), end), {initialEquity: INITIAL_EQUITY}),
    },
    '2026-H1': {
      trainingWindow: [start, Date.parse('2026-01-01T00:00:00Z')],
      oos: cohortMetrics(model.trades, model.signalEvents, Date.parse('2026-01-01T00:00:00Z'), end, {initialEquity: INITIAL_EQUITY}),
    },
  };
  return {
    model: model.name,
    modelVersion: model.v8 ? v8ShadowConfig.version : modelConfig.version,
    full: calculateMetrics(model.trades, {signals: model.signalEvents.length, initialEquity: INITIAL_EQUITY, periodStart: start, periodEnd: end}),
    splits: Object.fromEntries(Object.entries(segments).map(([name, [from, to]]) => [name, cohortMetrics(model.trades, model.signalEvents, from, to, {initialEquity: INITIAL_EQUITY})])),
    walkForward,
    acceptedSignals: model.acceptedSignals,
    rejectionReasons: model.rejectionReasons,
    openAtEnd: model.open.length,
  };
}

function markdownMetric(value, digits = 3) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

function markdownReport(report) {
  const rows = ['V7.5 Control', 'V8 Shadow'].map(name => {
    const item = report.models.find(model => model.model === name);
    const oos = item.splits.oos;
    return `| ${name} | ${oos.trades} | ${markdownMetric(oos.signalsPerMonth)} | ${markdownMetric(oos.winRate == null ? null : oos.winRate * 100, 1)}% | ${markdownMetric(oos.expectancyR)} | ${markdownMetric(oos.profitFactor)} | ${markdownMetric(oos.maxDrawdownPct == null ? null : oos.maxDrawdownPct * 100, 1)}% | ${markdownMetric(oos.fundingPnlUsdt, 2)} | ${markdownMetric(oos.feesAndCostsUsdt, 2)} |`;
  }).join('\n');
  const walkForwardRows = report.models.flatMap(model => ['2025', '2026-H1'].map(fold => {
    const item = model.walkForward[fold].oos;
    return `| ${fold} | ${model.model} | ${item.trades} | ${markdownMetric(item.netExpectancyR)} | ${markdownMetric(item.profitFactor)} | ${markdownMetric(item.maxDrawdownPct == null ? null : item.maxDrawdownPct * 100, 1)}% |`;
  })).join('\n');
  const comparison = report.comparison;
  return `# TeleEdge ${report.data.scopeLabel}\n\n` +
    `本报告由 \`${report.data.command}\` 生成，数据快照时间为 ${report.data.snapshotEnd}。状态：**${report.data.status}**；仅用于研究，不构成盈利结论，也不改变 V7.5 paper 控制。\n\n` +
    `## OOS cohort（按 signal time）\n\n` +
    `| 模型 | Trades | Signals/月 | Win rate | Net expectancy (R) | Profit factor | Max drawdown | Funding PnL | Modeled costs |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    `V8 − V7.5 OOS expectancy: **${markdownMetric(comparison.netExpectancyRDelta)} R**；profit factor delta: **${markdownMetric(comparison.profitFactorDelta)}**；max drawdown delta: **${markdownMetric(comparison.maxDrawdownPctDelta * 100, 1)} pp**。\n\n` +
    `## Walk-forward folds\n\n| Fold | Model | Trades | Net expectancy (R) | Profit factor | Max drawdown |\n|---|---|---:|---:|---:|---:|\n${walkForwardRows}\n\n` +
    `## 设计与限制\n\n` +
    `- 信号只读取 scan time 之前的完整 1h 数据；成交使用 signal 后第一根 1h 的开盘价，禁止使用 signal close 作为成交价。\n` +
    `- SL/TP 在完整 1h bar 上结算，若同一 bar 同时触发，SL 优先；资金费使用历史事件，缺少 mark price 时回退到事件前最近 1h close。\n` +
    `- V7.5 使用冻结 0.6% 风险；V8 使用独立 research allocator（edge/liquidity/volatility/portfolio correlation/drawdown/loss streak）。\n` +
    `- 当前样本为 ${report.data.symbols.length} 个币种、${report.data.sampleSize.priceRows} 根 1h 价格记录和 ${report.data.sampleSize.fundingRows} 条资金费记录；这不是完整 V7.5 Control OOS。\n` +
    `- 生产策略 Alpha 覆盖要求：daily breakout long、funding crowding short、volume shock short、V8 bear trend short；本报告的固定样本没有完成 expanded/non-core universe 和 point-in-time universe 验证。\n` +
    `- 当前 exchangeInfo 快照无法证明没有历史退市 survivorship bias，结果不应外推到全市场。\n` +
    `- ${report.conclusion}\n\n` +
    `## Splits\n\n` +
    `训练集：2021-01-01—2023-12-31；验证集：2024；walk-forward OOS：2025 及 2026-H1。参数在本次运行中没有用 OOS 调优。\n`;
}

export async function runBacktest({symbols = DEFAULT_SYMBOLS, start = Date.parse('2021-01-01T00:00:00Z'), end = SNAPSHOT_END, stepDays = 1, outputBase = path.join(APP_DIR, 'reports', 'teleedge-oos-backtest'), mode = 'smoke', allowExternalCache = false, dataRoot: requestedDataRoot = null} = {}) {
  const dataRoot = requestedDataRoot || (allowExternalCache ? WORKSPACE_DIR : path.join(APP_DIR, 'data', 'backtest'));
  const legacyLayout = allowExternalCache || fs.existsSync(path.join(dataRoot, 'v38_price_cache'));
  const priceDir = legacyLayout ? path.join(dataRoot, 'v38_price_cache') : path.join(dataRoot, 'price');
  const fundingDir = legacyLayout ? path.join(dataRoot, 'v38_funding_cache') : path.join(dataRoot, 'funding');
  const exchange = exchangeMarkets(dataRoot, legacyLayout);
  const manifestFile = legacyLayout ? path.join(APP_DIR, 'data', 'backtest-manifest.json') : path.join(dataRoot, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const dataBySymbol = new Map();
  const missing = [];
  for (const symbol of symbols) {
    const h1 = loadRows(priceDir, symbol);
    const funding = loadRows(fundingDir, symbol, true);
    if (!h1.length || !funding.length) missing.push({symbol, priceRows: h1.length, fundingRows: funding.length});
    const daily = aggregate(h1.filter(row => row.t + H1 <= end), DAY, end);
    const bars4h = aggregate(h1.filter(row => row.t + H1 <= end), 4 * H1, end);
    dataBySymbol.set(symbol, {market: marketFor(symbol, exchange), h1, funding, daily, bars4h});
  }
  const available = [...dataBySymbol].filter(([, data]) => data.h1.length && data.funding.length);
  if (!available.length) throw new Error(`No backtest data under ${dataRoot}. Run npm run backtest:fetch or explicitly use npm run backtest:smoke for the legacy external cache.`);
  const dailyByMarket = new Map(available.map(([symbol, data]) => [symbol, data.daily]));
  const breadthByTime = buildBreadth(dailyByMarket);
  const btcEnvironment = buildBtcEnvironment(dailyByMarket.get('BTCUSDT') || []);
  const scanTimes = makeScanTimes(start, end, stepDays);
  const control = createModel('V7.5 Control');
  const shadow = createModel('V8 Shadow', true);
  for (const scanTime of scanTimes) {
    const settleTime = scanTime + 1;
    settleOpen(control, dataBySymbol, settleTime, modelConfig.stressRoundTripCost);
    settleOpen(shadow, dataBySymbol, settleTime, modelConfig.stressRoundTripCost);
    for (const [symbol, data] of available) {
      const h1 = completedSlice(data.h1, scanTime, H1);
      const funding = beforeSlice(data.funding, scanTime);
      const daily = completedSlice(data.daily, scanTime, DAY);
      const bars4h = completedSlice(data.bars4h, scanTime, 4 * H1);
      const args = {market: data.market, h1, daily, bars4h, funding, breadthByTime, btcEnvironment, endTime: scanTime};
      const controlCandidates = generateLatestCandidates(args).filter(candidate => candidate.t === scanTime);
      const shadowCandidates = generateV8ShadowCandidates(args).filter(candidate => candidate.t === scanTime);
      processCandidates(control, controlCandidates, dataBySymbol, scanTime);
      processCandidates(shadow, shadowCandidates, dataBySymbol, scanTime);
    }
  }
  closeAtEnd(control, dataBySymbol, end, modelConfig.stressRoundTripCost);
  closeAtEnd(shadow, dataBySymbol, end, modelConfig.stressRoundTripCost);
  const models = [modelReport(control, start, end), modelReport(shadow, start, end)];
  const controlOos = models[0].splits.oos;
  const shadowOos = models[1].splits.oos;
  const comparison = {
    netExpectancyRDelta: (shadowOos.netExpectancyR ?? 0) - (controlOos.netExpectancyR ?? 0),
    profitFactorDelta: (shadowOos.profitFactor ?? 0) - (controlOos.profitFactor ?? 0),
    maxDrawdownPctDelta: (shadowOos.maxDrawdownPct ?? 0) - (controlOos.maxDrawdownPct ?? 0),
    netPnlUsdtDelta: (shadowOos.netPnlUsdt ?? 0) - (controlOos.netPnlUsdt ?? 0),
  };
  const insufficient = models.some(model => model.splits.oos.trades < 30);
  const report = {
    generatedAt: new Date().toISOString(),
    data: {
      source: legacyLayout ? 'external workspace cache (smoke only)' : 'repository data/backtest artifacts',
      mode,
      scopeLabel: 'smoke backtest (M4 INCOMPLETE)',
      status: 'M4-INCOMPLETE',
      formalEligible: false,
      command: legacyLayout ? 'npm run backtest:smoke' : 'npm run backtest',
      dataRoot: path.relative(APP_DIR, dataRoot).replaceAll('\\', '/') || '.',
      manifest: path.relative(APP_DIR, manifestFile).replaceAll('\\', '/'),
      snapshotEnd: new Date(end).toISOString(),
      snapshotTimestamp: manifest?.snapshotTimestamp || new Date(end).toISOString(),
      exchangeInfo: legacyLayout ? 'external workspace/v60_full_universe_cache/exchangeInfo.json' : 'data/backtest/exchangeInfo.json',
      symbols,
      missing,
      fixedUniverse: symbols.length === DEFAULT_SYMBOLS.length && symbols.every(symbol => DEFAULT_SYMBOLS.includes(symbol)),
      pointInTimeUniverse: Boolean(manifest?.universe?.pointInTime),
      historicalDelistingsResolved: Boolean(manifest?.universe?.historicalDelistingsResolved),
      sampleSize: {
        priceRows: available.reduce((sum, [, data]) => sum + data.h1.length, 0),
        fundingRows: available.reduce((sum, [, data]) => sum + data.funding.length, 0),
        symbolsWithBothFeeds: available.length,
      },
      alphaCoverage: ['daily_breakout_long', 'funding_crowding_short', 'volume_shock_short', 'v8_bear_trend_short'],
      survivorshipWarning: 'Current snapshot exchangeInfo does not contain historical delistings; this is not a full-universe survivorship-free result.',
    },
    methodology: {
      scanCadence: `${stepDays}d at UTC day boundary`,
      train: ['2021-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'],
      validation: ['2024-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'],
      walkForwardOos: ['2025-01-01T00:00:00.000Z', new Date(end).toISOString()],
      signalCohort: 'signalTime',
      fill: 'first 1h bar at or after signal time, open price',
      settlement: 'completed 1h bars; SL priority on same bar',
      funding: 'historical funding rows; markPrice fallback to prior completed 1h close',
      costRate: modelConfig.stressRoundTripCost,
      lookaheadGuards: ['completed h1 slice', 'next-bar open fill', 'completed-bar-only settlement', 'no OOS parameter tuning'],
      alphaCoverage: ['daily_breakout_long', 'funding_crowding_short', 'volume_shock_short', 'v8_bear_trend_short'],
    },
    models,
    comparison,
    conclusion: `M4 INCOMPLETE：${insufficient
      ? 'OOS 样本量不足（任一模型少于 30 笔），因此不报告统计显著的盈利或 V8 优越性结论。'
      : '即使固定样本达到最低门槛，仍缺少 expanded/non-core Alpha 的完整 point-in-time universe 和历史退市处理；不报告完整 V7.5 OOS 或 V8 优越性结论。'}`,
  };
  fs.mkdirSync(path.dirname(outputBase), {recursive: true});
  fs.writeFileSync(`${outputBase}.json`, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(`${outputBase}.md`, `${markdownReport(report)}\n`);
  return report;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/backtest.mjs')) {
  const symbols = (cliValue('--symbols', process.env.BACKTEST_SYMBOLS || DEFAULT_SYMBOLS.join(',')) || '')
    .split(',').map(item => item.trim().toUpperCase()).filter(Boolean);
  const start = dateValue(cliValue('--start', process.env.BACKTEST_START), Date.parse('2021-01-01T00:00:00Z'));
  const requestedEnd = dateValue(cliValue('--end', process.env.BACKTEST_END), SNAPSHOT_END);
  const end = Math.min(requestedEnd, SNAPSHOT_END);
  const stepDays = Number(cliValue('--step-days', process.env.BACKTEST_STEP_DAYS || 1));
  const output = cliValue('--output', path.join(APP_DIR, 'reports', 'teleedge-oos-backtest'));
  const mode = cliValue('--mode', process.env.BACKTEST_MODE || 'smoke');
  const allowExternalCache = process.argv.includes('--allow-external-cache');
  const dataRoot = cliValue('--data-root', process.env.BACKTEST_DATA_ROOT || null);
  const report = await runBacktest({symbols, start, end, stepDays, outputBase: output, mode, allowExternalCache, dataRoot});
  for (const model of report.models) {
    const oos = model.splits.oos;
    console.log(`${model.model}: trades=${oos.trades} expectancyR=${oos.netExpectancyR ?? 'n/a'} PF=${oos.profitFactor ?? 'n/a'} MDD=${oos.maxDrawdownPct ?? 'n/a'}`);
  }
  console.log(`Reports: ${output}.json and ${output}.md`);
}
