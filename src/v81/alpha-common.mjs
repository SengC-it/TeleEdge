import {stopForPoint} from './features.mjs';

export function candidateFromPoint(point, market, alpha, side, {targetR = alpha.targetR} = {}) {
  const risk = stopForPoint(point, side);
  if (!risk || !(point.signalTime > 0) || !(point.close > 0)) return null;
  const direction = side === 'long' ? 1 : -1;
  return {
    id: `V81|${alpha.id}|${market.symbol}|${side}|${point.signalTime}`,
    modelVersion: 'V8.1-research-1',
    alpha: alpha.id,
    alphaFamily: alpha.family,
    family: `v81_${alpha.family}`,
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
    targetR,
    target: point.close + direction * targetR * Math.abs(point.close - risk.stop),
    eventScore: Math.abs(Number(point.return3) || 0) * 100 + Math.abs(Number(point.fundingZ) || 0),
    dayVolume: Number(point.q) || 0,
    regime: point.regime,
    btcRouter: point.btcRegime,
    features: {
      close: point.close,
      ema20: point.ema20,
      ema50: point.ema50,
      previousEma50: point.previousEma50,
      regime: point.regime,
      btcRegime: point.btcRegime,
      fundingRate: point.fundingRate,
      fundingZ: point.fundingZ,
      previousFundingZ: point.previousFundingZ,
      volumeRatio: point.volumeRatio,
      rangeRatio: point.rangeRatio,
      adx: point.adx,
      atr: point.atr,
      rsi: point.rsi,
      return3: point.return3,
      return12: point.return12,
      relativeReturn12: point.relativeReturn12,
      previousRelativeReturn12: point.previousRelativeReturn12,
      btcReturn12: point.btcReturn12,
      btcStrength: point.btcStrength,
      distanceEmaAtr: point.distanceEmaAtr,
      thresholdDistance: point.rangeRatio != null ? point.rangeRatio - 1 : null,
    },
  };
}
