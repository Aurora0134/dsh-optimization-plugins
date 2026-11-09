/**
 * Wire tests for the browser data channel: route table, trust fence, method/body validation
 * and the handler contracts the client half consumes.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { apply } from '../index.js';
import { registerWorkflowUiApi } from '../host/ui-api.js';

const BASE = '/zcode-workflow';
// A real absolute directory the Host resolves through realpath without rewriting it.
const WORKSPACE = process.cwd();
const SAVED_PATH = path.join(WORKSPACE, '.dsh', 'workflows', 'review-changes.dwf.ts');

const ROUTE_PATHS = [
  `${BASE}/runs`,
  `${BASE}/run`,
  `${BASE}/run/stop`,
  `${BASE}/run/fill`,
  `${BASE}/run/start`,
  `${BASE}/workflows`,
  `${BASE}/workflows/delete`,
  `${BASE}/workflows/move`,
  `${BASE}/artifact`,
  `${BASE}/mode`,
];

/**
 * Minimal node request: an async iterable body and a lowercase header bag.
 * @param {{ method?: string, url?: string, headers?: Record<string, string>, body?: string }} options
 */
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
 * Build one plugin registration with fake services and capture every registered route.
 * @param {object} [options]
 */
function createFixture(options = {}) {
  const registered = [];
  const calls = [];
  const sessions = new Map([['session-1', { header: { cwd: WORKSPACE } }]]);
  const agents = new Map();
  if (options.agent !== false) {
    agents.set('session-1', {
      followup(payload) {
        calls.push(['followup', payload]);
        return Promise.resolve();
      },
    });
  }
  const saved = {
    name: 'review-changes',
    scope: 'project',
    description: 'Review changes',
    whenToUse: 'When a change needs review',
    args: {
      target: { type: 'string', required: true },
      count: { type: 'number', default: 2 },
    },
    path: SAVED_PATH,
    code: 'return { ok: true };',
  };
  const store = {
    async listSavedWorkflows() {
      const rows = [{ ...saved, code: saved.code }];
      rows.entries = rows;
      rows.invalid = [{ path: path.join(WORKSPACE, '.dsh', 'workflows', 'broken.dwf.ts'), reason: 'invalid metadata' }];
      return rows;
    },
    async getSavedWorkflow(name, request) {
      calls.push(['getSavedWorkflow', name, request]);
      return name === saved.name ? { ...saved } : undefined;
    },
    async deleteSavedWorkflow(name) {
      calls.push(['deleteSavedWorkflow', name]);
      return name === saved.name;
    },
    async moveSavedWorkflow(name) {
      calls.push(['moveSavedWorkflow', name]);
      return { ok: true, from: 'global', to: 'project', path: SAVED_PATH };
    },
    async readArtifactManifest() {
      return [{ id: 'report', kind: 'markdown', version: 1, contentType: 'text/markdown', text: '# report' }];
    },
    async artifactFilePath() {
      return undefined;
    },
  };
  const run = {
    id: 'run-1',
    name: 'review-changes',
    status: 'running',
    createdAt: 1,
    finishedAt: undefined,
    stopReason: undefined,
    possibleInterruption: false,
    spentTokens: 12,
    labelSource: 'saved',
    steps: { started: 0, settled: 0, failed: 0, running: 0 },
  };
  const runtime = {
    async listRuns(request) {
      calls.push(['listRuns', request]);
      return [run, { ...run, id: 'run-2' }, { ...run, id: 'run-3' }];
    },
    async getRun(id) {
      calls.push(['getRun', id]);
      return id === run.id ? run : undefined;
    },
    async stopRun(id, reason) {
      calls.push(['stopRun', id, reason]);
      return id === run.id ? { ...run, status: 'stopped', stopReason: reason } : undefined;
    },
    async fillHole(id, holeId, value) {
      calls.push(['fillHole', id, holeId, value]);
      return true;
    },
    async start(request) {
      calls.push(['start', request]);
      return { ok: true, runId: run.id, phases: ['review'], agents: ['reviewer'] };
    },
  };
  const services = {
    sessions: { get: (id) => sessions.get(id) },
    workingDirectory: { get: (session) => session?.header?.cwd },
    agents: { get: (id) => agents.get(id) },
  };
  const ctx = {
    connection: { requestRejection: () => options.rejection },
    webServer: {
      register(route) {
        registered.push(route);
        return () => {};
      },
    },
    effect(callback) {
      return callback();
    },
    get(key) {
      return services[key];
    },
  };
  registerWorkflowUiApi({
    ctx,
    storeFor: () => store,
    runtimeFor: () => runtime,
    resolveProjectRoot: options.resolveProjectRoot ?? (async (raw) => (raw === WORKSPACE ? WORKSPACE : undefined)),
    readMode: options.readMode ?? (async () => ({ mode: 'alwaysOn', writable: true, effective: 'immediate' })),
    writeMode: options.writeMode ?? (async (mode) => ({ mode, effective: 'immediate' })),
    logger: { warn() {} },
  });
  return { registered, calls, store, runtime, run, saved };
}

