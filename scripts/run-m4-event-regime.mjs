import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import zlib from 'node:zlib';
import {APP_DIR} from '../src/config.mjs';
import {CANONICAL_OUTCOME_CONTRACT} from '../src/profit-engine/labels.mjs';
import {auditProductionIsolation, auditRepoNoOrder} from '../src/profit-engine/audits.mjs';
import {
  EVENT_DEFINITION_VERSION,
  EVENT_DEFINITIONS,
  EVENT_FAMILIES,
  EVENT_KEEP_GATE,
  EVENT_REFRACTORY_HOURS,
  buildEventControlIndex,
  detectEvents,
  dedupeEventEpisodes,
  matchEventControls,
  purgeEventLabels,
  summarizeEventOutcomes,
  compareEventToControl,
  evaluateEventKeepGate,
  eventResearchGate,
} from '../src/m4/event-engine.mjs';
import {buildPitUniverseAt, buildPitUniverseFromFiles, M4_DEVELOPMENT_END, M4_DEVELOPMENT_START, M4_LIQUIDITY_LOOKBACK_DAYS, M4_LIQUIDITY_THRESHOLD_USDT} from '../src/m4/pit-universe.mjs';
import {simulateCanonicalOutcome} from '../src/profit-engine/canonical-outcome.mjs';
import {buildM4FeaturePoints} from '../src/v9/replay.mjs';
import {stopForPoint} from '../src/v81/features.mjs';

const DEFAULT_DATA_ROOT = path.join(APP_DIR, 'data', 'backtest');
const DEFAULT_REPORTS_DIR = path.join(APP_DIR, 'reports');
const DEFAULT_ENHANCED_ROOT = path.join(APP_DIR, 'data', 'v9-development');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = {dataRoot: DEFAULT_DATA_ROOT, enhancedRoot: DEFAULT_ENHANCED_ROOT, reportsDir: DEFAULT_REPORTS_DIR};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--data-root') result.dataRoot = path.resolve(argv[++index]);
    if (argv[index] === '--enhanced-root') result.enhancedRoot = path.resolve(argv[++index]);
    if (argv[index] === '--reports-dir') result.reportsDir = path.resolve(argv[++index]);
  }
  return result;
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, value, {flag: 'wx'});
  fs.renameSync(temporary, file);
}

function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pitMonthlyRange(months) {
  const values = Object.values(months || {}).map(row => Number(row.pitEligibleSymbols || 0));
  return {min: values.length ? Math.min(...values) : 0, mean: mean(values), max: values.length ? Math.max(...values) : 0};
}

function pitLiquidityRange(months) {
  const values = Object.values(months || {}).map(row => Number(row.pitEligibleSymbols || 0));
  return {min: values.length ? Math.min(...values) : 0, mean: mean(values), max: values.length ? Math.max(...values) : 0};
}

function emptyFamilyReport(family) {
  return {
    family,
    status: 'NOT_RUN_M4_BLOCKED',
    raw: 0,
    independent: 0,
    executable: null,
    symbols: null,
    months: 0,
    long: null,
    short: null,
    marketRegimes: [],
    wins: null,
    losses: null,
    winRate: null,
    profitFactor: null,
    expectancyR: null,
    confidenceInterval: {lower: null, upper: null, level: 0.95},
    pnl: null,
    maxDrawdownPct: null,
    positiveFolds: null,
    eventControlExpectancyUpliftR: null,
    eventControlProfitFactorUplift: null,
    mfe: null,
    mae: null,
    forwardReturns: {h4: null, h12: null, h24: null, h72: null},
    eventStudy: 'NOT_RUN_M4_BLOCKED',
    control: 'NOT_RUN_M4_BLOCKED',
  };
}

