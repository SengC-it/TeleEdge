export const CANONICAL_OUTCOME_CONTRACT = Object.freeze({
  decisionLatencyMinutes: 20, executionInterval: '1m', targetR: 2,
  verticalBarrierHours: 72, sameMinuteTpSl: 'SL', noInterpolation: true,
  researchOnly: true,
});

function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }

export function canonicalLabelFromOutcome(outcome, {signalTime, developmentEnd = Infinity} = {}) {
  const start = finite(signalTime ?? outcome?.signalTime);
  const decisionTime = finite(outcome?.decisionTime) ?? (start == null ? null : start + 20 * 60_000);
  const barrierTime = decisionTime == null ? null : decisionTime + CANONICAL_OUTCOME_CONTRACT.verticalBarrierHours * 3_600_000;
  const exitTime = finite(outcome?.exitTime);
  const completeBarrier = barrierTime == null || barrierTime <= Number(developmentEnd);
  const executable = outcome?.executable === true && finite(outcome?.netR) != null;
  const complete = executable && completeBarrier;
  return {
    ...outcome,
    signalTime: start, decisionTime, canonicalBarrierTime: barrierTime,
    canonicalOutcomeType: outcome?.exitReason === 'tp' ? 'TP' : outcome?.exitReason === 'sl' ? 'SL' : 'VERTICAL_MTM',
    labelUsable: complete, labelPositive: complete ? Number(outcome.netR) > 0 : null,
    positiveOpportunity: complete ? Number(outcome.netR) >= 0.5 : null,
    timeToExitMinutes: exitTime != null && decisionTime != null ? (exitTime - decisionTime) / 60_000 : null,
  };
}

export function joinCanonicalLabels(proposals, outcomes, {developmentEnd = Infinity} = {}) {
  const byId = new Map((outcomes || []).map(row => [String(row.observationId ?? row.id), row]));
  return (proposals || []).map(proposal => {
    const outcome = byId.get(String(proposal.primaryObservationId || proposal.id));
    const label = outcome ? canonicalLabelFromOutcome(outcome, {signalTime: proposal.t ?? proposal.signalTime, developmentEnd}) : {labelUsable: false, signalTime: proposal.t ?? proposal.signalTime, decisionTime: Number(proposal.t ?? proposal.signalTime) + 20 * 60_000};
    return {
      ...proposal, outcome: label, netR: label.labelUsable ? finite(label.netR) : null,
      netPnlUsdt: label.labelUsable ? finite(label.netPnlUsdt) : null,
      grossPnlUsdt: label.labelUsable ? finite(label.grossPnlUsdt) : null,
      fundingPnlUsdt: label.labelUsable ? finite(label.fundingPnlUsdt) : null,
      modeledCostUsdt: label.labelUsable ? finite(label.modeledCostUsdt) : null,
      fillTime: label.fillTime ?? null, fillPrice: label.fillPrice ?? null,
      stop: label.stop ?? proposal.sl ?? null, target: label.target ?? null,
      exitTime: label.exitTime ?? null, executable: label.labelUsable,
    };
  });
}

export function opportunityTarget(rows) {
  const executable = (rows || []).filter(row => row.outcome?.labelUsable === true);
  return executable.length ? executable.filter(row => row.outcome.positiveOpportunity === true).length / executable.length : null;
}
