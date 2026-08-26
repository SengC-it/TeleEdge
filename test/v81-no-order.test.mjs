import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {APP_DIR} from '../src/config.mjs';

const forbidden = [
  'createOrder', 'placeOrder', 'newOrder',
  '/fapi/v1/order', '/fapi/v2/order', '/fapi/v3/order',
];

function sourceFiles(directory) {
  const output = [];
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...sourceFiles(full));
    else if (entry.name.endsWith('.mjs')) output.push(full);
  }
  return output;
}

test('V8.1 research layer has no real execution path', () => {
  const files = [...sourceFiles(path.join(APP_DIR, 'src', 'v81')), path.join(APP_DIR, 'scripts', 'run-v81-development.mjs')];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const term of forbidden) assert.equal(source.includes(term), false, `${term} found in ${path.relative(APP_DIR, file)}`);
  }
});
