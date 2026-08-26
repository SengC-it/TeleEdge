export const EPISODE_REFRACTORY_HOURS = Object.freeze({
  trend_pullback_continuation: 120,
  volatility_expansion: 72,
  failed_breakout_reversal: 96,
  mean_reversion_extreme: 72,
  funding_price_divergence: 72,
  relative_strength_btc_rotation: 120,
});

function episodeKey(candidate) {
  return `${candidate.marketId || candidate.symbol}|${candidate.side}|${candidate.alpha}`;
}

export function dedupeResearchEpisodes(rows, {refractoryHoursByAlpha = EPISODE_REFRACTORY_HOURS} = {}) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = episodeKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const output = [];
  for (const group of groups.values()) {
    group.sort((a, b) => Number(a.t) - Number(b.t) || String(a.id).localeCompare(String(b.id)));
    let lastEntry = -Infinity;
    let episodeNumber = 0;
    for (const candidate of group) {
      const refractoryMs = Number(refractoryHoursByAlpha[candidate.alpha] || 72) * 3_600_000;
      if (Number(candidate.t) - lastEntry < refractoryMs) continue;
      episodeNumber++;
      lastEntry = Number(candidate.t);
      output.push({
        ...candidate,
        episodeId: `${episodeKey(candidate)}|episode-${episodeNumber}`,
        episodeEntry: true,
        episodeRefractoryHours: refractoryMs / 3_600_000,
      });
    }
  }
  return output.sort((a, b) => Number(a.t) - Number(b.t) || String(a.id).localeCompare(String(b.id)));
}
