/**
 * Unit tests for host/projection.js — every one of the 26 contract event types is applied at least
 * once; the tests pin the §3.1 field semantics (usage, actor status derivation, node phases,
 * artifacts/reports, concurrency, holes, settlement) and the bounded-list accounting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONSUMED_EVENT_TYPES,
  PROJECTION_LIMITS,
  applyWorkflowRunEvent,
  createRunState,
  projectRunEvents,
  workflowRunSummary,
} from '../host/projection.js';
import { WORKFLOW_EVENT_TYPES } from '../host/journal.js';

const INSTANCE = { siteId: 'site-a', ordinal: 0 };
const ACTOR = { siteId: 'actor-a', ordinal: 0 };

/**
 * Sequential event applier: keeps a state and a monotonically increasing `sequence`.
 */
function scenario() {
  let state = createRunState({ runId: 'run-1' });
  let sequence = 0;
  return {
    apply(type, payload = {}) {
      state = applyWorkflowRunEvent(state, {
        sequence,
        type,
        payload: { type, ...payload },
      });
      sequence += 1;
      return state;
    },
    get state() {
      return state;
    },
    get sequence() {
      return sequence;
    },
  };
}

test('run-started resets a life, keeps resumable tables and records the caps', () => {
  const run = scenario();
  run.apply('run-started', {
    runId: 'run-1',
    caps: { maxConcurrency: 6 },
    concurrencyCeiling: 8,
  });
  assert.equal(run.state.status, 'running');
  assert.deepEqual(run.state.usage, { spentTokens: 0, nodesUsed: 0 });
  assert.deepEqual(run.state.concurrency, { cap: 8, ceiling: 8, limit: 6 });

  run.apply('actor-created', { actor: ACTOR, name: 'reviewer', phaseName: 'review' });
  assert.equal(run.state.actors.length, 1);
  // 第二次生命期（resume）不能丢掉未截断的 actor 表。
  run.apply('run-started', {
    runId: 'run-1',
    caps: { maxConcurrency: 4 },
    concurrencyCeiling: 8,
    resumedFrom: 'run-0',
  });
  assert.equal(run.state.status, 'running');
  assert.equal(run.state.resumedFrom, 'run-0');
  assert.equal(run.state.actors.length, 1);
  assert.deepEqual(run.state.concurrency, { cap: 8, ceiling: 8, limit: 4 });
});

test('run-launched carries the authoritative phase order and hole indexes', () => {
  const run = scenario();
  run.apply('run-launched', {
    phaseNames: ['prep', 'build', 'ship'],
    phaseAlongside: [[], [2], []],
    holes: [1],
  });
  assert.deepEqual(run.state.phaseNames, ['prep', 'build', 'ship']);
  assert.deepEqual(run.state.phaseAlongside, [[], [2], []]);
  assert.deepEqual(run.state.phaseHoles, [1]);
});

test('phase-entered tracks rounds and marks the current phase', () => {
  const run = scenario();
  run.apply('phase-entered', { name: 'prep', ordinal: 1 });
  run.apply('phase-entered', { name: 'prep', ordinal: 3 });
  run.apply('phase-entered', { name: 'build', ordinal: 1 });
  assert.deepEqual(run.state.phases, [
    { name: 'prep', rounds: 3 },
    { name: 'build', rounds: 1 },
  ]);
  assert.equal(run.state.currentPhase, 'build');
});

test('actor-created + node lifecycle derive actor status and count nodesUsed on first dispatch', () => {
  const run = scenario();
  run.apply('actor-created', { actor: ACTOR, name: 'reviewer', phaseName: 'review' });
  assert.equal(run.state.actors[0].status, 'waiting');

  run.apply('node-queued', { instance: INSTANCE, kind: 'ask', phaseName: 'review' });
  assert.equal(run.state.nodes[0].phase, 'queued');
  assert.equal(run.state.actors[0].status, 'waiting');
  assert.equal(run.state.usage.nodesUsed, 0);

  run.apply('node-dispatched', {
    instance: INSTANCE,
    kind: 'ask',
    actor: ACTOR,
    instructionsHead: 'Review the diff',
  });
  assert.equal(run.state.nodes[0].phase, 'dispatched');
  assert.equal(run.state.actors[0].status, 'waiting');
  assert.equal(run.state.usage.nodesUsed, 1);

  // 同一 instance 再次 dispatched 不重复计数。
  run.apply('node-dispatched', { instance: INSTANCE, actor: ACTOR });
  assert.equal(run.state.usage.nodesUsed, 1);

  run.apply('node-executing', { instance: INSTANCE });
  assert.equal(run.state.nodes[0].phase, 'executing');
  assert.equal(run.state.actors[0].status, 'running');

  run.apply('node-waiting', { instance: INSTANCE });
  assert.equal(run.state.nodes[0].phase, 'waiting');
  assert.equal(run.state.actors[0].status, 'waiting');

  run.apply('node-repairing', { instance: INSTANCE, attempt: 1, violations: [] });
  assert.equal(run.state.nodes[0].phase, 'repairing');
  assert.equal(run.state.actors[0].status, 'running');

  run.apply('node-nudged', { instance: INSTANCE });
  assert.equal(run.state.nodes[0].phase, 'nudged');
  assert.equal(run.state.actors[0].status, 'running');

  run.apply('node-settled', { instance: INSTANCE, outcome: 'ok' });
  assert.equal(run.state.nodes[0].phase, 'settled');
  assert.equal(run.state.nodes[0].outcome, 'ok');
  assert.equal(run.state.actors[0].status, 'completed');
});

