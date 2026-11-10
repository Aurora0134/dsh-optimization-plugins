/**
 * facade 协议层单测：`__host` 的键集合、wire 错误形状、以及 cell 消息 → 引擎调用的路由。
 *
 * 这些用例不需要 vm：bridge 只依赖一个「引擎动作集合」的鸭子类型，所以用假引擎就能
 * 把每条消息的路由与应答逐条钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FACADE_GLOBALS, HOST_API_KEYS, createFacadeBridge, toWireError } from '../host/facade.js';

/** 收集 cell 收到的应答。 */
function makeCell() {
  const responses = [];
  return {
    responses,
    deliver: (response) => responses.push(response),
  };
}

/** 等一个 tick，让 bridge 的 promise 链把应答投递出来。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('facade 暴露的 __host 键集合与 §2 全集一致', () => {
  assert.deepEqual([...HOST_API_KEYS], [
    'args', 'run', 'createActor', 'ask', 'worldRead', 'publishArtifact', 'declareArtifact',
    'report', 'log', 'enterPhase', 'hole', 'channel', 'future',
  ]);
});

test('旧版 Workflow facade（parallel/pipeline/budget/workflow）不存在', () => {
  for (const absent of ['parallel', 'pipeline', 'budget', 'workflow', 'agentCall', 'schema']) {
    assert.equal(HOST_API_KEYS.includes(absent), false, `${absent} 不应出现在 __host 上`);
  }
  // 脚本可见的全局名里也没有旧 facade 的痕迹。
  assert.equal(FACADE_GLOBALS.includes('parallel'), false);
  assert.equal(FACADE_GLOBALS.includes('pipeline'), false);
  assert.equal(FACADE_GLOBALS.includes('budget'), false);
  assert.equal(FACADE_GLOBALS.includes('workflow'), false);
});

test('toWireError 保留脚本可分支的字段', () => {
  const plain = toWireError(new Error('boom'));
  assert.equal(plain.name, 'Error');
  assert.equal(plain.message, 'boom');

  const rich = Object.assign(new Error('invalid'), {
    name: 'WorkflowError',
    code: 'ValidationFailed',
    violations: [{ path: '$.ok', expected: 'a boolean', got: 'a string' }],
    finalText: 'not json',
  });
  const wire = toWireError(rich);
  assert.deepEqual(wire, {
    name: 'WorkflowError',
    message: 'invalid',
    code: 'ValidationFailed',
    violations: [{ path: '$.ok', expected: 'a boolean', got: 'a string' }],
    finalText: 'not json',
  });

  assert.deepEqual(toWireError('nope'), { name: 'Error', message: 'nope' });
});

test('bridge 把 create-actor / ask / world-read / publish-artifact 路由到引擎', async () => {
  const cell = makeCell();
  const calls = [];
  const engine = {
    createActor: (siteId, name, persona) => {
      calls.push(['createActor', siteId, name, persona]);
      return { siteId, ordinal: 1 };
    },
    ask: (siteId, actor, instructions) => {
      calls.push(['ask', siteId, actor, instructions]);
      return Promise.resolve({ verdict: 'ok' });
    },
    worldRead: (siteId, op, args) => {
      calls.push(['worldRead', siteId, op, args]);
      return Promise.resolve([{ path: 'a.ts', line: 1, text: 'x' }]);
    },
    publishArtifact: (siteId, op, args) => {
      calls.push(['publishArtifact', siteId, op, args]);
      return Promise.resolve({ id: args[0], version: 1 });
    },
    declareArtifact: (siteId, op, args) => calls.push(['declareArtifact', siteId, op, args]),
    report: (siteId, item, artifactId) => calls.push(['report', siteId, item, artifactId]),
    log: (message) => calls.push(['log', message]),
    enterPhase: (name) => calls.push(['enterPhase', name]),
    hole: (siteId, name, prompt) => {
      calls.push(['hole', siteId, name, prompt]);
      return Promise.resolve({ code: '(async () => ({ done: true }))' });
    },
    fail: (error) => calls.push(['fail', error]),
  };
  const bridge = createFacadeBridge({ engine, cell });

  bridge.handle({ kind: 'create-actor', localId: 'local#1', siteId: 'actor#1', name: 'reader', persona: undefined });
  bridge.handle({ kind: 'request', id: 'r1', type: 'ask', siteId: 'ask#1', actor: 'local#1', instructions: 'read it' });
  bridge.handle({ kind: 'request', id: 'r2', type: 'world-read', siteId: 'world-read#1', op: 'grep', args: ['x', '*.ts'] });
  bridge.handle({ kind: 'request', id: 'r3', type: 'publish-artifact', siteId: 'artifact#1', artifactOp: 'markdown', args: ['report', '# hi', { title: 'Report' }] });
  bridge.handle({ kind: 'event', type: 'log', message: 'working' });
  bridge.handle({ kind: 'event', type: 'phase-entered', name: 'look' });
  bridge.handle({ kind: 'event', type: 'report', siteId: 'report#1', item: { a: 1 }, artifactId: 'tiles' });
  bridge.handle({ kind: 'event', type: 'declare-artifact', siteId: 'artifact#2', op: 'metrics', args: ['tiles', { metrics: [{ field: 'n' }] }] });
  bridge.handle({ kind: 'request', id: 'r4', type: 'hole', siteId: 'hole#abc', name: 'decide', prompt: 'choose' });

  await flush();

  assert.deepEqual(calls[0], ['createActor', 'actor#1', 'reader', undefined]);
  assert.deepEqual(calls[1], ['ask', 'ask#1', { siteId: 'actor#1', ordinal: 1 }, 'read it']);
  assert.deepEqual(calls[2], ['worldRead', 'world-read#1', 'grep', ['x', '*.ts']]);
  assert.deepEqual(calls[3], ['publishArtifact', 'artifact#1', 'markdown', ['report', '# hi', { title: 'Report' }]]);
  assert.deepEqual(calls[4], ['log', 'working']);
  assert.deepEqual(calls[5], ['enterPhase', 'look']);
  assert.deepEqual(calls[6], ['report', 'report#1', { a: 1 }, 'tiles']);
  assert.deepEqual(calls[7], ['declareArtifact', 'artifact#2', 'metrics', ['tiles', { metrics: [{ field: 'n' }] }]]);
  assert.deepEqual(calls[8], ['hole', 'hole#abc', 'decide', 'choose']);

  const byId = new Map(cell.responses.map((response) => [response.id, response]));
  assert.equal(byId.get('r1').ok, true);
  assert.deepEqual(byId.get('r1').value, { verdict: 'ok' });
  assert.equal(byId.get('r2').ok, true);
  assert.equal(byId.get('r3').ok, true);
  assert.deepEqual(byId.get('r3').value, { id: 'report', version: 1 });
  assert.equal(byId.get('r4').ok, true);
});

test('bridge 对未知 actor / 未知请求类型返回结构化错误', async () => {
  const cell = makeCell();
  const bridge = createFacadeBridge({ engine: { createActor: () => ({ siteId: 'a', ordinal: 1 }) }, cell });
  bridge.handle({ kind: 'request', id: 'r1', type: 'ask', siteId: 'ask#1', actor: 'local#9', instructions: 'x' });
  bridge.handle({ kind: 'request', id: 'r2', type: 'mystery', siteId: 'x#1' });
  await flush();
  const byId = new Map(cell.responses.map((response) => [response.id, response]));
  assert.equal(byId.get('r1').ok, false);
  assert.equal(byId.get('r1').error.name, 'WorkflowError');
  assert.equal(byId.get('r1').error.code, 'UnknownActor');
  assert.equal(byId.get('r2').ok, false);
  assert.equal(byId.get('r2').error.code, 'UnknownRequest');
});

test('bridge 把 complete 交给 run 收尾处理器', () => {
  const cell = makeCell();
  const bridge = createFacadeBridge({ engine: {}, cell });
  const seen = [];
  bridge.setCompleteHandler((message) => seen.push(message));
  bridge.handle({ kind: 'complete', ok: true, value: { done: true } });
  bridge.handle({ kind: 'complete', ok: false, error: { name: 'ScriptStalled', message: 'stalled' } });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].ok, true);
  assert.equal(seen[1].error.name, 'ScriptStalled');
});
