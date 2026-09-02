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

export function primitiveSourcesForCandidate(candidate, explicitSource = null) {
  if (explicitSource === 'V8_BASELINE' || String(candidate?.modelVersion || '').includes('V8')) return ['V8_BASELINE'];
  const sources = [];
  const adx = f(candidate, 'adx');
  const return12 = f(candidate, 'return12');
  const return3 = f(candidate, 'return3');
  if ((adx != null && adx >= PROPOSAL_PRIMITIVES.TREND_PRIMITIVE.adxMin) || Math.abs(return12 || 0) >= PROPOSAL_PRIMITIVES.TREND_PRIMITIVE.return12AbsMin) sources.push('TREND_PRIMITIVE');
  if (Math.abs(return12 || 0) >= PROPOSAL_PRIMITIVES.PULLBACK_PRIMITIVE.return12AbsMin && Math.abs(return3 || 0) >= PROPOSAL_PRIMITIVES.PULLBACK_PRIMITIVE.return3OppositeAbsMin && Math.sign(return12 || 0) !== Math.sign(return3 || 0)) sources.push('PULLBACK_PRIMITIVE');
  if (Math.abs(f(candidate, 'takerImbalance') || 0) >= PROPOSAL_PRIMITIVES.FLOW_PRIMITIVE.takerImbalanceAbsMin || Math.abs(f(candidate, 'aggressiveVolumeZ') || 0) >= PROPOSAL_PRIMITIVES.FLOW_PRIMITIVE.aggressiveVolumeZAbsMin) sources.push('FLOW_PRIMITIVE');
  if ((f(candidate, 'crossSectionalReturnRank') ?? 0.5) <= PROPOSAL_PRIMITIVES.CROSS_SECTION_PRIMITIVE.returnRankTail || (f(candidate, 'crossSectionalReturnRank') ?? 0.5) >= 1 - PROPOSAL_PRIMITIVES.CROSS_SECTION_PRIMITIVE.returnRankTail || (f(candidate, 'crossSectionalFlowRank') ?? 0.5) <= PROPOSAL_PRIMITIVES.CROSS_SECTION_PRIMITIVE.flowRankTail || (f(candidate, 'crossSectionalFlowRank') ?? 0.5) >= 1 - PROPOSAL_PRIMITIVES.CROSS_SECTION_PRIMITIVE.flowRankTail) sources.push('CROSS_SECTION_PRIMITIVE');
  if (Math.abs(f(candidate, 'fundingZ') || 0) >= PROPOSAL_PRIMITIVES.CROWDING_PRIMITIVE.fundingZAbsMin || Math.abs(f(candidate, 'premiumZ') || 0) >= PROPOSAL_PRIMITIVES.CROWDING_PRIMITIVE.premiumZAbsMin || Math.abs(f(candidate, 'oiZ') || 0) >= PROPOSAL_PRIMITIVES.CROWDING_PRIMITIVE.oiZAbsMin) sources.push('CROWDING_PRIMITIVE');
  if ((f(candidate, 'rangeRatio') || 0) >= PROPOSAL_PRIMITIVES.VOLATILITY_PRIMITIVE.rangeRatioMin || (f(candidate, 'volumeRatio') || 0) >= PROPOSAL_PRIMITIVES.VOLATILITY_PRIMITIVE.volumeRatioMin) sources.push('VOLATILITY_PRIMITIVE');
  return sources;
}

export function toProfitProposal(candidate, {source = null} = {}) {
  const sources = [...new Set([...(candidate?.proposalSources || []), ...primitiveSourcesForCandidate(candidate, source)])].filter(value => SOURCE_NAMES.includes(value)).sort();
  return {
    ...candidate,
    proposalId: candidate.id,
    modelVersion: 'TELEEDGE-PROFIT-ENGINE-R1-R3',
    proposalSources: sources,
    proposalSourceFlags: Object.fromEntries(SOURCE_NAMES.map(name => [name, sources.includes(name)])),
    primaryObservationId: candidate.id,
    sourceObservationIds: [candidate.id],
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
    if (!current) { groups.set(key(row), {...row}); continue; }
    const winner = compare(row, current) < 0 ? row : current;
    const sources = [...new Set([...(current.proposalSources || []), ...(row.proposalSources || [])])].sort();
    const sourceObservationIds = [...new Set([...(current.sourceObservationIds || [current.id]), ...(row.sourceObservationIds || [row.id])])].sort();
    groups.set(key(row), {...winner, proposalSources: sources, sourceObservationIds, proposalSourceFlags: Object.fromEntries(SOURCE_NAMES.map(name => [name, sources.includes(name)])), proposalOverlap: sources.length > 1});
  }
  return [...groups.values()].sort((a, b) => Number(a.t) - Number(b.t) || String(a.side).localeCompare(String(b.side)) || compare(a, b));
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
    group.sort((a, b) => Number(a.t) - Number(b.t) || String(a.id).localeCompare(String(b.id)));
    let last = -Infinity;
    let episode = 0;
    for (const row of group) {
      if (Number(row.t) - last < Number(refractoryHours) * 3_600_000) continue;
      last = Number(row.t);
      episode++;
      result.push({...row, episodeId: `${row.marketId || row.symbol}|${row.side}|profit-engine-episode-${episode}`, episodeEntry: true, episodeRefractoryHours: Number(refractoryHours)});
    }
  }
  return result.sort((a, b) => Number(a.t) - Number(b.t) || String(a.id).localeCompare(String(b.id)));
}

export function buildProposalSet(candidates, {refractoryHours = 72, source = null} = {}) {
  const raw = (candidates || []).map(candidate => toProfitProposal(candidate, {source}));
  const merged = mergeProfitProposals(raw);
  const independent = dedupeProfitEpisodes(merged, {refractoryHours});
  return {raw, merged, independent};
}
