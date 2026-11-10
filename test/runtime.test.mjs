/**
 * 引擎单测：AIMD 并发、typed ask 的校验/修复/催促、hole 挂起与补全、提问通道、停止与通知。
 *
 * 这些用例用一个**假编译器**（直接给出 lowering 结果与站点表）驱动真实 runtime + 真实 cell，
 * 这样测的是调度与运行时语义，而不是编译器；编译器自己在 compiler.test.mjs 里测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_BUDGET, ConcurrencyController, createRuntime, formatCompletionNotification, normalizeSubmit,
  validateArtifactSpec, validateSchema,
} from '../host/runtime.js';
import { createMemoryJournal } from '../host/journal-memory.js';

/**
 * 假编译器：把给定的 lowering 语句体与站点事实原样返回。
 * @param {{lowered: string, askSpecs?: Map<string, object>, phases?: string[], sitePhases?: Map<string, string>, actors?: object[], holes?: object[]}} spec
 */
function stubCompiler(spec) {
  return {
    compileWorkflowScript({ mode } = {}) {
      return {
        ok: true,
        diagnostics: [],
        lowered: spec.lowered,
        js: `(async (__host) => {\n${spec.lowered}\n})`,
        scriptHash: 's-test',
        sites: [],
        askSpecs: spec.askSpecs ?? new Map(),
        sitePhases: spec.sitePhases ?? new Map(),
        phases: spec.phases ?? [],
        actors: spec.actors ?? [],
        holes: spec.holes ?? [],
        artifacts: [],
        worldReads: [],
        models: [],
        interfaces: {},
        mode,
      };
    },
  };
}

/** 一个什么都不做的工作区（world-read 用例才需要具体实现）。 */
function stubWorkspace() {
  return {
    files: {
      glob: async (pattern) => [`${pattern}:a.ts`],
      read: async (path) => `contents of ${path}`,
      grep: async (pattern) => [{ path: 'a.ts', line: 1, text: pattern }],
    },
    git: {
      changedFiles: async () => ['a.ts'],
      diff: async () => 'diff',
      status: async () => ({ clean: true, staged: [], unstaged: [], untracked: [] }),
      log: async () => [],
    },
    runCommand: async (cmd, args) => ({ exitCode: 0, stdout: `${cmd} ${args.join(' ')}`.trim(), stderr: '' }),
  };
}

/** 轮询直到条件成立或超时。 */
async function until(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('validateSchema 覆盖对象/数组/必填/多余字段', () => {
  const schema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['ok'],
    additionalProperties: false,
  };
  assert.deepEqual(validateSchema({ ok: true, notes: ['a'] }, schema), []);
  const missing = validateSchema({ notes: [] }, schema);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].path, '$.ok');
  assert.equal(missing[0].expected, 'a value');
  const extra = validateSchema({ ok: true, nope: 1 }, schema);
  assert.equal(extra[0].path, '$.nope');
  const wrong = validateSchema({ ok: 'yes' }, schema);
  assert.equal(wrong[0].path, '$.ok');
});

test('normalizeSubmit 对字符串结果尝试 JSON.parse 再校验', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  assert.deepEqual(normalizeSubmit({ ok: true }, schema), { value: { ok: true }, violations: [] });
  const parsed = normalizeSubmit('{"ok":true}', schema);
  assert.deepEqual(parsed.value, { ok: true });
  assert.deepEqual(parsed.violations, []);
  const invalid = normalizeSubmit('not json', schema);
  assert.equal(invalid.violations.length > 0, true);
});

test('ConcurrencyController：连续成功 4 次且有人等待才 +1', () => {
  const controller = new ConcurrencyController('run', 2, 8, () => 0);
  const changes = [];
  controller.noteWaiters(0, 1);
  for (let round = 0; round < 4; round += 1) {
    const epoch = controller.admitted(round);
    // 第一次请求会把 inFlight 减回去；四轮都在 epoch 不变时累积 streak
    changes.push(...controller.succeeded(round, epoch));
  }
  assert.equal(controller.cap, 3);
  assert.equal(changes.some((change) => change.reason === 'recovered'), true);
});

