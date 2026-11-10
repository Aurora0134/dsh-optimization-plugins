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
  // 第二次提示词带着违规说明（submit_result 的返回形状）
  assert.match(prompts[1], /The submitted result does not match the required schema:/);
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
  assert.match(prompts[1], /You ended your turn without submitting a result\./);
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
  assert.equal(settled.holes.length, 0);
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
      answer = reply.status === 'answered' ? reply.answer : reply.message;
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
  await until(async () => (await runtime.getRun(started.runId))?.nodes?.[0]?.phase !== undefined || true);
  const stopped = await runtime.stopRun(started.runId, 'user');
  assert.equal(stopped.ok, true);
  const settled = await runtime.waitForRun(started.runId, { timeoutMs: 3000 });
  assert.equal(settled.status, 'stopped');
  assert.equal(settled.stopReason, 'user');
  const events = runtime.eventsAfter(started.runId, -1, 100).map((row) => row.type);
  assert.equal(events.includes('run-settled'), true);
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
