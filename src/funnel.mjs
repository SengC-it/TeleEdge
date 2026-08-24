export const FUNNEL_STAGES = Object.freeze([
  'universe', 'history_valid', 'liquidity_valid', 'regime_valid',
  'trend_valid', 'funding_valid', 'trigger_valid', 'stop_valid',
  'edge_valid', 'ranked', 'accepted',
]);

function emptyStages() {
  return Object.fromEntries(FUNNEL_STAGES.map(stage => [stage, {reached: 0, passed: 0, rejected: 0}]));
}

export function createFunnel() {
  const funnel = {stages: emptyStages(), byDimension: {}, rejectionReasons: {}};
  funnel.record = event => recordFunnel(funnel, event);
  return funnel;
}

function dimensionKey(event) {
  return [event.family || 'all', event.side || 'all', event.regime || 'unknown',
    event.symbol || 'all', event.tier || 'all'].join('|');
}

export function recordFunnel(funnel, event) {
  if (!funnel || !event?.stage || !funnel.stages[event.stage]) return;
  const count = Math.max(1, Number(event.count || 1));
  const passed = event.passed !== false;
  const stage = funnel.stages[event.stage];
  stage.reached += count;
  if (passed) stage.passed += count;
  else stage.rejected += count;
  const key = dimensionKey(event);
  const dimension = funnel.byDimension[key] ||= {family: event.family || 'all', side: event.side || 'all', regime: event.regime || 'unknown', symbol: event.symbol || 'all', tier: event.tier || 'all', stages: emptyStages(), rejectionReasons: {}};
  const dimensionStage = dimension.stages[event.stage];
  dimensionStage.reached += count;
  if (passed) dimensionStage.passed += count;
  else dimensionStage.rejected += count;
  if (!passed) {
    const reason = event.rejectionReason || 'unspecified';
    funnel.rejectionReasons[reason] = (funnel.rejectionReasons[reason] || 0) + count;
    dimension.rejectionReasons[reason] = (dimension.rejectionReasons[reason] || 0) + count;
  }
}

export function summarizeFunnel(funnel) {
  return {
    stages: funnel?.stages || emptyStages(),
    byDimension: funnel?.byDimension || {},
    rejectionReasons: funnel?.rejectionReasons || {},
  };
}