test('node-settled(cached=true) is born queued and carries the transcript session', () => {
  const run = scenario();
  run.apply('actor-created', { actor: ACTOR, name: 'reviewer' });
  run.apply('node-settled', {
    instance: INSTANCE,
    actor: ACTOR,
    outcome: 'ok',
    cached: true,
    sourceSessionId: 'session-child',
  });
  assert.equal(run.state.nodes[0].cached, true);
  assert.equal(run.state.nodes[0].phase, 'settled');
  assert.equal(run.state.actors[0].sessionId, 'session-child');
});

test('node-progress only patches turn/toolCalls/lastTool', () => {
  const run = scenario();
  run.apply('node-queued', { instance: INSTANCE, kind: 'ask' });
  run.apply('node-progress', {
    instance: INSTANCE,
    turn: 2,
    toolCalls: 5,
    lastTool: { name: 'grep', target: 'src' },
  });
  assert.equal(run.state.nodes[0].turn, 2);
  assert.equal(run.state.nodes[0].toolCalls, 5);
  assert.deepEqual(run.state.nodes[0].lastTool, { name: 'grep', target: 'src' });
  assert.equal(run.state.nodes[0].phase, 'queued');
});

test('report stores a bounded preview and counts the tagged artifact', () => {
  const run = scenario();
  run.apply('artifact-published', {
    artifact: { id: 'report', kind: 'markdown', version: 1, title: 'Report', primary: true },
  });
  run.apply('report', {
    instance: INSTANCE,
    item: { answer: 42 },
    artifactId: 'report',
  });
  const report = run.state.reports[0];
  assert.equal(report.siteId, 'site-a');
  assert.equal(report.artifactId, 'report');
  assert.match(report.preview, /"answer": 42/u);
  assert.equal(run.state.artifacts[0].itemCount, 1);
  assert.equal(run.state.artifacts[0].primary, true);

  const bad = scenario();
  bad.apply('artifact-published', { artifact: { id: 'x', kind: 'not-a-kind', version: 1 } });
  assert.deepEqual(bad.state.artifacts ?? [], []);
  bad.apply('artifact-failed', { instance: INSTANCE, id: 'x', op: 'publish', error: { code: 'E', message: 'no' } });
  assert.equal(bad.state.status, 'pending');
});

test('usage-updated accumulates spent tokens on the usage record', () => {
  const run = scenario();
  run.apply('usage-updated', { spentTokens: 120 });
  run.apply('usage-updated', { spentTokens: 300 });
  assert.equal(run.state.usage.spentTokens, 300);
  assert.equal(run.state.usage.nodesUsed, 0);
});

test('escalation-raised/resolved maintain pendingQuestions by qid', () => {
  const run = scenario();
  run.apply('escalation-raised', {
    qid: 'dwfq-run-1-0',
    actor: ACTOR,
    actorName: 'reviewer',
    question: 'Ship it?',
    context: 'CI is green',
    askedAt: 1000,
  });
  assert.equal(run.state.pendingQuestions.length, 1);
  assert.equal(run.state.pendingQuestions[0].question, 'Ship it?');
  run.apply('escalation-resolved', { qid: 'dwfq-run-1-0', answer: 'yes' });
  assert.equal('pendingQuestions' in run.state, false);
});

