import {H1, modelConfig} from '../config.mjs';
import {firstCompletedTouch, settleOnCompletedBars} from '../backtest.mjs';
import {evaluateCandidateAcceptance} from '../portfolio.mjs';

const DECISION_LATENCY_MS = 20 * 60_000;
const STATIC_REJECTIONS = new Set(['symbol-already-open', 'symbol-cooldown', 'portfolio-cap', 'side-cap', 'market-data-unavailable', 'invalid-market-tick', 'invalid-market-step']);

function syntheticTouchBar(position, touch) {
  const interval = H1 / 60;
  const both = Boolean(touch.ambiguous);
  const entry = Number(position.entry);
  const stop = Number(position.stop);
  const target = Number(position.target);
  const long = position.side === 'long';
  const isStop = touch.reason === 'sl';
  const high = long
    ? (isStop ? (both ? target : entry) : target)
    : (isStop ? stop : (both ? stop : entry));
  const low = long
    ? (isStop ? stop : (both ? stop : entry))
    : (isStop ? (both ? target : entry) : target);
  return {t: Number(touch.time) - interval, o: entry, h: high, l: low, c: Number(touch.price)};
}

function fallbackTouchProfile(position, data, endTime) {
  const rows = typeof data.loadMinute === 'function' ? data.loadMinute(position.marketId) : [];
  const touch = firstCompletedTouch(position, rows, Number(endTime) + 1, H1 / 60);
  const through = touch?.time ?? Number(endTime);
  const interval = H1 / 60;
  const firstEligible = Math.ceil(Number(position.fillTime) / interval) * interval;
  const excursionRows = rows.filter(row => Number(row.t) >= firstEligible && Number(row.t) + interval <= through);
  const entry = Number(position.entry);
  const direction = position.side === 'long' ? 1 : -1;
  return {
    touch,
    mfe: excursionRows.length ? Math.max(...excursionRows.map(row => direction === 1 ? Number(row.h) / entry - 1 : 1 - Number(row.l) / entry)) : null,
    mae: excursionRows.length ? Math.min(...excursionRows.map(row => direction === 1 ? Number(row.l) / entry - 1 : 1 - Number(row.h) / entry)) : null,
  };
}

export const PORTFOLIO_CONFIG = Object.freeze({
  initialEquityUsdt: 10_000,
  positionCap: modelConfig.cap,
  sideCap: modelConfig.maxPerSide,
  cooldownMs: modelConfig.cooldownMs,
  riskFraction: modelConfig.riskFraction,
  decisionLatencyMs: DECISION_LATENCY_MS,
  executionInterval: '1m',
  sameMinuteTpSl: 'sl',
  costRate: modelConfig.stressRoundTripCost,
});

export function createResearchPortfolioState(initialEquityUsdt = PORTFOLIO_CONFIG.initialEquityUsdt) {
  return {
    equityUsdt: initialEquityUsdt,
    peakEquityUsdt: initialEquityUsdt,
    realizedPnlUsdt: 0,
    positions: [],
    closedTrades: [],
    rejected: [],
    accepted: [],
    cooldowns: {},
    lastDecisionTime: null,
  };
}

function settleOpenPositions(state, now, data, costRate) {
  const remaining = [];
  for (const position of state.positions) {
    const fundingRows = data.loadFunding(position.marketId, position.lastFundingTime, now + 1);
    const touch = position.plannedTouch && Number(position.plannedTouch.time) < Number(now) ? position.plannedTouch : null;
    const settled = settleOnCompletedBars(position, touch ? [syntheticTouchBar(position, touch)] : [], fundingRows, {
      now: Number(now) + 1,
      costRate,
      barIntervalMs: H1 / 60,
      priceAt: timestamp => data.priceAt(position.marketId, timestamp),
    });
    if (!settled.closed) {
      remaining.push(settled.position);
      continue;
    }
    const trade = tradeSummary(settled.trade);
    state.closedTrades.push(trade);
    state.realizedPnlUsdt += Number(trade.netPnlUsdt) || 0;
    state.equityUsdt += Number(trade.netPnlUsdt) || 0;
    state.peakEquityUsdt = Math.max(state.peakEquityUsdt, state.equityUsdt);
    state.cooldowns[position.marketId] = Number(trade.exitTime);
    data.release(position.marketId);
  }
  state.positions = remaining;
  state.lastDecisionTime = now;
}

