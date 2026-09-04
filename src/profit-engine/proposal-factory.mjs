import {stopForPoint} from '../v81/features.mjs';
import {SOURCE_NAMES} from './features.mjs';

export const PROPOSAL_PRIMITIVES = Object.freeze({
  TREND_PRIMITIVE: Object.freeze({adxMin: 15, return12AbsMin: 0.02}),
  PULLBACK_PRIMITIVE: Object.freeze({return12AbsMin: 0.02, return3OppositeAbsMin: 0.005}),
  FLOW_PRIMITIVE: Object.freeze({takerImbalanceAbsMin: 0.12, aggressiveVolumeZAbsMin: 1}),
  CROSS_SECTION_PRIMITIVE: Object.freeze({returnRankTail: 0.2, flowRankTail: 0.3}),
  CROWDING_PRIMITIVE: Object.freeze({fundingZAbsMin: 1, premiumZAbsMin: 1, oiZAbsMin: 1}),
  VOLATILITY_PRIMITIVE: Object.freeze({rangeRatioMin: 1.2, volumeRatioMin: 1.2}),
  V8_BASELINE: Object.freeze({frozen: true}),
});

function number(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function f(row, name) { return number(row?.[name] ?? row?.features?.[name]); }
function sourceValues(row) { return row?.features && typeof row.features === 'object' ? row.features : row; }

function crowdingDirections(point) {
  const fundingZ = f(point, 'fundingZ');
  const premiumZ = f(point, 'premiumZ');
  const oiZ = f(point, 'oiZ');
  const oiChange = f(point, 'oiChange');
  const dimensions = [fundingZ, premiumZ, oiZ].filter(value => value != null).length;
  if (fundingZ == null || dimensions < 2 || point.fundingValid === false) return [];
  const contraction = oiChange == null || oiChange <= 0;
  const crowdedLong = fundingZ >= PROPOSAL_PRIMITIVES.CROWDING_PRIMITIVE.fundingZAbsMin
    && (premiumZ >= PROPOSAL_PRIMITIVES.CROWDING_PRIMITIVE.premiumZAbsMin || oiZ >= PROPOSAL_PRIMITIVES.CROWDING_PRIMITIVE.oiZAbsMin)
    && contraction;
  const crowdedShort = fundingZ <= -PROPOSAL_PRIMITIVES.CROWDING_PRIMITIVE.fundingZAbsMin
    && (premiumZ <= -PROPOSAL_PRIMITIVES.CROWDING_PRIMITIVE.premiumZAbsMin || oiZ <= -PROPOSAL_PRIMITIVES.CROWDING_PRIMITIVE.oiZAbsMin)
    && contraction;
  return [...(crowdedLong ? [{source: 'CROWDING_PRIMITIVE', side: 'short'}] : []), ...(crowdedShort ? [{source: 'CROWDING_PRIMITIVE', side: 'long'}] : [])];
}

/**
 * Produce independent primitive directions directly from a completed feature
 * point. No V9 alpha detector is consulted here; the V9 feature store is only
 * an input data source.
 */
export function primitiveDirectionsForPoint(point) {
  const directions = [];
  const return12 = f(point, 'return12');
  const return3 = f(point, 'return3');
  const adx = f(point, 'adx');
  const regime = point?.regime ?? point?.features?.regime;
  if (return12 != null && Math.abs(return12) >= PROPOSAL_PRIMITIVES.TREND_PRIMITIVE.return12AbsMin
    && adx != null && adx >= PROPOSAL_PRIMITIVES.TREND_PRIMITIVE.adxMin) {
    directions.push({source: 'TREND_PRIMITIVE', side: return12 > 0 ? 'long' : 'short'});
  }
  if (return12 != null && return3 != null && Math.abs(return12) >= PROPOSAL_PRIMITIVES.PULLBACK_PRIMITIVE.return12AbsMin
    && Math.abs(return3) >= PROPOSAL_PRIMITIVES.PULLBACK_PRIMITIVE.return3OppositeAbsMin) {
    if (regime === 'bull' && return12 > 0 && return3 < 0) directions.push({source: 'PULLBACK_PRIMITIVE', side: 'long'});
    if (regime === 'bear' && return12 < 0 && return3 > 0) directions.push({source: 'PULLBACK_PRIMITIVE', side: 'short'});
  }
  const imbalance = f(point, 'takerImbalance');
  const aggressiveZ = f(point, 'aggressiveVolumeZ');
  if ((imbalance != null && imbalance >= PROPOSAL_PRIMITIVES.FLOW_PRIMITIVE.takerImbalanceAbsMin)
    || (aggressiveZ != null && aggressiveZ >= PROPOSAL_PRIMITIVES.FLOW_PRIMITIVE.aggressiveVolumeZAbsMin)) directions.push({source: 'FLOW_PRIMITIVE', side: 'long'});
  if ((imbalance != null && imbalance <= -PROPOSAL_PRIMITIVES.FLOW_PRIMITIVE.takerImbalanceAbsMin)
    || (aggressiveZ != null && aggressiveZ <= -PROPOSAL_PRIMITIVES.FLOW_PRIMITIVE.aggressiveVolumeZAbsMin)) directions.push({source: 'FLOW_PRIMITIVE', side: 'short'});
  const returnRank = f(point, 'crossSectionalReturnRank');
  const flowRank = f(point, 'crossSectionalFlowRank');
  if (returnRank != null && flowRank != null) {
    if (returnRank >= 1 - PROPOSAL_PRIMITIVES.CROSS_SECTION_PRIMITIVE.returnRankTail && flowRank >= 1 - PROPOSAL_PRIMITIVES.CROSS_SECTION_PRIMITIVE.flowRankTail) directions.push({source: 'CROSS_SECTION_PRIMITIVE', side: 'long'});
    if (returnRank <= PROPOSAL_PRIMITIVES.CROSS_SECTION_PRIMITIVE.returnRankTail && flowRank <= PROPOSAL_PRIMITIVES.CROSS_SECTION_PRIMITIVE.flowRankTail) directions.push({source: 'CROSS_SECTION_PRIMITIVE', side: 'short'});
  }
  directions.push(...crowdingDirections(point));
  if ((f(point, 'rangeRatio') ?? 0) >= PROPOSAL_PRIMITIVES.VOLATILITY_PRIMITIVE.rangeRatioMin
    || (f(point, 'volumeRatio') ?? 0) >= PROPOSAL_PRIMITIVES.VOLATILITY_PRIMITIVE.volumeRatioMin) {
    const impulse = return3 ?? imbalance ?? aggressiveZ;
    if (impulse != null && impulse > 0) directions.push({source: 'VOLATILITY_PRIMITIVE', side: 'long'});
    if (impulse != null && impulse < 0) directions.push({source: 'VOLATILITY_PRIMITIVE', side: 'short'});
  }
  return directions.sort((a, b) => SOURCE_NAMES.indexOf(a.source) - SOURCE_NAMES.indexOf(b.source) || a.side.localeCompare(b.side));
}

/**
 * Compatibility source attribution for existing candidate-shaped fixtures.
 * New proposals are created only by buildPrimitiveProposals above.
 */
export function primitiveSourcesForCandidate(candidate, explicitSource = null) {
  if (explicitSource === 'V8_BASELINE' || String(candidate?.modelVersion || '').includes('V8')) return ['V8_BASELINE'];
  if (Array.isArray(candidate?.proposalSources) && candidate.proposalSources.length) {
    return [...new Set(candidate.proposalSources)].filter(value => SOURCE_NAMES.includes(value)).sort();
  }
  const sources = new Set(primitiveDirectionsForPoint(candidate).map(row => row.source));
  const values = sourceValues(candidate);
  if (f(values, 'adx') != null && f(values, 'adx') >= PROPOSAL_PRIMITIVES.TREND_PRIMITIVE.adxMin) sources.add('TREND_PRIMITIVE');
  if (Math.abs(f(values, 'return12') || 0) >= PROPOSAL_PRIMITIVES.TREND_PRIMITIVE.return12AbsMin) sources.add('TREND_PRIMITIVE');
  if (Math.abs(f(values, 'fundingZ') || 0) >= PROPOSAL_PRIMITIVES.CROWDING_PRIMITIVE.fundingZAbsMin) sources.add('CROWDING_PRIMITIVE');
  if (Math.abs(f(values, 'premiumZ') || 0) >= PROPOSAL_PRIMITIVES.CROWDING_PRIMITIVE.premiumZAbsMin) sources.add('CROWDING_PRIMITIVE');
  if (Math.abs(f(values, 'oiZ') || 0) >= PROPOSAL_PRIMITIVES.CROWDING_PRIMITIVE.oiZAbsMin) sources.add('CROWDING_PRIMITIVE');
  if ((f(values, 'rangeRatio') || 0) >= PROPOSAL_PRIMITIVES.VOLATILITY_PRIMITIVE.rangeRatioMin || (f(values, 'volumeRatio') || 0) >= PROPOSAL_PRIMITIVES.VOLATILITY_PRIMITIVE.volumeRatioMin) sources.add('VOLATILITY_PRIMITIVE');
  return [...sources].filter(value => SOURCE_NAMES.includes(value)).sort();
}

function deterministicRisk(row, side) {
  const point = row?.features && typeof row.features === 'object' ? row.features : row;
  const risk = stopForPoint(point, side);
  if (risk) return risk;
  const stop = number(row?.sl ?? row?.stop);
  const entry = number(row?.signalPrice ?? row?.entry);
  return stop != null && entry != null && entry > 0 ? {stop, stopPct: Math.abs(entry - stop) / entry} : null;
}

function normalizeProposalRisk(row) {
  const entry = number(row.signalPrice ?? row.entry);
  const risk = deterministicRisk(row, row.side);
  if (entry == null || !risk) return {...row, targetR: 2};
  const target = entry + (row.side === 'long' ? 1 : -1) * 2 * Math.abs(entry - risk.stop);
  return {...row, entry, signalPrice: row.signalPrice ?? entry, sl: risk.stop, stop: risk.stop, stopPct: risk.stopPct, targetR: 2, target};
}

function proposalFromPrimitive(point, market, source, side) {
  const marketId = market?.symbol || point.marketId || point.symbol;
  const signalTime = number(point.signalTime ?? point.t);
  const signalPrice = number(point.close ?? point.signalPrice ?? point.entry);
  const risk = stopForPoint(point, side);
  if (!marketId || signalTime == null || signalTime <= 0 || !(signalPrice > 0) || !risk) return null;
  const direction = side === 'long' ? 1 : -1;
  const eventScore = Math.abs(number(point.return3) || 0) * 100 + Math.abs(number(point.takerImbalance) || 0) * 10;
  const dayVolume = number(point.q ?? point.quoteVolume) || 0;
  const id = `PE|${source}|${marketId}|${side}|${signalTime}`;
  return {
    id, proposalId: id, modelVersion: 'TELEEDGE-PROFIT-ENGINE-R1-R3',
    alpha: source, alphaFamily: source, family: `profit_${source.toLowerCase()}`,
    marketId, symbol: market?.baseAsset || point.baseAsset || marketId.replace(/USDT$/, ''), core: Boolean(market?.core ?? point.core),
    side, t: signalTime, signalTime, signalPrice, entry: signalPrice,
    sl: risk.stop, stop: risk.stop, stopPct: risk.stopPct, targetR: 2,
    target: signalPrice + direction * 2 * Math.abs(signalPrice - risk.stop),
    eventScore, dayVolume, edgeScore: Math.abs(number(point.return12) || 0),
    regime: point.regime || 'unknown', btcRouter: point.btcRegime || 'unknown',
    features: point, proposalSources: [source], proposalSourceFlags: Object.fromEntries(SOURCE_NAMES.map(name => [name, name === source])),
    primaryObservationId: id, sourceObservationIds: [id],
  };
}

export function buildPrimitiveProposals(pointsBySymbol, marketBySymbol) {
  const source = pointsBySymbol instanceof Map ? [...pointsBySymbol.entries()].flatMap(([symbol, points]) => (points || []).map(point => ({...point, marketId: point.marketId || symbol}))) : [...(pointsBySymbol || [])];
  return source.sort((a, b) => Number(a.signalTime ?? a.t) - Number(b.signalTime ?? b.t) || String(a.marketId || a.symbol).localeCompare(String(b.marketId || b.symbol)))
    .flatMap(point => primitiveDirectionsForPoint(point).map(({source: primitive, side}) => proposalFromPrimitive(point, marketBySymbol?.get?.(point.marketId || point.symbol) || marketBySymbol?.[point.marketId || point.symbol] || null, primitive, side)).filter(Boolean));
}

export function toProfitProposal(candidate, {source = null} = {}) {
  const sources = [...new Set([...(candidate?.proposalSources || []), ...(source ? [source] : []), ...primitiveSourcesForCandidate(candidate, source)])]
    .filter(value => SOURCE_NAMES.includes(value)).sort();
  const normalized = normalizeProposalRisk({...candidate, proposalSources: sources});
  return {
    ...normalized,
    proposalId: candidate.id,
    modelVersion: candidate.modelVersion || 'TELEEDGE-PROFIT-ENGINE-R1-R3',
    proposalSources: sources,
    proposalSourceFlags: Object.fromEntries(SOURCE_NAMES.map(name => [name, sources.includes(name)])),
    primaryObservationId: candidate.primaryObservationId || candidate.id,
    sourceObservationIds: candidate.sourceObservationIds || [candidate.id],
  };
}

function key(row) { return `${row.marketId || row.symbol}|${row.side}|${row.signalTime ?? row.t}`; }
function rankValue(value) { return Number.isFinite(Number(value)) ? Number(value) : -Infinity; }
function compare(a, b) {
  return rankValue(b.edgeScore) - rankValue(a.edgeScore)
    || rankValue(b.eventScore) - rankValue(a.eventScore)
    || rankValue(b.dayVolume) - rankValue(a.dayVolume)
    || String(a.id || '').localeCompare(String(b.id || ''));
}

export function mergeProfitProposals(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const current = groups.get(key(row));
    if (!current) { groups.set(key(row), toProfitProposal(row)); continue; }
    const winner = compare(row, current) < 0 ? row : current;
    const sources = [...new Set([...(current.proposalSources || []), ...(row.proposalSources || [])])].sort();
    const sourceObservationIds = [...new Set([...(current.sourceObservationIds || [current.id]), ...(row.sourceObservationIds || [row.id]), current.id, row.id])].sort();
    groups.set(key(row), toProfitProposal(normalizeProposalRisk({...winner, proposalSources: sources, sourceObservationIds, proposalOverlap: sources.length > 1})));
  }
  return [...groups.values()].sort((a, b) => Number(a.t ?? a.signalTime) - Number(b.t ?? b.signalTime) || String(a.side).localeCompare(String(b.side)) || compare(a, b));
}

