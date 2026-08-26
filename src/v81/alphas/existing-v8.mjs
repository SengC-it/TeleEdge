import {BASELINE_ALPHA_IDS} from '../alpha-registry.mjs';

export const existingV8Baseline = Object.freeze({
  ids: BASELINE_ALPHA_IDS,
  status: 'baseline-anchor-only',
  enabledInV81Research: false,
  note: 'The production V8 implementation remains the frozen comparison anchor; no production generator is imported here.',
});
