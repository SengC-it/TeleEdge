import crypto from 'node:crypto';

export const EVENT_DEFINITION_VERSION = 'm4-event-regime-v1';
export const EVENT_REFRACTORY_HOURS = 72;
export const EVENT_FAMILIES = Object.freeze([
  'BREADTH_REGIME_TRANSITION',
  'MARKET_VOLATILITY_SHOCK',
  'DISPERSION_ROTATION',
  'LEVERAGE_STRESS_TRANSITION',
  'TREND_REGIME_TRANSITION',
]);

export const EVENT_DEFINITIONS = Object.freeze({
  BREADTH_REGIME_TRANSITION: Object.freeze({
    level: 'market',
    bull: {fromBelow: 0.45, toAtLeast: 0.55, confirmationFloor: 0.50, side: 'long'},
    bear: {fromAbove: 0.55, toAtMost: 0.45, confirmationCeiling: 0.50, side: 'short'},
    confirmationObservations: 2,
  }),
  MARKET_VOLATILITY_SHOCK: Object.freeze({
    level: 'market', realizedVolZ: 2, directionalBreadth: 0.65,
  }),
  DISPERSION_ROTATION: Object.freeze({
    level: 'symbol', fromBelow: 1, toAtLeast: 1.5, topBottomPct: 0.10, maxPerSide: 3,
  }),
  LEVERAGE_STRESS_TRANSITION: Object.freeze({
    level: 'market', absoluteCrowdingStressZ: 2, minimumConsistentDimensions: 2,
  }),
  TREND_REGIME_TRANSITION: Object.freeze({
    level: 'market', states: ['BULL', 'BEAR', 'SIDEWAYS'], confirmationObservations: 2,
  }),
});

export const EVENT_KEEP_GATE = Object.freeze({
  minimumExecutable: 60,
  minimumFoldsWithSamples: 4,
  minimumPositiveFolds: 4,
  minimumProfitFactor: 1.25,
  minimumExpectancyR: 0.10,
  minimumExpectancyUpliftR: 0.08,
  minimumProfitFactorUplift: 0.15,
  maximumDrawdownPct: 0.08,
  maximumSymbolContribution: 0.20,
});

const FOUR_HOURS = 4 * 3_600_000;

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function eventTime(row) {
  return finite(row?.eventTime ?? row?.signalTime ?? row?.t);
}

function direction(value, fallback = null) {
  const numeric = finite(value);
  if (numeric == null) return fallback;
  return numeric > 0 ? 'long' : numeric < 0 ? 'short' : fallback;
}

function sign(value) {
  const numeric = finite(value);
  return numeric == null || numeric === 0 ? 0 : Math.sign(numeric);
}

