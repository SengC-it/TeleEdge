import {roundToTick} from './market-data.mjs';

const STOP_BOUNDS = Object.freeze({
  dailyBreakout: Object.freeze({min: 0.02, max: 0.12}),
  fundingCrowdingReversal: Object.freeze({min: 0.02, max: 0.08}),
  volumeShockReversal: Object.freeze({min: 0.02, max: 0.10}),
  v8BullTrendBreakout: Object.freeze({min: 0.02, max: 0.12}),
  v8FundingCrowdingReversal: Object.freeze({min: 0.02, max: 0.08}),
  v8VolumeShockReversal: Object.freeze({min: 0.02, max: 0.10}),
  v8BearCoreTrendShort: Object.freeze({min: 0.02, max: 0.12}),
});

export function stopBoundsForFamily(family) {
  return STOP_BOUNDS[family] || {min: 0.02, max: 0.12};
}

export function recalculateFilledRisk({side, family, fillPrice, stop, targetR, tickSize}) {
  const roundedFillPrice = roundToTick(Number(fillPrice), tickSize);
  const roundedStop = roundToTick(Number(stop), tickSize);
  const riskPerUnit = Math.abs(roundedFillPrice - roundedStop);
  const direction = side === 'long' ? 1 : side === 'short' ? -1 : 0;
  const numericTargetR = Number(targetR);
  if (!(roundedFillPrice > 0) || !(roundedStop > 0) || !direction || !(riskPerUnit > 0) || !(numericTargetR > 0)) {
    return {accepted: false, reason: 'invalid-fill-or-stop', fillPrice: roundedFillPrice, stop: roundedStop};
  }
  const validDirection = side === 'long' ? roundedStop < roundedFillPrice : roundedStop > roundedFillPrice;
  if (!validDirection) return {accepted: false, reason: 'invalid-fill-or-stop', fillPrice: roundedFillPrice, stop: roundedStop};
  const stopPct = riskPerUnit / roundedFillPrice;
  const bounds = stopBoundsForFamily(family);
  if (stopPct < bounds.min || stopPct > bounds.max) {
    return {
      accepted: false,
      reason: 'fill-stop-risk-out-of-bounds',
      fillPrice: roundedFillPrice,
      stop: roundedStop,
      stopPct,
      minStopPct: bounds.min,
      maxStopPct: bounds.max,
    };
  }
  const target = roundToTick(roundedFillPrice + direction * numericTargetR * riskPerUnit, tickSize);
  const effectiveTargetR = Math.abs(target - roundedFillPrice) / riskPerUnit;
  const targetDirectionValid = side === 'long' ? target > roundedFillPrice : target < roundedFillPrice;
  if (!targetDirectionValid || effectiveTargetR < numericTargetR * 0.95) {
    return {
      accepted: false,
      reason: 'fill-target-risk-too-low',
      fillPrice: roundedFillPrice,
      stop: roundedStop,
      target,
      stopPct,
      effectiveTargetR,
    };
  }
  return {
    accepted: true,
    fillPrice: roundedFillPrice,
    stop: roundedStop,
    target,
    stopPct,
    effectiveTargetR,
    targetR: numericTargetR,
  };
}
