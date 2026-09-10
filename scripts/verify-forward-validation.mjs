import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {APP_DIR} from '../src/config.mjs';
import {auditNoOrderPaths} from '../src/forward-validation/no-order-audit.mjs';
import {auditProductionIsolation, auditStrategyFreeze} from '../src/forward-validation/freeze.mjs';

const changed = (() => {
  try {
    return execFileSync('git', ['diff', '--name-only', 'main...HEAD'], {cwd: APP_DIR, encoding: 'utf8'}).trim().split(/\r?\n/).filter(Boolean);
  } catch {
    try { return execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], {cwd: APP_DIR, encoding: 'utf8'}).trim().split(/\r?\n/).filter(Boolean); }
    catch { return []; }
  }
})();
const freeze = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'reports', 'forward-validation-freeze.json'), 'utf8'));
const noOrder = auditNoOrderPaths(APP_DIR);
const strategy = auditStrategyFreeze(changed);
const isolation = auditProductionIsolation(changed);
const result = {status: noOrder.pass && strategy.pass && isolation.pass ? 'PASS' : 'FAIL', repoNoOrderAudit: noOrder, strategyFreezeAudit: strategy, productionBehaviorIsolation: isolation, changedFiles: changed, freezeManifest: freeze};
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
