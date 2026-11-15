/**
 * Model-facing tools of the dynamic-workflow port.
 *
 * The surface is ZCode 3.17.2 / CLI 0.21.1's twelve dynamic-workflow tools, with one
 * extension: `StopWorkflowRun`, because ZCode stops runs through its generic `TaskStop`
 * background-task tool and the Harness exposes no equivalent to plugins. Descriptions,
 * schema field texts, notes and error strings come from `host/tool-contract.js`, which
 * copies them from the reversed bundle; `execute` is the thin layer over `host/runtime.js`
 * plus the durable store.
 *
 * Each definition is a plain object: `{ name, description, parameters, output, execute }`,
 * registered through `ctx.tools.register` by `index.js`.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { preview } from './canonical.js';
import { userMessage } from './messages.js';
import { MAX_LOG_TAIL_MESSAGE, summarizeRun } from './runtime.js';
import { RUNTIME_CAPS } from './concurrency.js';
import { TOOL_DESCRIPTIONS } from './prompt.js';
import { createSubagentRunner, resolveModelRoute } from './subagent.js';
import {
  AMEND_BOTH_SCRIPTS,
  ARGS_WITHOUT_PATH,
  ANSWERING_UNAVAILABLE,
  COMPILE_FAILED_NOTE,
  EVAL_UNAVAILABLE,
  FILL_SOURCE,
  FILL_UNAVAILABLE,
  INTROSPECTION_UNAVAILABLE,
  MULTIPLE_WORKFLOW_SOURCES,
  NO_EXECUTION_NOTE,
  NO_WORKFLOW_SOURCE,
  RESUME_MESSAGES,
  RESUME_UNAVAILABLE,
  SAVE_BODY_ONLY,
  SAVE_BOTH_SOURCES,
  SNIPPET_BOTH_SOURCES,
  SNIPPET_NO_SOURCE,
  STOP_UNAVAILABLE,
  TOOL_DENIED,
  backgroundedNotice,
  launchedScriptSentence,
  revisedScriptSentence,
  runNotFound,
  scriptFileNote,
} from './tool-contract.js';

const MAX_MODEL_TEXT = 48 * 1024;
const DRAFT_KIND = 'draft';
const PATH_KIND = 'path';

/**
 * Truncate one model-facing text while keeping its head and tail readable.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
function budget(text, limit = MAX_MODEL_TEXT) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = Math.floor(limit * 0.25);
  return `${text.slice(0, head)}\n… output truncated (${text.length - head - tail} characters) …\n${text.slice(-tail)}`;
}

/** @param {string} text @param {object} [extra] */
const fail = (text, extra = {}) => ({ ok: false, text, response: text, diagnostics: [], ...extra });
/** @param {string} text @param {object} [extra] */
const succeed = (text, extra = {}) => ({ ok: true, text, response: text, ...extra });

/**
 * Drop `undefined` members, recursively, so a tool result is lossless JSON.
 *
 * The Harness refuses a tool output that carries an `undefined` anywhere in it: an extra field that
 * happens to be absent (an optional reason, a setting nobody edited) would otherwise turn a normal
 * result into `ToolOutputError: value is not lossless JSON` and lose the text the model needs.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function compactJson(value) {
  if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : compactJson(entry)));
  if (value === null || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const record = /** @type {Record<string, unknown>} */ (value);
  const out = {};
  for (const [key, entry] of Object.entries(record)) {
    if (entry === undefined) continue;
    out[key] = compactJson(entry);
  }
  return out;
}

/**
 * Output JSON Schema shared by every tool: the port keeps `text` for DSH's renderer, while
 * the contract fields named in `cli.md` §1.2–§1.11 stay camelCase.
 *
 * Only the three fields every result carries are required. A refusal is a result too, and it has no
 * success fields, so requiring them would make the Host reject the refusal itself.
 *
 * @param {Record<string, object>} properties
 */
function outputSchema(properties) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'response', 'text'],
    properties: {
      ok: { type: 'boolean' },
      response: { type: 'string' },
      text: { type: 'string' },
      // Optional everywhere: a refused call carries no diagnostics, and the schema has to admit the
      // empty list `fail()` writes on every tool, not just on the authoring ones.
      diagnostics: DIAGNOSTICS_PROPERTY,
      ...properties,
    },
  };
}

const DIAGNOSTIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'column', 'line', 'message'],
  properties: {
    code: { type: 'number' },
    column: { type: 'number' },
    line: { type: 'number' },
    message: { type: 'string' },
  },
};

/** `k4`/`$at` shape pieces shared by the authoring tools. */
const DIAGNOSTICS_PROPERTY = { type: 'array', items: DIAGNOSTIC_SCHEMA };

const FILL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['siteId', 'name'],
  properties: {
    siteId: { type: 'string' },
    name: { type: 'string' },
    draftPath: { type: 'string' },
    line: { type: 'number' },
  },
};

/**
 * What a launch result carries when the user answered the confirmation with anything but an allow.
 * `reason` is the sentence the model reads, `reasonSource` marks a revision request so the model
 * knows the text is feedback to work from rather than a refusal, and `preserveReasonFormatting` says
 * the text is human-authored and must reach the model byte-for-byte.
 */
const REJECTION_OUTPUT_PROPERTIES = {
  rejected: { type: 'boolean' },
  reason: { type: 'string' },
  reasonSource: { type: 'string', enum: ['workflow_refine_feedback'] },
  preserveReasonFormatting: { type: 'boolean' },
};

/** One row of ListWorkflowRuns' `runs` (`cli.md` §1.6). */
const RUN_ROW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'label', 'labelSource', 'status', 'ownedByThisSession', 'createdAt', 'updatedAt', 'spentTokens'],
  properties: {
    runId: { type: 'string' },
    label: { type: 'string' },
    labelSource: { type: 'string', enum: ['name', 'script'] },
    status: { type: 'string', enum: ['completed', 'errored', 'pending', 'running', 'stopped'] },
    stopReason: { type: 'string', enum: ['user', 'model', 'provider', 'interrupted', 'superseded'] },
    resumedFrom: { type: 'string' },
    supersededBy: { type: 'string' },
    ownedByThisSession: { type: 'boolean' },
    possiblyInterrupted: { type: 'boolean' },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
    spentTokens: { type: 'number' },
  },
};

/** One artifact row of GetWorkflowRun's `artifacts` (`cli.md` §1.5). */
const ARTIFACT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'version', 'itemCount'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['file', 'markdown', 'chart', 'table', 'metrics', 'board'] },
    title: { type: 'string' },
    version: { type: 'number' },
    contentType: { type: 'string' },
    bytes: { type: 'number' },
    sourcePath: { type: 'string' },
    itemCount: { type: 'number' },
    primary: { type: 'boolean' },
  },
};

/** One hole row of GetWorkflowRun's `holes` (`cli.md` §1.5). */
const HOLE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['siteId', 'name', 'state'],
  properties: {
    siteId: { type: 'string' },
    ordinal: { type: 'number' },
    name: { type: 'string' },
    type: { type: 'string' },
    state: { type: 'string', enum: ['waiting', 'filled'] },
    since: { type: 'number' },
    filledAt: { type: 'number' },
    filledBy: { type: 'string' },
  },
};

/** One pending question row (`cli.md` §1.5/§1.11). */
const QUESTION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['qid', 'actor', 'question'],
  properties: {
    qid: { type: 'string' },
    actor: { type: 'string' },
    actorName: { type: 'string' },
    question: { type: 'string' },
    context: { type: 'string' },
    askedAt: { type: 'number' },
  },
};

/** `Uoe` — GetWorkflowRun's snapshot output (`cli.md` §1.5). */
const RUN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['spentTokens', 'summary', 'generatedAt', 'usage', 'actors', 'logTail', 'health'],
  properties: {
    spentTokens: { type: 'number' },
    summary: { type: 'string' },
    generatedAt: { type: 'number' },
    usage: {
      type: 'object',
      additionalProperties: false,
      required: ['spentTokens', 'nodesObserved', 'nodesRunning', 'nodesCompleted', 'nodesFailed'],
      properties: {
        spentTokens: { type: 'number' },
        nodesObserved: { type: 'number' },
        nodesRunning: { type: 'number' },
        nodesCompleted: { type: 'number' },
        nodesFailed: { type: 'number' },
      },
    },
    maxConcurrency: { type: 'number' },
    subagentModel: { type: 'string' },
    // 契约 Uoe 的 modelBindings 是 record<string,string>，但 DSH 的 schema 校验只收布尔
    // additionalProperties，所以这里声明成 open object。
    modelBindings: { type: 'object', additionalProperties: true },
    scriptPath: { type: 'string' },
    actors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['siteId', 'ordinal'],
        properties: {
          siteId: { type: 'string' },
          ordinal: { type: 'number' },
          name: { type: 'string' },
        },
      },
    },
    logTail: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sequence', 'message'],
        properties: {
          sequence: { type: 'number' },
          message: { type: 'string' },
          at: { type: 'number' },
        },
      },
    },
    phases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'state', 'rounds'],
        properties: {
          name: { type: 'string' },
          state: { type: 'string', enum: ['done', 'current', 'ahead', 'unfinished'] },
          rounds: { type: 'number' },
          nodesSettled: { type: 'number' },
          nodesRunning: { type: 'number' },
          enteredAt: { type: 'number' },
          exitedAt: { type: 'number' },
        },
      },
    },
    subagents: { type: 'array', items: { type: 'object', additionalProperties: true } },
    subagentsTruncated: { type: 'boolean' },
    health: {
      type: 'object',
      additionalProperties: true,
      required: ['consecutiveFailures', 'cachedSteps', 'pendingQuestionsKnown'],
      properties: {
        lastProgressAt: { type: 'number' },
        // 契约 §1.5：epoch 毫秒，与 `lastProgressAt` 同型。
        stalledSince: { type: 'number' },
        concurrency: { type: 'object', additionalProperties: true },
        consecutiveFailures: { type: 'number' },
        cachedSteps: { type: 'number' },
        leftoverRunning: { type: 'boolean' },
        pendingQuestionsKnown: { type: 'boolean' },
      },
    },
    result: { type: 'string' },
    error: { type: 'object', additionalProperties: true },
    pendingQuestions: { type: 'array', items: QUESTION_OUTPUT_SCHEMA },
    holes: { type: 'array', items: HOLE_OUTPUT_SCHEMA },
    artifacts: { type: 'array', items: ARTIFACT_OUTPUT_SCHEMA },
  },
};

/** `F0e` — TaskOutput's task record (`cli.md` §1.12). */
const TASK_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id', 'task_type', 'status', 'description', 'output'],
  properties: {
    task_id: { type: 'string' },
    task_type: { type: 'string' },
    status: { type: 'string' },
    description: { type: 'string' },
    output: { type: 'string' },
    exitCode: { type: 'number' },
    error: { type: 'string' },
    prompt: { type: 'string' },
    result: { type: 'string' },
    outputFile: { type: 'string' },
  },
};

/**
 * The script body a metadata-header extraction produced. The compiler reports it as `script`,
 * the store's reader as `body`; read either so a headed file strips to its body.
 * @param {{ script?: unknown, body?: unknown }} header
 * @returns {string | undefined}
 */
function headerBody(header) {
  if (typeof header?.script === 'string') return header.script;
  if (typeof header?.body === 'string') return header.body;
  return undefined;
}

/**
 * How many lines the metadata header took: a diagnostic counted in body lines is reported on the
 * file line, so every caller that stripped a header adds this back (ZCode's `script_line_offset`).
 * @param {{ bodyLineOffset?: unknown }} header
 * @returns {number}
 */
function headerLineOffset(header) {
  const offset = header?.bodyLineOffset;
  return Number.isInteger(offset) && offset > 0 ? offset : 0;
}

/**
 * Render one diagnostic list in ZCode's `{file}:L{line}:C{column} {message}` form.
 * @param {string} file
 * @param {readonly { line?: number, column?: number, message: string }[]} diagnostics
 * @param {number} [lineOffset] header lines already stripped from the compiled body
 * @returns {string}
 */
function renderDiagnostics(file, diagnostics, lineOffset = 0) {
  const base = Number.isInteger(lineOffset) && lineOffset > 0 ? lineOffset : 0;
  return diagnostics
    .map((diagnostic) => `${file}:L${(diagnostic.line ?? 1) + base}:C${diagnostic.column ?? 1} ${diagnostic.message}`)
    .join('\n');
}

/**
 * Resolve the working directory of the calling agent.
 * @param {object} ctx
 * @param {{ agent?: { session?: unknown } }} exec
 * @returns {string}
 */
function sessionCwd(ctx, exec) {
  const agent = exec?.agent;
  try {
    const workingDirectory = ctx.get?.('workingDirectory');
    const fromAgent = workingDirectory?.get?.(agent?.session);
    if (typeof fromAgent === 'string' && fromAgent.length > 0) return fromAgent;
  } catch {
    // fall through
  }
  const fromSession = agent?.session?.header?.cwd ?? agent?.session?.cwd;
  if (typeof fromSession === 'string' && fromSession.length > 0) return fromSession;
  return process.cwd();
}

/**
 * Resolve the calling session's id, used by the launch-confirmation broker.
 * @param {object} exec
 * @returns {string}
 */
function sessionIdOf(exec) {
  const agent = exec?.agent;
  const candidates = [
    exec?.sessionId,
    agent?.session?.id,
    agent?.session?.header?.id,
    agent?.sessionId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return '';
}

/**
 * DSH 的"本会话允许的子代理路由"投影定义，与 `dsh-tool-subagent` 里的那份同名同版本：
 * key `subagentModelSelectionPolicy`、stateVersion 1、状态为 `{provider, model}[] | null`。
 * 注册表按 key 引用计数共享一个单元，多方注册读的是同一份状态；`parse` 只用于读回校验。
 */
const MODEL_SELECTION_POLICY_KEY = 'subagentModelSelectionPolicy';

/** 一个精确路由。 */
const modelRouteSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('a subagent model route must be an object with provider and model');
    }
    const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
    const model = typeof value.model === 'string' ? value.model.trim() : '';
    if (provider === '' || model === '') throw new Error('a subagent model route needs non-empty provider and model');
    return { provider, model };
  },
};

/** 策略状态：至少一条精确路由，或 null（会话没有记录策略）。 */
const modelSelectionPolicySchema = {
  parse(value) {
    if (value === null) return null;
    if (!Array.isArray(value) || value.length === 0) throw new Error('a subagent model policy is a non-empty route list or null');
    return value.map((route) => modelRouteSchema.parse(route));
  },
};

/**
 * 注册（或取回）本插件上下文上的策略投影句柄，进程内按上下文缓存一份。
 * 注册不可用（没有该服务，或宿主拒绝）时返回 undefined，调用方退回读原始事件。
 *
 * @param {object} ctx 插件上下文
 * @returns {Promise<{stateOf: (session: unknown) => {provider: string, model: string}[] | null | undefined} | undefined>}
 */
