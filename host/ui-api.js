/**
 * Browser data channel for the workflow UI.
 *
 * Route names mirror ZCode 3.17.2's workflow RPC surface one-for-one (see docs/port-contract.md):
 * the seven run-data calls, the eight saved-workflow calls and the workspace policy. The client
 * half (`client-src/10-api.js`) is the fixed counterpart, so a path or parameter name here must not
 * drift from it.
 *
 * Trust has one home — `ctx.connection.requestRejection` gates every route before any session,
 * path or body is resolved. A location (`sessionId` or `projectRoot`) resolves to one project root;
 * `resolveProjectRoot` is injected by `index.js`, which only admits registered workspaces.
 *
 * Errors follow §1/§7.3: data-plane failures carry the ZCode fault string as `code` and as the
 * message prefix (`fault.workflowRunEvents.sessionNotFound: <id>`), while body/parameter mistakes
 * stay `bad-parameter` so the client can tell a contract violation from a missing run.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { APPROVAL_OPTIONS } from './approval.js';
import { compileWorkflowScript } from './compiler.js';
import { pageEvents } from './journal.js';
import { userMessage } from './messages.js';
import { derivePhaseStates, isRunActive } from './phase-state.js';
import { isResumable } from './resumability.js';
import { createSubagentRunner } from './subagent.js';

const BASE = '/zcode-workflow';
/** Request bodies are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_RUN_LIMIT = 16;
const MAX_RUN_LIMIT = 64;
const DEFAULT_EVENT_LIMIT = 500;
const MAX_EVENT_LIMIT = 500;
const DEFAULT_ARTIFACT_ITEM_LIMIT = 200;
const MAX_ARTIFACT_ITEM_LIMIT = 500;
const DEFAULT_RUNS_FOR_WORKFLOW = 20;
const MAX_RUNS_FOR_WORKFLOW = 50;
const MODES = new Set(['disabled', 'onDemand', 'alwaysOn']);
const MODE_ALIASES = new Map([
  ['off', 'disabled'],
  ['onCommand', 'onDemand'],
  ['always', 'alwaysOn'],
]);
const TEXTUAL_CONTENT_TYPE = /^(?:text\/|application\/json$)/u;
/** §7.2：单次 artifact 读取上限 512 KiB，总量上限 20 MiB。 */
export const ATTACHMENT_CHUNK_MAX_BYTES = 512 * 1024;
/** §7.3 `attachmentMaxBytes`。 */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** §8 `M3.resultMaxBytes`。 */
export const NODE_RESULT_MAX_BYTES = 32 * 1024;
/** §2.5 artifact data 的单页字节预算（4 MiB），与事件分页一致。 */
const ARTIFACT_PAGE_MAX_BYTES = 4 * 1024 * 1024;
/** §2.5 `fields` 模式：单字段值超过 4096 字节时截断。 */
const MAX_FIELD_VALUE_BYTES = 4096;

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
 * Build an error whose code and message both carry the ZCode fault identifier.
 *
 * @param {number} status
 * @param {string} fault e.g. `fault.workflowRunEvents.sessionNotFound`
 * @param {string} [detail]
 */
function fault(status, faultName, detail) {
  const message = detail === undefined ? faultName : `${faultName}: ${detail}`;
  return new ApiError(status, faultName, message);
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
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
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
 * Parse one integer parameter from a query string or JSON body.
 *
 * @param {Record<string, unknown>} source
 * @param {string} name
 * @param {{ min?: number, max?: number, fallback?: number, required?: boolean }} [options]
 * @returns {number | undefined}
 */
function intField(source, name, options = {}) {
  const raw = source?.[name];
  if (raw === undefined || raw === null || raw === '') {
    if (options.required === true) throw new ApiError(400, 'missing-parameter', `"${name}" is required`);
    return options.fallback;
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value)) throw new ApiError(400, 'bad-parameter', `"${name}" must be an integer`);
  if (options.min !== undefined && value < options.min) {
    throw new ApiError(400, 'bad-parameter', `"${name}" must be >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new ApiError(400, 'bad-parameter', `"${name}" must be <= ${options.max}`);
  }
  return value;
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
 * Project the stored run row onto the wire summary (`dSs`, §1.1(1)) while keeping the aliases the
 * plugin's own UI already reads.
 * @param {Record<string, any>} row
 */
function runSummary(row) {
  const runId = row.runId ?? row.id;
  return {
    runId,
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
    label: row.label ?? row.name ?? runId,
    ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
    status: row.status,
    ...(row.stopReason === undefined ? {} : { stopReason: row.stopReason }),
    ...(row.resumedFrom === undefined ? {} : { resumedFrom: row.resumedFrom }),
    ...(row.supersededBy === undefined ? {} : { supersededBy: row.supersededBy }),
    ...(row.failureCode === undefined ? {} : { failureCode: row.failureCode }),
    ...(row.failureMessage === undefined ? {} : { failureMessage: row.failureMessage }),
    resumable: isResumable(row.status, row.stopReason),
    // Legacy aliases used by the plugin's status panel and directory.
    id: row.id ?? runId,
    name: row.name ?? row.label ?? runId,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    possibleInterruption: row.possibleInterruption === true,
    spentTokens: row.spentTokens,
    labelSource: row.labelSource,
  };
}

/**
 * Project one saved workflow onto the catalogue row shape; the script body stays on the Host.
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
 * Normalize one `invalid` catalogue row onto §1.2's reason enum
 * (`invalid_name|not_found|parse_error|read_error`).
 *
 * @param {{ path?: string, reason?: string }} row
 */
function invalidWorkflowRow(row) {
  const reason = typeof row?.reason === 'string' ? row.reason : '';
  const code = /usable workflow name/u.test(reason)
    ? 'invalid_name'
    : /could not be read/u.test(reason)
      ? 'read_error'
      : 'parse_error';
  return {
    ...(typeof row?.path === 'string' ? { path: row.path } : {}),
    reason: code,
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
 * Validate a value against the JSON-Schema subset compiled declarations use.
 *
 * The HTTP layer deliberately does not import the engine just to validate saved-workflow args:
 * the engine is replaceable, and a malformed option must never be able to take the data channel
 * down with it. The rules mirror `host/runtime.js`'s validator for this subset.
 *
 * @param {unknown} value
 * @param {Record<string, any>} schema
 * @param {string} [path]
 * @returns {string | undefined} first violation, or undefined
 */
function validateArgsSchema(value, schema, path = '') {
  if (schema === true || schema === undefined) return undefined;
  const at = path === '' ? 'the value' : path;
  if (schema.type === 'string') return typeof value === 'string' ? undefined : `${at} must be a string`;
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? undefined : `${at} must be a finite number`;
  if (schema.type === 'integer') return Number.isInteger(value) ? undefined : `${at} must be an integer`;
  if (schema.type === 'boolean') return typeof value === 'boolean' ? undefined : `${at} must be a boolean`;
  if (schema.type === 'null') return value === null ? undefined : `${at} must be null`;
  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(value) ? undefined : `${at} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${at} must be an array`;
    for (let index = 0; index < value.length; index += 1) {
      const violation = validateArgsSchema(value[index], schema.items ?? {}, `${path}[${index}]`);
      if (violation !== undefined) return violation;
    }
    return undefined;
  }
  if (schema.type === 'object' || schema.properties !== undefined) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${at} must be an object`;
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) return `${at}.${key} is required`;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) return `${at}.${key} is not a declared field`;
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (value[key] === undefined) continue;
      const violation = validateArgsSchema(value[key], propertySchema, `${path}.${key}`);
      if (violation !== undefined) return violation;
    }
  }
  return undefined;
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

