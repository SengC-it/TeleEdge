import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {APP_DIR} from '../src/config.mjs';
import {computeStrategyFreeze} from '../src/forward-validation/freeze.mjs';

const baseMainSha = (() => {
  try { return execFileSync('git', ['rev-parse', 'main'], {cwd: APP_DIR, encoding: 'utf8'}).trim(); } catch { return '21d2b8a1cdfed3e84153dce8491ed8448128727d'; }
})();
const manifest = {...computeStrategyFreeze({root: APP_DIR, baseMainSha}), createdAt: new Date().toISOString()};
fs.mkdirSync(path.join(APP_DIR, 'reports'), {recursive: true});
fs.writeFileSync(path.join(APP_DIR, 'reports', 'forward-validation-freeze.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const runbook = `# TeleEdge Frozen Forward Validation Runbook

Status: **PREPARED only**. Phase 1 does not activate a run, apply a migration, or deploy a function/Vercel.

## Future authorized launch

1. Apply the additive forward-validation migration.
2. Deploy the reviewed application/functions and run the smoke checks.
3. Verify \`v75StrategySha256\`, \`v8StrategySha256\`, and \`strategyFreezeManifestSha256\` against the freeze manifest.
4. Create a \`PREPARED\` run with the deployment reference.
5. Use an explicit authenticated activation operation; record \`startedAt\`.
6. Begin immutable signal collection. Only observations at or after \`startedAt\` are eligible; historical backfill is rejected.

## Lifecycle and invalidation

Runs move PREPARED → ACTIVE → COMPLETED only through explicit operations. A strategy fingerprint change while ACTIVE invalidates the run with \`STRATEGY_MUTATION\`; its sample is never mixed with a new run. Data-integrity failures invalidate or block evaluation.

## Evaluation

The final evaluation requires both 90 elapsed days and 50 combined independent closed signals. Open paper positions, manual decisions, history/backtest results, and invalid-quality signals are excluded from PF, expectancy, win rate, and realized PnL. The final gate requires PF ≥ 1.35, expectancy ≥ +0.15R, positive net PnL, max DD ≤ 6%, at least 10 unique symbols, unchanged hashes, and no data-integrity failure. Before both minimums, the verdict is \`INSUFFICIENT_FORWARD_SAMPLE\`; no PASS/FAIL/GO/STOP is shown.

## Evidence export

Research/admin export contains the run manifest, immutable signals, system-paper outcomes, metrics, manual decision ledger, and audit history. Manual ledger edits never change system-paper results.\n`;
fs.writeFileSync(path.join(APP_DIR, 'reports', 'forward-validation-runbook.md'), runbook);
console.log(JSON.stringify({status: manifest.status, baseMainSha: manifest.baseMainSha, v75StrategySha256: manifest.v75StrategySha256, v8StrategySha256: manifest.v8StrategySha256, strategyFreezeManifestSha256: manifest.strategyFreezeManifestSha256}));