function month(value) {
  const date = new Date(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function stableId(row, index = 0) {
  return String(row?.eventId || row?.id || `${row?.eventFamily || 'observation'}|${eventTime(row) || 0}|${row?.symbol || ''}|${row?.side || row?.sideHypothesis || ''}|${index}`);
}

function eventId(family, row, side, symbol = null) {
  const raw = `${family}|${side || 'diagnostic'}|${symbol || 'MARKET'}|${eventTime(row)}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function makeEvent(family, row, {
  sideHypothesis = null,
  symbol = null,
  level = EVENT_DEFINITIONS[family].level,
  features = {},
  diagnostic = false,
} = {}) {
  const t = eventTime(row);
  return {
    eventId: eventId(family, row, sideHypothesis, symbol),
    eventFamily: family,
    eventTime: t,
    symbol,
    sideHypothesis,
    marketRegime: row?.marketRegime || row?.regime || null,
    liquidityBucket: row?.liquidityBucket || null,
    features: {...features},
    pitUniverseSize: finite(row?.pitUniverseSize ?? row?.universeSize),
    sourceEvidence: row?.sourceEvidence || null,
    eventDefinitionVersion: EVENT_DEFINITION_VERSION,
    level,
    diagnostic,
  };
}

function sortedRows(rows) {
  return (rows || []).filter(row => eventTime(row) != null && row?.completed !== false && row?.isComplete !== false)
    .map((row, index) => ({...row, __index: index}))
    .sort((left, right) => eventTime(left) - eventTime(right) || stableId(left, left.__index).localeCompare(stableId(right, right.__index)));
}

function consecutiveObservations(left, right) {
  const gap = eventTime(right) - eventTime(left);
  return gap > 0 && gap <= FOUR_HOURS;
}

function directionalBreadth(row) {
  return finite(row?.directionalBreadth ?? row?.breadthDirectional ?? row?.breadthAbove50);
}

function marketDirection(row) {
  return row?.marketDirection || row?.direction || direction(row?.marketReturn ?? row?.btcReturn ?? row?.return4, null);
}

export function detectBreadthRegimeTransitions(rows) {
  const sorted = sortedRows(rows);
  const events = [];
  for (let index = 1; index + 1 < sorted.length; index++) {
    if (!consecutiveObservations(sorted[index - 1], sorted[index]) || !consecutiveObservations(sorted[index], sorted[index + 1])) continue;
    const previous = finite(sorted[index - 1].breadthAbove50);
    const current = finite(sorted[index].breadthAbove50);
    const confirmation = finite(sorted[index + 1].breadthAbove50);
    if (previous == null || current == null || confirmation == null) continue;
    if (previous < 0.45 && current >= 0.55 && confirmation >= 0.50) {
      events.push(makeEvent('BREADTH_REGIME_TRANSITION', sorted[index], {
        sideHypothesis: 'long',
        features: {previousBreadth: previous, eventBreadth: current, confirmationBreadth: confirmation},
      }));
    }
    if (previous > 0.55 && current <= 0.45 && confirmation <= 0.50) {
      events.push(makeEvent('BREADTH_REGIME_TRANSITION', sorted[index], {
        sideHypothesis: 'short',
        features: {previousBreadth: previous, eventBreadth: current, confirmationBreadth: confirmation},
      }));
    }
  }
  return events;
}

export function detectVolatilityShocks(rows) {
  const events = [];
  for (const row of sortedRows(rows)) {
    const realizedVolZ = finite(row.realizedVolZ);
    const breadth = directionalBreadth(row);
    if (realizedVolZ == null || realizedVolZ < 2) continue;
    const side = breadth != null && breadth >= 0.65 ? marketDirection(row) : null;
    events.push(makeEvent('MARKET_VOLATILITY_SHOCK', row, {
      sideHypothesis: side,
      features: {realizedVolZ, medianAbsReturnZ: finite(row.medianAbsReturnZ), rangeExpansionBreadth: finite(row.rangeExpansionBreadth), directionalBreadth: breadth},
      diagnostic: side == null,
    }));
  }
  return events;
}

function membersFor(row) {
  return row?.members || row?.symbols || row?.points || [];
}

export function detectDispersionRotations(rows) {
  const events = [];
  for (const row of sortedRows(rows)) {
    const previous = finite(row.previousDispersionZ ?? row.dispersionZPrevious);
    const current = finite(row.crossSectionalReturnDispersionZ ?? row.dispersionZ);
    if (previous == null || current == null || !(previous < 1 && current >= 1.5)) continue;
    const members = membersFor(row).map(member => ({
      ...member,
      symbol: member.symbol || member.marketId,
      rank: finite(member.pitReturnRank ?? member.crossSectionalReturnRank ?? member.returnRank),
    })).filter(member => member.symbol && member.rank != null).sort((left, right) => right.rank - left.rank || left.symbol.localeCompare(right.symbol));
    if (!members.length) continue;
    const count = Math.max(1, Math.ceil(members.length * 0.10));
    const top = members.slice(0, Math.min(3, count));
    const bottom = members.slice(-Math.min(3, count)).sort((left, right) => left.rank - right.rank || left.symbol.localeCompare(right.symbol));
    for (const member of top) events.push(makeEvent('DISPERSION_ROTATION', row, {symbol: member.symbol, sideHypothesis: 'long', level: 'symbol', features: {previousDispersionZ: previous, dispersionZ: current, pitReturnRank: member.rank}}));
    for (const member of bottom) events.push(makeEvent('DISPERSION_ROTATION', row, {symbol: member.symbol, sideHypothesis: 'short', level: 'symbol', features: {previousDispersionZ: previous, dispersionZ: current, pitReturnRank: member.rank}}));
  }
  return events;
}

function consistentStress(row) {
  const dimensions = [
    ['funding', finite(row.fundingZ)],
    ['premium', finite(row.premiumZ)],
    ['oi', finite(row.oiZ ?? row.openInterestZ)],
  ].filter(([, value]) => value != null && value !== 0);
  const positive = dimensions.filter(([, value]) => value > 0);
  const negative = dimensions.filter(([, value]) => value < 0);
  if (positive.length >= 2) return {crowded: 'long', dimensions: positive.map(([name]) => name)};
  if (negative.length >= 2) return {crowded: 'short', dimensions: negative.map(([name]) => name)};
  const explicit = row.crowdingDirection;
  if (explicit === 'long' || explicit === 'short') return {crowded: explicit, dimensions: dimensions.map(([name]) => name)};
  return null;
}

export function detectLeverageStressTransitions(rows) {
  const events = [];
  for (const row of sortedRows(rows)) {
    const stress = finite(row.crowdingStressZ);
    if (stress == null || Math.abs(stress) < 2) continue;
    const consistency = consistentStress(row);
    if (!consistency || consistency.dimensions.length < 2) continue;
    const breakSide = marketDirection(row);
    const side = consistency.crowded === 'long' && breakSide === 'short'
      ? 'short'
      : consistency.crowded === 'short' && breakSide === 'long' ? 'long' : null;
    if (!side) continue;
    events.push(makeEvent('LEVERAGE_STRESS_TRANSITION', row, {
      sideHypothesis: side,
      features: {crowdingStressZ: stress, crowdedDirection: consistency.crowded, consistentDimensions: consistency.dimensions, completedBreakDirection: breakSide},
    }));
  }
  return events;
}

export function detectTrendRegimeTransitions(rows) {
  const sorted = sortedRows(rows);
  const events = [];
  const sideFor = (from, to) => {
    if ((from === 'SIDEWAYS' || from === 'BEAR') && to === 'BULL') return 'long';
    if ((from === 'SIDEWAYS' || from === 'BULL') && to === 'BEAR') return 'short';
    return null;
  };
  for (let index = 1; index + 1 < sorted.length; index++) {
    if (!consecutiveObservations(sorted[index - 1], sorted[index]) || !consecutiveObservations(sorted[index], sorted[index + 1])) continue;
    const from = String(sorted[index - 1].marketRegime ?? sorted[index - 1].regime ?? '').toUpperCase();
    const to = String(sorted[index].marketRegime ?? sorted[index].regime ?? '').toUpperCase();
    const confirmation = String(sorted[index + 1].marketRegime ?? sorted[index + 1].regime ?? '').toUpperCase();
    const side = sideFor(from, to);
    if (!side || confirmation !== to) continue;
    events.push(makeEvent('TREND_REGIME_TRANSITION', sorted[index], {sideHypothesis: side, features: {from, to, confirmation}}));
  }
  return events;
}

export function detectEvents(snapshots) {
  const all = [
    ...detectBreadthRegimeTransitions(snapshots),
    ...detectVolatilityShocks(snapshots),
    ...detectDispersionRotations(snapshots),
    ...detectLeverageStressTransitions(snapshots),
    ...detectTrendRegimeTransitions(snapshots),
  ];
  return all.sort((left, right) => left.eventTime - right.eventTime || left.eventFamily.localeCompare(right.eventFamily) || String(left.symbol || '').localeCompare(String(right.symbol || '')) || String(left.sideHypothesis || '').localeCompare(String(right.sideHypothesis || '')));
}

export function dedupeEventEpisodes(events, refractoryHours = EVENT_REFRACTORY_HOURS) {
  const refractoryMs = refractoryHours * 3_600_000;
  const lastByKey = new Map();
  const independent = [];
  const suppressed = [];
  const sorted = [...(events || [])].sort((left, right) => eventTime(left) - eventTime(right) || stableId(left).localeCompare(stableId(right)));
  for (const row of sorted) {
    const key = `${row.eventFamily}|${row.level === 'symbol' ? row.symbol || 'UNKNOWN' : 'MARKET'}|${row.sideHypothesis || 'diagnostic'}`;
    const previous = lastByKey.get(key);
    if (previous && eventTime(row) - eventTime(previous) < refractoryMs) {
      suppressed.push({...row, duplicateOf: previous.eventId, deduped: true});
      continue;
    }
    lastByKey.set(key, row);
    independent.push({...row, deduped: false, episodeKey: key});
  }
  return {rawEvents: sorted, independentEvents: independent, suppressedEvents: suppressed};
}

export function matchEventControls(event, observations, {maxControls = 1} = {}) {
  const eventMonth = month(event.eventTime);
  const side = event.sideHypothesis;
  const candidates = (observations || []).filter(row => {
    if (row.eventId || row.eventFamily || row.isEvent) return false;
    if (row.completed === false || row.isComplete === false) return false;
    if (side && row.side && row.side !== side) return false;
    if (row.month && row.month !== eventMonth) return false;
    if (row.marketRegime && event.marketRegime && row.marketRegime !== event.marketRegime) return false;
    if (row.liquidityBucket && event.liquidityBucket && row.liquidityBucket !== event.liquidityBucket) return false;
    return eventTime(row) != null;
  }).sort((left, right) => Math.abs(eventTime(left) - event.eventTime) - Math.abs(eventTime(right) - event.eventTime) || stableId(left).localeCompare(stableId(right)));
  return candidates.slice(0, maxControls);
}

export function purgeEventLabels(rows, {validationStart, purgeHours = 72} = {}) {
  const boundary = Number(validationStart) - Number(purgeHours) * 3_600_000;
  const kept = [];
  const excluded = [];
  for (const row of rows || []) {
    const exit = finite(row.exitTime ?? row.labelEndTime ?? row.canonicalBarrierTime);
    if (exit != null && exit >= boundary) excluded.push({...row, excludedByOutcomeOverlap: true});
    else kept.push(row);
  }
  return {kept, excluded, excludedByOutcomeOverlap: excluded.length, labelOverlapFree: excluded.length === 0};
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function confidenceInterval(values) {
  if (!values.length) return {lower: null, upper: null, level: 0.95};
  const average = mean(values);
  const margin = values.length > 1 ? 1.96 * standardDeviation(values) / Math.sqrt(values.length) : null;
  return {lower: margin == null ? null : average - margin, upper: margin == null ? null : average + margin, level: 0.95};
}

export function summarizeEventOutcomes(rows, {initialEquity = 10_000} = {}) {
  const executable = (rows || []).filter(row => row.executable !== false && Number.isFinite(Number(row.netR ?? row.r)));
  const pnl = executable.map(row => Number(row.netPnlUsdt ?? row.pnl ?? row.netR ?? row.r));
  const wins = pnl.filter(value => value > 0);
  const losses = pnl.filter(value => value < 0);
  const expectancyValues = executable.map(row => Number(row.netR ?? row.r)).filter(Number.isFinite);
  const bySymbol = new Map();
  for (const row of executable) {
    const key = row.symbol || row.marketId || 'MARKET';
    bySymbol.set(key, (bySymbol.get(key) || 0) + Number(row.netPnlUsdt ?? row.pnl ?? row.netR ?? row.r));
  }
  const totalPositive = pnl.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const totalPnl = pnl.reduce((sum, value) => sum + value, 0);
  let equity = initialEquity; let peak = initialEquity; let maxDrawdown = 0;
  for (const value of pnl) { equity += value; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  const folds = new Set(executable.map(row => row.outerFold).filter(value => value != null));
  const positiveFolds = new Set((executable.filter(row => Number(row.netR ?? row.r) > 0).map(row => row.outerFold).filter(value => value != null)));
  const largestSymbol = Math.max(0, ...bySymbol.values());
  return {
    independent: Number(rows?.length || 0),
    executable: executable.length,
    symbols: bySymbol.size,
    wins: wins.length,
    losses: losses.length,
    winRate: executable.length ? wins.length / executable.length : null,
    profitFactor: losses.length ? totalPositive / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : null,
    expectancyR: mean(expectancyValues),
    confidenceInterval: confidenceInterval(expectancyValues),
    pnl: totalPnl,
    maxDrawdownPct: maxDrawdown / initialEquity,
    positiveFolds: positiveFolds.size,
    folds: folds.size,
    symbolConcentration: totalPnl > 0 ? largestSymbol / totalPnl : null,
  };
}

export function compareEventToControl(eventRows, controlRows) {
  const event = summarizeEventOutcomes(eventRows);
  const control = summarizeEventOutcomes(controlRows);
  return {
    event,
    control,
    expectancyUpliftR: event.expectancyR == null || control.expectancyR == null ? null : event.expectancyR - control.expectancyR,
    profitFactorUplift: event.profitFactor == null || control.profitFactor == null ? null : event.profitFactor - control.profitFactor,
  };
}

export function evaluateEventKeepGate(summary, {strong = false} = {}) {
  if (!summary || summary.executable < EVENT_KEEP_GATE.minimumExecutable) return 'WATCH';
  const upliftPass = Number(summary.expectancyUpliftR) >= EVENT_KEEP_GATE.minimumExpectancyUpliftR
    || Number(summary.profitFactorUplift) >= EVENT_KEEP_GATE.minimumProfitFactorUplift;
  const keep = summary.folds >= EVENT_KEEP_GATE.minimumFoldsWithSamples
    && summary.positiveFolds >= EVENT_KEEP_GATE.minimumPositiveFolds
    && Number(summary.profitFactor) >= EVENT_KEEP_GATE.minimumProfitFactor
    && Number(summary.expectancyR) >= EVENT_KEEP_GATE.minimumExpectancyR
    && Number(summary.pnl) > 0
    && upliftPass
    && Number(summary.maxDrawdownPct) <= EVENT_KEEP_GATE.maximumDrawdownPct
    && Number(summary.symbolConcentration) <= EVENT_KEEP_GATE.maximumSymbolContribution;
  if (!keep) return 'REJECT';
  if (strong && summary.executable >= 100 && summary.symbols >= 20 && Number(summary.profitFactor) >= 1.5 && Number(summary.expectancyR) >= 0.2 && Number(summary.confidenceInterval?.lower) > 0 && summary.positiveFolds >= 5 && Number(summary.maxDrawdownPct) <= 0.06) return 'STRONG_KEEP';
  return 'KEEP';
}

export function eventResearchGate(familySummaries) {
  const statuses = Object.values(familySummaries || {}).map(row => row?.status);
  const keep = statuses.filter(value => value === 'KEEP' || value === 'STRONG_KEEP').length;
  const strong = statuses.filter(value => value === 'STRONG_KEEP').length;
  return keep >= 2 || strong >= 1 ? 'EVENT_RESEARCH_GO' : 'EVENT_RESEARCH_FAIL';
}
