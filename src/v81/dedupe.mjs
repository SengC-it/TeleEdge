function candidateKey(candidate) {
  return `${candidate.marketId || candidate.symbol}|${candidate.side}|${candidate.t}`;
}

function compare(a, b) {
  return Number(b.edgeScore || 0) - Number(a.edgeScore || 0)
    || Number(b.confidenceScore || 0) - Number(a.confidenceScore || 0)
    || Number(b.eventScore || 0) - Number(a.eventScore || 0)
    || Number(b.dayVolume || 0) - Number(a.dayVolume || 0)
    || String(a.id || '').localeCompare(String(b.id || ''));
}

export function researchAlertKey(candidate) {
  return candidateKey(candidate);
}

export function mergeResearchCandidates(input) {
  const groups = new Map();
  for (const candidate of input || []) {
    const key = candidateKey(candidate);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {...candidate, alphaSources: [candidate.alpha]});
      continue;
    }
    const winner = compare(candidate, current) < 0 ? candidate : current;
    const alphaSources = [...new Set([...(current.alphaSources || [current.alpha]), candidate.alpha])].sort();
    groups.set(key, {...winner, alphaSources, alphaOverlap: alphaSources.length > 1});
  }
  return [...groups.values()].sort((a, b) => Number(a.t) - Number(b.t) || String(a.side).localeCompare(String(b.side)) || compare(a, b));
}

export function rankResearchCandidates(input, {sameTimePerSide = 3} = {}) {
  const groups = new Map();
  for (const candidate of mergeResearchCandidates(input)) {
    const key = `${candidate.t}|${candidate.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  return [...groups.values()]
    .flatMap(group => group.sort(compare).slice(0, sameTimePerSide))
    .sort((a, b) => Number(a.t) - Number(b.t) || String(a.side).localeCompare(String(b.side)) || compare(a, b));
}
