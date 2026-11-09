/**
 * Browser data channel for the workflow UI.
 *
 * The client half is a static Client module: it has no `host.call`, so every catalog read,
 * run action and setting change arrives over these same-origin routes. Trust has one home —
 * `ctx.connection.requestRejection` gates every route before any session, path or body is
 * resolved. Bodies are tiny JSON objects and are validated at the wire.
 *
 * A location (`sessionId` or `projectRoot`) resolves to one project root; `resolveProjectRoot`
 * is injected by `index.js`, which only admits registered workspaces. A request that names no
 * resolvable location is rejected rather than defaulted, because guessing would let the page
 * read another project's runs.
 *
 * A route is keyed by path, not by path+method: the route table throws on a duplicate
 * `(kind, path)`, so one path with a GET and a POST handler is a single registration whose
 * handler dispatches on the method.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createSubagentRunner } from './subagent.js';
import { validateAgainstSchema } from './runtime.js';

const BASE = '/zcode-workflow';
/** Request bodies are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_RUN_LIMIT = 30;
const MAX_RUN_LIMIT = 100;
const MODES = new Set(['disabled', 'onDemand', 'alwaysOn']);
const MODE_ALIASES = new Map([
  ['off', 'disabled'],
  ['onCommand', 'onDemand'],
  ['always', 'alwaysOn'],
]);
const TEXTUAL_CONTENT_TYPE = /^(?:text\/|application\/json$)/u;

/** One rejected request: the wrapper turns it into the uniform `{ code, message }` body. */
class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload === undefined ? null : payload));
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} allow
 */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader('allow', allow);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ code: 'method-not-allowed', message: `use ${allow}` }));
}

/**
 * Read one request header from either a plain node header bag or a Fetch `Headers`.
 * @param {{ headers?: unknown }} request
 * @param {string} name lowercase header name
 * @returns {string | undefined}
 */
function headerOf(request, name) {
  const headers = request?.headers;
  if (headers === null || headers === undefined) return undefined;
  const raw = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  if (typeof raw === 'string') return raw;
  return Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : undefined;
}

/**
 * Collect a bounded body as UTF-8 text; `null` past the ceiling (stream drained).
 * @param {AsyncIterable<Buffer | string> & { resume?: () => void }} req
 * @returns {Promise<string | null>}
 */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume?.();
      return null;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * Parse a JSON object body. Arrays, primitives and malformed text are one rejection.
 * @param {string} text
 * @returns {Record<string, unknown> | undefined}
 */
function parseJsonObject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return parsed;
}

/**
 * Read one string field from a query record or a JSON body. Blank values are absent.
 * @param {Record<string, unknown>} source
 * @param {string} name
 * @returns {string | undefined}
 */
function stringField(source, name) {
  const value = source?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} name
 * @returns {string}
 */
function requiredString(source, name) {
  const value = stringField(source, name);
  if (value === undefined) throw new ApiError(400, 'missing-parameter', `"${name}" is required`);
  return value;
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
function parseRunLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RUN_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError(400, 'bad-parameter', '"limit" must be a positive integer');
  }
  return Math.min(value, MAX_RUN_LIMIT);
}

/**
 * ZCode's mode aliases on the wire; `index.js` normalizes the same set for patch config.
 * @param {unknown} raw
 * @returns {'disabled' | 'onDemand' | 'alwaysOn' | undefined}
 */
function canonicalMode(raw) {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (MODES.has(value)) return /** @type {'disabled' | 'onDemand' | 'alwaysOn'} */ (value);
  return MODE_ALIASES.get(value);
}

/**
 * Project the stored run row onto the fields the browser reads.
 * @param {Record<string, any>} row
 */
function runSummary(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    stopReason: row.stopReason,
    possibleInterruption: row.possibleInterruption === true,
    spentTokens: row.spentTokens,
    labelSource: row.labelSource,
  };
}

/**
 * Project one saved workflow onto the catalog row shape; the script body stays on the Host.
 * @param {Record<string, any>} entry
 */
function savedWorkflow(entry) {
  return {
    name: entry.name,
    scope: entry.scope,
    description: entry.description ?? entry.meta?.description,
    whenToUse: entry.whenToUse ?? entry.meta?.whenToUse,
    args: entry.args ?? entry.meta?.args ?? {},
    path: entry.path,
  };
}