test('concurrency-changed tracks the cap, monotonic ceiling and cooldown', () => {
  const run = scenario();
  run.apply('run-started', { caps: { maxConcurrency: 8 }, concurrencyCeiling: 8 });
  run.apply('concurrency-changed', {
    next: 4,
    previous: 8,
    reason: 'throttled',
    cooldownMs: 5000,
  });
  assert.deepEqual(run.state.concurrency, { cap: 4, ceiling: 8, cooldownMs: 5000 });
  run.apply('concurrency-changed', { next: 6, previous: 4, reason: 'recovered' });
  assert.deepEqual(run.state.concurrency, { cap: 6, ceiling: 8 });
  run.apply('concurrency-changed', { next: 6, previous: 6, reason: 'idle_reset', cooldownMs: 0 });
  assert.equal('cooldownMs' in run.state.concurrency, false);
});

test('run-caps-changed updates the limit and clears the window at the ceiling', () => {
  const run = scenario();
  run.apply('run-started', { caps: { maxConcurrency: 8 }, concurrencyCeiling: 8 });
  run.apply('run-caps-changed', { runId: 'run-1', caps: { maxConcurrency: 6 }, previous: { maxConcurrency: 8 } });
  assert.deepEqual(run.state.concurrency, { cap: 8, ceiling: 8, limit: 6 });
  run.apply('run-caps-changed', { runId: 'run-1', caps: { maxConcurrency: 8 }, previous: { maxConcurrency: 6 } });
  // limit 回到 ceiling 且没有 cooldown 时整个 concurrency 字段消失（§3.4）。
  assert.equal('concurrency' in run.state, false);
});

test('hole-reached/filled drive the waiting → filled transition', () => {
  const run = scenario();
  run.apply('run-launched', { phaseNames: ['prep', 'build'], holes: [1] });
  run.apply('hole-reached', {
    instance: INSTANCE,
    name: 'target',
    prompt: 'Which target?',
    since: 500,
  });
  assert.equal(run.state.holes[0].state, 'waiting');
  assert.equal(run.state.holes[0].since, 500);

  run.apply('hole-filled', {
    siteId: 'site-a',
    filledAt: 900,
    filledBy: 'user',
    phaseNames: ['prep', 'build', 'ship'],
    holes: [1],
  });
  assert.equal(run.state.holes[0].state, 'filled');
  assert.equal(run.state.holes[0].filledAt, 900);
  assert.equal('prompt' in run.state.holes[0], false);
  assert.deepEqual(run.state.phaseNames, ['prep', 'build', 'ship']);
  assert.deepEqual(run.state.phaseHoles, [1]);
});