const modelSelectionPolicyHandles = new WeakMap();
function modelSelectionPolicyHandle(ctx) {
  if (ctx === undefined || ctx === null || typeof ctx !== 'object') return Promise.resolve(undefined);
  const cached = modelSelectionPolicyHandles.get(ctx);
  if (cached !== undefined) return cached;
  const created = (async () => {
    const projections = ctx.get?.('sessionProjections');
    if (projections === undefined || projections === null || typeof projections.register !== 'function') return undefined;
    const handle = await projections.register({
      key: MODEL_SELECTION_POLICY_KEY,
      stateVersion: 1,
      stateSchema: modelSelectionPolicySchema,
      init: () => null,
      apply: (state, event) => {
        if (state !== null || event?.type !== 'subagent/model-selection-policy') return state;
        const allowed = event?.data?.allowedModels;
        if (!Array.isArray(allowed)) return state;
        try {
          return modelSelectionPolicySchema.parse(allowed);
        } catch {
          return state;
        }
      },
    });
    if (handle === undefined || handle === null || typeof handle.stateOf !== 'function') return undefined;
    return { stateOf: (session) => handle.stateOf(session) };
  })();
  modelSelectionPolicyHandles.set(ctx, created);
  return created;
}

/**
 * 读一条会话里记录的子代理路由策略（DSH 的 `subagent/model-selection-policy` 事件）。
 *
 * 策略是 host-only 会话投影的原始事件，插件读同一份数据即可，不必自己注册投影。
 * 两个读口都是 best-effort：拿不到就当会话没有记录策略。
 *
 * @param {object | undefined} query `sessionQuery` 服务
 * @param {string} sessionId
 * @returns {Promise<{provider: string, model: string}[] | undefined>}
 */
async function readPolicyRoutes(query, sessionId) {
  if (query === undefined || query === null || typeof query !== 'object') return undefined;
  const routesOf = (event) => {
    if (event?.type !== 'subagent/model-selection-policy') return undefined;
    const allowed = event?.data?.allowedModels;
    if (!Array.isArray(allowed)) return undefined;
    const routes = [];
    for (const entry of allowed) {
      const provider = typeof entry?.provider === 'string' ? entry.provider.trim() : '';
      const model = typeof entry?.model === 'string' ? entry.model.trim() : '';
      if (provider !== '' && model !== '') routes.push({ provider, model });
    }
    return routes.length === 0 ? undefined : routes;
  };
  if (typeof query.listEvents === 'function') {
    const records = await query.listEvents(sessionId);
    if (Array.isArray(records)) {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (record?.type !== 'subagent/model-selection-policy' || record?.surface === 'shadowed') continue;
        if (record.seq === undefined || typeof query.readEvent !== 'function') break;
        const window = await query.readEvent({ sessionId, seq: record.seq });
        const routes = routesOf(window?.target);
        if (routes !== undefined) return routes;
        break;
      }
    }
  }
  if (typeof query.readSession === 'function') {
    const snapshot = await query.readSession(sessionId);
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const routes = routesOf(events[index]);
      if (routes !== undefined) return routes;
    }
  }
  return undefined;
}

/**
 * Render a workspace path the way the model should pass it back.
 * @param {string} cwd
 * @param {string} absolute
 * @returns {string}
 */
function describePath(cwd, absolute) {
  const relative = path.relative(cwd, absolute);
  return relative.length === 0 ? absolute : (relative.startsWith('..') || path.isAbsolute(relative) ? absolute : relative);
}

/**
 * Read one script/snippet/fill file, refusing paths outside the workspace.
 * @param {string} cwd
 * @param {string} inputPath
 * @returns {Promise<{ ok: true, text: string, absolute: string, described: string } | { ok: false, message: string }>}
 */
