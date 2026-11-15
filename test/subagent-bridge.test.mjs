import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentRunner } from '../host/subagent.js';

const quietLogger = { warn() {} };

/**
 * 按 DSH 0.2.2-rc.3 的 SubagentActivationSpec 校验一次 startActivation 的形状。
 *
 * 声明面见 dsh-subagent/lib/typert.host.js:791-792（Omit<SubagentStartRequest,'label'|'signal'>
 * + provider/label/name/childId/signal/delivery，全部同层，没有嵌套 request），
 * 运行时的读法见 index.js:3025（`spec.parent.id`）、1480/1493（`spec.parent`）、
 * 1558（`spec.prompt`）、1494/1600（`spec.signal` 交给 trackStartup）、1499（`spec.agentOptions`）。
 * 桥若退回嵌套 request，这里会像真实运行时一样先读到 undefined 而失败。
 */
function assertDeclaredSpec(spec) {
  assert.equal(typeof spec.provider, 'string', 'spec.provider 必填');
  assert.equal(typeof spec.label, 'string', 'spec.label 必填');
  assert.equal(
    Object.hasOwn(spec, 'request'),
    false,
    'rc.3 的 spec 是扁平的：prompt/parent/cwd/agentOptions/outputSchema 与 provider 同层，不存在嵌套 request',
  );
  assert.equal(typeof spec.parent?.id, 'string', 'spec.parent 必须是活 Agent（index.js:3025）');
  assert.ok(Array.isArray(spec.prompt) && spec.prompt.length > 0, 'spec.prompt 是 ContentBlock[]（index.js:1558）');
  assert.equal(typeof spec.signal?.throwIfAborted, 'function', 'spec.signal 是必填 AbortSignal（index.js:1494）');
  assert.ok(spec.delivery === 'caller' || spec.delivery === 'parent', 'delivery 必填');
  if (spec.cwd !== undefined) assert.equal(typeof spec.cwd, 'string', 'spec.cwd 是字符串');
  if (spec.agentOptions !== undefined) assert.equal(typeof spec.agentOptions, 'object', 'spec.agentOptions 是 AgentOptions');
  if (spec.outputSchema !== undefined) assert.equal(typeof spec.outputSchema, 'object', 'spec.outputSchema 是 JSON Schema 对象');
}

/**
 * 只实现 DSH 声明面的假 subagents 服务：有 getProvider(name) 与 startActivation(spec)，没有 list()。
 * 假服务不是橡皮图章——它按 rc.3 的扁平 spec 断言，桥漏传 parent / signal 或退回嵌套 request 都会红。
 */
function declaredSurface({ providers = ['spawn'], result, childId = 'child-1', name = 'probe-1' } = {}) {
  const calls = [];
  let disposed = 0;
  return {
    calls,
    get disposed() {
      return disposed;
    },
    getProvider(providerName) {
      if (!providers.includes(providerName)) return undefined;
      return {
        name: providerName,
        capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
        inheritsParentContext: false,
        prepareContinuable: async () => ({}),
      };
    },
    async startActivation(spec) {
      assertDeclaredSpec(spec);
      calls.push(spec);
      return {
        childId,
        name,
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

test('扁平 spec 契约：嵌套 request 形态会被假服务判红（防回归）', () => {
  const nested = {
    provider: 'spawn',
    label: 'probe',
    request: { prompt: [{ type: 'text', text: 'ping' }], parent: { id: 'sess-1' } },
    signal: new AbortController().signal,
    delivery: 'caller',
  };
  assert.throws(() => assertDeclaredSpec(nested), /扁平|spec\.parent/);
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

test('服务不暴露 getProvider 时给出可读错误，不退化成 is not a function', async () => {
  const subagents = {
    async startActivation() {
      assert.fail('查询面缺失时不应该走到 startActivation');
    },
  };
  const run = runnerFor(subagents);
  await assert.rejects(
    () => run({ parent: { id: 'sess-1' }, prompt: 'ping', actor: { name: 'probe' } }),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(!/is not a function/.test(message));
      assert.ok(!(error instanceof TypeError));
      assert.match(message, /getProvider/);
      return true;
    },
  );
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

test('生产调用形态（tools.js 传 agent 而不是 parent）也能启动，且 spec.parent 就是它', async () => {
  const subagents = declaredSurface();
  const run = runnerFor(subagents);
  const parent = { id: 'sess-1' };
  const answer = await run({ agent: parent, prompt: 'ping', actor: { name: 'probe' } });
  assert.equal(answer.text, 'PONG');
  assert.equal(subagents.calls[0].parent, parent, '父会话对象必须原样交给 index.js:3025 的身份校验');
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

test('正常路径返回 {text, structured?, tokens?, childId, childName}', async () => {
  const subagents = declaredSurface({
    result: {
      output: [{ type: 'text', text: '{"ok":true}' }],
      stopReason: 'completed',
      structured: { ok: true },
      usage: { totalTokens: 42 },
    },
    childId: 'child-1',
    name: 'probe-1',
  });
  const run = runnerFor(subagents);
  const answer = await run({
    parent: { id: 'sess-1' },
    prompt: 'ping',
    cwd: 'C:/x',
    actor: { name: 'probe', model: 'prov/m1', persona: 'you are probe' },
  });
  assert.equal(answer.text, '{"ok":true}');
  assert.deepEqual(answer.structured, { ok: true });
  assert.equal(answer.tokens, 42);
  assert.equal(answer.childId, 'child-1', 'activation 的 childId 应保留，供 actor 身份关联');
  assert.equal(answer.childName, 'probe-1', 'activation 的 name 也应保留');
  assert.equal(subagents.calls.length, 1);
  assert.equal(subagents.disposed, 1, 'activation 必须被 dispose');
  const spec = subagents.calls[0];
  assert.equal(spec.parent.id, 'sess-1');
  assert.deepEqual(spec.agentOptions, { provider: 'prov', model: 'm1' });
  assert.equal(spec.cwd, 'C:/x');
  assert.equal(spec.prompt[0].type, 'text');
  assert.match(spec.prompt[0].text, /you are probe/);
});
