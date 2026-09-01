import {stopForPoint} from '../v81/features.mjs';
import {V9_ALPHA_IDS, V9_ALPHA_REGISTRY} from './registry.mjs';
import {scoreV9Candidate} from './scoring.mjs';

export const V9_TARGET_R = 2;

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function sideMatches(point, side) {
  const long = side === 'long';
  return {
    flow: long ? Number(point.takerImbalance) >= 0.12 : Number(point.takerImbalance) <= -0.12,
    impulse: long ? Number(point.aggressiveVolumeZ) >= 1 : Number(point.aggressiveVolumeZ) <= -1,
    trend: point.regime === (long ? 'bull' : 'bear') || (long ? Number(point.return3) > 0 : Number(point.return3) < 0),
    reversal: long ? Boolean(point.failedBreakoutDown) : Boolean(point.failedBreakoutUp),
    priceUnwind: long ? Number(point.return3) > 0 : Number(point.return3) < 0,
  };
}

function candidateFromPoint(point, market, alphaId, side, variant) {
  const risk = stopForPoint(point, side);
  if (!risk || !(point.signalTime > 0) || !(point.close > 0)) return null;
  const direction = side === 'long' ? 1 : -1;
  const candidate = {
    id: `V9|${alphaId}|${variant}|${market.symbol}|${side}|${point.signalTime}`,
    modelVersion: 'V9-research-1',
    alpha: alphaId,
    alphaFamily: V9_ALPHA_REGISTRY[alphaId].family,
    family: `v9_${V9_ALPHA_REGISTRY[alphaId].family}`,
    alphaVariant: variant,
    marketId: market.symbol,
    symbol: market.baseAsset || market.symbol.replace(/USDT$/, ''),
    core: Boolean(market.core),
    side,
    t: point.signalTime,
    signalIntervalHours: 4,
    signalPrice: point.close,
    entry: point.close,
    sl: risk.stop,
    stopPct: risk.stopPct,
    targetR: V9_TARGET_R,
    target: point.close + direction * V9_TARGET_R * Math.abs(point.close - risk.stop),
    eventScore: Math.abs(Number(point.return3) || 0) * 100 + Math.abs(Number(point.takerImbalance) || 0) * 10,
    dayVolume: Number(point.q) || 0,
    regime: point.regime,
    btcRouter: point.btcRegime,
    features: point,
  };
  return scoreV9Candidate(candidate);
}

function detectFlowMomentum(point, alphaId, variant) {
  for (const side of ['long', 'short']) {
    const match = sideMatches(point, side);
    const variantPass = variant === 'trend-confirmed' ? match.trend : Number(point.volumeRatio) >= 1.2;
    if (match.flow && match.impulse && variantPass) return [{side}];
  }
  return [];
}

function detectFlowReversal(point, alphaId, variant) {
  for (const side of ['long', 'short']) {
    const match = sideMatches(point, side);
    const rejected = match.reversal || (side === 'long' ? Number(point.return3) < 0 : Number(point.return3) > 0);
    const variantPass = variant === 'exhaustion-rejection' ? rejected : Math.abs(Number(point.aggressiveVolumeZ) || 0) >= 1;
    if (match.flow && variantPass) return [{side}];
  }
  return [];
}

function detectOiTrend(point, alphaId, variant) {
  if (!point.metricsAvailable || !point.oiHistoryAvailable || finite(point.openInterest) == null || finite(point.oiChange) == null || finite(point.oiZ) == null) return [];
  const rows = [];
  for (const side of ['long', 'short']) {
    const long = side === 'long';
    const alignment = long ? point.oiState === 'new-long' : point.oiState === 'new-short';
    const divergence = long ? point.oiState === 'short-covering' : point.oiState === 'long-liquidation';
    if ((variant === 'price-oi-alignment' ? alignment : divergence) && Math.abs(Number(point.oiZ)) >= 0.5) rows.push({side});
  }
  return rows;
}

