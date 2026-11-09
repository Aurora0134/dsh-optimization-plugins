/**
 * Workflow run engine: compiles a submitted script, executes it in an isolated V8 context,
 * journals every observable effect, and notifies the owning agent when the run settles.
 *
 * The engine is deliberately transport-agnostic: it receives the store, the workspace views,
 * and a per-run subagent runner from the plugin (`index.js`). That keeps the run loop testable
 * without a Harness and mirrors ZCode's split between the workflow tool surface and its
 * sandboxed script runtime.
 */
import os from 'node:os';
import vm from 'node:vm';
import { createFacade, WorkflowScriptError } from './facade.js';

/** @typedef {{ id: string, name: string, status: string, cwd: string, scriptPath: string, args: Record<string, unknown>, maxConcurrency: number, subagentModel?: string, resumedFrom?: string, createdAt: number, finishedAt?: number, stopReason?: string, error?: string, result?: unknown }} RunMeta */

const TERMINAL = new Set(['completed', 'errored', 'stopped', 'superseded']);

/**
 * JSON.stringify that never throws (cycles, bigints, functions).
 * @param {unknown} value
 * @returns {string}
 */
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Build one run id that is sortable by time and unique per process.
 * @returns {string}
 */
function newRunId() {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `dwf-${stamp}-${random}`;
}

/**
 * Validate `structured` output against the JSON-schema subset our compiler emits.
 * @param {unknown} value
 * @param {Record<string, unknown>} schema
 * @param {string} [path]
 * @returns {string | undefined} the first violation, or undefined when valid.
 */