async function readWorkspaceFile(cwd, inputPath) {
  const absolute = path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
  try {
    const relative = path.relative(cwd, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, message: `the file path escapes the workspace: ${inputPath}` };
    }
    const text = await fsp.readFile(absolute, 'utf8');
    return { ok: true, text, absolute, described: describePath(cwd, absolute) };
  } catch (error) {
    return { ok: false, message: `cannot read ${inputPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Validate saved-workflow arguments against their declarations.
 * @param {Record<string, unknown>} supplied
 * @param {Record<string, { type?: string, description?: string, required?: boolean, default?: unknown }>} declarations
 * @returns {{ ok: true, args: Record<string, unknown> } | { ok: false, message: string }}
 */
function validateSavedArgs(supplied, declarations) {
  const declared = declarations ?? {};
  const names = Object.keys(declared);
  const args = { ...supplied };
  for (const key of Object.keys(args)) {
    if (Object.prototype.hasOwnProperty.call(declared, key)) continue;
    return {
      ok: false,
      message: names.length === 0
        ? `unknown argument '${key}': this workflow declares no arguments`
        : `unknown argument '${key}' (declared: ${names.join(', ')})`,
    };
  }
  for (const [name, declaration] of Object.entries(declared)) {
    const value = args[name];
    if (value === undefined) {
      if (declaration?.default !== undefined) {
        args[name] = declaration.default;
        continue;
      }
      if (declaration?.required === true) return { ok: false, message: `missing required argument '${name}'` };
      continue;
    }
    const type = declaration?.type ?? 'string';
    const describe = (entry) => {
      if (entry === null) return 'null';
      if (Array.isArray(entry)) return 'an array';
      const kind = typeof entry;
      return kind === 'number' ? 'a number' : kind === 'boolean' ? 'a boolean' : kind === 'string' ? 'a string' : `a ${kind}`;
    };
    const mismatch = type === 'string' && typeof value !== 'string' ? `expected a string, got ${describe(value)}`
      : type === 'number' && !(typeof value === 'number' && Number.isFinite(value)) ? `expected a finite number, got ${describe(value)}`
        : type === 'boolean' && typeof value !== 'boolean' ? `expected a boolean, got ${describe(value)}`
          : undefined;
    if (mismatch !== undefined) {
      return { ok: false, message: `argument '${name}': ${mismatch} (${JSON.stringify(value)})` };
    }
  }
  return { ok: true, args };
}

/** @param {object} run @returns {object[]} */
function phasesOf(run) {
  const phases = run?.phasesDetail ?? run?.phases ?? [];
  return Array.isArray(phases) ? phases : [];
}

/** @param {object} run @returns {object[]} */
function subagentsOf(run) {
  const subagents = run?.subagents ?? run?.actors ?? run?.agents ?? [];
  return Array.isArray(subagents) ? subagents : [];
}

/** @param {object} run @param {string} [cwd] @returns {string} */
function renderRun(run, cwd) {
  const id = run.id ?? run.runId ?? 'unknown';
  const name = run.name ?? run.label;
  const status = run.status ?? 'unknown';
  const stopReason = run.stopReason ?? run.stop_reason;
  const lines = [];
  lines.push(`Run ${id}${typeof name === 'string' && name.length > 0 ? ` "${name}"` : ''} — ${status}${stopReason === undefined ? '' : ` (stop reason: ${stopReason})`}`);
  // 契约 §1.5 的描述里 `superseded` 的后继由 `<superseded_by>` 指名（cli.md:190）。
  if (typeof run.supersededBy === 'string') lines.push(`<superseded_by>${run.supersededBy}</superseded_by>`);
  const usage = run.usage ?? {};
  const spent = usage.spentTokens ?? run.spentTokens;
  const usageBits = [];
  if (typeof spent === 'number') usageBits.push(`${spent} tokens`);
  if (typeof usage.nodesObserved === 'number') usageBits.push(`${usage.nodesObserved} nodes observed`);
  if (typeof usage.nodesRunning === 'number') usageBits.push(`${usage.nodesRunning} running`);
  if (typeof usage.nodesCompleted === 'number') usageBits.push(`${usage.nodesCompleted} completed`);
  if (typeof usage.nodesFailed === 'number') usageBits.push(`${usage.nodesFailed} failed`);
  if (usageBits.length > 0) lines.push(`Usage: ${usageBits.join(', ')}`);
  if (typeof run.scriptPath === 'string') lines.push(`Script: ${cwd === undefined ? run.scriptPath : describePath(cwd, run.scriptPath)}`);
  if (typeof run.createdAt === 'number') {
    lines.push(`Created: ${new Date(run.createdAt).toISOString()}${typeof run.finishedAt === 'number' ? `, finished: ${new Date(run.finishedAt).toISOString()}` : ''}`);
  }
  if (typeof run.maxConcurrency === 'number') lines.push(`Subagents at once: ${run.maxConcurrency}`);
  if (typeof run.subagentModel === 'string' && run.subagentModel.length > 0) lines.push(`Subagent model: ${run.subagentModel}`);
  if (run.maxConcurrency === undefined && typeof run.steps?.running === 'number') {
    lines.push(`Steps: ${run.steps.settled ?? 0} settled, ${run.steps.failed ?? 0} failed, ${run.steps.running} running`);
  }
  const phases = phasesOf(run);
  if (phases.length > 0) {
    lines.push('Phases:');
    for (const phase of phases) {
      if (typeof phase === 'string') {
        lines.push(`- ${phase}${run.currentPhase === phase ? ' (current)' : ''}`);
        continue;
      }
      const bits = [phase.name ?? '(unnamed)'];
      if (phase.state !== undefined) bits.push(phase.state);
      if (typeof phase.rounds === 'number') bits.push(`${phase.rounds} round(s)`);
      if (typeof phase.nodesSettled === 'number') bits.push(`${phase.nodesSettled} settled`);
      if (typeof phase.nodesRunning === 'number') bits.push(`${phase.nodesRunning} running`);
      lines.push(`- ${bits.join(', ')}`);
    }
  }
  const subagents = subagentsOf(run);
  if (subagents.length > 0) {
    lines.push('Subagents:');
    for (const subagent of subagents) {
      const bits = [subagent.name ?? subagent.id ?? '(unnamed)'];
      const state = subagent.state ?? subagent.status ?? subagent.phase;
      if (state !== undefined) bits.push(String(state));
      if (subagent.phaseName !== undefined) bits.push(`phase ${subagent.phaseName}`);
      if (subagent.currentAsk !== undefined) bits.push(`asking: ${budget(String(subagent.currentAsk), 300)}`);
      if (subagent.parkedOn !== undefined) bits.push(`parked on ${subagent.parkedOn}`);
      if (typeof subagent.stepsSettled === 'number') bits.push(`${subagent.stepsSettled} settled`);
      if (typeof subagent.stepsFailed === 'number' && subagent.stepsFailed > 0) bits.push(`${subagent.stepsFailed} failed`);
      if (typeof subagent.tokens === 'number') bits.push(`${subagent.tokens} tokens`);
      lines.push(`- ${bits.join(', ')}`);
    }
    if (run.subagentsTruncated === true) lines.push('- … more subagents were truncated');
  }
  if (run.health !== undefined && typeof run.health === 'object') {
    const health = [];
    if (run.health.concurrency !== undefined) {
      const concurrency = run.health.concurrency;
      health.push(`concurrency ${concurrency.effective ?? concurrency.cap ?? '?'}${concurrency.reason === undefined ? '' : ` (${concurrency.reason})`}`);
    }
    if (typeof run.health.lastProgressAt === 'number') health.push(`last progress ${new Date(run.health.lastProgressAt).toISOString()}`);
    if (run.health.stalledSince !== undefined) health.push(`stalled since ${new Date(run.health.stalledSince).toISOString()}`);
    if (typeof run.health.consecutiveFailures === 'number' && run.health.consecutiveFailures > 0) health.push(`${run.health.consecutiveFailures} consecutive failures`);
    if (typeof run.health.cachedSteps === 'number' && run.health.cachedSteps > 0) health.push(`${run.health.cachedSteps} cached steps`);
    if (health.length > 0) lines.push(`Health: ${health.join(', ')}`);
  }
  const questions = Array.isArray(run.pendingQuestions) ? run.pendingQuestions : [];
  if (questions.length > 0) {
    lines.push('Questions waiting for an answer (answer with ResolveWorkflowQuestion):');
    for (const question of questions) {
      lines.push(`- ${question.qid}${question.actorName === undefined ? '' : ` from ${question.actorName}`}: ${budget(String(question.question ?? ''), 1000)}`);
      if (question.context !== undefined) lines.push(`  context: ${budget(String(question.context), 600)}`);
    }
  }
  const holes = Array.isArray(run.holes) ? run.holes : [];
  if (holes.length > 0) {
    lines.push('Holes (fill with FillWorkflowHole):');
    for (const hole of holes) {
      const bits = [`${hole.siteId ?? hole.id ?? '?'}${hole.name === undefined ? '' : ` "${hole.name}"`}`];
      if (hole.state !== undefined) bits.push(String(hole.state));
      if (hole.type !== undefined) bits.push(`type ${hole.type}`);
      if (hole.prompt !== undefined) bits.push(`prompt: ${budget(String(hole.prompt), 600)}`);
      lines.push(`- ${bits.join(', ')}`);
    }
  }
  const artifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
  if (artifacts.length > 0) {
    lines.push('Artifacts (already shown to the user as cards):');
    for (const artifact of artifacts) {
      const bits = [`${artifact.id} v${artifact.version ?? 1} (${artifact.kind ?? 'file'})`];
      if (artifact.title !== undefined) bits.push(`"${artifact.title}"`);
      if (artifact.primary === true) bits.push('[primary]');
      if (artifact.itemCount !== undefined) bits.push(`${artifact.itemCount} item(s)`);
      lines.push(`- ${bits.join(' ')}`);
    }
  }
  const reports = Array.isArray(run.reports) ? run.reports : [];
  if (reports.length > 0) {
    lines.push(`Reported items (${reports.length}):`);
    for (const report of reports.slice(-40)) {
      const preview = typeof report.preview === 'string'
        ? report.preview
        : JSON.stringify(report.item ?? report);
      lines.push(`- ${budget(preview, 2000)}`);
    }
  }
  const log = Array.isArray(run.logTail) ? run.logTail : (Array.isArray(run.log) ? run.log : []);
  if (log.length > 0) {
    lines.push('Log:');
    for (const entry of log.slice(-40)) lines.push(`- ${typeof entry === 'string' ? entry : String(entry.message ?? '')}`);
  }
  const world = Array.isArray(run.world) ? run.world : (Array.isArray(run.worldCommands) ? run.worldCommands : []);
  if (world.length > 0) {
    lines.push('Commands:');
    for (const command of world.slice(-20)) {
      if (typeof command === 'string') {
        lines.push(`- ${command}`);
        continue;
      }
      lines.push(`- ${[command.cmd ?? command.command, ...(Array.isArray(command.args) ? command.args : [])].filter(Boolean).join(' ')}${command.exitCode === undefined ? '' : ` → exit ${command.exitCode}`}`);
    }
  }
  if (run.result !== undefined && run.result !== null) {
    lines.push('Return value:');
    lines.push(budget(typeof run.result === 'string' ? run.result : JSON.stringify(run.result, null, 2), 20000));
  }
  if (run.error !== undefined) {
    if (typeof run.error === 'string') {
      lines.push(`Error: ${run.error}`);
    } else {
      lines.push(`Error${run.error?.code === undefined ? '' : ` ${run.error.code}`}: ${run.error?.message ?? JSON.stringify(run.error)}`);
      const providerStop = run.error?.providerStop;
      if (providerStop !== undefined && typeof providerStop === 'object') {
        lines.push(`Provider stop: ${providerStop.kind ?? 'other'}${providerStop.reason === undefined ? '' : ` — ${providerStop.reason}`}`);
        if (providerStop.resetAt !== undefined) lines.push(`Resets at: ${new Date(providerStop.resetAt).toISOString()}`);
      }
    }
  }
  return budget(lines.join('\n'));
}

/** @param {object} run @param {string} [sessionId] @returns {string} */
function renderRunRow(run, sessionId) {
  const id = run.id ?? run.runId;
  const name = run.name ?? run.label;
  const status = run.status ?? 'unknown';
  const stopReason = run.stopReason ?? run.stop_reason;
  const owned = run.ownedByThisSession ?? run.owned_by_this_session;
  const possiblyInterrupted = run.possiblyInterrupted
    ?? (owned === true && stopReason !== 'user' && run.introducesProviders === undefined && (status === 'running' || status === 'pending'));
  const bits = [`${id}${typeof name === 'string' && name.length > 0 ? ` "${name}"` : ''} — ${status}${stopReason === undefined ? '' : ` (${stopReason})`}`];
  if (owned !== undefined) bits.push(owned ? 'this session' : 'another session');
  if (typeof run.spentTokens === 'number' && run.spentTokens > 0) bits.push(`${run.spentTokens} tokens`);
  if (typeof run.createdAt === 'number') bits.push(`created ${new Date(run.createdAt).toISOString()}`);
  if (typeof run.updatedAt === 'number') bits.push(`updated ${new Date(run.updatedAt).toISOString()}`);
  if (run.resumedFrom !== undefined) bits.push(`resumed from ${run.resumedFrom}`);
  if (run.supersededBy !== undefined) bits.push(`superseded by ${run.supersededBy}`);
  if (possiblyInterrupted === true) bits.push('possibly_interrupted="true"');
  void sessionId;
  return `- ${bits.join(', ')}`;
}

const RUN_STATUSES = new Set(['completed', 'errored', 'pending', 'running', 'stopped']);
const STOP_REASONS = new Set(['user', 'model', 'provider', 'interrupted', 'superseded']);

/**
 * Map one runtime run row to ListWorkflowRuns' `runs[]` contract (`cli.md` §1.6).
 * @param {object} run
 */
function toRunRow(run) {
  const runId = run.id ?? run.runId ?? '';
  // store 的 `label` 已按「显式 name → 脚本首行 → runId」解析好，`labelSource` 也由 store
  // 按「meta.name 有没有值」定成 "name"/"script"（cli.md:205 的 V0e），这里只做投影。
  const label = typeof run.label === 'string' && run.label !== '' ? run.label : runId;
  const rawStatus = run.status;
  const status = RUN_STATUSES.has(rawStatus) ? rawStatus : 'pending';
  const rawStopReason = run.stopReason ?? run.stop_reason;
  const stopReason = STOP_REASONS.has(rawStopReason) ? rawStopReason : undefined;
  const owned = run.ownedByThisSession ?? run.owned_by_this_session ?? false;
  const possiblyInterrupted = run.possiblyInterrupted
    ?? (owned === true && stopReason !== 'user' && run.introducesProviders === undefined && (status === 'running' || status === 'pending'));
  return {
    runId,
    label: label ?? runId,
    labelSource: run.labelSource === 'name' ? 'name' : 'script',
    status,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(typeof run.resumedFrom === 'string' ? { resumedFrom: run.resumedFrom } : {}),
    ...(typeof run.supersededBy === 'string' ? { supersededBy: run.supersededBy } : {}),
    ownedByThisSession: owned === true,
    ...(possiblyInterrupted === true ? { possiblyInterrupted: true } : {}),
    createdAt: typeof run.createdAt === 'number' ? run.createdAt : 0,
    updatedAt: typeof run.updatedAt === 'number' ? run.updatedAt : (typeof run.createdAt === 'number' ? run.createdAt : 0),
    spentTokens: typeof run.spentTokens === 'number' ? run.spentTokens : 0,
  };
}

/**
 * Map a runtime snapshot to GetWorkflowRun's `Uoe` output (`cli.md` §1.5).
 * @param {object} run
 */
function toRunOutput(run) {
  const used = run.usage ?? {};
  const usage = {
    spentTokens: Number(used.spentTokens ?? run.spentTokens ?? 0),
    nodesObserved: Number(used.nodesObserved ?? 0),
    nodesRunning: Number(used.nodesRunning ?? 0),
    nodesCompleted: Number(used.nodesCompleted ?? 0),
    nodesFailed: Number(used.nodesFailed ?? 0),
  };
  const phases = phasesOf(run).map((phase) => {
    if (typeof phase !== 'string') {
      return {
        name: String(phase?.name ?? ''),
        state: ['done', 'current', 'ahead', 'unfinished'].includes(phase?.state) ? phase.state : 'unfinished',
        rounds: Number(phase?.rounds ?? 1),
        ...(typeof phase?.nodesSettled === 'number' ? { nodesSettled: phase.nodesSettled } : {}),
        ...(typeof phase?.nodesRunning === 'number' ? { nodesRunning: phase.nodesRunning } : {}),
      };
    }
    const names = phasesOf(run).map((entry) => (typeof entry === 'string' ? entry : entry?.name));
    const index = names.indexOf(phase);
    const currentIndex = run.currentPhase === undefined ? -1 : names.indexOf(run.currentPhase);
    const state = run.status === 'completed'
      ? 'done'
      : (currentIndex === -1 ? (index === 0 ? 'current' : 'unfinished') : (index < currentIndex ? 'done' : (index === currentIndex ? 'current' : 'ahead')));
    return { name: phase, state, rounds: 1 };
  });
  const actors = (Array.isArray(run.actors) ? run.actors : []).map((actor) => ({
    siteId: String(actor.siteId ?? ''),
    ordinal: Number(actor.ordinal ?? 0),
    ...(typeof actor.name === 'string' ? { name: actor.name } : {}),
  }));
  const allSubagents = (Array.isArray(run.actors) ? run.actors : []).map((actor) => ({
    siteId: String(actor.siteId ?? ''),
    ordinal: Number(actor.ordinal ?? 0),
    ...(typeof actor.name === 'string' ? { name: actor.name } : {}),
    state: actor.status === 'completed' ? 'done' : (actor.status === 'running' ? 'executing' : 'waiting'),
  }));
  // 快照自带 subagents（按 actor 的 node 行派生状态与计数）时直接透出；旧数据没有这个字段
  // 时才退回 actor 投影，且不伪造恒 0 的计数。
  const snapshotSubagents = Array.isArray(run.subagents) ? run.subagents : allSubagents;
  const subagents = snapshotSubagents.slice(0, RUNTIME_CAPS.maxSnapshotSubagents);
  const subagentsTruncated = snapshotSubagents.length > subagents.length;
  const health = {
    consecutiveFailures: Number(run.health?.consecutiveFailures ?? usage.nodesFailed),
    cachedSteps: Number(run.health?.cachedSteps ?? 0),
    pendingQuestionsKnown: run.health?.pendingQuestionsKnown !== false,
    ...(typeof run.health?.lastProgressAt === 'number' ? { lastProgressAt: run.health.lastProgressAt } : {}),
    // 契约 §1.5：`stalledSince` 与 `lastProgressAt` 同为 epoch 毫秒。
    ...(typeof run.health?.stalledSince === 'number' ? { stalledSince: run.health.stalledSince } : {}),
    ...(run.health?.concurrency === undefined ? {} : { concurrency: run.health.concurrency }),
    ...(run.health?.leftoverRunning === true ? { leftoverRunning: true } : {}),
  };
  const logTail = (Array.isArray(run.logTail) ? run.logTail : []).map((entry, index) => ({
    sequence: Number(entry.sequence ?? index),
    // 契约 `qIs`：每行最长 1024（cli.md:165/540）。
    message: preview(String(entry.message ?? ''), MAX_LOG_TAIL_MESSAGE),
    ...(typeof entry.at === 'number' ? { at: entry.at } : {}),
  }));
  const pendingQuestions = (Array.isArray(run.pendingQuestions) ? run.pendingQuestions : []).map((question) => ({
    qid: String(question.qid ?? ''),
    // 契约 `WIs.actor` 是字符串（问题由哪个子代理提出，`siteId@ordinal`）。
    actor: String(
      question.actor
      ?? (question.actorSiteId === undefined ? '' : `${question.actorSiteId}@${question.actorOrdinal ?? 0}`),
    ),
    ...(typeof question.actorName === 'string' ? { actorName: question.actorName } : {}),
    question: String(question.question ?? ''),
    ...(typeof question.context === 'string' ? { context: question.context } : {}),
    ...(typeof question.askedAt === 'number' ? { askedAt: question.askedAt } : {}),
  }));
  const holes = (Array.isArray(run.holes) ? run.holes : []).map((hole) => ({
    siteId: String(hole.siteId ?? hole.id ?? ''),
    ...(typeof hole.ordinal === 'number' ? { ordinal: hole.ordinal } : {}),
    name: String(hole.name ?? hole.siteId ?? ''),
    ...(typeof hole.type === 'string' ? { type: hole.type } : {}),
    state: hole.state === 'filled' ? 'filled' : 'waiting',
    ...(typeof hole.since === 'number' ? { since: hole.since } : {}),
    ...(typeof hole.filledAt === 'number' ? { filledAt: hole.filledAt } : {}),
    ...(typeof hole.filledBy === 'string' ? { filledBy: hole.filledBy } : {}),
  }));
  const artifacts = (Array.isArray(run.artifacts) ? run.artifacts : []).map((artifact) => ({
    id: String(artifact.id ?? ''),
    kind: ['file', 'markdown', 'chart', 'table', 'metrics', 'board'].includes(artifact.kind) ? artifact.kind : 'file',
    ...(typeof artifact.title === 'string' ? { title: artifact.title } : {}),
    version: Number(artifact.version ?? 1),
    ...(typeof artifact.contentType === 'string' ? { contentType: artifact.contentType } : {}),
    ...(typeof artifact.bytes === 'number' ? { bytes: artifact.bytes } : {}),
    ...(typeof artifact.sourcePath === 'string' ? { sourcePath: artifact.sourcePath } : {}),
    itemCount: Number(artifact.itemCount ?? 0),
    ...(artifact.primary === true ? { primary: true } : {}),
  }));
  const result = run.result === undefined
    ? undefined
    : (typeof run.result === 'string' ? run.result : JSON.stringify(run.result));
  const error = run.error === undefined
    ? undefined
    : (typeof run.error === 'string' ? { message: run.error } : {
      ...(typeof run.error.code === 'string' ? { code: run.error.code } : {}),
      message: String(run.error.message ?? ''),
      ...(run.error.providerStop === undefined ? {} : { providerStop: run.error.providerStop }),
    });
  return {
    spentTokens: usage.spentTokens,
    // 快照自己带 `summary` 时直接用它；假 runtime（测试）只给字段时在这里补一份。
    summary: typeof run.summary === 'string' && run.summary.length > 0 ? run.summary : summarizeRun(run),
    generatedAt: Date.now(),
    usage,
    ...(typeof run.maxConcurrency === 'number' ? { maxConcurrency: run.maxConcurrency } : {}),
    ...(typeof run.subagentModel === 'string' ? { subagentModel: run.subagentModel } : {}),
    ...(run.modelBindings === undefined ? {} : { modelBindings: run.modelBindings }),
    ...(typeof run.scriptPath === 'string' ? { scriptPath: run.scriptPath } : {}),
    actors,
    logTail,
    phases,
    subagents,
    ...(subagentsTruncated ? { subagentsTruncated: true } : {}),
    health,
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
    pendingQuestions,
    holes,
    artifacts,
  };
}

/**
 * Build the tool definitions bound to one plugin instance.
 *
 * @param {object} options
 * @param {object} options.ctx plugin context
 * @param {object} options.runtime workflow runtime (`host/runtime.js`)
 * @param {object} options.store durable store (`host/store.js`)
 * @param {object} options.compiler compiler module (`host/compiler.js`)
 * @param {object} [options.approval] launch-confirmation broker (`host/approval.js`); when
 *   absent — which is what a profile without the confirmation channel sees — a script runs
 *   without a confirmation window
 * @param {object} [options.config]
 * @param {object} [options.logger]
 * @returns {object[]} tool definitions
 */
export function createWorkflowTools({ ctx, runtime, store, compiler, approval, config = {}, logger = console }) {
  const baseRunner = createSubagentRunner({ ctx, config, logger });
  const has = (name) => runtime !== undefined && runtime !== null && typeof runtime[name] === 'function';

  /**
   * 本会话允许派子代理的路由。
   *
   * DSH 把它记成一个 host-only 会话投影（key `subagentModelSelectionPolicy`，状态是精确的
   * `{provider, model}[] | null`）。工具侧派子代理时按同一份状态放行：有策略时必须命中其中
   * 一条，没有策略时只放行父会话路由。所以确认框的目录必须是这份名单，而不是 provider 的
   * 全量模型——全量目录里既有本会话用不了的路由（选中即被拒），又缺本会话真正在用的模型。
   *
   * 投影的官方共读方式是注册同一份定义（注册表按引用计数共享一个单元，见
   * dsh-tool-subagent 的同名定义）。注册不可用时退回读会话日志里的原始事件，数据同源。
   *
   * @param {string} sessionId
   * @returns {Promise<{provider: string, model: string}[] | undefined>} undefined 表示会话没有记录策略
   */
  const sessionPolicyRoutes = (() => {
    /** @type {Map<string, {at: number, routes: {provider: string, model: string}[] | undefined}>} */
    const cache = new Map();
    return async function loadPolicyRoutes(sessionId, session) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
      const cached = cache.get(sessionId);
      if (cached !== undefined && Date.now() - cached.at < 30000) return cached.routes;
      let routes;
      try {
        const handle = await modelSelectionPolicyHandle(ctx);
        routes = handle === undefined ? undefined : handle.stateOf(session) ?? undefined;
      } catch (error) {
        logger.warn?.(`zcode-workflow: registering the subagent model policy projection failed: ${error instanceof Error ? error.message : String(error)}`);
        routes = undefined;
      }
      if (routes === undefined) {
        try {
          routes = await readPolicyRoutes(ctx?.get?.('sessionQuery'), sessionId);
        } catch (error) {
          logger.warn?.(`zcode-workflow: reading this Session's subagent model policy failed: ${error instanceof Error ? error.message : String(error)}`);
          routes = undefined;
        }
      }
      cache.set(sessionId, { at: Date.now(), routes });
      return routes;
    };
  })();

  /**
   * provider 目录（只用来给允许的路由配显示名）：模型 id 是 `provider/model` 里的 model，
   * 名字取 LLM 注册表公布的模型名，取不到就退回 id。
   */
  const llmDirectory = (() => {
    /** @type {{at: number, providers: Map<string, string>, models: Map<string, Map<string, string>>, available: boolean} | undefined} */
    let cached;
    /** @type {Promise<typeof cached> | undefined} */
    let pending;
    return async function loadDirectory() {
      if (cached !== undefined && Date.now() - cached.at < 30000) return cached;
      if (pending !== undefined) return pending;
      pending = (async () => {
        /** @type {Map<string, string>} */
        const providers = new Map();
        /** @type {Map<string, Map<string, string>>} */
        const models = new Map();
        const llm = ctx?.get?.('llm');
        if (llm === undefined || llm === null
          || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
          return { at: Date.now(), providers, models, available: false };
        }
        let listed;
        try {
          listed = llm.listProviders();
        } catch {
          listed = [];
        }
        for (const provider of Array.isArray(listed) ? listed : []) {
          const providerId = typeof provider?.id === 'string' ? provider.id.trim() : '';
          if (providerId === '') continue;
          providers.set(providerId, typeof provider.name === 'string' && provider.name.trim() !== '' ? provider.name.trim() : providerId);
          let entries;
          try {
            entries = await llm.listModels(providerId);
          } catch {
            // 一个 provider 的目录拉不到，不影响它的路由仍然可选（显示名退回 id）。
            continue;
          }
          const byModel = new Map();
          for (const model of Array.isArray(entries) ? entries : []) {
            const modelId = typeof model?.id === 'string' ? model.id.trim() : '';
            if (modelId === '') continue;
            byModel.set(modelId, typeof model.name === 'string' && model.name.trim() !== '' ? model.name.trim() : modelId);
          }
          models.set(providerId, byModel);
        }
        return { at: Date.now(), providers, models, available: true };
      })();
      try {
        const value = await pending;
        cached = value;
        return value;
      } finally {
        pending = undefined;
      }
    };
  })();

  /**
   * 一个路由公布的思考强度层级（ZCode 的模型选择器旁边那一档）。取不到就不给。
   * @param {{provider: string, model: string}} route
   * @returns {Promise<{id: string, label: string}[]>}
   */
  const modelEfforts = (() => {
    /** @type {Map<string, {at: number, rows: {id: string, label: string}[]}>} */
    const cache = new Map();
    return async function loadEfforts(route) {
      const key = `${route.provider}/${route.model}`;
      const cached = cache.get(key);
      if (cached !== undefined && Date.now() - cached.at < 60000) return cached.rows;
      /** @type {{id: string, label: string}[]} */
      const rows = [];
      const llm = ctx?.get?.('llm');
      if (llm !== undefined && llm !== null && typeof llm.resolveModelInfo === 'function') {
        try {
          const info = await llm.resolveModelInfo(route.provider, route.model);
          const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : [];
          for (const effort of efforts) {
            const id = typeof effort?.id === 'string' ? effort.id.trim() : '';
            if (id === '') continue;
            rows.push({ id, label: typeof effort.name === 'string' && effort.name.trim() !== '' ? effort.name.trim() : id });
          }
        } catch {
          // 强度是加分项：解析不到就当这个模型没有层级，不影响模型本身可选。
        }
      }
      cache.set(key, { at: Date.now(), rows });
      return rows;
    };
  })();

  /**
   * 启动确认里可选的子代理模型：本会话允许的路由 ∩ 可见目录，外加每一档的思考强度。
   *
   * @param {{sessionId: string, parentRoute?: {provider: string, model: string}}} request
   * @returns {Promise<{id: string, label: string, efforts?: {id: string, label: string}[]}[]>}
   */
  const modelCatalog = async ({ sessionId, session, parentRoute }) => {
    const allowed = await sessionPolicyRoutes(sessionId, session);
    // 没有记录策略时不等于"什么都能选"：DSH 只放行父会话自己的路由。
    const routes = allowed ?? (parentRoute === undefined ? [] : [parentRoute]);
    if (routes.length === 0) {
      logger.warn?.('zcode-workflow: the launch confirmation offers no subagent model: this Session recorded no model-selection policy and the calling model is unknown');
      return [];
    }
    const directory = await llmDirectory();
    if (!directory.available) {
      logger.warn?.('zcode-workflow: the llm service is unavailable, so subagent models are listed by id only');
    }
    const rows = [];
    const seen = new Set();
    for (const route of routes) {
      const id = `${route.provider}/${route.model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const modelName = directory.models.get(route.provider)?.get(route.model);
      const label = modelName === undefined ? id : modelName;
      const efforts = await modelEfforts(route);
      rows.push({ id, label, ...(efforts.length === 0 ? {} : { efforts }) });
    }
    return rows;
  };

  /**
   * 父会话当前模型（子代理不显式选模型时走的路由），拆成 provider/model。
   * @param {string | undefined} model
   * @returns {{provider: string, model: string} | undefined}
   */
  const parentRouteOf = (model) => {
    const route = resolveModelRoute(model);
    if (route === undefined || typeof route.provider !== 'string' || typeof route.model !== 'string') return undefined;
    return { provider: route.provider, model: route.model };
  };

  /**
   * 脚本与弹窗都没指定模型时，子代理实际会用的路由：插件配置优先，否则继承调用会话当前模型。
   * @param {object} exec
   * @returns {string | undefined}
   */
  const defaultSubagentModel = (exec) => {
    if (typeof config.subagentModel === 'string' && config.subagentModel.trim() !== '') return config.subagentModel.trim();
    try {
      const requestConfig = exec?.agent?.session?.requestHeader?.()?.config;
      if (requestConfig === null || typeof requestConfig !== 'object') return undefined;
      const provider = typeof requestConfig.provider === 'string' ? requestConfig.provider.trim() : '';
      const model = typeof requestConfig.model === 'string' ? requestConfig.model.trim() : '';
      if (provider !== '' && model !== '') return `${provider}/${model}`;
      return model === '' ? undefined : model;
    } catch {
      return undefined;
    }
  };

  /**
   * Build the per-run subagent runner bound to the calling agent and workspace.
   * @param {object} exec
   * @param {string} cwd
   */
  const runnerFor = (exec, cwd) => {
    if (exec?.agent === undefined) {
      throw new Error('dynamic workflows need an agent turn; these tools are not callable outside a session');
    }
    return (request) => baseRunner({ ...request, agent: exec.agent, cwd });
  };

  /**
   * Send the completion notification into the owning agent's inbox.
   * @param {object} agent
   * @returns {(text: string) => void}
   */
  const notifierFor = (agent) => (text) => {
    try {
      const result = agent.followup(userMessage(text));
      if (result !== undefined && typeof result.catch === 'function') {
        result.catch((error) => logger.warn?.(`zcode-workflow: notification delivery failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    } catch (error) {
      logger.warn?.(`zcode-workflow: notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * Resolve a `saved` source into its script body and validated args.
   * @param {{ name: string, args?: Record<string, unknown>, scope?: 'project'|'global' }} saved
   * @param {string} cwd
   */
  const resolveSaved = async (saved, cwd) => {
    const entry = await store.getSavedWorkflow(saved.name, { cwd, scope: saved.scope });
    if (entry === undefined) {
      return { ok: false, message: `no saved workflow named "${saved.name}". Use ListSavedWorkflows to see the names that exist.` };
    }
    const header = compiler.extractMetadataHeader(entry.code);
    // 存盘文件带 metadata 头：剥掉后写进草稿，诊断报的是草稿行号，所以这里不需要偏移。
    const body = header.ok ? (headerBody(header) ?? entry.code) : entry.code;
    const declarations = header.ok ? header.meta?.args ?? {} : entry.meta?.args ?? {};
    const validated = validateSavedArgs(saved.args ?? {}, declarations);
    if (!validated.ok) return { ok: false, message: validated.message };
    return { ok: true, code: body, meta: header.ok ? header.meta : entry.meta, args: validated.args, entry };
  };

  /**
   * The models the script names literally (`model("…")`), collected while compiling. ZCode maps
   * those names to canonical ids (`model_bindings`); the only thing the confirmation reads off it
   * is whether the set is non-empty, which makes the run-level model a default rather than the
   * model every subagent uses.
   *
   * @param {object | undefined} prepared `runtime.prepare` result, when the runtime has one
   * @param {string} code the script body that was compiled
   * @param {string | undefined} filename the file the body came from, for a second compile
   * @returns {string[]}
   */
  const scriptModelNames = (prepared, code, filename) => {
    const fromPrepare = prepared?.prepared?.compile?.models;
    if (Array.isArray(fromPrepare)) return fromPrepare.filter((name) => typeof name === 'string' && name.length > 0);
    try {
      if (typeof compiler.compileWorkflowScript !== 'function') return [];
      const compiled = compiler.compileWorkflowScript({ code, filename: filename ?? 'workflow-script.ts', mode: 'workflow' });
      const models = compiled?.models;
      return Array.isArray(models) ? models.filter((name) => typeof name === 'string' && name.length > 0) : [];
    } catch {
      return [];
    }
  };

  /**
   * The provider a model id belongs to: the part before the first `/`. A bare model id names no
   * provider, so it can never introduce one (ZCode's `d9o`).
   * @param {unknown} value
   * @returns {string | undefined}
   */
  const providerOfModel = (value) => {
    if (typeof value !== 'string') return undefined;
    const slash = value.indexOf('/');
    return slash > 0 ? value.slice(0, slash) : undefined;
  };

  /**
   * The providers an amend would bring in that the run was not already allowed to use — ZCode's
   * `introduces_providers`. Authorized: the provider of the model the subagents fall back to, plus
   * whatever the predecessor ran or had bound. Introduced: this amend's own model choices, the
   * explicit one and the script's literal `model()` names.
   *
   * Known deviation from ZCode: its baseline is the provider of the model catalog's `current`
   * model, while this host can only read the subagent fallback route — so the authorized set is
   * not always the same one. Both directions and their effect are written down in the deviation
   * table of `docs/port-contract.md`.
   *
   * @param {{ subagentModel?: string, scriptModels?: readonly string[], predecessor?: object, fallbackModel?: string }} input
   * @returns {string[]} sorted provider ids; empty means nothing new
   */
  const introducedProviders = ({ subagentModel: model, scriptModels = [], predecessor, fallbackModel }) => {
    const authorized = new Set();
    for (const known of [fallbackModel, predecessor?.subagentModel]) {
      const provider = providerOfModel(known);
      if (provider !== undefined) authorized.add(provider);
    }
    const bindings = predecessor?.modelBindings;
    if (bindings !== null && typeof bindings === 'object' && !Array.isArray(bindings)) {
      for (const bound of Object.values(bindings)) {
        const provider = providerOfModel(bound);
        if (provider !== undefined) authorized.add(provider);
      }
    }
    const introduced = new Set();
    for (const chosen of [model, ...scriptModels]) {
      const provider = providerOfModel(chosen);
      if (provider !== undefined && !authorized.has(provider)) introduced.add(provider);
    }
    return [...introduced].sort();
  };

  /** @param {unknown} runId */
  const mintRunId = (runId) => (typeof runId === 'string' && runId.length > 0
    ? runId
    : (typeof runtime.newRunId === 'function'
      ? runtime.newRunId()
      : `dwf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`));

  /**
   * Write an inline script to a machine-owned draft, the way ZCode does before compiling, so
   * a diagnostic and the launch result can name a file the model edits next instead of
   * re-emitting the script. Best-effort: a host without a draft store still runs the script.
   * @param {string} cwd
   * @param {string} name
   * @param {string} code
   * @returns {Promise<string | undefined>}
   */
  const draftFor = async (cwd, name, code) => {
    if (typeof store.writeDraft !== 'function') return undefined;
    try {
      return await store.writeDraft(name, code, { cwd });
    } catch (error) {
      logger.warn?.(`zcode-workflow: writing the draft failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  /**
   * Ask the user to confirm one launch. Returns the decision, including the settings the
   * confirmation window adjusted; a rejection is a normal result, never a thrown error.
   *
   * The request carries the tool call's identity and cancellation: the browser matches the pending
   * run to this very call, and an aborted call stops waiting instead of holding the answer slot for
   * a caller that is already gone.
   *
   * @param {{ runId: string, sessionId: string, toolName: string, display: object, toolCallId?: string, signal?: AbortSignal }} request
   */
  const confirmLaunch = async (request) => {
    if (approval === undefined) return { ok: true, unconfirmed: true };
    try {
      if (request.sessionId.length > 0 && typeof approval.allowsSession === 'function' && approval.allowsSession(request.sessionId, request.toolName)) {
        return { ok: true, sessionAllowed: true };
      }
      const decision = await approval.request({
        runId: request.runId,
        sessionId: request.sessionId,
        toolName: request.toolName,
        payload: request.display,
        ...(typeof request.toolCallId === 'string' && request.toolCallId.length > 0 ? { toolCallId: request.toolCallId } : {}),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (decision?.decision === 'allow') return { ok: true, adjustments: decision.adjustments };
      const reason = typeof decision?.reason === 'string' ? decision.reason.trim() : '';
      if (decision?.reasonSource === 'workflow_refine_feedback' && reason.length > 0) {
        return { ok: false, text: reason, reason, rejected: true, reasonSource: 'workflow_refine_feedback', preserveReasonFormatting: true };
      }
      if (/not confirmed|did not confirm/i.test(reason)) return { ok: false, text: reason, reason, rejected: true };
      return { ok: false, text: TOOL_DENIED, reason: TOOL_DENIED, rejected: true };
    } catch (error) {
      return { ok: false, text: `workflow_confirmation_failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  /**
   * The script-location sentence appended to a launch result.
   * @param {string} cwd
   * @param {string | undefined} absolute
   * @param {'draft'|'path'} kind
   */
  const locationSentence = (cwd, absolute, kind) => {
    if (typeof absolute !== 'string' || absolute.length === 0) return '';
    return launchedScriptSentence({ kind, described: describePath(cwd, absolute) });
  };

  /**
   * Describe the two adjustable settings the way the confirmation/launch result does.
   * @param {{ maxConcurrency?: number, subagentModel?: string }} settings
   */
  const settingsSentence = ({ maxConcurrency, subagentModel }) => {
    let text = '';
    if (typeof subagentModel === 'string' && subagentModel.length > 0) {
      text += ` Subagents run on ${subagentModel} (the main agent stays on the session model).`;
    }
    if (typeof maxConcurrency === 'number') {
      const defaultConcurrency = typeof runtime.defaultConcurrency === 'function' ? runtime.defaultConcurrency() : undefined;
      text += ` At most ${maxConcurrency === 1 ? '1 subagent runs' : `${maxConcurrency} subagents run`} at once${maxConcurrency === defaultConcurrency ? ' (the default)' : ''}.`;
    }
    return text;
  };

  /**
   * Turn one compile failure into the response ZCode returns.
   * @param {object} options
   * @param {string} options.cwd
   * @param {readonly object[]} options.diagnostics
   * @param {string} [options.absolutePath]
   * @param {'draft'|'path'} options.kind
   * @param {string} [options.savedName]
   * @param {string} [options.savedPath]
   * @param {number} [options.lineOffset] header lines stripped from the compiled body
   */
  const compileFailure = ({ cwd, diagnostics, absolutePath, kind, savedName, savedPath, lineOffset }) => {
    const described = typeof absolutePath === 'string' && absolutePath.length > 0 ? describePath(cwd, absolutePath) : undefined;
    const file = described ?? 'workflow.ts';
    const title = savedName === undefined
      ? 'The workflow script has errors:'
      : `The saved workflow '${savedName}'${savedPath === undefined ? '' : ` (${savedPath})`} has errors:`;
    const note = described === undefined
      ? COMPILE_FAILED_NOTE
      : scriptFileNote({ kind, described });
    return fail([
      title,
      renderDiagnostics(file, diagnostics, lineOffset),
      '',
      note,
    ].join('\n'), { diagnostics, scriptPath: absolutePath });
  };

  /**
   * Turn one fill compile failure into the response ZCode returns.
   * @param {{ runId: string, holeId: string, diagnostics: readonly object[], fillPath?: string }} input
   */
  const fillCompileFailure = ({ runId, holeId, diagnostics, fillPath }) => {
    const described = fillPath;
    const lines = [
      described === undefined
        ? 'The fill could not be saved to a file; fix the body below and resubmit it inline.'
        : `The fill is saved at ${described}. Edit that file in place and resubmit with \`path\`; do not paste it inline again.`,
      'The effective script does not compile:',
      renderDiagnostics(described ?? 'fill.ts', diagnostics),
      '',
      `NOTE: Nothing was spliced or journaled — hole ${holeId} of run ${runId} is still waiting for its body.`,
    ];
    return fail(lines.join('\n'), { diagnostics, fill: { siteId: holeId, name: holeId } });
  };

  /** @param {object} run @param {string} runId */
  const isRunning = (run) => run?.status === 'running' || run?.status === 'pending';

  /** @type {object[]} */
  const tools = [];

  // ---------------------------------------------------------------------------------------
  // CreateWorkflow
  // ---------------------------------------------------------------------------------------
  tools.push({
    name: 'CreateWorkflow',
    description: TOOL_DESCRIPTIONS.createWorkflow,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          description: "Short run label in the user's language. Always pass it for an inline script; defaults to the saved workflow's name.",
        },
        script: {
          type: 'string',
          description: 'The whole workflow script, inline. Exactly one of `script`, `saved` and `path`.',
        },
        saved: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              description: 'Name of a saved workflow (see ListSavedWorkflows).',
            },
            args: {
              type: 'object',
              additionalProperties: true,
              description: 'Values for the arguments the saved workflow declares.',
            },
            path: { type: 'string', minLength: 1 },
            scope: {
              type: 'string',
              enum: ['project', 'global'],
              description: 'Which archive to take it from; omit for the normal lookup order.',
            },
          },
          description: 'A saved workflow to run, by name. Exactly one of `script`, `saved` and `path`.',
        },
        path: {
          type: 'string',
          minLength: 1,
          description: 'A script file on disk (relative or absolute), usually the file a previous result named. Exactly one of `script`, `saved` and `path`.',
        },
        args: {
          type: 'object',
          additionalProperties: true,
          description: 'Values for the arguments a `path` file declares. Only with `path`.',
        },
        max_concurrency: {
          type: 'integer',
          minimum: 1,
          description: 'Subagents working at once, above or below the default. Only when the user asks for more or less parallelism; never as a reaction to provider errors.',
        },
        subagent_model: {
          type: 'string',
          minLength: 1,
          description: 'Model for the subagents (`providerId/modelId` or a model id). Only when the user asks, and never a model under another provider the user did not name — ask them first if one would help; you stay on the session model.',
        },
      },
    },
    async execute(args, exec) {
      const cwd = sessionCwd(ctx, exec);
      const sources = ['script', 'saved', 'path'].filter((key) => args?.[key] !== undefined);
      if (sources.length === 0) return fail(NO_WORKFLOW_SOURCE, { diagnostics: [] });
      if (sources.length > 1) return fail(MULTIPLE_WORKFLOW_SOURCES, { diagnostics: [] });
      if (args?.args !== undefined && args?.path === undefined) return fail(ARGS_WITHOUT_PATH, { diagnostics: [] });

      let code;
      let scriptPath;
      let runName = typeof args?.name === 'string' ? args.name : undefined;
      let runArgs = args?.args !== undefined && typeof args.args === 'object' && args.args !== null ? { ...args.args } : {};
      let meta;
      let origin;
      let savedName;
      let savedPath;
      // 只有 path 源会剥掉 metadata 头，而诊断报的是那个文件；草稿里的行号就是正文行号。
      let lineOffset = 0;
      if (args?.script !== undefined) {
        code = String(args.script);
        origin = 'inline';
      } else if (args?.path !== undefined) {
        const file = await readWorkspaceFile(cwd, String(args.path));
        if (!file.ok) return fail(`${file.message} Nothing ran.`, { diagnostics: [] });
        scriptPath = file.absolute;
        origin = 'path';
        const header = compiler.extractMetadataHeader(file.text);
        const body = headerBody(header);
        if (header.ok && header.meta !== undefined && body !== undefined) {
          meta = header.meta;
          code = body;
          // 诊断按文件行报：正文第 1 行是这个文件的第 bodyLineOffset+1 行。
          lineOffset = headerLineOffset(header);
          runName = runName ?? meta.name;
          runArgs = validateSavedArgs(runArgs, meta.args ?? {});
          if (!runArgs.ok) return fail(`${runArgs.message} Nothing ran.`, { diagnostics: [] });
          runArgs = runArgs.args;
        } else {
          code = file.text;
        }
      } else {
        const saved = await resolveSaved(args.saved, cwd);
        if (!saved.ok) return fail(`${saved.message} Nothing ran.`, { diagnostics: [] });
        code = saved.code;
        meta = saved.meta;
        runArgs = saved.args;
        savedName = args.saved.name;
        savedPath = saved.entry?.path ?? args.saved.path;
        runName = runName ?? meta?.name ?? args.saved.name;
        origin = 'saved';
      }
      if (typeof code !== 'string' || code.trim().length === 0) {
        return fail('the workflow script is empty. Nothing ran.', { diagnostics: [] });
      }
      if (!has('start') && !has('prepare')) {
        return fail(`The workflow script compiled cleanly.\n\n${NO_EXECUTION_NOTE}`, { diagnostics: [] });
      }

      const label = typeof runName === 'string' && runName.length > 0 ? runName : 'workflow';
      if (scriptPath === undefined) {
        // ZCode saves an inline/saved script to a draft before compiling, so diagnostics and
        // the launch result name a file instead of asking for the script again.
        scriptPath = await draftFor(cwd, meta?.name ?? label, code);
      }
      const requested = {
        code,
        cwd,
        name: label,
        args: runArgs,
        maxConcurrency: typeof args?.max_concurrency === 'number' ? args.max_concurrency : undefined,
        subagentModel: typeof args?.subagent_model === 'string' ? args.subagent_model : undefined,
        scriptPath,
        origin,
      };

      /** @type {object | undefined} */
      let prepared;
      if (has('prepare')) {
        try {
          prepared = await runtime.prepare(requested);
        } catch (error) {
          return fail(`the workflow could not be prepared: ${error instanceof Error ? error.message : String(error)}`, { diagnostics: [] });
        }
      }
      const diagnostics = Array.isArray(prepared?.diagnostics) ? prepared.diagnostics : [];
      const draftPath = prepared?.draftPath ?? prepared?.scriptPath ?? scriptPath;
      if (prepared !== undefined && prepared.ok === false) {
        if (diagnostics.length > 0) {
          return compileFailure({
            cwd,
            diagnostics,
            absolutePath: draftPath,
            kind: args?.path !== undefined ? PATH_KIND : DRAFT_KIND,
            savedName,
            savedPath,
            lineOffset,
          });
        }
        return fail(prepared.error ?? 'the workflow could not start. Nothing ran.');
      }
      if (diagnostics.length > 0) {
        return compileFailure({
          cwd,
          diagnostics,
          absolutePath: draftPath,
          kind: args?.path !== undefined ? PATH_KIND : DRAFT_KIND,
          savedName,
          savedPath,
          lineOffset,
        });
      }

      const sessionId = sessionIdOf(exec);
      const proposalId = mintRunId();
      let maxConcurrency = requested.maxConcurrency;
      let subagentModel = requested.subagentModel;
      if (approval !== undefined) {
        const defaultModel = defaultSubagentModel(exec);
        const effectiveModel = subagentModel ?? defaultModel;
        const modelDefault = subagentModel === undefined;
        const models = await modelCatalog({ sessionId, session: exec?.agent?.session, parentRoute: parentRouteOf(defaultModel) });
        const display = {
          kind: 'create_workflow',
          ok: true,
          errorCount: 0,
          diagnostics: [],
          script: code,
          name: label,
          args: runArgs,
          probe: prepared?.prepared,
          phases: prepared?.phases,
          holes: prepared?.holes,
          artifacts: prepared?.artifacts,
          worldCommands: prepared?.worldCommands,
          causalityGraph: prepared?.causalityGraph,
          max_concurrency: maxConcurrency,
          // 只有显式选过模型才带 `subagent_model`：没选时留空，确认框才显示「沿用会话模型」
          // （ZCode 的 `Tzt(Pon(input))` 在缺省时得到 `{kind:'session'}`，同理）。
          ...(subagentModel === undefined ? {} : { subagent_model: subagentModel }),
          subagent_model_default: modelDefault,
          // 脚本自己点了模型名：模型行说的就只是「默认」用的那个（ZCode 的 model_bindings 非空）。
          scriptNamesModels: scriptModelNames(prepared, code, draftPath).length > 0,
          models,
          adjustable_settings: {
            subagent_model: true,
            ...(typeof runtime.defaultConcurrency === 'function' ? { concurrency_ceiling: runtime.defaultConcurrency() } : {}),
          },
          ...(args?.path === undefined ? {} : { path: String(args.path) }),
          ...(args?.saved === undefined ? {} : { saved: args.saved }),
        };
        const decision = await confirmLaunch({
          runId: proposalId,
          sessionId,
          toolName: 'CreateWorkflow',
          display,
          toolCallId: exec?.callId,
          signal: exec?.signal,
        });
        if (!decision.ok) return fail(decision.text, { rejected: true, reason: decision.reason ?? decision.text, reasonSource: decision.reasonSource, preserveReasonFormatting: decision.preserveReasonFormatting });
        if (decision.adjustments !== undefined) {
          // null = 回到默认（ZCode 的 `subagent_model: null` / `max_concurrency: null`）。
          if (decision.adjustments.maxConcurrency === null) maxConcurrency = undefined;
          else if (typeof decision.adjustments.maxConcurrency === 'number') maxConcurrency = decision.adjustments.maxConcurrency;
          if (decision.adjustments.subagentModel === null) subagentModel = undefined;
          else if (typeof decision.adjustments.subagentModel === 'string') subagentModel = decision.adjustments.subagentModel;
        }
      }

      const started = has('start')
        ? await runtime.start({
          ...requested,
          ...(prepared === undefined ? {} : { prepared: prepared.prepared ?? prepared }),
          notify: notifierFor(exec.agent),
          runner: runnerFor(exec, cwd),
          cwd,
          name: label,
          args: runArgs,
          maxConcurrency,
          subagentModel,
          runId: proposalId,
          // 浏览器按工具调用 id 把自己的运行卡认领到这次 run（ZCode 的认领方式）。
          ...(typeof exec?.callId === 'string' && exec.callId.length > 0 ? { toolCallId: exec.callId } : {}),
          origin,
        })
        : { ok: false, error: NO_EXECUTION_NOTE };
      if (!started?.ok) {
        const startDiagnostics = Array.isArray(started?.diagnostics) ? started.diagnostics : [];
        if (startDiagnostics.length > 0) {
          return compileFailure({
            cwd,
            diagnostics: startDiagnostics,
            absolutePath: started.scriptPath ?? draftPath,
            kind: args?.path !== undefined ? PATH_KIND : DRAFT_KIND,
            savedName,
            savedPath,
            lineOffset,
          });
        }
        return fail(started?.error ?? 'the workflow could not start. Nothing ran.');
      }
      const runId = started.runId ?? proposalId;
      const runDraft = started.scriptPath ?? started.draftPath ?? draftPath;
      const sentence = locationSentence(cwd, runDraft, args?.path !== undefined ? PATH_KIND : DRAFT_KIND);
      const text = backgroundedNotice(runId) + settingsSentence({ maxConcurrency, subagentModel }) + sentence;
      return succeed(text, {
        diagnostics: [],
        runId,
        scriptPath: runDraft,
        status: 'backgrounded',
        backgroundTaskId: runId,
      });
    },
  });

  // ---------------------------------------------------------------------------------------
  // AmendWorkflow
  // ---------------------------------------------------------------------------------------
  tools.push({
    name: 'AmendWorkflow',
    description: TOOL_DESCRIPTIONS.amendWorkflow,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: {
        run_id: {
          type: 'string',
          minLength: 1,
          description: 'ID of the run to amend (from a result, a notification, GetWorkflowRun or ListWorkflowRuns).',
        },
        script: {
          type: 'string',
          minLength: 1,
          description: 'The whole revised script, inline. This OR `path`, never both; omit both to keep the predecessor\'s script.',
        },
        path: {
          type: 'string',
          minLength: 1,
          description: "The revised script's file, usually the predecessor's own script file edited in place. This OR `script`, never both.",
        },
        name: {
          type: 'string',
          minLength: 1,
          description: "Display label for the new run; defaults to the predecessor's.",
        },
        max_concurrency: {
          // 契约允许 null（回到默认）；DSH 的 JSON Schema 只收单一 type，用 anyOf 表达可空。
          anyOf: [{ type: 'integer' }, { type: 'null' }],
          minimum: 1,
          description: "Omit to keep the predecessor's limit, null to return to the default, a number to set one above or below it (only when the user asks).",
        },
        subagent_model: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
          minLength: 1,
          description: 'Omit to keep the predecessor\'s choice, null for the session model, a model id to set one (only when the user asks, never a model under another provider the user did not name — ask them first if one would help).',
        },
      },
    },
    async execute(args, exec) {
      if (args?.script !== undefined && args?.path !== undefined) return fail(AMEND_BOTH_SCRIPTS);
      if (!has('getRun') || !has('amend')) {
        return has('getRun') ? fail(`workflow_amend_refused: the workflow runtime refused to amend run ${String(args?.run_id)} (reason: amend is not available in this runtime). Nothing was stopped or created.`) : fail(INTROSPECTION_UNAVAILABLE);
      }
      const previous = await runtime.getRun(String(args?.run_id));
      if (previous === undefined || previous === null) return fail(runNotFound(String(args?.run_id)));
      const cwd = sessionCwd(ctx, exec) || previous.cwd || process.cwd();
      const runId = previous.id ?? previous.runId ?? String(args?.run_id);

      let code;
      let scriptPath;
      let kind;
      let described;
      // 内联 script 原样写成草稿，诊断行号就是草稿行号；从文件读来的才剥头、才要补偏移。
      let lineOffset = 0;
      const inherited = args?.script === undefined && args?.path === undefined;
      if (args?.script !== undefined) {
        code = String(args.script);
        kind = DRAFT_KIND;
        scriptPath = await draftFor(cwd, previous.name ?? previous.label ?? 'workflow', code);
        if (typeof scriptPath === 'string') described = describePath(cwd, scriptPath);
      } else if (args?.path !== undefined) {
        const file = await readWorkspaceFile(cwd, String(args.path));
        if (!file.ok) return fail(`workflow_script_file_unreadable: ${file.message} Nothing was stopped or created.`);
        code = file.text;
        scriptPath = file.absolute;
        described = file.described;
        kind = PATH_KIND;
        const header = compiler.extractMetadataHeader(file.text);
        const body = headerBody(header);
        if (header.ok && header.meta !== undefined && body !== undefined) {
          code = body;
          lineOffset = headerLineOffset(header);
        }
        const predecessorPath = typeof previous.scriptPath === 'string' ? previous.scriptPath : undefined;
        if (predecessorPath !== undefined) {
          const previousText = await fsp.readFile(predecessorPath, 'utf8').catch(() => undefined);
          if (previousText !== undefined && previousText === file.text) {
            return fail(`workflow_script_unchanged: ${described} is byte-for-byte the script run ${runId} was started with, so amending it would repeat that run exactly. Edit the file first, then call AmendWorkflow again with the same \`path\`; to change only the settings, pass them and omit \`path\`; to continue a stopped run under the same script, use ResumeWorkflowRun. Nothing was stopped or created.`);
          }
        }
      } else {
        const predecessorPath = typeof previous.scriptPath === 'string' ? previous.scriptPath : undefined;
        if (predecessorPath !== undefined) {
          const previousFile = await readWorkspaceFile(cwd, predecessorPath);
          if (previousFile.ok) {
            code = previousFile.text;
            scriptPath = previousFile.absolute;
            described = previousFile.described;
            kind = PATH_KIND;
            const header = compiler.extractMetadataHeader(code);
            const body = headerBody(header);
            if (header.ok && header.meta !== undefined && body !== undefined) {
              code = body;
              lineOffset = headerLineOffset(header);
            }
          }
        }
        if (code === undefined && typeof store.getRun === 'function') {
          const stored = await store.getRun(runId, { cwd: previous.cwd ?? cwd }).catch(() => undefined);
          if (typeof stored?.scriptText === 'string') code = stored.scriptText;
        }
        if (code === undefined) {
          return fail(`workflow_amend_script_unavailable: this host cannot read run ${runId}'s stored script, so the script cannot be omitted here — pass the whole script as \`script\`, or its file as \`path\`. Nothing was stopped or created.`);
        }
      }

      /** @type {object | undefined} */
      let prepared;
      if (has('prepare')) {
        try {
          prepared = await runtime.prepare({
            code,
            cwd,
            name: args?.name ?? previous.name ?? 'workflow',
            args: previous.args ?? {},
            maxConcurrency: typeof args?.max_concurrency === 'number' ? args.max_concurrency : previous.maxConcurrency,
            subagentModel: typeof args?.subagent_model === 'string' ? args.subagent_model : previous.subagentModel,
            scriptPath,
            origin: 'amend',
          });
        } catch (error) {
          return fail(`the revised workflow could not be prepared: ${error instanceof Error ? error.message : String(error)}`);
        }
        const diagnostics = Array.isArray(prepared?.diagnostics) ? prepared.diagnostics : [];
        if ((prepared !== undefined && prepared.ok === false) || diagnostics.length > 0) {
          const draftPath = prepared?.draftPath ?? prepared?.scriptPath ?? scriptPath;
          const describedDraft = draftPath === undefined ? '' : describePath(cwd, draftPath);
          if (diagnostics.length === 0) return fail(prepared?.error ?? 'the revised workflow could not be compiled. Nothing was stopped or created.');
          return fail([
            'The revised workflow script has errors:',
            renderDiagnostics(describedDraft.length > 0 ? describedDraft : 'workflow.ts', diagnostics, lineOffset),
            '',
            describedDraft.length > 0
              ? scriptFileNote({ kind, described: describedDraft })
              : COMPILE_FAILED_NOTE,
            `Run ${runId} was not touched.`,
          ].join('\n'), { diagnostics, scriptPath: draftPath });
        }
      }

      const sessionId = sessionIdOf(exec);
      const owned = previous.parentSessionId !== undefined && sessionId.length > 0
        ? previous.parentSessionId === sessionId
        : previous.ownedByThisSession;
      const stopReason = previous.stopReason ?? previous.stop_reason;
      // 确认框展示这次 amend 实际会用的值：本次参数优先，否则沿用前序 run 的设置。
      const defaultModel = defaultSubagentModel(exec);
      const requestedModel = typeof args?.subagent_model === 'string' ? args.subagent_model : undefined;
      let subagentModel = args?.subagent_model === null ? undefined : (requestedModel ?? previous.subagentModel);
      let maxConcurrency = args?.max_concurrency === null
        ? undefined
        : (typeof args?.max_concurrency === 'number' ? args.max_concurrency : previous.maxConcurrency);
      const scriptModels = scriptModelNames(prepared, code, scriptPath);
      // 引入新的 provider 就撤回静默放行：这次 amend 会让子代理跑在这个会话还没授权过的一家上。
      const introduced = introducedProviders({ subagentModel, scriptModels, predecessor: previous, fallbackModel: defaultModel });
      const shouldAsk = approval !== undefined
        && (owned === false || (previous.status === 'stopped' && stopReason === 'user') || introduced.length > 0);
      if (shouldAsk) {
        const effectiveModel = subagentModel ?? defaultModel;
        const modelDefault = subagentModel === undefined;
        const models = await modelCatalog({ sessionId, session: exec?.agent?.session, parentRoute: parentRouteOf(defaultModel) });
        const display = {
          kind: 'amend_workflow',
          ok: true,
          errorCount: 0,
          diagnostics: [],
          script: code,
          run_id: runId,
          name: args?.name ?? previous.name,
          predecessor: {
            name: previous.name ?? previous.label,
            status: previous.status,
            stop_reason: stopReason,
            owned_by_this_session: owned === true,
            script_inherited: inherited,
            ...(introduced.length === 0 ? {} : { introduces_providers: introduced }),
          },
          max_concurrency: maxConcurrency,
          // 只有显式选过模型才带 `subagent_model`：没选时留空，确认框才显示「沿用会话模型」
          // （ZCode 的 `Tzt(Pon(input))` 在缺省时得到 `{kind:'session'}`，同理）。
          ...(subagentModel === undefined ? {} : { subagent_model: subagentModel }),
          subagent_model_default: modelDefault,
          scriptNamesModels: scriptModels.length > 0,
          models,
          causalityGraph: prepared?.causalityGraph,
          adjustable_settings: {
            subagent_model: true,
            ...(typeof runtime.defaultConcurrency === 'function' ? { concurrency_ceiling: runtime.defaultConcurrency() } : {}),
          },
        };
        const decision = await confirmLaunch({
          runId,
          sessionId,
          toolName: 'AmendWorkflow',
          display,
          toolCallId: exec?.callId,
          signal: exec?.signal,
        });
        if (!decision.ok) return fail(decision.text, { rejected: true, reason: decision.reason ?? decision.text, reasonSource: decision.reasonSource, preserveReasonFormatting: decision.preserveReasonFormatting });
        if (decision.adjustments !== undefined) {
          // null = 回到默认（ZCode 的 `subagent_model: null` / `max_concurrency: null`）。
          if (decision.adjustments.maxConcurrency === null) maxConcurrency = undefined;
          else if (typeof decision.adjustments.maxConcurrency === 'number') maxConcurrency = decision.adjustments.maxConcurrency;
          if (decision.adjustments.subagentModel === null) subagentModel = undefined;
          else if (typeof decision.adjustments.subagentModel === 'string') subagentModel = decision.adjustments.subagentModel;
        }
      }

      const wasRunning = isRunning(previous);
      const adjusted = {
        ...(code === undefined ? {} : { code }),
        ...(scriptPath === undefined ? {} : { scriptPath }),
        name: typeof args?.name === 'string' ? args.name : previous.name,
        maxConcurrency,
        subagentModel,
        // amend 与 start 用同一个字段名，浏览器才能按 callId 认领新的 run。
        ...(typeof exec?.callId === 'string' && exec.callId.length > 0 ? { toolCallId: exec.callId } : {}),
        runner: runnerFor(exec, cwd),
        notify: notifierFor(exec.agent),
      };
      let amended;
      try {
        amended = await runtime.amend(runId, adjusted);
      } catch (error) {
        return fail(`workflow_amend_refused: the workflow runtime refused to amend run ${runId} (reason: ${error instanceof Error ? error.message : String(error)}). Nothing was stopped or created.`);
      }
      if (!amended?.ok) {
        const reason = amended?.code ?? amended?.reason;
        const message = typeof amended?.message === 'string' ? amended.message : '';
        const diagnostics = Array.isArray(amended?.diagnostics) ? amended.diagnostics : [];
        if (diagnostics.length > 0) {
          const draftPath = amended?.draftPath ?? amended?.scriptPath ?? scriptPath;
          const describedDraft = typeof draftPath === 'string' ? describePath(cwd, draftPath) : undefined;
          return fail([
            'The revised workflow script has errors:',
            renderDiagnostics(describedDraft ?? 'workflow.ts', diagnostics, lineOffset),
            '',
            describedDraft === undefined ? COMPILE_FAILED_NOTE : scriptFileNote({ kind: kind ?? DRAFT_KIND, described: describedDraft }),
            `Run ${runId} was not touched.`,
          ].join('\n'), { diagnostics, scriptPath: draftPath });
        }
        if (reason === 'not_found' || reason === 'RUN_NOT_FOUND') return fail(runNotFound(runId));
        if (reason === 'SCRIPT_UNCHANGED' || reason === 'script_unchanged') return fail(message.length > 0 ? message : `workflow_script_unchanged: run ${runId} would run exactly as before. Nothing was stopped or created.`);
        if (reason === 'missing_boundaries' || reason === 'MISSING_BOUNDARIES') {
          return fail(`workflow_amend_missing_boundaries: run ${runId}'s journal predates transcript-boundary bookkeeping (or its boundaries were never recorded), so its finished asks cannot seed an amended run — there is no fallback. Submit this script as a fresh CreateWorkflow instead. Nothing was stopped or created.`);
        }
        if (reason === 'script_unavailable' || reason === 'SCRIPT_UNAVAILABLE') {
          return fail(`workflow_amend_script_unavailable: ${message || 'the predecessor script is not stored'}, so the script cannot be omitted here — pass the whole script as \`script\`, or its file as \`path\`. Nothing was stopped or created.`);
        }
        return fail(`workflow_amend_refused: the workflow runtime refused to amend run ${runId} (reason: ${reason ?? 'unknown'}).${message.length > 0 ? ` ${message}` : ''} Nothing was stopped or created.`);
      }
      const successor = amended.runId ?? amended.id;
      const superseded = wasRunning ? (amended.supersededRunId ?? runId) : undefined;
      const settledText = superseded === undefined
        ? `Run ${runId} had already settled; its finished work is imported as cache.`
        : `Run ${superseded} was still running: it has been stopped and superseded, and everything it finished before the stop is imported as cache. It will not send a notification of its own.`;
      const scriptText = inherited
        ? `The script of run ${runId} started unchanged in the background as run ${successor}.`
        : `The revised script started in the background as run ${successor}.`;
      const revisionPath = amended.scriptPath ?? scriptPath ?? previous.scriptPath;
      const revision = typeof revisionPath === 'string' && revisionPath.length > 0
        ? revisedScriptSentence(describePath(cwd, revisionPath))
        : '';
      const text = `${settledText} ${scriptText} It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.${settingsSentence({ maxConcurrency: adjusted.maxConcurrency, subagentModel: adjusted.subagentModel })}${revision}`;
      return succeed(text, {
        diagnostics: [],
        runId: successor,
        ...(wasRunning ? { supersededRunId: runId } : {}),
        status: 'backgrounded',
        backgroundTaskId: successor,
        ...(typeof amended.scriptPath === 'string' ? { scriptPath: amended.scriptPath } : {}),
      });
    },
  });

  // ---------------------------------------------------------------------------------------
  // ResumeWorkflowRun
  // ---------------------------------------------------------------------------------------
  tools.push({
    name: 'ResumeWorkflowRun',
    description: TOOL_DESCRIPTIONS.resumeWorkflowRun,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: {
        run_id: {
          type: 'string',
          minLength: 1,
          description: 'The workflow run ID to resume — a cancelled run or one that failed with code `Interrupted`, as seen with GetWorkflowRun or ListWorkflowRuns',
        },
      },
    },
    async execute(args, exec) {
      if (!has('resume')) return fail(RESUME_UNAVAILABLE);
      const runId = String(args?.run_id);
      const result = await runtime.resume(runId, {
        runner: runnerFor(exec, sessionCwd(ctx, exec)),
        notify: notifierFor(exec.agent),
        signal: exec?.signal,
      });
      if (result?.ok) {
        const resumed = result.runId ?? runId;
        return succeed(`The workflow run ${resumed} has been resumed and is running in the background. It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.`, {
          runId: resumed,
          status: 'backgrounded',
          backgroundTaskId: resumed,
        });
      }
      const reason = result?.code ?? result?.reason;
      const message = typeof result?.message === 'string' ? result.message : '';
      if (reason === 'not_found' || reason === 'RUN_NOT_FOUND') return fail(runNotFound(runId));
      const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
      if (diagnostics.length > 0) {
        return fail([
          RESUME_MESSAGES.compile_failed.replaceAll('{runId}', runId),
          renderDiagnostics(result?.draftPath ?? result?.scriptPath ?? 'workflow.ts', diagnostics),
        ].join('\n'), { diagnostics });
      }
      if (reason === 'compile_failed' || reason === 'COMPILE_FAILED') {
        return fail(RESUME_MESSAGES.compile_failed.replaceAll('{runId}', runId) + (message.length > 0 ? `\n${message}` : ''));
      }
      if (reason === 'superseded' || reason === 'SUPERSEDED') {
        const successor = result?.supersededBy === undefined ? '' : ` The successor run is ${result.supersededBy}.`;
        return fail(RESUME_MESSAGES.superseded.replaceAll('{runId}', runId) + successor);
      }
      if (reason === 'already_running' || reason === 'ALREADY_RUNNING') return fail(RESUME_MESSAGES.already_running);
      if (reason === 'script_missing' || reason === 'SCRIPT_MISSING') return fail(RESUME_MESSAGES.script_missing);
      if (reason === 'script_mismatch' || reason === 'SCRIPT_MISMATCH') {
        return fail(`workflow_run_script_mismatch: the stored script hash for run ${runId} no longer matches the stored script text — the journal record was modified by an outside force. Start a fresh run with CreateWorkflow instead.`);
      }
      if (reason === 'not_resumable' || reason === 'NOT_RESUMABLE') return fail(RESUME_MESSAGES.not_resumable);
      if (message.length > 0) return fail(message);
      return fail(RESUME_MESSAGES.other.replaceAll('{runId}', runId).replace('{reason}', String(reason ?? 'unknown')));
    },
  });

  // ---------------------------------------------------------------------------------------
  // GetWorkflowRun
  // ---------------------------------------------------------------------------------------
  tools.push({
    name: 'GetWorkflowRun',
    description: TOOL_DESCRIPTIONS.getWorkflowRun,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: {
        run_id: {
          type: 'string',
          minLength: 1,
          description: 'The workflow run ID to inspect (as returned by CreateWorkflow or ListWorkflowRuns)',
        },
      },
    },
    async execute(args) {
      if (!has('getRun')) return fail(INTROSPECTION_UNAVAILABLE);
      const run = await runtime.getRun(String(args?.run_id));
      if (run === undefined || run === null) return fail(runNotFound(String(args?.run_id)));
      return succeed(renderRun(run, undefined), toRunOutput(run));
    },
  });

  // ---------------------------------------------------------------------------------------
  // ListWorkflowRuns
  // ---------------------------------------------------------------------------------------
  tools.push({
    name: 'ListWorkflowRuns',
    description: TOOL_DESCRIPTIONS.listWorkflowRuns,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 20,
          description: 'Maximum number of runs to return (1-50, default 20). Most recently updated runs come first.',
        },
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['completed', 'errored', 'pending', 'running', 'stopped'] },
          description: 'Optional status filter. Omit to see every run in this project. Pass ["running", "pending"] to see only what is still in flight.',
        },
      },
    },
    async execute(args, exec) {
      if (!has('listRuns')) return fail(INTROSPECTION_UNAVAILABLE);
      const raw = args?.limit;
      const limit = typeof raw === 'number' && Number.isFinite(raw)
        ? Math.min(50, Math.max(1, Math.trunc(raw)))
        : 20;
      const listed = await runtime.listRuns({
        // 多要一行：契约的 `truncated` 只表示“还有更多 run 没进这一页”。
        limit: limit + 1,
        cwd: sessionCwd(ctx, exec),
        sessionId: sessionIdOf(exec),
      });
      const rows = Array.isArray(listed) ? listed : (Array.isArray(listed?.runs) ? listed.runs : []);
      const overflow = rows.length > limit;
      const page = overflow ? rows.slice(0, limit) : rows;
      const statuses = Array.isArray(args?.statuses) ? args.statuses : undefined;
      const filtered = statuses === undefined ? page : page.filter((row) => statuses.includes(row.status));
      if (page.length === 0) {
        return succeed('No workflow runs exist in this project yet.', { runs: [] });
      }
      if (filtered.length === 0) {
        return succeed(`No workflow runs match that status filter (${statuses.join(', ')}).`, { runs: [] });
      }
      const truncated = overflow || (!Array.isArray(listed) && listed?.truncated === true);
      return succeed(budget([
        `${filtered.length} workflow run(s), most recent first:`,
        ...filtered.map((row) => renderRunRow(row)),
        ...(truncated === true ? ['(more runs exist than this limit; raise `limit` to 50)'] : []),
      ].join('\n')), {
        runs: filtered.map((row) => toRunRow(row)),
        ...(truncated === true ? { truncated: true } : {}),
      });
    },
  });

  // ---------------------------------------------------------------------------------------
  // FillWorkflowHole
  // ---------------------------------------------------------------------------------------
  tools.push({
    name: 'FillWorkflowHole',
    description: TOOL_DESCRIPTIONS.fillWorkflowHole,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id', 'hole_id'],
      properties: {
        run_id: {
          type: 'string',
          minLength: 1,
          description: 'ID of the run that is waiting at the hole (from the hole notification).',
        },
        hole_id: {
          type: 'string',
          minLength: 1,
          description: "The hole's site id from the notification or from GetWorkflowRun's holes, e.g. `hole#21b40fca`.",
        },
        script: {
          type: 'string',
          minLength: 1,
          description: "The body: only the statements of the hole's function, inline. This OR `path`, never both. It is compiled where the hole stands and sees every binding declared before it; it must return the hole's type.",
        },
        path: {
          type: 'string',
          minLength: 1,
          description: 'A file holding those statements — usually the fill file named by a rejected attempt, edited in place. This OR `script`, never both.',
        },
      },
    },
    async execute(args, exec) {
      const runId = String(args?.run_id);
      const holeId = String(args?.hole_id);
      const sources = [args?.script, args?.path].filter((value) => value !== undefined);
      if (sources.length !== 1) return fail(FILL_SOURCE);
      const cwd = sessionCwd(ctx, exec);
      let body;
      let fillPath;
      if (args?.script !== undefined) {
        body = String(args.script);
      } else {
        const file = await readWorkspaceFile(cwd, String(args.path));
        if (!file.ok) {
          return fail(`workflow_fill_file_unreadable: ${file.message}. Pass \`path\` for the fill file a previous result named, or submit the body inline as \`script\`. Nothing was filled.`);
        }
        if (file.text.length === 0) {
          return fail(`workflow_fill_file_unreadable: ${file.described} is empty. Pass \`path\` for the fill file a previous result named, or submit the body inline as \`script\`. Nothing was filled.`);
        }
        body = file.text;
        fillPath = file.described;
      }
      if (!has('fillHole')) return fail(FILL_UNAVAILABLE);
      const before = has('getRun') ? await runtime.getRun(runId) : undefined;
      let result;
      try {
        // The tool resolves `path` itself (workspace check, readable file) and hands the
        // runtime the statements; dev-engine's fillHole accepts `{ script }` or `{ path }`
        // and compiles the body where the hole stands.
        result = await runtime.fillHole(runId, holeId, { script: body });
      } catch (error) {
        return fail(`workflow_fill_refused: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!result?.ok) {
        const reason = result?.code ?? result?.reason;
        const message = result?.message ?? '';
        if (reason === 'RUN_NOT_FOUND' || reason === 'run_not_found') {
          return fail(`${runNotFound(runId)} Nothing was filled: \`run_id\` pointed at a run that does not exist — take it from the hole notification or from ListWorkflowRuns.`);
        }
        if (reason === 'BODY_UNAVAILABLE' || reason === 'body_unavailable') {
          return fail('workflow_fill_body_unavailable: the call reached the handler without a resolved body. Pass `script` or `path`. Nothing was filled.');
        }
        const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
        if (diagnostics.length > 0) return fillCompileFailure({ runId, holeId, diagnostics, fillPath });
        if (reason === 'RUN_SETTLED' || reason === 'NOT_WAITING' || reason === 'run_settled' || reason === 'not_waiting') {
          return fail(`${message.length > 0 ? message : `run ${runId} is not waiting at ${holeId}.`}${/Nothing was filled/u.test(message) ? '' : ' Nothing was filled.'}`);
        }
        return fail(`hole_not_waiting: ${message.length > 0 ? message : `run ${runId} is not waiting at ${holeId}.`} Nothing was filled.`);
      }
      const holeName = result.name ?? result.holeName ?? holeId;
      const after = has('getRun') ? await runtime.getRun(runId) : undefined;
      const beforePhases = Array.isArray(before?.phases) ? before.phases.map((phase) => (typeof phase === 'string' ? phase : phase?.name)).filter(Boolean) : [];
      const afterPhases = Array.isArray(after?.phases) ? after.phases.map((phase) => (typeof phase === 'string' ? phase : phase?.name)).filter(Boolean) : [];
      const phasesAdded = afterPhases.filter((name) => !beforePhases.includes(name));
      const phaseText = phasesAdded.length === 0
        ? 'It added no phases.'
        : `It added the phase${phasesAdded.length === 1 ? '' : 's'} ${phasesAdded.join(', ')}.`;
      const returnedPath = result.scriptPath ?? result.draftPath;
      const runPath = returnedPath ?? before?.scriptPath ?? after?.scriptPath;
      const draftText = typeof returnedPath === 'string' && returnedPath.length > 0
        ? `The run's draft ${describePath(cwd, returnedPath)} now holds the effective script: edit that file and pass \`path\` to AmendWorkflow for any later revision.`
        : (typeof runPath === 'string' && runPath.length > 0
          ? `The body is journaled against run ${runId}; to change anything outside the hole, edit the run's script (${describePath(cwd, runPath)}) and call AmendWorkflow.`
          : 'The run has no draft file, so a later revision must pass the whole script to AmendWorkflow.');
      const text = `The fill joined run ${runId} at hole "${holeName}" (${holeId}); the branch parked there has resumed and the run keeps going in the background. ${phaseText} ${draftText} Do not wait for the run or poll it with TaskOutput; you will be notified when it completes.`;
      return succeed(text, {
        fill: {
          siteId: holeId,
          name: holeName,
          ...(typeof runPath === 'string' ? { draftPath: runPath } : {}),
          ...(typeof result.line === 'number' ? { line: result.line } : {}),
        },
        diagnostics: [],
      });
    },
  });

  // ---------------------------------------------------------------------------------------
  // EvalWorkflowSnippet
  // ---------------------------------------------------------------------------------------
  tools.push({
    name: 'EvalWorkflowSnippet',
    description: TOOL_DESCRIPTIONS.evalWorkflowSnippet,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: {
          type: 'string',
          minLength: 1,
          description: 'The snippet, inline. This OR `path`, never both.',
        },
        path: {
          type: 'string',
          minLength: 1,
          description: 'A file holding the snippet, read whole. This OR `code`, never both.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 600000,
          description: 'Wall clock for the whole snippet, in ms. Default 60000, at most 600000.',
        },
      },
    },
    async execute(args, exec) {
      const sources = [args?.code, args?.path].filter((value) => value !== undefined);
      if (sources.length === 0) return fail(SNIPPET_NO_SOURCE);
      if (sources.length > 1) return fail(SNIPPET_BOTH_SOURCES);
      const cwd = sessionCwd(ctx, exec);
      let code;
      if (args?.code !== undefined) {
        code = String(args.code);
      } else {
        const file = await readWorkspaceFile(cwd, String(args.path));
        if (!file.ok) return fail(`${file.message}. Nothing ran.`);
        code = file.text;
      }
      if (!has('evaluate')) return fail(EVAL_UNAVAILABLE);
      const timeoutMs = typeof args?.timeoutMs === 'number'
        ? Math.min(600000, Math.max(1000, Math.trunc(args.timeoutMs)))
        : 60000;
      const result = await runtime.evaluate({ code, cwd, timeoutMs, signal: exec?.signal });
      const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
      if (diagnostics.length > 0) {
        return fail([
          'The snippet has errors:',
          renderDiagnostics('snippet.ts', diagnostics),
          '',
          'NOTE: The snippet was NOT executed — fix the errors above and call the tool again.',
        ].join('\n'), { diagnostics });
      }
      if (!result?.ok) {
        return fail(`The snippet failed: ${result?.error ?? 'unknown error'}${Array.isArray(result?.logs) && result.logs.length > 0 ? `\n\nLogs:\n${result.logs.map((line) => `- ${line}`).join('\n')}` : ''}`);
      }
      const value = result.value;
      const rendered = value === undefined || value === null
        ? 'It returned no value.'
        : `Return value:\n${budget(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 4000)}`;
      const text = budget([
        `The snippet completed in ${result.durationMs ?? 0}ms.`,
        rendered,
        ...(Array.isArray(result.logs) && result.logs.length > 0 ? ['', 'Logs:', ...result.logs.map((line) => `- ${line}`)] : []),
      ].join('\n'));
      return succeed(text, { diagnostics: [], logs: result.logs ?? [], durationMs: result.durationMs ?? 0 });
    },
  });

  // ---------------------------------------------------------------------------------------
  // SaveWorkflow
  // ---------------------------------------------------------------------------------------
  tools.push({
    name: 'SaveWorkflow',
    description: TOOL_DESCRIPTIONS.saveWorkflow,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description', 'scope'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'File-safe identifier: letters, digits, dot, dash and underscore.',
        },
        description: {
          type: 'string',
          minLength: 1,
          description: 'One line saying what the workflow does.',
        },
        whenToUse: {
          type: 'string',
          minLength: 1,
          description: 'When this workflow is the right answer.',
        },
        args: {
          type: 'object',
          // record<name, {type, description?, required?, default?}>：DSH 的 schema 校验只收布尔
          // additionalProperties，逐项结构交给宿主侧的元数据校验。
          additionalProperties: true,
          description: 'Argument declarations the script reads off `args`.',
        },
        script: {
          type: 'string',
          description: 'The script body, inline, without a metadata block. This OR `script_path`, never both.',
        },
        script_path: {
          type: 'string',
          minLength: 1,
          description: 'A file holding the script body, usually a draft a result named. This OR `script`, never both.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: '"project" when the script depends on this repository; "global" when it depends on nothing in it. Required, no default.',
        },
        run_id: {
          type: 'string',
          minLength: 1,
          description: 'Provenance only: the id of the run this workflow was distilled from, when saving a workflow that just ran. Pass it whenever you know it; it does not change what is saved.',
        },
      },
    },
    async execute(args, exec) {
      const hasScript = args?.script !== undefined;
      const hasPath = args?.script_path !== undefined;
      if (hasScript === hasPath) return fail(SAVE_BOTH_SOURCES);
      if (args?.scope !== 'project' && args?.scope !== 'global') {
        return fail('`scope` is required and must be "project" or "global": "project" when the script depends on this repository; "global" when it depends on nothing in it. Nothing was saved.');
      }
      const cwd = sessionCwd(ctx, exec);
      let code;
      // 存盘文件由这份正文加一个 metadata 头写成，所以诊断按那个文件的行走。
      let lineOffset = 0;
      if (hasScript) {
        code = String(args.script);
        if (/^\s*\/\*\s*zcode-workflow/u.test(code)) return fail(SAVE_BODY_ONLY);
      } else {
        const file = await readWorkspaceFile(cwd, String(args.script_path));
        if (!file.ok) return fail(`${file.message}. Nothing was saved.`);
        const header = compiler.extractMetadataHeader(file.text);
        const body = headerBody(header);
        if (header.ok && body !== undefined) {
          code = body;
          lineOffset = headerLineOffset(header);
        } else {
          code = file.text;
        }
      }
      const nameCheck = typeof store.validateSavedWorkflowName === 'function'
        ? store.validateSavedWorkflowName(args.name)
        : { ok: true };
      if (nameCheck.ok === false) return fail(`${nameCheck.message ?? 'invalid workflow name'} Nothing was saved.`);
      const filename = `${args.name}.dwf.ts`;
      const compiled = compiler.compileWorkflowScript({ code, filename, mode: 'workflow' });
      if (!compiled.ok) {
        return fail([
          'The workflow script has errors:',
          renderDiagnostics(filename, compiled.diagnostics, lineOffset),
          '',
          'NOTE: Nothing was saved — fix the errors above and call the tool again.',
        ].join('\n'), { diagnostics: compiled.diagnostics });
      }
      const saved = await store.saveSavedWorkflow({
        cwd,
        name: args.name,
        scope: args.scope,
        code,
        meta: {
          description: args.description,
          whenToUse: args.whenToUse,
          args: args.args !== null && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args : undefined,
        },
        overwrite: true,
      });
      if (!saved?.ok) return fail(`${saved?.message ?? 'the workflow could not be saved'} Nothing was saved.`);
      const scopeNote = saved.scope === 'global' ? 'global' : 'project';
      const text = `${saved.overwritten ? 'Replaced' : 'Saved'} the ${scopeNote} workflow "${args.name}" at ${describePath(cwd, saved.path)}. Run it with CreateWorkflow using \`saved: { name: "${args.name}" }\`.`;
      return succeed(text, {
        name: args.name,
        scope: saved.scope,
        path: saved.path,
        overwritten: saved.overwritten,
        diagnostics: [],
      });
    },
  });

  // ---------------------------------------------------------------------------------------
  // ListSavedWorkflows
  // ---------------------------------------------------------------------------------------
  tools.push({
    name: 'ListSavedWorkflows',
    description: TOOL_DESCRIPTIONS.listSavedWorkflows,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(args, exec) {
      const cwd = sessionCwd(ctx, exec);
      const listed = await store.listSavedWorkflows({ cwd });
      const entries = Array.isArray(listed) ? listed : (Array.isArray(listed?.entries) ? listed.entries : []);
      const invalid = Array.isArray(listed?.invalid) ? listed.invalid : [];
      if (entries.length === 0 && invalid.length === 0) {
        return succeed('No saved workflows exist for this project or globally.', { workflows: [] });
      }
      const lines = [`${entries.length} saved workflow(s):`];
      const workflows = [];
      for (const entry of entries) {
        const declarations = entry.meta?.args;
        const argText = declarations !== null && typeof declarations === 'object' && !Array.isArray(declarations) && Object.keys(declarations).length > 0
          ? `\n  Args: ${Object.entries(declarations).map(([name, declaration]) => `${name}:${declaration?.type ?? 'string'}${declaration?.required === true ? ' (required)' : ''}`).join(', ')}`
          : '';
        const whenText = entry.meta?.whenToUse === undefined ? '' : `\n  When to use: ${entry.meta.whenToUse}`;
        lines.push(`- ${entry.name} [${entry.scope}] — ${entry.meta?.description ?? '(no description)'}${whenText}${argText}\n  Path: ${describePath(cwd, entry.path)}`);
        workflows.push({
          name: entry.name,
          scope: entry.scope,
          description: entry.meta?.description,
          whenToUse: entry.meta?.whenToUse,
          args: entry.meta?.args,
          path: entry.path,
        });
      }
      for (const bad of invalid) lines.push(`- (unreadable) ${bad.path}: ${bad.reason}`);
      return succeed(budget(lines.join('\n')), { workflows, invalid });
    },
  });

  // ---------------------------------------------------------------------------------------
  // ResolveWorkflowQuestion
  // ---------------------------------------------------------------------------------------
  tools.push({
    name: 'ResolveWorkflowQuestion',
    description: TOOL_DESCRIPTIONS.resolveWorkflowQuestion,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question_id', 'answer'],
      properties: {
        question_id: {
          type: 'string',
          minLength: 1,
          description: "The question ID from the escalation notification, or from GetWorkflowRun's pending questions (looks like `dwfq-...`)",
        },
        answer: {
          type: 'string',
          minLength: 1,
          description: 'The answer text, delivered verbatim to the subagent that asked',
        },
      },
    },
    async execute(args) {
      const questionId = typeof args?.question_id === 'string' ? args.question_id : '';
      const answer = typeof args?.answer === 'string' ? args.answer : '';
      if (questionId.length === 0 || answer.length === 0) {
        return fail('workflow_question_invalid: `question_id` and `answer` are both required (min 1 character). Nothing was answered.');
      }
      if (!has('resolveQuestion') && !has('answerQuestion')) return fail(ANSWERING_UNAVAILABLE);
      const resolve = has('resolveQuestion') ? runtime.resolveQuestion : runtime.answerQuestion;
      const result = await resolve(questionId, answer);
      if (result?.ok) {
        const qid = result.qid ?? questionId;
        return succeed(`Answer delivered for question ${qid}. The subagent that asked has resumed its turn with your answer; the run keeps going as before.`, {
          qid,
        });
      }
      const reason = result?.code ?? result?.reason;
      if (reason === 'UNKNOWN_QUESTION' || reason === 'unknown_question') {
        return fail(`unknown_question: no workflow question with ID ${questionId} is waiting in this session's runs. Check GetWorkflowRun's pendingQuestions for the questions a run still owes an answer to.`);
      }
      if (reason === 'ALREADY_RESOLVED' || reason === 'already_resolved') {
        return fail(`already_resolved: question ${questionId} has already been answered; the subagent that asked has resumed. Do not answer it again.`);
      }
      if (reason === 'RUN_NOT_IN_FLIGHT' || reason === 'run_not_in_flight') {
        return fail(`run_not_in_flight: the run that asked ${questionId} is no longer running, so there is nothing left to answer. GetWorkflowRun shows its terminal state.`);
      }
      if (reason === 'ANSWERING_UNAVAILABLE' || reason === 'answering_unavailable') return fail(ANSWERING_UNAVAILABLE);
      return fail(`workflow_question_refused: the workflow runtime refused to deliver the answer${reason === undefined ? '' : ` (reason: ${reason})`}.${typeof result?.message === 'string' && result.message.length > 0 ? ` ${result.message}` : ''}`);
    },
  });

  // ---------------------------------------------------------------------------------------
  // TaskOutput
  // ---------------------------------------------------------------------------------------
  tools.push({
    name: 'TaskOutput',
    description: TOOL_DESCRIPTIONS.taskOutput,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: {
        run_id: {
          type: 'string',
          minLength: 1,
          description: 'The workflow run ID to wait for.',
        },
        block: {
          type: 'boolean',
          default: true,
          description: 'Wait for the run to settle (default), or return the current snapshot immediately.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: 3600000,
          default: 600000,
          description: 'How long to wait before returning the current snapshot, in ms (default 600000, at most 3600000).',
        },
      },
    },
    async execute(args, exec) {
      if (!has('getRun')) return fail(INTROSPECTION_UNAVAILABLE);
      const runId = String(args?.run_id);
      if (has('listRuns')) {
        const rows = await runtime.listRuns({
          limit: 50,
          cwd: sessionCwd(ctx, exec),
          sessionId: sessionIdOf(exec),
        });
        const row = (Array.isArray(rows) ? rows : []).find((candidate) => (candidate.id ?? candidate.runId) === runId);
        if (row !== undefined && row.ownedByThisSession === false) {
          return fail(`No task found with ID: ${runId} — this session did not start it. Use GetWorkflowRun for a run another session owns.`);
        }
      }
      const snapshot = await runtime.getRun(runId);
      if (snapshot === undefined || snapshot === null) return fail(runNotFound(runId));
      const block = args?.block !== false;
      const timeoutMs = typeof args?.timeout_ms === 'number'
        ? Math.min(3600000, Math.max(1000, Math.trunc(args.timeout_ms)))
        : 600000;
      if (!block || !isRunning(snapshot) || !has('waitForRun')) {
        return succeed(renderRun(snapshot, sessionCwd(ctx, exec)), {
          retrieval_status: isRunning(snapshot) ? 'not_ready' : 'success',
          run_id: snapshot.id ?? snapshot.runId ?? runId,
          status: snapshot.status,
        });
      }
      const settled = await runtime.waitForRun(runId, { timeoutMs, signal: exec?.signal });
      if (settled === undefined || isRunning(settled)) {
        const snapshotNow = settled ?? (await runtime.getRun(runId)) ?? snapshot;
        return succeed(`${renderRun(snapshotNow, sessionCwd(ctx, exec))}\n\nIt is still running after ${timeoutMs}ms. The completion notification will arrive on its own; do not poll it.`, {
          retrieval_status: 'timeout',
          run_id: snapshot.id ?? snapshot.runId ?? runId,
          status: snapshotNow.status,
        });
      }
      return succeed(renderRun(settled, sessionCwd(ctx, exec)), {
        retrieval_status: 'success',
        run_id: settled.id ?? settled.runId ?? runId,
        status: settled.status,
      });
    },
  });

  // ---------------------------------------------------------------------------------------
  // StopWorkflowRun — the port's only extension (ZCode: generic TaskStop)
  // ---------------------------------------------------------------------------------------
  tools.push({
    name: 'StopWorkflowRun',
    description: TOOL_DESCRIPTIONS.stopWorkflowRun,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: {
        run_id: {
          type: 'string',
          minLength: 1,
          description: 'The workflow run ID to stop.',
        },
      },
    },
    async execute(args) {
      if (!has('stopRun')) return fail(STOP_UNAVAILABLE);
      const runId = String(args?.run_id);
      const stopped = await runtime.stopRun(runId, 'model');
      if (stopped === undefined || stopped === null) return fail(runNotFound(runId));
      if (stopped.ok === false) {
        const reason = stopped.code ?? stopped.reason;
        if (reason === 'RUN_NOT_FOUND' || reason === 'run_not_found') return fail(runNotFound(runId));
        if (reason === 'RUN_SETTLED' || reason === 'run_settled') {
          return fail(stopped.message ?? `workflow_run_settled: run ${runId} already settled; there is nothing to stop.`);
        }
        return fail(stopped.message ?? `workflow_stop_refused: run ${runId} could not be stopped (reason: ${String(reason ?? 'unknown')}).`);
      }
      const status = stopped.status ?? 'stopped';
      return succeed(`Stopped run ${runId} (stop_reason "model"); the run is now ${status} and resumable with ResumeWorkflowRun.`, {
        runId,
        status,
        stopReason: 'model',
      });
    },
  });

  /**
   * Each tool's output contract (`cli.md` §1.2–§1.11). `text` and `response` are always
   * present; the contract fields are camelCase.
   *
   * Every field is declared and none of them is required. The Host validates each returned value
   * against this one schema, and a refusal is a value too — `{ ok: false, text }` with none of the
   * success fields — so requiring them would turn "run not found" into an invalid-output error and
   * lose the sentence the model needs.
   */
  const OUTPUT_SCHEMAS = {
    CreateWorkflow: outputSchema({
      diagnostics: DIAGNOSTICS_PROPERTY,
      status: { type: 'string', enum: ['backgrounded'] },
      backgroundTaskId: { type: 'string' },
      runId: { type: 'string' },
      scriptPath: { type: 'string' },
      retuned: { type: 'object', additionalProperties: true },
      causalityGraph: { type: 'object', additionalProperties: true },
      fill: FILL_OUTPUT_SCHEMA,
      ...REJECTION_OUTPUT_PROPERTIES,
    }),
    AmendWorkflow: outputSchema({
      diagnostics: DIAGNOSTICS_PROPERTY,
      status: { type: 'string', enum: ['backgrounded'] },
      backgroundTaskId: { type: 'string' },
      runId: { type: 'string' },
      supersededRunId: { type: 'string' },
      scriptPath: { type: 'string' },
      retuned: { type: 'object', additionalProperties: true },
      causalityGraph: { type: 'object', additionalProperties: true },
      fill: FILL_OUTPUT_SCHEMA,
      ...REJECTION_OUTPUT_PROPERTIES,
    }),
    ResumeWorkflowRun: outputSchema({
      runId: { type: 'string' },
      status: { type: 'string', enum: ['backgrounded'] },
      backgroundTaskId: { type: 'string' },
    }),
    GetWorkflowRun: outputSchema(RUN_OUTPUT_SCHEMA.properties),
    ListWorkflowRuns: outputSchema({
      runs: { type: 'array', items: RUN_ROW_OUTPUT_SCHEMA },
      truncated: { type: 'boolean' },
    }),
    FillWorkflowHole: outputSchema({
      diagnostics: DIAGNOSTICS_PROPERTY,
      fill: FILL_OUTPUT_SCHEMA,
    }),
    EvalWorkflowSnippet: outputSchema({
      diagnostics: DIAGNOSTICS_PROPERTY,
      logs: { type: 'array', items: { type: 'string' } },
      durationMs: { type: 'number' },
    }),
    SaveWorkflow: outputSchema({
      diagnostics: DIAGNOSTICS_PROPERTY,
      name: { type: 'string' },
      scope: { type: 'string', enum: ['project', 'global'] },
      path: { type: 'string' },
      overwritten: { type: 'boolean' },
    }),
    ListSavedWorkflows: outputSchema({
      workflows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'scope', 'path'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            whenToUse: { type: 'string' },
            args: { type: 'object', additionalProperties: true },
            scope: { type: 'string', enum: ['project', 'global'] },
            path: { type: 'string' },
          },
        },
      },
      invalid: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'reason'],
          properties: { path: { type: 'string' }, reason: { type: 'string' } },
        },
      },
    }),
    ResolveWorkflowQuestion: outputSchema({
      qid: { type: 'string' },
    }),
    TaskOutput: outputSchema({
      retrieval_status: { type: 'string', enum: ['success', 'not_ready', 'timeout'] },
      run_id: { type: 'string' },
      status: { type: 'string' },
      task: {
        type: 'object',
        additionalProperties: false,
        required: TASK_OUTPUT_SCHEMA.required,
        properties: TASK_OUTPUT_SCHEMA.properties,
      },
    }),
    StopWorkflowRun: outputSchema({
      runId: { type: 'string' },
      status: { type: 'string' },
      stopReason: { type: 'string', enum: ['user', 'model', 'provider', 'interrupted', 'superseded'] },
    }),
  };
  for (const tool of tools) {
    tool.output = {
      schema: OUTPUT_SCHEMAS[tool.name] ?? outputSchema({}),
      render: (args, value) => [{ type: 'text', text: value.text ?? '' }],
    };
    // The Host validates each returned value against `output.schema` and refuses one that is not
    // lossless JSON; compacting at this single boundary keeps every path — allow, rejection,
    // compile failure — from depending on which optional field happened to be present.
    const run = tool.execute;
    tool.execute = async (args, exec) => compactJson(await run(args, exec));
  }

  return tools;
}