test('run-settled maps status, stop reason, superseded chain and error text', () => {
  const completed = projectRunEvents([
    { sequence: 0, type: 'run-started', payload: { type: 'run-started', caps: { maxConcurrency: 2 } } },
    { sequence: 1, type: 'run-settled', payload: { type: 'run-settled', status: 'completed', resumable: true } },
  ], { runId: 'run-1' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.resumable, true);

  const superseded = projectRunEvents([
    { sequence: 0, type: 'run-started', payload: { type: 'run-started' } },
    {
      sequence: 1,
      type: 'run-settled',
      payload: { type: 'run-settled', status: 'stopped', stopReason: 'superseded', supersededBy: 'run-2' },
    },
  ], { runId: 'run-1' });
  assert.equal(superseded.status, 'stopped');
  assert.equal(superseded.stopReason, 'superseded');
  assert.equal(superseded.supersededBy, 'run-2');

  const errored = projectRunEvents([
    {
      sequence: 0,
      type: 'run-settled',
      payload: {
        type: 'run-settled',
        status: 'errored',
        error: { code: 'ScriptError', message: 'boom' },
      },
    },
  ], { runId: 'run-1' });
  assert.equal(errored.status, 'errored');
  assert.equal(errored.error, 'boom');

  const unknown = projectRunEvents([
    { sequence: 0, type: 'run-settled', payload: { type: 'run-settled', status: 'teleported' } },
  ], { runId: 'run-1' });
  assert.equal(unknown.status, 'errored');
  assert.match(unknown.error, /unrecognized status/u);
});

test('ignored event types leave the snapshot unchanged apart from the watermark', () => {
  const run = scenario();
  run.apply('run-started', { caps: { maxConcurrency: 2 } });
  const before = run.state;
  for (const type of ['run-stalled', 'log', 'import-cache-closed']) {
    run.apply(type, { message: 'noise', instance: INSTANCE, cause: 'world-run' });
    const { lastEventSequence: _watermark, ...rest } = run.state;
    assert.deepEqual(rest, (({ lastEventSequence: _ignored, ...other }) => other)(before), `${type} must not change the snapshot`);
  }
});

test('all 26 event types are declared consumed or explicitly ignored', () => {
  assert.equal(WORKFLOW_EVENT_TYPES.length, 26);
  const ignored = ['run-stalled', 'log', 'import-cache-closed'];
  for (const type of WORKFLOW_EVENT_TYPES) {
    assert.equal(
      CONSUMED_EVENT_TYPES.has(type),
      !ignored.includes(type),
      `${type} consumption flag`,
    );
  }
});

test('bounded lists count evictions in unlistedByPhase (§3.5)', () => {
  const limits = { ...PROJECTION_LIMITS, maxActors: 2, maxNodes: 2 };
  let state = createRunState({ runId: 'run-1', lastEventSequence: 0 });
  let sequence = 1;
  const apply = (type, payload) => {
    state = applyWorkflowRunEvent(state, { sequence, type, payload: { type, ...payload } }, limits);
    sequence += 1;
    return state;
  };

  apply('run-launched', { phaseNames: ['alpha'] });
  for (let ordinal = 0; ordinal < 3; ordinal += 1) {
    apply('actor-created', {
      actor: { siteId: 'site-a', ordinal },
      name: `actor-${ordinal}`,
      phaseName: 'alpha',
    });
  }
  assert.equal(state.actors.length, 2);
  assert.equal(state.truncated, true);
  const bucket = state.unlistedByPhase.find((entry) => entry.phaseName === 'alpha');
  assert.ok(bucket !== undefined, 'the evicted actor must be accounted for');
  assert.equal(bucket.actors, 1);
});

test('reports and artifacts are capped and report previews are truncated', () => {
  const limits = {
    ...PROJECTION_LIMITS,
    maxReports: 1,
    maxArtifacts: 1,
    maxReportPreviewLength: 10,
  };
  let state = createRunState({ runId: 'run-1' });
  state = applyWorkflowRunEvent(state, {
    sequence: 0,
    type: 'artifact-published',
    payload: { type: 'artifact-published', artifact: { id: 'a', kind: 'markdown', version: 1 } },
  }, limits);
  state = applyWorkflowRunEvent(state, {
    sequence: 1,
    type: 'artifact-published',
    payload: { type: 'artifact-published', artifact: { id: 'b', kind: 'file', version: 1 } },
  }, limits);
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.truncated, true);

  state = applyWorkflowRunEvent(state, {
    sequence: 2,
    type: 'report',
    payload: { type: 'report', instance: INSTANCE, item: { long: 'x'.repeat(100) } },
  }, limits);
  assert.equal(state.reports[0].preview.length, 10);
  assert.equal(state.reports[0].preview.endsWith('\u2026'), true);
  state = applyWorkflowRunEvent(state, {
    sequence: 3,
    type: 'report',
    payload: { type: 'report', instance: { siteId: 'site-b', ordinal: 0 }, item: 'second' },
  }, limits);
  assert.equal(state.reports.length, 1);
});

test('duplicate events are idempotent and out-of-order events keep the watermark', () => {
  const actor = { siteId: 'actor-a', ordinal: 0 };
  let state = createRunState({ runId: 'run-1' });
  const event = { sequence: 4, type: 'actor-created', payload: { type: 'actor-created', actor, name: 'A' } };
  state = applyWorkflowRunEvent(state, event);
  state = applyWorkflowRunEvent(state, event);
  assert.equal(state.actors.length, 1);
  assert.equal(state.lastEventSequence, 4);
  const older = applyWorkflowRunEvent(state, {
    sequence: 2,
    type: 'actor-created',
    payload: { type: 'actor-created', actor: { siteId: 'actor-b', ordinal: 0 }, name: 'B' },
  });
  // 乱序事件仍会被折叠，但水位不能倒退；列表未截断时允许新增条目（§2.3 Xit 语义）。
  assert.equal(older.lastEventSequence, 4);
  assert.equal(older.actors.length, 2);
});

test('workflowRunSummary returns the §1.1(1) summary shape', () => {
  const summary = workflowRunSummary({
    runId: 'run-1',
    toolCallId: 'call-1',
    status: 'stopped',
    stopReason: 'user',
    resumedFrom: 'run-0',
    error: 'stopped by user',
  }, { label: 'Review changes', updatedAt: 1234 });
  assert.deepEqual(summary, {
    runId: 'run-1',
    toolCallId: 'call-1',
    label: 'Review changes',
    updatedAt: 1234,
    status: 'stopped',
    stopReason: 'user',
    resumedFrom: 'run-0',
    failureMessage: 'stopped by user',
    resumable: true,
  });
});
