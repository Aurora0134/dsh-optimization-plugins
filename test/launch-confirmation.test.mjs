/**
 * The launch confirmation, end to end and without a browser.
 *
 * The bug this guards against: a launch waits on the broker for a decision, and nothing on the
 * browser side could see the question, so the tool call sat there until its 15-minute timeout and the
 * model never got an answer. The pieces are the real ones — the broker, the tools, the routes — and
 * only the runtime, the store and the HTTP carrier are stubs, so a change to the wire between them
 * fails here instead of in a test session that waits fifteen minutes.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createApprovalBroker } from '../host/approval.js';
import { createWorkflowTools } from '../host/tools.js';
import { registerWorkflowUiApi } from '../host/ui-api.js';

const WORKSPACE = await mkdtemp(path.join(os.tmpdir(), 'zcode-launch-'));
after(() => rm(WORKSPACE, { recursive: true, force: true }));

const BASE = '/zcode-workflow';
const SESSION = 'session-1';

/** Minimal node request: an async iterable body and a lowercase header bag. */
function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8');
    },
    resume() {},
  };
}

/** Minimal node response: status, headers and one body chunk. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk;
    },
  };
}

/**
 * Wire the real broker, tools and routes over stub services.
 */
function createHarness(options = {}) {
  const registered = [];
  const started = [];
  const amended = [];
  const broker = createApprovalBroker({ logger: { warn() {}, info() {} } });
  const runtime = {
    prepare: async (request) => ({
      ok: true,
      diagnostics: [],
      draftPath: request.scriptPath,
      scriptPath: request.scriptPath,
      phases: ['Plan'],
      actors: [],
      holes: [],
      artifacts: [],
      worldCommands: [],
      causalityGraph: { phases: [{ id: 'Plan', name: 'Plan' }], steps: [{ id: 's1', phase: 'Plan', kind: 'ask' }], holes: [] },
      prepared: { code: request.code, filename: 'workflow.ts', compile: { ok: true, phases: ['Plan'], actors: [], holes: [], scriptHash: 'hash', askSpecs: new Map(), sitePhases: new Map() } },
    }),
    start: async (request) => {
      started.push(request);
      return { ok: true, runId: request.runId, status: 'running' };
    },
    defaultConcurrency: () => 8,
    getRun: async () => options.previous,
    amend: async (runId, request) => {
      amended.push({ runId, request });
      return { ok: true, runId: 'next', status: 'running' };
    },
  };
  const store = {
    listRunsForSession: async () => [],
    projectRun: async () => undefined,
    writeDraft: async () => undefined,
  };
  const compiler = { extractMetadataHeader: () => ({ ok: false }), compileWorkflowScript: () => ({ ok: true, diagnostics: [], phases: ['Plan'] }) };
  // 会话投影：确认框的模型目录读的就是这份"本会话允许的子代理路由"。
  // 没有记录策略时状态是 null，等价于"只允许父会话路由"。
  const registrations = [];
  const projections = {
    register: async (definition) => {
      registrations.push(definition);
      return { stateOf: () => (options.policy === undefined ? null : options.policy) };
    },
  };
  const tools = createWorkflowTools({
    ctx: {
      get: (key) => {
        if (key === 'llm') return options.llm;
        if (key === 'sessionProjections') return projections;
        return undefined;
      },
    },
    runtime,
    store,
    compiler,
    approval: broker,
    logger: { warn() {}, info() {} },
  });
  const services = {
    sessions: { get: (id) => (id === SESSION ? { header: { cwd: WORKSPACE } } : undefined) },
    workingDirectory: { get: (session) => session?.header?.cwd },
    agents: { get: () => undefined },
  };
  registerWorkflowUiApi({
    ctx: {
      connection: { requestRejection: () => undefined },
      webServer: { register: (route) => { registered.push(route); return () => {}; } },
      effect: (callback) => callback(),
      get: (key) => services[key],
    },
    storeFor: () => store,
    runtimeFor: () => runtime,
    resolveProjectRoot: async (raw) => (raw === WORKSPACE ? WORKSPACE : undefined),
    readMode: async () => ({ mode: 'alwaysOn', writable: true, effective: 'immediate' }),
    writeMode: async (mode) => ({ mode, effective: 'immediate' }),
    approval: broker,
    logger: { warn() {} },
  });
  return {
    tools,
    started,
    amended,
    broker,
    registrations,
    byName: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
    /** @param {'GET'|'POST'} method @param {string} pathname */
    async call(method, pathname, options = {}) {
      const route = registered.find((entry) => entry.path === pathname);
      assert.ok(route, `route ${pathname} is registered`);
      const query = options.query === undefined ? '' : `?${new URLSearchParams(options.query).toString()}`;
      const headers = method === 'POST' ? { 'content-type': 'application/json' } : {};
      const body = method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined;
      const response = makeResponse();
      await route.handler(makeRequest({ method, url: `${pathname}${query}`, headers, body }), response);
      const text = response.body === undefined ? undefined : String(response.body);
      return { status: response.statusCode, json: text === undefined ? undefined : JSON.parse(text) };
    },
    /** Launches the catalogue reports as waiting, once the tool call has reached the broker. */
    async waiting() {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const listed = await this.call('GET', `${BASE}/runs`, { query: { sessionId: SESSION } });
        const runs = listed.json.runs.filter((row) => row.status === 'pending');
        if (runs.length > 0) return runs;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return [];
    },
  };
}

