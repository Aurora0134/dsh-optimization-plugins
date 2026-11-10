/**
 * Wire tests for the browser data channel: route table, trust fence, method/body validation,
 * the seven run-data calls, the eight saved-workflow calls, the policy pair, the launch approval
 * broker and the compatibility routes.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { apply } from '../index.js';
import {
  decodedBase64ByteLength,
  projectArtifactFields,
  readArtifactChunk,
  registerWorkflowUiApi,
  truncateNodeResult,
  utf8SafeSlice,
  validateArtifactRead,
} from '../host/ui-api.js';

const BASE = '/zcode-workflow';
// A real absolute directory the Host resolves through realpath without rewriting it.
const WORKSPACE = process.cwd();
const SAVED_PATH = path.join(WORKSPACE, '.dsh', 'workflows', 'review-changes.dwf.ts');
const SAVED_CODE = 'phase("prep");\nreturn { ok: true };';

const ROUTE_PATHS = [
  // §1.1 run data plane
  `${BASE}/runs`,
  `${BASE}/run/events`,
  `${BASE}/run/artifacts`,
  `${BASE}/artifact/data`,
  `${BASE}/artifact/read`,
  `${BASE}/run/workspace`,
  `${BASE}/run/node`,
  // interaction
  `${BASE}/run/approve`,
  `${BASE}/run/stop`,
  `${BASE}/run/configure`,
  `${BASE}/run/resume`,
  `${BASE}/run/fill`,
  `${BASE}/run/answer`,
  // §1.2 saved workflows
  `${BASE}/workflows/list`,
  `${BASE}/workflows/get`,
  `${BASE}/workflows/updateMeta`,
  `${BASE}/workflows/delete`,
  `${BASE}/workflows/move`,
  `${BASE}/workflows/save`,
  `${BASE}/workflows/runs`,
  `${BASE}/workflows/forRun`,
  // §6 policy
  `${BASE}/policy`,
  // compatibility (Lead-approved transition routes)
  `${BASE}/workflows`,
  `${BASE}/run`,
  `${BASE}/run/start`,
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
    code: SAVED_CODE,
  };
  const savedRow = {
    name: saved.name,
    scope: saved.scope,
    description: saved.description,
    whenToUse: saved.whenToUse,
    args: saved.args,
    path: saved.path,
  };
  const savedArtifact = {
    id: 'report',
    kind: 'markdown',
    title: 'Report',
    contentType: 'text/markdown',
    version: 2,
    versions: [
      { version: 1, publishedAt: 1, bytes: 8, uri: 'artifacts/report/v1.md' },
      { version: 2, publishedAt: 2, bytes: 9, uri: 'artifacts/report/v2.md', primary: true },
    ],
    itemCount: 1,
    primary: true,
  };
  const reportEvent = {
    sequence: 3,
    type: 'report',
    payload: {
      type: 'report',
      instance: { siteId: 'site-a', ordinal: 0 },
      item: { kind: 'summary', rows: [{ a: 1 }], long: 'x'.repeat(5000) },
      artifactId: 'report',
    },
  };
  const worldNode = {
    siteId: 'site-a',
    ordinal: 0,
    kind: 'world-run',
    op: 'git',
    args: ['status'],
    status: 'completed',
    summary: { resultBytes: 12, exitCode: 0, stdoutBytes: 10 },
    createdAt: 1,
    updatedAt: 2,
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
    async saveWorkflow(input) {
      calls.push(['saveWorkflow', input]);
      return { ok: true, name: input.name, scope: 'project', path: SAVED_PATH, overwritten: false };
    },
    async updateSavedWorkflowMeta(name, meta, request) {
      calls.push(['updateSavedWorkflowMeta', name, meta, request]);
      return { ok: true, path: SAVED_PATH, scope: 'project' };
    },
    async removeSavedWorkflow(name) {
      calls.push(['removeSavedWorkflow', name]);
      return name === saved.name
        ? { ok: true, path: SAVED_PATH, scope: 'project' }
        : { ok: false, reason: 'not_found' };
    },
    async deleteSavedWorkflow(name) {
      calls.push(['deleteSavedWorkflow', name]);
      return name === saved.name;
    },
    async moveSavedWorkflow(name) {
      calls.push(['moveSavedWorkflow', name]);
      return { ok: true, from: 'global', to: 'project', path: SAVED_PATH };
    },
    async listSavedWorkflowRuns(name, request) {
      calls.push(['listSavedWorkflowRuns', name, request]);
      return { runs: [{ runId: 'run-1', name: saved.name, status: 'running', createdAt: 1, updatedAt: 2, spentTokens: 12, artifacts: [] }], truncated: false };
    },
    async resolveSavedWorkflowForRun(input) {
      calls.push(['resolveSavedWorkflowForRun', input]);
      return { entry: savedRow, match: 'name', runArgs: { target: 'src' } };
    },
    async readArtifactManifest() {
      return [{ id: 'report', kind: 'markdown', version: 1, contentType: 'text/markdown', text: '# report' }];
    },
    async listArtifacts() {
      calls.push(['listArtifacts']);
      return [savedArtifact];
    },
    async readArtifactPayload(runId, artifactId, version) {
      calls.push(['readArtifactPayload', runId, artifactId, version]);
      if (Number(version) === 9) return undefined;
      return { bytes: Buffer.from('abcdef', 'utf8'), mediaType: 'text/plain', totalBytes: 6 };
    },
    async artifactFilePath() {
      return undefined;
    },
    async readEventPage(runId, request) {
      calls.push(['readEventPage', runId, request]);
      return {
        events: [{ sequence: 3, type: 'report', payload: reportEvent.payload }],
        hasMore: true,
        lastEventSequence: 7,
      };
    },
    async readEvents() {
      return [reportEvent];
    },
    async listWorldNodes() {
      calls.push(['listWorldNodes']);
      return { nodes: [worldNode], truncated: false };
    },
    async getNode(runId, siteId, ordinal) {
      calls.push(['getNode', runId, siteId, ordinal]);
      if (siteId !== 'site-a') return undefined;
      return {
        kind: 'world-read',
        status: 'completed',
        result: { exitCode: 0, stdout: 'ok', stderr: '' },
      };
    },
    async getRun(id) {
      calls.push(['getRun', id]);
      return id === 'run-1' ? run : undefined;
    },
    async readRunScript() {
      return SAVED_CODE;
    },
    async listRunsForSession(request) {
      calls.push(['listRunsForSession', request]);
      return [run, { ...run, id: 'run-2' }, { ...run, id: 'run-3' }];
    },
    async projectRun(runId) {
      calls.push(['projectRun', runId]);
      return {
        runId,
        status: 'running',
        phaseNames: ['review', 'ship'],
        currentPhase: 'review',
        phases: [{ name: 'review', rounds: 1 }],
        actors: [{ siteId: 'actor-a', ordinal: 0, status: 'running' }],
        nodes: [],
        holes: [{ siteId: 'site-a', ordinal: 0, name: 'target', state: 'waiting' }],
      };
    },
  };
  const run = {
    id: 'run-1',
    runId: 'run-1',
    toolCallId: 'tool-1',
    name: 'review-changes',
    label: 'review-changes',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    finishedAt: undefined,
    stopReason: undefined,
    possibleInterruption: false,
    spentTokens: 12,
    labelSource: 'saved',
    args: { target: 'src' },
    maxConcurrency: 4,
    scriptPath: path.join(WORKSPACE, '.dsh', 'workflow-drafts', 'review-changes.dwf.ts'),
    steps: { started: 0, settled: 0, failed: 0, running: 0 },
  };
  const runtime = {
    async listRuns(request) {
      calls.push(['listRuns', request]);
      return [run, { ...run, id: 'run-2' }, { ...run, id: 'run-3' }];
    },
    async getRun(id) {
      calls.push(['getRun', id]);
      return id === 'run-1' ? run : undefined;
    },
    async stopRun(id, reason) {
      calls.push(['stopRun', id, reason]);
      return id === run.id ? { ...run, status: 'stopped', stopReason: reason } : undefined;
    },
    configureRun(id, value) {
      calls.push(['configureRun', id, value]);
      return id === run.id
        ? { ok: true, runId: id, caps: { maxConcurrency: value } }
        : { ok: false, code: 'RUN_NOT_FOUND', message: `run_not_found: no workflow run with ID ${id} exists for this project.` };
    },
    async fillHole(id, holeId, value) {
      calls.push(['fillHole', id, holeId, value]);
      return true;
    },
    async resolveQuestion(qid, answer) {
      calls.push(['resolveQuestion', qid, answer]);
      return qid === 'q-1';
    },
    async start(request) {
      calls.push(['start', request]);
      return { ok: true, runId: run.id, phases: ['review'], agents: ['reviewer'] };
    },
  };
  const approval = options.approval === false
    ? undefined
    : {
      settle(input) {
        calls.push(['approval.settle', input]);
        if (input.runId === 'no-pending') return undefined;
        return input.optionId === 'deny'
          ? { decision: 'deny', optionId: 'deny', reason: 'no' }
          : { decision: 'allow', optionId: input.optionId };
      },
      cancel(runId) {
        calls.push(['approval.cancel', runId]);
      },
    };
  const policy = {
    enabled: options.policyEnabled ?? true,
    mode: options.policyMode ?? 'alwaysOn',
    writable: true,
    effective: 'immediate',
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
    readMode: options.readMode ?? (async () => ({ mode: policy.mode, writable: true, effective: 'immediate' })),
    writeMode: options.writeMode ?? (async (mode) => ({ mode, effective: 'immediate' })),
    readPolicy: options.readPolicy ?? (async (scope) => {
      calls.push(['readPolicy', scope]);
      return policy;
    }),
    writePolicy: options.writePolicy ?? (async (next) => {
      calls.push(['writePolicy', next]);
      return { enabled: next.enabled, mode: next.mode ?? (next.enabled ? policy.mode : 'disabled'), effective: 'immediate' };
    }),
    approval,
    logger: { warn() {} },
  });
  return { registered, calls, store, runtime, run, saved, approval };
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

test('GET /runs lists session runs with derived phases and legacy aliases', async () => {
  const fixture = createFixture();
  const missing = await call(fixture, 'GET', `${BASE}/runs`, { query: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'missing-location');

  const listed = await call(fixture, 'GET', `${BASE}/runs`, { query: { sessionId: 'session-1', limit: '2' } });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.runs.length, 2);
  assert.equal(listed.json.truncated, true);
  const [first] = listed.json.runs;
  assert.equal(first.runId, 'run-1');
  assert.equal(first.label, 'review-changes');
  assert.equal(first.toolCallId, 'tool-1');
  assert.equal(first.id, 'run-1');
  assert.equal(first.name, 'review-changes');
  assert.equal(first.possibleInterruption, false);
  assert.deepEqual(first.phases.map((phase) => [phase.name, phase.status]), [['review', 'running'], ['ship', 'pending']]);
  assert.equal(first.agentsWorking, 1);
  assert.equal(first.currentPhase, 'review');
  assert.equal(first.waitingHole, 'target');
  const sessionCall = fixture.calls.find((entry) => entry[0] === 'listRunsForSession');
  assert.equal(sessionCall[1].parentSessionId, 'session-1');
  assert.equal(sessionCall[1].limit, 3);
});

test('GET /runs maps a stale session to the §1 fault string and accepts projectRoot', async () => {
  const fixture = createFixture();
  const stale = await call(fixture, 'GET', `${BASE}/runs`, { query: { sessionId: 'gone' } });
  assert.equal(stale.status, 404);
  assert.equal(stale.json.code, 'fault.workflowRuns.sessionNotFound');
  assert.match(stale.json.message, /^fault\.workflowRuns\.sessionNotFound: gone/u);

  const unregistered = await call(fixture, 'GET', `${BASE}/runs`, { query: { projectRoot: '/elsewhere' } });
  assert.equal(unregistered.status, 404);
  assert.equal(unregistered.json.code, 'project-not-found');

  const byRoot = await call(fixture, 'GET', `${BASE}/runs`, { query: { projectRoot: WORKSPACE } });
  assert.equal(byRoot.status, 200);
  assert.equal(byRoot.json.runs.length, 3);
});

test('GET /run returns the legacy runtime snapshot, requiring runId and a known run', async () => {
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

test('GET /run/events pages after a sequence and reports whether more remain', async () => {
  const fixture = createFixture();
  const page = await call(fixture, 'GET', `${BASE}/run/events`, {
    query: { sessionId: 'session-1', runId: 'run-1', afterSequence: '2', limit: '10' },
  });
  assert.equal(page.status, 200);
  assert.equal(page.json.events[0].sequence, 3);
  assert.equal(page.json.events[0].type, 'report');
  assert.equal(page.json.hasMore, true);
  // 上游回包只有 events + hasMore；水位由快照自带，这里不能多带字段。
  assert.equal('lastEventSequence' in page.json, false);
  const storeCall = fixture.calls.find((entry) => entry[0] === 'readEventPage');
  assert.deepEqual(storeCall[2], { cwd: WORKSPACE, afterSequence: 2, limit: 10 });

  const missing = await call(fixture, 'GET', `${BASE}/run/events`, { query: { sessionId: 'session-1' } });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'missing-parameter');
});

test('GET /run/artifacts returns the artifact ledger', async () => {
  const fixture = createFixture();
  const listed = await call(fixture, 'GET', `${BASE}/run/artifacts`, {
    query: { sessionId: 'session-1', runId: 'run-1' },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.artifacts.length, 1);
  assert.equal(listed.json.artifacts[0].id, 'report');
  assert.equal(listed.json.artifacts[0].version, 2);
  assert.equal(listed.json.artifacts[0].itemCount, 1);
  assert.equal(listed.json.artifacts[0].primary, true);
});

test('GET /artifact/data pages report events and projects requested fields', async () => {
  const fixture = createFixture();
  const page = await call(fixture, 'GET', `${BASE}/artifact/data`, {
    query: {
      sessionId: 'session-1',
      runId: 'run-1',
      artifactId: 'report',
      afterSequence: '2',
      fields: 'kind,rows',
    },
  });
  assert.equal(page.status, 200);
  assert.equal(page.json.items.length, 1);
  assert.equal(page.json.items[0].sequence, 3);
  assert.equal(page.json.items[0].siteId, 'site-a');
  // 投影读取只回投影后的字段，不回整条 item。
  assert.equal('item' in page.json.items[0], false);
  assert.deepEqual(page.json.items[0].fields, {
    kind: 'summary',
    rows: [{ a: 1 }],
  });

  const long = projectArtifactFields({ text: 'x'.repeat(5000) }, ['text']);
  assert.equal(Buffer.byteLength(String(long.text), 'utf8') <= 4096, true);
  assert.equal(String(long.text).endsWith('\u2026'), true);

  const invalid = await call(fixture, 'GET', `${BASE}/artifact/data`, {
    query: { sessionId: 'session-1', runId: 'run-1', artifactId: 'report', fields: 'a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,aa,bb,cc,dd,ee,ff,gg' },
  });
  assert.equal(invalid.status, 400);
});

test('GET /artifact/read slices bytes and clamps offsets', async () => {
  const fixture = createFixture();
  const chunk = await call(fixture, 'GET', `${BASE}/artifact/read`, {
    query: {
      sessionId: 'session-1',
      runId: 'run-1',
      artifactId: 'report',
      version: '2',
      offset: '2',
      limit: '2',
    },
  });
  assert.equal(chunk.status, 200);
  assert.equal(chunk.json.dataBase64, Buffer.from('cd').toString('base64'));
  assert.equal(chunk.json.mediaType, 'text/plain');
  assert.equal(chunk.json.totalBytes, 6);
  assert.equal(chunk.json.nextOffset, 4);

  const tail = await call(fixture, 'GET', `${BASE}/artifact/read`, {
    query: {
      sessionId: 'session-1',
      runId: 'run-1',
      artifactId: 'report',
      version: '2',
      offset: '99',
      limit: '2',
    },
  });
  assert.equal(tail.status, 200);
  assert.equal(tail.json.dataBase64, '');
  assert.equal(tail.json.nextOffset, null);

  const missing = await call(fixture, 'GET', `${BASE}/artifact/read`, {
    query: { sessionId: 'session-1', runId: 'run-1', artifactId: 'report', version: '9', offset: '0', limit: '2' },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'fault.workflowRunArtifactRead.notFound');
  assert.match(missing.json.message, /^fault\.workflowRunArtifactRead\.notFound: run-1\/report@9/u);

  const oversized = await call(fixture, 'GET', `${BASE}/artifact/read`, {
    query: { sessionId: 'session-1', runId: 'run-1', artifactId: 'report', version: '2', offset: '0', limit: String(512 * 1024 + 1) },
  });
  assert.equal(oversized.status, 400);
});

test('GET /run/workspace returns world-operation nodes', async () => {
  const fixture = createFixture();
  const workspace = await call(fixture, 'GET', `${BASE}/run/workspace`, {
    query: { sessionId: 'session-1', runId: 'run-1' },
  });
  assert.equal(workspace.status, 200);
  assert.equal(workspace.json.nodes.length, 1);
  assert.equal(workspace.json.nodes[0].op, 'git');
  assert.deepEqual(workspace.json.nodes[0].args, ['status']);
  assert.equal(workspace.json.nodes[0].status, 'completed');
});

test('GET /run/node returns the §8 result and its truncation metadata', async () => {
  const fixture = createFixture();
  const node = await call(fixture, 'GET', `${BASE}/run/node`, {
    query: { sessionId: 'session-1', runId: 'run-1', siteId: 'site-a', ordinal: '0' },
  });
  assert.equal(node.status, 200);
  assert.equal(node.json.status, 'completed');
  assert.deepEqual(node.json.result, { exitCode: 0, stdout: 'ok', stderr: '' });
  assert.equal(node.json.truncated, false);
  assert.equal(typeof node.json.totalBytes, 'number');

  const unknown = await call(fixture, 'GET', `${BASE}/run/node`, {
    query: { sessionId: 'session-1', runId: 'run-1', siteId: 'site-z', ordinal: '0' },
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'fault.workflowRunNodeResult.notFound');
});

test('POST /run/approve settles the launch confirmation through the broker', async () => {
  const fixture = createFixture();
  const allowed = await call(fixture, 'POST', `${BASE}/run/approve`, {
    body: { sessionId: 'session-1', runId: 'run-1', optionId: 'allow_once', freeText: 'go' },
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.json, { ok: true, decision: { decision: 'allow', optionId: 'allow_once' } });
  const settleCall = fixture.calls.find((entry) => entry[0] === 'approval.settle');
  assert.deepEqual(settleCall[1], { runId: 'run-1', optionId: 'allow_once', reason: 'go', adjustments: undefined });

  const unknownOption = await call(fixture, 'POST', `${BASE}/run/approve`, {
    body: { sessionId: 'session-1', runId: 'run-1', optionId: 'maybe' },
  });
  assert.equal(unknownOption.status, 400);
  assert.equal(unknownOption.json.code, 'fault.workflowRunApprove.unknownOption');

  const noPending = await call(fixture, 'POST', `${BASE}/run/approve`, {
    body: { sessionId: 'session-1', runId: 'no-pending', optionId: 'deny' },
  });
  assert.equal(noPending.status, 404);
  assert.equal(noPending.json.code, 'fault.workflowRunApprove.noPending');

  const unavailable = createFixture({ approval: false });
  const refused = await call(unavailable, 'POST', `${BASE}/run/approve`, {
    body: { sessionId: 'session-1', runId: 'run-1', optionId: 'allow_once' },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'fault.workflowRunApprove.unavailable');

  const stale = await call(fixture, 'POST', `${BASE}/run/approve`, {
    body: { sessionId: 'gone', runId: 'run-1', optionId: 'allow_once' },
  });
  assert.equal(stale.status, 404);
  assert.equal(stale.json.code, 'fault.workflowRunApprove.sessionNotFound');
});

test('POST /run/stop stops through the runtime and cancels a pending approval', async () => {
  const fixture = createFixture();
  const stopped = await call(fixture, 'POST', `${BASE}/run/stop`, {
    body: { sessionId: 'session-1', runId: 'run-1' },
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.ok, true);
  assert.equal(stopped.json.run.status, 'stopped');
  const stopCall = fixture.calls.find((entry) => entry[0] === 'stopRun');
  assert.deepEqual(stopCall, ['stopRun', 'run-1', 'user']);
  assert.ok(fixture.calls.some((entry) => entry[0] === 'approval.cancel' && entry[1] === 'run-1'));
});

test('POST /run/configure retunes a running run and rejects a non-integer bound', async () => {
  const fixture = createFixture();
  const retuned = await call(fixture, 'POST', `${BASE}/run/configure`, {
    body: { sessionId: 'session-1', runId: 'run-1', maxConcurrency: 6 },
  });
  assert.equal(retuned.status, 200);
  assert.equal(retuned.json.ok, true);
  assert.deepEqual(retuned.json.caps, { maxConcurrency: 6 });
  assert.deepEqual(fixture.calls.find((entry) => entry[0] === 'configureRun'), ['configureRun', 'run-1', 6]);

  const fractional = await call(fixture, 'POST', `${BASE}/run/configure`, {
    body: { sessionId: 'session-1', runId: 'run-1', maxConcurrency: 2.5 },
  });
  assert.equal(fractional.status, 400);
  assert.equal(fractional.json.code, 'invalid-request');

  const unknown = await call(fixture, 'POST', `${BASE}/run/configure`, {
    body: { sessionId: 'session-1', runId: 'run-9', maxConcurrency: 3 },
  });
  assert.equal(unknown.status, 404);
});

test('POST /run/fill now takes script/path instead of a raw value', async () => {
  const fixture = createFixture();
  const filled = await call(fixture, 'POST', `${BASE}/run/fill`, {
    body: { sessionId: 'session-1', runId: 'run-1', holeId: 'hole-1', script: 'return 42;' },
  });
  assert.equal(filled.status, 200);
  assert.equal(filled.json.ok, true);
  const fillCall = fixture.calls.find((entry) => entry[0] === 'fillHole');
  assert.deepEqual(fillCall, ['fillHole', 'run-1', 'hole-1', { script: 'return 42;' }]);

  const missing = await call(fixture, 'POST', `${BASE}/run/fill`, {
    body: { sessionId: 'session-1', runId: 'run-1' },
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'missing-parameter');
});

test('POST /run/answer forwards to runtime.resolveQuestion', async () => {
  const fixture = createFixture();
  const answered = await call(fixture, 'POST', `${BASE}/run/answer`, {
    body: { sessionId: 'session-1', qid: 'q-1', answer: 'yes' },
  });
  assert.equal(answered.status, 200);
  assert.deepEqual(fixture.calls.find((entry) => entry[0] === 'resolveQuestion'), ['resolveQuestion', 'q-1', 'yes']);

  const notPending = await call(fixture, 'POST', `${BASE}/run/answer`, {
    body: { sessionId: 'session-1', qid: 'q-2', answer: 'yes' },
  });
  assert.equal(notPending.status, 409);
  assert.equal(notPending.json.code, 'fault.workflowRunAnswer.notPending');
});

test('POST /run/resume restarts a stopped run from its stored script', async () => {
  const fixture = createFixture();
  fixture.run.status = 'stopped';
  const resumed = await call(fixture, 'POST', `${BASE}/run/resume`, {
    body: { sessionId: 'session-1', runId: 'run-1' },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.json.ok, true);
  assert.equal(resumed.json.runId, 'run-1');
  const startCall = fixture.calls.find((entry) => entry[0] === 'start');
  assert.equal(startCall[1].resumedFrom, 'run-1');
  assert.equal(startCall[1].code, SAVED_CODE);
  assert.equal(typeof startCall[1].runner, 'function');

  fixture.run.status = 'completed';
  const notResumable = await call(fixture, 'POST', `${BASE}/run/resume`, {
    body: { sessionId: 'session-1', runId: 'run-1' },
  });
  assert.equal(notResumable.status, 409);
  assert.equal(notResumable.json.code, 'fault.workflowRunResume.notResumable');
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

test('GET /workflows/list projects saved entries without their script body', async () => {
  const fixture = createFixture();
  const listed = await call(fixture, 'GET', `${BASE}/workflows/list`, { query: { projectRoot: WORKSPACE } });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.workflows.length, 1);
  const [entry] = listed.json.workflows;
  assert.equal(entry.name, 'review-changes');
  assert.equal(entry.scope, 'project');
  assert.equal(entry.description, 'Review changes');
  assert.deepEqual(entry.args, fixture.saved.args);
  assert.equal('code' in entry, false);
  // §1.2 #1: the list response always names the directory the entries came from.
  assert.equal(listed.json.dir, path.join(WORKSPACE, '.dsh', 'workflows'));
  assert.equal(listed.json.invalid.length, 1);
  assert.deepEqual(listed.json.entries, listed.json.workflows);

  const legacy = await call(fixture, 'GET', `${BASE}/workflows`, { query: { projectRoot: WORKSPACE } });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.json.entries.length, 1);
});

test('GET /workflows/get returns the script; unknown names return the not_found union', async () => {
  const fixture = createFixture();
  const found = await call(fixture, 'GET', `${BASE}/workflows/get`, {
    query: { projectRoot: WORKSPACE, name: 'review-changes' },
  });
  assert.equal(found.status, 200);
  assert.equal(found.json.ok, true);
  assert.equal(found.json.script, fixture.saved.code);
  assert.equal(found.json.meta.description, 'Review changes');

  const missing = await call(fixture, 'GET', `${BASE}/workflows/get`, {
    query: { projectRoot: WORKSPACE, name: 'missing' },
  });
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.json, { ok: false, reason: 'not_found' });
});

test('POST /workflows/save reads the run script, compiles it and saves', async () => {
  const fixture = createFixture();
  const saved = await call(fixture, 'POST', `${BASE}/workflows/save`, {
    body: {
      projectRoot: WORKSPACE,
      runId: 'run-1',
      name: 'review-changes',
      meta: { description: 'Review changes' },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.path, SAVED_PATH);
  const saveCall = fixture.calls.find((entry) => entry[0] === 'saveWorkflow');
  assert.equal(saveCall[1].runId, 'run-1');
  assert.equal(saveCall[1].code, SAVED_CODE);

  // An empty description is legal (the contract requires the key, not a non-empty value); a
  // non-string is not.
  const emptyDescription = await call(fixture, 'POST', `${BASE}/workflows/save`, {
    body: { projectRoot: WORKSPACE, runId: 'run-1', name: 'x', meta: { description: '' }, overwrite: true },
  });
  assert.equal(emptyDescription.status, 200);

  const badMeta = await call(fixture, 'POST', `${BASE}/workflows/save`, {
    body: { projectRoot: WORKSPACE, runId: 'run-1', name: 'x', meta: { description: 5 } },
  });
  assert.equal(badMeta.status, 400);
});

test('POST /workflows/delete, /move, /updateMeta, GET /runs and /forRun use the store', async () => {
  const fixture = createFixture();
  const deleted = await call(fixture, 'POST', `${BASE}/workflows/delete`, {
    body: { projectRoot: WORKSPACE, name: 'review-changes', scope: 'project' },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.ok, true);
  assert.equal(deleted.json.path, SAVED_PATH);

  const unknown = await call(fixture, 'POST', `${BASE}/workflows/delete`, {
    body: { projectRoot: WORKSPACE, name: 'missing' },
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'workflow-not-found');

  const moved = await call(fixture, 'POST', `${BASE}/workflows/move`, {
    body: { projectRoot: WORKSPACE, name: 'review-changes' },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.from, 'global');
  assert.equal(moved.json.to, 'project');
  assert.equal(moved.json.path, SAVED_PATH);

  const updated = await call(fixture, 'POST', `${BASE}/workflows/updateMeta`, {
    body: { projectRoot: WORKSPACE, name: 'review-changes', meta: { description: 'Updated' } },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.ok, true);
  assert.equal(updated.json.path, SAVED_PATH);

  const runs = await call(fixture, 'GET', `${BASE}/workflows/runs`, {
    query: { projectRoot: WORKSPACE, name: 'review-changes', limit: '10' },
  });
  assert.equal(runs.status, 200);
  assert.equal(runs.json.runs[0].runId, 'run-1');
  assert.equal(runs.json.runs[0].spentTokens, 12);

  const forRun = await call(fixture, 'GET', `${BASE}/workflows/forRun`, {
    query: { projectRoot: WORKSPACE, runId: 'run-1', candidates: 'review-changes' },
  });
  assert.equal(forRun.status, 200);
  assert.equal(forRun.json.match, 'name');
  assert.equal(forRun.json.entry.name, 'review-changes');
  assert.deepEqual(forRun.json.runArgs, { target: 'src' });
});

test('GET/POST /policy read and write through the injected policy channel', async () => {
  const fixture = createFixture({ policyMode: 'onDemand', policyEnabled: true });
  const snapshot = await call(fixture, 'GET', `${BASE}/policy`, { query: { projectRoot: WORKSPACE } });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.json.enabled, true);
  assert.equal(snapshot.json.mode, 'onDemand');
  assert.equal(snapshot.json.writable, true);
  assert.deepEqual(fixture.calls.find((entry) => entry[0] === 'readPolicy'), ['readPolicy', { projectRoot: WORKSPACE }]);

  const disabled = await call(fixture, 'POST', `${BASE}/policy`, {
    body: { projectRoot: WORKSPACE, enabled: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.enabled, false);
  assert.equal(disabled.json.mode, 'disabled');
  assert.deepEqual(fixture.calls.find((entry) => entry[0] === 'writePolicy'), ['writePolicy', { projectRoot: WORKSPACE, enabled: false }]);

  const badMode = await call(fixture, 'POST', `${BASE}/policy`, {
    body: { projectRoot: WORKSPACE, enabled: true, mode: 'sometimes' },
  });
  assert.equal(badMode.status, 400);
  assert.equal(badMode.json.code, 'invalid-mode');
});

test('GET/POST /mode keep the compatibility shape', async () => {
  const fixture = createFixture({
    readMode: async () => ({ mode: 'onDemand', writable: false, effective: 'restart' }),
  });
  const snapshot = await call(fixture, 'GET', `${BASE}/mode`);
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.json, { mode: 'onDemand', writable: false, effective: 'restart' });

  const written = [];
  const modeFixture = createFixture({
    writeMode: async (mode) => {
      written.push(mode);
      return { mode, effective: 'restart' };
    },
  });
  const saved = await call(modeFixture, 'POST', `${BASE}/mode`, { body: { mode: 'off' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { mode: 'disabled', effective: 'restart' });
  assert.deepEqual(written, ['disabled']);
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
  assert.equal(request.code, SAVED_CODE);
  assert.equal(request.name, 'review-changes');
  assert.equal(request.cwd, WORKSPACE);
  assert.equal(request.origin, 'saved');
  assert.deepEqual(request.args, { target: 'src', count: 2 });
  assert.equal(typeof request.runner, 'function');
  assert.equal(typeof request.notify, 'function');

  request.notify('<workflow-run status="completed" />');
  const followup = fixture.calls.find((entry) => entry[0] === 'followup');
  assert.equal(followup[1].content[0].text, '<workflow-run status="completed" />');
  assert.equal(followup[1].role, 'user');
  assert.equal(typeof followup[1].id, 'string');
  assert.ok(followup[1].id.length > 0);
  assert.deepEqual(followup[1].source, { kind: 'user' });
});

test('GET /artifact keeps the legacy text payload shape', async () => {
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

/* ---------------------------------------------------------------------------------------------- */
/* artifact / node result helpers                                                                  */
/* ---------------------------------------------------------------------------------------------- */