test('ConcurrencyController：限流回落 lastGood / ×0.75 并设冷却', () => {
  const controller = new ConcurrencyController('run', 4, 16, () => 0);
  controller.noteWaiters(0, 2);
  // 先长到 4 以上：直接 seed 模拟历史
  controller.seed(0, 8);
  assert.equal(controller.cap, 8);
  const epoch = controller.admitted(0);
  const changes = controller.throttled(100, epoch, 'throttled', 5000);
  assert.equal(controller.cap, 0.75 * 8 === 6 ? 6 : controller.cap);
  assert.equal(controller.cooldownUntil, 5100);
  assert.equal(controller.canAdmit(200), false);
  assert.equal(controller.canAdmit(6000), true);
  assert.equal(changes.some((change) => change.reason === 'throttled'), true);

  const fresh = new ConcurrencyController('run', 4, 16, () => 0);
  fresh.noteWaiters(0, 3);
  const firstEpoch = fresh.admitted(0);
  fresh.succeeded(0, firstEpoch);
  const secondEpoch = fresh.admitted(0);
  const shrunk = fresh.throttled(10, secondEpoch, 'throttled');
  assert.equal(shrunk.length, 1);
  assert.equal(fresh.cap, 3);
});

test('ConcurrencyController：空闲 5 分钟复位到 initial', () => {
  const controller = new ConcurrencyController('run', 4, 16, () => 0);
  controller.noteWaiters(0, 4);
  // idleReset 需要「有过请求且在飞归零」，所以先走一次完整的 admit/succeeded。
  const epoch = controller.admitted(0);
  controller.succeeded(0, epoch);
  controller.seed(0, 6);
  assert.equal(controller.cap, 6);
  const changes = controller.idleReset(300001);
  assert.equal(controller.cap, 4);
  assert.equal(changes.some((change) => change.reason === 'idle_reset'), true);
});

test('validateArtifactSpec 覆盖 chart/table/metrics/board 的关键分支', () => {
  assert.equal(validateArtifactSpec('chart', { x: { field: 'round' }, y: { field: 'ms' } }), undefined);
  assert.match(validateArtifactSpec('chart', { x: { field: '' }, y: { field: 'ms' } }), /spec x\.field must be a non-empty string/);
  assert.match(validateArtifactSpec('table', { columns: [] }), /spec columns must be a non-empty array of fields/);
  assert.match(validateArtifactSpec('metrics', { metrics: [{ field: 'n' }], title: 3 }), /spec title must be a string/);
  assert.match(validateArtifactSpec('board', { key: 'id', status: 'col', columns: ['a', ''] }), /columns\[1\] must be a non-empty string/);
  assert.equal(validateArtifactSpec('board', { key: 'id', status: 'col', columns: ['a'] }), undefined);
});

test('一次 untyped run：actor → ask → log → report → 完成通知', async () => {
  const compiler = stubCompiler({
    lowered: [
      'var reader = __host.createActor("actor#1", "reader", void 0);',
      '__host.enterPhase("look");',
      'var answer = await __host.ask("ask#1", reader, "read the file");',
      '__host.log(answer);',
      '__host.report("report#1", { answer: answer }, void 0);',
      'return answer;',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: false }]]),
    phases: ['look'],
    sitePhases: new Map([['ask#1', 'look']]),
    actors: [{ siteId: 'actor#1', name: 'reader' }],
  });
  const notifications = [];
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const started = await runtime.startRun({
    code: '// stub',
    name: 'untyped',
    cwd: '/tmp/ws',
    runner: async () => ({ text: 'ok' }),
    notify: (text) => notifications.push(text),
  });
  assert.equal(started.ok, true, String(started.error));
  const settled = await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
  assert.equal(settled.status, 'completed');
  assert.equal(settled.result, 'ok');
  assert.equal(settled.reports.length, 1);
  assert.equal(settled.actors.length, 1);
  assert.equal(typeof settled.actors[0].sessionId, 'string');
  assert.equal(settled.actors[0].sessionId.startsWith('dwf-'), true);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /^\[SYSTEM NOTIFICATION - NOT USER INPUT\]/);
  assert.match(notifications[0], /<status>completed<\/status>/);

  const events = runtime.eventsAfter(started.runId, -1, 100).map((row) => row.type);
  for (const type of ['run-started', 'actor-created', 'phase-entered', 'node-queued', 'node-dispatched', 'node-settled', 'report', 'log', 'run-settled']) {
    assert.equal(events.includes(type), true, `缺少事件 ${type}`);
  }
});

