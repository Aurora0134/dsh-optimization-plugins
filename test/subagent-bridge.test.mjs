import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentRunner } from '../host/subagent.js';

const quietLogger = { warn() {} };

/**
 * 只实现 DSH 声明面（dsh-subagent/lib/typert.host.js 的方法表）的假 subagents 服务：
 * 有 getProvider(name) 与 startActivation(spec)，没有 list()。
 * 假服务按 index.js:3060 / manager 的真实前置条件校验 spec，而不是打桩放过，
 * 这样桥漏传 parent / signal 时测试会失败，而不是被假服务掩盖。
 */
function declaredSurface({ providers = ['spawn'], result, childId = 'child-1' } = {}) {
  const calls = [];
  let disposed = 0;
  return {
    calls,
    get disposed() {
      return disposed;
    },
    getProvider(name) {
      if (!providers.includes(name)) return undefined;
      return {
        name,
        capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
        inheritsParentContext: false,
        prepareContinuable: async () => ({}),
      };
    },
    async startActivation(spec) {
      assert.equal(typeof spec.request?.parent?.id, 'string', 'request.parent 必须是活 Agent（index.js:3060 的前置条件）');
      assert.equal(typeof spec.signal?.throwIfAborted, 'function', 'spec.signal 必须是 AbortSignal（manager 无条件使用）');
      assert.equal(typeof spec.label, 'string', 'label 必填');
      assert.ok(spec.delivery === 'caller' || spec.delivery === 'parent', 'delivery 必填');
      calls.push(spec);
      return {
        childId,
        result: Promise.resolve(result ?? { output: [{ type: 'text', text: 'PONG' }], stopReason: 'completed' }),
        dispose: async () => {
          disposed += 1;
        },
      };
    },
  };
}

const runnerFor = (subagents, config = {}) => createSubagentRunner({
  ctx: { get: (key) => (key === 'subagents' ? subagents : undefined) },
  config,
  logger: quietLogger,
});

test('provider 未注册时抛可读错误，且不依赖枚举 provider（无 list()）', async () => {
  const subagents = declaredSurface({ providers: ['spawn'] });
  const run = runnerFor(subagents, { subagentProvider: 'missing-provider' });
  await assert.rejects(
    () => run({ parent: { id: 'sess-1' }, prompt: 'ping', actor: { name: 'probe' } }),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(!/is not a function/.test(message), `不应把缺少方法当作失败原因: ${message}`);
      // "unavailable:" 里的 available 不算枚举；这里拦住的是旧文案的 "available: a, b, none"。
      assert.ok(!/available:/.test(message.replaceAll('unavailable', '')), `不应枚举已注册 provider: ${message}`);
      assert.ok(message.includes('missing-provider'), `应点名缺失的 provider: ${message}`);
      assert.match(message, /not registered|unavailable/i, `应是可读的不可用错误: ${message}`);
      return true;
    },
  );
  assert.equal(subagents.calls.length, 0, '未注册的 provider 不应该被启动');
});

test('服务不暴露 getProvider 时不硬拦（版本漂移兜底），由 startActivation 决定', async () => {
  const calls = [];
  const subagents = {
    async startActivation(spec) {
      assert.equal(typeof spec.request?.parent?.id, 'string');
      assert.equal(typeof spec.signal?.throwIfAborted, 'function');
      calls.push(spec);
      return { childId: 'child-1', result: Promise.resolve({ output: [{ type: 'text', text: 'PONG' }], stopReason: 'completed' }), dispose: async () => {} };
    },
  };
  const warnings = [];
  const run = createSubagentRunner({
    ctx: { get: (key) => (key === 'subagents' ? subagents : undefined) },
    config: {},
    logger: { warn: (line) => warnings.push(line) },
  });
  const answer = await run({ parent: { id: 'sess-1' }, prompt: 'ping', actor: { name: 'probe' } });
  assert.equal(answer.text, 'PONG');
  assert.equal(calls.length, 1);
  assert.match(warnings.join('\n'), /getProvider/);
});

