import {PORTFOLIO_CONFIG} from '../v81/portfolio.mjs';

export const PROFIT_PORTFOLIO_CONFIG = Object.freeze({
  initialEquityUsdt: 10_000, riskFraction: 0.006, maxPositions: 10, maxPerSide: 8,
  sameTimestampSide: 3, cooldownHours: 72, costRate: PORTFOLIO_CONFIG.costRate,
});

function compare(a, b) { return Number(b.predictedNetR) - Number(a.predictedNetR) || Number(b.pPositiveNetR) - Number(a.pPositiveNetR) || Number(b.r1Score) - Number(a.r1Score) || String(a.id).localeCompare(String(b.id)); }

export function simulateQualifiedPortfolio(rows, {initialEquityUsdt = PROFIT_PORTFOLIO_CONFIG.initialEquityUsdt} = {}) {
  const eligible = [...(rows || [])].filter(row => row.executable);
  const cycles = new Map();
  for (const row of eligible) {
    const key = `${row.signalTime}|${row.side}`;
    if (!cycles.has(key)) cycles.set(key, []);
    cycles.get(key).push(row);
  }
  const top3 = [...cycles.values()].flatMap(group => group.sort(compare).slice(0, PROFIT_PORTFOLIO_CONFIG.sameTimestampSide));
  const ordered = top3.filter(row => row.qualified).sort((a, b) => Number(a.decisionTime ?? a.signalTime) - Number(b.decisionTime ?? b.signalTime) || compare(a, b));
  const open = []; const cooldowns = new Map(); const accepted = []; const rejected = []; const trades = []; let equity = initialEquityUsdt; let peak = equity; let maxDrawdown = 0;
  for (const row of ordered) {
    const decision = Number(row.decisionTime ?? row.signalTime);
    for (let index = open.length - 1; index >= 0; index--) {
      if (Number(open[index].exitTime) <= decision) { const closed = open.splice(index, 1)[0]; trades.push(closed); equity += Number(closed.netPnlUsdt || 0); peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); cooldowns.set(closed.marketId || closed.symbol, Number(closed.exitTime)); }
    }
    const marketId = row.marketId || row.symbol;
    if (open.some(position => (position.marketId || position.symbol) === marketId)) { rejected.push({id: row.id, reason: 'symbol-already-open'}); continue; }
    if (decision < Number(cooldowns.get(marketId) || -Infinity) + PROFIT_PORTFOLIO_CONFIG.cooldownHours * 3_600_000) { rejected.push({id: row.id, reason: 'symbol-cooldown'}); continue; }
    if (open.length >= PROFIT_PORTFOLIO_CONFIG.maxPositions) { rejected.push({id: row.id, reason: 'portfolio-cap'}); continue; }
    if (open.filter(position => position.side === row.side).length >= PROFIT_PORTFOLIO_CONFIG.maxPerSide) { rejected.push({id: row.id, reason: 'side-cap'}); continue; }
    const position = {...row, portfolioTrade: true}; open.push(position); accepted.push(position);
  }
  for (const position of open) { trades.push(position); equity += Number(position.netPnlUsdt || 0); peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  const pnl = trades.map(row => Number(row.netPnlUsdt || 0)); const netR = trades.map(row => Number(row.netR)).filter(Number.isFinite); const wins = pnl.filter(value => value > 0); const losses = pnl.filter(value => value < 0);
  const monthlyPnl = {};
  for (const row of trades) {
    const date = new Date(Number(row.exitTime ?? row.signalTime));
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    monthlyPnl[month] = (monthlyPnl[month] || 0) + Number(row.netPnlUsdt || 0);
  }
  return {accepted, rejected, closedTrades: trades, metrics: {trades: trades.length, wins: wins.length, losses: losses.length, uniqueSymbols: new Set(trades.map(row => row.marketId || row.symbol)).size, netPnlUsdt: pnl.reduce((sum, value) => sum + value, 0), netReturn: (equity - initialEquityUsdt) / initialEquityUsdt, expectancyR: netR.length ? netR.reduce((sum, value) => sum + value, 0) / netR.length : null, profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : wins.length ? Infinity : null, winRate: trades.length ? wins.length / trades.length : null, maxDrawdownUsdt: maxDrawdown, maxDrawdownPct: maxDrawdown / initialEquityUsdt, monthlyPnl}, contract: PROFIT_PORTFOLIO_CONFIG, reusedProductionContract: {decisionLatencyMs: PORTFOLIO_CONFIG.decisionLatencyMs, costRate: PORTFOLIO_CONFIG.costRate}};
}