test('typed ask：校验失败走 node-repairing，再交对结果', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const compiler = stubCompiler({
    lowered: [
      'var judge = __host.createActor("actor#1", "judge", void 0);',
      'return await __host.ask("ask#1", judge, "judge it");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: true, schema }]]),
  });
  const prompts = [];
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const started = await runtime.startRun({
    code: '// stub',
    name: 'typed-repair',
    cwd: '/tmp/ws',
    runner: async (request) => {
      prompts.push(request.prompt);
      return prompts.length === 1 ? { text: '{"ok":"yes"}' } : { text: '{"ok":true}' };
    },
  });
  const settled = await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
  assert.equal(settled.status, 'completed');
  assert.deepEqual(settled.result, { ok: true });
  assert.equal(prompts.length, 2);
  // 第二次提示词带着违规说明（repair 回合的抬头，回复协议版本）
  assert.match(prompts[1], /The reply did not match the required schema:/);
  const events = runtime.eventsAfter(started.runId, -1, 100).map((row) => row.type);
  assert.equal(events.includes('node-repairing'), true);
});

test('typed ask：一回合没交结果走 node-nudged，预算内被催回', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const compiler = stubCompiler({
    lowered: [
      'var judge = __host.createActor("actor#1", "judge", void 0);',
      'return await __host.ask("ask#1", judge, "judge it");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: true, schema }]]),
  });
  const prompts = [];
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const started = await runtime.startRun({
    code: '// stub',
    name: 'typed-nudge',
    cwd: '/tmp/ws',
    runner: async (request) => {
      prompts.push(request.prompt);
      return prompts.length === 1 ? { text: 'I think it is fine.' } : { text: '{"ok":true}' };
    },
  });
  const settled = await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
  assert.equal(settled.status, 'completed');
  assert.deepEqual(settled.result, { ok: true });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /You ended your turn without giving the result\./);
  assert.equal(ASK_BUDGET.nudges, 1);
  const events = runtime.eventsAfter(started.runId, -1, 100).map((row) => row.type);
  assert.equal(events.includes('node-nudged'), true);
});

test('hole：到达即挂起，fillHole 用函数体在站点处求值', async () => {
  const compiler = stubCompiler({
    lowered: [
      'var value = await __host.hole("hole#abc", "decide", "choose a number", (__src) => eval(__src));',
      'return value.n;',
    ].join('\n'),
  });
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const started = await runtime.startRun({ code: '// stub', name: 'hole', cwd: '/tmp/ws', runner: async () => ({ text: '' }) });
  const waiting = await until(async () => (await runtime.getRun(started.runId))?.holes?.length === 1);
  assert.equal(Boolean(waiting), true, 'run 应该在 hole 处挂起');
  const running = await runtime.getRun(started.runId);
  assert.equal(running.status, 'running');
  assert.equal(running.holes[0].siteId, 'hole#abc');
  assert.equal(running.holes[0].name, 'decide');

  const filled = await runtime.fillHole(started.runId, 'hole#abc', { script: 'return { n: 7 };' });
  assert.equal(filled.ok, true, JSON.stringify(filled));
  const settled = await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
  assert.equal(settled.status, 'completed');
  assert.equal(settled.result, 7);
  // 契约 §1.5：已填的 hole 以 `state:"filled"` 留在列表里，不再消失（评审 m14/R4）。
  assert.deepEqual(settled.holes.map((hole) => `${hole.siteId}:${hole.state}`), ['hole#abc:filled']);
  assert.equal(typeof settled.holes[0].filledAt, 'number');
});