/* ---------------------------------------------------------------------------------------------- */
/* artifact / node result helpers (exported for unit tests)                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * UTF-8 safe truncation: keep complete code points only, dropping an incomplete trailing sequence.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function utf8SafeSlice(text, maxBytes) {
  const source = String(text ?? '');
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return source;
  let output = '';
  let used = 0;
  for (const character of source) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > maxBytes) break;
    output += character;
    used += size;
  }
  return output;
}

/**
 * Decode the base64 byte length exactly like §7.3's `Tm`: `null` means invalid.
 *
 * @param {string} value
 * @returns {number | null}
 */
export function decodedBase64ByteLength(value) {
  const text = String(value ?? '');
  if (text.length === 0) return 0;
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) return null;
  const padding = text.endsWith('==') ? 2 : (text.endsWith('=') ? 1 : 0);
  return (text.length / 4) * 3 - padding;
}

/**
 * Slice one artifact payload into the §7.2 response. `offset` past the end clamps to the tail
 * instead of failing; `nextOffset` is the next absolute start, or `null` at the end.
 *
 * @param {{ bytes: Buffer, mediaType: string, offset: number, limit: number }} input
 * @returns {{ dataBase64: string, mediaType: string, totalBytes: number, nextOffset: number | null }}
 */
export function readArtifactChunk({ bytes, mediaType, offset, limit }) {
  const totalBytes = bytes.byteLength;
  const start = Math.min(Math.max(0, offset), totalBytes);
  const end = Math.min(start + limit, totalBytes);
  const chunk = bytes.subarray(start, end);
  return {
    dataBase64: Buffer.from(chunk).toString('base64'),
    mediaType,
    totalBytes,
    nextOffset: end < totalBytes ? end : null,
  };
}

/**
 * Validate an artifact-read response against §7.3. Returns the first issue message, else undefined.
 *
 * @param {{ dataBase64: unknown, totalBytes: unknown, nextOffset: unknown }} payload
 * @returns {string | undefined}
 */
export function validateArtifactRead(payload) {
  const totalBytes = Number(payload?.totalBytes);
  if (!Number.isInteger(totalBytes) || totalBytes < 0) return 'totalBytes must be a non-negative integer';
  // 上游把 20 MiB 上限交给 zod `.max()`，默认文案会代入实参（20971520），这里逐字复刻。
  if (totalBytes > ATTACHMENT_MAX_BYTES) return 'Too big: expected number to be <=20971520';
  const decoded = decodedBase64ByteLength(String(payload?.dataBase64 ?? ''));
  if (decoded === null) return 'invalid base64';
  if (decoded > ATTACHMENT_CHUNK_MAX_BYTES) return 'workflow artifact read chunk exceeds decoded byte limit';
  const nextOffset = payload?.nextOffset;
  if (nextOffset !== null && nextOffset !== undefined) {
    if (!Number.isInteger(nextOffset) || nextOffset <= 0) return 'nextOffset must be a positive integer or null';
    if (nextOffset > totalBytes) return 'nextOffset exceeds totalBytes';
  }
  return undefined;
}

/**
 * Node result truncation (§8 `Dyc`). `totalBytes` is always the UTF-8 byte length of the complete
 * JSON encoding, so the UI can honestly say "1.2 MB, truncated".
 *
 * @param {unknown} result
 * @param {number} [maxBytes]
 * @returns {{ result?: unknown, truncated: boolean, totalBytes: number }}
 */
export function truncateNodeResult(result, maxBytes = NODE_RESULT_MAX_BYTES) {
  const budget = Math.max(1, Math.min(Math.floor(maxBytes), NODE_RESULT_MAX_BYTES));
  let json;
  try {
    json = JSON.stringify(result);
  } catch {
    json = undefined;
  }
  const totalBytes = Buffer.byteLength(json ?? String(result), 'utf8');
  if (json !== undefined && totalBytes <= budget) return { result, truncated: false, totalBytes };

  if (typeof result === 'string') {
    return { result: utf8SafeSlice(result, budget), truncated: true, totalBytes };
  }
  if (Array.isArray(result)) {
    // 预算里预留 2 字节给 `[]` 与逗号（§8）。
    const items = [];
    let used = 2;
    for (const item of result) {
      const text = JSON.stringify(item) ?? 'null';
      // 每个元素都占「JSON 字节 + 1 个逗号」，首元素也不例外（§8 `Dyc`）。
      const cost = Buffer.byteLength(text, 'utf8') + 1;
      if (used + cost > budget) break;
      items.push(item);
      used += cost;
    }
    return { result: items, truncated: items.length < result.length, totalBytes };
  }
  if (
    result !== null
    && typeof result === 'object'
    && typeof result.exitCode === 'number'
    && typeof result.stdout === 'string'
    && typeof result.stderr === 'string'
  ) {
    const skeleton = JSON.stringify({ ...result, stdout: '', stderr: '' });
    const remaining = Math.max(0, budget - Buffer.byteLength(skeleton, 'utf8'));
    const stdoutBytes = Buffer.byteLength(result.stdout, 'utf8');
    const stderrBytes = Buffer.byteLength(result.stderr, 'utf8');
    const stderrBudget = Math.min(stderrBytes, Math.max(remaining >> 1, remaining - stdoutBytes));
    const stdoutBudget = Math.max(0, remaining - stderrBudget);
    return {
      result: {
        ...result,
        stdout: utf8SafeSlice(result.stdout, stdoutBudget),
        stderr: utf8SafeSlice(result.stderr, stderrBudget),
      },
      truncated: true,
      totalBytes,
    };
  }
  // 其它 object：返回 JSON 字符串而不是对象，保证前端能展示片段。
  const text = json ?? String(result);
  return { result: utf8SafeSlice(text, budget), truncated: true, totalBytes };
}

/**
 * Resolve one dot path inside a JSON value (`a.b[0].c` / `a.0.c`).
 * @param {unknown} value
 * @param {string} pathText
 */
