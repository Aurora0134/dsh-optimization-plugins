/**
 * 内存版 journal —— 契约的可执行副本。
 *
 * 为什么存在：dev-host 的 `host/journal.js` 是结构化存储（SQLite/JSON 文件）；引擎只需要一组
 * 语义明确的方法，不应该依赖具体介质。这个实现有三个用途：
 * 1. 单测：`runtime.test.mjs` 用它在内存里跑完整 run；
 * 2. 兜底：插件没注入 journal 时引擎仍能工作（例如 `EvalWorkflowSnippet` 的轻量路径）；
 * 3. 契约：方法名/返回形状逐条对齐 `beauty/zcode-cli.js:651300-651445`，dev-host 按它实现即可。
 *
 * 约定（与 ZCode 一致）：
 * - 所有 `get*`/`list*` 返回**深拷贝**，调用方改不到存储；
 * - `putNode`/`putActor` 是 upsert，key = `${siteId}@${ordinal}`；
 * - `appendEvent` 分配 run 内连续 sequence（从 0 开始），返回 `{sequence, event, timeCreated}`；
 * - `listNodes` 支持 `withResult:false`（丢 result）与 `maxResultBytes`（按 JSON 字节截断）。
 */

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return structuredClone(value);
}

/** @param {{siteId: string, ordinal: number}} ref */
function keyOf(ref) {
  return `${ref.siteId}@${ref.ordinal}`;
}

/**
 * 一行节点结果的 UTF-8 字节数（`resultBytes`）。
 * @param {{result?: unknown}} row
 * @returns {number}
 */
function resultBytes(row) {
  if (row.result === undefined) return 0;
  const text = JSON.stringify(row.result);
  return text === undefined ? 0 : new TextEncoder().encode(text).length;
}

/**
 * 按结果字节预算保留前缀行（`withinBytes`）。
 * @param {object[]} rows
 * @param {number} maxBytes
 * @returns {object[]}
 */
function withinBytes(rows, maxBytes) {
  const kept = [];
  let total = 0;
  for (const row of rows) {
    const bytes = resultBytes(row);
    if (kept.length > 0 && total + bytes > maxBytes) break;
    kept.push(row);
    total += bytes;
  }
  return kept;
}

/**
 * 建一个内存 journal。
 * @returns {object} journal（方法集合见文件头）
 */
