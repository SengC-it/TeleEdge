import fs from 'node:fs';
import path from 'node:path';
import {sha256, stableJson} from './contract.mjs';

export const V75_FROZEN_FILES = Object.freeze([
  'src/config.mjs', 'src/fill-risk.mjs', 'src/portfolio.mjs', 'src/strategy.mjs',
]);
export const V8_FROZEN_FILES = Object.freeze([
  'src/config.mjs', 'src/fill-risk.mjs', 'src/v8-shadow.mjs',
]);

function hashFiles(root, files) {
  const payload = files.map(file => ({path: file, sha256: sha256(fs.readFileSync(path.join(root, file)))}));
  return {sha256: sha256(stableJson(payload)), files: payload};
}

export function computeStrategyFreeze({root, baseMainSha = '21d2b8a1cdfed3e84153dce8491ed8448128727d'} = {}) {
  const v75 = hashFiles(root, V75_FROZEN_FILES);
  const v8 = hashFiles(root, V8_FROZEN_FILES);
  const validationRules = {
    minimumDurationDays: 90,
    minimumIndependentSignals: 50,
    verdictBeforeBothMinimums: 'INSUFFICIENT_FORWARD_SAMPLE',
    paperMode: true,
    automaticOrders: false,
    historicalBackfill: false,
    manualLedgerAffectsSystemPaper: false,
  };
  const freezeCore = {baseMainSha, v75StrategySha256: v75.sha256, v8StrategySha256: v8.sha256, validationRules};
  const strategyFreezeManifestSha256 = sha256(stableJson(freezeCore));
  return {
    baseMainSha,
    v75StrategySha256: v75.sha256,
    v8StrategySha256: v8.sha256,
    strategyFreezeManifestSha256,
    v75Files: v75.files,
    v8Files: v8.files,
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
  const forbidden = new Set([...V75_FROZEN_FILES, ...V8_FROZEN_FILES]);
  const changedFrozenFiles = changedPaths.filter(file => forbidden.has(file));
  return {pass: changedFrozenFiles.length === 0, changedFrozenFiles, frozenFiles: [...forbidden].sort()};
}

export function auditProductionIsolation(changedPaths = []) {
  const blockedPrefixes = [
    'supabase/functions/teleeg-worker/', 'supabase/functions/teleeg-reviews/', 'vercel.json',
    'supabase/config.toml', 'api/status.mjs', 'api/send-mail.mjs', 'api/reviews.mjs',
  ];
  const productionFiles = changedPaths.filter(file => blockedPrefixes.some(prefix => file === prefix || file.startsWith(prefix)));
  return {pass: productionFiles.length === 0, productionFiles};
}