function readFieldPath(value, pathText) {
  let current = value;
  for (const segment of String(pathText).split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * `artifact/data` 的 `fields` 隐藏能力（§2.5）：按字段路径裁剪；单值超过 4096 字节时以省略号收尾。
 *
 * @param {unknown} item
 * @param {string[]} fields
 * @returns {Record<string, unknown>}
 */
export function projectArtifactFields(item, fields) {
  /** @type {Record<string, unknown>} */
  const output = {};
  for (const field of fields) {
    const value = readFieldPath(item, field);
    if (value === undefined) continue;
    const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
    output[field] = Buffer.byteLength(text, 'utf8') > MAX_FIELD_VALUE_BYTES
      ? `${utf8SafeSlice(text, MAX_FIELD_VALUE_BYTES - Buffer.byteLength('\u2026', 'utf8'))}\u2026`
      : value;
  }
  return output;
}

/**
 * Normalize a flat or envelope event into `{sequence, type, payload}`.
 * @param {Record<string, any>} event
 * @param {number} index
 */
function normalizeEvent(event, index) {
  if (event !== null && typeof event === 'object' && event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
    return {
      sequence: Number.isInteger(event.sequence) && event.sequence >= 0 ? event.sequence : index,
      type: typeof event.type === 'string' ? event.type : (typeof event.payload.type === 'string' ? event.payload.type : 'log'),
      payload: event.payload,
    };
  }
  return {
    sequence: Number.isInteger(event?.sequence) && event.sequence >= 0 ? event.sequence : index,
    type: typeof event?.type === 'string' ? event.type : 'log',
    payload: event ?? {},
  };
}

/**
 * @param {object} options
 * @param {object} options.ctx scoped Cordis context carrying `webServer`, `connection` and `effect`
 * @param {(cwd: string) => object} options.storeFor durable store for one project root
 * @param {(cwd: string) => object} options.runtimeFor workflow runtime for one project root
 * @param {(raw: unknown) => Promise<string | undefined>} options.resolveProjectRoot admits only registered workspaces
 * @param {() => Promise<{ mode: string, writable: boolean, effective: string }>} options.readMode
 * @param {(mode: string) => Promise<{ mode: string, effective: string }>} options.writeMode
 * @param {() => Promise<{ enabled: boolean, mode: string }>} [options.readPolicy] workspace policy reader (index.js)
 * @param {(input: { projectRoot: string, enabled: boolean, mode?: string }) => Promise<{ enabled: boolean, mode: string }>} [options.writePolicy]
 * @param {object} [options.approval] launch-confirmation broker (`host/approval.js`)
 * @param {object} [options.config] 插件配置（子代理 provider/model 等），数据面启动的运行同样要吃
 * @param {{ warn?: Function }} [options.logger]
 */
export function registerWorkflowUiApi({
  ctx,
  storeFor,
  runtimeFor,
  resolveProjectRoot,
  readMode,
  writeMode,
  readPolicy,
  writePolicy,
  approval,
  config = {},
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
   * Resolve a location for a data-plane route and translate a stale session into the ZCode fault
   * string for that RPC (§1.1). Session ownership is the same check every other route uses.
   *
   * @param {Record<string, unknown>} source
   * @param {string} faultName e.g. `fault.workflowRunEvents.sessionNotFound`
   * @returns {Promise<string>}
   */
  const cwdForData = async (source, faultName) => {
    try {
      return await cwdFrom(source);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'session-not-found') {
        const sessionId = stringField(source, 'sessionId');
        throw fault(404, faultName, sessionId);
      }
      throw error;
    }
  };

  /**
   * Send the model-facing completion notice into the session that started the run.
   * @param {object} agent
   * @param {string} text
   */
  const notifyAgent = (agent, text) => {
    try {
      const result = agent.followup(userMessage(text));
      if (result !== undefined && typeof result.catch === 'function') {
        result.catch((error) => logger.warn?.(`zcode-workflow: run notification failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    } catch (error) {
      logger.warn?.(`zcode-workflow: run notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** @param {{ projectRoot?: string, sessionId?: string }} source @param {string} faultName */
  const requireRunLocation = async (source, faultName) => cwdForData(source, faultName);

  /** @param {string} cwd */
  const storeAt = (cwd) => storeFor(cwd);

  /**
   * All journal events for one run, regardless of whether the caller uses a runtime or the store.
   *
   * @param {string} cwd
   * @param {string} runId
   * @returns {Promise<Record<string, any>[]>}
   */
  const readAllEvents = async (cwd, runId) => {
    const store = storeAt(cwd);
    if (typeof store.readEvents === 'function') {
      const rows = await store.readEvents(runId, { cwd });
      return (Array.isArray(rows) ? rows : []).map(normalizeEvent);
    }
    return [];
  };

  /**
   * `workflowRunEvents` page, preferring the journal-backed store method.
   *
   * @param {string} cwd
   * @param {string} runId
   * @param {{ afterSequence?: number, limit?: number }} options
   */
  const eventPageFor = async (cwd, runId, options) => {
    const store = storeAt(cwd);
    if (typeof store.readEventPage === 'function') {
      const page = await store.readEventPage(runId, { cwd, ...options });
      return {
        events: (page?.events ?? []).map((event) => ({
          sequence: event.sequence,
          type: event.type,
          payload: event.payload,
        })),
        hasMore: page?.hasMore === true,
        lastEventSequence: Number.isInteger(page?.lastEventSequence) ? page.lastEventSequence : 0,
      };
    }
    const events = await readAllEvents(cwd, runId);
    const page = pageEvents(events, options);
    return {
      events: page.events.map((event) => ({ sequence: event.sequence, type: event.type, payload: event.payload })),
      hasMore: page.hasMore,
      lastEventSequence: page.lastEventSequence,
    };
  };

  /**
   * Enrich one run summary with the derived phase ladder and the number of working subagents.
   * Both are cheap once the journal is read and keep the directory and the detail pane consistent.
   *
   * @param {string} cwd
   * @param {Record<string, any>} row
   */
  const enrichRunSummary = async (cwd, row) => {
    const summary = runSummary(row);
    summary.phases = [];
    summary.agentsWorking = 0;
    const store = storeAt(cwd);
    if (typeof store.projectRun !== 'function') return summary;
    try {
      const snapshot = await store.projectRun(summary.runId, { cwd });
      if (snapshot === undefined) return summary;
      summary.phases = derivePhaseStates(snapshot);
      summary.agentsWorking = (snapshot.actors ?? []).filter((actor) => actor.status === 'running').length;
      if (typeof snapshot.currentPhase === 'string') summary.currentPhase = snapshot.currentPhase;
      // 留白只对活跃 run 有意义：已结束的 run 里残留的 waiting 留白不再算待答。
      if (isRunActive(snapshot.status)) {
        const waitingHole = (snapshot.holes ?? []).find((hole) => hole.state === 'waiting');
        if (waitingHole !== undefined && typeof waitingHole.name === 'string') summary.waitingHole = waitingHole.name;
      }
    } catch (error) {
      // A corrupt journal must not take the whole run list down; the summary stays usable.
      logger.warn?.(`zcode-workflow: could not project run ${summary.runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return summary;
  };

  /** @type {{ path: string, GET?: Function, POST?: Function }[]} */
  const routes = [
    /* ------------------------------ run data plane (§1.1) ---------------------------------- */
    {
      path: `${BASE}/runs`,
      async GET(req, res, query) {
        const sessionId = stringField(query, 'sessionId');
        const cwd = sessionId === undefined
          ? await cwdFrom(query)
          : await cwdForData(query, 'fault.workflowRuns.sessionNotFound');
        const limit = intField(query, 'limit', { min: 1, max: MAX_RUN_LIMIT, fallback: DEFAULT_RUN_LIMIT });
        const store = storeAt(cwd);
        let rows;
        if (typeof store.listRunsForSession === 'function') {
          rows = await store.listRunsForSession({
            cwd,
            ...(sessionId === undefined ? {} : { parentSessionId: sessionId }),
            limit: limit + 1,
          });
        } else {
          rows = await runtimeFor(cwd).listRuns({ project: true, limit: limit + 1 });
        }
        const page = rows.slice(0, limit);
        // 前端运行目录用新字段：runId/label/phases/agentsWorking。阶段状态必须服务端算，
        // 否则列表和详情会对同一 run 给出不同阶段（§3.3 Wm）。
        const summaries = [];
        for (const row of page) summaries.push(await enrichRunSummary(cwd, row));
        sendJson(res, 200, {
          runs: summaries,
          ...(rows.length > limit ? { truncated: true } : {}),
        });
      },
    },
    {
      path: `${BASE}/run/events`,
      async GET(req, res, query) {
        const runId = requiredString(query, 'runId');
        const cwd = await requireRunLocation(query, 'fault.workflowRunEvents.sessionNotFound');
        const afterSequence = intField(query, 'afterSequence', { min: 0, fallback: undefined });
        const limit = intField(query, 'limit', { min: 1, max: MAX_EVENT_LIMIT, fallback: DEFAULT_EVENT_LIMIT });
        const page = await eventPageFor(cwd, runId, { afterSequence, limit });
        sendJson(res, 200, {
          events: page.events,
          hasMore: page.hasMore,
        });
      },
    },
    {
      path: `${BASE}/run/artifacts`,
      async GET(req, res, query) {
        const runId = requiredString(query, 'runId');
        const cwd = await requireRunLocation(query, 'fault.workflowRunArtifacts.sessionNotFound');
        const store = storeAt(cwd);
        let artifacts = [];
        if (typeof store.listArtifacts === 'function') {
          artifacts = await store.listArtifacts(runId, { cwd });
        } else if (typeof store.readArtifactManifest === 'function') {
          const manifest = await store.readArtifactManifest(runId);
          artifacts = artifactsFromManifest(manifest);
        }
        sendJson(res, 200, { artifacts });
      },
    },
    {
      path: `${BASE}/artifact/data`,
      async GET(req, res, query) {
        const runId = requiredString(query, 'runId');
        const artifactId = requiredString(query, 'artifactId');
        const cwd = await requireRunLocation(query, 'fault.workflowRunArtifactData.sessionNotFound');
        const afterSequence = intField(query, 'afterSequence', { min: 0, fallback: undefined });
        const limit = intField(query, 'limit', { min: 1, max: MAX_ARTIFACT_ITEM_LIMIT, fallback: DEFAULT_ARTIFACT_ITEM_LIMIT });
        const fields = readFields(query.fields);
        const events = (await readAllEvents(cwd, runId))
          .filter((event) => event.type === 'report' && event.payload?.artifactId === artifactId)
          .filter((event) => afterSequence === undefined || event.sequence > afterSequence)
          .sort((left, right) => left.sequence - right.sequence);
        const items = [];
        let bytes = 0;
        let hasMore = false;
        for (let index = 0; index < events.length; index += 1) {
          const event = events[index];
          const item = event.payload?.item;
          const size = Buffer.byteLength(JSON.stringify(item ?? null) ?? 'null', 'utf8');
          if (index > 0 && (index + 1 > limit || bytes + size > ARTIFACT_PAGE_MAX_BYTES)) {
            hasMore = true;
            break;
          }
          const instance = event.payload?.instance;
          const siteId = typeof instance?.siteId === 'string' ? instance.siteId : (typeof event.payload?.siteId === 'string' ? event.payload.siteId : '');
          const ordinal = Number.isInteger(instance?.ordinal)
            ? instance.ordinal
            : (Number.isInteger(event.payload?.ordinal) ? event.payload.ordinal : 0);
          items.push({
            sequence: event.sequence,
            siteId,
            ordinal,
            // §2.5 fields 模式：只回投影字段，完整 item 不再下传，带宽优化才成立。
            ...(fields === undefined
              ? { item }
              : { fields: projectArtifactFields(item, fields) }),
          });
          bytes += size;
        }
        sendJson(res, 200, { items, hasMore });
      },
    },
    {
      path: `${BASE}/artifact/read`,
      async GET(req, res, query) {
        const runId = requiredString(query, 'runId');
        const artifactId = requiredString(query, 'artifactId');
        const cwd = await requireRunLocation(query, 'fault.workflowRunArtifactRead.sessionNotFound');
        const version = intField(query, 'version', { min: 1, max: 16, required: true });
        const offset = intField(query, 'offset', { min: 0, required: true });
        const limit = intField(query, 'limit', { min: 1, max: ATTACHMENT_CHUNK_MAX_BYTES, required: true });
        const store = storeAt(cwd);
        let payload;
        if (typeof store.readArtifactPayload === 'function') {
          payload = await store.readArtifactPayload(runId, artifactId, version);
        } else if (typeof store.artifactFilePath === 'function') {
          const file = await store.artifactFilePath(runId, artifactId, version);
          if (file !== undefined) {
            const bytes = await fsp.readFile(file).catch(() => undefined);
            if (bytes !== undefined) payload = { bytes, mediaType: 'application/octet-stream', totalBytes: bytes.byteLength };
          }
        }
        if (payload === undefined) {
          throw fault(404, 'fault.workflowRunArtifactRead.notFound', `${runId}/${artifactId}@${version}`);
        }
        if (payload.totalBytes > ATTACHMENT_MAX_BYTES) {
          // 同 validateArtifactRead：上限 20 MiB，文案代入 zod `.max()` 的实参。
          throw new ApiError(400, 'invalid-request', 'Too big: expected number to be <=20971520');
        }
        const response = readArtifactChunk({
          bytes: payload.bytes,
          mediaType: payload.mediaType ?? 'application/octet-stream',
          offset,
          limit,
        });
        const issue = validateArtifactRead(response);
        if (issue !== undefined) throw new ApiError(400, 'invalid-request', issue);
        sendJson(res, 200, response);
      },
    },
    {
      path: `${BASE}/run/workspace`,
      async GET(req, res, query) {
        const runId = requiredString(query, 'runId');
        const cwd = await requireRunLocation(query, 'fault.workflowRunWorkspace.sessionNotFound');
        const store = storeAt(cwd);
        if (typeof store.listWorldNodes === 'function') {
          const listed = await store.listWorldNodes(runId, { cwd });
          sendJson(res, 200, {
            nodes: Array.isArray(listed?.nodes) ? listed.nodes : [],
            ...(listed?.truncated === true ? { truncated: true } : {}),
          });
          return;
        }
        if (typeof store.readEvents !== 'function') {
          sendJson(res, 200, { nodes: [], unavailable: true });
          return;
        }
        sendJson(res, 200, { nodes: workspaceNodesFromEvents(await readAllEvents(cwd, runId)) });
      },
    },
    {
      path: `${BASE}/run/node`,
      async GET(req, res, query) {
        const runId = requiredString(query, 'runId');
        const siteId = requiredString(query, 'siteId');
        const ordinal = intField(query, 'ordinal', { min: 0, required: true });
        const maxBytes = intField(query, 'maxBytes', { min: 1, max: NODE_RESULT_MAX_BYTES, fallback: NODE_RESULT_MAX_BYTES });
        const cwd = await requireRunLocation(query, 'fault.workflowRunNodeResult.sessionNotFound');
        const store = storeAt(cwd);
        const node = typeof store.getNode === 'function'
          ? await store.getNode(runId, siteId, ordinal, { cwd })
          : undefined;
        if (node === undefined || (node.kind !== 'world-read' && node.kind !== 'world-run')) {
          throw fault(404, 'fault.workflowRunNodeResult.notFound', `${runId}/${siteId}@${ordinal}`);
        }
        sendJson(res, 200, nodeResultPayload(node, maxBytes));
      },
    },

    /* --------------------------- run interaction (UI actions) ------------------------------ */
    {
      path: `${BASE}/run/approve`,
      async POST(req, res, query, body) {
        const sessionId = requiredString(body, 'sessionId');
        const runId = requiredString(body, 'runId');
        const optionId = requiredString(body, 'optionId');
        // Session ownership first: a browser tab may only answer for a live, resolvable Session.
        await cwdForData(body, 'fault.workflowRunApprove.sessionNotFound');
        if (!APPROVAL_OPTIONS.includes(optionId)) {
          throw new ApiError(400, 'fault.workflowRunApprove.unknownOption', `fault.workflowRunApprove.unknownOption: ${optionId}`);
        }
        if (approval === undefined || typeof approval.settle !== 'function') {
          throw new ApiError(409, 'fault.workflowRunApprove.unavailable', 'fault.workflowRunApprove.unavailable');
        }
        const decision = approval.settle({
          runId,
          optionId,
          reason: stringField(body, 'freeText'),
          adjustments: body.adjustments,
        });
        if (decision === undefined) {
          throw new ApiError(404, 'fault.workflowRunApprove.noPending', `fault.workflowRunApprove.noPending: ${runId}`);
        }
        void sessionId;
        sendJson(res, 200, { ok: true, decision });
      },
    },
    {
      path: `${BASE}/run/configure`,
      async POST(req, res, query, body) {
        const runId = requiredString(body, 'runId');
        const cwd = await cwdFrom(body);
        const rawLimit = body?.maxConcurrency;
        const limit = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit);
        if (!Number.isFinite(limit) || limit < 1 || Math.floor(limit) !== limit) {
          throw new ApiError(400, 'invalid-request', 'maxConcurrency must be a positive integer');
        }
        const runtime = runtimeFor(cwd);
        if (typeof runtime.configureRun !== 'function') {
          throw new ApiError(409, 'run-settings-unsupported', 'this runtime cannot retune a running run');
        }
        const result = runtime.configureRun(runId, limit);
        if (result?.ok === false) {
          const status = result.code === 'RUN_NOT_FOUND' ? 404 : (result.code === 'RUN_NOT_ACTIVE' ? 409 : 400);
          throw new ApiError(status, 'run-settings-failed', result.message ?? `could not retune "${runId}"`);
        }
        sendJson(res, 200, { ok: true, caps: result?.caps, run: await runtime.getRun(runId) });
      },
    },
    {
      path: `${BASE}/run/stop`,
      async POST(req, res, query, body) {
        const runId = requiredString(body, 'runId');
        const cwd = await cwdFrom(body);
        const runtime = runtimeFor(cwd);
        const result = await runtime.stopRun(runId, 'user');
        if (result === undefined) throw new ApiError(404, 'run-not-found', `no workflow run "${runId}"`);
        if (result?.ok === false) {
          const status = result.code === 'RUN_NOT_FOUND' ? 404 : (result.code === 'RUN_SETTLED' ? 409 : 400);
          throw new ApiError(status, result.code === 'RUN_SETTLED' ? 'run-settled' : 'run-not-found', result.message ?? `could not stop "${runId}"`);
        }
        try {
          // Stopping a run that is still waiting for launch confirmation must not strand the tool.
          approval?.cancel?.(runId, 'the run was stopped before it was confirmed');
        } catch {
          // cancel is best-effort; the stop above already succeeded
        }
        // The engine returns `{ok:true, runId, stopReason}`; older runtimes return the run snapshot.
        const run = result?.run
          ?? (result?.status !== undefined || result?.id !== undefined ? result : await runtime.getRun(runId));
        sendJson(res, 200, { ok: true, run });
      },
    },
    {
      path: `${BASE}/run/resume`,
      async POST(req, res, query, body) {
        const runId = requiredString(body, 'runId');
        const sessionId = requiredString(body, 'sessionId');
        const cwd = await cwdFrom(body);
        const runtime = runtimeFor(cwd);
        const previous = await runtime.getRun(runId);
        if (previous === undefined) throw new ApiError(404, 'run-not-found', `no workflow run "${runId}"`);
        if (previous.status !== 'stopped') {
          throw new ApiError(409, 'fault.workflowRunResume.notResumable', `fault.workflowRunResume.notResumable: ${runId} is ${previous.status}`);
        }
        const agent = ctx.get?.('agents')?.get?.(sessionId);
        if (agent === undefined) {
          throw new ApiError(400, 'session-not-live', `resuming a workflow needs the session that owns it; "${sessionId}" is not live`);
        }
        const runner = (request) => createSubagentRunner({ ctx, logger, config })({ ...request, agent, cwd });
        const notify = (text) => notifyAgent(agent, text);
        // The engine owns resume semantics (same run id, replay settled nodes); only fall back to
        // a fresh start when an older runtime has no resumeRun.
        if (typeof runtime.resumeRun === 'function') {
          const resumed = await runtime.resumeRun(runId, { runner, notify, sessionId });
          if (resumed?.ok === false) {
            const code = resumed.code === 'RUN_NOT_FOUND'
              ? 'fault.workflowRunResume.notFound'
              : resumed.code === 'NOT_RESUMABLE'
                ? 'fault.workflowRunResume.notResumable'
                : 'fault.workflowRunResume.failed';
            const status = resumed.code === 'RUN_NOT_FOUND' ? 404 : (resumed.code === 'NOT_RESUMABLE' ? 409 : 400);
            throw new ApiError(status, code, `${code}: ${resumed.message ?? runId}`);
          }
          const resumedId = typeof resumed?.runId === 'string' ? resumed.runId : runId;
          sendJson(res, 200, { ok: true, runId: resumedId, run: await runtime.getRun(resumedId) });
          return;
        }
        const store = storeAt(cwd);
        let code = typeof store.readRunScript === 'function' ? await store.readRunScript(runId, { cwd }) : undefined;
        if (code === undefined && typeof previous.scriptPath === 'string') {
          code = await fsp.readFile(previous.scriptPath, 'utf8').catch(() => undefined);
        }
        if (typeof code !== 'string' || code === '') {
          throw new ApiError(409, 'fault.workflowRunResume.scriptMissing', `fault.workflowRunResume.scriptMissing: ${runId}`);
        }
        const started = await runtime.start({
          code,
          scriptPath: previous.scriptPath,
          name: String(body.name ?? previous.name),
          cwd,
          args: previous.args ?? {},
          maxConcurrency: previous.maxConcurrency,
          subagentModel: previous.subagentModel,
          resumedFrom: previous.id,
          origin: 'resume',
          runner,
          notify,
        });
        if (!started?.ok) throw new ApiError(400, 'workflow-invalid', describeStartFailure(started));
        sendJson(res, 200, { ok: true, runId: started.runId, run: await runtime.getRun(started.runId) });
      },
    },
    {
      path: `${BASE}/run/fill`,
      async POST(req, res, query, body) {
        const runId = requiredString(body, 'runId');
        const holeId = requiredString(body, 'holeId');
        const cwd = await cwdFrom(body);
        const runtime = runtimeFor(cwd);
        // ZCode 3.17.2 的 hole 值是脚本/文件输入，不再是任意 JSON：`{script?, path?}`。
        const payload = {
          ...(typeof body.script === 'string' ? { script: body.script } : {}),
          ...(typeof body.path === 'string' ? { path: body.path } : {}),
        };
        const filled = await runtime.fillHole(runId, holeId, payload);
        const failed = filled === false || (filled !== null && typeof filled === 'object' && filled.ok === false);
        if (failed) {
          const code = typeof filled === 'object' && filled?.code === 'RUN_NOT_FOUND'
            ? 'fault.workflowRunFill.runNotFound'
            : 'fault.workflowRunFill.notWaiting';
          const status = code === 'fault.workflowRunFill.runNotFound' ? 404 : 409;
          throw new ApiError(status, code, `${code}: ${runId}/${holeId}`);
        }
        sendJson(res, 200, { ok: true, run: await runtime.getRun(runId) });
      },
    },
    {
      path: `${BASE}/run/answer`,
      async POST(req, res, query, body) {
        const qid = requiredString(body, 'qid');
        if (!Object.prototype.hasOwnProperty.call(body, 'answer')) {
          throw new ApiError(400, 'missing-parameter', '"answer" is required (use null for an empty answer)');
        }
        const cwd = await cwdFrom(body);
        const runtime = runtimeFor(cwd);
        if (typeof runtime.resolveQuestion !== 'function') {
          throw new ApiError(409, 'fault.workflowRunAnswer.unavailable', 'fault.workflowRunAnswer.unavailable');
        }
        const resolved = await runtime.resolveQuestion(qid, body.answer);
        const resolvedOk = resolved === true
          || (resolved !== null && typeof resolved === 'object' && resolved.ok === true);
        if (!resolvedOk) {
          const code = 'fault.workflowRunAnswer.notPending';
          throw new ApiError(409, code, `${code}: ${qid}`);
        }
        sendJson(res, 200, { ok: true });
      },
    },

    /* ------------------------------ saved workflows (§1.2) ---------------------------------- */
    {
      path: `${BASE}/workflows/list`,
      async GET(req, res, query) {
        const cwd = await cwdFrom(query);
        const scope = workflowScope(query.scope);
        const store = storeFor(cwd);
        const listed = await store.listSavedWorkflows({ cwd, ...(scope === undefined ? {} : { scope }) });
        const entries = Array.isArray(listed?.entries) ? listed.entries : Array.isArray(listed) ? listed : [];
        const workflows = entries.map(savedWorkflow);
        const invalid = Array.isArray(listed?.invalid) ? listed.invalid : [];
        // §1.2 #1 响应带必填 dir：目录页用它显示归档位置，也用于打开工作流文件。
        const dir = scope === 'global'
          ? (typeof store.paths?.globalSavedDir === 'function' ? store.paths.globalSavedDir() : path.join(cwd, '.dsh', 'workflows'))
          : (typeof store.paths?.projectSavedDir === 'function' ? store.paths.projectSavedDir(cwd) : path.join(cwd, '.dsh', 'workflows'));
        sendJson(res, 200, {
          workflows,
          entries: workflows,
          invalid: invalid.map(invalidWorkflowRow),
          dir,
        });
      },
    },
    {
      path: `${BASE}/workflows/get`,
      async GET(req, res, query) {
        const name = requiredString(query, 'name');
        const scope = workflowScope(query.scope);
        const cwd = await cwdFrom(query);
        const entry = await storeFor(cwd).getSavedWorkflow(name, { cwd, ...(scope === undefined ? {} : { scope }) });
        if (entry === undefined) {
          sendJson(res, 200, {
            ok: false,
            reason: /^[A-Za-z0-9_.-]{1,64}$/u.test(name) ? 'not_found' : 'invalid_name',
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          name: entry.name,
          path: entry.path,
          scope: entry.scope,
          meta: {
            description: entry.description,
            ...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
            ...(entry.args === undefined ? {} : { args: entry.args }),
          },
          script: entry.code,
        });
      },
    },
    {
      path: `${BASE}/workflows/updateMeta`,
      async POST(req, res, query, body) {
        const name = requiredString(body, 'name');
        const meta = readWorkflowMeta(body.meta);
        const scope = workflowScope(body.scope);
        const cwd = await cwdFrom(body);
        const store = storeFor(cwd);
        if (typeof store.updateSavedWorkflowMeta === 'function') {
          const result = await store.updateSavedWorkflowMeta(name, meta, { cwd, ...(scope === undefined ? {} : { scope }) });
          sendJson(res, 200, result);
          return;
        }
        // 没有扩展方法时退回读改写；解析失败不覆盖原文件。
        const entry = await store.getSavedWorkflow(name, { cwd, ...(scope === undefined ? {} : { scope }) });
        if (entry === undefined) {
          sendJson(res, 200, { ok: false, reason: 'not_found' });
          return;
        }
        const saved = await store.saveSavedWorkflow({
          cwd,
          name,
          scope: entry.scope,
          code: entry.code,
          meta: { ...entry.meta, ...meta },
        });
        sendJson(res, 200, saved.ok ? { ok: true, path: saved.path } : { ok: false, reason: 'write_error', detail: saved.message });
      },
    },
    {
      path: `${BASE}/workflows/delete`,
      async POST(req, res, query, body) {
        const name = requiredString(body, 'name');
        const scope = workflowScope(body.scope);
        const cwd = await cwdFrom(body);
        const store = storeFor(cwd);
        if (typeof store.removeSavedWorkflow === 'function') {
          const result = await store.removeSavedWorkflow(name, { cwd, ...(scope === undefined ? {} : { scope }) });
          if (!result.ok) {
            const status = result.reason === 'invalid_name' ? 400 : 404;
            sendJson(res, status, {
              ok: false,
              reason: result.reason,
              code: result.reason === 'invalid_name' ? 'invalid-name' : 'workflow-not-found',
              message: result.reason === 'invalid_name' ? 'the workflow name is not valid' : `no saved workflow named "${name}"`,
            });
            return;
          }
          sendJson(res, 200, result);
          return;
        }
        const removed = await store.deleteSavedWorkflow(name, { cwd, ...(scope === undefined ? {} : { scope }) });
        if (!removed) {
          sendJson(res, 404, { ok: false, reason: 'not_found', code: 'workflow-not-found', message: `no saved workflow named "${name}"` });
          return;
        }
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
          sendJson(res, status, {
            ok: false,
            reason: moved?.reason ?? 'move_failed',
            code: moved?.reason === 'not_found' ? 'workflow-not-found' : (moved?.reason ?? 'move-failed'),
            message: moved?.message ?? `could not move "${name}"`,
            detail: moved?.message,
          });
          return;
        }
        sendJson(res, 200, { ok: true, from: moved.from, to: moved.to, path: moved.path });
      },
    },
    {
      path: `${BASE}/workflows/save`,
      async POST(req, res, query, body) {
        const name = requiredString(body, 'name');
        const runId = requiredString(body, 'runId');
        const cwd = await cwdFrom(body);
        const scope = workflowScope(body.scope);
        const store = storeFor(cwd);
        const run = await store.getRun(runId, { cwd });
        if (run === undefined) {
          sendJson(res, 200, { ok: false, reason: 'run_not_found' });
          return;
        }
        const meta = readWorkflowMeta(body.meta);
        const code = typeof store.readRunScript === 'function'
          ? await store.readRunScript(runId, { cwd })
          : (typeof run.scriptPath === 'string' ? await fsp.readFile(run.scriptPath, 'utf8').catch(() => undefined) : undefined);
        if (typeof code !== 'string' || code.trim() === '') {
          sendJson(res, 200, { ok: false, reason: 'script_missing' });
          return;
        }
        // §1.2 #7 / N19：先判目标存在，再编译；overwrite 缺省等价 false。
        if (body.overwrite !== true && typeof store.savedWorkflowTarget === 'function') {
          const target = store.savedWorkflowTarget(name, { cwd, ...(scope === undefined ? {} : { scope }) });
          if (target?.exists === true) {
            sendJson(res, 200, {
              ok: false,
              reason: 'target_exists',
              path: target.path,
              detail: `a ${target.scope} workflow named "${name}" already exists`,
            });
            return;
          }
        }
        const compiled = compileWorkflowScript({
          code,
          filename: typeof run.scriptPath === 'string' ? run.scriptPath : `${name}.dwf.ts`,
          mode: 'workflow',
        });
        if (!compiled.ok) {
          sendJson(res, 200, { ok: false, reason: 'compile_failed', detail: describeStartFailure(compiled) });
          return;
        }
        const result = typeof store.saveWorkflow === 'function'
          ? await store.saveWorkflow({
            cwd,
            runId,
            name,
            meta,
            ...(scope === undefined ? {} : { scope }),
            overwrite: body.overwrite === true,
            code,
          })
          : await legacySaveWorkflow(store, { cwd, name, meta, scope: scope ?? 'project', code, overwrite: body.overwrite === true });
        sendJson(res, 200, result);
      },
    },
    {
      path: `${BASE}/workflows/runs`,
      async GET(req, res, query) {
        const cwd = await cwdFrom(query);
        const name = stringField(query, 'name');
        const scope = workflowScope(query.scope);
        const limit = intField(query, 'limit', { min: 1, max: MAX_RUNS_FOR_WORKFLOW, fallback: DEFAULT_RUNS_FOR_WORKFLOW });
        const store = storeFor(cwd);
        if (typeof store.listSavedWorkflowRuns === 'function') {
          const listed = await store.listSavedWorkflowRuns(name, { cwd, limit });
          sendJson(res, 200, { runs: listed.runs, ...(listed.truncated ? { truncated: true } : {}) });
          return;
        }
        const rows = (await runtimeFor(cwd).listRuns({ project: true }))
          .filter((row) => name === undefined || row.name === name)
          .slice(0, limit)
          .map((row) => ({
            runId: row.id,
            ...(row.name === undefined ? {} : { name: row.name }),
            status: row.status,
            ...(row.stopReason === undefined ? {} : { stopReason: row.stopReason }),
            createdAt: row.createdAt ?? 0,
            updatedAt: row.updatedAt ?? row.createdAt ?? 0,
            spentTokens: row.spentTokens ?? 0,
          }));
        sendJson(res, 200, { runs, ...(rows.length === limit ? { truncated: true } : {}) });
        void scope;
      },
    },
    {
      path: `${BASE}/workflows/forRun`,
      async GET(req, res, query) {
        const runId = requiredString(query, 'runId');
        const cwd = await cwdFrom(query);
        const candidates = parseCandidates(query.candidates);
        const store = storeFor(cwd);
        if (typeof store.resolveSavedWorkflowForRun === 'function') {
          sendJson(res, 200, await store.resolveSavedWorkflowForRun({ runId, candidates, cwd }));
          return;
        }
        const run = await store.getRun(runId, { cwd });
        if (run === undefined) {
          sendJson(res, 200, {});
          return;
        }
        const listed = await store.listSavedWorkflows({ cwd });
        const entries = Array.isArray(listed?.entries) ? listed.entries : Array.isArray(listed) ? listed : [];
        const byName = entries.find((entry) => entry.name === run.name);
        sendJson(res, 200, byName === undefined ? {} : { entry: savedWorkflow(byName), match: 'name', runArgs: run.args ?? {} });
      },
    },

    /* --------------------------------- policy (§6) ------------------------------------------ */
    {
      path: `${BASE}/policy`,
      async GET(req, res, query) {
        const cwd = await cwdFrom(query);
        const policy = await readPolicyValue(cwd);
        sendJson(res, 200, policy);
      },
      async POST(req, res, query, body) {
        const cwd = await cwdFrom(body);
        if (typeof body.enabled !== 'boolean') {
          throw new ApiError(400, 'bad-parameter', '"enabled" must be a boolean');
        }
        const requested = body.mode === undefined ? undefined : canonicalMode(body.mode);
        if (body.mode !== undefined && requested === undefined) {
          throw new ApiError(400, 'invalid-mode', 'mode must be disabled, onDemand or alwaysOn');
        }
        const current = await readPolicyValue(cwd);
        const nextMode = body.enabled === false ? 'disabled' : (requested ?? (current.mode !== 'disabled' ? current.mode : 'alwaysOn'));
        if (typeof writePolicy === 'function') {
          const saved = await writePolicy({ projectRoot: cwd, enabled: body.enabled, ...(requested === undefined ? {} : { mode: requested }) });
          sendJson(res, 200, normalizePolicy(saved, nextMode));
          return;
        }
        if (typeof writeMode === 'function') {
          const saved = await writeMode(nextMode);
          sendJson(res, 200, normalizePolicy(saved, nextMode));
          return;
        }
        throw new ApiError(409, 'policy-unavailable', 'this profile cannot persist the dynamic-workflow policy');
      },
    },

    /* ----------------------------- compatibility routes ------------------------------------ */
    {
      path: `${BASE}/workflows`,
      async GET(req, res, query) {
        const cwd = await cwdFrom(query);
        const listed = await storeFor(cwd).listSavedWorkflows({ cwd });
        const entries = Array.isArray(listed?.entries) ? listed.entries : Array.isArray(listed) ? listed : [];
        sendJson(res, 200, {
          entries: entries.map(savedWorkflow),
          invalid: (Array.isArray(listed?.invalid) ? listed.invalid : []).map(invalidWorkflowRow),
        });
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
        const violation = validateArgsSchema(args, argsSchemaFor(declarations), 'args');
        if (violation !== undefined) throw new ApiError(400, 'invalid-args', violation);
        const runtime = runtimeFor(cwd);
        const askChild = createSubagentRunner({ ctx, logger, config });
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
            if (typeof store.readArtifactPayload === 'function') {
              const payload = await store.readArtifactPayload(runId, artifactId, payloadVersion);
              text = payload === undefined ? undefined : payload.bytes.toString('utf8');
            } else {
              const file = await store.artifactFilePath(runId, artifactId, payloadVersion);
              if (file !== undefined) text = await fsp.readFile(file, 'utf8');
            }
            if (text === undefined) throw new ApiError(404, 'artifact-not-found', `artifact "${artifactId}" has no stored payload`);
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
        let bytes;
        if (typeof store.readArtifactPayload === 'function') {
          bytes = (await store.readArtifactPayload(runId, artifactId, payloadVersion))?.bytes;
        } else {
          const file = await store.artifactFilePath(runId, artifactId, payloadVersion);
          if (file !== undefined) bytes = await fsp.readFile(file);
        }
        if (bytes === undefined) throw new ApiError(404, 'artifact-not-found', `artifact "${artifactId}" has no stored payload`);
        res.statusCode = 200;
        res.setHeader('content-type', contentType);
        res.setHeader('cache-control', 'no-store');
        res.end(bytes);
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

  /**
   * Read the workspace policy, preferring the injected policy channel but staying usable with the
   * older mode-only wiring (`index.js` passes both while profiles upgrade).
   *
   * @param {string} cwd
   * @returns {Promise<{ enabled: boolean, mode: string }>}
   */
  const readPolicyValue = async (cwd) => {
    if (typeof readPolicy === 'function') {
      const raw = await readPolicy({ projectRoot: cwd });
      const normalized = normalizePolicy(raw);
      return {
        ...normalized,
        ...(raw !== null && typeof raw === 'object' && typeof raw.writable === 'boolean' ? { writable: raw.writable } : {}),
        ...(raw !== null && typeof raw === 'object' && typeof raw.effective === 'string' ? { effective: raw.effective } : {}),
      };
    }
    const snapshot = await readMode();
    const mode = canonicalMode(snapshot?.mode) ?? 'alwaysOn';
    return {
      enabled: mode !== 'disabled',
      mode,
      ...(typeof snapshot?.writable === 'boolean' ? { writable: snapshot.writable } : {}),
      ...(typeof snapshot?.effective === 'string' ? { effective: snapshot.effective } : {}),
    };
  };

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

/* ---------------------------------------------------------------------------------------------- */
/* route helpers                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/**
 * @param {unknown} raw
 * @returns {'project'|'global'|undefined}
 */
function workflowScope(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = String(raw);
  if (value !== 'project' && value !== 'global') {
    throw new ApiError(400, 'bad-parameter', '"scope" must be "project" or "global"');
  }
  return value;
}

/**
 * @param {unknown} raw
 * @returns {{ description?: string, whenToUse?: string, args?: Record<string, unknown> }}
 */
function readWorkflowMeta(raw) {
  if (raw === undefined || raw === null) {
    throw new ApiError(400, 'missing-parameter', '"meta" is required');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'bad-parameter', '"meta" must be an object');
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  // `Ow.description: J` 必填但允许空串（§1.2 / validation.js:14823-14827）。
  if (typeof record.description !== 'string') {
    throw new ApiError(400, 'missing-parameter', '"meta.description" is required');
  }
  if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') {
    throw new ApiError(400, 'bad-parameter', '"meta.whenToUse" must be a string');
  }
  if (record.args !== undefined && (record.args === null || typeof record.args !== 'object' || Array.isArray(record.args))) {
    throw new ApiError(400, 'bad-parameter', '"meta.args" must be an object');
  }
  return {
    description: /** @type {string} */ (record.description),
    ...(record.whenToUse === undefined ? {} : { whenToUse: /** @type {string} */ (record.whenToUse) }),
    ...(record.args === undefined ? {} : { args: /** @type {Record<string, unknown>} */ (record.args) }),
  };
}

/**
 * `fields` is sent as a comma-separated query parameter by the client (`10-api.js`).
 * @param {unknown} raw
 * @returns {string[] | undefined}
 */
function readFields(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const fields = raw.split(',').map((field) => field.trim()).filter((field) => field !== '');
  if (fields.length === 0 || fields.length > 32) {
    throw new ApiError(400, 'bad-parameter', '"fields" must contain 1-32 field paths');
  }
  for (const field of fields) {
    if (field.length > 256) throw new ApiError(400, 'bad-parameter', '"fields" paths must be at most 256 characters');
  }
  return fields;
}

/**
 * `candidates` for `workflows/forRun`: the client sends `name` values joined by commas.
 * @param {unknown} raw
 * @returns {{ name: string }[]}
 */
function parseCandidates(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(',').map((name) => name.trim()).filter((name) => name !== '').slice(0, 8).map((name) => ({ name }));
}

/**
 * @param {unknown} raw
 * @param {string} [fallbackMode]
 * @returns {{ enabled: boolean, mode: string }}
 */
function normalizePolicy(raw, fallbackMode) {
  if (raw !== null && typeof raw === 'object') {
    const record = /** @type {Record<string, unknown>} */ (raw);
    const mode = canonicalMode(record.mode);
    if (mode !== undefined) return { enabled: record.enabled === undefined ? mode !== 'disabled' : record.enabled === true, mode };
    if (typeof record.enabled === 'boolean') {
      return { enabled: record.enabled, mode: record.enabled ? (fallbackMode ?? 'alwaysOn') : 'disabled' };
    }
  }
  const mode = canonicalMode(fallbackMode) ?? 'alwaysOn';
  return { enabled: mode !== 'disabled', mode };
}

/**
 * Legacy `saveSavedWorkflow` result → §1.2 §7 reason vocabulary.
 *
 * @param {any} store
 * @param {{ cwd: string, name: string, meta: Record<string, unknown>, scope: 'project'|'global', code: string, overwrite: boolean }} input
 */
async function legacySaveWorkflow(store, input) {
  const saved = await store.saveSavedWorkflow({
    cwd: input.cwd,
    name: input.name,
    scope: input.scope,
    code: input.code,
    meta: input.meta,
    overwrite: input.overwrite,
  });
  if (!saved?.ok) {
    const reason = typeof saved?.message === 'string' && /already exists/u.test(saved.message) ? 'target_exists' : 'write_error';
    return { ok: false, reason, ...(saved?.message === undefined ? {} : { detail: saved.message }) };
  }
  return {
    ok: true,
    name: input.name,
    scope: saved.scope,
    path: saved.path,
    overwritten: saved.overwritten === true,
    ...(saved.shadowing === undefined ? {} : { shadowing: saved.shadowing }),
  };
}

/**
 * Group legacy manifest rows into the §1.1(3) `bls` shape (fallback for stores without
 * `listArtifacts`).
 *
 * @param {Record<string, any>[]} rows
 * @returns {Record<string, any>[]}
 */
function artifactsFromManifest(rows) {
  /** @type {Map<string, Record<string, any>[]>} */
  const groups = new Map();
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue;
    const list = groups.get(row.id) ?? [];
    list.push(row);
    groups.set(row.id, list);
  }
  const artifacts = [];
  for (const [id, versions] of groups) {
    versions.sort((left, right) => Number(left.version) - Number(right.version));
    const latest = versions[versions.length - 1];
    artifacts.push({
      id,
      kind: latest.kind,
      ...(latest.title === undefined ? {} : { title: latest.title }),
      version: Number(latest.version),
      versions: versions.map((row) => ({
        version: Number(row.version),
        ...(row.title === undefined ? {} : { title: row.title }),
        ...(row.bytes === undefined ? {} : { bytes: row.bytes }),
        publishedAt: row.publishedAt ?? row.createdAt ?? 0,
        ...(row.primary === true ? { primary: true } : {}),
      })),
      itemCount: latest.itemCount ?? 0,
      ...(versions.some((row) => row.primary === true) ? { primary: true } : {}),
    });
  }
  return artifacts.slice(0, 32);
}

/**
 * Node result payload (§8). Failed nodes expose only the error summary; unfinished nodes expose
 * status without a result.
 *
 * @param {Record<string, any>} node canonical `dwf_node` row
 * @param {number} maxBytes
 */
function nodeResultPayload(node, maxBytes) {
  if (node.status === 'failed') {
    const code = typeof node.error?.code === 'string' ? node.error.code : undefined;
    const message = typeof node.error?.message === 'string' ? node.error.message : '';
    return {
      status: 'failed',
      ...(node.error === undefined
        ? {}
        : {
          error: {
            ...(code === undefined ? {} : { code }),
            message: message.length <= 2000 ? message : `${message.slice(0, 1999)}…`,
          },
        }),
      truncated: false,
      totalBytes: 0,
    };
  }
  if (node.status !== 'completed' || node.result === undefined) {
    return { status: node.status, truncated: false, totalBytes: 0 };
  }
  const truncated = truncateNodeResult(node.result, maxBytes);
  return {
    status: 'completed',
    ...(truncated.result === undefined ? {} : { result: truncated.result }),
    truncated: truncated.truncated,
    totalBytes: truncated.totalBytes,
  };
}

/**
 * Fallback `workflowRunWorkspace` projection from journal events (no node table).
 *
 * @param {{ sequence: number, type: string, payload: Record<string, any> }[]} events
 */
function workspaceNodesFromEvents(events) {
  /** @type {Map<string, Record<string, any>>} */
  const nodes = new Map();
  const keyOf = (instance) => `${instance.siteId}\0${instance.ordinal}`;
  for (const event of events) {
    const payload = event.payload ?? {};
    const instance = payload.instance;
    if (instance === null || typeof instance !== 'object' || typeof instance.siteId !== 'string') continue;
    const key = keyOf(instance);
    const existing = nodes.get(key);
    const now = payload.at ?? payload.time_created ?? 0;
    if (event.type === 'node-queued' && (payload.kind === 'world-read' || payload.kind === 'world-run')) {
      nodes.set(key, {
        siteId: instance.siteId,
        ordinal: instance.ordinal,
        kind: payload.kind,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      });
      continue;
    }
    if (event.type === 'node-settled' && existing !== undefined) {
      existing.status = payload.outcome === 'ok' ? 'completed' : 'failed';
      if (payload.error !== null && typeof payload.error === 'object') {
        existing.error = {
          code: typeof payload.error.code === 'string' ? payload.error.code : 'error',
          message: typeof payload.error.message === 'string' ? payload.error.message.slice(0, 2000) : '',
        };
      }
      existing.updatedAt = now;
      continue;
    }
    if (event.type === 'node-dispatched' && existing !== undefined) {
      if (payload.kind === 'world-read' || payload.kind === 'world-run') existing.kind = payload.kind;
      existing.updatedAt = now;
    }
  }
  return [...nodes.values()].slice(0, 2000);
}