/** One tool call bound to the session the routes resolve. */
function execFor(extra = {}) {
  return {
    sessionId: SESSION,
    callId: 'call-1',
    agent: { session: { header: { cwd: WORKSPACE } }, followup() {} },
    ...extra,
  };
}

test('a launch waiting for an answer is visible, answerable, and then gone', async () => {
  const h = createHarness();
  const executing = h.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'nightly' }, execFor());

  const [pending] = await h.waiting();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.toolName, 'CreateWorkflow');
  assert.equal(pending.toolCallId, 'call-1');
  assert.equal(pending.label, 'nightly');
  assert.equal(pending.input.script, 'return 1;');
  assert.equal(pending.input.causalityGraph.phases[0].name, 'Plan');
  assert.equal(h.started.length, 0, 'nothing runs before the user answers');

  // 卡片订阅详情时不能 404：等待中的启动同样是一个可读的 run。
  const detail = await h.call('GET', `${BASE}/run`, { query: { sessionId: SESSION, runId: pending.runId } });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.run.status, 'pending');

  const answered = await h.call('POST', `${BASE}/run/approve`, {
    body: { sessionId: SESSION, runId: pending.runId, optionId: 'allow_once', adjustments: { maxConcurrency: 2 } },
  });
  assert.equal(answered.status, 200);

  const result = await executing;
  assert.equal(result.ok, true, result.text);
  assert.equal(h.started.length, 1);
  assert.equal(h.started[0].maxConcurrency, 2);
  const after = await h.call('GET', `${BASE}/runs`, { query: { sessionId: SESSION } });
  assert.deepEqual(after.json.runs.filter((row) => row.status === 'pending'), []);
});

test('a launch the user refuses answers the call and creates nothing', async () => {
  const h = createHarness();
  const executing = h.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'nightly' }, execFor());
  const [pending] = await h.waiting();
  await h.call('POST', `${BASE}/run/approve`, { body: { sessionId: SESSION, runId: pending.runId, optionId: 'deny' } });
  const result = await executing;
  assert.equal(result.ok, false);
  assert.equal(result.rejected, true);
  assert.equal(h.started.length, 0);
});

test('a cancelled call stops waiting at once instead of holding the answer slot', async () => {
  const h = createHarness();
  const controller = new AbortController();
  const startedAt = Date.now();
  const executing = h.byName.CreateWorkflow.execute(
    { script: 'return 1;', name: 'nightly' },
    execFor({ signal: controller.signal }),
  );
  const [pending] = await h.waiting();
  assert.equal(pending.status, 'pending');
  controller.abort();
  const result = await executing;
  assert.equal(result.ok, false);
  assert.equal(result.rejected, true);
  assert.ok(Date.now() - startedAt < 2000, 'the call must not sit on the timeout');
  const after = await h.call('GET', `${BASE}/runs`, { query: { sessionId: SESSION } });
  assert.deepEqual(after.json.runs.filter((row) => row.status === 'pending'), []);
  // 放弃的提问不会被第二次作答。
  const late = await h.call('POST', `${BASE}/run/approve`, {
    body: { sessionId: SESSION, runId: pending.runId, optionId: 'allow_once' },
  });
  assert.equal(late.status, 404);
  assert.equal(h.started.length, 0);
});

