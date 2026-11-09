/**
 * The facade a dynamic-workflow script runs against.
 *
 * This is the port of ZCode's `§16.2 The facade`: the globals a workflow script may call
 * (`agent`, `phase`, `report`, `artifact`, `files`, `git`, `world`, `channel`, `future`,
 * `hole`, `log`, `run`, `args`, `model`) with the same semantics and caps. Everything here is
 * host-side JavaScript; the script itself runs inside a `node:vm` context that receives these
 * functions.
 *
 * Values that belong to the durable rundown (reports, artifacts, ask results, log lines) are
 * published through `ctx` callbacks so the runtime can journal them and notify the client.
 */

/** A workflow script failed in a way the script itself can observe by catching. */
export class WorkflowScriptError extends Error {
  /**
   * @param {string} code stable machine-readable code, e.g. 'duplicate_agent', 'channel_deadlock'.
   * @param {string} message model-facing message.
   */
  constructor(code, message) {
    super(message);
    this.name = 'WorkflowScriptError';
    this.code = code;
  }
}

const DEFAULT_LIMITS = {
  maxConcurrency: 8,
  maxReportItems: 65536,
  maxReportItemBytes: 1024 * 1024,
  maxReportTotalBytes: 1024 * 1024 * 1024,
  maxArtifactIds: 32,
  maxArtifactVersions: 16,
  maxArtifactFileBytes: 20 * 1024 * 1024,
  maxArtifactMarkdownBytes: 256 * 1024,
  maxArtifactTitle: 120,
  maxArtifactDescription: 500,
  maxAgents: 1024,
  maxPhases: 32,
  maxHoles: 32,
  askHistoryChars: 6000,
};

/**
 * ZCode's default parallel cap: `clamp(cores - 2, 4, 16)`.
 * @param {number} cores
 * @returns {number}
 */
export function defaultMaxConcurrency(cores) {
  return Math.min(16, Math.max(4, cores - 2));
}

const ARTIFACT_KINDS = new Set(['file', 'markdown', 'chart', 'table', 'metrics', 'board']);

/**
 * Render a value for a journal/UI without throwing on cycles or unsupported values.
 * @param {unknown} value
 * @returns {string}
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * True when `value` is plain JSON data (the only thing `report()` accepts).
 * @param {unknown} value
 * @param {Set<unknown>} [seen]
 * @returns {boolean}
 */
function isJsonValue(value, seen = new Set()) {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type !== 'object') return false;
  if (seen.has(value)) return false;
  // Cross-realm safe: the script runs in a vm context, so its objects are not this realm's
  // `Object.prototype` instances; the toString tag still distinguishes plain data from
  // Date, Map, class instances and other non-JSON values.
  const tag = Object.prototype.toString.call(value);
  if (tag !== '[object Object]' && tag !== '[object Array]') return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen));
    return Object.values(value).every((entry) => isJsonValue(entry, seen));
  } finally {
    seen.delete(value);
  }
}

/**
 * Validate and normalize one artifact spec field path.
 * @param {unknown} field
 * @returns {{ field: string, label?: string, unit?: string }}
 */
function normalizeArtifactField(field) {
  if (typeof field !== 'object' || field === null) {
    throw new WorkflowScriptError('artifact_spec', 'artifact field specs must be objects like { field: "round" }');
  }
  const { field: name, label, unit } = /** @type {Record<string, unknown>} */ (field);
  if (typeof name !== 'string' || name.length === 0) {
    throw new WorkflowScriptError('artifact_spec', 'artifact field specs need a non-empty string "field"');
  }
  return {
    field: name,
    ...(typeof label === 'string' ? { label } : {}),
    ...(typeof unit === 'string' ? { unit } : {}),
  };
}

/**
 * Check the options shared by every artifact kind.
 * @param {unknown} opts
 * @param {typeof DEFAULT_LIMITS} limits
 * @returns {{ title?: string, description?: string, primary?: boolean }}
 */
