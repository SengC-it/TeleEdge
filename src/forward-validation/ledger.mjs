import {activateRun, assertImmutableSignalUpdate, buildForwardSignal, MANUAL_DECISIONS, recordAdvisoryWithForwardLogging} from './contract.mjs';
import {calculateForwardMetrics, dailyIntegritySnapshot} from './metrics.mjs';

export class InMemoryForwardLedger {
  constructor(run) {
    this.run = run;
    this.signals = [];
    this.outcomes = [];
    this.manualDecisions = [];
    this.audit = [];
  }

  activate(startedAt) {
    this.run = activateRun(this.run, {startedAt});
    this.audit.push({entityType: 'run', entityId: this.run.runId, action: 'activate', after: this.run});
    return this.run;
  }

  recordSignal(input) {
    const signal = buildForwardSignal(input, {run: this.run, existingSignals: this.signals});
    const existing = this.signals.find(row => row.id === signal.id || row.dedupeKey === signal.dedupeKey);
    if (existing) return {signal: existing, duplicate: true, independent: false};
    this.signals.push(signal);
    this.audit.push({entityType: 'signal', entityId: signal.id, action: 'insert', after: signal});
    return {signal, duplicate: false, independent: signal.independent};
  }

  updateSignal(id, next) {
    const index = this.signals.findIndex(row => row.id === id);
    if (index < 0) throw new Error('signal not found');
    assertImmutableSignalUpdate(this.signals[index], next);
    this.signals[index] = {...this.signals[index], ...next};
    this.audit.push({entityType: 'signal', entityId: id, action: 'update', after: this.signals[index]});
    return this.signals[index];
  }

  recordOutcome(outcome) {
    if (!this.signals.some(signal => signal.id === outcome.signalId)) throw new Error('outcome requires a known signal');
    if (this.outcomes.some(row => row.signalId === outcome.signalId)) throw new Error('outcome already exists');
    const normalized = {status: outcome.closedAt ? 'closed' : 'open', ...outcome};
    this.outcomes.push(normalized);
    this.audit.push({entityType: 'outcome', entityId: outcome.signalId, action: 'insert', after: normalized});
    return normalized;
  }

  recordManualDecision({signalId, decision, updatedAt = Date.now(), ...fields}) {
    if (!MANUAL_DECISIONS.includes(decision)) throw new Error('invalid manual decision');
    if (!this.signals.some(signal => signal.id === signalId)) throw new Error('manual decision requires a known signal');
    const row = {decisionId: `manual-${signalId}`, signalId, decision, updatedAt: new Date(updatedAt).toISOString(), ...fields};
    this.manualDecisions.push(row);
    this.audit.push({entityType: 'manual_decision', entityId: row.decisionId, action: 'insert', after: row});
    return row;
  }

  updateManualDecision(decisionId, patch, updatedAt = Date.now()) {
    const index = this.manualDecisions.findIndex(row => row.decisionId === decisionId);
    if (index < 0) throw new Error('manual decision not found');
    const before = this.manualDecisions[index];
    const after = {...before, ...patch, updatedAt: new Date(updatedAt).toISOString()};
    this.manualDecisions[index] = after;
    this.audit.push({entityType: 'manual_decision', entityId: decisionId, action: 'update', before, after});
    return after;
  }

  metrics() {
    return calculateForwardMetrics(this.signals, this.outcomes);
  }

  integritySnapshot(date, extras = {}) {
    return dailyIntegritySnapshot({date, run: this.run, signals: this.signals, outcomes: this.outcomes, ...extras});
  }

  exportEvidence() {
    return {
      runManifest: this.run,
      signals: this.signals.map(row => ({...row})),
      outcomes: this.outcomes.map(row => ({...row})),
      metrics: this.metrics(),
      manualDecisions: this.manualDecisions.map(row => ({...row})),
      audit: this.audit.map(row => ({...row})),
    };
  }
}

export {recordAdvisoryWithForwardLogging};
