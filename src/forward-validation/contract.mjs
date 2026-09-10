import crypto from 'node:crypto';

export const DAY = 86_400_000;
// Production cooldown is 72 hours, not 72 calendar days.
export const COOLDOWN_MS = 3 * DAY;
export const MINIMUM_DURATION_DAYS = 90;
export const MINIMUM_INDEPENDENT_SIGNALS = 50;

export const FORWARD_STATUSES = Object.freeze(['PREPARED', 'ACTIVE', 'COMPLETED', 'INVALIDATED']);
export const SIGNAL_STRATEGIES = Object.freeze(['V7.5', 'V8']);
export const MANUAL_DECISIONS = Object.freeze(['SKIPPED', 'TAKEN', 'WATCHED']);
export const IMMUTABLE_SIGNAL_FIELDS = Object.freeze([
  'signalTime', 'side', 'referenceEntry', 'stopLoss', 'takeProfit', 'strategy', 'strategyHash',
]);

function numberTime(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : NaN;
}

function iso(value) {
  const time = numberTime(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function requiredSignalFields(signal) {
  return [
    ['strategy', SIGNAL_STRATEGIES.includes(signal.strategy)],
    ['strategyHash', typeof signal.strategyHash === 'string' && signal.strategyHash.length > 0],
    ['symbol', typeof signal.symbol === 'string' && signal.symbol.length > 0],
    ['side', signal.side === 'long' || signal.side === 'short'],
    ['signalTime', Number.isFinite(numberTime(signal.signalTime))],
    ['observedAt', Number.isFinite(numberTime(signal.observedAt))],
    ['referenceEntry', Number.isFinite(Number(signal.referenceEntry)) && Number(signal.referenceEntry) > 0],
    ['stopLoss', Number.isFinite(Number(signal.stopLoss)) && Number(signal.stopLoss) > 0],
    ['takeProfit', Number.isFinite(Number(signal.takeProfit)) && Number(signal.takeProfit) > 0],
  ];
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function deterministicSignalKey(signal) {
  const time = numberTime(signal.signalTime);
  return sha256([signal.strategy, signal.symbol, signal.side, Number.isFinite(time) ? time : 'invalid'].join('|'));
}

export function overlapGroupId(signal) {
  const time = numberTime(signal.signalTime);
  if (!signal.symbol || !signal.side || !Number.isFinite(time)) return null;
  return sha256(['overlap', signal.symbol, signal.side, time].join('|'));
}

export function createPreparedRun({
  runId = `forward-${crypto.randomUUID()}`,
  preparedAt = Date.now(),
  baseMainSha,
  v75StrategySha256,
  v8StrategySha256,
  strategyFreezeManifestSha256,
  deploymentReference = null,
  notes = 'Prepared only; explicit activation is required.',
} = {}) {
  if (!baseMainSha || !v75StrategySha256 || !v8StrategySha256 || !strategyFreezeManifestSha256) {
    throw new Error('forward run requires base and strategy fingerprints');
  }
  const prepared = iso(preparedAt);
  return {
    runId,
    status: 'PREPARED',
    preparedAt: prepared,
    startedAt: null,
    endedAt: null,
    minimumEndAt: null,
    minimumDurationDays: MINIMUM_DURATION_DAYS,
    minimumSignals: MINIMUM_INDEPENDENT_SIGNALS,
    baseMainSha,
    v75StrategySha256,
    v8StrategySha256,
    strategyFreezeManifestSha256,
    deploymentReference,
    notes,
    invalidatedAt: null,
    invalidationReason: null,
  };
}

export function activateRun(run, {startedAt = Date.now()} = {}) {
  if (run.status !== 'PREPARED') throw new Error(`only PREPARED runs may activate; got ${run.status}`);
  const start = numberTime(startedAt);
  if (!Number.isFinite(start) || start < numberTime(run.preparedAt)) throw new Error('active start must be after preparation');
  return {...run, status: 'ACTIVE', startedAt: iso(start), minimumEndAt: iso(start + MINIMUM_DURATION_DAYS * DAY)};
}

export function invalidateRun(run, reason, {at = Date.now()} = {}) {
  if (!reason) throw new Error('invalidation reason is required');
  if (run.status === 'COMPLETED') throw new Error('completed run cannot be invalidated silently');
  return {...run, status: 'INVALIDATED', invalidatedAt: iso(at), invalidationReason: reason};
}

export function enforceStrategyHashes(run, {v75StrategySha256, v8StrategySha256, at = Date.now()} = {}) {
  if (run.status !== 'ACTIVE') return run;
  if (run.v75StrategySha256 !== v75StrategySha256 || run.v8StrategySha256 !== v8StrategySha256) {
    return invalidateRun(run, 'STRATEGY_MUTATION', {at});
  }
  return run;
}

export function assertImmutableSignalUpdate(previous, next) {
  for (const field of IMMUTABLE_SIGNAL_FIELDS) {
    if (stableJson(previous?.[field]) !== stableJson(next?.[field])) throw new Error(`immutable signal field changed: ${field}`);
  }
  return true;
}

function priorSameEpisode(signals, signal) {
  const time = numberTime(signal.signalTime);
  return signals
    .filter(row => row.dataQualityStatus !== 'INVALID_SIGNAL_DATA' && row.symbol === signal.symbol && row.side === signal.side)
    .filter(row => Math.abs(numberTime(row.signalTime) - time) < COOLDOWN_MS)
    .sort((a, b) => numberTime(a.signalTime) - numberTime(b.signalTime) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

export function buildForwardSignal(signal, {run, existingSignals = []} = {}) {
  if (!run || run.status !== 'ACTIVE') throw new Error('forward signals require an ACTIVE run');
  const fields = requiredSignalFields(signal);
  const dataQualityStatus = fields.every(([, valid]) => valid) ? 'VALID' : 'INVALID_SIGNAL_DATA';
  const observedAt = numberTime(signal.observedAt);
  if (Number.isFinite(observedAt) && observedAt < numberTime(run.startedAt)) throw new Error('historical backfill is forbidden');
  const signalTime = numberTime(signal.signalTime);
  const id = signal.id || deterministicSignalKey({...signal, signalTime});
  const built = {
    id,
    runId: run.runId,
    strategy: signal.strategy ?? null,
    strategyHash: signal.strategyHash ?? null,
    origin: signal.origin || 'forward-validation',
    symbol: signal.symbol ?? null,
    side: signal.side ?? null,
    signalTime: iso(signalTime),
    observedAt: iso(observedAt),
    signalPrice: signal.signalPrice ?? signal.referenceEntry ?? null,
    referenceEntry: signal.referenceEntry ?? null,
    stopLoss: signal.stopLoss ?? null,
    takeProfit: signal.takeProfit ?? null,
    stopPct: signal.stopPct ?? null,
    targetR: signal.targetR ?? null,
    marketRegime: signal.marketRegime ?? null,
    score: signal.score ?? null,
    confidence: signal.confidence ?? null,
    funding: signal.funding ?? null,
    context: signal.context ?? null,
    emailEligible: signal.emailEligible ?? false,
    emailSent: signal.emailSent ?? false,
    emailSentAt: signal.emailSentAt ?? null,
    overlapGroupId: overlapGroupId(signal),
    dedupeKey: deterministicSignalKey({...signal, signalTime}),
    dataQualityStatus,
    createdAt: iso(signal.createdAt ?? Date.now()),
  };
  if (dataQualityStatus === 'VALID') {
    const prior = priorSameEpisode(existingSignals, built);
    built.independent = !prior;
    built.independentId = prior?.independentId || sha256(['independent', built.symbol, built.side, built.signalTime].join('|'));
    built.duplicateOf = prior?.id ?? null;
  } else {
    built.independent = false;
    built.independentId = null;
    built.duplicateOf = null;
  }
  return built;
}

export function countIndependentSignals(signals, {closedSignalIds = null} = {}) {
  const allowed = closedSignalIds ? new Set(closedSignalIds) : null;
  return new Set((signals || [])
    .filter(signal => signal.dataQualityStatus !== 'INVALID_SIGNAL_DATA' && signal.independent)
    .filter(signal => !allowed || allowed.has(signal.id))
    .map(signal => signal.independentId)).size;
}

export function evaluateForwardStatus(run, {signals = [], outcomes = [], now = Date.now(), dataIntegrity = true, strategyHashesUnchanged = true} = {}) {
  if (run.status === 'PREPARED') return {verdict: 'INSUFFICIENT_FORWARD_SAMPLE', durationReady: false, signalReady: false, evaluable: false};
  if (run.status === 'INVALIDATED') return {verdict: 'FORWARD_STOP_CANDIDATE', durationReady: false, signalReady: false, evaluable: false, reason: run.invalidationReason};
  const elapsedDays = Math.max(0, (numberTime(now) - numberTime(run.startedAt)) / DAY);
  const closedSignalIds = (outcomes || []).filter(row => row.status === 'closed' || row.closedAt || row.closed_at).map(row => row.signalId || row.signal_id);
  const independentClosed = countIndependentSignals(signals, {closedSignalIds});
  const durationReady = elapsedDays >= MINIMUM_DURATION_DAYS;
  const signalReady = independentClosed >= MINIMUM_INDEPENDENT_SIGNALS;
  if (!durationReady || !signalReady) return {verdict: 'INSUFFICIENT_FORWARD_SAMPLE', durationReady, signalReady, evaluable: false, elapsedDays, independentClosed};
  if (!dataIntegrity || !strategyHashesUnchanged) return {verdict: 'FORWARD_STOP_CANDIDATE', durationReady, signalReady, evaluable: true, elapsedDays, independentClosed};
  return {verdict: 'EVALUABLE', durationReady, signalReady, evaluable: true, elapsedDays, independentClosed};
}

export function completeRun(run, evaluation, {endedAt = Date.now()} = {}) {
  if (run.status !== 'ACTIVE') throw new Error(`only ACTIVE runs may complete; got ${run.status}`);
  if (!evaluation?.evaluable) throw new Error('run cannot complete before the minimum duration and signal count');
  return {...run, status: 'COMPLETED', endedAt: iso(endedAt)};
}

export function recordAdvisoryWithForwardLogging(advisory, forwardLogger) {
  return Promise.resolve().then(async () => {
    try {
      const forward = await forwardLogger(advisory);
      return {advisorySuppressed: false, forward, forwardLoggingError: null};
    } catch (error) {
      return {advisorySuppressed: false, forward: null, forwardLoggingError: String(error)};
    }
  });
}
