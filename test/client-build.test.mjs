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
  // Git may check the committed artifact out with CRLF on Windows; the generator always writes LF.
  const normalize = (text) => text.replace(/\r\n/g, '\n');
  assert.equal(normalize(after), normalize(before), 'client.js is stale; run node scripts/build-client.mjs');
  execFileSync(process.execPath, ['--check', clientPath]);
});

test('the built client keeps the run card wired to its Session and its tool call', () => {
  const client = readFileSync(clientPath, 'utf8');
  // The keyed tool seat hands the Session to the registration's inject hook, never to the owner
  // payload; without this line a card has no Session and the run channel never asks for anything.
  assert.ok(
    client.includes('inject: (sessionId) => ({ sessionId })'),
    'the tool card registration must inject the Session id',
  );
  // A card claims its run through the tool call that launched it: the owner spells it `callId`,
  // the run catalogue spells it `toolCallId`, and the card model has to read both.
  assert.ok(client.includes('props.callId'), 'the card model must read the owner callId');
  assert.ok(client.includes('wfRunCardOwnRow'), 'the run card must claim its row by tool call id');
  assert.ok(client.includes('wfRunToolCallId(row) === model.toolId'), 'the claim must compare the run row toolCallId');
  // The session header seat renders its children with an empty owner payload, so the status entry
  // reads the Session from its own inject hook; without it the entry lists nothing.
  assert.ok(
    client.includes('inject: (sessionId) => ({\n      sessionId,'),
    'the workflow status entry must inject the Session id',
  );
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