/** 一个有两家 provider 的 LLM 目录：用来证明越权路由不会进确认框。 */
function twoProviderLlm(extra = {}) {
  return {
    listProviders: () => [{ id: 'prov', name: 'Provider' }, { id: 'other', name: 'Other' }],
    listModels: async (provider) => (provider === 'prov'
      ? [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }]
      : [{ id: 'x1', name: 'Other One' }]),
    ...extra,
  };
}

/** 一个声明了可调设置但没显式选模型的启动。 */
function launchWithoutModel() {
  return execFor({
    agent: {
      session: {
        header: { cwd: WORKSPACE },
        requestHeader: () => ({ config: { provider: 'prov', model: 'm1' } }),
      },
      followup() {},
    },
  });
}

test('没有记录策略时目录只有会话模型，可调并发仍然送到确认框', async () => {
  const h = createHarness({ llm: twoProviderLlm() });
  const executing = h.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'nightly' }, launchWithoutModel());
  const [pending] = await h.waiting();
  // 本会话没有记录策略：DSH 只放行父会话路由，所以目录里不能出现别的 provider 或别的模型。
  assert.deepEqual(pending.input.models.map((row) => row.id), ['prov/m1']);
  // 模型没显式传参：确认框仍要能以会话模型为准，并且并发是可调的（默认值随 payload 下发）。
  assert.equal(pending.input.subagent_model, undefined);
  assert.equal(pending.input.subagent_model_default, true);
  assert.equal(pending.input.max_concurrency, undefined);
  assert.equal(pending.input.adjustable_settings.subagent_model, true);
  assert.equal(pending.input.adjustable_settings.concurrency_ceiling, 8);
  assert.equal(h.started.length, 0);
  await h.call('POST', BASE + '/run/approve', { body: { sessionId: SESSION, runId: pending.runId, optionId: 'deny' } });
  await executing;
});

test('记录策略存在时目录恰好是那些路由，不出现越权地址', async () => {
  const h = createHarness({
    llm: twoProviderLlm({
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }),
    }),
    policy: [{ provider: 'prov', model: 'm2' }],
  });
  const executing = h.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'nightly' }, launchWithoutModel());
  const [pending] = await h.waiting();
  // 只有策略里的路由：父会话路由(prov/m1) 与别家 provider(other/x1) 都不在目录里。
  assert.deepEqual(pending.input.models, [{
    id: 'prov/m2',
    label: 'Model Two',
    efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
  }]);
  // 读的是官方那份投影定义，名字与版本必须和 dsh-tool-subagent 一致，才能共享同一个单元。
  assert.equal(h.registrations.length, 1);
  assert.equal(h.registrations[0].key, 'subagentModelSelectionPolicy');
  assert.equal(h.registrations[0].stateVersion, 1);
  await h.call('POST', BASE + '/run/approve', { body: { sessionId: SESSION, runId: pending.runId, optionId: 'deny' } });
  await executing;
});

test('确认框选定的模型与并发写进本次 run 的启动参数', async () => {
  const h = createHarness({ llm: twoProviderLlm(), policy: [{ provider: 'prov', model: 'm2' }] });
  const executing = h.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'nightly' }, launchWithoutModel());
  const [pending] = await h.waiting();
  const answered = await h.call('POST', BASE + '/run/approve', {
    body: {
      sessionId: SESSION,
      runId: pending.runId,
      optionId: 'allow_once',
      adjustments: { subagentModel: 'prov/m2', maxConcurrency: 3 },
    },
  });
  assert.equal(answered.status, 200);
  const result = await executing;
  assert.equal(result.ok, true, result.text);
  assert.equal(h.started[0].subagentModel, 'prov/m2');
  assert.equal(h.started[0].maxConcurrency, 3);
});

