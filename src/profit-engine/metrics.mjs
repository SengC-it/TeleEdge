function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function monthKey(value) { const date = new Date(Number(value)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`; }

export function summarizeTrades(trades, {initialEquity = 10_000, start = -Infinity, end = Infinity} = {}) {
  const rows = (trades || []).filter(row => Number(row.exitTime ?? row.signalTime) >= start && Number(row.exitTime ?? row.signalTime) < end && Number.isFinite(Number(row.netR ?? row.netPnlUsdt)));
  const netR = rows.map(row => Number(row.netR));
  const pnl = rows.map(row => finite(row.netPnlUsdt) ?? Number(row.netR) * Number(row.riskUsdt || initialEquity * 0.006));
  const wins = pnl.filter(value => value > 0); const losses = pnl.filter(value => value < 0);
  let equity = initialEquity; let peak = equity; let maxDrawdown = 0;
  for (const value of pnl) { equity += value; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  const monthlyPnl = {};
  for (const row of rows) { const month = monthKey(row.exitTime ?? row.signalTime); monthlyPnl[month] = (monthlyPnl[month] || 0) + (finite(row.netPnlUsdt) ?? 0); }
  const monthValues = Object.values(monthlyPnl);
  return {
    trades: rows.length, wins: wins.length, losses: losses.length, uniqueSymbols: new Set(rows.map(row => row.marketId || row.symbol)).size,
    netPnlUsdt: pnl.reduce((sum, value) => sum + value, 0), netReturn: (equity - initialEquity) / initialEquity,
    expectancyR: netR.length ? netR.reduce((sum, value) => sum + value, 0) / netR.length : null,
    profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : wins.length ? Infinity : null,
    winRate: rows.length ? wins.length / rows.length : null, maxDrawdownUsdt: maxDrawdown, maxDrawdownPct: maxDrawdown / initialEquity,
    monthlyPnl, positiveMonths: monthValues.filter(value => value > 0).length, negativeMonths: monthValues.filter(value => value < 0).length, zeroMonths: monthValues.filter(value => value === 0).length,
  };
}

export function breakdown(rows, keyOf) {
  const groups = new Map(); for (const row of rows || []) { const key = String(keyOf(row)); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => [key, summarizeTrades(group)]));
}

export function frequencyByMonth(rows, start, end) {
  const output = {}; const cursor = new Date(start); cursor.setUTCDate(1);
  while (cursor.getTime() < end) { output[monthKey(cursor)] = {rawProposals: 0, independentProposals: 0, executableOutcomes: 0, r1Active: 0, r2PositiveEdge: 0, r3Qualified: 0, highConfidence: 0, portfolioTrades: 0}; cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
  for (const row of rows || []) { const month = monthKey(row.signalTime ?? row.t); if (!output[month]) continue; if (row.rawProposal) output[month].rawProposals++; if (row.independentProposal) output[month].independentProposals++; if (row.executable) output[month].executableOutcomes++; if (row.r1Active) output[month].r1Active++; if (row.r2PositiveEdge) output[month].r2PositiveEdge++; if (row.qualified) output[month].r3Qualified++; if (row.highConfidence) output[month].highConfidence++; if (row.portfolioTrade) output[month].portfolioTrades++; }
  return output;
}
