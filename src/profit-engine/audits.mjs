import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const executableExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const forbiddenWords = [
  ['create', 'Order'],
  ['place', 'Order'],
  ['new', 'Order'],
].map(parts => parts.join(''));
const forbiddenEndpoints = ['1', '2', '3'].map(version => ['/fapi/', `v${version}`, '/', 'order'].join(''));

function filesUnder(directory, output) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) filesUnder(full, output);
    else if (executableExtensions.has(path.extname(entry.name).toLowerCase())) output.push(full);
  }
}

export function auditRepoNoOrder(appDir, {roots = null} = {}) {
  const directories = roots || ['src', 'api', path.join('supabase', 'functions')].map(value => path.join(appDir, value));
  const resolved = roots ? directories.map(directory => path.isAbsolute(directory) ? directory : path.join(appDir, directory)) : directories;
  const files = [];
  for (const directory of resolved) filesUnder(directory, files);
  const findings = [];
  for (const file of files.sort()) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const lower = line.toLowerCase();
      for (const pattern of [...forbiddenWords, ...forbiddenEndpoints]) {
        if (lower.includes(pattern.toLowerCase())) findings.push({path: path.relative(appDir, file).replaceAll('\\', '/'), line: index + 1, pattern});
      }
    });
  }
  return {
    pass: findings.length === 0,
    roots: resolved.map(directory => path.relative(appDir, directory).replaceAll('\\', '/')),
    scannedFiles: files.map(file => path.relative(appDir, file).replaceAll('\\', '/')),
    offendingPaths: [...new Set(findings.map(row => row.path))].sort(),
    findings,
    boundary: 'market-data-only; no Binance order submission executable code',
  };
}

export function auditProductionIsolation(appDir, baseRef = 'research/v9-derivatives-multifactor') {
  let changedFiles = [];
  try {
    const committed = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {cwd: appDir, encoding: 'utf8'});
    const working = execFileSync('git', ['diff', '--name-only', 'HEAD'], {cwd: appDir, encoding: 'utf8'});
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {cwd: appDir, encoding: 'utf8'});
    changedFiles = [...new Set(`${committed}\n${working}\n${untracked}`.split(/\r?\n/).map(value => value.trim()).filter(Boolean))].sort();
  } catch {
    return {pass: false, baseRef, changedFiles: [], productionFiles: [], error: 'unable-to-audit-git-diff'};
  }
  const productionPrefixes = [
    'api/', 'supabase/', 'vercel.json', '.vercel/',
    'src/daemon.', 'src/config.', 'src/binance.', 'src/portfolio.',
  ];
  const productionFiles = changedFiles.filter(file => productionPrefixes.some(prefix => file === prefix || file.startsWith(prefix)));
  return {
    pass: productionFiles.length === 0,
    baseRef,
    changedFiles,
    productionFiles,
    boundary: 'research-only; Production strategy, APIs, cron, SMTP, secrets and schema unchanged',
  };
}