function normalizeArtifactOptions(opts, limits) {
  if (opts === undefined) return {};
  if (typeof opts !== 'object' || opts === null) {
    throw new WorkflowScriptError('artifact_spec', 'artifact options must be an object');
  }
  const { title, description, primary } = /** @type {Record<string, unknown>} */ (opts);
  if (title !== undefined && (typeof title !== 'string' || title.length > limits.maxArtifactTitle)) {
    throw new WorkflowScriptError('artifact_spec', `artifact title must be a string of at most ${limits.maxArtifactTitle} characters`);
  }
  if (description !== undefined
    && (typeof description !== 'string' || description.length > limits.maxArtifactDescription)) {
    throw new WorkflowScriptError('artifact_spec', `artifact description must be a string of at most ${limits.maxArtifactDescription} characters`);
  }
  if (primary !== undefined && typeof primary !== 'boolean') {
    throw new WorkflowScriptError('artifact_spec', 'artifact primary must be a boolean');
  }
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(primary === undefined ? {} : { primary }),
  };
}

/**
 * A typed hole a running script is waiting at, until `FillWorkflowHole` writes its body.
 * @typedef {{ id: string, name: string, prompt?: string, resolve: (value: unknown) => void, reject: (error: Error) => void }} PendingHole
 */

/**
 * Build the facade for one run.
 *
 * @param {object} options
 * @param {{ id: string, name?: string, cwd: string, args: Record<string, unknown>, resumedFrom?: string }} options.run
 * @param {Record<string, object>} [options.typeSchemas] interface name → JSON schema for `ask<T>`
 * @param {object} options.hooks
 * @param {(request: { agentName: string | undefined, persona: object | undefined, prompt: string, schema: object | undefined, model: string | undefined, signal: AbortSignal }) => Promise<{ text: string, structured?: unknown }>} options.hooks.askAgent
 * @param {(event: Record<string, unknown>) => void} options.hooks.emit
 * @param {(artifactId: string, kind: string, opts: object) => number} options.hooks.declareArtifact
 * @param {(artifactId: string, kind: string, opts: object, payload: object) => Promise<{ id: string, version: number }>} options.hooks.publishArtifact
 * @param {{ files: object, git: object, runCommand: Function }} options.workspace
 * @param {object} [options.limits]
 * @param {AbortSignal} [options.signal]
 * @returns {{ facade: Record<string, unknown>, state: object }}
 */