test('base64 byte-length detection follows Tm exactly', () => {
  assert.equal(decodedBase64ByteLength(''), 0);
  assert.equal(decodedBase64ByteLength('YQ=='), 1);
  assert.equal(decodedBase64ByteLength('YWI='), 2);
  assert.equal(decodedBase64ByteLength('YWJj'), 3);
  assert.equal(decodedBase64ByteLength('A'), null);
  assert.equal(decodedBase64ByteLength('!!!!'), null);
  assert.equal(decodedBase64ByteLength('YWJj='), null);
});

test('artifact read chunking clamps the offset and reports nextOffset', () => {
  const bytes = Buffer.from('abcdef', 'utf8');
  assert.deepEqual(readArtifactChunk({ bytes, mediaType: 'text/plain', offset: 2, limit: 2 }), {
    dataBase64: Buffer.from('cd').toString('base64'),
    mediaType: 'text/plain',
    totalBytes: 6,
    nextOffset: 4,
  });
  assert.deepEqual(readArtifactChunk({ bytes, mediaType: 'text/plain', offset: 99, limit: 2 }), {
    dataBase64: '',
    mediaType: 'text/plain',
    totalBytes: 6,
    nextOffset: null,
  });
});

test('artifact read validation uses the §7.3 messages', () => {
  const valid = {
    dataBase64: Buffer.from('abc').toString('base64'),
    totalBytes: 3,
    nextOffset: null,
  };
  assert.equal(validateArtifactRead(valid), undefined);
  assert.equal(validateArtifactRead({ ...valid, dataBase64: '!!!' }), 'invalid base64');
  assert.equal(
    validateArtifactRead({ ...valid, dataBase64: Buffer.alloc(512 * 1024 + 1).toString('base64'), totalBytes: 512 * 1024 + 1 }),
    'workflow artifact read chunk exceeds decoded byte limit',
  );
  assert.equal(validateArtifactRead({ ...valid, totalBytes: 20 * 1024 * 1024 + 1 }), 'Too big: expected number to be <=20971520');
  assert.equal(validateArtifactRead({ ...valid, nextOffset: 4 }), 'nextOffset exceeds totalBytes');
});