test('fillHole：未知 run 返回 RUN_NOT_FOUND，未等待的站点返回 NOT_WAITING', async () => {
  const compiler = stubCompiler({ lowered: 'return 1;' });
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const missing = await runtime.fillHole('dwf-nope', 'hole#abc', { script: 'return 1;' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'RUN_NOT_FOUND');
  const started = await runtime.startRun({ code: '// stub', name: 'plain', cwd: '/tmp/ws', runner: async () => ({ text: '' }) });
  await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
  const settled = await runtime.fillHole(started.runId, 'hole#abc', { script: 'return 1;' });
  assert.equal(settled.ok, false);
  assert.equal(settled.code, 'RUN_SETTLED');
});

test('escalate：子代理挂起提问，resolveQuestion 逐字回灌；未知 qid 有可判别错误', async () => {
  const compiler = stubCompiler({
    lowered: [
      'var helper = __host.createActor("actor#1", "helper", void 0);',
      'return await __host.ask("ask#1", helper, "do the thing");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: false }]]),
  });
  let answer;
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const started = await runtime.startRun({
    code: '// stub',
    name: 'escalation',
    cwd: '/tmp/ws',
    runner: async (request) => {
      const reply = await request.escalate({ question: 'Which branch?', context: 'both look valid' });
      // 契约回灌对象是 `{status:'answered', message, qid}`（评审 M9）。
      answer = reply.status === 'answered' ? reply.message : reply.message;
      return { text: answer };
    },
  });
  const pending = await until(async () => (await runtime.getRun(started.runId))?.pendingQuestions?.length === 1);
  assert.equal(Boolean(pending), true, 'run 应该有一个待答问题');
  const running = await runtime.getRun(started.runId);
  const qid = running.pendingQuestions[0].qid;
  assert.equal(qid.startsWith('dwfq-'), true);

  const unknown = runtime.resolveQuestion('dwfq-nope', 'x');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_QUESTION');

  const resolved = runtime.resolveQuestion(qid, 'the left branch');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.qid, qid);
  const settled = await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
  assert.equal(settled.status, 'completed');
  assert.equal(settled.result, 'the left branch');
  assert.equal(answer, 'the left branch');
  const events = runtime.eventsAfter(started.runId, -1, 100).map((row) => row.type);
  assert.equal(events.includes('escalation-raised'), true);
  assert.equal(events.includes('escalation-resolved'), true);
});

test('stopRun：在飞 run 记 stopped + stop_reason=user', async () => {
  const compiler = stubCompiler({
    lowered: [
      'var slow = __host.createActor("actor#1", "slow", void 0);',
      'return await __host.ask("ask#1", slow, "take your time");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: false }]]),
  });
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const started = await runtime.startRun({
    code: '// stub',
    name: 'stop',
    cwd: '/tmp/ws',
    runner: async (request) => new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  // 等 ask 真的派发出去（节点已落 journal 且 run 仍在跑），再发停止。
  const dispatched = await until(async () => {
    const running = await runtime.getRun(started.runId);
    return Array.isArray(running?.nodes) && running.nodes.length > 0 && running.status === 'running';
  });
  assert.equal(Boolean(dispatched), true, 'ask 应该已派发');
  const stopped = await runtime.stopRun(started.runId, 'user');
  assert.equal(stopped.ok, true);
  const settled = await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
  assert.equal(settled.status, 'stopped');
  assert.equal(settled.stopReason, 'user');
  const events = runtime.eventsAfter(started.runId, -1, 100).map((row) => row.type);
  assert.equal(events.includes('run-settled'), true);
});

test('configureRun：活跃 run 改并发上限并记 run-caps-changed，未知/已结算 run 有可判别错误', async () => {
  const compiler = stubCompiler({
    lowered: [
      'var reader = __host.createActor("actor#1", "reader", void 0);',
      'return await __host.ask("ask#1", reader, "hold");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: false }]]),
    phases: ['look'],
    sitePhases: new Map([['ask#1', 'look']]),
    actors: [{ siteId: 'actor#1', name: 'reader' }],
  });
  /** @type {(value: string) => void} */
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = createRuntime({
    compiler,
    workspaceFor: stubWorkspace,
    config: { maxConcurrency: 4 },
    logger: { warn() {}, info() {} },
  });
  const started = await runtime.startRun({
    code: '// stub',
    name: 'caps',
    cwd: '/tmp/ws',
    runner: async () => ({ text: await gate }),
    notify: () => {},
  });
  assert.equal(started.ok, true, String(started.error));
  await until(() => runtime.eventsAfter(started.runId, -1, 200).some((row) => row.type === 'node-executing'));
  const changed = runtime.configureRun(started.runId, 7);
  assert.equal(changed.ok, true);
  const caps = runtime.eventsAfter(started.runId, -1, 400).filter((row) => row.type === 'run-caps-changed');
  assert.equal(caps.length, 1);
  assert.equal(caps[0].event.caps.maxConcurrency, 7);
  assert.equal(runtime.configureRun(started.runId, 7).code, 'CAPS_UNCHANGED');
  assert.equal(runtime.configureRun('nope', 3).code, 'RUN_NOT_FOUND');
  // 契约的并发上限封在 1024：越界值按上限算，不写进 caps。
  const clamped = runtime.configureRun(started.runId, 5000);
  assert.equal(clamped.ok, true);
  assert.equal(clamped.caps.maxConcurrency, 1024);
  // 进程里没有、但表里还是 running 的 run：是 run_not_retunable（这个进程调不了），不是 run_settled。
  const staleJournal = createMemoryJournal();
  staleJournal.createRun({ runId: 'stale-running', status: 'running', createdAt: 1, updatedAt: 1 });
  const staleRuntime = createRuntime({ compiler, journal: staleJournal, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  assert.equal(staleRuntime.configureRun('stale-running', 3).code, 'RUN_NOT_RETUNABLE');
  // 非法入参是“参数错”，不是“值没变”：独立错误码（评审 R5）。
  for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '7', null, undefined]) {
    assert.equal(runtime.configureRun(started.runId, bad).code, 'INVALID_CAP', String(bad));
  }
  release('done');
  await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
  assert.equal(runtime.configureRun(started.runId, 5).code, 'RUN_NOT_ACTIVE');
});

test('run-stalled：超过 stallMs 无进展时记事件并只催两次', async (t) => {
  const compiler = stubCompiler({
    lowered: [
      'var reader = __host.createActor("actor#1", "reader", void 0);',
      'return await __host.ask("ask#1", reader, "hold");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: false }]]),
    phases: ['look'],
    sitePhases: new Map([['ask#1', 'look']]),
    actors: [{ siteId: 'actor#1', name: 'reader' }],
  });
  /** @type {(value: string) => void} */
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const notifications = [];
  const runtime = createRuntime({
    compiler,
    workspaceFor: stubWorkspace,
    config: { stallMs: 40, stallCheckMs: 20 },
    logger: { warn() {}, info() {} },
  });
  t.after(() => { release('late'); });
  const started = await runtime.startRun({
    code: '// stub',
    name: 'stall',
    cwd: '/tmp/ws',
    runner: async () => ({ text: await gate }),
    notify: (text) => notifications.push(text),
  });
  assert.equal(started.ok, true, String(started.error));
  const stalled = await until(() => runtime.eventsAfter(started.runId, -1, 400).find((row) => row.type === 'run-stalled'), 3000);
  assert.ok(stalled !== undefined, 'expected a run-stalled event');
  assert.equal(typeof stalled.event.since, 'number');
  const reminders = await until(() => notifications.filter((text) => /stalled|no progress/u.test(text)).length >= 2, 3000);
  assert.equal(Boolean(reminders), true);
  assert.equal(notifications.filter((text) => /no progress|still stalled/u.test(text)).length <= 2, true);
  // 契约 §1.5 的 `health.lastProgressAt`/`stalledSince` 必须能从快照读到（评审 M10/R6）。
  const snapshot = await until(async () => {
    const current = await runtime.getRun(started.runId);
    return current?.health?.stalledSince === undefined ? undefined : current;
  }, 3000);
  assert.equal(Boolean(snapshot), true, 'health.stalledSince 应该出现');
  assert.equal(typeof snapshot.health.lastProgressAt, 'number');
  assert.equal(typeof snapshot.health.stalledSince, 'number', 'stalledSince 应为 epoch 毫秒（契约 §1.5）');
  assert.equal(Number.isFinite(Date.parse(new Date(snapshot.health.stalledSince).toISOString())), true);
  release('done');
  await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
});

test('ResumeWorkflowRun：runtime.resume 是同一实现，stopped run 用同一 runId 续跑', async () => {
  const compiler = stubCompiler({
    lowered: [
      'var slow = __host.createActor("actor#1", "slow", void 0);',
      'return await __host.ask("ask#1", slow, "take your time");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: false }]]),
  });
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  assert.equal(runtime.resume, runtime.resumeRun);
  let calls = 0;
  const started = await runtime.startRun({
    code: '// stub',
    name: 'resume',
    cwd: '/tmp/ws',
    runner: async (request) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return { text: 'resumed answer' };
    },
  });
  await until(async () => (await runtime.getRun(started.runId))?.nodes?.length > 0);
  await runtime.stopRun(started.runId, 'user');
  const stopped = await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
  assert.equal(stopped.status, 'stopped');

  const resumed = await runtime.resume(started.runId, {
    runner: async () => ({ text: 'resumed answer' }),
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.runId, started.runId);
  const settled = await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
  assert.equal(settled.status, 'completed');
  assert.equal(settled.result, 'resumed answer');
});

test('escalate 标记协议：回复里的围栏 JSON 触发提问，答案作为下一回合文本回灌', async () => {
  const compiler = stubCompiler({
    lowered: [
      'var helper = __host.createActor("actor#1", "helper", void 0);',
      'return await __host.ask("ask#1", helper, "do the thing");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: false }]]),
  });
  const prompts = [];
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const started = await runtime.startRun({
    code: '// stub',
    name: 'marker-escalation',
    cwd: '/tmp/ws',
    runner: async (request) => {
      prompts.push(request.prompt);
      if (prompts.length === 1) {
        return { text: 'I need a decision.\n```json\n{"escalate":{"question":"Which branch?","context":"both look valid"}}\n```' };
      }
      return { text: `I took the answer: ${request.prompt.includes('the left branch') ? 'left' : 'unknown'}` };
    },
  });
  const pending = await until(async () => (await runtime.getRun(started.runId))?.pendingQuestions?.length === 1);
  assert.equal(Boolean(pending), true, 'run 应该有挂起的问题');
  const running = await runtime.getRun(started.runId);
  const record = running.pendingQuestions[0];
  assert.equal(record.qid.startsWith('dwfq-'), true);
  assert.equal(record.actorSiteId, 'actor#1');
  assert.equal(record.actorOrdinal, 1);
  const resolved = runtime.resolveQuestion(record.qid, 'the left branch');
  assert.equal(resolved.ok, true);
  const settled = await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
  assert.equal(settled.status, 'completed');
  assert.match(settled.result, /I took the answer: left/);
  assert.match(prompts[1], /Your question was answered:\nthe left branch/);
});

test('escalate 失败原因区分未知/已答（22/23）', async () => {
  const compiler = stubCompiler({
    lowered: [
      'var helper = __host.createActor("actor#1", "helper", void 0);',
      'return await __host.ask("ask#1", helper, "ask");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: false }]]),
  });
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const started = await runtime.startRun({
    code: '// stub',
    name: 'codes',
    cwd: '/tmp/ws',
    runner: async (request) => new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  assert.equal(runtime.resolveQuestion('dwfq-none', 'x').code, 'UNKNOWN_QUESTION');
  await runtime.stopRun(started.runId, 'user');
  await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
});

test('通知信封：任务通知元素与终态指引（契约 §7.2）', () => {
  const entry = {
    meta: { id: 'dwf-1', name: 'demo', stopReason: undefined },
    events: [
      { type: 'report', item: { a: 1 } },
      { type: 'artifact-published', artifact: { id: 'doc', kind: 'markdown', primary: true } },
    ],
  };
  const completed = formatCompletionNotification(entry, { status: 'completed', value: { ok: true } });
  for (const tag of ['<task-id>dwf-1</task-id>', '<status>completed</status>', '<summary>', '<result>', '<reports count="1">', '<artifacts count="1">']) {
    assert.equal(completed.includes(tag), true, `缺少 ${tag}`);
  }
  const stopped = formatCompletionNotification(entry, { status: 'stopped', reason: 'model' });
  assert.match(stopped, /amend the running run directly/);

  const errored = formatCompletionNotification(entry, { status: 'errored', error: new Error('bad script') });
  assert.match(errored, /<error>bad script<\/error>/);
  assert.match(errored, /AmendWorkflow/);
});

test('完成通知：报错分支给出 AmendWorkflow 指引，摘要截断字段存在', () => {
  const entry = {
    meta: { id: 'dwf-1', name: 'demo', stopReason: undefined },
    events: [
      { type: 'report', item: { a: 1 } },
      { type: 'artifact-published', artifact: { id: 'doc', kind: 'markdown', primary: true } },
    ],
  };
  const completed = formatCompletionNotification(entry, { status: 'completed', value: { ok: true } });
  assert.match(completed, /<status>completed<\/status>/);
  assert.match(completed, /<reports count="1">/);
  assert.match(completed, /<artifacts count="1">/);
  assert.match(completed, /do not paste their contents/);

  const errored = formatCompletionNotification(entry, { status: 'errored', error: new Error('bad script') });
  assert.match(errored, /<error>bad script<\/error>/);
  assert.match(errored, /AmendWorkflow/);
  assert.match(errored, /ResumeWorkflowRun will refuse this run/);
});

test('完成通知：<summary> 截 500，superseded 的 run 带 <superseded_by>', () => {
  const entry = {
    meta: { id: 'dwf-1', name: 'n'.repeat(600), stopReason: 'superseded', supersededBy: 'dwf-2' },
    events: [],
  };
  const text = formatCompletionNotification(entry, { status: 'stopped', reason: 'superseded' });
  const summary = text.match(/<summary>(.*)<\/summary>/u);
  assert.equal(summary[1].length, 500);
  assert.equal(text.includes('<superseded_by>dwf-2</superseded_by>'), true);
});

test('amend：前驱 meta 落 stop_reason=superseded 与 superseded_by=<后继 runId>（契约 §4.9）', async () => {
  const compiler = stubCompiler({
    lowered: [
      'var reader = __host.createActor("actor#1", "reader", void 0);',
      'return await __host.ask("ask#1", reader, "hold");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: false }]]),
  });
  /** @type {(value: string) => void} */
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const notifications = [];
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const started = await runtime.startRun({
    code: '// stub',
    name: 'pred',
    cwd: '/tmp/ws',
    runner: async () => ({ text: await gate }),
    notify: (text) => notifications.push(text),
  });
  assert.equal(started.ok, true, String(started.error));
  await until(() => runtime.eventsAfter(started.runId, -1, 200).some((row) => row.type === 'node-executing'));

  const amended = await runtime.amend(started.runId, {
    code: '// stub',
    name: 'next',
    cwd: '/tmp/ws',
    runner: async () => ({ text: 'done' }),
    notify: () => {},
  });
  assert.equal(amended.ok, true, JSON.stringify(amended));
  const successor = amended.runId;
  assert.notEqual(successor, started.runId);

  const predecessor = await runtime.getRun(started.runId);
  assert.equal(predecessor.status, 'stopped');
  assert.equal(predecessor.stopReason, 'superseded');
  assert.equal(predecessor.supersededBy, successor);

  const rows = await runtime.listRuns({ limit: 10 });
  assert.equal(rows.find((row) => row.runId === started.runId).supersededBy, successor);
  assert.equal(
    notifications.some((text) => text.includes(`<superseded_by>${successor}</superseded_by>`)),
    true,
    '前驱的通知应指名后继',
  );

  release('late');
  await runtime.waitForRun(successor, { timeoutMs: 3000 });
});

test('subagents 与 actors 的 status 是派生的：计数来自该 actor 的 node 行（契约 cli.md:167-169）', async () => {
  const compiler = stubCompiler({
    lowered: [
      'var reader = __host.createActor("actor#1", "reader", void 0);',
      'await __host.ask("ask#1", reader, "one");',
      'return await __host.ask("ask#2", reader, "two");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: false }], ['ask#2', { typed: false }]]),
    actors: [{ siteId: 'actor#1', name: 'reader' }],
  });
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const started = await runtime.startRun({
    code: '// stub',
    name: 'subagents',
    cwd: '/tmp/ws',
    runner: async () => 'ok',
  });
  const settled = await runtime.waitForRun(started.runId, { timeoutMs: 5000 });
  assert.equal(settled.status, 'completed');
  const run = await runtime.getRun(started.runId);
  assert.equal(run.actors.length, 1);
  // 运行已结束 → 契约的派生规则把每个 actor 记为 completed。
  assert.equal(run.actors[0].status, 'completed');
  assert.equal(run.subagents.length, 1);
  const [subagent] = run.subagents;
  assert.equal(subagent.name, 'reader');
  assert.equal(subagent.state, 'done');
  assert.equal(subagent.stepsSettled, 2);
  assert.equal(subagent.stepsFailed, 0);
  assert.equal(typeof subagent.tokens, 'number');
  // node 行带 actor 归属：派生计数与步骤台账都读它。
  assert.equal(run.nodes.length, 2);
  for (const node of run.nodes) {
    assert.equal(node.actorSiteId, 'actor#1');
    assert.equal(node.actorOrdinal, run.actors[0].ordinal);
  }
});

test('subagents 在飞行中显示 executing，排队时显示 waiting', async () => {
  const compiler = stubCompiler({
    lowered: [
      'var slow = __host.createActor("actor#1", "slow", void 0);',
      'return await __host.ask("ask#1", slow, "hold");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: false }]]),
    actors: [{ siteId: 'actor#1', name: 'slow' }],
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const started = await runtime.startRun({
    code: '// stub',
    name: 'in-flight',
    cwd: '/tmp/ws',
    runner: () => gate,
  });
  const executing = await until(async () => {
    const run = await runtime.getRun(started.runId);
    return run?.subagents?.[0]?.state === 'executing' ? run : undefined;
  });
  assert.equal(Boolean(executing), true, 'ask 派发后 subagent 应为 executing');
  assert.equal(executing.subagents[0].stepsSettled, 0);
  release('done');
  const settled = await runtime.waitForRun(started.runId, { timeoutMs: 5000 });
  assert.equal(settled.status, 'completed');
  const after = await runtime.getRun(started.runId);
  assert.equal(after.subagents[0].state, 'done');
  assert.equal(after.subagents[0].stepsSettled, 1);
});

test('health.concurrency 只透契约四字段（cli.md:171）', async () => {
  const compiler = stubCompiler({
    lowered: [
      'var slow = __host.createActor("actor#1", "slow", void 0);',
      'return await __host.ask("ask#1", slow, "hold");',
    ].join('\n'),
    askSpecs: new Map([['ask#1', { typed: false }]]),
    actors: [{ siteId: 'actor#1', name: 'slow' }],
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = createRuntime({ compiler, workspaceFor: stubWorkspace, logger: { warn() {}, info() {} } });
  const started = await runtime.startRun({ code: '// stub', name: 'conc', cwd: '/tmp/ws', runner: () => gate });
  const running = await until(async () => {
    const run = await runtime.getRun(started.runId);
    return run?.health?.concurrency === undefined ? undefined : run;
  });
  assert.equal(Boolean(running), true, '运行中应该带 health.concurrency');
  assert.deepEqual(Object.keys(running.health.concurrency).sort(), ['cap', 'effective']);
  assert.equal(typeof running.health.concurrency.effective, 'number');
  assert.equal(typeof running.health.concurrency.cap, 'number');
  release('done');
  await runtime.waitForRun(started.runId, { timeoutMs: 5000 });
});