export function createFacade({ run, hooks, workspace, limits = {}, signal, typeSchemas }) {
  const limit = { ...DEFAULT_LIMITS, ...limits };
  const agents = new Map();
  const channels = new Set();
  const publishedArtifacts = new Map();
  const declaredPresets = new Map();
  const reports = [];
  const holes = new Map();
  const phases = [];
  let currentPhase = null;
  let reportBytes = 0;
  let primaryArtifact;
  let closed = false;
  let stallTimer;

  // Global parallel cap: ZCode schedules every actor through one run-wide cap; asks queue FIFO.
  let active = 0;
  /** @type {Array<() => void>} */
  const waiters = [];
  /**
   * @template T
   * @param {() => Promise<T>} body
   * @returns {Promise<T>}
   */
  const withSlot = async (body) => {
    if (active >= limit.maxConcurrency) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    active += 1;
    try {
      return await body();
    } finally {
      active -= 1;
      const next = waiters.shift();
      if (next !== undefined) next();
    }
  };

  /**
   * Journal one event through the runtime, tolerating a closed run.
   * @param {Record<string, unknown>} event
   */
  const emit = (event) => {
    try {
      hooks.emit(event);
    } catch {
      // Journaling must never break the script; the runtime logs its own failures.
    }
    resetStallTimer();
  };

  const state = {
    phases,
    agents,
    reports,
    holes,
    artifacts: publishedArtifacts,
    get currentPhase() {
      return currentPhase;
    },
  };

  const resetStallTimer = () => {
    if (closed || typeof setTimeout !== 'function') return;
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      // A long model call can legitimately take minutes, so the stall window is generous.
      // The runtime turns this into a `ScriptStalled` stop instead of hanging forever.
      emit({ type: 'script/stalled', at: Date.now() });
      try {
        hooks.onStall?.();
      } catch {
        // The runtime owns the stop path.
      }
    }, limit.stallMs ?? 30 * 60 * 1000);
    stallTimer.unref?.();
  };

  /**
   * Run one subagent ask under the run's concurrency budget.
   * @param {{ agentName: string | undefined, persona: object | undefined, prompt: string, schema: object | undefined, model: string | undefined }} request
   * @returns {Promise<unknown>}
   */
  const ask = async (request) => {
    if (closed) throw new WorkflowScriptError('run_closed', 'this workflow run has already settled');
    if (signal?.aborted) throw new WorkflowScriptError('aborted', 'the workflow run was stopped');
    const startedAt = Date.now();
    emit({
      type: 'ask/started',
      agent: request.agentName,
      phase: currentPhase,
      prompt: request.prompt,
      at: startedAt,
    });
    try {
      const result = await withSlot(() => hooks.askAgent({ ...request, signal: signal ?? new AbortController().signal }));
      emit({
        type: 'ask/settled',
        agent: request.agentName,
        phase: currentPhase,
        prompt: request.prompt,
        text: result.text,
        structured: result.structured === undefined ? undefined : result.structured,
        at: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      return result.structured === undefined ? result.text : result.structured;
    } catch (error) {
      emit({
        type: 'ask/failed',
        agent: request.agentName,
        phase: currentPhase,
        prompt: request.prompt,
        error: error instanceof Error ? error.message : String(error),
        at: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  };

  /**
   * `agent(name?, persona?)` — one persistent conversation with its own history.
   * @param {string} [name]
   * @param {string | { system?: string, model?: unknown }} [persona]
   */
  const agent = (name, persona) => {
    if (name !== undefined && name !== null && typeof name !== 'string') {
      throw new WorkflowScriptError('agent_name', 'agent() takes a string name or nothing');
    }
    const agentName = typeof name === 'string' && name.length > 0 ? name : undefined;
    if (agentName !== undefined) {
      if (agents.has(agentName)) {
        throw new WorkflowScriptError('duplicate_agent', `duplicate subagent name "${agentName}": every name in one run must be unique`);
      }
      if (agents.size >= limit.maxAgents) {
        throw new WorkflowScriptError('too_many_agents', `a run may create at most ${limit.maxAgents} subagents`);
      }
    }
    const normalized = typeof persona === 'string'
      ? { system: persona }
      : (persona && typeof persona === 'object' ? { ...persona } : {});
    const record = {
      name: agentName,
      persona: normalized,
      model: typeof normalized.model === 'string'
        ? normalized.model
        : (normalized.model !== null && typeof normalized.model === 'object' ? normalized.model.__zcodeModelRef : undefined),
      history: [],
    };
    if (agentName !== undefined) agents.set(agentName, record);
    return {
      /**
       * Give the subagent one task. With a type argument the compiler rewrites the call into
       * `ask(__zcodeSchema("Type"), instructions)`; the runtime validates the answer against
       * the schema it built from that interface.
       * @param {unknown} instructionsOrMarker
       * @param {string} [maybeInstructions]
       * @returns {Promise<unknown>}
       */
      ask(instructionsOrMarker, maybeInstructions) {
        let instructions = instructionsOrMarker;
        let schemaName = record.schemaName;
        if (instructionsOrMarker !== null
          && typeof instructionsOrMarker === 'object'
          && typeof instructionsOrMarker.__zcodeSchema === 'string') {
          schemaName = instructionsOrMarker.__zcodeSchema;
          instructions = maybeInstructions;
        }
        if (typeof instructions !== 'string' || instructions.trim().length === 0) {
          throw new WorkflowScriptError('ask_instructions', 'ask() needs a non-empty instruction string');
        }
        const schema = schemaName === undefined ? undefined : typeSchemas?.[schemaName];
        if (schemaName !== undefined && schema === undefined) {
          throw new WorkflowScriptError('unknown_type', `ask<${schemaName}> names a type the script does not declare`);
        }
        return (async () => {
          const transcript = record.history
            .map((entry, index) => `### Ask ${index + 1}\n${entry.ask}\n\n### Answer ${index + 1}\n${entry.answer}`)
            .join('\n\n');
          const historyText = transcript.length === 0
            ? ''
            : `\n\nEarlier asks in this conversation, kept for context:\n${transcript.slice(-limit.askHistoryChars)}`;
          const prompt = `${instructions}${historyText}`;
          const value = await ask({
            agentName: record.name,
            persona: record.persona,
            prompt,
            schema,
            model: record.model,
          });
          const text = typeof value === 'string' ? value : safeStringify(value);
          record.history.push({ ask: instructions, answer: text });
          return value;
        })();
      },
    };
  };

  /**
   * `phase(name)` — presentation marker grouping the steps that follow.
   * @param {string} name
   */
  const phase = (name) => {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new WorkflowScriptError('phase_name', 'phase() needs a non-empty name');
    }
    const now = Date.now();
    if (currentPhase !== null && currentPhase.name === name) return;
    if (currentPhase === null && phases.length >= limit.maxPhases) {
      throw new WorkflowScriptError('too_many_phases', `a run may open at most ${limit.maxPhases} phases`);
    }
    if (currentPhase !== null) currentPhase.endedAt = now;
    currentPhase = { name, startedAt: now };
    phases.push(currentPhase);
    emit({ type: 'phase/started', name, at: now });
  };

  /**
   * `report(item, tag?)` — one intermediate result, delivered even when the run fails.
   * @param {unknown} item
   * @param {string} [artifactId]
   */
  const report = (item, artifactId) => {
    if (!isJsonValue(item)) {
      throw new WorkflowScriptError('report_json', 'report() items must be plain JSON: objects, arrays, strings, numbers, booleans or null');
    }
    if (reports.length >= limit.maxReportItems) {
      throw new WorkflowScriptError('report_cap', `a run may report at most ${limit.maxReportItems} items`);
    }
    const serialized = safeStringify(item);
    if (serialized.length > limit.maxReportItemBytes) {
      throw new WorkflowScriptError('report_cap', `one reported item may be at most ${limit.maxReportItemBytes} bytes`);
    }
    reportBytes += serialized.length;
    if (reportBytes > limit.maxReportTotalBytes) {
      throw new WorkflowScriptError('report_cap', 'reported items exceeded the run budget of 1 GiB');
    }
    if (artifactId !== undefined) {
      if (typeof artifactId !== 'string' || !declaredPresets.has(artifactId)) {
        throw new WorkflowScriptError('report_tag', `report() tags must name a declared chart/table/metrics/board artifact; "${String(artifactId)}" is not one`);
      }
    }
    const entry = {
      item,
      ...(artifactId === undefined ? {} : { artifactId }),
      at: Date.now(),
      ...(currentPhase === null ? {} : { phase: currentPhase.name }),
    };
    reports.push(entry);
    emit({ type: 'report', item, artifactId: artifactId ?? null, phase: currentPhase?.name ?? null, at: entry.at });
    if (artifactId !== undefined) {
      const preset = declaredPresets.get(artifactId);
      preset.items.push(item);
      emit({ type: 'artifact/updated', id: artifactId, kind: preset.kind, at: entry.at });
    }
  };

  /**
   * Resolve one declared artifact id, asserting kind coherence and the id budget.
   * @param {string} id
   * @param {string} kind
   * @returns {{ id: string, kind: string }}
   */
  const claimArtifact = (id, kind) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
      throw new WorkflowScriptError('artifact_id', 'artifact ids must be 1-64 characters of [A-Za-z0-9_.-]');
    }
    if (!ARTIFACT_KINDS.has(kind)) throw new WorkflowScriptError('artifact_id', `unknown artifact kind "${kind}"`);
    const existing = publishedArtifacts.get(id) ?? declaredPresets.get(id);
    if (existing !== undefined && existing.kind !== kind) {
      throw new WorkflowScriptError('artifact_id', `artifact id "${id}" is already used by a ${existing.kind} artifact`);
    }
    if (existing === undefined && publishedArtifacts.size + declaredPresets.size >= limit.maxArtifactIds) {
      throw new WorkflowScriptError('artifact_cap', `a run may publish at most ${limit.maxArtifactIds} artifact ids`);
    }
    return existing ?? { id, kind };
  };

  /**
   * Assert the single-primary invariant at declaration time.
   * @param {object} opts
   * @param {string} id
   */
  const notePrimary = (opts, id) => {
    if (opts.primary === true) {
      if (primaryArtifact !== undefined && primaryArtifact !== id) {
        throw new WorkflowScriptError('artifact_primary', `at most one artifact may be primary; "${primaryArtifact}" already is`);
      }
      primaryArtifact = id;
    }
  };

  /**
   * Publish one content artifact (file or markdown).
   * @param {string} id
   * @param {string} kind
   * @param {object} opts
   * @param {object} payload
   */
  const publishContent = async (id, kind, opts, payload) => {
    claimArtifact(id, kind);
    const versions = (publishedArtifacts.get(id)?.versions ?? 0) + 1;
    if (versions > limit.maxArtifactVersions) {
      throw new WorkflowScriptError('artifact_cap', `artifact "${id}" may have at most ${limit.maxArtifactVersions} versions`);
    }
    notePrimary(opts, id);
    const version = await hooks.publishArtifact(id, kind, opts, payload);
    const record = { id, kind, ...opts, version: version.version, versions };
    publishedArtifacts.set(id, record);
    emit({ type: 'artifact/published', id, kind, version: version.version, title: opts.title ?? id, primary: opts.primary === true, at: Date.now() });
    return { id, version: version.version };
  };

  /**
   * Declare one preset dashboard artifact.
   * @param {string} id
   * @param {string} kind
   * @param {object} spec
   */
  const declarePreset = (id, kind, spec) => {
    claimArtifact(id, kind);
    const opts = normalizeArtifactOptions({
      title: spec?.title,
      description: spec?.description,
      primary: spec?.primary,
    }, limit);
    notePrimary(opts, id);
    if (declaredPresets.has(id)) {
      const previous = declaredPresets.get(id);
      if (safeStringify(previous.spec) !== safeStringify(spec)) {
        throw new WorkflowScriptError('artifact_spec', `artifact "${id}" was already declared with a different spec`);
      }
      return;
    }
    const record = { id, kind, spec, ...opts, items: [] };
    declaredPresets.set(id, record);
    emit({ type: 'artifact/declared', id, kind, spec, title: opts.title ?? id, primary: opts.primary === true, at: Date.now() });
  };

  const artifact = {
    async file(id, filePath, opts) {
      if (typeof filePath !== 'string' || filePath.length === 0) {
        throw new WorkflowScriptError('artifact_path', 'artifact.file() needs a workspace-relative path');
      }
      const normalized = normalizeArtifactOptions(opts, limit);
      return publishContent(id, 'file', normalized, { path: filePath, contentType: opts?.contentType });
    },
    async markdown(id, content, opts) {
      if (typeof content !== 'string') {
        throw new WorkflowScriptError('artifact_markdown', 'artifact.markdown() needs a string body');
      }
      if (Buffer.byteLength(content, 'utf8') > limit.maxArtifactMarkdownBytes) {
        throw new WorkflowScriptError('artifact_cap', `markdown artifacts may be at most ${limit.maxArtifactMarkdownBytes} bytes`);
      }
      return publishContent(id, 'markdown', normalizeArtifactOptions(opts, limit), { text: content });
    },
    chart(id, spec) {
      if (typeof spec !== 'object' || spec === null) throw new WorkflowScriptError('artifact_spec', 'artifact.chart() needs a spec object');
      if (spec.type !== undefined && !['line', 'bar', 'scatter'].includes(spec.type)) {
        throw new WorkflowScriptError('artifact_spec', 'chart type must be "line", "bar" or "scatter"');
      }
      const x = normalizeArtifactField(spec.x);
      const y = Array.isArray(spec.y) ? spec.y.map(normalizeArtifactField) : normalizeArtifactField(spec.y);
      declarePreset(id, 'chart', {
        ...normalizeArtifactOptions(spec, limit),
        type: spec.type ?? 'line',
        x,
        y,
        ...(spec.scale === undefined ? {} : { scale: spec.scale }),
        ...(spec.baseline === undefined ? {} : { baseline: normalizeArtifactField(spec.baseline) }),
      });
    },
    table(id, spec) {
      if (typeof spec !== 'object' || spec === null || !Array.isArray(spec.columns)) {
        throw new WorkflowScriptError('artifact_spec', 'artifact.table() needs a columns array');
      }
      declarePreset(id, 'table', {
        ...normalizeArtifactOptions(spec, limit),
        columns: spec.columns.map(normalizeArtifactField),
        ...(spec.key === undefined ? {} : { key: String(spec.key) }),
      });
    },
    metrics(id, spec) {
      if (typeof spec !== 'object' || spec === null || !Array.isArray(spec.metrics)) {
        throw new WorkflowScriptError('artifact_spec', 'artifact.metrics() needs a metrics array');
      }
      declarePreset(id, 'metrics', {
        ...normalizeArtifactOptions(spec, limit),
        metrics: spec.metrics.map(normalizeArtifactField),
      });
    },
    board(id, spec) {
      if (typeof spec !== 'object' || spec === null || !Array.isArray(spec.columns) || typeof spec.key !== 'string' || typeof spec.status !== 'string') {
        throw new WorkflowScriptError('artifact_spec', 'artifact.board() needs key, status and columns');
      }
      declarePreset(id, 'board', {
        ...normalizeArtifactOptions(spec, limit),
        key: spec.key,
        status: spec.status,
        columns: spec.columns.map(String),
        ...(spec.cardTitle === undefined ? {} : { cardTitle: String(spec.cardTitle) }),
        ...(spec.detail === undefined ? {} : { detail: spec.detail.map(normalizeArtifactField) }),
      });
    },
  };

  /**
   * A FIFO async channel between two stages.
   * @param {string} [name]
   */
  const channel = (name) => {
    const queue = [];
    const waiters = [];
    let closedFlag = false;
    const record = { name: name ?? 'channel' };
    channels.add(record);
    const channelObject = {
      send(item) {
        if (closedFlag) throw new WorkflowScriptError('channel_closed', 'cannot send on a closed channel');
        if (waiters.length > 0) {
          const waiter = waiters.shift();
          waiter.resolve({ value: item, done: false });
        } else {
          queue.push(item);
        }
      },
      close() {
        if (closedFlag) return;
        closedFlag = true;
        channels.delete(record);
        while (waiters.length > 0) waiters.shift().resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
            if (closedFlag) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve, reject) => {
              waiters.push({ resolve, reject });
            });
          },
          return: () => Promise.resolve({ value: undefined, done: true }),
        };
      },
    };
    return channelObject;
  };

  /**
   * `future(body)` — start a concurrent stage immediately.
   * @param {() => Promise<unknown>} body
   */
  const future = (body) => {
    if (typeof body !== 'function') throw new WorkflowScriptError('future_body', 'future() needs a function');
    try {
      return Promise.resolve(body());
    } catch (error) {
      return Promise.reject(error);
    }
  };

  /**
   * `hole(name, prompt?, body?)` — a typed gap filled mid-run.
   * @param {string} name
   * @param {string | (() => Promise<unknown>)} [promptOrBody]
   * @param {() => Promise<unknown>} [maybeBody]
   */
  const hole = (name, promptOrBody, maybeBody) => {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new WorkflowScriptError('hole_name', 'hole() needs a non-empty literal name');
    }
    if (holes.has(name)) {
      throw new WorkflowScriptError('hole_name', `hole name "${name}" is used twice in one run`);
    }
    if (holes.size >= limit.maxHoles) {
      throw new WorkflowScriptError('too_many_holes', `a run may wait at at most ${limit.maxHoles} holes`);
    }
    const body = typeof promptOrBody === 'function' ? promptOrBody : maybeBody;
    if (typeof body === 'function') return body();
    const prompt = typeof promptOrBody === 'string' ? promptOrBody : undefined;
    const deferred = Promise.withResolvers();
    const record = { id: `hole#${Math.random().toString(16).slice(2, 10)}`, name, prompt, deferred, claimed: false };
    holes.set(name, record);
    emit({ type: 'hole/waiting', id: record.id, name, prompt: prompt ?? null, phase: currentPhase?.name ?? null, at: Date.now() });
    return deferred.promise;
  };

  /**
   * `log(message)` — narration for the human watching the run.
   * @param {string} message
   */
  const log = (message) => {
    const text = typeof message === 'string' ? message : safeStringify(message);
    emit({ type: 'log', text, phase: currentPhase?.name ?? null, at: Date.now() });
  };

  /**
   * `world.run(cmd, args?, opts?)` — a deterministic gate; a nonzero exit is a value.
   * @param {string} cmd
   * @param {string[]} [cmdArgs]
   * @param {object} [opts]
   */
  const worldRun = async (cmd, cmdArgs = [], opts = {}) => {
    if (typeof cmd !== 'string' || cmd.length === 0) {
      throw new WorkflowScriptError('world_command', 'world.run() needs a non-empty command string literal');
    }
    if (!Array.isArray(cmdArgs) || cmdArgs.some((entry) => typeof entry !== 'string')) {
      throw new WorkflowScriptError('world_args', 'world.run() arguments must be an array of strings');
    }
    const output = opts?.output;
    emit({ type: 'world/started', cmd, args: cmdArgs, phase: currentPhase?.name ?? null, at: Date.now() });
    const startedAt = Date.now();
    try {
      const result = await workspace.runCommand(cmd, cmdArgs, {
        ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        ...(output === undefined ? {} : { output }),
      });
      emit({
        type: 'world/settled',
        cmd,
        args: cmdArgs,
        exitCode: result.exitCode,
        phase: currentPhase?.name ?? null,
        at: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      emit({
        type: 'world/failed',
        cmd,
        args: cmdArgs,
        error: error instanceof Error ? error.message : String(error),
        phase: currentPhase?.name ?? null,
        at: Date.now(),
      });
      throw error;
    }
  };

  const model = (id) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new WorkflowScriptError('model_ref', 'model() needs a model id string literal');
    }
    return { __zcodeModelRef: id };
  };

  const facade = {
    agent,
    phase,
    report,
    artifact,
    files: workspace.files,
    git: workspace.git,
    world: { run: worldRun },
    channel,
    future,
    hole,
    log,
    model,
    run: Object.freeze({
      id: run.id,
      ...(run.resumedFrom === undefined ? {} : { resumedFrom: run.resumedFrom }),
    }),
    args: Object.freeze({ ...run.args }),
  };

  /** Settle the facade: reject any parked hole, close channels, stop the stall watchdog. */
  const dispose = () => {
    closed = true;
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    for (const record of holes.values()) {
      record.deferred.reject(new WorkflowScriptError('hole_unfilled', `the run settled while waiting at hole "${record.name}"`));
    }
    holes.clear();
    for (const record of [...channels]) record.close?.();
    channels.clear();
  };

  // Expose the pending-hole map to the runtime so FillWorkflowHole can resolve it.
  Object.defineProperty(state, 'resolveHole', {
    enumerable: false,
    value: (holeId, value) => {
      for (const record of holes.values()) {
        if (record.id !== holeId || record.claimed) continue;
        record.claimed = true;
        emit({ type: 'hole/filled', id: holeId, name: record.name, at: Date.now() });
        record.deferred.resolve(value);
        return true;
      }
      return false;
    },
  });

  resetStallTimer();
  return { facade, state, dispose };
}