function closeAtEnd(state, endTime, data, costRate) {
  for (const position of state.positions) {
    const fundingRows = data.loadFunding(position.marketId, position.lastFundingTime, Number(endTime) + 1);
    const touch = position.plannedTouch && Number(position.plannedTouch.time) <= Number(endTime) ? position.plannedTouch : null;
    const settled = settleOnCompletedBars(position, touch ? [syntheticTouchBar(position, touch)] : [], fundingRows, {
      now: Number(endTime) + 1,
      costRate,
      barIntervalMs: H1 / 60,
      priceAt: timestamp => data.priceAt(position.marketId, timestamp),
    });
    if (settled.closed) {
      const trade = tradeSummary(settled.trade);
      state.closedTrades.push(trade);
      state.realizedPnlUsdt += Number(trade.netPnlUsdt) || 0;
      state.equityUsdt += Number(trade.netPnlUsdt) || 0;
      state.peakEquityUsdt = Math.max(state.peakEquityUsdt, state.equityUsdt);
      data.release(position.marketId);
      continue;
    }
    const marked = settled.position;
    const fallbackRows = typeof data.lastMinuteClose === 'function' ? null : (typeof data.loadMinute === 'function' ? data.loadMinute(position.marketId) : []);
    const fallbackLast = fallbackRows?.filter(row => Number(row.t) + H1 / 60 <= Number(endTime)).at(-1);
    const exitPrice = (typeof data.lastMinuteClose === 'function'
      ? data.lastMinuteClose(position.marketId, marked.fillTime, endTime)
      : fallbackLast?.c) ?? Number(marked.entry);
    const direction = marked.side === 'long' ? 1 : -1;
    const grossPnlUsdt = direction * (exitPrice - Number(marked.entry)) * Number(marked.quantity);
    const modeledCostUsdt = costRate * Number(marked.entry) * Number(marked.quantity);
    const netPnlUsdt = grossPnlUsdt + Number(marked.fundingPnlUsdt || 0) - modeledCostUsdt;
    const trade = {
      ...marked,
      status: 'closed', exitReason: 'end_of_sample', exitPrice,
      exitTime: Number(endTime), grossPnlUsdt, modeledCostUsdt, netPnlUsdt,
      netR: Number(marked.riskUsdt) > 0 ? netPnlUsdt / Number(marked.riskUsdt) : null,
    };
    state.closedTrades.push(tradeSummary(trade));
    state.realizedPnlUsdt += netPnlUsdt;
    state.equityUsdt += netPnlUsdt;
    state.peakEquityUsdt = Math.max(state.peakEquityUsdt, state.equityUsdt);
    data.release(position.marketId);
  }
  state.positions = [];
}

function candidateSummary(candidate) {
  return {
    id: candidate.id,
    marketId: candidate.marketId,
    side: candidate.side,
    alpha: candidate.alpha,
    t: candidate.t,
    tier: candidate.tier,
  };
}

function tradeSummary(trade) {
  return {
    id: trade.id, marketId: trade.marketId, symbol: trade.symbol, side: trade.side,
    alpha: trade.alpha, alphaSources: trade.alphaSources, regime: trade.regime, tier: trade.tier,
    signalTime: trade.signalTime, decisionTime: trade.decisionTime, fillTime: trade.fillTime,
    fillPrice: trade.fillPrice, entry: trade.entry, stop: trade.stop, target: trade.target,
    targetR: trade.targetR, effectiveTargetR: trade.effectiveTargetR, stopPct: trade.stopPct,
    quantity: trade.quantity, notionalUsdt: trade.notionalUsdt, riskUsdt: trade.riskUsdt,
    fundingPnlUsdt: trade.fundingPnlUsdt, status: trade.status, exitReason: trade.exitReason,
    exitPrice: trade.exitPrice, exitTime: trade.exitTime, grossPnlUsdt: trade.grossPnlUsdt,
    modeledCostUsdt: trade.modeledCostUsdt, netPnlUsdt: trade.netPnlUsdt, netR: trade.netR,
    mfe: trade.mfe, mae: trade.mae,
  };
}

