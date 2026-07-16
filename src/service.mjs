import {appendNdjson, EVENTS_FILE, loadState, saveState} from './storage.mjs';
import {CORE_MARKETS, DAY, H1, modelConfig, runtimeConfig} from './config.mjs';
import {aggregate} from './indicators.mjs';
import {loadExchangeInfo, loadFundingHistory, loadPriceHistory} from './market-data.mjs';
import {buildBreadth, buildBtcEnvironment, generateLatestCandidates} from './strategy.mjs';
import {acceptCandidates} from './portfolio.mjs';
import {fetchMinuteRange, getFundingRates, mapLimit} from './binance.mjs';
import {notify} from './notifier.mjs';

function eligibleMarkets(exchangeInfo, endTime) {
  return (exchangeInfo.symbols || []).filter(market => market.quoteAsset === 'USDT'
    && market.contractType === 'PERPETUAL'
    && market.status === 'TRADING'
    && +market.onboardDate <= endTime - 34 * DAY);
}

async function buildEnvironment(markets, endTime) {
  const coreDaily = new Map();
  const core = markets.filter(market => CORE_MARKETS.has(market.symbol));
  const results = await mapLimit(core, Math.min(3, runtimeConfig.requestConcurrency), async market => {
    try {
      const h1 = await loadPriceHistory(market.symbol, endTime);
      if (h1.at(-1)?.t + H1 < endTime) throw new Error('price history is stale');
      return {market, daily: aggregate(h1, DAY, endTime)};
    } catch (error) {
      return {market, error: String(error)};
    }
  });
  for (const result of results) if (result.daily?.length) coreDaily.set(result.market.symbol, result.daily);
  const btcDaily = coreDaily.get('BTCUSDT');
  if (!btcDaily?.length) throw new Error('BTCUSDT daily history is unavailable; regime router cannot run');
  return {
    breadthByTime: buildBreadth(coreDaily),
    btcEnvironment: buildBtcEnvironment(btcDaily),
    errors: results.filter(result => result.error),
  };
}

export async function runScan(now = Date.now()) {
  const state = loadState(now);
  state.service.status = 'scanning';
  state.service.lastScanStartedAt = now;
  state.service.lastError = null;
  saveState(state, now);
  try {
    const endTime = Math.floor(now / H1) * H1;
    const exchangeInfo = await loadExchangeInfo();
    const markets = eligibleMarkets(exchangeInfo, endTime);
    const marketById = new Map(markets.map(market => [market.symbol, market]));
    const environment = await buildEnvironment(markets, endTime);
    const results = await mapLimit(markets, runtimeConfig.requestConcurrency, async market => {
      try {
        const [h1, funding] = await Promise.all([
          loadPriceHistory(market.symbol, endTime),
          loadFundingHistory(market.symbol, endTime),
        ]);
        if (h1.at(-1)?.t + H1 < endTime) throw new Error('price history is stale');
        return {market, candidates: generateLatestCandidates({
          market,
          h1,
          funding,
          breadthByTime: environment.breadthByTime,
          btcEnvironment: environment.btcEnvironment,
          endTime,
        })};
      } catch (error) {
        return {market, error: String(error)};
      }
    });
    const candidates = results.flatMap(result => result.candidates || []);
    const fresh = candidates.filter(candidate => candidate.t <= now && candidate.t >= now - runtimeConfig.signalMaxAgeMs);
    const decision = acceptCandidates(fresh, state, marketById);
    const errors = [...environment.errors, ...results.filter(result => result.error)];
    const summary = {
      scanTime: now,
      marketDataEnd: endTime,
      universe: markets.length,
      evaluated: results.filter(result => !result.error).length,
      marketErrors: errors.length,
      rawCandidates: candidates.length,
      freshCandidates: fresh.length,
      unseenCandidates: decision.unseenCount,
      rankedCandidates: decision.rankedCount,
      accepted: decision.accepted.length,
      rejected: decision.rejected.length,
      activePositions: state.positions.length,
      exchangeInfoFallback: exchangeInfo._fallbackError || null,
    };
    state.service.lastScanCompletedAt = Date.now();
    state.service.lastScanSummary = summary;
    state.service.status = errors.length ? 'degraded' : 'ready';
    if (errors.length) state.service.lastError = `${errors.length} market-data errors; first: ${errors[0].market.symbol}: ${errors[0].error}`;
    saveState(state);
    appendNdjson(EVENTS_FILE, {eventId: `scan-${now}`, type: 'scan', at: Date.now(), payload: summary});
    for (const position of decision.accepted) {
      try {
        await notify('entry', position);
      } catch (error) {
        state.service.status = 'degraded';
        state.service.lastError = `Entry notification failed: ${error}`;
        saveState(state);
      }
    }
    return summary;
  } catch (error) {
    state.service.status = 'degraded';
    state.service.lastError = String(error);
    state.service.lastScanCompletedAt = Date.now();
    saveState(state);
    throw error;
  }
}