export function createMemoryJournal() {
  /** @type {Map<string, object>} */
  const runs = new Map();
  /** @type {Map<string, Map<string, object>>} */
  const actors = new Map();
  /** @type {Map<string, Map<string, object>>} */
  const nodes = new Map();
  /** @type {Map<string, {sequence: number, event: object, timeCreated: number}[]>} */
  const events = new Map();

  const requireRun = (runId) => {
    const run = runs.get(runId);
    if (run === undefined) throw new Error(`journal: unknown run ${runId}`);
    return run;
  };
  const requireNodes = (runId) => {
    const bucket = nodes.get(runId);
    if (bucket === undefined) throw new Error(`journal: unknown run ${runId}`);
    return bucket;
  };

  return {
    /* ---------------- run ---------------- */

    createRun(row) {
      if (runs.has(row.runId)) throw new Error(`journal: run ${row.runId} already exists`);
      runs.set(row.runId, clone(row));
      actors.set(row.runId, new Map());
      nodes.set(row.runId, new Map());
      events.set(row.runId, []);
    },
    getRun(runId) {
      const run = runs.get(runId);
      return run === undefined ? undefined : clone(run);
    },
    listRuns({ project, limit } = {}) {
      const rows = [...runs.values()]
        .filter((run) => project === undefined || run.cwd === project)
        .sort((a, b) => (b.timeUpdated ?? b.timeCreated ?? 0) - (a.timeUpdated ?? a.timeCreated ?? 0));
      return (limit === undefined ? rows : rows.slice(0, Math.max(0, limit))).map((run) => clone(run));
    },
    updateRunStatus(runId, status, info = {}) {
      const run = requireRun(runId);
      run.status = status;
      run.timeUpdated = Date.now();
      if (status === 'pending' || status === 'running') {
        delete run.failure;
        delete run.stopReason;
        delete run.supersededBy;
        delete run.result;
        return;
      }
      if (info.stopReason === undefined) delete run.stopReason;
      else run.stopReason = info.stopReason;
      if (info.supersededBy === undefined) delete run.supersededBy;
      else run.supersededBy = info.supersededBy;
      if (info.failure === undefined) delete run.failure;
      else run.failure = clone(info.failure);
      if (info.result !== undefined) run.result = clone(info.result);
    },
    updateRunUsage(runId, spentTokens) {
      const run = requireRun(runId);
      run.spentTokens = Math.max(0, Math.floor(spentTokens));
      run.timeUpdated = Date.now();
    },
    updateRunCaps(runId, caps) {
      const run = requireRun(runId);
      run.caps = clone(caps);
      run.timeUpdated = Date.now();
    },
    updateRunScript(runId, scriptText, scriptHash) {
      const run = requireRun(runId);
      run.scriptText = scriptText;
      run.scriptHash = scriptHash;
      run.timeUpdated = Date.now();
    },

    /* ---------------- actor ---------------- */

    putActor(row) {
      const bucket = actors.get(row.runId);
      if (bucket === undefined) throw new Error(`journal: unknown run ${row.runId}`);
      bucket.set(keyOf(row), { ...clone(row), timeUpdated: Date.now() });
    },
    getActor(runId, siteId, ordinal) {
      const row = actors.get(runId)?.get(keyOf({ siteId, ordinal }));
      return row === undefined ? undefined : clone(row);
    },
    listActors(runId, { name, withPersona = false } = {}) {
      const bucket = actors.get(runId);
      if (bucket === undefined) return [];
      return [...bucket.values()]
        .filter((row) => name === undefined || row.name === name)
        .map((row) => {
          const copy = clone(row);
          if (!withPersona) delete copy.persona;
          return copy;
        });
    },

    /* ---------------- node ---------------- */

    putNode(row) {
      const bucket = requireNodes(row.runId);
      const previous = bucket.get(keyOf(row));
      bucket.set(keyOf(row), {
        ...clone(row),
        timeCreated: previous?.timeCreated ?? Date.now(),
        timeUpdated: Date.now(),
      });
    },
    getNode(runId, siteId, ordinal, { withResult = true } = {}) {
      const row = nodes.get(runId)?.get(keyOf({ siteId, ordinal }));
      if (row === undefined) return undefined;
      const copy = clone(row);
      if (!withResult) delete copy.result;
      return copy;
    },
    listNodes(runId, { kinds = 'all', withResult = true, limit, maxResultBytes } = {}) {
      const bucket = nodes.get(runId);
      if (bucket === undefined) return [];
      const filtered = [...bucket.values()].filter((row) => kinds === 'all' || kinds.includes(row.kind));
      const limited = limit === undefined ? filtered : filtered.slice(0, Math.max(0, limit));
      const bounded = maxResultBytes === undefined ? limited : withinBytes(limited, maxResultBytes);
      return bounded.map((row) => {
        const copy = clone(row);
        if (!withResult) delete copy.result;
        return copy;
      });
    },
    countNodes(runId, kind) {
      const bucket = nodes.get(runId);
      if (bucket === undefined) return 0;
      let count = 0;
      for (const row of bucket.values()) if (row.kind === kind) count += 1;
      return count;
    },
    sumResultBytes(runId, kind) {
      const bucket = nodes.get(runId);
      if (bucket === undefined) return 0;
      let total = 0;
      for (const row of bucket.values()) if (row.kind === kind) total += resultBytes(row);
      return total;
    },

    /* ---------------- event ---------------- */

    appendEvent(runId, event) {
      const list = events.get(runId);
      if (list === undefined) throw new Error(`journal: unknown run ${runId}`);
      const entry = { sequence: list.length, event: clone(event), timeCreated: Date.now() };
      list.push(entry);
      return clone(entry);
    },
    /**
     * @param {string} runId
     * @param {{ types?: 'all'|string[], afterSequence?: number, limit?: number, reportItems?: 'all'|{limit: number} }} [options]
     */
    listEvents(runId, options = {}) {
      const list = events.get(runId);
      if (list === undefined) return [];
      const { types = 'all', afterSequence, limit, reportItems = 'all' } = options;
      // report 的 item 可能很大：超过 reportItems.limit 的第 N+1 条起，item 字段被删掉（原实现同款）。
      const oversized = new Set();
      if (reportItems !== 'all') {
        let seen = 0;
        for (const entry of list) {
          if (entry.event.type !== 'report') continue;
          seen += 1;
          if (seen > reportItems.limit) oversized.add(entry.sequence);
        }
      }
      const filtered = list.filter((entry) => (types === 'all' || types.includes(entry.event.type))
        && (afterSequence === undefined || entry.sequence > afterSequence));
      return (limit === undefined ? filtered : filtered.slice(0, Math.max(0, limit))).map((entry) => {
        const copy = clone(entry);
        if (oversized.has(entry.sequence)) delete copy.event.item;
        return copy;
      });
    },
  };
}
