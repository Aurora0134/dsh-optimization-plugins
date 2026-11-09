/**
 * The served `client.js` is generated: every part under `client-src/` and every locale section
 * must be reflected in it. This test rebuilds and fails when the committed artifact is stale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const clientPath = path.join(root, 'client.js');

test('client.js is built from client-src and locale files', () => {
  const before = readFileSync(clientPath, 'utf8');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-client.mjs')], { cwd: root });
  const after = readFileSync(clientPath, 'utf8');
  assert.equal(after, before, 'client.js is stale; run node scripts/build-client.mjs');
  execFileSync(process.execPath, ['--check', clientPath]);
});

test('client.js carries both dictionaries and every tool card key', () => {
  const client = readFileSync(clientPath, 'utf8');
  const en = JSON.parse(readFileSync(path.join(root, 'locale', 'en.json'), 'utf8'));
  const zh = JSON.parse(readFileSync(path.join(root, 'locale', 'zh.json'), 'utf8'));
  for (const key of Object.keys(en.tool)) {
    assert.ok(client.includes(JSON.stringify(key)), `missing tool key ${key} in client.js`);
  }
  for (const [key, value] of Object.entries(zh.tool)) {
    assert.ok(client.includes(JSON.stringify(value)), `missing Chinese tool copy for ${key}`);
  }
});