export function firstTouch(position, bars) {
  for (const bar of bars) {
    const stopHit = position.side === 'long' ? bar.l <= position.stop : bar.h >= position.stop;
    const targetHit = position.side === 'long' ? bar.h >= position.target : bar.l <= position.target;
    // Deliberately conservative and consistent with the research fallback.
    if (stopHit) return {reason: 'sl', price: position.stop, time: bar.t + 60_000, ambiguous: targetHit};
    if (targetHit) return {reason: 'tp', price: position.target, time: bar.t + 60_000, ambiguous: false};
  }
  return null;
}

async function fundingSince(position, endTime) {
  const events = [];
  let cursor = (position.lastFundingTime ?? position.signalTime) + 1;
  while (cursor < endTime) {
    const batch = await getFundingRates(position.marketId, {startTime: cursor, endTime, limit: 1000});
    if (!Array.isArray(batch) || !batch.length) break;
    for (const row of batch) events.push({t: +row.fundingTime, rate: +row.fundingRate, markPrice: +row.markPrice || position.entry});
    const next = +batch.at(-1).fundingTime + 1;
    if (next <= cursor) break;
    cursor = next;
    if (batch.length < 1000) break;
  }
  return events;
}

function applyFunding(position, events, until) {
  const included = events.filter(event => event.t < until);
  for (const event of included) {
    const cashflow = event.markPrice * position.quantity * event.rate;
    position.fundingPnlUsdt += position.side === 'long' ? -cashflow : cashflow;
    position.lastFundingTime = Math.max(position.lastFundingTime || 0, event.t);
  }
}

function closePosition(position, touch) {
  const direction = position.side === 'long' ? 1 : -1;
  const grossPnlUsdt = direction * (touch.price - position.entry) * position.quantity;
  const modeledCostUsdt = modelConfig.stressRoundTripCost * position.entry * position.quantity;
  const netPnlUsdt = grossPnlUsdt + position.fundingPnlUsdt - modeledCostUsdt;
  return {
    ...position,
    status: 'closed',
    exitReason: touch.reason,
    exitPrice: touch.price,
    exitTime: touch.time,
    ambiguousSameMinute: touch.ambiguous,
    grossPnlUsdt,
    modeledCostUsdt,
    netPnlUsdt,
    netR: netPnlUsdt / position.riskUsdt,
  };
}

export async function runMonitor(now = Date.now()) {
  const state = loadState(now);
  const active = state.positions.filter(position => position.status === 'open');
  if (!active.length) {
    state.service.lastMonitorAt = now;
    if (state.service.status === 'starting') state.service.status = 'ready';
    saveState(state, now);
    return {checked: 0, closed: 0, errors: 0};
  }
  const results = await mapLimit(active, Math.min(3, active.length), async position => {
    try {
      const [bars, funding] = await Promise.all([
        fetchMinuteRange(position.marketId, position.lastCheckedAt, now),
        fundingSince(position, now),
      ]);
      const touch = firstTouch(position, bars);
      applyFunding(position, funding, touch?.time ?? now + 1);
      if (!touch) {
        position.lastCheckedAt = Math.floor(now / 60_000) * 60_000;
        return {position};
      }
      return {position: closePosition(position, touch), closed: true};
    } catch (error) {
      return {position, error: String(error)};
    }
  });
  const closed = results.filter(result => result.closed).map(result => result.position);
  const errors = results.filter(result => result.error);
  state.positions = results.filter(result => !result.closed).map(result => result.position);
  for (const position of closed) {
    state.closedPositions.push(position);
    state.cooldowns[position.marketId] = position.exitTime;
    state.realizedPnlUsdt += position.netPnlUsdt;
    state.equityUsdt += position.netPnlUsdt;
  }
  state.service.lastMonitorAt = now;
  if (errors.length) {
    state.service.status = 'degraded';
    state.service.lastError = `${errors.length} position monitor errors; first: ${errors[0].position.marketId}: ${errors[0].error}`;
  }
  saveState(state, now);
  for (const position of closed) {
    try {
      await notify('exit', position);
    } catch (error) {
      state.service.status = 'degraded';
      state.service.lastError = `Exit notification failed: ${error}`;
      saveState(state);
    }
  }
  return {checked: active.length, closed: closed.length, errors: errors.length};
}
