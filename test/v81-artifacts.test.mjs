import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {APP_DIR} from '../src/config.mjs';

test('V8.1 raw research artifacts are excluded from source and deployment artifacts', () => {
  const gitignore = fs.readFileSync(`${APP_DIR}/.gitignore`, 'utf8');
  const vercelignore = fs.readFileSync(`${APP_DIR}/.vercelignore`, 'utf8');
  assert.match(gitignore, /^data\/v81-development\/$/m);
  assert.match(vercelignore, /^data\/v81-development\/$/m);
});
