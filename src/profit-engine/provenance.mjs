import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function hashFile(file) { return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null; }

export function hashFiles(root, files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort()) { const full = path.isAbsolute(file) ? file : path.join(root, file); if (!fs.existsSync(full)) continue; hash.update(path.relative(root, full).replaceAll('\\', '/')); hash.update('\0'); hash.update(fs.readFileSync(full)); hash.update('\0'); }
  return hash.digest('hex');
}

export function jsonSha256(value) { return crypto.createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex'); }

export function profitEngineFiles(appDir) {
  const directory = path.join(appDir, 'src', 'profit-engine');
  const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.mjs')).map(name => path.join('src', 'profit-engine', name)) : [];
  const runner = path.join('scripts', 'run-profit-engine-development.mjs');
  if (fs.existsSync(path.join(appDir, runner))) files.push(runner);
  return files.sort();
}

export function profitEngineCodeSha256(appDir) { return hashFiles(appDir, profitEngineFiles(appDir)); }