function detectCrowdedUnwind(point, alphaId, variant) {
  if (!point.metricsAvailable || !point.ratioHistoryAvailable || !point.fundingHistoryAvailable || !point.premiumHistoryAvailable || !point.oiHistoryAvailable) return [];
  const funding = Number(point.fundingZ);
  const premium = Number(point.premiumZ);
  const unwind = Number(point.return3);
  const oiContraction = Number(point.oiChange) < 0;
  const ratios = [point.globalLongShortRatio, point.topTraderAccountRatio, point.topTraderPositionRatio, point.takerLongShortRatio].map(Number);
  if (ratios.some(value => !Number.isFinite(value))) return [];
  const crowdedLong = funding >= 1.5 && premium >= 1 && oiContraction && unwind < 0 && ratios.every(value => value > 1);
  const crowdedShort = funding <= -1.5 && premium <= -1 && oiContraction && unwind > 0 && ratios.every(value => value < 1);
  if (variant === 'funding-premium-unwind') return crowdedLong ? [{side: 'short'}] : crowdedShort ? [{side: 'long'}] : [];
  const stateMatches = point.oiState === 'long-liquidation' || point.oiState === 'short-covering';
  if (!stateMatches) return [];
  return crowdedLong ? [{side: 'short'}] : crowdedShort ? [{side: 'long'}] : [];
}

function detectPremiumDislocation(point, alphaId, variant) {
  if (!point.premiumHistoryAvailable || !point.markIndexHistoryAvailable || finite(point.premiumZ) == null || finite(point.markIndexSpread) == null) return [];
  const rows = [];
  if (variant === 'mean-reversion') {
    if (Number(point.premiumZ) <= -1.5 && Number(point.return3) <= 0) rows.push({side: 'long'});
    if (Number(point.premiumZ) >= 1.5 && Number(point.return3) >= 0) rows.push({side: 'short'});
  } else {
    if (Number(point.premiumZ) >= 1.5 && Number(point.return3) > 0) rows.push({side: 'long'});
    if (Number(point.premiumZ) <= -1.5 && Number(point.return3) < 0) rows.push({side: 'short'});
  }
  return rows;
}

function detectCrossSectional(point, alphaId, variant) {
  const returnRank = finite(point.crossSectionalReturnRank);
  const flowRank = finite(point.crossSectionalFlowRank);
  if (returnRank == null || flowRank == null) return [];
  const rows = [];
  if (returnRank >= 0.8 && flowRank >= 0.7 && (variant === 'return-flow-leaders' || point.btcRegime !== 'bear')) rows.push({side: 'long'});
  if (returnRank <= 0.2 && flowRank <= 0.3 && (variant === 'return-flow-leaders' || point.btcRegime !== 'bull')) rows.push({side: 'short'});
  return rows;
}

const DETECTORS = Object.freeze({
  FLOW_MOMENTUM: detectFlowMomentum,
  FLOW_REVERSAL: detectFlowReversal,
  OI_TREND_CONFIRMATION: detectOiTrend,
  CROWDED_UNWIND: detectCrowdedUnwind,
  PREMIUM_DISLOCATION: detectPremiumDislocation,
  CROSS_SECTIONAL_FLOW_STRENGTH: detectCrossSectional,
});

export function detectV9Alpha(point, market, alphaId, variant) {
  const alpha = V9_ALPHA_REGISTRY[alphaId];
  if (!alpha || !alpha.variants.includes(variant)) return [];
  return (DETECTORS[alphaId]?.(point, alphaId, variant) || [])
    .map(({side}) => candidateFromPoint(point, market, alphaId, side, variant)).filter(Boolean);
}

export function generateV9Candidates(point, market) {
  return V9_ALPHA_IDS.flatMap(alphaId => V9_ALPHA_REGISTRY[alphaId].variants.flatMap(variant => detectV9Alpha(point, market, alphaId, variant)));
}

export {DETECTORS};
