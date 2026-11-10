/**
 * Unit tests for host/journal.js — sequence allocation, afterSequence paging, the line/byte
 * double budget (first row always survives), watermark and legacy/corrupt-line tolerance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_EVENT_LIMIT,
  EVENT_TYPES,
  Journal,
  MAX_EVENT_PAGE_BYTES,
  WORKFLOW_EVENT_TYPES,
  createJournal,
  normalizeAfterSequence,
  normalizeEventLimit,
  pageEvents,
} from '../host/journal.js';

/** @returns {Promise<{ dir: string, file: string, journal: Journal, cleanup: () => Promise<void> }>} */
async function fixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dwf-journal-'));
  return {
    dir,
    file: path.join(dir, 'journal.jsonl'),
    journal: createJournal(dir),
    cleanup: async () => {
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

test('event type table is the 26-entry contract from §2.1', () => {
  assert.equal(WORKFLOW_EVENT_TYPES.length, 26);
  assert.equal(new Set(WORKFLOW_EVENT_TYPES).size, 26);
  assert.equal(EVENT_TYPES.RUN_STARTED, 'run-started');
  assert.equal(EVENT_TYPES.IMPORT_CACHE_CLOSED, 'import-cache-closed');
  assert.deepEqual(
    [...WORKFLOW_EVENT_TYPES].sort(),
    [
      'actor-created',
      'artifact-failed',
      'artifact-published',
      'concurrency-changed',
      'escalation-raised',
      'escalation-resolved',
      'hole-filled',
      'hole-reached',
      'import-cache-closed',
      'log',
      'node-dispatched',
      'node-executing',
      'node-nudged',
      'node-progress',
      'node-queued',
      'node-repairing',
      'node-settled',
      'node-waiting',
      'phase-entered',
      'report',
      'run-caps-changed',
      'run-launched',
      'run-settled',
      'run-stalled',
      'run-started',
      'usage-updated',
    ],
  );
});

test('limit and afterSequence normalization match the wire schema', () => {
  assert.equal(normalizeEventLimit(undefined), DEFAULT_EVENT_LIMIT);
  assert.equal(normalizeEventLimit(0), DEFAULT_EVENT_LIMIT);
  assert.equal(normalizeEventLimit(700), 500);
  assert.equal(normalizeEventLimit('12'), 12);
  assert.equal(normalizeAfterSequence(undefined), undefined);
  assert.equal(normalizeAfterSequence(-1), undefined);
  assert.equal(normalizeAfterSequence(0), 0);
  assert.equal(normalizeAfterSequence('3'), 3);
});

test('append allocates contiguous sequences starting at 0', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  for (let index = 0; index < 5; index += 1) {
    const row = await f.journal.append({ type: 'log', message: `line ${index}` });
    assert.equal(row.sequence, index);
  }
  const rows = await f.journal.readRows();
  assert.deepEqual(rows.map((row) => row.sequence), [0, 1, 2, 3, 4]);
  assert.equal(await f.journal.watermark(), 4);

  const events = await f.journal.readAll();
  assert.equal(events[0].message, 'line 0');
  assert.equal(events[0].type, 'log');
  assert.equal(events[0].sequence, 0);
  assert.equal(typeof events[0].at, 'number');
});

test('concurrent appends keep the sequence unique and contiguous', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  await Promise.all(Array.from({ length: 40 }, (_, index) => f.journal.append({ type: 'report', index })));
  const rows = await f.journal.readRows();
  assert.equal(rows.length, 40);
  assert.deepEqual(rows.map((row) => row.sequence), Array.from({ length: 40 }, (_, index) => index));
});

