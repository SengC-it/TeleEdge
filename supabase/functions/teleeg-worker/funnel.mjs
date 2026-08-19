export const FUNNEL_STAGES = [
  'universe', 'history_valid', 'liquidity_valid', 'regime_valid',
  'trend_valid', 'funding_valid', 'trigger_valid', 'stop_valid',
  'edge_valid', 'ranked', 'accepted',
];

function stages() {
  return Object.fromEntries(FUNNEL_STAGES.map(stage => [stage, {reached: 0, passed: 0, rejected: 0}]));
}

export function createFunnel() {
  const funnel = {stages: stages(), byDimension: {}, rejectionReasons: {}};
  funnel.record = event => recordFunnel(funnel, event);
  return funnel;
}

function recordFunnel(funnel, event) {
  if (!event?.stage || !funnel.stages[event.stage]) return;
  const count = Math.max(1, Number(event.count || 1));
  const passed = event.passed !== false;
  const item = funnel.stages[event.stage];
  item.reached += count;
  item[passed ? 'passed' : 'rejected'] += count;
  const key = [event.family || 'all', event.side || 'all', event.regime || 'unknown', event.symbol || 'all', event.tier || 'all'].join('|');
  const dimension = funnel.byDimension[key] ||= {
    family: event.family || 'all', side: event.side || 'all', regime: event.regime || 'unknown',
    symbol: event.symbol || 'all', tier: event.tier || 'all', stages: stages(), rejectionReasons: {},
  };
  const dimensionStage = dimension.stages[event.stage];
  dimensionStage.reached += count;
  dimensionStage[passed ? 'passed' : 'rejected'] += count;
  if (!passed) {
    const reason = event.rejectionReason || 'unspecified';
    funnel.rejectionReasons[reason] = (funnel.rejectionReasons[reason] || 0) + count;
    dimension.rejectionReasons[reason] = (dimension.rejectionReasons[reason] || 0) + count;
  }
}

export function summarizeFunnel(funnel) {
  return {stages: funnel?.stages || stages(), byDimension: funnel?.byDimension || {}, rejectionReasons: funnel?.rejectionReasons || {}};
}