test('确认框选「沿用会话模型」时不写 subagent_model，越界并发被夹紧', async () => {
  const h = createHarness({ llm: twoProviderLlm(), policy: [{ provider: 'prov', model: 'm2' }] });
  const executing = h.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'nightly' }, launchWithoutModel());
  const [pending] = await h.waiting();
  const answered = await h.call('POST', BASE + '/run/approve', {
    body: {
      sessionId: SESSION,
      runId: pending.runId,
      optionId: 'allow_once',
      // 会话模型 = null（不给本次 run 指定模型）；并发给一个越界值。
      adjustments: { subagentModel: null, maxConcurrency: 5000 },
    },
  });
  assert.equal(answered.status, 200);
  const result = await executing;
  assert.equal(result.ok, true, result.text);
  assert.equal(h.started[0].subagentModel, undefined);
  assert.equal(h.started[0].maxConcurrency, 1024);

  const h2 = createHarness({ llm: twoProviderLlm(), policy: [{ provider: 'prov', model: 'm2' }] });
  const second = h2.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'nightly' }, launchWithoutModel());
  const [pending2] = await h2.waiting();
  await h2.call('POST', BASE + '/run/approve', {
    body: { sessionId: SESSION, runId: pending2.runId, optionId: 'allow_once', adjustments: { maxConcurrency: 0 } },
  });
  await second;
  assert.equal(h2.started[0].maxConcurrency, 1, 'a concurrency below one is clamped instead of rejected');
});

test('the run carries the tool call that launched it, so a card can claim it', async () => {
  const h = createHarness({ llm: twoProviderLlm(), policy: [{ provider: 'prov', model: 'm2' }] });
  const executing = h.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'nightly' }, execFor({ callId: 'call-42' }));
  const [pending] = await h.waiting();
  await h.call('POST', BASE + '/run/approve', { body: { sessionId: SESSION, runId: pending.runId, optionId: 'allow_once' } });
  await executing;
  assert.equal(h.started[0].toolCallId, 'call-42');
});

test('an amended run carries the tool call of the amendment', async () => {
  const previous = {
    id: 'run-prev',
    runId: 'run-prev',
    status: 'running',
    parentSessionId: 'another-session',
    name: 'previous',
    cwd: WORKSPACE,
    scriptPath: WORKSPACE + '/previous.ts',
    scriptText: 'return 1;',
    args: {},
    maxConcurrency: 5,
    subagentModel: 'prov/m1',
  };
  const h = createHarness({ llm: twoProviderLlm(), previous });
  const executing = h.byName.AmendWorkflow.execute({ run_id: 'run-prev', script: 'return 2;' }, execFor({ callId: 'call-99' }));
  const [pending] = await h.waiting();
  await h.call('POST', BASE + '/run/approve', { body: { sessionId: SESSION, runId: pending.runId, optionId: 'allow_once' } });
  await executing;
  assert.equal(h.amended[0].request.toolCallId, 'call-99');
});

test('an amend confirmation starts from the predecessor settings and applies the dialog changes', async () => {
  const llm = {
    listProviders: () => [{ id: 'prov', name: 'Provider' }],
    listModels: async () => [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }],
  };
  const previous = {
    id: 'run-prev',
    runId: 'run-prev',
    status: 'running',
    parentSessionId: 'another-session',
    name: 'previous',
    cwd: WORKSPACE,
    scriptPath: WORKSPACE + '/previous.ts',
    scriptText: 'return 1;',
    args: {},
    maxConcurrency: 5,
    subagentModel: 'prov/m1',
  };
  const h = createHarness({ llm, previous });
  const executing = h.byName.AmendWorkflow.execute(
    { run_id: 'run-prev', script: 'return 2;' },
    execFor({
      agent: {
        session: {
          header: { cwd: WORKSPACE },
          requestHeader: () => ({ config: { provider: 'prov', model: 'm1' } }),
        },
        followup() {},
      },
    }),
  );
  const [pending] = await h.waiting();
  assert.equal(pending.input.max_concurrency, 5);
  assert.equal(pending.input.subagent_model, 'prov/m1');
  assert.equal(pending.input.subagent_model_default, false);
  assert.equal(pending.input.adjustable_settings.concurrency_ceiling, 8);

  await h.call('POST', BASE + '/run/approve', {
    body: {
      sessionId: SESSION,
      runId: pending.runId,
      optionId: 'allow_once',
      adjustments: { maxConcurrency: 2, subagentModel: 'prov/m2' },
    },
  });
  const result = await executing;
  assert.equal(result.ok, true, result.text);
  assert.equal(h.amended.length, 1);
  assert.equal(h.amended[0].runId, 'run-prev');
  assert.equal(h.amended[0].request.maxConcurrency, 2);
  assert.equal(h.amended[0].request.subagentModel, 'prov/m2');
});