test('afterSequence is an exclusive lower bound and limit reports hasMore', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  for (let index = 0; index < 10; index += 1) await f.journal.append({ type: 'log', message: String(index) });

  const first = await f.journal.page({ afterSequence: 2, limit: 3 });
  assert.deepEqual(first.events.map((event) => event.sequence), [3, 4, 5]);
  assert.equal(first.hasMore, true);
  assert.equal(first.lastEventSequence, 9);

  const tail = await f.journal.page({ afterSequence: 7, limit: 10 });
  assert.deepEqual(tail.events.map((event) => event.sequence), [8, 9]);
  assert.equal(tail.hasMore, false);

  const empty = await f.journal.page({ afterSequence: 9, limit: 10 });
  assert.deepEqual(empty.events, []);
  assert.equal(empty.hasMore, false);
  assert.equal(empty.lastEventSequence, 9);
});

test('pageEvents never drops the first row and stops at the byte budget', () => {
  const big = 'x'.repeat(600);
  const rows = [
    { sequence: 0, type: 'log', payload: { type: 'log', message: 'first' } },
    { sequence: 1, type: 'log', payload: { type: 'log', message: 'second' } },
    { sequence: 2, type: 'log', payload: { type: 'log', message: big } },
  ];
  const firstOnly = pageEvents(rows, { maxBytes: 20 });
  assert.deepEqual(firstOnly.events.map((event) => event.sequence), [0]);
  assert.equal(firstOnly.hasMore, true);

  const oversizedFirst = pageEvents(
    [{ sequence: 0, type: 'log', payload: { message: big } }, { sequence: 1, type: 'log', payload: { message: 'next' } }],
    { maxBytes: 10 },
  );
  // 首行即使超过预算也完整返回：否则客户端会卡在同一个 afterSequence 上死循环。
  assert.deepEqual(oversizedFirst.events.map((event) => event.sequence), [0]);
  assert.equal(oversizedFirst.events[0].payload.message.length, 600);
  assert.equal(oversizedFirst.hasMore, true);

  const byRows = pageEvents(rows, { limit: 1, maxBytes: MAX_EVENT_PAGE_BYTES });
  assert.deepEqual(byRows.events.map((event) => event.sequence), [0]);
  assert.equal(byRows.hasMore, true);
});

test('legacy flat rows and torn lines are tolerated', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  await fsp.writeFile(
    f.file,
    [
      JSON.stringify({ at: 10, type: 'phase/started', name: 'preflight' }),
      'not json',
      JSON.stringify({ at: 11, type: 'log', message: 'after tear' }),
      '',
    ].join('\n'),
    'utf8',
  );

  const rows = await f.journal.readRows();
  assert.deepEqual(rows.map((row) => row.sequence), [0, 1]);
  assert.equal(rows[0].payload.name, 'preflight');

  const events = await f.journal.readAll();
  assert.equal(events[0].type, 'phase/started');
  assert.equal(events[0].name, 'preflight');
  assert.equal(events[0].at, 10);
  assert.equal(events[1].message, 'after tear');

  // 追加时不能与旧行号/sequence 冲突。
  const appended = await f.journal.append({ type: 'log', message: 'new' });
  assert.equal(appended.sequence, 2);
  assert.equal((await f.journal.readRows()).length, 3);
});

test('payload is stored as the full event object and re-read flat', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  const row = await f.journal.append({
    type: 'artifact-published',
    instance: { siteId: 'site-a', ordinal: 2 },
    artifact: { id: 'report', kind: 'markdown', version: 1 },
  });
  assert.equal(row.type, 'artifact-published');
  assert.deepEqual(row.payload.instance, { siteId: 'site-a', ordinal: 2 });

  const [event] = await f.journal.readAll();
  assert.equal(event.type, 'artifact-published');
  assert.equal(event.instance.siteId, 'site-a');
  assert.equal(event.artifact.id, 'report');
});

test('a missing journal reads as empty and starts at sequence 0', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  assert.deepEqual(await f.journal.readRows(), []);
  assert.equal(await f.journal.watermark(), 0);
  const page = await f.journal.page({});
  assert.deepEqual(page.events, []);
  assert.equal(page.lastEventSequence, 0);
  assert.equal((await f.journal.append({ type: 'run-started' })).sequence, 0);
});
