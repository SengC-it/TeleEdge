import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sha256, stableJson} from './contract.mjs';

export const V75_FROZEN_FILES = Object.freeze([
  'src/config.mjs', 'src/fill-risk.mjs', 'src/portfolio.mjs', 'src/strategy.mjs',
]);
export const V8_FROZEN_FILES = Object.freeze([
  'src/config.mjs', 'src/fill-risk.mjs', 'src/v8-shadow.mjs',
]);
export const PRODUCTION_WORKER_FILES = Object.freeze([
  'supabase/functions/teleeg-worker/auth.mjs',
  'supabase/functions/teleeg-worker/finalize.mjs',
  'supabase/functions/teleeg-worker/funnel.mjs',
  'supabase/functions/teleeg-worker/forward-validation.mjs',
  'supabase/functions/teleeg-worker/index.ts',
  'supabase/functions/teleeg-worker/risk.mjs',
  'supabase/functions/teleeg-worker/strategy.mjs',
  'supabase/functions/teleeg-worker/v8-shadow.mjs',
]);
export const PRODUCTION_INSTRUMENTATION_FILES = Object.freeze([
  'supabase/functions/teleeg-worker/forward-validation.mjs',
  'supabase/functions/teleeg-worker/index.ts',
]);

function hashFiles(root, files) {
  const payload = files.map(file => ({path: file, sha256: sha256(fs.readFileSync(path.join(root, file)))}));
  return {sha256: sha256(stableJson(payload)), files: payload};
}

export function computeStrategyFreeze({root, baseMainSha = '21d2b8a1cdfed3e84153dce8491ed8448128727d'} = {}) {
  const worker = hashFiles(root, PRODUCTION_WORKER_FILES);
  const v75 = hashFiles(root, [...V75_FROZEN_FILES, ...PRODUCTION_WORKER_FILES]);
  const v8 = hashFiles(root, [...V8_FROZEN_FILES, ...PRODUCTION_WORKER_FILES]);
  const validationRules = {
    minimumDurationDays: 90,
    minimumIndependentSignals: 50,
    verdictBeforeBothMinimums: 'INSUFFICIENT_FORWARD_SAMPLE',
    paperMode: true,
    automaticOrders: false,
    historicalBackfill: false,
    manualLedgerAffectsSystemPaper: false,
  };
  const freezeCore = {baseMainSha, v75StrategySha256: v75.sha256, v8StrategySha256: v8.sha256, productionWorkerSha256: worker.sha256, validationRules};
  const strategyFreezeManifestSha256 = sha256(stableJson(freezeCore));
  return {
    baseMainSha,
    v75StrategySha256: v75.sha256,
    v8StrategySha256: v8.sha256,
    productionWorkerSha256: worker.sha256,
    strategyFreezeManifestSha256,
    v75Files: v75.files,
    v8Files: v8.files,
    productionWorkerFiles: worker.files,
    validationRules,
    minimumDays: 90,
    minimumSignals: 50,
    finalGate: {
      durationDays: 90,
      independentClosedSignals: 50,
      profitFactor: 1.35,
      expectancyR: 0.15,
      netPnlPositive: true,
      maxDrawdownPct: 0.06,
      uniqueSymbols: 10,
      dataIntegrity: true,
      strategyHashesUnchanged: true,
    },
    status: 'PREPARED',
  };
}

export function auditStrategyFreeze(changedPaths = []) {
  const forbidden = new Set([...V75_FROZEN_FILES, ...V8_FROZEN_FILES, ...PRODUCTION_WORKER_FILES]
    .filter(file => !PRODUCTION_INSTRUMENTATION_FILES.includes(file)));
  const changedFrozenFiles = changedPaths.filter(file => forbidden.has(file));
  return {pass: changedFrozenFiles.length === 0, changedFrozenFiles, frozenFiles: [...forbidden].sort()};
}

export function auditProductionIsolation(changedPaths = []) {
  const blockedPrefixes = [
    'supabase/functions/teleeg-reviews/', 'vercel.json',
    'supabase/config.toml', 'api/status.mjs', 'api/send-mail.mjs', 'api/reviews.mjs',
  ];
  const productionFiles = changedPaths.filter(file => {
    if (file.startsWith('supabase/functions/teleeg-worker/')) return !PRODUCTION_INSTRUMENTATION_FILES.includes(file);
    return blockedPrefixes.some(prefix => file === prefix || file.startsWith(prefix));
  });
  return {pass: productionFiles.length === 0, productionFiles};
}

function withoutForwardInstrumentation(source) {
  return String(source).split(/\r?\n/)
    .filter(line => !line.includes('forward-validation') && !line.includes('recordForward'))
    .join('\n')
    .replace(/\n+$/, '');
}

export function auditProductionSemanticIsolation(root, changedPaths = []) {
  const workerChanges = changedPaths.filter(file => file.startsWith('supabase/functions/teleeg-worker/'));
  const forbidden = workerChanges.filter(file => !PRODUCTION_INSTRUMENTATION_FILES.includes(file));
  let indexSemanticUnchanged = true;
  let comparisonError = null;
  if (workerChanges.includes('supabase/functions/teleeg-worker/index.ts')) {
    try {
      const current = fs.readFileSync(path.join(root, 'supabase/functions/teleeg-worker/index.ts'), 'utf8');
      let base = null;
      for (const ref of ['main', 'origin/main']) {
        try {
          base = execFileSync('git', ['show', `${ref}:supabase/functions/teleeg-worker/index.ts`], {cwd: root, encoding: 'utf8'});
          break;
        } catch { /* checkout providers differ on whether main is local or remote-tracking */ }
      }
      if (base == null) throw new Error('main worker baseline is unavailable');
      indexSemanticUnchanged = withoutForwardInstrumentation(current) === withoutForwardInstrumentation(base);
    } catch (error) {
      comparisonError = String(error);
      indexSemanticUnchanged = false;
    }
  }
  return {
    pass: forbidden.length === 0 && indexSemanticUnchanged,
    productionFiles: forbidden,
    indexSemanticUnchanged,
    comparisonError,
    allowedInstrumentationFiles: [...PRODUCTION_INSTRUMENTATION_FILES],
  };
}