export function validateAgainstSchema(value, schema, path = '') {
  if (schema === true || schema === undefined) return undefined;
  const at = path === '' ? 'the result' : path;
  if (schema.type === 'string') {
    return typeof value === 'string' ? undefined : `${at} must be a string`;
  }
  if (schema.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? undefined : `${at} must be a finite number`;
  }
  if (schema.type === 'integer') {
    return Number.isInteger(value) ? undefined : `${at} must be an integer`;
  }
  if (schema.type === 'boolean') {
    return typeof value === 'boolean' ? undefined : `${at} must be a boolean`;
  }
  if (schema.type === 'null') {
    return value === null ? undefined : `${at} must be null`;
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(value) ? undefined : `${at} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${at} must be an array`;
    for (let index = 0; index < value.length; index += 1) {
      const violation = validateAgainstSchema(value[index], schema.items ?? {}, `${path}[${index}]`);
      if (violation !== undefined) return violation;
    }
    return undefined;
  }
  if (schema.type === 'object' || schema.properties !== undefined) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${at} must be an object`;
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
      const violation = validateAgainstSchema(value[key], propertySchema, `${path}.${key}`);
      if (violation !== undefined) return violation;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Coerce a text answer into JSON for a typed ask.
 * @param {string} text
 * @returns {unknown}
 */
function parseJsonAnswer(text) {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced !== null) candidates.push(fenced[1].trim());
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

/**
 * Create the workflow engine.
 *
 * @param {object} options
 * @param {object} options.store durable run/artifact store (host/store.js)
 * @param {(cwd: string) => object} options.workspaceFor builds the read-only workspace views for one run
 * @param {object} options.compiler compiler module (host/compiler.js)
 * @param {object} [options.config] plugin config (maxConcurrency, stallMs, ...)
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @returns {object} engine
 */
export function createRuntime({ store, workspaceFor, compiler, config = {}, logger = console }) {
  /** @type {Map<string, { meta: RunMeta, state: object | null, events: object[], listeners: Set<Function>, waiters: Set<Function>, abort: AbortController, settled: boolean }>} */
  const runs = new Map();

  // ZCode's default parallel cap: clamp(cores - 2, 4, 16), and at most 8 runs in flight.
  const cpuCount = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const defaultMaxConcurrency = Number.isInteger(config.maxConcurrency) && config.maxConcurrency > 0
    ? config.maxConcurrency
    : Math.min(16, Math.max(4, cpuCount - 2));
  const maxRuns = Number.isInteger(config.maxRuns) && config.maxRuns > 0 ? config.maxRuns : 8;

  /**
   * Notify live listeners of one run's progress.
   * @param {string} runId
   */
  const publish = (runId) => {
    const entry = runs.get(runId);
    if (entry === undefined) return;
    for (const listener of entry.listeners) {
      try {
        listener(entry);
      } catch (error) {
        logger.warn?.(`zcode-workflow: run listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  /**
   * Load a run from the store into memory (or return the live entry).
   * @param {string} runId
   */
  const ensure = async (runId) => {
    const live = runs.get(runId);
    if (live !== undefined) return live;
    const meta = await store.getRun(runId);
    if (meta === undefined) return undefined;
    const entry = {
      meta,
      state: null,
      events: [],
      listeners: new Set(),
      waiters: new Set(),
      abort: new AbortController(),
      settled: TERMINAL.has(meta.status),
    };
    runs.set(runId, entry);
    return entry;
  };

  /**
   * Start one workflow from a submitted script.
   *
   * @param {object} request
   * @param {string} request.code the (TypeScript) workflow script
   * @param {string} [request.scriptPath] an existing file the script was read from
   * @param {string} request.name run label
   * @param {string} request.cwd workspace root
   * @param {Record<string, unknown>} [request.args]
   * @param {number} [request.maxConcurrency]
   * @param {string} [request.subagentModel]
   * @param {string} [request.resumedFrom]
   * @param {object} request.runner subagent runner ({ agentName, persona, prompt, schema, model, signal }) => Promise<{ text, structured }>
   * @param {(text: string) => void} [request.notify] called once when the run settles
   * @param {string} [request.origin]
   * @param {string} [request.runId] reuse an existing run id (a resume keeps the same id)
   * @returns {Promise<{ ok: boolean, runId?: string, diagnostics?: object[], scriptPath?: string, draftPath?: string, phases?: string[], agents?: string[], error?: string }>}
   */
  const start = async (request) => {
    const activeRuns = [...runs.values()].filter((entry) => !entry.settled).length;
    if (activeRuns >= maxRuns) {
      return { ok: false, error: `too_many_runs: ${maxRuns} workflow runs are already in flight in this project; wait for one to settle. Nothing ran.` };
    }
    const safeName = String(request.name ?? 'workflow').replace(/[^\w\u4e00-\u9fa5 .-]+/g, '-').slice(0, 80) || 'workflow';
    // ZCode writes an inline script to a draft file BEFORE compiling, so a diagnostic can name
    // the file the model edits next. A `path` source already is that file.
    const draftPath = request.scriptPath ?? await store.writeDraft(safeName, request.code);
    const compiled = compiler.compileWorkflowScript({
      code: request.code,
      filename: draftPath,
      mode: 'workflow',
    });
    if (!compiled.ok) {
      return { ok: false, diagnostics: compiled.diagnostics, scriptPath: draftPath, draftPath };
    }
    const runId = request.runId ?? newRunId();
    const meta = await store.createRun({
      id: runId,
      name: safeName,
      status: 'running',
      cwd: request.cwd,
      scriptPath: draftPath,
      code: request.code,
      args: request.args ?? {},
      maxConcurrency: request.maxConcurrency ?? defaultMaxConcurrency,
      subagentModel: request.subagentModel,
      resumedFrom: request.resumedFrom,
      origin: request.origin ?? 'workflow',
      phases: compiled.phases,
      agentNames: compiled.agents,
    });
    /** @type {any} */
    const entry = {
      meta,
      state: null,
      events: [],
      listeners: new Set(),
      waiters: new Set(),
      abort: new AbortController(),
      settled: false,
      draftPath,
      compiled,
      notify: request.notify,
      runner: request.runner,
    };
    runs.set(runId, entry);
    void execute(entry, request.code, compiled);
    return {
      ok: true,
      runId,
      scriptPath: draftPath,
      draftPath,
      phases: compiled.phases,
      agents: compiled.agents,
    };
  };

  /**
   * Execute one compiled script to settlement, then persist and notify.
   * @param {any} entry live run entry
   * @param {string} code the original script
   * @param {any} compiled compiler output
   */
  const execute = async (entry, code, compiled) => {
    const { meta } = entry;
    let facadeState;
    let facadeDispose;
    try {
      const workspace = workspaceFor(meta.cwd);
      const created = createFacade({
        run: {
          id: meta.id,
          name: meta.name,
          cwd: meta.cwd,
          args: meta.args ?? {},
          resumedFrom: meta.resumedFrom,
        },
        hooks: {
          askAgent: async ({ agentName, persona, prompt, schema, model, signal }) => {
            const answer = await entry.runner({ agentName, persona, prompt, schema, model, signal });
            if (schema === undefined) return answer;
            const structured = answer.structured !== undefined
              ? answer.structured
              : parseJsonAnswer(answer.text);
            if (structured === undefined) {
              throw new WorkflowScriptError('result_invalid', `the answer for "${agentName ?? 'a subagent'}" was not valid JSON for the declared type`);
            }
            const violation = validateAgainstSchema(structured, schema);
            if (violation !== undefined) {
              throw new WorkflowScriptError('result_invalid', `the answer for "${agentName ?? 'a subagent'}" did not match its declared type: ${violation}`);
            }
            return { text: answer.text, structured };
          },
          emit: (event) => {
            entry.events.push(event);
            entry.state?.phasesUpdate?.(event);
            void store.appendEvent(meta.id, event).catch((error) => {
              logger.warn?.(`zcode-workflow: journal append failed for ${meta.id}: ${error instanceof Error ? error.message : String(error)}`);
            });
            publish(meta.id);
          },
          publishArtifact: async (artifactId, kind, opts, payload) => {
            const manifest = await store.readArtifactManifest(meta.id);
            const versions = manifest.filter((record) => record.id === artifactId).length;
            const version = versions + 1;
            await store.publishArtifact(meta.id, {
              id: artifactId,
              kind,
              version,
              title: opts.title,
              description: opts.description,
              primary: opts.primary,
              contentType: payload.contentType,
              sourcePath: payload.path,
              text: payload.text,
            });
            return { id: artifactId, version };
          },
          onStall: () => {
            entry.abort.abort(new Error('workflow run stalled'));
          },
        },
        workspace,
        typeSchemas: compiled.interfaces ?? {},
        limits: {
          maxConcurrency: meta.maxConcurrency,
          ...(config.answerHistoryChars === undefined ? {} : { askHistoryChars: config.answerHistoryChars }),
          ...(config.stallMs === undefined ? {} : { stallMs: config.stallMs }),
        },
        signal: entry.abort.signal,
      });
      facadeState = created.state;
      facadeDispose = created.dispose;
      entry.state = created.state;
      const sandbox = {
        ...created.facade,
        __zcodeSchema: (name) => ({ __zcodeSchema: name }),
        console: {
          log: (...args) => created.facade.log(args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')),
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        Buffer: undefined,
        setTimeout,
        clearTimeout,
        queueMicrotask,
      };
      const context = vm.createContext(sandbox, { name: `workflow:${meta.id}` });
      // The compiler returns the complete runnable expression (`(async () => { … })()`); the
      // script body needs a function scope because a workflow's final `return` is top-level.
      const script = new vm.Script(compiled.js, { filename: meta.scriptPath });
      // Bound the synchronous prologue (an accidental `while (true)` before the first await);
      // asynchronous waits are covered by the facade's stall watchdog.
      const result = await script.runInContext(context, { timeout: config.syncTimeoutMs ?? 30 * 1000 });
      await settle(entry, {
        status: 'completed',
        result: result === undefined ? null : result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stopped = error instanceof WorkflowScriptError
        && (error.code === 'aborted' || error.code === 'hole_unfilled');
      // A stop this plugin requested carries its reason: an amendment supersedes, a user stop
      // stays resumable, and anything else (process teardown, stall) is an interruption.
      const requested = entry.stopRequested;
      const stopReason = requested === 'supersede' ? 'superseded'
        : requested === 'user' ? 'user'
          : 'interrupted';
      await settle(entry, {
        status: stopped ? (requested === 'supersede' ? 'superseded' : 'stopped') : 'errored',
        stopReason: stopped ? stopReason : 'script_error',
        error: message,
      }, error);
    } finally {
      try {
        facadeDispose?.();
      } catch {
        // dispose is best-effort
      }
      entry.state = facadeState ?? null;
    }
  };

  /**
   * Persist one settled run, notify listeners and the owning agent.
   * @param {any} entry live run entry
   * @param {{ status: string, result?: unknown, stopReason?: string, error?: string }} outcome
   * @param {unknown} [cause]
   */
  const settle = async (entry, outcome, cause) => {
    const { meta } = entry;
    if (entry.settled) return;
    entry.settled = true;
    const finishedAt = Date.now();
    let settledMeta;
    try {
      settledMeta = await store.settleRun(meta.id, {
        status: outcome.status,
        stopReason: outcome.stopReason,
        error: outcome.error,
        result: outcome.result,
        finishedAt,
      });
    } catch (error) {
      // Persistence must not swallow the settlement: keep the in-memory terminal state so the
      // notification and waiters still fire, and report the storage failure.
      logger.warn?.(`zcode-workflow: could not persist settlement of ${meta.id}: ${error instanceof Error ? error.message : String(error)}`);
      settledMeta = {
        ...meta,
        status: outcome.status,
        stopReason: outcome.stopReason,
        error: outcome.error,
        finishedAt,
      };
    }
    entry.meta = { ...settledMeta, ...(outcome.result === undefined ? {} : { result: outcome.result }) };
    publish(meta.id);
    for (const waiter of entry.waiters) {
      try {
        waiter(entry.meta);
      } catch {
        // waiters are consumers
      }
    }
    entry.waiters.clear();
    const notification = formatNotification(entry, outcome);
    try {
      entry.notify?.(notification);
    } catch (error) {
      logger.warn?.(`zcode-workflow: completion notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    logger.info?.(`zcode-workflow: run ${meta.id} ${outcome.status}${outcome.error === undefined ? '' : ` (${outcome.error})`}`);
    void cause;
  };

  /**
   * The model-facing completion notification, mirroring ZCode's terminal message.
   * @param {any} entry
   * @param {{ status: string, result?: unknown, stopReason?: string, error?: string }} outcome
   * @returns {string}
   */
  const formatNotification = (entry, outcome) => {
    const { meta } = entry;
    const reports = entry.events.filter((event) => event.type === 'report');
    const artifacts = entry.events.filter((event) => event.type === 'artifact/published' || event.type === 'artifact/declared');
    const holes = entry.events.filter((event) => event.type === 'hole/waiting');
    const lines = [];
    lines.push(`<workflow-run id="${meta.id}" name="${meta.name}" status="${outcome.status}">`);
    lines.push(`Script file: ${meta.scriptPath}`);
    if (outcome.status === 'completed') {
      lines.push('The workflow completed. Its return value:');
      lines.push('```json');
      lines.push(JSON.stringify(outcome.result ?? null, null, 2).slice(0, 20000));
      lines.push('```');
    } else if (outcome.status === 'stopped') {
      lines.push(`The workflow stopped (${outcome.stopReason ?? 'stopped'}). It is resumable; the reason is reported below.`);
      if (outcome.error !== undefined) lines.push(`Reason: ${outcome.error}`);
      if (holes.length > 0) {
        lines.push('It is waiting at these holes; fill one with FillWorkflowHole and resume:');
        for (const hole of holes) lines.push(`- ${hole.id} (${hole.name})${hole.prompt === undefined ? '' : `: ${hole.prompt}`}`);
      }
    } else {
      lines.push('The workflow errored. Editing a run script and resubmitting it with AmendWorkflow is how a revision happens; replaying the same script would fail the same way.');
      lines.push(`Error: ${outcome.error ?? 'unknown error'}`);
    }
    if (reports.length > 0) {
      lines.push(`Reported items (${reports.length}):`);
      for (const report of reports.slice(-100)) {
        lines.push(`- ${JSON.stringify(report.item).slice(0, 2000)}`);
      }
    }
    if (artifacts.length > 0) {
      lines.push('Published artifacts:');
      for (const artifact of artifacts) {
        lines.push(`- ${artifact.id} (${artifact.kind})${artifact.title === undefined ? '' : `: ${artifact.title}`}${artifact.primary === true ? ' [primary]' : ''}`);
      }
    }
    lines.push('</workflow-run>');
    return lines.join('\n');
  };

  /**
   * Snapshot one run for a model or UI caller.
   * @param {string} runId
   * @returns {Promise<object | undefined>}
   */
  const getRun = async (runId) => {
    const entry = await ensure(runId);
    if (entry === undefined) return undefined;
    const events = entry.events.length === 0 && entry.settled
      ? await store.readEvents(runId)
      : entry.events;
    const artifacts = await store.readArtifactManifest(runId);
    const reported = events.filter((event) => event.type === 'report');
    const asks = events.filter((event) => event.type === 'ask/started');
    const settledAsks = events.filter((event) => event.type === 'ask/settled' || event.type === 'ask/failed');
    const phaseStarts = events.filter((event) => event.type === 'phase/started');
    const holes = events.filter((event) => event.type === 'hole/waiting' && detectedFill(events, event.id) === false);
    return {
      id: entry.meta.id,
      name: entry.meta.name,
      status: entry.meta.status,
      cwd: entry.meta.cwd,
      scriptPath: entry.meta.scriptPath,
      createdAt: entry.meta.createdAt,
      finishedAt: entry.meta.finishedAt,
      stopReason: entry.meta.stopReason,
      error: entry.meta.error,
      result: entry.meta.result,
      maxConcurrency: entry.meta.maxConcurrency,
      subagentModel: entry.meta.subagentModel,
      resumedFrom: entry.meta.resumedFrom,
      phases: phaseStarts.map((event) => event.name),
      steps: {
        started: asks.length,
        settled: settledAsks.filter((event) => event.type === 'ask/settled').length,
        failed: settledAsks.filter((event) => event.type === 'ask/failed').length,
        running: Math.max(0, asks.length - settledAsks.length),
      },
      phasesDetail: summarizePhases(events),
      agents: summarizeAgents(events),
      reports: reported.map((event) => ({ item: event.item, artifactId: event.artifactId, phase: event.phase, at: event.at })),
      artifacts,
      holes: holes.map((event) => ({ id: event.id, name: event.name, prompt: event.prompt, phase: event.phase })),
      log: events.filter((event) => event.type === 'log').slice(-200).map((event) => ({ text: event.text, phase: event.phase, at: event.at })),
      world: events.filter((event) => event.type === 'world/settled').map((event) => ({ cmd: event.cmd, args: event.args, exitCode: event.exitCode, phase: event.phase, at: event.at })),
    };
  };

  /**
   * Whether a hole has since been filled.
   * @param {object[]} events
   * @param {string} holeId
   * @returns {boolean}
   */
  const detectedFill = (events, holeId) => events.some((event) => event.type === 'hole/filled' && event.id === holeId);

  /**
   * @param {object[]} events
   * @returns {object[]}
   */
  const summarizePhases = (events) => {
    const phases = [];
    for (const event of events) {
      if (event.type === 'phase/started') {
        phases.push({ name: event.name, startedAt: event.at, endedAt: undefined, asks: 0, failed: 0 });
      } else if (phases.length > 0) {
        const phase = phases[phases.length - 1];
        if (event.type === 'ask/started') phase.asks += 1;
        if (event.type === 'ask/failed') phase.failed += 1;
      }
    }
    return phases;
  };

  /**
   * @param {object[]} events
   * @returns {object[]}
   */
  const summarizeAgents = (events) => {
    /** @type {Map<string, { name: string, asks: number, settled: number, failed: number, lastEvent?: number }>} */
    const agents = new Map();
    for (const event of events) {
      if (event.type !== 'ask/started' && event.type !== 'ask/settled' && event.type !== 'ask/failed') continue;
      const name = event.agent ?? '(anonymous)';
      const record = agents.get(name) ?? { name, asks: 0, settled: 0, failed: 0 };
      if (event.type === 'ask/started') record.asks += 1;
      if (event.type === 'ask/settled') record.settled += 1;
      if (event.type === 'ask/failed') record.failed += 1;
      record.lastEvent = event.at;
      agents.set(name, record);
    }
    return [...agents.values()];
  };

  /**
   * List runs newest first.
   * @param {{ project?: boolean, limit?: number }} [options]
   * @returns {Promise<object[]>}
   */
  const listRuns = async (options = {}) => {
    const stored = await store.listRuns({ project: options.project !== false, limit: options.limit ?? 30 });
    return stored;
  };

  /**
   * Wait for one run to settle (the `TaskOutput` tool).
   * @param {string} runId
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<object | undefined>}
   */
  const waitForRun = async (runId, options = {}) => {
    const entry = await ensure(runId);
    if (entry === undefined) return undefined;
    if (entry.settled) return getRun(runId);
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    await new Promise((resolve) => {
      let timer;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        entry.waiters.delete(done);
        resolve(undefined);
      };
      entry.waiters.add(done);
      timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      options.signal?.addEventListener('abort', done, { once: true });
    });
    return getRun(runId);
  };

  /**
   * Stop one run.
   * @param {string} runId
   * @param {string} [reason]
   * @returns {Promise<object | undefined>}
   */
  const stopRun = async (runId, reason = 'user') => {
    const entry = await ensure(runId);
    if (entry === undefined) return undefined;
    if (!entry.settled) {
      entry.stopRequested = reason;
      entry.abort.abort(new Error(`workflow run stopped: ${reason}`));
    }
    return getRun(runId);
  };

  /**
   * Resolve a pending hole from `FillWorkflowHole`.
   * @param {string} runId
   * @param {string} holeId
   * @param {unknown} value
   * @returns {Promise<boolean>}
   */
  const fillHole = async (runId, holeId, value) => {
    const entry = runs.get(runId);
    if (entry === undefined || entry.state === null) return false;
    return entry.state.resolveHole(holeId, value) === true;
  };

  /**
   * Subscribe to a run's progress (used by the plugin's Host service and the Client UI).
   * @param {string} runId
   * @param {(entry: object) => void} listener
   * @returns {() => void}
   */
  const subscribe = (runId, listener) => {
    const found = runs.get(runId);
    if (found === undefined) return () => {};
    found.listeners.add(listener);
    return () => found.listeners.delete(listener);
  };

  /**
   * Compile and run one snippet synchronously (`EvalWorkflowSnippet`). No run is created and
   * nothing persists: the facade subset is `args`, `run`, `log`, `files`, `git`, `world.run`,
   * `channel` and `future`, exactly like ZCode's snippet surface.
   *
   * @param {{ code: string, cwd: string, timeoutMs?: number, signal?: AbortSignal }} request
   * @returns {Promise<{ ok: boolean, value?: unknown, logs?: string[], diagnostics?: object[], error?: string, durationMs?: number }>}
   */
  const evaluate = async ({ code, cwd, timeoutMs = 60 * 1000, signal }) => {
    const startedAt = Date.now();
    const compiled = compiler.compileWorkflowScript({ code, filename: 'snippet.ts', mode: 'snippet' });
    if (!compiled.ok) {
      return { ok: false, diagnostics: compiled.diagnostics, durationMs: Date.now() - startedAt };
    }
    const workspace = workspaceFor(cwd);
    const logs = [];
    const runId = `dwfeval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const sandbox = {
      files: workspace.files,
      git: workspace.git,
      world: { run: (cmd, args = [], opts = {}) => workspace.runCommand(cmd, args, opts) },
      channel: (name) => {
        const queue = [];
        const waiters = [];
        let closed = false;
        return {
          send(item) {
            if (closed) throw new WorkflowScriptError('channel_closed', 'cannot send on a closed channel');
            if (waiters.length > 0) waiters.shift()({ value: item, done: false });
            else queue.push(item);
          },
          close() {
            closed = true;
            while (waiters.length > 0) waiters.shift()({ value: undefined, done: true });
          },
          [Symbol.asyncIterator]: () => ({
            next() {
              if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
              if (closed) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve) => waiters.push(resolve));
            },
          }),
          name,
        };
      },
      future: (body) => {
        try {
          return Promise.resolve(body());
        } catch (error) {
          return Promise.reject(error);
        }
      },
      log: (message) => {
        logs.push(typeof message === 'string' ? message : safeJson(message));
      },
      model: (id) => ({ __zcodeModelRef: id }),
      args: Object.freeze({}),
      run: Object.freeze({ id: runId }),
      __zcodeSchema: (name) => ({ __zcodeSchema: name }),
      console: {
        log: (...args) => logs.push(args.map((value) => (typeof value === 'string' ? value : safeJson(value))).join(' ')),
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      setTimeout,
      clearTimeout,
      queueMicrotask,
    };
    let timer;
    try {
      const context = vm.createContext(sandbox, { name: `workflow-snippet` });
      const script = new vm.Script(compiled.js, { filename: 'snippet.ts' });
      const execution = script.runInContext(context, { timeout: config.syncTimeoutMs ?? 30 * 1000 });
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __timeout: true }), Math.min(Math.max(timeoutMs, 1), 600000));
      });
      const abort = new Promise((resolve) => {
        if (signal === undefined) return;
        if (signal.aborted) return resolve({ __aborted: true });
        signal.addEventListener('abort', () => resolve({ __aborted: true }), { once: true });
      });
      const outcome = await Promise.race([execution, timeout, abort]);
      if (outcome !== null && typeof outcome === 'object' && outcome.__timeout === true) {
        return { ok: false, error: `the snippet timed out after ${timeoutMs}ms`, logs, durationMs: Date.now() - startedAt };
      }
      if (outcome !== null && typeof outcome === 'object' && outcome.__aborted === true) {
        return { ok: false, error: 'the snippet was cancelled', logs, durationMs: Date.now() - startedAt };
      }
      return { ok: true, value: outcome === undefined ? null : outcome, logs, durationMs: Date.now() - startedAt };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), logs, durationMs: Date.now() - startedAt };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    start,
    getRun,
    listRuns,
    waitForRun,
    stopRun,
    fillHole,
    evaluate,
    subscribe,
    get runCount() {
      return runs.size;
    },
  };
}
