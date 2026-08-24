export const NOTIFIABLE_STAGES = Object.freeze([
  'candidate',
  'ranked signal',
  'accepted signal',
  'notifiable alert',
  'email sent',
]);

export const ALERT_SOURCES = Object.freeze({
  control: 'V7.5 CONTROL',
  shadow: 'V8 SHADOW',
});

export const REJECTION_CATEGORIES = Object.freeze([
  'fill unavailable',
  'slippage',
  'stop-risk',
  'cooldown',
  'position cap',
  'quantity/minQty',
  'symbol already open',
  'other',
]);

function finiteTime(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : NaN;
}

function sourceRank(source) {
  return source === ALERT_SOURCES.control ? 0 : source === ALERT_SOURCES.shadow ? 1 : 2;
}

export function alertKey(event) {
  const symbol = event?.marketId ?? event?.market_id ?? event?.symbol;
  const side = event?.side;
  const signalTime = finiteTime(event?.signalTime ?? event?.signal_time ?? event?.t);
  if (!symbol || !side || !Number.isFinite(signalTime)) return null;
  return `${symbol}|${side}|${signalTime}`;
}

export function sourceForModel(model) {
  const value = typeof model === 'string' ? model : model?.model ?? model?.modelVersion ?? model?.model_version;
  return String(value || '').toUpperCase().includes('V8') ? ALERT_SOURCES.shadow : ALERT_SOURCES.control;
}

export function classifyRejection(reason) {
  const value = String(reason || '').toLowerCase();
  if (value.includes('fill') || value.includes('execution-data') || value.includes('market-data')) return 'fill unavailable';
  if (value.includes('slippage')) return 'slippage';
  if (value.includes('stop') || value.includes('target') || value.includes('risk') || value.includes('invalid-fill-or-stop')) return 'stop-risk';
  if (value.includes('cooldown')) return 'cooldown';
  if (value.includes('cap')) return 'position cap';
  if (value.includes('quantity') || value.includes('minqty') || value.includes('minimum')) return 'quantity/minQty';
  if (value.includes('symbol-already-open') || value.includes('already-open')) return 'symbol already open';
  return 'other';
}

export function sourceLabel(sources) {
  const normalized = [...new Set(sources || [])].sort((a, b) => sourceRank(a) - sourceRank(b) || a.localeCompare(b));
  if (normalized.includes(ALERT_SOURCES.control) && normalized.includes(ALERT_SOURCES.shadow)) return 'V7.5 CONTROL + V8 SHADOW';
  if (normalized.includes(ALERT_SOURCES.shadow)) return 'V8 SHADOW / EXPERIMENTAL';
  if (normalized.includes(ALERT_SOURCES.control)) return 'V7.5 CONTROL';
  return 'UNKNOWN';
}

export function notifiableAlert(signal, source, {emailSent = null} = {}) {
  const key = alertKey(signal);
  if (!key) throw new Error('notifiable alert requires symbol, side, and signal time');
  const payload = {...signal};
  return {
    key,
    symbol: signal.marketId ?? signal.market_id ?? signal.symbol,
    side: signal.side,
    signalTime: finiteTime(signal.signalTime ?? signal.signal_time ?? signal.t),
    source,
    sources: [source],
    sourceLabel: sourceLabel([source]),
    stage: 'notifiable alert',
    emailSent,
    payload,
  };
}

export function mergeNotifiableAlerts(entries) {
  const merged = new Map();
  for (const entry of entries || []) {
    if (!entry || entry.stage === 'candidate' || entry.stage === 'ranked signal') continue;
    const key = entry.key || alertKey(entry.payload || entry);
    if (!key) continue;
    const source = entry.source || sourceForModel(entry.model || entry.payload);
    const previous = merged.get(key);
    if (!previous) {
      const sources = [...new Set([...(entry.sources || []), source])];
      merged.set(key, {
        ...entry,
        key,
        source,
        sources,
        sourceLabel: sourceLabel(sources),
        stage: 'notifiable alert',
      });
      continue;
    }
    const sources = [...new Set([...(previous.sources || []), source])];
    const preferred = sourceRank(source) < sourceRank(previous.source) ? entry : previous;
    merged.set(key, {
      ...previous,
      ...preferred,
      key,
      source: preferred.source || previous.source,
      sources,
      sourceLabel: sourceLabel(sources),
      emailSent: previous.emailSent === true || entry.emailSent === true
        ? true
        : previous.emailSent ?? entry.emailSent ?? null,
      stage: 'notifiable alert',
    });
  }
  return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function summarizeNotifiableAlerts(entries) {
  const alerts = mergeNotifiableAlerts(entries);
  const countByLabel = label => alerts.filter(alert => alert.sourceLabel === label).length;
  return {
    alerts,
    v75: countByLabel('V7.5 CONTROL'),
    v8Only: countByLabel('V8 SHADOW / EXPERIMENTAL'),
    overlapDeduped: countByLabel('V7.5 CONTROL + V8 SHADOW'),
    combined: alerts.length,
    emailSent: alerts.filter(alert => alert.emailSent === true).length,
    actualSignalIncreasePct: null,
  };
}

export function rejectionBreakdown(rows) {
  const categories = Object.fromEntries(REJECTION_CATEGORIES.map(category => [category, 0]));
  const byReason = {};
  const signals = (rows || []).map(row => {
    const rawReason = String(row.reason || row.rejectionReason || 'unknown');
    const category = classifyRejection(rawReason);
    categories[category]++;
    byReason[rawReason] = (byReason[rawReason] || 0) + 1;
    return {
      signalId: row.signalId || row.id || null,
      symbol: row.symbol || row.marketId || row.market_id || null,
      side: row.side || null,
      signalTime: finiteTime(row.signalTime ?? row.signal_time ?? row.t),
      stage: row.stage || 'accepted signal',
      reason: category,
      rawReason,
      firstFailureTimestamp: row.firstFailureTimestamp ?? row.failureTime ?? null,
      gapStart: row.gapStart ?? null,
      gapEnd: row.gapEnd ?? null,
      missingDurationMs: row.missingDurationMs ?? null,
      boundary: row.boundary || null,
    };
  });
  return {total: signals.length, categories, byReason, signals};
}