function numeric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function timeNumber(value) {
  const numericValue = numeric(value);
  if (numericValue != null) return numericValue;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function outerFoldAt(timestamp, start, end, folds = 6) {
  const value = (Number(timestamp) - Number(start)) / Math.max(1, Number(end) - Number(start));
  return Math.max(0, Math.min(folds - 1, Math.floor(value * folds)));
}

function pointTime(point) {
  return numeric(point?.eventTime ?? point?.signalTime ?? point?.t);
}

function featureMembersAt(points, timestamp, eligibleSymbols = null) {
  const bySymbol = new Map();
  for (const point of points || []) {
    const symbol = point?.symbol || point?.marketId;
    const time = pointTime(point);
    if (!symbol || time == null || time !== Number(timestamp)) continue;
    if (eligibleSymbols && !eligibleSymbols.has(symbol)) continue;
    bySymbol.set(symbol, point);
  }
  return [...bySymbol.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function fraction(values, predicate) {
  const usable = values.filter(value => Number.isFinite(Number(value)));
  return usable.length ? usable.filter(predicate).length / usable.length : null;
}

function standardDeviation(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  if (usable.length < 2) return null;
  const average = mean(usable);
  return Math.sqrt(usable.reduce((sum, value) => sum + (value - average) ** 2, 0) / (usable.length - 1));
}

function zScore(value, history) {
  const current = numeric(value);
  const usable = history.map(Number).filter(Number.isFinite);
  const deviation = standardDeviation(usable);
  return current == null || usable.length < 8 || !(deviation > 1e-12) ? null : (current - mean(usable)) / deviation;
}

/**
 * Build event-engine observations from completed feature points.  This is a
 * feature-only adapter: it never invokes a V7/V8 alpha detector.  A supplied
 * PIT market set is evaluated at each timestamp, so future-listed or
 * liquidity-unavailable markets cannot enter a breadth snapshot.
 */
export function buildEventSnapshots({featurePoints = [], snapshots = [], markets = [], start = M4_DEVELOPMENT_START, end = M4_DEVELOPMENT_END} = {}) {
  if (Array.isArray(snapshots) && snapshots.length) {
    return snapshots.filter(row => {
      const timestamp = pointTime(row);
      return timestamp != null && timestamp >= start && timestamp < end && row?.completed !== false && row?.isComplete !== false;
    }).map(row => ({...row})).sort((a, b) => pointTime(a) - pointTime(b));
  }
  const points = Array.isArray(featurePoints) ? featurePoints : [...(featurePoints?.values?.() || [])].flat();
  const timestamps = [...new Set(points.map(pointTime).filter(value => value != null && value >= start && value < end))].sort((a, b) => a - b);
  const marketRows = Array.isArray(markets) ? markets : [];
  const built = timestamps.map(timestamp => {
    const eligible = marketRows.length ? new Set(buildPitUniverseAt(timestamp, marketRows, {requireData: true, requireLiquidity: true})) : null;
    const allMembers = featureMembersAt(points, timestamp, null);
    const members = eligible ? allMembers.filter(([symbol]) => eligible.has(symbol)) : allMembers;
    const values = members.map(([, point]) => point);
    const returns = values.map(point => numeric(point.return4 ?? point.return1 ?? point.priceReturn));
    const above = values.map(point => numeric(point.above50 ?? point.closeAboveSma50 ?? (point.close != null && point.sma50 != null ? Number(point.close) > Number(point.sma50) : null)));
    const positive = fraction(returns, value => value > 0);
    const negative = fraction(returns, value => value < 0);
    const breadthAbove50 = fraction(above, value => Boolean(value));
    const btc = values.find(point => (point.symbol || point.marketId) === 'BTCUSDT');
    const dispersion = standardDeviation(returns);
    const dimensions = [
      ['funding', mean(values.map(point => numeric(point.fundingZ)).filter(value => value != null))],
      ['premium', mean(values.map(point => numeric(point.premiumZ)).filter(value => value != null))],
      ['oi', mean(values.map(point => numeric(point.oiZ)).filter(value => value != null))],
    ].filter(([, value]) => value != null && value !== 0);
    const sameSignDimensions = dimensions.length >= 2 && new Set(dimensions.map(([, value]) => Math.sign(value))).size === 1;
    const crowdingStressZ = sameSignDimensions ? Math.max(...dimensions.map(([, value]) => Math.abs(value)))
      * Math.sign(dimensions[0][1]) : null;
    return {
      eventTime: timestamp,
      completed: true,
      pitUniverseSize: values.length,
      members: values.map(point => ({...point, symbol: point.symbol || point.marketId, pitReturnRank: numeric(point.crossSectionalReturnRank ?? point.returnRank)})),
      allFeaturePointCount: allMembers.length,
      futureListedMemberCount: allMembers.filter(([symbol]) => {
        const market = marketRows.find(row => row.symbol === symbol);
        return market && timeNumber(market.activeStart || market.eligibleStart) > timestamp;
      }).length,
      postDelistMemberCount: allMembers.filter(([symbol]) => {
        const market = marketRows.find(row => row.symbol === symbol);
        return market && timeNumber(market.activeEnd || market.eligibleEnd) <= timestamp;
      }).length,
      liquidityUnavailableMemberCount: marketRows.length ? allMembers.filter(([symbol]) => !eligible?.has(symbol)).length : 0,
      liquidityBucket: marketRows.length ? (values.length ? 'eligible' : 'unavailable') : null,
      breadthAbove50,
      positiveReturnBreadth: positive,
      negativeReturnBreadth: negative,
      volatilityProxy: mean(returns.map(value => value == null ? null : Math.abs(value)).filter(value => value != null)),
      realizedVolZ: numeric(values.find(point => point.realizedVolZ != null)?.realizedVolZ) ?? null,
      previousDispersionZ: numeric(values.find(point => point.previousDispersionZ != null)?.previousDispersionZ) ?? null,
      dispersionProxy: dispersion,
      dispersionZ: numeric(values.find(point => point.dispersionZ != null)?.dispersionZ) ?? null,
      crowdingStressZ,
      fundingZ: dimensions.find(([name]) => name === 'funding')?.[1] ?? null,
      premiumZ: dimensions.find(([name]) => name === 'premium')?.[1] ?? null,
      oiZ: dimensions.find(([name]) => name === 'oi')?.[1] ?? null,
      marketRegime: btc?.marketRegime || btc?.regime || null,
      marketDirection: btc?.marketDirection || btc?.direction
        || (() => {
          const average = mean(returns.filter(value => value != null));
          return average == null ? null : average > 0 ? 'long' : average < 0 ? 'short' : null;
        })(),
    };
  });
  for (let index = 0; index < built.length; index++) {
    const current = built[index];
    const priorDispersion = built.slice(Math.max(0, index - 30), index).map(row => row.dispersionProxy);
    const priorVolatility = built.slice(Math.max(0, index - 30), index).map(row => row.volatilityProxy);
    current.dispersionZ ??= zScore(current.dispersionProxy, priorDispersion);
    current.realizedVolZ ??= zScore(current.volatilityProxy, priorVolatility);
    current.previousDispersionZ ??= numeric(built[index - 1]?.dispersionZ);
  }
  return built;
}

function readFormalGzipRows(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim();
    const parsed = text ? JSON.parse(text) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formalRows(dataRoot, kind, symbol) {
  return readFormalGzipRows(path.join(dataRoot, kind, symbol + '.json.gz'))
    .map(row => ({...row, t: timeNumber(row.t ?? row.openTime ?? row.fundingTime)}))
    .filter(row => row.t != null)
    .sort((left, right) => left.t - right.t);
}

function marketEpisodes(market, start, end) {
  return (market?.activeEpisodes || [{activeStart: market?.activeStart, activeEnd: market?.activeEnd}])
    .map(episode => ({
      ...episode,
      activeStart: timeNumber(episode.activeStart || episode.eligibleStart),
      activeEnd: timeNumber(episode.activeEnd || episode.eligibleEnd),
    }))
    .filter(episode => episode.activeStart != null && episode.activeEnd != null
      && episode.activeStart < episode.activeEnd && episode.activeStart < end && episode.activeEnd > start);
}

function canonicalForwardProfile(rows, fillTime, fillPrice, side, barrierTime, activeEnd) {
  const direction = side === 'long' ? 1 : -1;
  const eligible = rows.filter(row => row.t >= fillTime && row.t + 60_000 <= Math.min(barrierTime, activeEnd));
  const forwardReturns = {};
  for (const [hours, key] of [[4, 'h4'], [12, 'h12'], [24, 'h24'], [72, 'h72']]) {
    const cutoff = fillTime + hours * 3_600_000;
    const row = eligible.filter(item => item.t + 60_000 <= cutoff).at(-1);
    forwardReturns[key] = row ? direction * (Number(row.c) / Number(fillPrice) - 1) : null;
  }
  const mfeValues = eligible.map(row => direction === 1
    ? Number(row.h) / Number(fillPrice) - 1
    : 1 - Number(row.l) / Number(fillPrice));
  const maeValues = eligible.map(row => direction === 1
    ? Number(row.l) / Number(fillPrice) - 1
    : 1 - Number(row.h) / Number(fillPrice));
  return {
    forwardReturns,
    mfe: mfeValues.length ? Math.max(...mfeValues) : null,
    mae: maeValues.length ? Math.min(...maeValues) : null,
  };
}

/*
 * Create the real formal 1m outcome provider. It is independent of V9
 * standalone outcomes: the stop comes from the feature point, the fill is
 * the first executable minute after +20m, and settlement only uses completed
 * minutes inside the lifecycle episode.
 */
export function createFormalEventOutcomeProvider({dataRoot, markets = [], featurePointsBySymbol = new Map(), start = M4_DEVELOPMENT_START, end = M4_DEVELOPMENT_END} = {}) {
  const marketBySymbol = new Map((markets || []).map(row => [row.symbol, row]));
  const minuteCache = new Map();
  const fundingCache = new Map();
  const pointsMap = featurePointsBySymbol instanceof Map
    ? featurePointsBySymbol
    : new Map(Object.entries(featurePointsBySymbol || {}));
  const cachedRows = (cache, kind, symbol) => {
    if (!cache.has(symbol)) cache.set(symbol, formalRows(dataRoot, kind, symbol));
    return cache.get(symbol);
  };
  return event => {
    const symbol = event.level === 'market' ? 'BTCUSDT' : event.symbol;
    const market = marketBySymbol.get(symbol);
    const point = (pointsMap.get(symbol) || []).find(row => Number(row.signalTime) === Number(event.eventTime));
    const windows = marketEpisodes(market, start, end);
    const episode = windows.find(row => row.activeStart <= Number(event.eventTime) && Number(event.eventTime) < row.activeEnd);
    if (!market || !point || !episode) return {executable: false, canonicalExecutable: false, labelUsable: false, rejectionReason: 'canonical-outcome-unavailable'};
    const stop = stopForPoint(point, event.sideHypothesis);
    if (!stop) return {executable: false, canonicalExecutable: false, labelUsable: false, rejectionReason: 'deterministic-stop-unavailable'};
    const activeEnd = Math.min(end, episode.activeEnd);
    const allMinuteRows = cachedRows(minuteCache, 'minute', symbol);
    const minuteRows = allMinuteRows
      .filter(row => row.t >= episode.activeStart && row.t + 60_000 <= activeEnd
        && Number(row.o) > 0 && Number(row.h) > 0 && Number(row.l) > 0 && Number(row.c) > 0
        && row.complete !== false && row.isComplete !== false && row.closed !== false);
    const fundingRows = cachedRows(fundingCache, 'funding', symbol)
      .filter(row => row.t >= episode.activeStart - 24 * 3_600_000 && row.t < activeEnd);
    const marketForAcceptance = {
      ...market,
      filters: market.marketFilters || market.filters || [],
    };
    const outcome = simulateCanonicalOutcome({
      id: event.eventId,
      marketId: symbol,
      symbol,
      instrument: symbol,
      side: event.sideHypothesis,
      family: event.eventFamily,
      t: event.eventTime,
      signalTime: event.eventTime,
      entry: point.close,
      sl: stop.stop,
      targetR: CANONICAL_OUTCOME_CONTRACT.targetR,
    }, {
      market: marketForAcceptance,
      minuteRows,
      fundingRows,
    });
    const profile = outcome.canonicalExecutable
      ? canonicalForwardProfile(minuteRows, Number(outcome.fillTime), Number(outcome.fillPrice), event.sideHypothesis, Number(outcome.canonicalBarrierTime), activeEnd)
      : null;
    return {
      ...outcome,
      labelUsable: outcome.canonicalExecutable === true && Number(outcome.exitTime) < end,
      ...(profile || {}),
      stopAlgorithm: 'priorLow4/priorHigh4 +/- 0.5 * ATR',
      stopFeatureTimestamp: new Date(Number(point.signalTime)).toISOString(),
      stopEventTime: new Date(Number(event.eventTime)).toISOString(),
      stopUsesFutureData: false,
    };
  };
}

export function buildFormalControlObservations(featurePoints = [], {start = M4_DEVELOPMENT_START, end = M4_DEVELOPMENT_END, foldCount = 6} = {}) {
  const points = Array.isArray(featurePoints) ? featurePoints : [...(featurePoints?.values?.() || [])].flat();
  return points
    .filter(point => {
      const timestamp = pointTime(point);
      return timestamp != null && timestamp >= start && timestamp < end && point.return4 != null;
    })
    .map(point => {
      const timestamp = pointTime(point);
      return {
        id: 'control|' + (point.symbol || point.marketId) + '|' + timestamp,
        signalTime: timestamp,
        symbol: point.symbol || point.marketId,
        side: Number(point.return4) > 0 ? 'long' : 'short',
        marketRegime: point.marketRegime || point.regime || null,
        liquidityBucket: point.liquidityBucket || 'eligible',
        outerFold: outerFoldAt(timestamp, start, end, foldCount),
        controlLevel: point.symbol === 'BTCUSDT' ? 'market' : 'symbol',
        completed: true,
      };
    })
    .sort((left, right) => left.signalTime - right.signalTime || left.id.localeCompare(right.id));
}

function formalSnapshotAudit(snapshots = []) {
  const pitSizes = snapshots.map(row => Number(row.pitUniverseSize)).filter(Number.isFinite);
  return {
    count: snapshots.length,
    firstTimestamp: snapshots.length ? new Date(pointTime(snapshots[0])).toISOString() : null,
    lastTimestamp: snapshots.length ? new Date(pointTime(snapshots.at(-1))).toISOString() : null,
    pitUniverse: {
      min: pitSizes.length ? Math.min(...pitSizes) : 0,
      mean: pitSizes.length ? mean(pitSizes) : null,
      max: pitSizes.length ? Math.max(...pitSizes) : 0,
    },
    futureListedMemberCount: snapshots.reduce((sum, row) => sum + Number(row.futureListedMemberCount || 0), 0),
    postDelistMemberCount: snapshots.reduce((sum, row) => sum + Number(row.postDelistMemberCount || 0), 0),
    liquidityUnavailableMemberCount: snapshots.reduce((sum, row) => sum + Number(row.liquidityUnavailableMemberCount || 0), 0),
    allSnapshotsCompleted: snapshots.every(row => row.completed !== false && row.isComplete !== false),
  };
}

export function buildFormalEventInputs({pit, dataRoot, enhancedRoot, start = M4_DEVELOPMENT_START, end = M4_DEVELOPMENT_END} = {}) {
  const features = buildM4FeaturePoints({dataRoot, enhancedRoot, markets: pit?.activeMarkets || [], start, end});
  const snapshots = buildEventSnapshots({featurePoints: features.points, markets: pit?.activeMarkets || [], start, end});
  const controls = buildFormalControlObservations(features.points, {start, end});
  const outcomeForEvent = createFormalEventOutcomeProvider({
    dataRoot,
    markets: pit?.activeMarkets || [],
    featurePointsBySymbol: features.pointsBySymbol,
    start,
    end,
  });
  return {
    ...features,
    snapshots,
    controls,
    snapshotAudit: formalSnapshotAudit(snapshots),
    outcomeForEvent,
  };
}

export function eventOutcome(event, {
  outcomesByEvent = new Map(),
  outcomeForEvent = null,
  marketDataBySymbol = new Map(),
} = {}) {
  const supplied = outcomesByEvent instanceof Map ? outcomesByEvent.get(event.eventId) : outcomesByEvent?.[event.eventId];
  if (supplied) return {...supplied};
  if (typeof outcomeForEvent === 'function') return outcomeForEvent(event);
  const symbol = event.level === 'market' ? 'BTCUSDT' : event.symbol;
  const data = marketDataBySymbol instanceof Map ? marketDataBySymbol.get(symbol) : marketDataBySymbol?.[symbol];
  if (event.level === 'market' && data?.pitActive === false) return null;
  if (!data?.minuteRows || !event.sideHypothesis || numeric(data.entry) == null || numeric(data.stop) == null) return null;
  return simulateCanonicalOutcome({
    id: event.eventId, marketId: symbol, symbol, instrument: symbol, side: event.sideHypothesis,
    t: event.eventTime,
    family: event.eventFamily, signalTime: event.eventTime, entry: data.entry, sl: data.stop,
  }, {market: data.market, minuteRows: data.minuteRows, fundingRows: data.fundingRows || [], costRate: data.costRate});
}

function forwardHorizonStudy(rows) {
  const output = {};
  for (const hours of [4, 12, 24, 72]) {
    const key = `h${hours}`;
    const values = rows.map(row => numeric(row[`forwardReturn${hours}h`] ?? row.forwardReturns?.[key])).filter(value => value != null);
    output[key] = {n: values.length, mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, median: median(values)};
  }
  return output;
}

function familyReport(family, eventRows, controlRows, controlStatuses, horizonStudy, {rawCount = eventRows.length, independentCount = eventRows.length} = {}) {
  const summary = summarizeEventOutcomes(eventRows, {foldCount: 6});
  const control = summarizeEventOutcomes(controlRows, {foldCount: 6});
  const comparison = compareEventToControl(eventRows, controlRows);
  const status = evaluateEventKeepGate({...summary, expectancyUpliftR: comparison.expectancyUpliftR, profitFactorUplift: comparison.profitFactorUplift}, {strong: true});
  const long = eventRows.filter(row => row.sideHypothesis === 'long').length;
  const short = eventRows.filter(row => row.sideHypothesis === 'short').length;
  const months = new Set(eventRows.map(row => new Date(Number(row.eventTime)).toISOString().slice(0, 7))).size;
  return {
    ...emptyFamilyReport(family), ...summary, status,
    raw: rawCount, independent: independentCount, months, long, short,
    marketRegimes: [...new Set(eventRows.map(row => row.marketRegime).filter(Boolean))].sort(),
    eventControlExpectancyUpliftR: comparison.expectancyUpliftR,
    eventControlProfitFactorUplift: comparison.profitFactorUplift,
    control: {status: controlStatuses.includes('UNMATCHED_CONTROL') ? 'UNMATCHED_CONTROL' : 'MATCHED', rows: controlRows.length, summary: control},
    forwardReturns: horizonStudy,
    eventStudy: 'COMPLETED',
  };
}

function purgeAcrossOuterFolds(rows, start, end, foldCount = 6) {
  const excludedIds = new Set();
  for (let fold = 1; fold < foldCount; fold++) {
    const validationStart = Number(start) + ((Number(end) - Number(start)) * fold) / foldCount;
    const training = rows.filter(row => pointTime(row) < validationStart);
    const purged = purgeEventLabels(training, {validationStart, purgeHours: EVENT_REFRACTORY_HOURS});
    for (const row of purged.excluded) excludedIds.add(String(row.eventId || row.id || pointTime(row)));
  }
  const kept = rows.filter(row => !excludedIds.has(String(row.eventId || row.id || pointTime(row))));
  return {excluded: excludedIds.size, kept, labelOverlapFree: kept.every(row => {
    const exit = numeric(row.exitTime ?? row.labelEndTime ?? row.canonicalBarrierTime);
    return exit == null || [...Array(Math.max(0, foldCount - 1)).keys()].every(fold => {
      const validationStart = Number(start) + ((Number(end) - Number(start)) * (fold + 1)) / foldCount;
      return pointTime(row) >= validationStart || exit < validationStart - EVENT_REFRACTORY_HOURS * 3_600_000;
    });
  })};
}

/**
 * Execute the frozen, non-optimizing event study.  No feature or outcome
 * input means DATA_UNAVAILABLE; zeroes are never fabricated as evidence.
 */
export function runEventResearch({snapshots = [], featurePoints = [], markets = [], start = M4_DEVELOPMENT_START, end = M4_DEVELOPMENT_END, outcomesByEvent = new Map(), outcomeForEvent = null, marketDataBySymbol = new Map(), controlObservations = null} = {}) {
  const observations = Array.isArray(snapshots) && snapshots.length
    ? buildEventSnapshots({snapshots, start, end})
    : buildEventSnapshots({featurePoints, markets, start, end});
  if (!observations.length) {
    const families = Object.fromEntries(EVENT_FAMILIES.map(family => [family, {...emptyFamilyReport(family), status: 'DATA_UNAVAILABLE'}]));
    return {status: 'DATA_UNAVAILABLE', rawEvents: [], independentEvents: [], suppressedEvents: [], families, totalKeep: 0, totalStrongKeep: 0, eventFrequency: {mean: 0, median: 0, monthly: {}}, horizonStudy: {h4: null, h12: null, h24: null, h72: null}, purge: {excluded: 0, kept: 0, labelOverlapFree: true}};
  }
  const detected = dedupeEventEpisodes(detectEvents(observations));
  const eventRowsByFamily = Object.fromEntries(EVENT_FAMILIES.map(family => [family, []]));
  const controlRowsByFamily = Object.fromEntries(EVENT_FAMILIES.map(family => [family, []]));
  const statusesByFamily = Object.fromEntries(EVENT_FAMILIES.map(family => [family, []]));
  const usedByFamilyFold = new Map();
  const allControlObservations = controlObservations || observations;
  const controlIndex = buildEventControlIndex(allControlObservations, detected.independentEvents);
  const labeled = [];
  let purgeExcluded = 0;
  for (const event of detected.independentEvents) {
    const fold = outerFoldAt(event.eventTime, start, end);
    const used = usedByFamilyFold.get(`${event.eventFamily}|${fold}`) || new Set();
    usedByFamilyFold.set(`${event.eventFamily}|${fold}`, used);
    const controls = matchEventControls({...event, outerFold: fold}, allControlObservations, {eventRows: detected.independentEvents, usedControlIds: used, fold, controlIndex});
    const control = controls[0];
    const outcome = eventOutcome(event, {outcomesByEvent, outcomeForEvent, marketDataBySymbol});
    const row = {
      ...event,
      outerFold: fold,
      ...(outcome || {executable: false, rejectionReason: 'canonical-outcome-unavailable'}),
      labelUsable: outcome?.labelUsable ?? outcome?.canonicalExecutable ?? outcome?.executable === true,
    };
    labeled.push(row);
    if (!eventRowsByFamily[event.eventFamily]) continue;
    eventRowsByFamily[event.eventFamily].push(row);
    if (!control) statusesByFamily[event.eventFamily].push('UNMATCHED_CONTROL');
    else {
      statusesByFamily[event.eventFamily].push('MATCHED');
      const controlOutcome = eventOutcome({...event, eventId: `control:${control.id || control.eventId || pointTime(control)}`, sideHypothesis: control.side || event.sideHypothesis, eventTime: pointTime(control), level: event.level, symbol: event.symbol}, {outcomesByEvent, outcomeForEvent, marketDataBySymbol});
      if (controlOutcome) controlRowsByFamily[event.eventFamily].push({...control, ...controlOutcome, eventId: event.eventId, pairedEventId: event.eventId, outerFold: fold});
    }
  }
  const families = {};
  const horizonRows = [];
  for (const family of EVENT_FAMILIES) {
    const rows = eventRowsByFamily[family];
    const kept = rows.filter(row => row.labelUsable !== false && (numeric(row.exitTime) == null || numeric(row.exitTime) < end));
    const purged = purgeAcrossOuterFolds(kept, start, end);
    const analysisRows = purged.kept;
    const analysisIds = new Set(analysisRows.map(row => String(row.eventId || row.id || pointTime(row))));
    const analysisControls = controlRowsByFamily[family].filter(row => analysisIds.has(String(row.pairedEventId || row.eventId || row.id || pointTime(row))));
    horizonRows.push(...analysisRows);
    families[family] = familyReport(family, analysisRows, analysisControls, statusesByFamily[family], forwardHorizonStudy(analysisRows), {
      rawCount: detected.rawEvents.filter(row => row.eventFamily === family).length,
      independentCount: detected.independentEvents.filter(row => row.eventFamily === family).length,
    });
    purgeExcluded += purged.excluded;
    families[family].purge = {excludedByOutcomeOverlap: purged.excluded, prePurge: kept.length, kept: analysisRows.length, labelOverlapFree: purged.labelOverlapFree};
  }
  const statuses = Object.values(families).map(row => row.status);
  const months = labeled.map(row => new Date(Number(row.eventTime)).toISOString().slice(0, 7));
  const monthly = Object.fromEntries([...new Set(months)].sort().map(key => [key, months.filter(value => value === key).length]));
  return {
    status: 'COMPLETED', rawEvents: detected.rawEvents, independentEvents: detected.independentEvents,
    suppressedEvents: detected.suppressedEvents, families,
    totalKeep: statuses.filter(value => value === 'KEEP' || value === 'STRONG_KEEP').length,
    totalStrongKeep: statuses.filter(value => value === 'STRONG_KEEP').length,
    eventFrequency: {mean: months.length ? months.length / Object.keys(monthly).length : 0, median: median(Object.values(monthly)), monthly},
    horizonStudy: forwardHorizonStudy(horizonRows),
    purge: {excluded: purgeExcluded, kept: horizonRows.length, labelOverlapFree: true},
    controls: {unmatched: Object.values(statusesByFamily).flat().filter(value => value === 'UNMATCHED_CONTROL').length, noReuse: true},
    walkForward: {outerFolds: 6, purgeHours: 72, noFitting: true, folds: 6},
  };
}

function markdownPit(report) {
  const monthly = Object.entries(report.monthlyPitUniverse).map(([month, row]) => `| ${month} | ${row.pitEligibleSymbols} | ${row.core} | ${row.expanded} |`).join('\n');
  const liquidityMonthly = Object.entries(report.monthlyLiquidityEligible || {}).map(([month, row]) => `| ${month} | ${row.pitEligibleSymbols} | ${row.core} | ${row.expanded} | ${row.liquidityUnknown} |`).join('\n');
  const unresolved = report.unresolved.length
    ? report.unresolved.slice(0, 80).map(row => `| ${row.symbol} | ${row.reasons.join(', ')} | ${(row.conflictClasses || []).join(', ') || '—'} | ${row.firstArchiveMonth || '—'} | ${row.lastArchiveMonth || '—'} |`).join('\n')
    : '| — | none | — | — | — |';
  const gaps = report.dataGaps.length
    ? report.dataGaps.slice(0, 80).map(row => `| ${row.symbol} | ${row.kind} | ${row.reason} |`).join('\n')
    : '| — | — | none |';
  return `# M4 PIT Universe Closure

Status: **${report.status}**

Development window: ${report.start} → ${report.end} (end exclusive). Snapshot: ${report.snapshotTimestamp || '—'}.

This report uses the union of actual Binance Data Vision USD-M archive evidence and the current exchangeInfo cross-check. Current exchangeInfo is never used as the sole historical universe source. Archive first/last observations are diagnostics only and cannot certify an in-window listing or delisting.

## Universe

- Global discovered symbols: ${report.globalDiscoveredSymbols?.length || report.discoveredSymbols.length}
- Development archive symbols: ${report.developmentArchiveSymbols?.length || 0}
- Development-relevant crypto perpetual symbols: ${report.developmentRelevantSymbols?.length || 0}
- Current symbols: ${report.currentSymbols.length}
- Historical archive-only symbols: ${report.historicalDelistedSymbols.length}
- Excluded TradFi perpetual symbols: ${report.excludedTradfiSymbols?.length || 0}
- Listed during Development: ${report.listedDuringDevelopment.length}
- Delisted during Development: ${report.delistedDuringDevelopment.length}
- PIT window resolved: ${report.markets.filter(row => row.pitWindowResolved).length}/${report.markets.length}
- Unresolved Development lifecycle: ${report.unresolved.length}
- Development-active episodes: ${report.developmentActiveEpisodes?.length || 0}
- Multi-episode/relisted symbols: ${report.multiEpisodeSymbols?.length || 0}
- Relist episode classification: ${report.relistEpisodeSymbols?.length || 0}
- True lifecycle conflicts: ${report.trueLifecycleConflicts?.length || 0}
- Ambiguous evidence matches: ${report.ambiguousEvidenceMatches?.length || 0}
- Hourly boundary straddles accepted: ${report.hourlyBoundaryStraddleSymbols?.length || 0}
- Archive interval alignments: ${report.archiveIntervalAlignmentSymbols?.length || 0}
- M4_PIT_WINDOW_COMPLETE: **${report.m4PitWindowComplete}**
- M4_GLOBAL_COMPLETE: **${report.m4GlobalComplete}**
- M4 window data contract ready: **${report.m4WindowDataContractReady}**
- Legacy manifest data contract diagnostic: **${report.manifestDataContractReady}**

## Monthly PIT universe

| Month | PIT eligible | Core | Expanded |
|---|---:|---:|---:|
${monthly || '| — | 0 | 0 | 0 |'}

## Monthly PIT liquidity eligibility

Fixed rule: completed point-in-time 30-day average quote volume ≥ 20,000,000 USDT. Missing liquidity history is fail-closed and is not inferred from future volume.

| Month | Liquidity-eligible | Core | Expanded | Unknown |
|---|---:|---:|---:|---:|
${liquidityMonthly || '| — | 0 | 0 | 0 | 0'}

## Lifecycle blockers

| Symbol | Reason | Conflict class | First archive month | Last archive month |
|---|---|---|---|---|
${unresolved}

## Data gaps

| Symbol | Artifact | Reason |
|---|---|---|
${gaps}

## Integrity and provenance

- Required artifacts: ${report.dataIntegrity.requiredArtifacts.join(', ')}
- Active markets with complete artifact metadata: ${report.dataIntegrity.completeActiveMarkets}/${report.dataIntegrity.activeMarkets}
- Data gaps: ${report.dataIntegrity.gaps}
- Hash failures: ${report.dataIntegrity.hashFailures}
- Liquidity metadata unknown: ${report.dataIntegrity.liquidityUnknown}
- Liquidity eligible observations: ${report.liquidityEligibleObservations ?? 0}
- Liquidity rejected for insufficient 30-day history: ${report.liquidityRejectedInsufficientHistory ?? 0}
- Liquidity rejected for gap: ${report.liquidityRejectedGap ?? 0}
- Liquidity rejected below threshold: ${report.liquidityRejectedBelowThreshold ?? 0}
- PIT liquidity eligible monthly min/mean/max: ${report.monthlyLiquidityRange?.min ?? 0} / ${report.monthlyLiquidityRange?.mean ?? 0} / ${report.monthlyLiquidityRange?.max ?? 0}
- PIT universe SHA-256: ${report.pitUniverseSha256}
- Universe evidence SHA-256: ${report.universeEvidenceSha256}
- Dataset manifest SHA-256: ${report.datasetManifestSha256 || '—'}

Formal Event Research status: **${report.m4PitWindowComplete ? 'eligible to run' : 'M4_BLOCKED; Event Research not run'}**.
`;
}

function markdownEvent(report) {
  const rows = Object.values(report.families).map(row => `| ${row.family} | ${row.status} | ${row.independent ?? 0} | ${row.executable ?? '—'} | ${row.profitFactor ?? '—'} | ${row.expectancyR ?? '—'} | ${row.eventControlExpectancyUpliftR ?? '—'} |`).join('\n');
  return `# Event / Regime Conditional Research

Status: **${report.finalDecision}**. No ML, grid search, threshold optimization, Holdout, or Production change was performed.

Event definitions are frozen at ${report.eventDefinitionVersion}. Outcome contract: canonical 72h, 20-minute decision latency, 1m executable fill, deterministic stop, 2R target, chronological 1m first touch, same-minute TP+SL=SL, funding/fees/modeled cost.

## Family results

| Family | Status | Independent | Executable | PF | Expectancy R | Event-control uplift R |
|---|---|---:|---:|---:|---:|---:|
${rows}

## Gate

- Total KEEP: ${report.totalKeep}
- Total STRONG_KEEP: ${report.totalStrongKeep}
- Event/month mean and median: ${report.eventFrequency.mean} / ${report.eventFrequency.median}
- Holdout: **NOT RUN**
- M4 status: **${report.m4Status}**
- Final decision: **${report.finalDecision}**
`;
}

function buildEventReport(pit, audits, {dataRoot = DEFAULT_DATA_ROOT, enhancedRoot = DEFAULT_ENHANCED_ROOT, appDir = APP_DIR} = {}) {
  let inputs = null;
  let inputError = null;
  if (pit.m4PitWindowComplete) {
    try {
      inputs = buildFormalEventInputs({pit, dataRoot, enhancedRoot, start: M4_DEVELOPMENT_START, end: M4_DEVELOPMENT_END});
    } catch (error) {
      inputError = error.message;
    }
  }
  const research = inputs
    ? runEventResearch({
      snapshots: inputs.snapshots,
      markets: pit.activeMarkets,
      start: M4_DEVELOPMENT_START,
      end: M4_DEVELOPMENT_END,
      outcomeForEvent: inputs.outcomeForEvent,
      controlObservations: inputs.controls,
    })
    : null;
  const families = research?.families || Object.fromEntries(EVENT_FAMILIES.map(family => [family, emptyFamilyReport(family)]));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    eventDefinitionVersion: EVENT_DEFINITION_VERSION,
    developmentWindow: {start: new Date(M4_DEVELOPMENT_START).toISOString(), end: new Date(M4_DEVELOPMENT_END).toISOString()},
    m4Status: pit.status,
    finalDecision: pit.m4PitWindowComplete && research ? eventResearchGate(families) : 'M4_BLOCKED',
    families,
    totalKeep: research?.totalKeep ?? 0,
    totalStrongKeep: research?.totalStrongKeep ?? 0,
    eventFrequency: research?.eventFrequency ?? {mean: 0, median: 0, monthly: {}},
    eventStudy: pit.m4PitWindowComplete && research
      ? {status: research?.status || 'DATA_UNAVAILABLE', horizons: ['4h', '12h', '24h', '72h'], rawEvents: research?.rawEvents?.length || 0, independentEvents: research?.independentEvents?.length || 0, purge: research?.purge || null}
      : {status: 'NOT_RUN_M4_BLOCKED', horizons: ['4h', '12h', '24h', '72h']},
    formalPipeline: {
      status: inputs ? 'REAL_FEATURE_SNAPSHOTS_READY' : pit.m4PitWindowComplete ? 'DATA_UNAVAILABLE' : 'NOT_RUN_M4_BLOCKED',
      featureOnly: true,
      featurePoints: inputs?.points?.length ?? null,
      snapshotAudit: inputs?.snapshotAudit || null,
      controlObservations: inputs?.controls?.length ?? null,
      outcomeProvider: Boolean(inputs?.outcomeForEvent),
      inputError,
      dataRoot: path.relative(appDir, dataRoot).replaceAll('\\', '/'),
      enhancedRoot: path.relative(appDir, enhancedRoot).replaceAll('\\', '/'),
    },
    controls: {method: 'deterministic exact month + side + regime + liquidity bucket matching; market controls use BTCUSDT; dispersion controls use the event symbol; nearest timestamp, stable event id tie-break; no reuse within family/fold; ±72h same-family contamination excluded', audited: Boolean(inputs), unmatched: research?.controls?.unmatched ?? null, noReuse: research?.controls?.noReuse ?? null},
    liquidity: {lookbackDays: M4_LIQUIDITY_LOOKBACK_DAYS, thresholdUsdt: M4_LIQUIDITY_THRESHOLD_USDT, completedOnly: true, pointInTime: true},
    walkForward: research?.walkForward
      ? {...research.walkForward, eventEndAware: true, randomSplit: false, validationFrozen: true}
      : {outerFolds: 6, purgeHours: 72, eventEndAware: true, randomSplit: false, validationFrozen: true},
    outcomeContract: CANONICAL_OUTCOME_CONTRACT,
    gates: EVENT_KEEP_GATE,
    holdout: {status: 'NOT RUN', authorized: false},
    repoNoOrderAudit: audits.noOrder,
    productionIsolation: audits.isolation,
    knownLimitations: [
      'M4 PIT window is blocked until all Development-active archive symbols have resolved entry/exit boundaries and required data coverage.',
      'Event family metrics are intentionally not computed while M4 is blocked; no point estimate is presented as evidence.',
      'Formal feature points, snapshots, controls and outcome provider are only admitted from the real feature/data roots after the M4 gate passes.',
      'No Holdout was run and no Production configuration, schema, scheduler, SMTP or signal behavior was changed.',
    ],
  };
}

export function buildReports({appDir = APP_DIR, dataRoot = DEFAULT_DATA_ROOT, enhancedRoot = DEFAULT_ENHANCED_ROOT, reportsDir = DEFAULT_REPORTS_DIR} = {}) {
  const pit = buildPitUniverseFromFiles({appDir, dataRoot, start: M4_DEVELOPMENT_START, end: M4_DEVELOPMENT_END});
  const audits = {noOrder: auditRepoNoOrder(appDir), isolation: auditProductionIsolation(appDir, 'research/profit-engine-r1-r3')};
  const pitReport = {
    reportVersion: 'm4-pit-universe-v1',
    generatedAt: new Date().toISOString(),
    ...pit,
    monthlyRange: pitMonthlyRange(pit.monthlyPitUniverse),
    monthlyLiquidityRange: pitLiquidityRange(pit.monthlyLiquidityEligible),
    discoveredHistoricalSymbols: pit.historicalDelistedSymbols?.length || 0,
    source: 'Binance official Data Vision USD-M archive index plus timestamped lifecycle evidence and exchangeInfo cross-check',
    survivorshipAudit: {currentListAlone: false, archiveUnionUsed: true, historicalDelistingsIncluded: (pit.historicalDelistedSymbols?.length || 0) > 0},
  };
  const eventReport = buildEventReport(pitReport, audits, {appDir, dataRoot, enhancedRoot});
  const frozenConfig = {
    schemaVersion: 1,
    eventDefinitionVersion: EVENT_DEFINITION_VERSION,
    families: EVENT_DEFINITIONS,
    refractoryHours: EVENT_REFRACTORY_HOURS,
    outcomeContract: CANONICAL_OUTCOME_CONTRACT,
    controls: eventReport.controls,
    liquidity: {lookbackDays: M4_LIQUIDITY_LOOKBACK_DAYS, thresholdUsdt: M4_LIQUIDITY_THRESHOLD_USDT, completedOnly: true, pointInTime: true},
    walkForward: eventReport.walkForward,
    gates: EVENT_KEEP_GATE,
    developmentWindow: eventReport.developmentWindow,
    holdout: eventReport.holdout,
  };
  pitReport.provenance = {
    m4DatasetSha256: sha256(JSON.stringify({markets: pitReport.markets, dataIntegrity: pitReport.dataIntegrity})),
    pitUniverseSha256: pitReport.pitUniverseSha256 || null,
    eventEngineCodeSha256: sha256(fs.readFileSync(path.join(appDir, 'src', 'm4', 'event-engine.mjs'))),
    eventFrozenConfigSha256: sha256(JSON.stringify(frozenConfig)),
    datasetManifestSha256: pitReport.datasetManifestSha256 || null,
    universeEvidenceSha256: pitReport.universeEvidenceSha256 || null,
  };
  eventReport.provenance = {
    m4DatasetSha256: pitReport.provenance.m4DatasetSha256,
    pitUniverseSha256: pitReport.provenance.pitUniverseSha256,
    eventEngineCodeSha256: pitReport.provenance.eventEngineCodeSha256,
    eventFrozenConfigSha256: pitReport.provenance.eventFrozenConfigSha256,
    datasetManifestSha256: pitReport.provenance.datasetManifestSha256,
    universeEvidenceSha256: pitReport.provenance.universeEvidenceSha256,
  };
  writeJson(path.join(reportsDir, 'm4-pit-universe.json'), pitReport);
  atomicWrite(path.join(reportsDir, 'm4-pit-universe.md'), markdownPit(pitReport));
  writeJson(path.join(reportsDir, 'event-regime-development.json'), eventReport);
  atomicWrite(path.join(reportsDir, 'event-regime-development.md'), markdownEvent(eventReport));
  writeJson(path.join(reportsDir, 'event-regime-frozen-config.json'), frozenConfig);
  return {pit: pitReport, event: eventReport, frozenConfig};
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const result = buildReports(parseArgs());
    console.log(JSON.stringify({
      m4Status: result.pit.status,
      m4PitWindowComplete: result.pit.m4PitWindowComplete,
      m4GlobalComplete: result.pit.m4GlobalComplete,
      discoveredSymbols: result.pit.discoveredSymbols.length,
      unresolved: result.pit.unresolved.length,
      eventDecision: result.event.finalDecision,
      reports: ['reports/m4-pit-universe.json', 'reports/m4-pit-universe.md', 'reports/event-regime-development.json', 'reports/event-regime-development.md', 'reports/event-regime-frozen-config.json'],
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