/**
 * Saved-workflow arguments are declarations, while the compiler's validator speaks JSON Schema.
 * `json` declarations accept any value, so their property carries no constraint.
 * @param {Record<string, any>} declarations
 */
function argsSchemaFor(declarations) {
  /** @type {Record<string, object>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];
  for (const [name, declaration] of Object.entries(declarations ?? {})) {
    const type = declaration?.type;
    properties[name] = type === 'number' || type === 'boolean'
      ? { type }
      : type === 'json' ? {} : { type: 'string' };
    if (declaration?.required === true) required.push(name);
  }
  return { type: 'object', additionalProperties: false, properties, required };
}

/**
 * Fill declared defaults before validation, matching the model-facing tools.
 * @param {Record<string, unknown>} supplied
 * @param {Record<string, any>} declarations
 */
function applyArgDefaults(supplied, declarations) {
  const values = { ...supplied };
  for (const [name, declaration] of Object.entries(declarations ?? {})) {
    if (values[name] === undefined && declaration?.default !== undefined) values[name] = declaration.default;
  }
  return values;
}

/**
 * One-line reason a start failed; compiler diagnostics are the common case.
 * @param {{ diagnostics?: any[], error?: string }} started
 * @returns {string}
 */
function describeStartFailure(started) {
  const diagnostics = Array.isArray(started?.diagnostics)
    ? started.diagnostics.filter((entry) => entry?.severity !== 'warning')
    : [];
  if (diagnostics.length > 0) {
    const lines = diagnostics.slice(0, 5).map((entry) => `line ${entry?.line ?? '?'}: ${entry?.message ?? 'invalid script'}`);
    return `the workflow script has errors: ${lines.join('; ')}`;
  }
  return typeof started?.error === 'string' && started.error !== '' ? started.error : 'the workflow could not start';
}

/**
 * @param {object} options
 * @param {object} options.ctx scoped Cordis context carrying `webServer`, `connection` and `effect`
 * @param {(cwd: string) => object} options.storeFor durable store for one project root
 * @param {(cwd: string) => object} options.runtimeFor workflow runtime for one project root
 * @param {(raw: unknown) => Promise<string | undefined>} options.resolveProjectRoot admits only registered workspaces
 * @param {() => Promise<{ mode: string, writable: boolean, effective: string }>} options.readMode
 * @param {(mode: string) => Promise<{ mode: string, effective: string }>} options.writeMode
 * @param {{ warn?: Function }} [options.logger]
 */
export function registerWorkflowUiApi({
  ctx,
  storeFor,
  runtimeFor,
  resolveProjectRoot,
  readMode,
  writeMode,
  logger = console,
}) {
  const webServer = ctx.get?.('webServer') ?? ctx.webServer;
  const connection = ctx.get?.('connection') ?? ctx.connection;
  if (webServer === undefined || connection === undefined) {
    logger.warn?.('zcode-workflow: webServer/connection are unavailable; the browser data channel is not registered');
    return;
  }

  /** @param {string} sessionId */
  const sessionCwd = (sessionId) => {
    // `sessions` is the normal lookup; a live agent also owns its session for profiles that do
    // not mount the store service.
    const session = ctx.get?.('sessions')?.get?.(sessionId) ?? ctx.get?.('agents')?.get?.(sessionId)?.session;
    if (session === undefined) return undefined;
    try {
      const directory = ctx.get?.('workingDirectory')?.get?.(session);
      if (typeof directory === 'string' && directory !== '') return path.resolve(directory);
    } catch {
      // A profile without workingDirectory still has the session's recorded directory.
    }
    const header = session?.header?.cwd;
    return typeof header === 'string' && header !== '' ? path.resolve(header) : undefined;
  };

  /**
   * Resolve a session or project location to the project root its data lives under.
   * @param {Record<string, unknown>} source query record or JSON body
   * @returns {Promise<string>}
   */
  const cwdFrom = async (source) => {
    const sessionId = stringField(source, 'sessionId');
    if (sessionId !== undefined) {
      const found = sessionCwd(sessionId);
      if (found !== undefined) return found;
    }
    const projectRoot = stringField(source, 'projectRoot');
    if (projectRoot !== undefined) {
      const admitted = await resolveProjectRoot(projectRoot);
      if (admitted !== undefined) return admitted;
      throw new ApiError(404, 'project-not-found', `"${projectRoot}" is not a registered workspace`);
    }
    if (sessionId !== undefined) {
      throw new ApiError(404, 'session-not-found', `no live session "${sessionId}"; pass projectRoot for a project view`);
    }
    throw new ApiError(400, 'missing-location', 'sessionId or projectRoot is required');
  };

  /**
   * Send the model-facing completion notice into the session that started the run.
   * @param {object} agent
   * @param {string} text
   */
  const notifyAgent = (agent, text) => {
    try {
      const result = agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } });
      if (result !== undefined && typeof result.catch === 'function') {
        result.catch((error) => logger.warn?.(`zcode-workflow: run notification failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    } catch (error) {
      logger.warn?.(`zcode-workflow: run notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** @type {{ path: string, GET?: Function, POST?: Function }[]} */
  const routes = [
    {
      path: `${BASE}/runs`,
      async GET(req, res, query) {
        const limit = parseRunLimit(query.limit);
        const cwd = await cwdFrom(query);
        // One extra row tells the UI whether the catalog was cut without a second request.
        const rows = await runtimeFor(cwd).listRuns({ project: true, limit: limit + 1 });
        sendJson(res, 200, { runs: rows.slice(0, limit).map(runSummary), truncated: rows.length > limit });
      },
    },
    {
      path: `${BASE}/run`,
      async GET(req, res, query) {
        const runId = requiredString(query, 'runId');
        const cwd = await cwdFrom(query);
        const run = await runtimeFor(cwd).getRun(runId);
        if (run === undefined) throw new ApiError(404, 'run-not-found', `no workflow run "${runId}"`);
        sendJson(res, 200, { run });
      },
    },
    {
      path: `${BASE}/run/stop`,
      async POST(req, res, query, body) {
        const runId = requiredString(body, 'runId');
        const cwd = await cwdFrom(body);
        const run = await runtimeFor(cwd).stopRun(runId, 'user');
        if (run === undefined) throw new ApiError(404, 'run-not-found', `no workflow run "${runId}"`);
        sendJson(res, 200, { ok: true, run });
      },
    },
    {
      path: `${BASE}/run/fill`,
      async POST(req, res, query, body) {
        const runId = requiredString(body, 'runId');
        const holeId = requiredString(body, 'holeId');
        if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
          throw new ApiError(400, 'missing-parameter', '"value" is required (use null for an empty value)');
        }
        const cwd = await cwdFrom(body);
        const runtime = runtimeFor(cwd);
        const filled = await runtime.fillHole(runId, holeId, body.value);
        if (!filled) {
          throw new ApiError(409, 'hole-not-waiting', `run "${runId}" is not in flight or is not waiting at "${holeId}"`);
        }
        sendJson(res, 200, { ok: true, run: await runtime.getRun(runId) });
      },
    },
    {
      path: `${BASE}/run/start`,
      async POST(req, res, query, body) {
        const sessionId = requiredString(body, 'sessionId');
        const name = requiredString(body, 'name');
        const scope = stringField(body, 'scope');
        if (scope !== undefined && scope !== 'project' && scope !== 'global') {
          throw new ApiError(400, 'bad-parameter', '"scope" must be "project" or "global"');
        }
        if (body.args !== undefined && (body.args === null || typeof body.args !== 'object' || Array.isArray(body.args))) {
          throw new ApiError(400, 'bad-parameter', '"args" must be an object');
        }
        // The data channel stays registered while the feature is disabled; starting a run is
        // still gated by the applied mode, so the UI cannot bypass the switch.
        const snapshot = await readMode();
        if (snapshot?.mode === 'disabled') {
          throw new ApiError(409, 'mode_disabled', 'dynamic workflows are disabled in this profile; enable them in settings first');
        }
        const agent = ctx.get?.('agents')?.get?.(sessionId);
        if (agent === undefined) {
          throw new ApiError(400, 'session-not-live', `starting a workflow needs the session that owns it; "${sessionId}" is not live`);
        }
        const cwd = await cwdFrom(body);
        const store = storeFor(cwd);
        const saved = await store.getSavedWorkflow(name, { cwd, ...(scope === undefined ? {} : { scope }) });
        if (saved === undefined) throw new ApiError(404, 'workflow-not-found', `no saved workflow named "${name}"`);
        const declarations = saved.args ?? {};
        const args = applyArgDefaults(/** @type {Record<string, unknown>} */ (body.args ?? {}), declarations);
        const violation = validateAgainstSchema(args, argsSchemaFor(declarations), 'args');
        if (violation !== undefined) throw new ApiError(400, 'invalid-args', violation);
        const runtime = runtimeFor(cwd);
        const askChild = createSubagentRunner({ ctx, logger });
        const started = await runtime.start({
          code: saved.code,
          name,
          cwd,
          args,
          origin: 'saved',
          runner: (request) => askChild({ ...request, agent, cwd }),
          notify: (text) => notifyAgent(agent, text),
        });
        if (!started?.ok) throw new ApiError(400, 'workflow-invalid', describeStartFailure(started));
        const run = await runtime.getRun(started.runId);
        sendJson(res, 200, { ok: true, runId: started.runId, run });
      },
    },
    {
      path: `${BASE}/workflows`,
      async GET(req, res, query) {
        const cwd = await cwdFrom(query);
        const listed = await storeFor(cwd).listSavedWorkflows({ cwd });
        const entries = Array.isArray(listed?.entries) ? listed.entries : Array.isArray(listed) ? listed : [];
        sendJson(res, 200, {
          entries: entries.map(savedWorkflow),
          invalid: Array.isArray(listed?.invalid) ? listed.invalid : [],
        });
      },
    },
    {
      path: `${BASE}/workflows/delete`,
      async POST(req, res, query, body) {
        const name = requiredString(body, 'name');
        const scope = stringField(body, 'scope');
        if (scope !== undefined && scope !== 'project' && scope !== 'global') {
          throw new ApiError(400, 'bad-parameter', '"scope" must be "project" or "global"');
        }
        const cwd = await cwdFrom(body);
        const removed = await storeFor(cwd).deleteSavedWorkflow(name, { cwd, ...(scope === undefined ? {} : { scope }) });
        if (!removed) throw new ApiError(404, 'workflow-not-found', `no saved workflow named "${name}"`);
        sendJson(res, 200, { ok: true });
      },
    },
    {
      path: `${BASE}/workflows/move`,
      async POST(req, res, query, body) {
        const name = requiredString(body, 'name');
        const cwd = await cwdFrom(body);
        const moved = await storeFor(cwd).moveSavedWorkflow(name, { from: 'global', to: 'project', cwd });
        if (!moved?.ok) {
          const status = moved?.reason === 'not_found' ? 404 : moved?.reason === 'invalid_name' ? 400 : 409;
          throw new ApiError(status, moved?.reason ?? 'move-failed', moved?.message ?? `could not move "${name}"`);
        }
        sendJson(res, 200, { ok: true, path: moved.path });
      },
    },
    {
      path: `${BASE}/artifact`,
      async GET(req, res, query) {
        const runId = requiredString(query, 'runId');
        const artifactId = requiredString(query, 'artifactId');
        const rawVersion = query.version;
        let version;
        if (rawVersion !== undefined && rawVersion !== '') {
          version = Number(rawVersion);
          if (!Number.isInteger(version) || version < 1) {
            throw new ApiError(400, 'bad-parameter', '"version" must be a positive integer');
          }
        }
        const cwd = await cwdFrom(query);
        const store = storeFor(cwd);
        const manifest = await store.readArtifactManifest(runId);
        const rows = manifest.filter((row) => row?.id === artifactId);
        if (rows.length === 0) throw new ApiError(404, 'artifact-not-found', `run "${runId}" has no artifact "${artifactId}"`);
        const record = version === undefined ? rows[rows.length - 1] : rows.find((row) => Number(row.version) === version);
        if (record === undefined) throw new ApiError(404, 'artifact-not-found', `artifact "${artifactId}" has no version ${version}`);
        const contentType = typeof record.contentType === 'string' && record.contentType !== ''
          ? record.contentType
          : 'application/octet-stream';
        const payloadVersion = Number(record.version);
        // Text payloads travel as JSON so the UI can render them; binary payloads are served
        // as bytes so an <img> or a download can point at this route directly.
        if (TEXTUAL_CONTENT_TYPE.test(contentType)) {
          let text = typeof record.text === 'string' ? record.text : undefined;
          if (text === undefined) {
            const file = await store.artifactFilePath(runId, artifactId, payloadVersion);
            if (file === undefined) throw new ApiError(404, 'artifact-not-found', `artifact "${artifactId}" has no stored payload`);
            text = await fsp.readFile(file, 'utf8');
          }
          sendJson(res, 200, {
            kind: record.kind,
            contentType,
            text,
            title: record.title,
            version: payloadVersion,
            primary: record.primary === true,
          });
          return;
        }
        const file = await store.artifactFilePath(runId, artifactId, payloadVersion);
        if (file === undefined) throw new ApiError(404, 'artifact-not-found', `artifact "${artifactId}" has no stored payload`);
        res.statusCode = 200;
        res.setHeader('content-type', contentType);
        res.setHeader('cache-control', 'no-store');
        res.end(await fsp.readFile(file));
      },
    },
    {
      path: `${BASE}/mode`,
      async GET(req, res) {
        const snapshot = await readMode();
        sendJson(res, 200, {
          mode: typeof snapshot?.mode === 'string' ? snapshot.mode : 'alwaysOn',
          writable: snapshot?.writable !== false,
          effective: snapshot?.effective === 'restart' ? 'restart' : 'immediate',
        });
      },
      async POST(req, res, query, body) {
        const raw = stringField(body, 'mode');
        if (raw === undefined) throw new ApiError(400, 'missing-parameter', '"mode" is required');
        const next = canonicalMode(raw);
        if (next === undefined) throw new ApiError(400, 'invalid-mode', 'mode must be disabled, onDemand or alwaysOn');
        const saved = await writeMode(next);
        sendJson(res, 200, {
          mode: typeof saved?.mode === 'string' ? saved.mode : next,
          effective: saved?.effective === 'restart' ? 'restart' : 'immediate',
        });
      },
    },
  ];

  /** @param {{ path: string, GET?: Function, POST?: Function }} route */
  const allowedMethods = (route) => (typeof route.GET === 'function' && typeof route.POST === 'function'
    ? 'GET, POST'
    : typeof route.GET === 'function' ? 'GET' : 'POST');

  /**
   * Wrap one route: trust fence, method, body, then the handler's own validation.
   * @param {{ path: string, GET?: Function, POST?: Function }} route
   */
  const wrap = (route) => async (req, res) => {
    try {
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) {
        sendJson(res, rejection, {
          code: rejection === 403 ? 'forbidden' : 'unauthorized',
          message: 'this request is not authorized',
        });
        return;
      }
      const handler = req.method === 'GET' || req.method === 'POST' ? route[req.method] : undefined;
      if (typeof handler !== 'function') {
        sendMethodNotAllowed(res, allowedMethods(route));
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const query = Object.fromEntries(url.searchParams);
      let body;
      if (req.method === 'POST') {
        const mediaType = String(headerOf(req, 'content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
        if (mediaType !== 'application/json') {
          throw new ApiError(415, 'unsupported-media-type', 'content-type must be application/json');
        }
        const text = await readBoundedBody(req);
        if (text === null) throw new ApiError(413, 'payload-too-large', 'request body is too large');
        body = parseJsonObject(text);
        if (body === undefined) throw new ApiError(400, 'bad-request', 'request body must be a JSON object');
      }
      await handler(req, res, query, body);
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.status, { code: error.code, message: error.message });
        return;
      }
      logger.warn?.(`zcode-workflow: ${route.path} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      sendJson(res, 500, { code: 'internal-error', message: 'the request could not be completed' });
    }
  };

  for (const route of routes) {
    const handler = wrap(route);
    const register = () => webServer.register({ kind: 'exact', path: route.path, handler });
    if (typeof ctx.effect === 'function') ctx.effect(register, `zcode-workflow: ${route.path}`);
    else register();
  }
}