export async function simulatePortfolio(cycles, data, {
  endTime,
  initialEquityUsdt = PORTFOLIO_CONFIG.initialEquityUsdt,
  positionCap = PORTFOLIO_CONFIG.positionCap,
  sideCap = PORTFOLIO_CONFIG.sideCap,
  costRate = PORTFOLIO_CONFIG.costRate,
} = {}) {
  const state = createResearchPortfolioState(initialEquityUsdt);
  let rankedCount = 0;
  for await (const cycle of cycles) {
    const ranked = Array.isArray(cycle) ? cycle : [cycle];
    if (!ranked.length) continue;
    const decisionTime = Number(ranked[0].t) + DECISION_LATENCY_MS;
    settleOpenPositions(state, decisionTime, data, costRate);
    for (const candidate of ranked) {
      const market = data.marketBySymbol.get(candidate.marketId);
      const preflight = evaluateCandidateAcceptance(candidate, {
        activePositions: state.positions,
        cooldowns: state.cooldowns,
        equityUsdt: state.equityUsdt,
        market,
        decisionTime,
        fillTime: decisionTime,
        fillPrice: candidate.entry,
        strictFill: false,
        positionCap,
        sideCap,
      });
      if (STATIC_REJECTIONS.has(preflight.reason)) {
        state.rejected.push({candidate: candidateSummary(candidate), reason: preflight.reason});
        continue;
      }
      const firstMinute = data.firstMinute(candidate.marketId, decisionTime, endTime);
      const acceptance = evaluateCandidateAcceptance(candidate, {
        activePositions: state.positions,
        cooldowns: state.cooldowns,
        equityUsdt: state.equityUsdt,
        market,
        decisionTime,
        fillTime: firstMinute?.t,
        fillPrice: firstMinute?.o ?? firstMinute?.c,
        strictFill: true,
        positionCap,
        sideCap,
      });
      rankedCount++;
      if (!acceptance.accepted) {
        state.rejected.push({candidate: candidateSummary(candidate), reason: acceptance.reason});
        if (!state.positions.some(position => position.marketId === candidate.marketId)) data.release(candidate.marketId, {keep: true});
        continue;
      }
      const position = {
        id: candidate.id,
        modelVersion: candidate.modelVersion,
        mode: 'paper-research',
        status: 'open',
        marketId: candidate.marketId,
        symbol: candidate.symbol,
        side: candidate.side,
        alpha: candidate.alpha,
        alphaSources: candidate.alphaSources || [candidate.alpha],
        family: candidate.family,
        regime: candidate.regime,
        tier: candidate.tier,
        signalTime: candidate.t,
        signalPrice: candidate.signalPrice,
        decisionTime,
        fillTime: acceptance.fillTime,
        fillPrice: acceptance.fillPrice,
        entry: acceptance.fillPrice,
        stop: acceptance.filledRisk.stop,
        target: acceptance.filledRisk.target,
        targetR: acceptance.filledRisk.targetR,
        effectiveTargetR: acceptance.filledRisk.effectiveTargetR,
        stopPct: acceptance.filledRisk.stopPct,
        quantity: acceptance.quantity,
        notionalUsdt: acceptance.fillPrice * acceptance.quantity,
        riskUsdt: acceptance.riskUsdt,
        fundingPnlUsdt: 0,
        lastFundingTime: acceptance.fillTime,
        lastCheckedAt: acceptance.fillTime,
        features: candidate.features,
      };
      const profile = typeof data.firstTouch === 'function'
        ? data.firstTouch(position, endTime)
        : fallbackTouchProfile(position, data, endTime);
      position.plannedTouch = profile.touch;
      position.mfe = profile.mfe;
      position.mae = profile.mae;
      data.retain?.(candidate.marketId);
      state.positions.push(position);
      state.accepted.push({candidate: candidateSummary(candidate), positionId: position.id});
    }
  }
  if (Number.isFinite(Number(endTime))) closeAtEnd(state, endTime, data, costRate);
  return {state, accepted: state.accepted, rejected: state.rejected, closedTrades: state.closedTrades, rankedCount};
}