test('parent 缺失时先抛可读错误（不是 TypeError，也不是启动失败）', async () => {
  const subagents = declaredSurface();
  const run = runnerFor(subagents);
  await assert.rejects(
    () => run({ prompt: 'ping', actor: { name: 'probe' } }),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(!(error instanceof TypeError), '不应泄漏 TypeError');
      assert.ok(!/is not a function|cannot read propert/i.test(message), `不应泄漏 JS 运行时错误: ${message}`);
      assert.ok(!/could not start/i.test(message), `应在启动前就拒绝: ${message}`);
      assert.match(message, /parent/i, `应说明缺少父会话: ${message}`);
      assert.match(message, /workflow subagent/i, `应点名是谁: ${message}`);
      return true;
    },
  );
  assert.equal(subagents.calls.length, 0);
});

test('parent 不是活 Agent（非对象）时同样抛可读错误', async () => {
  const subagents = declaredSurface();
  const run = runnerFor(subagents);
  for (const parent of ['sess-1', 42, null]) {
    await assert.rejects(
      () => run({ parent, prompt: 'ping' }),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(!(error instanceof TypeError));
        assert.match(message, /parent/i);
        assert.equal(subagents.calls.length, 0);
        return true;
      },
    );
  }
});

test('signal 缺失时桥自己兜底 AbortSignal，activation 仍能启动', async () => {
  const subagents = declaredSurface();
  const run = runnerFor(subagents);
  const answer = await run({ parent: { id: 'sess-1' }, prompt: 'ping', actor: { name: 'probe' } });
  assert.equal(answer.text, 'PONG');
  assert.equal(subagents.calls.length, 1);
  assert.equal(typeof subagents.calls[0].signal?.throwIfAborted, 'function', '桥必须传一个真实的 AbortSignal');
});

test('调用方给了 signal 时原样透传', async () => {
  const subagents = declaredSurface();
  const run = runnerFor(subagents);
  const signal = new AbortController().signal;
  await run({ parent: { id: 'sess-1' }, prompt: 'ping', signal });
  assert.equal(subagents.calls[0].signal, signal);
});

test('生产调用形态（tools.js 传 agent 而不是 parent）也能启动', async () => {
  const subagents = declaredSurface();
  const run = runnerFor(subagents);
  const parent = { id: 'sess-1' };
  const answer = await run({ agent: parent, prompt: 'ping', actor: { name: 'probe' } });
  assert.equal(answer.text, 'PONG');
  assert.equal(subagents.calls[0].request.parent, parent, '父会话对象必须原样交给 manager 的身份校验');
});

test('stopReason 非 completed 一律报错：error / aborted / max-tokens / refusal', async () => {
  for (const reason of ['error', 'aborted', 'max-tokens', 'refusal']) {
    const subagents = declaredSurface({ result: { output: [{ type: 'text', text: '' }], stopReason: reason, diagnostic: 'provider said no' } });
    const run = runnerFor(subagents);
    await assert.rejects(
      () => run({ parent: { id: 'sess-1' }, prompt: 'x', actor: { name: 'probe' } }),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /probe/, `错误里必须带 actor 名: ${message}`);
        assert.match(message, new RegExp(reason.replace('-', '\\-'), 'i'), `错误里应能看出 stopReason: ${message}`);
        return true;
      },
      `stopReason=${reason} 时不应把空文本当成功`,
    );
  }
});

test('正常路径返回 {text, structured?, tokens?, childId}', async () => {
  const subagents = declaredSurface({
    result: {
      output: [{ type: 'text', text: '{"ok":true}' }],
      stopReason: 'completed',
      structured: { ok: true },
      usage: { totalTokens: 42 },
    },
  });
  const run = runnerFor(subagents);
  const answer = await run({
    parent: { id: 'sess-1' },
    prompt: 'ping',
    actor: { name: 'probe', model: 'prov/m1', persona: 'you are probe' },
  });
  assert.equal(answer.text, '{"ok":true}');
  assert.deepEqual(answer.structured, { ok: true });
  assert.equal(answer.tokens, 42);
  assert.equal(answer.childId, 'child-1', 'activation 的 childId 应保留，供 actor 身份关联');
  assert.equal(subagents.calls.length, 1);
  assert.equal(subagents.disposed, 1, 'activation 必须被 dispose');
  assert.equal(subagents.calls[0].request.parent.id, 'sess-1');
  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'prov', model: 'm1' });
});