/**
 * Invoke one registered route the way the HTTP carrier would.
 * @param {ReturnType<typeof createFixture>} fixture
 * @param {'GET'|'POST'} method
 * @param {string} pathname
 * @param {{ query?: Record<string, string>, body?: unknown, rawBody?: string, headers?: Record<string, string> }} [options]
 */
async function call(fixture, method, pathname, options = {}) {
  const route = fixture.registered.find((entry) => entry.path === pathname);
  assert.ok(route, `route ${pathname} is registered`);
  const query = options.query === undefined ? '' : `?${new URLSearchParams(options.query).toString()}`;
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (method === 'POST') {
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json';
    body = options.rawBody ?? JSON.stringify(options.body ?? {});
  }
  const request = makeRequest({ method, url: `${pathname}${query}`, headers, body });
  const response = makeResponse();
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} ${pathname} did not answer`)), 2000);
  });
  try {
    await Promise.race([route.handler(request, response), guard]);
  } finally {
    clearTimeout(timer);
  }
  const text = response.body === undefined
    ? undefined
    : Buffer.isBuffer(response.body) ? response.body.toString('utf8') : String(response.body);
  return {
    status: response.statusCode,
    headers: response.headers,
    text,
    json: text === undefined ? undefined : JSON.parse(text),
  };
}

test('registers every documented path exactly once as an exact route', () => {
  const fixture = createFixture();
  const paths = fixture.registered.map((route) => route.path).sort();
  assert.deepEqual(paths, [...ROUTE_PATHS].sort());
  assert.ok(fixture.registered.every((route) => route.kind === 'exact'));
});

test('every route applies the connection trust fence before anything else', async () => {
  const refused = createFixture({ rejection: 401 });
  const unauthorized = await call(refused, 'GET', `${BASE}/mode`);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.json.code, 'unauthorized');
  // The fence runs before the method check.
  const forbidden = createFixture({ rejection: 403 });
  const denied = await call(forbidden, 'DELETE', `${BASE}/mode`);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'forbidden');
});

test('rejects an unsupported method with the route allow list', async () => {
  const fixture = createFixture();
  const onPostOnly = await call(fixture, 'GET', `${BASE}/run/stop`);
  assert.equal(onPostOnly.status, 405);
  assert.equal(onPostOnly.headers.allow, 'POST');
  const onBoth = await call(fixture, 'DELETE', `${BASE}/mode`);
  assert.equal(onBoth.status, 405);
  assert.equal(onBoth.headers.allow, 'GET, POST');
});

test('GET /runs requires a location and pages with a truncation flag', async () => {
  const fixture = createFixture();
  const missing = await call(fixture, 'GET', `${BASE}/runs`, { query: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'missing-location');

  const listed = await call(fixture, 'GET', `${BASE}/runs`, { query: { sessionId: 'session-1', limit: '2' } });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.runs.length, 2);
  assert.equal(listed.json.truncated, true);
  assert.equal(listed.json.runs[0].id, 'run-1');
  assert.equal(listed.json.runs[0].possibleInterruption, false);
  const listCall = fixture.calls.find((entry) => entry[0] === 'listRuns');
  assert.deepEqual(listCall[1], { project: true, limit: 3 });
});

test('GET /runs rejects an unregistered project root and a stale session', async () => {
  const fixture = createFixture();
  const unregistered = await call(fixture, 'GET', `${BASE}/runs`, { query: { projectRoot: '/elsewhere' } });
  assert.equal(unregistered.status, 404);
  assert.equal(unregistered.json.code, 'project-not-found');

  const stale = await call(fixture, 'GET', `${BASE}/runs`, { query: { sessionId: 'gone' } });
  assert.equal(stale.status, 404);
  assert.equal(stale.json.code, 'session-not-found');

  const byRoot = await call(fixture, 'GET', `${BASE}/runs`, { query: { projectRoot: WORKSPACE } });
  assert.equal(byRoot.status, 200);
  assert.equal(byRoot.json.runs.length, 3);
  assert.equal(byRoot.json.truncated, false);
});

test('GET /run returns a snapshot, requiring runId and a known run', async () => {
  const fixture = createFixture();
  const missing = await call(fixture, 'GET', `${BASE}/run`, { query: { sessionId: 'session-1' } });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'missing-parameter');

  const found = await call(fixture, 'GET', `${BASE}/run`, { query: { sessionId: 'session-1', runId: 'run-1' } });
  assert.equal(found.status, 200);
  assert.equal(found.json.run.id, 'run-1');

  const unknown = await call(fixture, 'GET', `${BASE}/run`, { query: { sessionId: 'session-1', runId: 'nope' } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'run-not-found');
});

test('POST /run/stop stops through the runtime with the user reason', async () => {
  const fixture = createFixture();
  const stopped = await call(fixture, 'POST', `${BASE}/run/stop`, {
    body: { sessionId: 'session-1', runId: 'run-1' },
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.ok, true);
  assert.equal(stopped.json.run.status, 'stopped');
  const stopCall = fixture.calls.find((entry) => entry[0] === 'stopRun');
  assert.deepEqual(stopCall, ['stopRun', 'run-1', 'user']);
});

test('POST /run/fill resolves a hole and reports the refreshed run', async () => {
  const fixture = createFixture();
  const filled = await call(fixture, 'POST', `${BASE}/run/fill`, {
    body: { sessionId: 'session-1', runId: 'run-1', holeId: 'hole-1', value: { answer: 42 } },
  });
  assert.equal(filled.status, 200);
  assert.equal(filled.json.ok, true);
  assert.equal(filled.json.run.id, 'run-1');
  const fillCall = fixture.calls.find((entry) => entry[0] === 'fillHole');
  assert.deepEqual(fillCall, ['fillHole', 'run-1', 'hole-1', { answer: 42 }]);

  const missingValue = await call(fixture, 'POST', `${BASE}/run/fill`, {
    body: { sessionId: 'session-1', runId: 'run-1', holeId: 'hole-1' },
  });
  assert.equal(missingValue.status, 400);
  assert.equal(missingValue.json.code, 'missing-parameter');
});

test('POST bodies require application/json, valid JSON and stay under 64 KiB', async () => {
  const fixture = createFixture();
  const wrongType = await call(fixture, 'POST', `${BASE}/mode`, {
    headers: { 'content-type': 'text/plain' },
    rawBody: '{"mode":"alwaysOn"}',
  });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.json.code, 'unsupported-media-type');

  const notJson = await call(fixture, 'POST', `${BASE}/mode`, { rawBody: '{' });
  assert.equal(notJson.status, 400);
  assert.equal(notJson.json.code, 'bad-request');

  const tooLarge = await call(fixture, 'POST', `${BASE}/mode`, { rawBody: `{"mode":"${'x'.repeat(70 * 1024)}"}` });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.json.code, 'payload-too-large');
});

test('GET /workflows projects saved entries without their script body', async () => {
  const fixture = createFixture();
  const listed = await call(fixture, 'GET', `${BASE}/workflows`, { query: { projectRoot: WORKSPACE } });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.entries.length, 1);
  const [entry] = listed.json.entries;
  assert.equal(entry.name, 'review-changes');
  assert.equal(entry.scope, 'project');
  assert.equal(entry.description, 'Review changes');
  assert.deepEqual(entry.args, fixture.saved.args);
  assert.equal('code' in entry, false);
  assert.equal(listed.json.invalid.length, 1);
});

test('POST /workflows/delete and /workflows/move use the saved-workflow store', async () => {
  const fixture = createFixture();
  const deleted = await call(fixture, 'POST', `${BASE}/workflows/delete`, {
    body: { projectRoot: WORKSPACE, name: 'review-changes', scope: 'project' },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.ok, true);

  const unknown = await call(fixture, 'POST', `${BASE}/workflows/delete`, {
    body: { projectRoot: WORKSPACE, name: 'missing' },
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'workflow-not-found');

  const moved = await call(fixture, 'POST', `${BASE}/workflows/move`, {
    body: { projectRoot: WORKSPACE, name: 'review-changes' },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.path, SAVED_PATH);
});

test('GET /artifact returns a text payload as JSON with its content type', async () => {
  const fixture = createFixture();
  const artifact = await call(fixture, 'GET', `${BASE}/artifact`, {
    query: { sessionId: 'session-1', runId: 'run-1', artifactId: 'report' },
  });
  assert.equal(artifact.status, 200);
  assert.match(artifact.headers['content-type'], /application\/json/u);
  assert.deepEqual(artifact.json, {
    kind: 'markdown',
    contentType: 'text/markdown',
    text: '# report',
    version: 1,
    primary: false,
  });

  const unknown = await call(fixture, 'GET', `${BASE}/artifact`, {
    query: { sessionId: 'session-1', runId: 'run-1', artifactId: 'nope' },
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'artifact-not-found');
});

test('GET /mode reports the applied mode, writability and channel timing', async () => {
  const fixture = createFixture({
    readMode: async () => ({ mode: 'onDemand', writable: false, effective: 'restart' }),
  });
  const snapshot = await call(fixture, 'GET', `${BASE}/mode`);
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.json, { mode: 'onDemand', writable: false, effective: 'restart' });
});

test('POST /mode validates the mode and normalizes the ZCode aliases', async () => {
  const written = [];
  const fixture = createFixture({
    writeMode: async (mode) => {
      written.push(mode);
      return { mode, effective: 'restart' };
    },
  });
  const saved = await call(fixture, 'POST', `${BASE}/mode`, { body: { mode: 'off' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { mode: 'disabled', effective: 'restart' });
  assert.deepEqual(written, ['disabled']);

  const invalid = await call(fixture, 'POST', `${BASE}/mode`, { body: { mode: 'sometimes' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, 'invalid-mode');

  const missing = await call(fixture, 'POST', `${BASE}/mode`, { body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'missing-parameter');
});

test('POST /run/start refuses a session without a live agent', async () => {
  const fixture = createFixture({ agent: false });
  const refused = await call(fixture, 'POST', `${BASE}/run/start`, {
    body: { sessionId: 'session-1', name: 'review-changes', args: { target: 'src' } },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, 'session-not-live');
  assert.equal(fixture.calls.some((entry) => entry[0] === 'start'), false);
});

test('POST /run/start refuses to bypass a disabled mode', async () => {
  const fixture = createFixture({ readMode: async () => ({ mode: 'disabled', writable: true, effective: 'immediate' }) });
  const refused = await call(fixture, 'POST', `${BASE}/run/start`, {
    body: { sessionId: 'session-1', name: 'review-changes', args: { target: 'src' } },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'mode_disabled');
});

test('POST /run/start validates saved-workflow arguments before starting', async () => {
  const fixture = createFixture();
  const unknown = await call(fixture, 'POST', `${BASE}/run/start`, {
    body: { sessionId: 'session-1', name: 'review-changes', args: { target: 'src', bogus: true } },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.code, 'invalid-args');
  assert.match(unknown.json.message, /bogus/u);

  const wrongType = await call(fixture, 'POST', `${BASE}/run/start`, {
    body: { sessionId: 'session-1', name: 'review-changes', args: { target: 5 } },
  });
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.json.code, 'invalid-args');
  assert.match(wrongType.json.message, /target/u);
  assert.equal(fixture.calls.some((entry) => entry[0] === 'start'), false);
});

test('POST /run/start starts the saved script with the agent-bound runner and notifies it', async () => {
  const fixture = createFixture();
  const started = await call(fixture, 'POST', `${BASE}/run/start`, {
    body: { sessionId: 'session-1', name: 'review-changes', scope: 'project', args: { target: 'src' } },
  });
  assert.equal(started.status, 200);
  assert.equal(started.json.ok, true);
  assert.equal(started.json.runId, 'run-1');
  assert.equal(started.json.run.id, 'run-1');

  const startCall = fixture.calls.find((entry) => entry[0] === 'start');
  const request = startCall[1];
  assert.equal(request.code, 'return { ok: true };');
  assert.equal(request.name, 'review-changes');
  assert.equal(request.cwd, WORKSPACE);
  assert.equal(request.origin, 'saved');
  assert.deepEqual(request.args, { target: 'src', count: 2 });
  assert.equal(typeof request.runner, 'function');
  assert.equal(typeof request.notify, 'function');

  // The completion notice lands in the session that owns the run.
  request.notify('<workflow-run status="completed" />');
  const followup = fixture.calls.find((entry) => entry[0] === 'followup');
  assert.equal(followup[1].content[0].text, '<workflow-run status="completed" />');
  assert.deepEqual(followup[1].source, { kind: 'user' });
});

/**
 * Run one check with an isolated `$DSH_HOME` so mode persistence never touches the real home.
 * @param {(home: string) => Promise<void>} run
 */
async function withTempHome(run) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zcode-workflow-ui-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await fsp.mkdir(path.join(home, 'zcode-workflow'), { recursive: true });
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await fsp.rm(home, { recursive: true, force: true });
  }
}

/**
 * Apply the plugin against a host that has a web server, a connection fence and no model-side
 * services; model tool registration throws so a disabled-mode leak fails the test.
 * @param {object | undefined} configEditor
 */
function applyWithDataChannel(configEditor) {
  const routes = [];
  const injected = [];
  const silent = { warn() {}, info() {} };
  const child = {
    get: (key) => (key === 'configEditor' ? configEditor : undefined),
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    connection: { requestRejection: () => undefined },
    effect(callback) {
      return callback();
    },
  };
  const ctx = {
    get(key) {
      if (key === 'logger') return silent;
      if (key === 'configEditor') return configEditor;
      return undefined;
    },
    inject(deps, callback) {
      injected.push(deps);
      callback(child);
    },
    effect(callback) {
      return callback();
    },
    tools: {
      register() {
        throw new Error('model-facing tools must stay off while the mode is disabled');
      },
    },
    systemPrompt: {
      section() {
        throw new Error('the prompt section must stay off while the mode is disabled');
      },
    },
  };
  apply(ctx, { mode: 'alwaysOn' });
  return { routes, injected };
}

/**
 * @param {{ method?: string, url: string, body?: unknown }} options
 */
async function callModeRoute(routes, options) {
  const route = routes.find((entry) => entry.path === `${BASE}/mode`);
  assert.ok(route, 'the mode route is registered');
  const headers = options.body === undefined ? {} : { 'content-type': 'application/json' };
  const request = makeRequest({
    method: options.method ?? 'GET',
    url: options.url,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const response = makeResponse();
  await route.handler(request, response);
  return JSON.parse(String(response.body));
}

test('apply keeps the data channel when the stored mode is disabled and leaves model tools off', async () => {
  await withTempHome(async (home) => {
    await fsp.writeFile(
      path.join(home, 'zcode-workflow', 'settings.json'),
      `${JSON.stringify({ mode: 'disabled' })}\n`,
      'utf8',
    );
    const { routes, injected } = applyWithDataChannel(undefined);
    assert.deepEqual(injected, [['webServer', 'connection']]);
    // The stored file outranks the patch config and is reported as a restart-only channel.
    assert.deepEqual(await callModeRoute(routes, { url: `${BASE}/mode` }), {
      mode: 'disabled',
      writable: true,
      effective: 'restart',
    });
  });
});

test('POST /mode persists through configEditor before the reload and drops the fallback file', async () => {
  await withTempHome(async (home) => {
    const settingsFile = path.join(home, 'zcode-workflow', 'settings.json');
    await fsp.writeFile(settingsFile, `${JSON.stringify({ mode: 'disabled' })}\n`, 'utf8');
    const edits = [];
    const configEditor = {
      entries: () => [{ options: { id: 'zcode-workflow', name: 'zcode-workflow', config: { mode: 'disabled' } } }],
      async edit(entry, change) {
        edits.push({ entry, next: change({ mode: 'disabled', maxConcurrency: 4 }, {}) });
      },
    };
    const { routes } = applyWithDataChannel(configEditor);
    const saved = await callModeRoute(routes, { method: 'POST', url: `${BASE}/mode`, body: { mode: 'onDemand' } });
    assert.deepEqual(saved, { mode: 'onDemand', effective: 'immediate' });
    assert.equal(edits.length, 1);
    // The complete raw config is preserved and only the mode changes.
    assert.deepEqual(edits[0].next, { mode: 'onDemand', maxConcurrency: 4 });
    // The stale override is removed before the edit's reload could read it.
    await assert.rejects(fsp.access(settingsFile), /ENOENT/u);
  });
});

test('POST /mode falls back to the settings file when configEditor rejects the edit', async () => {
  await withTempHome(async (home) => {
    const settingsFile = path.join(home, 'zcode-workflow', 'settings.json');
    await fsp.writeFile(settingsFile, `${JSON.stringify({ mode: 'disabled' })}\n`, 'utf8');
    const configEditor = {
      entries: () => [{ options: { id: 'zcode-workflow', name: 'zcode-workflow', config: { mode: 'disabled' } } }],
      async edit() {
        throw new Error('configuration is overridden by a home patch');
      },
    };
    const { routes } = applyWithDataChannel(configEditor);
    const saved = await callModeRoute(routes, { method: 'POST', url: `${BASE}/mode`, body: { mode: 'onDemand' } });
    assert.deepEqual(saved, { mode: 'onDemand', effective: 'restart' });
    assert.deepEqual(JSON.parse(await fsp.readFile(settingsFile, 'utf8')), { mode: 'onDemand' });
    assert.deepEqual(await callModeRoute(routes, { url: `${BASE}/mode` }), {
      mode: 'onDemand',
      writable: true,
      effective: 'restart',
    });
  });
});
