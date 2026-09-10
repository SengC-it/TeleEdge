import {buildForwardSignal, recordAdvisoryWithForwardLogging} from './contract.mjs';

/**
 * Best-effort bridge for the future ACTIVE run. It deliberately has no effect
 * when no run is active, and a ledger failure never suppresses the advisory.
 * The production scan/email path can inject this bridge after the additive
 * migration and an explicit run activation; Phase 1 does not activate it.
 */
export async function recordAcceptedAdvisory({run, advisory, existingSignals = [], persist}) {
  if (run?.status !== 'ACTIVE') return {recorded: false, reason: 'no-active-forward-run', advisorySuppressed: false};
  const result = await recordAdvisoryWithForwardLogging(advisory, async input => {
    const signal = buildForwardSignal(input, {run, existingSignals});
    if (!persist) return signal;
    return persist(signal);
  });
  return {recorded: Boolean(result.forward), advisorySuppressed: result.advisorySuppressed, signal: result.forward, error: result.forwardLoggingError};
}
