import fs from 'node:fs';
import path from 'node:path';

const EXECUTABLE_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx']);
const FORBIDDEN = [
  /\bcreateOrder\b/, /\bplaceOrder\b/, /\bnewOrder\b/,
  /\/fapi\/v1\/order/, /\/fapi\/v2\/order/, /\/fapi\/v3\/order/,
];

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  const output = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(full));
    else if (EXECUTABLE_EXTENSIONS.has(path.extname(entry.name))) output.push(full);
  }
  return output;
}

export function auditNoOrderPaths(root) {
  const roots = ['src', 'api', 'supabase/functions'].map(relative => path.join(root, relative));
  const offendingPaths = [];
  for (const file of roots.flatMap(filesUnder)) {
    const text = fs.readFileSync(file, 'utf8');
    if (FORBIDDEN.some(pattern => pattern.test(text))) offendingPaths.push(path.relative(root, file).replaceAll('\\', '/'));
  }
  return {
    pass: offendingPaths.length === 0,
    scannedRoots: ['src', 'api', 'supabase/functions'],
    offendingPaths,
    rule: 'Executable source only; audit declaration and test fixtures are outside the scanned roots.',
  };
}