test('utf8SafeSlice never emits half a code point', () => {
  assert.equal(utf8SafeSlice('abc', 3), 'abc');
  assert.equal(utf8SafeSlice('你好世界', 4), '你');
  // 4 字节 emoji 被截断时整体丢弃，不产生 U+FFFD。
  assert.equal(utf8SafeSlice('a😀', 3), 'a');
});

test('node result truncation follows the four §8 strategies', () => {
  const small = truncateNodeResult({ answer: 42 });
  assert.deepEqual(small, { result: { answer: 42 }, truncated: false, totalBytes: Buffer.byteLength('{"answer":42}') });

  const text = truncateNodeResult('x'.repeat(100), 10);
  assert.equal(text.truncated, true);
  assert.equal(text.result, 'x'.repeat(10));
  // totalBytes 是完整 JSON 的字节数（字符串带引号），不是原始文本长度。
  assert.equal(text.totalBytes, Buffer.byteLength(JSON.stringify('x'.repeat(100))));

  // 每个元素占「JSON 字节 + 1 个逗号」，首元素也不例外：预算 5 只放得下 `[1]`。
  const array = truncateNodeResult([1, 2, 3, 4, 5], 5);
  assert.equal(array.truncated, true);
  assert.deepEqual(array.result, [1]);
  assert.equal(array.totalBytes, Buffer.byteLength('[1,2,3,4,5]'));

  const command = truncateNodeResult({ exitCode: 0, stdout: 'x'.repeat(100), stderr: 'y'.repeat(100) }, 50);
  assert.equal(command.truncated, true);
  assert.equal(command.result.exitCode, 0);
  assert.ok(Buffer.byteLength(command.result.stdout) + Buffer.byteLength(command.result.stderr) <= 50);
  assert.equal(command.totalBytes, Buffer.byteLength(JSON.stringify({ exitCode: 0, stdout: 'x'.repeat(100), stderr: 'y'.repeat(100) })));

  const object = truncateNodeResult({ long: 'x'.repeat(100) }, 10);
  assert.equal(object.truncated, true);
  assert.equal(typeof object.result, 'string');
  assert.equal(object.result.length, 10);
});

/* ---------------------------------------------------------------------------------------------- */
/* mode persistence through index.js                                                               */
/* ---------------------------------------------------------------------------------------------- */

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

test('POST /run/configure：三种 retune 拒绝各有自己的码，客户端才能给不同文案', async () => {
  const fixture = createFixture();
  const { runtime } = fixture;
  const real = runtime.configureRun;
  const cases = [
    ['CAPS_UNCHANGED', 409, 'retune_unchanged'],
    ['RUN_NOT_ACTIVE', 409, 'run_settled'],
    ['RUN_NOT_FOUND', 404, 'run_not_found'],
  ];
  try {
    for (const [code, status, expected] of cases) {
      runtime.configureRun = () => ({ ok: false, code, message: `${code}: simulated` });
      const answer = await call(fixture, 'POST', `${BASE}/run/configure`, {
        body: { sessionId: 'session-1', runId: 'run-1', maxConcurrency: 5 },
      });
      assert.equal(answer.status, status, code);
      assert.equal(answer.json.code, expected, code);
    }
  } finally {
    runtime.configureRun = real;
  }
});