export function dedupeProfitEpisodes(rows, {refractoryHours = 72} = {}) {
  const grouped = new Map();
  for (const row of rows || []) {
    const groupKey = `${row.marketId || row.symbol}|${row.side}`;
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(row);
  }
  const result = [];
  for (const group of grouped.values()) {
    group.sort((a, b) => Number(a.t ?? a.signalTime) - Number(b.t ?? b.signalTime) || String(a.id).localeCompare(String(b.id)));
    let last = -Infinity;
    let episode = 0;
    for (const row of group) {
      const timestamp = Number(row.t ?? row.signalTime);
      if (timestamp - last < Number(refractoryHours) * 3_600_000) continue;
      last = timestamp;
      episode++;
      result.push({...row, episodeId: `${row.marketId || row.symbol}|${row.side}|profit-engine-episode-${episode}`, episodeEntry: true, episodeRefractoryHours: Number(refractoryHours)});
    }
  }
  return result.sort((a, b) => Number(a.t ?? a.signalTime) - Number(b.t ?? b.signalTime) || String(a.id).localeCompare(String(b.id)));
}

export function buildProposalSet(candidates, {refractoryHours = 72, source = null} = {}) {
  const raw = (candidates || []).map(candidate => toProfitProposal(candidate, {source}));
  const merged = mergeProfitProposals(raw);
  const independent = dedupeProfitEpisodes(merged, {refractoryHours});
  return {raw, merged, independent};
}
