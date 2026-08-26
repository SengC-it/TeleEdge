import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STRATEGY_ROOTS = Object.freeze([
  'src/v81',
  'src/strategy.mjs',
  'src/v8-shadow.mjs',
  'src/portfolio.mjs',
  'src/backtest.mjs',
  'src/fill-risk.mjs',
  'src/market-data.mjs',
  'src/risk.mjs',
  'src/indicators.mjs',
  'src/config.mjs',
  'scripts/backtest.mjs',
]);

function sourceFiles(root, relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) return [];
  const stat = fs.statSync(fullPath);
  if (stat.isFile()) return [relativePath];
  return fs.readdirSync(fullPath, {withFileTypes: true})
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => sourceFiles(root, path.join(relativePath, entry.name)))
    .filter(file => file.endsWith('.mjs'));
}

export function strategyTreeFiles(appDir) {
  return [...new Set(STRATEGY_ROOTS.flatMap(relativePath => sourceFiles(appDir, relativePath)))].sort();
}

export function strategyTreeSha256(appDir) {
  const hash = crypto.createHash('sha256');
  for (const relativePath of strategyTreeFiles(appDir)) {
    hash.update(relativePath.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(appDir, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function jsonSha256(value) {
  return crypto.createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
}

export function validateProvenance(provenance, {currentStrategyTreeSha256 = null} = {}) {
  const required = ['strategyTreeSha256', 'developmentRunCodeCommit', 'reportCommit', 'frozenConfigSha256', 'datasetManifestSha256'];
  const missing = required.filter(key => !provenance?.[key]);
  const strategyTreeMatches = currentStrategyTreeSha256 == null || provenance?.strategyTreeSha256 === currentStrategyTreeSha256;
  return {valid: missing.length === 0 && strategyTreeMatches, missing, strategyTreeMatches};
}
