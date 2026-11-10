/**
 * 工作流执行引擎（G2 宿主调度引擎）。
 *
 * 这是 `beauty/zcode-cli.js:649150-651267`（WorkflowEngine + AskScheduler + AgentRuntimeWorkflowDriver）
 * 的移植，行为契约见 docs/port-contract.md：
 *
 * - 节点生命周期：queued → dispatched → executing/waiting/repairing/nudged → settled
 *   （每个迁移都写 journal 节点行 + 一条同名事件）。
 * - 会话模型：一个 actor 一个会话，**同名 actor 复用同一会话**（journal 记 sessionId）；
 *   同一 actor 同时只跑一个 ask，后续 ask 在 `liveQueue` 里 FIFO 排队。
 * - 调度三层：每 actor 串行 + 全局 `activeAsks < maxConcurrency` 计数 + AIMD 自适应
 *   （见 host/concurrency.js：连续 4 次成功且有人等待才 +1；被限流 ×0.75 或回落 lastGood；
 *   空闲 5 分钟复位）。默认上限 `max(4, min(16, cores-2))`。
 * - 预算：repair 3 次、nudge 1 次、escalation 3 次/ask（ASK_BUDGET）。
 * - hole：`hole()` 到达未补全的站点 → 挂起该分支（hole-reached），`fillHole` 后 release
 *   （hole-filled），同一 siteId 再到达不再过线。
 * - 提问题：`escalate` 挂到 `qid`，`resolveQuestion` 把答案逐字回灌（escalation-raised/resolved）。
 * - 产物：content（file/markdown）是效应，走 request/response；preset 是声明，发布时校验
 *   id/规格/唯一 primary/上限（逐字文案见 host/artifact-messages 常量）。
 * - report：caps 65536 项 / 单项 1 MiB / 单运行 1 GiB；带 artifactId 的项必须指向已声明 preset。
 * - token：ask 结算时累加 `tokens`，`usage-updated` + journal.updateRunUsage。
 *
 * ## 与真 ZCode 的已知偏差（都由运行环境决定，不是遗漏）
 * 1. **子进程 vs vm**：脚本在本进程的 `node:vm` context 里跑（host/cell.js），不是独立子进程。
 *    协议、隔离边界、停滞检测都一致；差别是没有进程级崩溃隔离与 `--max-old-space-size` 兜底。
 * 2. **actor 会话的“一轮”**：DSH 的 subagent 以 activation 为单位（一次启动 = 一个回合），
 *    没有可动态注册的 `submit_result` 工具。因此这里把每个 ask 拆成若干“回合”，
 *    repair/nudge 用**逐字提示词**再开一回合（`violations` 文本 / NUDGE_PROMPT），
 *    而 actor 的跨 ask 上下文用脚本侧保留的历史合成在提示词尾部（ZCode 靠会话本身）。
 * 3. 没有 provider 配额自动续跑、没有 header/transcript 边界（amend 的种子）——DSH 侧无对应能力。
 *
 * ## 注入的 ctx 约定（dev-host 提供；未提供时用内存实现）
 * journal：`createRun/getRun/listRuns/updateRunStatus/updateRunUsage/updateRunCaps/updateRunScript/
 *   putActor/getActor/putNode/getNode/listNodes/countNodes/sumResultBytes/appendEvent/listEvents`
 * projection：`apply?(runId, event)`、`snapshot?(runId)`（可选；只在存在时调用）
 * artifacts：`publish(record)`（可选；内容产物必须有它才能发布）
 */

import os from 'node:os';
import { createWorkflowCell } from './cell.js';
import { createFacadeBridge } from './facade.js';
import { createMemoryJournal } from './journal-memory.js';
import { inputHash, safeJson, utf8Length, preview } from './canonical.js';
import {
  ARTIFACT_CAPS, ARTIFACT_ID_PATTERN, ASK_BUDGET, RUNTIME_CAPS, REPORT_CAPS, WORKSPACE_CAPS,
  ConcurrencyController, defaultMaxConcurrency, transientBackoffMs,
} from './concurrency.js';
import {
  ARTIFACT_BINARY_UNSUPPORTED, ARTIFACT_NO_SESSION_SCOPE, ARTIFACT_STORE_UNAVAILABLE,
  describeArg, fileArtifactFailureMessage, invalidArtifactIdMessage, invalidArtifactOptionsMessage,
  invalidMarkdownMessage, mimeForPath,
} from './artifact-messages.js';
import {
  ESCALATIONS_PER_ASK, ESCALATION_BUDGET_EXHAUSTED, ESCALATION_NO_ACTIVE_ASK, NUDGE_PROMPT,
  SUBMIT_VIOLATIONS_HEADER, buildAskPrompt, buildWorkflowActorIdentity, formatViolations,
  parseEscalationMarkers,
} from './prompts.js';

/** 运行终态。 */
const TERMINAL = new Set(['completed', 'errored', 'stopped']);

/** provider 侧错误码：这些失败把 run 收成 `stopped/provider`，而不是 `errored`（M11）。 */
const PROVIDER_ERROR_CODES = new Set([
  'auth', 'AuthError', 'not_configured', 'model_unavailable', 'invalid_request', 'quota',
  'ProviderThrottled', 'ProviderUnavailable', 'ProviderAuth', 'ProviderQuota', 'ModelUnavailable',
]);

/** 一个 ask 的升级回合上限（防止模型反复提同一个问题把回合循环拖死）。 */
const MAX_ESCALATION_ROUNDS = ESCALATIONS_PER_ASK + 1;

/** `GetWorkflowRun.logTail[].message` 的上限（契约 `Q0e`，cli.md:540）。 */
export const MAX_LOG_TAIL_MESSAGE = 1024;

/** `GetWorkflowRun.summary` 的上限（契约 §1.5 `summary(max 400)`，cli.md:162）。 */
const MAX_RUN_SUMMARY = 400;

/** `run-settled` 通知 `<summary>` 的上限（终态通知载荷 `summary: max(500)`，见契约 §7）。 */
const MAX_NOTIFICATION_SUMMARY = 500;

/** 会被当作“有进展”的事件：停滞判定读它刷新 lastProgressAt。 */
const PROGRESS_EVENTS = new Set([
  'node-queued', 'node-dispatched', 'node-executing', 'node-progress', 'node-settled',
  'node-repairing', 'node-nudged', 'report', 'artifact-published', 'artifact-failed',
  'phase-entered', 'hole-reached', 'hole-filled', 'usage-updated', 'log',
  'escalation-raised', 'escalation-resolved',
]);

/** 引擎内部错误：带稳定 `code`，脚本侧 catch 后能按 `err.code` 分支。 */
export class WorkflowError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{violations?: unknown, finalText?: string}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    if (extra.violations !== undefined) this.violations = extra.violations;
    if (extra.finalText !== undefined) this.finalText = extra.finalText;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.violations === undefined ? {} : { violations: this.violations }),
      ...(this.finalText === undefined ? {} : { finalText: this.finalText }),
    };
  }
}

/**
 * 校验 typed ask 的结果，返回违规列表（空 = 通过）。
 * 支持本编译器产出的 schema 子集：type/properties/required/additionalProperties/items/enum/const/nullable。
 *
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [path]
 * @returns {{path: string, expected: string, got: string}[]}
 */
export function validateSchema(value, schema, path = '$') {
  if (schema === undefined || schema === null || schema === true) return [];
  const expected = describeSchema(schema);
  if (Array.isArray(schema.enum)) {
    if (schema.enum.includes(value)) return [];
    // 字符串化的 enum 也接受（模型常把枚举写成字符串）
    if (typeof value === 'string' && schema.enum.map(String).includes(value)) return [];
    return [{ path, expected, got: describeValue(value) }];
  }
  if (schema.const !== undefined) {
    if (value === schema.const || (typeof value === 'string' && String(schema.const) === value)) return [];
    return [{ path, expected, got: describeValue(value) }];
  }
  const type = schema.type;
  if (type === 'string') return typeof value === 'string' ? [] : [{ path, expected, got: describeValue(value) }];
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? [] : [{ path, expected, got: describeValue(value) }];
  if (type === 'integer') return Number.isInteger(value) ? [] : [{ path, expected, got: describeValue(value) }];
  if (type === 'boolean') return typeof value === 'boolean' ? [] : [{ path, expected, got: describeValue(value) }];
  if (type === 'null') return value === null ? [] : [{ path, expected, got: describeValue(value) }];
  if (type === 'array') {
    if (!Array.isArray(value)) return [{ path, expected, got: describeValue(value) }];
    const violations = [];
    value.forEach((entry, index) => {
      violations.push(...validateSchema(entry, schema.items ?? {}, `${path}[${index}]`));
    });
    return violations;
  }
  if (type === 'object' || schema.properties !== undefined) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [{ path, expected, got: describeValue(value) }];
    }
    const violations = [];
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) violations.push({ path: `${path}.${key}`, expected: 'a value', got: 'nothing' });
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) violations.push({ path: `${path}.${key}`, expected: 'no such field', got: describeValue(value[key]) });
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (value[key] === undefined) continue;
      violations.push(...validateSchema(value[key], propertySchema, `${path}.${key}`));
    }
    return violations;
  }
  return [];
}

/**
 * schema 的人话描述（违规文本里用）。
 * @param {object} schema
 * @returns {string}
 */
function describeSchema(schema) {
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`;
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.type === 'array') return 'an array';
  if (schema.type === 'object' || schema.properties !== undefined) return 'an object';
  return schema.type ?? 'a JSON value';
}

/**
 * 值的人话描述。
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array (${value.length} items)`;
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return JSON.stringify(preview(value, 40));
  return String(value);
}

/**
 * typed ask 的 submit 规范化（`DFa`）：先校验原值，字符串再尝试 JSON.parse 复校验。
 *
 * @param {unknown} value
 * @param {object | undefined} schema
 * @returns {{value: unknown, violations: {path: string, expected: string, got: string}[]}}
 */
export function normalizeSubmit(value, schema) {
  if (schema === undefined) return { value, violations: [] };
  const direct = validateSchema(value, schema);
  if (direct.length === 0) return { value, violations: [] };
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      const again = validateSchema(parsed, schema);
      return { value: parsed, violations: again };
    } catch {
      // 不是 JSON，保留原值与违规
    }
  }
  return { value, violations: direct };
}

/**
 * 从文本里尽力取出 JSON（模型常加代码围栏或前后说明）。
 * @param {string} text
 * @returns {unknown}
 */
function parseJsonLoose(text) {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  if (fenced !== null) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // 下一个
    }
  }
  return undefined;
}

/**
 * 生成 run id。
 * @returns {string}
 */
function newRunId() {
  return `dwf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * actor 会话 id（`mintActorSessionId`，cli.md:739755-739760）。
 * @param {string} runId
 * @param {{siteId: string, ordinal: number}} ref
 * @returns {string}
 */
export function mintActorSessionId(runId, ref) {
  const sanitize = (value) => String(value).replace(/_/gu, '__').replace(/[^A-Za-z0-9.-]/gu, '_');
  return `dwf-${sanitize(runId)}-${sanitize(`${ref.siteId}@${ref.ordinal}`)}`;
}

/** @typedef {{siteId: string, ordinal: number}} NodeRef */

/**
 * 工作流引擎：一次 run 的全部可变状态。
 *
 * 为什么把引擎与 runtime 的 run 注册表分开：引擎不知道通知、等待者、订阅者；它只对
 * journal 与 driver 负责，因此可以单独构造、单独测。
 */
class WorkflowEngine {  /**
   * @param {object} options
   * @param {string} options.runId
   * @param {object} options.journal
   * @param {object} options.driver 由 runtime 构造（见 createDriver）
   * @param {{maxConcurrency: number}} options.caps
   * @param {Map<string, object>} [options.askSpecs]
   * @param {Map<string, string>} [options.sitePhases]
   * @param {Map<string, string>} [options.holeTypes] 站点 id → 类型文本（`holes[].type`）
   * @param {object} [options.launch] run-launched 载荷
   * @param {number} [options.now]
   */
  constructor({ runId, journal, driver, caps, askSpecs = new Map(), sitePhases = new Map(), holeTypes = new Map(), launch, now = Date.now }) {
    this.runId = runId;
    this.journal = journal;
    this.driver = driver;
    this.caps = { maxConcurrency: Math.max(1, Math.floor(caps.maxConcurrency)) };
    this.askSpecs = askSpecs;
    this.sitePhases = sitePhases;
    /** @type {Map<string, string>} */
    this.holeTypes = holeTypes;
    this.now = now;
    this.ordinals = new Map();
    this.phaseOrdinals = new Map();
    this.currentPhase = undefined;
    this.instancePhases = new Map();
    this.actorNames = new Map();
    this.holes = new Map();
    this.filledHoles = new Map();
    /** @type {Map<string, {kind: string, spec?: string, versions?: number, primary?: boolean, items?: number}>} */
    this.artifacts = new Map();
    this.reportTally = { count: 0, bytes: 0 };
    this.spentTokens = 0;
    this.settled = false;
    this.failure = undefined;
    this.settleDeferred = Promise.withResolvers();
    this.scheduler = new AskScheduler(this);
    // AIMD 的增长上界就是本次 run 的并发上限（不是全局 1024 上限）：否则 cap 会漂到
    // `max_concurrency` 之上（评审 m9）。改上限走 setMaxConcurrency()。
    this.concurrency = new ConcurrencyController(runId, this.caps.maxConcurrency, this.caps.maxConcurrency, now);
    this.lastProgressAt = now();
    this.stalledSince = undefined;
    this.stallReminders = 0;

    const existing = journal.getRun(runId);
    if (existing === undefined) {
      journal.createRun({
        runId,
        status: 'running',
        caps: { ...this.caps },
        spentTokens: 0,
        cwd: launch?.cwd,
        name: launch?.name,
        scriptText: launch?.scriptText,
        scriptPath: launch?.scriptPath,
        scriptHash: launch?.scriptHash,
        args: launch?.args,
        ...(launch?.resumedFrom === undefined ? {} : { resumedFrom: launch.resumedFrom }),
        timeCreated: now(),
      });
    } else {
      this.spentTokens = existing.spentTokens ?? 0;
      this.restoreFromJournal();
      journal.updateRunStatus(runId, 'running');
    }
    this.record({ type: 'run-started', runId, caps: { ...this.caps } });
    if (existing === undefined && launch !== undefined) this.record(runLaunchedEvent(launch));
    if (this.spentTokens > 0) this.record({ type: 'usage-updated', spentTokens: this.spentTokens });
  }

  /** 续跑：从 journal 恢复工件/报告计数与已完成节点（重放靠 scheduler 的 inputHash 命中）。 */
  restoreFromJournal() {
    for (const row of this.journal.listNodes(this.runId, { kinds: ['artifact'], withResult: true })) {
      this.rememberArtifactRow(row.artifactId, row.result);
    }
    this.reportTally = {
      count: this.journal.countNodes(this.runId, 'report'),
      bytes: this.journal.sumResultBytes(this.runId, 'report'),
    };
    const run = this.journal.getRun(this.runId);
    if (run?.phases !== undefined) this.sitePhases = new Map(Object.entries(run.phases));
  }

  /**
   * 记录一条事件（原实现 `record`）：先补 phase 信息，再写 journal + 通知 driver。
   * @param {object} event
   */
  /** 记录一条事件（原实现 `record`）：先补 phase 信息，再写 journal + 通知 driver。 */
  record(event) {
    // 进展时间戳：停滞判定与 health.lastProgressAt 共用（评审 M10）。
    if (PROGRESS_EVENTS.has(event.type)) this.noteProgress();
    const stamped = stampBirthPhase(event, this.instancePhases);
    try {
      this.journal.appendEvent(this.runId, stamped);
    } catch (error) {
      this.driver.logger?.warn?.(`zcode-workflow: journal append failed for ${this.runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      this.driver.emit(stamped);
    } catch (error) {
      this.driver.logger?.warn?.(`zcode-workflow: event listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 下一个站点序号，并记下该节点的阶段（`nextOrdinal`）。
   * @param {string} siteId
   * @returns {number}
   */
  nextOrdinal(siteId) {
    const ordinal = (this.ordinals.get(siteId) ?? 0) + 1;
    this.ordinals.set(siteId, ordinal);
    const phaseName = this.sitePhases.get(siteId) ?? this.currentPhase;
    if (phaseName !== undefined) this.instancePhases.set(`${siteId}@${ordinal}`, phaseName);
    return ordinal;
  }

  /**
   * 建 actor（原实现 `createActor`）。
   * @param {string} siteId
   * @param {string | undefined} name
   * @param {string | object | undefined} persona
   * @returns {NodeRef}
   */
  createActor(siteId, name, persona) {
    this.assertRunning('createActor');
    const ordinal = this.nextOrdinal(siteId);
    const ref = { siteId, ordinal };
    const key = `${siteId}@${ordinal}`;
    const normalized = normalizePersona(name, persona);
    const actorName = normalized.name;
    if (actorName !== undefined && actorName !== '') {
      const first = this.actorNames.get(actorName);
      if (first !== undefined) {
        const error = new WorkflowError(
          'DuplicateActorName',
          `Subagent name "${actorName}" is used twice in this run (${first} and ${key}). A named subagent is the identity an amended re-run matches its cache by, so names must be unique; give this one its own name or drop the name to make it anonymous.`,
        );
        this.fail(error);
        throw error;
      }
      this.actorNames.set(actorName, key);
    }
    this.scheduler.registerActor(ref, key, normalized.name, normalized);
    const existing = this.journal.getActor(this.runId, siteId, ordinal);
    this.journal.putActor({
      runId: this.runId,
      siteId,
      ordinal,
      ...(normalized.name === undefined ? {} : { name: normalized.name }),
      persona: normalized,
      sessionId: existing?.sessionId,
      ...(existing?.resolvedModel === undefined ? {} : { resolvedModel: existing.resolvedModel }),
      status: 'waiting',
    });
    this.record({ type: 'actor-created', actor: ref, name: normalized.name, persona: normalized });
    return ref;
  }

  /**
   * 提交一个 ask（原实现 `ask`）。
   * @param {string} siteId
   * @param {NodeRef} actor
   * @param {string} instructions
   * @returns {Promise<unknown>}
   */
  ask(siteId, actor, instructions) {
    if (this.settled) return Promise.reject(this.runError());
    if (!this.scheduler.hasActor(actor)) {
      const error = new WorkflowError('UnknownActor', `Unknown subagent handle: ${actor.siteId}@${actor.ordinal}.`);
      this.fail(error);
      return Promise.reject(error);
    }
    const spec = this.askSpecs.get(siteId);
    if (spec === undefined) {
      const error = new WorkflowError('MissingAskSpec', `Ask site ${siteId} has no spec: askSpecs is incomplete (compile output mismatch).`);
      this.fail(error);
      return Promise.reject(error);
    }
    // 空指令照常下发（契约没有这条校验；评审 m15）。ask() 只要求句柄与站点存在。
    return this.scheduler.admitAsk(siteId, actor, typeof instructions === 'string' ? instructions : String(instructions ?? ''), spec);
  }

  /**
   * world-read / world.run（原实现 `readWorld`）：有 journal 命中就重放，否则执行并落节点。
   * @param {string} siteId
   * @param {string} op
   * @param {unknown[]} args
   * @returns {Promise<unknown>}
   */
  async worldRead(siteId, op, args) {
    if (this.settled) throw this.runError();
    const ordinal = this.nextOrdinal(siteId);
    const ref = { siteId, ordinal };
    const hash = inputHash({ op, args });
    const kind = op === 'run' ? 'world-run' : 'world-read';
    const existing = this.journal.getNode(this.runId, siteId, ordinal);
    if (existing !== undefined) {
      if (existing.inputHash !== hash) throw this.inputHashMismatch(ref, existing.inputHash, hash);
      if (existing.status === 'completed') {
        this.record({ type: 'node-settled', instance: ref, outcome: 'ok', cached: true });
        return existing.result;
      }
      if (existing.status === 'failed') {
        this.record({ type: 'node-settled', instance: ref, outcome: 'failed', cached: true, error: existing.error });
        throw WorkflowError.fromJSON(existing.error);
      }
    }
    if (kind === 'world-run') this.closeImportCache(ref, 'world-run');
    const boundedArgs = boundWorldReadInput(op, args);
    this.journal.putNode({
      runId: this.runId, siteId, ordinal, kind, inputHash: hash, input: boundedArgs, status: 'running',
    });
    this.record({ type: 'node-queued', instance: ref, kind });
    this.record({ type: 'node-dispatched', instance: ref });
    try {
      const result = await this.driver.executeWorldRead(op, args);
      this.journal.putNode({
        runId: this.runId, siteId, ordinal, kind, inputHash: hash, input: boundedArgs, status: 'completed', result,
      });
      this.record({ type: 'node-settled', instance: ref, outcome: 'ok' });
      return result;
    } catch (error) {
      const wrapped = error instanceof WorkflowError
        ? error
        : new WorkflowError('DriverError', `World read failed: ${op} ${safeJson(args)}.`, {});
      this.journal.putNode({
        runId: this.runId, siteId, ordinal, kind, inputHash: hash, input: boundedArgs, status: 'failed', error: wrapped.toJSON(),
      });
      this.record({ type: 'node-settled', instance: ref, outcome: 'failed', error: wrapped.toJSON() });
      throw wrapped;
    }
  }

  /**
   * `log()`：进度 narration。
   * @param {string} message
   */
  log(message) {
    if (!this.settled) this.record({ type: 'log', message: String(message) });
  }

  /**
   * `phase()`：只发事件，不落 journal 节点（阶段是展示结构）。
   * @param {string} name
   */
  enterPhase(name) {    if (this.settled) return;
    const trimmed = String(name ?? '').trim();
    if (trimmed.length === 0) return;
    const ordinal = (this.phaseOrdinals.get(trimmed) ?? 0) + 1;
    this.phaseOrdinals.set(trimmed, ordinal);
    this.currentPhase = trimmed;
    this.record({ type: 'phase-entered', name: trimmed, ordinal });
  }

  /**
   * 记录“有进展”的时间戳（停滞判定与 `health.lastProgressAt` 共用）。
   */
  noteProgress() {
    this.lastProgressAt = this.now();
    this.stalledSince = undefined;
    this.stallReminders = 0;
  }

  /**
   * 运行中调整并发上限（`setMaxConcurrency`）：改 caps + journal + `run-caps-changed`，
   * 并让 AIMD 的增长上界跟着走（评审 M2/m3/m9）。
   *
   * @param {number} value
   * @returns {boolean} 是否真的改了
   */
  setMaxConcurrency(value) {
    if (this.settled || !Number.isFinite(value)) return false;
    const next = Math.max(1, Math.floor(value));
    if (next === this.caps.maxConcurrency) return false;
    const previous = { maxConcurrency: this.caps.maxConcurrency };
    this.caps = { maxConcurrency: next };
    try {
      this.journal.updateRunCaps?.(this.runId, { ...this.caps });
    } catch (error) {
      this.driver.logger?.warn?.(`zcode-workflow: updateRunCaps failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.record({ type: 'run-caps-changed', runId: this.runId, caps: { ...this.caps }, previous });
    for (const change of this.concurrency.setGrowthLimit(this.now(), next)) {
      this.record({ type: 'concurrency-changed', ...change });
    }
    if (next > previous.maxConcurrency) this.scheduler.pumpAll();
    return true;
  }

  /**
   * `hole()`：到达未补全的留白 → 挂起该分支。
   * @param {string} siteId
   * @param {string} name
   * @param {string | undefined} prompt
   * @returns {Promise<{code: string}>}
   */
  hole(siteId, name, prompt) {
    if (this.settled) return Promise.reject(this.runError());
    const remembered = this.filledHoles.get(siteId);
    if (remembered !== undefined) return Promise.resolve({ code: remembered.code });
    const ordinal = this.nextOrdinal(siteId);
    const ref = { siteId, ordinal };
    const boundedPrompt = typeof prompt === 'string' && prompt.length > 0 ? preview(prompt, 4000) : undefined;
    const deferred = Promise.withResolvers();
    const declaredType = this.holeTypes.get(siteId);
    const record = {
      siteId,
      ordinal,
      name: String(name),
      ...(declaredType === undefined ? {} : { type: declaredType }),
      prompt: boundedPrompt,
      since: this.now(),
      deferred,
      ref,
    };
    this.holes.set(siteId, record);
    this.record({
      type: 'hole-reached',
      instance: ref,
      name: record.name,
      ...(declaredType === undefined ? {} : { holeType: declaredType }),
      ...(boundedPrompt === undefined ? {} : { prompt: boundedPrompt }),
    });
    return deferred.promise;
  }

  /**
   * 补全留白（`fillHole` 的后半：L4o）。
   * @param {string} siteId
   * @param {string} code
   * @param {string} [filledBy]
   * @param {string} [name]
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  fillHole(siteId, code, filledBy, name) {
    if (this.settled) return { ok: false, reason: 'settled' };
    const parked = this.holes.get(siteId);
    if (parked === undefined && !this.filledHoles.has(siteId)) return { ok: false, reason: 'not_waiting' };
    const filledAt = this.now();
    const filledType = parked?.type ?? this.holeTypes.get(siteId) ?? this.filledHoles.get(siteId)?.type;
    this.filledHoles.set(siteId, {
      code,
      filledAt,
      name: name ?? parked?.name ?? this.filledHoles.get(siteId)?.name ?? siteId,
      ...(filledType === undefined ? {} : { type: filledType }),
      ...(filledBy === undefined ? {} : { filledBy }),
    });
    this.record({
      type: 'hole-filled',
      siteId,
      filledAt,
      ...(filledBy === undefined ? {} : { filledBy }),
      phaseNames: this.driver.phaseNames ?? [],
    });
    if (parked !== undefined) {
      this.holes.delete(siteId);
      parked.deferred.resolve({ code });
    }
    this.noteProgress();
    return { ok: true };
  }

  /**
   * 续跑时把脚本里记录的 fill 体重新装回引擎（评审 M4）：站点直接算已补全，不再挂起。
   * @param {Record<string, {code: string, filledAt?: number, filledBy?: string, name?: string}>} fills
   */
  seedFills(fills) {
    for (const [siteId, record] of Object.entries(fills ?? {})) {
      if (record === undefined || typeof record.code !== 'string') continue;
      this.filledHoles.set(siteId, record);
    }
  }

  /**
   * 留白清单（含已填）：`GetWorkflowRun.holes` 的 `state` 需要 waiting/filled 两种（评审 m14）。
   * @returns {object[]}
   */
  holeRecords() {
    /** @type {object[]} */
    const rows = [...this.holes.values()].map((hole) => ({
      siteId: hole.siteId,
      ordinal: hole.ordinal,
      name: hole.name,
      ...(hole.type === undefined ? {} : { type: hole.type }),
      state: 'waiting',
      since: hole.since,
    }));
    for (const [siteId, record] of this.filledHoles.entries()) {
      if (this.holes.has(siteId)) continue;
      rows.push({
        siteId,
        ordinal: record.ordinal ?? 0,
        name: record.name ?? siteId,
        ...(record.type === undefined ? {} : { type: record.type }),
        state: 'filled',
        ...(record.filledAt === undefined ? {} : { filledAt: record.filledAt }),
        ...(record.filledBy === undefined ? {} : { filledBy: record.filledBy }),
      });
    }
    return rows;
  }

  /**
   * 挂起中的留白清单（GetWorkflowRun.holes）。
   * @returns {object[]}
   */
  openHoles() {
    return [...this.holes.values()].map((hole) => ({
      siteId: hole.siteId,
      ordinal: hole.ordinal,
      name: hole.name,
      ...(hole.type === undefined ? {} : { type: hole.type }),
      ...(hole.prompt === undefined ? {} : { prompt: hole.prompt }),
      state: 'waiting',
      since: hole.since,
    }));
  }

  /* ---------------- 产物 ---------------- */

  /**
   * 内容产物（file/markdown）：效应，走 request/response。
   * @param {string} siteId
   * @param {'file'|'markdown'} op
   * @param {unknown[]} args
   * @returns {Promise<{id: string, version: number}>}
   */
  async publishArtifact(siteId, op, args) {
    if (this.settled) throw this.runError();
    const ordinal = this.nextOrdinal(siteId);
    const ref = { siteId, ordinal };
    const id = args[0];
    const content = args[1];
    const opts = args[2];
    // §6.6 的逐字文案：id → opts（title/description/primary/contentType）→ 正文/大小。
    const invalidId = invalidArtifactIdMessage(op, id);
    if (invalidId !== undefined) throw new WorkflowError('DriverError', invalidId);
    const invalidOptions = invalidArtifactOptionsMessage(op, opts);
    if (invalidOptions !== undefined) throw new WorkflowError('DriverError', invalidOptions);
    if (op === 'file' && typeof content !== 'string') {
      throw new WorkflowError('DriverError', `artifact.file: path must be a string, got ${describeArg(content)}.`);
    }
    if (op === 'markdown') {
      const invalidMarkdown = invalidMarkdownMessage(content);
      if (invalidMarkdown !== undefined) throw new WorkflowError('DriverError', invalidMarkdown);
    }
    const hash = inputHash({ op, args, id });
    const existing = this.journal.getNode(this.runId, siteId, ordinal);
    if (existing !== undefined) {
      if (existing.inputHash !== hash) throw this.inputHashMismatch(ref, existing.inputHash, hash);
      if (existing.status === 'completed') return { id: existing.result.id, version: existing.result.version };
      if (existing.status === 'failed') throw WorkflowError.fromJSON(existing.error);
    }
    const primaryRequested = opts?.primary === true;
    const version = (this.artifacts.get(id)?.versions ?? 0) + 1;
    const admission = this.admitArtifact(id, op, primaryRequested);
    if (admission !== undefined) throw this.failArtifact(ref, hash, { id, op }, admission);
    this.journal.putNode({
      runId: this.runId, siteId, ordinal, kind: 'artifact', inputHash: hash, status: 'running', artifactId: id,
    });
    try {
      const published = await this.driver.executeArtifactPublish({ runId: this.runId, siteId, ordinal, op, id, version, content, opts });
      const record = {
        id,
        kind: op,
        version,
        ...(typeof opts?.title === 'string' ? { title: opts.title } : {}),
        ...(typeof opts?.description === 'string' ? { description: opts.description } : {}),
        ...(op === 'file'
          ? {
            ...(opts?.contentType === undefined ? (mimeForPath(content) === undefined ? {} : { contentType: mimeForPath(content) }) : { contentType: opts.contentType }),
            sourcePath: content,
          }
          : { bytes: utf8Length(content) }),
        ...(published?.contentType === undefined ? {} : { contentType: published.contentType }),
        ...(published?.bytes === undefined ? {} : { bytes: published.bytes }),
        ...(published?.sourcePath === undefined ? {} : { sourcePath: published.sourcePath }),
        primary: primaryRequested || this.artifacts.get(id)?.primary === true,
      };
      this.journal.putNode({
        runId: this.runId, siteId, ordinal, kind: 'artifact', inputHash: hash, status: 'completed', result: record, artifactId: id,
      });
      this.artifacts.set(id, { kind: op, versions: version, primary: record.primary === true });
      this.record({ type: 'artifact-published', instance: ref, artifact: record });
      this.noteProgress();
      return { id, version };
    } catch (error) {
      const wrapped = error instanceof WorkflowError
        ? error
        : new WorkflowError(
          error?.name === 'ArtifactTooLarge' ? 'ArtifactTooLarge' : 'DriverError',
          error?.name === 'ArtifactTooLarge'
            ? fileArtifactFailureMessage({ path: String(content), reason: 'too_large', bytes: error?.bytes })
            : (error?.message ?? `Artifact publish failed: ${op} "${id}".`),
        );
      throw this.failArtifact(ref, hash, { id, op }, wrapped);
    }
  }

  /**
   * 声明 preset（chart/table/metrics/board）：同步、void，走事件通道。
   * @param {string} siteId
   * @param {string} op
   * @param {unknown[]} args
   */
  declareArtifact(siteId, op, args) {
    if (this.settled) return;
    const ordinal = this.nextOrdinal(siteId);
    const ref = { siteId, ordinal };
    const id = args[0];
    const spec = args[1];
    if (typeof id !== 'string' || id === '') {
      this.fail(new WorkflowError('DriverError', invalidArtifactIdMessage(op, id) ?? `artifact.${op}: invalid id.`));
      return;
    }
    const hash = inputHash({ op, args, id });
    const existing = this.journal.getNode(this.runId, siteId, ordinal);
    if (existing !== undefined) {
      if (existing.inputHash !== hash) {
        this.fail(this.inputHashMismatch(ref, existing.inputHash, hash));
        return;
      }
      return;
    }
    const invalid = validateArtifactSpec(op, spec);
    if (invalid !== undefined) {
      this.fail(new WorkflowError('ArtifactSpecInvalid', `Artifact "${id}" has an invalid spec (at ${refToString(ref)}): ${invalid}`));
      return;
    }
    const previous = this.artifacts.get(id);
    if (previous !== undefined) {
      if (previous.kind !== op) {
        this.fail(new WorkflowError('ArtifactKindMismatch', `Artifact id "${id}" is already a ${previous.kind} and cannot be declared as a ${op} (at ${refToString(ref)}). An id belongs to one artifact kind for the whole run; use a different id.`));
        return;
      }
      if (previous.spec === safeJson(spec)) return;
      this.fail(new WorkflowError('ArtifactRedeclared', `Artifact "${id}" was already declared with a different spec (at ${refToString(ref)}). The spec for one id must stay identical (an identical re-declaration is a no-op); declare it once at the top of the script.`));
      return;
    }
    const primary = spec?.primary === true;
    const conflict = primaryConflict(this.primaryArtifactId(), id, primary, `declare "${id}" without primary`, ref);
    if (conflict !== undefined) {
      this.fail(conflict);
      return;
    }
    if (this.artifacts.size >= ARTIFACT_CAPS.maxArtifactsPerRun) {
      this.fail(new WorkflowError('ArtifactCapExceeded', `Cannot declare "${id}": this run already has ${ARTIFACT_CAPS.maxArtifactsPerRun} artifact ids, the maximum. Reuse an existing id or publish fewer artifacts.`));
      return;
    }
    const record = {
      id,
      kind: op,
      version: 1,
      ...(typeof spec?.title === 'string' ? { title: spec.title } : {}),
      ...(typeof spec?.description === 'string' ? { description: spec.description } : {}),
      spec,
      ...(primary ? { primary: true } : {}),
    };
    this.artifacts.set(id, { kind: op, spec: safeJson(spec), versions: 1, primary, items: 0 });
    this.journal.putNode({
      runId: this.runId, siteId, ordinal, kind: 'artifact', inputHash: hash, status: 'completed', result: record, artifactId: id,
    });
    this.record({ type: 'artifact-published', instance: ref, artifact: record });
  }

  /**
   * `report(item, artifactId?)`：即发即忘的进度项。
   * @param {string} siteId
   * @param {unknown} item
   * @param {string | undefined} artifactId
   */
  report(siteId, item, artifactId) {
    if (this.settled) return;
    const ordinal = this.nextOrdinal(siteId);
    const ref = { siteId, ordinal };
    let serialized;
    try {
      serialized = JSON.stringify(item);
    } catch (error) {
      this.fail(new WorkflowError('DriverError', `report() item cannot be serialized to JSON (a cycle or a bigint) at ${refToString(ref)}. Report a plain JSON value.`));
      return;
    }
    if (serialized === undefined) {
      this.fail(new WorkflowError('DriverError', `report() item is not a JSON value (undefined, a function or a symbol) at ${refToString(ref)}. Report a plain JSON value.`));
      return;
    }
    const tag = typeof artifactId === 'string' && artifactId !== '' ? artifactId : undefined;
    const hash = inputHash({ item, artifactId: tag ?? null });
    const existing = this.journal.getNode(this.runId, siteId, ordinal);
    if (existing !== undefined) {
      if (existing.inputHash !== hash) {
        this.fail(this.inputHashMismatch(ref, existing.inputHash, hash));
        return;
      }
      return;
    }
    if (tag !== undefined) {
      const preset = this.artifacts.get(tag);
      const isPreset = preset !== undefined && preset.kind !== 'file' && preset.kind !== 'markdown';
      if (!isPreset) {
        const declas = [...this.artifacts.entries()]
          .filter(([, info]) => info.kind !== 'file' && info.kind !== 'markdown')
          .map(([id]) => id);
        this.fail(new WorkflowError('ArtifactUndeclared', `report() tag "${tag}" is not a declared preset artifact (at ${refToString(ref)}). Declare it once at the top of the script, e.g. artifact.chart("${tag}", …), before tagging reports with it. Declared presets: ${declas.join(', ') || '(none)'}.`));
        return;
      }
    }
    const bytes = utf8Length(serialized);
    if (bytes > REPORT_CAPS.maxItemSerializedBytes) {
      this.fail(new WorkflowError('ReportCapExceeded', `report() item at ${refToString(ref)} is ${bytes} bytes, over the ${REPORT_CAPS.maxItemSerializedBytes}-byte limit. Report a summary instead.`));
      return;
    }
    if (this.reportTally.count >= REPORT_CAPS.maxItemsPerRun) {
      this.fail(new WorkflowError('ReportCapExceeded', `This run already reported ${REPORT_CAPS.maxItemsPerRun} items, the maximum. Report findings, not chatter.`));
      return;
    }
    if (this.reportTally.bytes + bytes > REPORT_CAPS.maxBytesPerRun) {
      this.fail(new WorkflowError('ReportCapExceeded', `report() item at ${refToString(ref)} would take this run's reports to ${this.reportTally.bytes + bytes} bytes, over the ${REPORT_CAPS.maxBytesPerRun}-byte limit per run. Report summaries, and publish large results with artifact.file.`));
      return;
    }
    this.reportTally = { count: this.reportTally.count + 1, bytes: this.reportTally.bytes + bytes };
    // journal 侧最多保留 Vs.maxReports(64) 行（评审 M14）：超出后仍计数与发事件，但不再落行，
    // 这样 GetWorkflowRun 的读取侧裁剪就不再是唯一护栏。
    const keepRow = this.reportTally.count <= RUNTIME_CAPS.maxReports;
    if (keepRow) {
      this.journal.putNode({
        runId: this.runId, siteId, ordinal, kind: 'report', inputHash: hash, status: 'completed', result: item,
        ...(tag === undefined ? {} : { artifactId: tag }),
      });
    }
    if (tag !== undefined) {
      const preset = this.artifacts.get(tag);
      if (preset !== undefined) {
        this.artifacts.set(tag, { ...preset, items: (preset.items ?? 0) + 1 });
      }
    }
    this.noteProgress();
    this.record({ type: 'report', instance: ref, item, ...(tag === undefined ? {} : { artifactId: tag }) });
  }

  /**
   * ask 的统计（token/turn/toolCalls）落 journal + `usage-updated`。
   * @param {NodeRef} ref
   * @param {{tokens?: number, turns?: number, toolCalls?: number}} stats
   */
  askStats(ref, stats) {
    if (this.settled) return;
    const tokens = Number.isFinite(stats.tokens) ? Math.max(0, Math.floor(stats.tokens)) : 0;
    if (tokens > 0) {
      this.spentTokens += tokens;
      this.journal.updateRunUsage(this.runId, this.spentTokens);
      this.record({ type: 'usage-updated', spentTokens: this.spentTokens });
    }
    const node = this.journal.getNode(this.runId, ref.siteId, ref.ordinal);
    if (node !== undefined) {
      this.journal.putNode({
        ...node,
        ...(stats.turns === undefined ? {} : { turn: stats.turns }),
        ...(stats.toolCalls === undefined ? {} : { toolCalls: stats.toolCalls }),
        ...(tokens === 0 ? {} : { stats: { tokens } }),
      });
    }
  }

  /**
   * @param {NodeRef} ref
   * @param {object} progress
   */
  askProgress(ref, progress) {
    if (this.settled) return;
    this.record({ type: 'node-progress', instance: ref, ...progress });
  }

  /* ---------------- 收尾 ---------------- */

  /**
   * 脚本完成（`settleCompleted`）。
   * @param {unknown} result
   */
  complete(result) {
    if (this.settled) return;
    this.markSettled();
    this.scheduler.abortInFlight(new WorkflowError('Cancelled', 'Run completed; in-flight subagent tasks were abandoned.'), true);
    this.finish('completed', { result });
    this.settleDeferred.resolve({ status: 'completed', value: result });
  }

  /**
   * 被停止（`settleStopped`）。
   * @param {'user'|'model'|'provider'|'interrupted'|'superseded'} stopReason
   * @param {WorkflowError | undefined} failure
   * @param {string} [supersededBy]
   */
  stop(stopReason, failure, supersededBy) {
    if (this.settled) return;
    this.markSettled(failure);
    this.scheduler.abortInFlight(new WorkflowError('Cancelled', 'Run stopped.'), true);
    for (const hole of this.holes.values()) hole.deferred.reject(new WorkflowError('Cancelled', 'Run stopped.'));
    this.holes.clear();
    this.finish('stopped', {
      stopReason,
      ...(supersededBy === undefined ? {} : { supersededBy }),
      ...(failure === undefined ? {} : { failure: failure.toJSON() }),
    });
    this.settleDeferred.resolve({
      status: 'stopped',
      reason: stopReason,
      ...(supersededBy === undefined ? {} : { supersededBy }),
      ...(failure === undefined ? {} : { error: failure }),
    });
  }

  /**
   * 失败（`settleFailed`）：脚本错误 / caps / 驱动错误。
   * @param {WorkflowError | Error} error
   */
  fail(error) {
    if (this.settled) return;
    const wrapped = error instanceof WorkflowError
      ? error
      : new WorkflowError('DriverError', error instanceof Error ? error.message : String(error));
    this.markSettled(wrapped);
    this.scheduler.abortInFlight(wrapped, false);
    for (const hole of this.holes.values()) hole.deferred.reject(wrapped);
    this.holes.clear();
    this.finish('errored', { failure: wrapped.toJSON() });
    this.settleDeferred.resolve({ status: 'errored', error: wrapped });
  }

  /**
   * 写 journal 终态 + `run-settled` 事件（`finishRun`）。
   * @param {'completed'|'stopped'|'errored'} status
   * @param {object} info
   */
  finish(status, info) {
    try {
      this.journal.updateRunStatus(this.runId, status, info);
    } catch (error) {
      this.driver.logger?.warn?.(`zcode-workflow: could not persist run status: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.record({
      type: 'run-settled',
      status,
      ...(info.stopReason === undefined ? {} : { stopReason: info.stopReason }),
      ...(info.supersededBy === undefined ? {} : { supersededBy: info.supersededBy }),
      ...(info.failure === undefined ? {} : { error: info.failure }),
    });
    this.driver.dispose?.();
  }

  /**
   * @param {WorkflowError} [failure]
   */
  markSettled(failure) {
    this.settled = true;
    if (failure !== undefined) this.failure = failure;
  }

  /** @returns {WorkflowError} */
  runError() {
    return this.failure ?? new WorkflowError('Cancelled', 'Run already settled.');
  }

  /**
   * @param {string} what
   */
  assertRunning(what) {
    if (this.settled) throw this.runError();
    void what;
  }

  /**
   * 产物占用判定（`$Fa`）：kind 冲突、primary 冲突、id 上限、版本上限。
   * @param {string} id
   * @param {string} op
   * @param {boolean} primary
   * @returns {WorkflowError | undefined}
   */
  admitArtifact(id, op, primary) {
    const existing = this.artifacts.get(id);
    if (existing !== undefined && existing.kind !== op) {
      return new WorkflowError('ArtifactKindMismatch', `Artifact id "${id}" is already a ${existing.kind} and cannot be published as a ${op}. An id belongs to one artifact kind for the whole run (publishing the same id again creates a new version, and a version cannot change what it is); use a different id.`);
    }
    const conflict = primaryConflict(this.primaryArtifactId(), id, primary, `publish "${id}" without primary`, undefined);
    if (conflict !== undefined) return conflict;
    if (existing === undefined && this.artifacts.size >= ARTIFACT_CAPS.maxArtifactsPerRun) {
      return new WorkflowError('ArtifactCapExceeded', `Cannot publish "${id}": this run already has ${ARTIFACT_CAPS.maxArtifactsPerRun} artifact ids, the maximum. Publish a new version of an existing id instead.`);
    }
    if (existing !== undefined && (existing.versions ?? 0) >= ARTIFACT_CAPS.maxVersionsPerArtifact) {
      return new WorkflowError('ArtifactVersionCapExceeded', `Artifact "${id}" already has ${existing.versions} versions, the maximum of ${ARTIFACT_CAPS.maxVersionsPerArtifact}. Publish the final content in fewer versions.`);
    }
    return undefined;
  }

  /** @returns {string | undefined} */
  primaryArtifactId() {
    for (const [id, record] of this.artifacts.entries()) if (record.primary === true) return id;
    return undefined;
  }

  /**
   * 重放结算顺序的挂钩。
   *
   * ZCode 用 `ReplaySettleOrder` 保证重放节点按录制顺序结算（避免并发重放打乱 UI 顺序）。
   * 本移植没有跨 run 的导入缓存，续跑时已完成的节点直接按 journal 顺序回放即可，
   * 因此这里退化成「立刻放行」；接口保留，dev-host 若要精确顺序可替换。
   *
   * @param {NodeRef} ref
   * @param {() => void} run
   */
  holdForReplay(ref, run) {
    void ref;
    run();
  }

  /**
   * 产物失败：落失败节点 + `artifact-failed`，返回要抛出的错误。
   * @param {NodeRef} ref
   * @param {string} hash
   * @param {{id: string, op: string}} info
   * @param {WorkflowError} error
   * @returns {WorkflowError}
   */
  failArtifact(ref, hash, info, error) {
    const serialized = error.toJSON();
    this.journal.putNode({
      runId: this.runId, siteId: ref.siteId, ordinal: ref.ordinal, kind: 'artifact', inputHash: hash, status: 'failed', error: serialized, artifactId: info.id,
    });
    this.record({ type: 'artifact-failed', instance: ref, id: info.id, op: info.op, error: serialized });
    return error;
  }

  /**
   * 首个 world.run 关闭 amend 导入缓存（`F2n`）。
   * @param {NodeRef} ref
   * @param {string} cause
   */
  closeImportCache(ref, cause) {
    if (this.importClosed === true) return;
    this.importClosed = true;
    this.record({ type: 'import-cache-closed', instance: ref, cause });
  }

  /**
   * 从 journal 恢复产物记录（`_4o`）。
   * @param {string | undefined} id
   * @param {object | undefined} result
   */
  rememberArtifactRow(id, result) {
    if (typeof id !== 'string' || id === '' || result === undefined || result?.kind === undefined) return;
    const existing = this.artifacts.get(id);
    this.artifacts.set(id, {
      kind: result.kind,
      ...(result.spec === undefined ? (existing?.spec === undefined ? {} : { spec: existing.spec }) : { spec: safeJson(result.spec) }),
      versions: (existing?.versions ?? 0) + 1,
      ...(result.primary === true || existing?.primary === true ? { primary: true } : {}),
      items: existing?.items ?? 0,
    });
  }

  /**
   * @param {NodeRef} ref
   * @param {string} expected
   * @param {string} got
   * @returns {WorkflowError}
   */
  inputHashMismatch(ref, expected, got) {
    return new WorkflowError(
      'InputHashMismatch',
      `Replay hit at ${refToString(ref)} but inputHash differs (expected ${expected}, got ${got}): the script is not deterministic, so the journal cannot be replayed.`,
    );
  }
}

/** 给 WorkflowError 加静态反序列化（journal 里存的是 toJSON 形状）。 */
WorkflowError.fromJSON = (payload) => new WorkflowError(
  payload?.code ?? 'DriverError',
  payload?.message ?? 'unknown error',
  { violations: payload?.violations, finalText: payload?.finalText },
);

/**
 * 事件写入前补 `phaseName`（`stampBirthPhase`）。
 * @param {object} event
 * @param {Map<string, string>} instancePhases
 * @returns {object}
 */
function stampBirthPhase(event, instancePhases) {
  const withPhase = (instance) => instancePhases.get(`${instance?.siteId}@${instance?.ordinal}`);
  if (event.type === 'actor-created') {
    const phaseName = withPhase(event.actor);
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === 'node-queued') {
    const phaseName = withPhase(event.instance);
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === 'node-dispatched' && event.actor !== undefined) {
    const phaseName = withPhase(event.instance);
    const actorPhaseName = withPhase(event.actor);
    return {
      ...event,
      ...(phaseName === undefined ? {} : { phaseName }),
      ...(actorPhaseName === undefined ? {} : { actorPhaseName }),
    };
  }
  if (event.type === 'node-settled' && event.cached === true) {
    const phaseName = withPhase(event.instance);
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === 'hole-reached') {
    const phaseName = withPhase(event.instance);
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  return event;
}

/**
 * `run-launched` 载荷（`runLaunchedEvent`）。
 * @param {object} launch
 * @returns {object}
 */
function runLaunchedEvent(launch) {
  return {
    type: 'run-launched',
    inputId: launch.inputId ?? launch.runId,
    ...(launch.toolCallId === undefined ? {} : { toolCallId: launch.toolCallId }),
    ...(launch.parentSessionId === undefined ? {} : { parentSessionId: launch.parentSessionId }),
    ...(launch.phaseNames === undefined ? {} : { phaseNames: launch.phaseNames }),
    ...(launch.subagentModel === undefined ? {} : { subagentModel: launch.subagentModel }),
    ...(launch.scriptPath === undefined ? {} : { scriptPath: launch.scriptPath }),
    ...(launch.holes === undefined ? {} : { holes: launch.holes }),
  };
}

/** `siteId@ordinal`。 */
function refToString(ref) {
  return `${ref.siteId}@${ref.ordinal}`;
}

/**
 * `Uoe.summary`：一行概览（契约 §1.5，截 400）。快照与 `GetWorkflowRun` 共用这一份实现。
 * @param {object} run `getRun()` 的返回或同形快照
 * @returns {string}
 */
export function summarizeRun(run) {
  const usage = run?.usage ?? {};
  const spent = Number(usage.spentTokens ?? run?.spentTokens ?? 0);
  const waiting = (Array.isArray(run?.pendingQuestions) ? run.pendingQuestions.length : 0)
    + (Array.isArray(run?.holes) ? run.holes.filter((hole) => hole.state === 'waiting').length : 0);
  const text = `${run?.name ?? run?.label ?? run?.runId ?? run?.id ?? 'run'} — ${run?.status ?? 'unknown'}`
    + `${spent === 0 ? '' : `, ${spent} tokens`}`
    + `, ${Number(usage.nodesCompleted ?? 0)}/${Number(usage.nodesObserved ?? 0)} nodes completed`
    + `${waiting === 0 ? '' : `, ${waiting} waiting on you`}`;
  return preview(text, MAX_RUN_SUMMARY);
}

/**
 * `max_concurrency` 规范化（`normalizeRunConcurrency = max(1, floor(x))`，契约 cli.md:960）。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeConcurrency(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/**
 * 脚本失败的终态分类（评审 M11）：
 * - 错误码 `Interrupted`（进程/沙箱退出）→ `stopped/interrupted`（可续跑）；
 * - provider 侧错误（认证/配额/模型不可用/限流）→ `stopped/provider`（解决原因后 resume）；
 * - 其余才是 `errored`（脚本自身的问题，只能 amend）。
 * @param {object} engine
 * @param {Error | WorkflowError} error
 */
function settleScriptFailure(engine, error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'Interrupted' || /interrupted|sandbox.*(exit|died)/iu.test(error?.message ?? '')) {
    engine.stop('interrupted', error instanceof WorkflowError ? error : new WorkflowError('Interrupted', error?.message ?? 'interrupted'));
    return;
  }
  const providerish = error?.providerStop !== undefined
    || PROVIDER_ERROR_CODES.has(code)
    || /provider|rate.?limit|quota|sign.?in|not configured|model.*unavailable/iu.test(`${code} ${error?.message ?? ''}`);
  if (providerish) {
    engine.stop('provider', error instanceof WorkflowError ? error : new WorkflowError(code || 'ProviderError', error?.message ?? 'provider error'));
    return;
  }
  engine.fail(error instanceof Error ? error : new Error(String(error)));
}

/**
 * persona 规范化（`normalizePersona`）。
 * @param {string | undefined} name
 * @param {string | object | undefined} persona
 * @returns {{name?: string, system?: string, model?: string}}
 */
function normalizePersona(name, persona) {
  const record = {};
  if (typeof persona === 'string') record.system = persona;
  else if (persona !== null && typeof persona === 'object') {
    if (typeof persona.name === 'string') record.name = persona.name;
    if (typeof persona.system === 'string') record.system = persona.system;
    if (typeof persona.model === 'string') record.model = persona.model;
  }
  if (record.name === undefined && typeof name === 'string' && name !== '') record.name = name;
  return record;
}

/**
 * primary 冲突判定（`N2n`/`Bkt`）。
 * @param {string | undefined} currentPrimary
 * @param {string} id
 * @param {boolean} wantsPrimary
 * @param {string} advice
 * @param {NodeRef | undefined} ref
 * @returns {WorkflowError | undefined}
 */
function primaryConflict(currentPrimary, id, wantsPrimary, advice, ref) {
  if (!wantsPrimary || currentPrimary === undefined || currentPrimary === id) return undefined;
  const at = ref === undefined ? '' : ` (at ${refToString(ref)})`;
  return new WorkflowError(
    'ArtifactPrimaryConflict',
    `Cannot mark "${id}" as primary${at}: "${currentPrimary}" is already this run's primary artifact. A run has one deliverable; ${advice}, or publish it as a new version of "${currentPrimary}".`,
  );
}

/**
 * preset 规格校验（`validateArtifactSpec`，逐字文案见各分支）。
 *
 * @param {string} op
 * @param {unknown} spec
 * @returns {string | undefined}
 */
export function validateArtifactSpec(op, spec) {
  const isPlain = spec !== null && typeof spec === 'object' && !Array.isArray(spec);
  if (!isPlain) return `${op} spec must be an object literal, got ${describeValue(spec)}`;
  const options = checkSpecOptions(spec);
  if (options !== undefined) return options;
  const checkField = (field, at) => {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) return `spec ${at} must be { field: "…" }, got ${describeValue(field)}`;
    if (typeof field.field !== 'string' || field.field.trim() === '') return `spec ${at}.field must be a non-empty string (a dot path into the item, e.g. "timing.after")`;
    for (const key of ['label', 'unit']) {
      if (field[key] !== undefined && typeof field[key] !== 'string') return `spec ${at}.${key} must be a string, got ${describeValue(field[key])}`;
    }
    return undefined;
  };
  const checkFieldList = (list, at) => {
    if (!Array.isArray(list) || list.length === 0) return `spec ${at} must be a non-empty array of fields ({ field: "…" })`;
    for (const [index, field] of list.entries()) {
      const problem = checkField(field, `${at}[${index}]`);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  if (op === 'chart') {
    const x = checkField(spec.x, 'x');
    if (x !== undefined) return x;
    if (Array.isArray(spec.y)) {
      if (spec.y.length === 0) return 'chart spec y is an empty array; give it at least one series';
      for (const [index, entry] of spec.y.entries()) {
        const problem = checkField(entry, `y[${index}]`);
        if (problem !== undefined) return problem;
      }
    } else {
      const y = checkField(spec.y, 'y');
      if (y !== undefined) return y;
    }
    if (spec.type !== undefined && !['line', 'bar', 'scatter'].includes(String(spec.type))) {
      return `chart spec type must be "line", "bar" or "scatter", got ${describeValue(spec.type)}`;
    }
    if (spec.scale !== undefined && !['linear', 'log'].includes(String(spec.scale))) {
      return `chart spec scale must be "linear" or "log", got ${describeValue(spec.scale)}`;
    }
    if (spec.baseline !== undefined) {
      const baseline = checkField(spec.baseline, 'baseline');
      if (baseline !== undefined) return baseline;
    }
    return undefined;
  }
  if (op === 'table') {
    const columns = checkFieldList(spec.columns, 'columns');
    if (columns !== undefined) return columns;
    if (spec.key !== undefined && !isNonEmptyString(spec.key)) return 'table spec key must be a non-empty string (the field that identifies a row)';
    return undefined;
  }
  if (op === 'metrics') return checkFieldList(spec.metrics, 'metrics');
  if (!isNonEmptyString(spec.key)) return 'board spec key must be a non-empty string (the field that identifies a card)';
  if (!isNonEmptyString(spec.status)) return 'board spec status must be a non-empty string (the field that picks a card\'s column)';
  if (!Array.isArray(spec.columns) || spec.columns.length === 0) return 'board spec columns must be a non-empty array of strings (the column order)';
  for (const [index, column] of spec.columns.entries()) {
    if (!isNonEmptyString(column)) return `board spec columns[${index}] must be a non-empty string`;
  }
  if (spec.cardTitle !== undefined && !isNonEmptyString(spec.cardTitle)) return 'board spec cardTitle must be a non-empty string (the field used as the card title)';
  if (spec.detail !== undefined) return checkFieldList(spec.detail, 'detail');
  return undefined;
}

/**
 * @param {object} spec
 * @returns {string | undefined}
 */
function checkSpecOptions(spec) {
  if (spec.title !== undefined) {
    if (typeof spec.title !== 'string') return `spec title must be a string, got ${describeValue(spec.title)}`;
    if (spec.title.length > ARTIFACT_CAPS.maxTitleLength) return `spec title is ${spec.title.length} characters, over the ${ARTIFACT_CAPS.maxTitleLength} limit`;
  }
  if (spec.description !== undefined) {
    if (typeof spec.description !== 'string') return `spec description must be a string, got ${describeValue(spec.description)}`;
    if (spec.description.length > ARTIFACT_CAPS.maxDescriptionLength) return `spec description is ${spec.description.length} characters, over the ${ARTIFACT_CAPS.maxDescriptionLength} limit`;
  }
  if (spec.primary !== undefined && typeof spec.primary !== 'boolean') return `spec primary must be a boolean, got ${describeValue(spec.primary)}`;
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * world 节点的入参留档（`boundWorldReadInput`）：整体 ≤4096 字节，否则前 8 个实参各截 400 字符。
 * @param {string} op
 * @param {unknown[]} args
 * @returns {object}
 */
function boundWorldReadInput(op, args) {
  const candidate = { op, args: [...args] };
  try {
    const text = JSON.stringify(candidate);
    if (text !== undefined && utf8Length(text) <= ASK_BUDGET.instructionsHead) return candidate;
  } catch {
    // 落下面的截断形态
  }
  return { op, args: args.slice(0, 8).map((arg) => preview(safeJson(arg), 400)), truncated: true };
}

/**
 * 单 actor 的调度状态 + 全局 slot 计数 + AIMD。
 *
 * 这是引擎最容易写错的部分，所以独立成类：
 * - `admitAsk` 把 ask 放进该 actor 的 FIFO，节点立即进 journal（queued）；
 * - `pumpActor` 受 `actor.current`（每 actor 串行）与全局 `activeAsks < caps.maxConcurrency` 双约束；
 * - `dispatch` 建/复用会话后发 `node-dispatched`，再把 work 交给 driver 的回合循环；
 * - 结算统一走 `settleOk`/`settleFailed`，并递减计数、唤醒下一轮 pump。
 */
class AskScheduler {
  /** @param {WorkflowEngine} engine */
  constructor(engine) {
    this.engine = engine;
    /** @type {Map<string, object>} */
    this.actors = new Map();
    /** @type {object[]} */
    this.actorOrder = [];
    /** @type {Map<string, object>} */
    this.liveNodes = new Map();
    this.activeAsks = 0;
    this.importClosed = false;
  }

  get journal() {
    return this.engine.journal;
  }

  get host() {
    return this.engine;
  }

  /** @param {NodeRef} ref */
  hasActor(ref) {
    return this.actors.has(refToString(ref));
  }

  /**
   * @param {NodeRef} ref
   * @param {string} id
   * @param {string | undefined} name
   * @param {object} persona
   */
  registerActor(ref, id, name, persona) {
    const actor = {
      ref,
      id,
      persona,
      name,
      current: undefined,
      liveQueue: [],
      sessionPromise: undefined,
      session: undefined,
      history: [],
      escalations: new Map(),
      escalationsUsed: 0,
      escalationSeq: 0,
    };
    this.actors.set(id, actor);
    this.actorOrder.push(actor);
    return actor;
  }

  /**
   * 收下一个 ask（原实现 `admitAsk` 的现场路径）。
   *
   * @param {string} siteId
   * @param {NodeRef} actorRef
   * @param {string} instructions
   * @param {object} spec
   * @returns {Promise<unknown>}
   */
  admitAsk(siteId, actorRef, instructions, spec) {
    const actor = this.actors.get(refToString(actorRef));
    if (actor === undefined) return Promise.reject(new WorkflowError('UnknownActor', `Unknown subagent handle: ${refToString(actorRef)}.`));
    const ordinal = this.engine.nextOrdinal(siteId);
    const ref = { siteId, ordinal };
    const hash = inputHash({ actor: refToString(actorRef), instructions, typed: spec.typed === true, schema: spec.schema ?? null });
    const existing = this.journal.getNode(this.engine.runId, siteId, ordinal);
    if (existing !== undefined) {
      if (existing.inputHash !== hash) {
        const error = this.engine.inputHashMismatch(ref, existing.inputHash, hash);
        this.engine.fail(error);
        return Promise.reject(error);
      }
      if (existing.status === 'completed') {
        // 重放命中：不再花钱，按原结果结算（cached）。
        const deferred = Promise.withResolvers();
        this.engine.holdForReplay(ref, () => {
          this.engine.record({ type: 'node-settled', instance: ref, outcome: 'ok', cached: true });
          deferred.resolve(existing.result);
        });
        return deferred.promise;
      }
      if (existing.status === 'failed') {
        this.engine.record({ type: 'node-settled', instance: ref, outcome: 'failed', cached: true, error: existing.error });
        return Promise.reject(WorkflowError.fromJSON(existing.error));
      }
    }
    const deferred = Promise.withResolvers();
    const node = {
      instance: ref,
      actor,
      actorSeq: actor.liveQueue.length + (actor.current === undefined ? 0 : 1),
      instructions,
      hash,
      spec,
      deferred,
      repairsRemaining: ASK_BUDGET.repairs,
      nudgesRemaining: ASK_BUDGET.nudges,
      settled: false,
      dispatched: false,
    };
    this.liveNodes.set(refToString(ref), node);
    this.journal.putNode({
      runId: this.engine.runId,
      siteId,
      ordinal,
      kind: 'ask',
      actorSiteId: actorRef.siteId,
      actorOrdinal: actorRef.ordinal,
      actorSeq: node.actorSeq,
      inputHash: hash,
      status: 'running',
    });
    actor.liveQueue.push(node);
    this.setNodePhase(node, 'queued');
    this.engine.record({
      type: 'node-queued',
      instance: ref,
      kind: 'ask',
      actor: actorRef,
      actorSeq: node.actorSeq,
      ...(instructions.trim() === '' ? {} : { instructionsHead: preview(instructions.trim(), RUNTIME_CAPS.maxInstructionsHeadLength) }),
    });
    this.pumpAll();
    return deferred.promise;
  }

  /** 遍历所有 actor 尝试派发。 */
  pumpAll() {
    for (const actor of this.actorOrder) this.pumpActor(actor);
  }

  /** @param {object} actor */
  pumpActor(actor) {
    const engine = this.engine;
    if (engine.settled || actor.current !== undefined || actor.liveQueue.length === 0) return;
    if (this.activeAsks >= engine.caps.maxConcurrency || !engine.concurrency.canAdmit(engine.now())) {
      // 被 slot/冷却挡住：把该 actor 队首的节点标成 waiting（`cause:"slot"`，评审 M3）。
      const blocked = actor.liveQueue[0];
      if (blocked !== undefined && blocked.waiting !== true) {
        blocked.waiting = true;
        this.setNodePhase(blocked, 'waiting', { wait: { cause: 'slot' } });
        engine.record({ type: 'node-waiting', instance: blocked.instance, cause: 'slot' });
      }
      return;
    }
    const node = actor.liveQueue.shift();
    actor.current = node;
    this.activeAsks += 1;
    void this.dispatch(node);
  }

  /** @param {object} node */
  async dispatch(node) {
    const engine = this.engine;
    const changes = engine.concurrency.noteWaiters(engine.now(), this.activeAsks);
    for (const change of changes) engine.record({ type: 'concurrency-changed', ...change });
    node.epoch = engine.concurrency.admitted(engine.now());
    let session;
    try {
      session = await this.ensureSession(node.actor);
    } catch (error) {
      if (engine.settled || node.settled) return;
      this.settleFailed(node, new WorkflowError('DriverError', `Failed to create the subagent session: ${describeCause(error)}`));
      return;
    }
    if (engine.settled || node.settled) return;
    engine.record({
      type: 'node-dispatched',
      instance: node.instance,
      kind: 'ask',
      actor: node.actor.ref,
      ...(node.actor.name === undefined ? {} : { actorName: node.actor.name }),
      ...(node.actor.persona.model === undefined ? {} : { actorPersonaModel: node.actor.persona.model }),
      ...(node.instructions.trim() === '' ? {} : { instructionsHead: preview(node.instructions.trim(), RUNTIME_CAPS.maxInstructionsHeadLength) }),
    });
    node.dispatched = true;
    node.waiting = false;
    this.setNodePhase(node, 'dispatched', { wait: undefined });
    this.engine.noteProgress();
    try {
      await this.driverRunAsk(node, session);
    } catch (error) {
      if (!node.settled) this.settleFailed(node, error instanceof WorkflowError ? error : new WorkflowError('DriverError', describeCause(error)));
    }
  }

  /**
   * 一次 ask 的回合循环（直接映射原实现的 turn/submit/repair/nudge）。
   *
   * 与原实现的结构对应：
   *   - 一回合结束且未被 accept → turnEnded：untyped 直接成功；typed 还有 nudge 就再跑一回合。
   *   - 回合里交上来的值 → submitAttempted：校验失败还有 repair 就带着 violations 再跑一回合。
   * @param {object} node
   * @param {object} session
   */
  async driverRunAsk(node, session) {
    const engine = this.engine;
    const spec = node.spec;
    // 每个 ask 重置升级预算（原实现 startAsk 里 escalationsUsed = 0）。
    node.actor.escalationsUsed = 0;
    let finalText = '';
    let turns = 0;
    let toolCalls = 0;
    let escalationRounds = 0;
    for (;;) {
      if (engine.settled || node.settled) return;
      // 回合开始：executing（评审 M3：queued→dispatched→executing 全程落 journal）。
      this.setNodePhase(node, 'executing');
      engine.record({ type: 'node-executing', instance: node.instance });
      const turn = await session.runTurn(this.buildPrompt(node), node);
      turns += 1;
      toolCalls += turn.toolCalls ?? 0;
      finalText = turn.text ?? '';
      engine.askStats(node.instance, { tokens: turn.tokens ?? 0, turns, toolCalls });
      engine.askProgress(node.instance, { turn: turns, toolCalls });
      this.setNodePhase(node, 'executing', { turn: turns, toolCalls });

      // 升级提问（B3 的回复标记协议）：回复里出现 ```json {"escalate":{…}} ``` 就挂起该 ask，
      // 主代理用 ResolveWorkflowQuestion 回答；答案（message）作为下一回合文本回灌。
      if (Array.isArray(turn.escalations) && turn.escalations.length > 0 && escalationRounds < MAX_ESCALATION_ROUNDS) {
        escalationRounds += 1;
        const marker = turn.escalations[0];
        this.setNodePhase(node, 'waiting', { wait: { cause: 'question' } });
        engine.record({ type: 'node-waiting', instance: node.instance, cause: 'question' });
        const answer = await engine.driver.raiseQuestion(node.actor, node.instance, marker);
        session.answer = typeof answer?.message === 'string' ? answer.message : ESCALATION_BUDGET_EXHAUSTED;
        continue;
      }

      const submit = turn.value;
      const hasSubmit = turn.submitted === true || submit !== undefined;
      if (!spec.typed) {
        // untyped ask：最终回复文本就是结果；带了结构化值也接受。
        this.settleOk(node, hasSubmit ? submit : finalText);
        return;
      }
      if (hasSubmit) {
        const normalized = normalizeSubmit(submit, spec.schema);
        if (normalized.violations.length === 0) {
          this.settleOk(node, normalized.value);
          return;
        }
        if (node.repairsRemaining > 0) {
          node.repairsRemaining -= 1;
          const attempt = ASK_BUDGET.repairs - node.repairsRemaining;
          this.setNodePhase(node, 'repairing', { outcome: undefined, violations: normalized.violations });
          engine.record({
            type: 'node-repairing',
            instance: node.instance,
            attempt,
            violations: normalized.violations,
          });
          session.repairNotice = `${SUBMIT_VIOLATIONS_HEADER}\n${formatViolations(normalized.violations)}`;
          continue;
        }
        this.settleFailed(node, new WorkflowError(
          'ValidationFailed',
          'The reply never matched the required schema and the repair budget is exhausted.',
          { violations: normalized.violations },
        ));
        return;
      }
      // typed ask 没给结果：还有 nudge 预算就催一回合，否则失败。
      if (node.nudgesRemaining > 0) {
        node.nudgesRemaining -= 1;
        this.setNodePhase(node, 'nudged');
        engine.record({ type: 'node-nudged', instance: node.instance });
        session.nudge = true;
        continue;
      }
      this.settleFailed(node, new WorkflowError(
        'ResultNotSubmitted',
        'The typed ask ended without a reply carrying the result, so there is no result.',
        { finalText },
      ));
      return;
    }
  }

  /**
   * 把节点的 `phase`（+附加字段）写回 journal。评审 M3：节点行必须带 phase，快照直接读它。
   * @param {object} node
   * @param {string} phase
   * @param {object} [extra]
   */
  setNodePhase(node, phase, extra = {}) {
    const { siteId, ordinal } = node.instance;
    const row = this.journal.getNode(this.engine.runId, siteId, ordinal);
    const base = row ?? {
      runId: this.engine.runId,
      siteId,
      ordinal,
      kind: 'ask',
      actorSiteId: node.actor.ref.siteId,
      actorOrdinal: node.actor.ref.ordinal,
      inputHash: node.hash,
      status: 'running',
    };
    const next = { ...base, phase, ...extra };
    if (extra.outcome === undefined && phase !== 'settled') delete next.outcome;
    if (base.phase === 'settled') return; // 已结算的节点不再改状态
    this.journal.putNode(next);
  }

  /** 当前排队等 slot 的 ask 数（AIMD 的 waiters 语义，评审 M2）。 */
  queuedCount() {
    let total = 0;
    for (const actor of this.actorOrder) total += actor.liveQueue.length;
    return total;
  }

  /**
   * @param {object} node
   * @returns {object}
   */
  buildPrompt(node) {
    const actor = node.actor;
    const spec = node.spec;
    return {
      actor: {
        name: actor.name,
        persona: actor.persona.system,
        model: actor.persona.model,
        sessionId: actor.session?.id,
      },
      instructions: node.instructions,
      typed: spec.typed === true,
      schema: spec.schema,
      history: actor.history,
      repairNotice: actor.session?.repairNotice,
      nudge: actor.session?.nudge === true,
      answer: actor.session?.answer,
      system: buildWorkflowActorIdentity({ name: actor.name, persona: actor.persona.system }),
    };
  }

  /**
   * 建/复用会话（`ensureSession`）：同名 actor 复用同一会话，journal 记 `sessionId`。
   * @param {object} actor
   * @returns {Promise<object>}
   */
  ensureSession(actor) {
    if (actor.sessionPromise !== undefined) return actor.sessionPromise;
    const sessionId = mintActorSessionId(this.engine.runId, actor.ref);
    const journaled = this.journal.getActor(this.engine.runId, actor.ref.siteId, actor.ref.ordinal);
    const promise = this.engine.driver.createActorSession(actor, sessionId, journaled?.sessionId)
      .then((session) => {
        actor.session = session;
        this.journal.putActor({
          runId: this.engine.runId,
          siteId: actor.ref.siteId,
          ordinal: actor.ref.ordinal,
          ...(actor.name === undefined ? {} : { name: actor.name }),
          persona: actor.persona,
          sessionId: session.id,
          status: 'running',
          ...(actor.persona.model === undefined ? {} : { model: actor.persona.model }),
        });
        return session;
      });
    actor.sessionPromise = promise;
    return promise;
  }

  /**
   * @param {object} node
   * @param {unknown} value
   */
  settleOk(node, value) {
    if (node.settled) return;
    node.settled = true;
    const actor = node.actor;
    // actor 的跨 ask 上下文：记录本次问答（DSH 侧每回合是一次 activation，见文件头偏差 2）。
    actor.history.push({
      ask: node.instructions,
      answer: typeof value === 'string' ? value : safeJson(value),
    });
    if (actor.history.length > 8) actor.history.splice(0, actor.history.length - 8);
    this.journal.putNode({
      runId: this.engine.runId,
      siteId: node.instance.siteId,
      ordinal: node.instance.ordinal,
      kind: 'ask',
      actorSiteId: actor.ref.siteId,
      actorOrdinal: actor.ref.ordinal,
      actorSeq: node.actorSeq,
      inputHash: node.hash,
      status: 'completed',
      result: value,
    });
    this.engine.record({ type: 'node-settled', instance: node.instance, outcome: 'ok' });
    this.setNodePhase(node, 'settled', { outcome: 'ok', status: 'completed' });
    this.finishLiveNode(node, 'ok');
    node.deferred.resolve(value);
  }

  /**
   * @param {object} node
   * @param {WorkflowError} error
   */
  settleFailed(node, error) {
    if (node.settled) return;
    node.settled = true;
    const actor = node.actor;
    this.journal.putNode({
      runId: this.engine.runId,
      siteId: node.instance.siteId,
      ordinal: node.instance.ordinal,
      kind: 'ask',
      actorSiteId: actor.ref.siteId,
      actorOrdinal: actor.ref.ordinal,
      actorSeq: node.actorSeq,
      inputHash: node.hash,
      status: 'failed',
      error: error.toJSON(),
    });
    this.engine.record({ type: 'node-settled', instance: node.instance, outcome: 'failed', error: error.toJSON() });
    this.setNodePhase(node, 'settled', { outcome: 'failed', status: 'failed' });
    // provider 侧的限流/配额失败走 throttled（收缩 + 冷却），其余失败走 failedTransient
    // （只减 inFlight，不奖励增长）。评审 M2：失败绝不能算成功。
    const throttled = error?.providerStop !== undefined
      || PROVIDER_ERROR_CODES.has(error?.code)
      || /throttl|rate.?limit|quota/i.test(error?.message ?? '');
    this.finishLiveNode(node, throttled ? 'throttled' : 'failed', error);
    node.deferred.reject(error);
  }

  /**
   * @param {object} node
   * @param {'ok'|'failed'|'throttled'} outcome
   * @param {WorkflowError} [error]
   */
  finishLiveNode(node, outcome = 'ok', error) {
    this.liveNodes.delete(refToString(node.instance));
    const actor = node.actor;
    if (actor.current === node) {
      actor.current = undefined;
      this.activeAsks = Math.max(0, this.activeAsks - 1);
      const now = this.engine.now();
      const epoch = node.epoch ?? 0;
      let changes = this.engine.concurrency.noteWaiters(now, this.queuedCount());
      if (outcome === 'ok') changes = changes.concat(this.engine.concurrency.succeeded(now, epoch));
      else if (outcome === 'throttled') changes = changes.concat(this.engine.concurrency.throttled(now, epoch, error?.code ?? 'throttled', error?.retryAfterMs));
      else changes = changes.concat(this.engine.concurrency.failedTransient(now));
      for (const change of changes) this.engine.record({ type: 'concurrency-changed', ...change });
      this.engine.noteProgress();
      // actor 结算后状态是 completed（评审 m7）。
      try {
        this.journal.putActor({
          runId: this.engine.runId,
          siteId: actor.ref.siteId,
          ordinal: actor.ref.ordinal,
          ...(actor.name === undefined ? {} : { name: actor.name }),
          persona: actor.persona,
          ...(actor.session?.id === undefined ? {} : { sessionId: actor.session.id }),
          status: 'completed',
          ...(actor.persona.model === undefined ? {} : { model: actor.persona.model }),
        });
      } catch {
        // actor 行写失败不影响 ask 的结算
      }
    }
    this.pumpAll();
  }

  /**
   * 停止时撤回全部在飞节点（`abortInFlight`）。
   * @param {WorkflowError} error
   * @param {boolean} recordCancelled
   */
  abortInFlight(error, recordCancelled) {
    for (const node of [...this.liveNodes.values()]) {
      if (node.settled) continue;
      node.settled = true;
      if (node.dispatched) this.engine.driver.cancelAsk?.(node.instance);
      if (recordCancelled) this.engine.record({ type: 'node-settled', instance: node.instance, outcome: 'cancelled' });
      node.deferred.reject(error);
      this.settleActorEscalations(node.actor);
    }
    this.liveNodes.clear();
    this.activeAsks = 0;
  }

  /**
   * 撤回该 actor 挂起的升级提问（`withdrawEscalations`）。
   * @param {object} actor
   */
  settleActorEscalations(actor) {
    for (const [qid, deferred] of actor.escalations.entries()) {
      actor.escalations.delete(qid);
      this.engine.driver.pendingQuestions.delete(qid);
      deferred.reject(new WorkflowError('Cancelled', `Escalation ${qid} was cancelled along with its ask.`));
    }
  }
}

/**
 * 构造 run 的 driver：会话、world 读取、产物发布、提问通道、事件出口。
 *
 * driver 是引擎与宿主能力（subagent / workspace / artifact store）之间唯一的桥，
 * 这样引擎可以只用假 driver 做单测。
 *
 * @param {object} options
 * @param {string} options.runId
 * @param {string} options.cwd
 * @param {object} options.journal
 * @param {object | undefined} options.workspace
 * @param {object | undefined} options.artifacts
 * @param {(request: object) => Promise<object>} options.runner 子代理执行器
 * @param {(text: string) => void} [options.notify]
 * @param {(event: object) => void} [options.onEvent]
 * @param {object} [options.logger]
 * @param {AbortSignal} [options.signal]
 * @param {string[]} [options.phaseNames]
 * @returns {object}
 */
function createDriver({
  runId, cwd, journal, workspace, artifacts, runner, notify, onEvent, logger, signal, phaseNames = [],
}) {
  const pendingQuestions = new Map();
  const resolvedQuestions = new Set();
  const questionRuns = new Map();
  const liveAsks = new Map();
  /** @type {object | undefined} 供 session.runTurn 反查 driver 方法（return 前赋值）。 */
  let driverRef;
  const driver = {
    logger,
    phaseNames,
    pendingQuestions,
    resolvedQuestions,
    questionRuns,
    emit(event) {
      onEvent?.(event);
    },
    /**
     * 建 actor 会话：一个 actor 一个会话对象；`sessionId` 由引擎铸造。
     * @param {object} actor
     * @param {string} sessionId
     * @param {string | undefined} journaledSessionId
     * @returns {Promise<object>}
     */
    async createActorSession(actor, sessionId, journaledSessionId) {
      if (journaledSessionId !== undefined && journaledSessionId !== sessionId) {
        throw new WorkflowError('DriverError', `Subagent session identity mismatch for ${refToString(actor.ref)}: the journaled session id and the minted one differ.`);
      }
      const session = {
        id: sessionId,
        actor,
        lastValue: undefined,
        lastText: '',
        repairNotice: undefined,
        nudge: false,
        /**
         * 跑一个回合。DSH 的 activation 是一次性的，所以“会话”体现在提示词里的历史。
         * @param {object} prompt
         * @param {object} node
         * @returns {Promise<{text: string, value?: unknown, submitted?: boolean, tokens?: number, toolCalls?: number}>}
         */
        async runTurn(prompt, node) {
          const controller = new AbortController();
          const abort = () => controller.abort(signal?.reason);
          if (signal?.aborted) abort();
          signal?.addEventListener('abort', abort, { once: true });
          liveAsks.set(refToString(node.instance), controller);
          const timer = undefined; // 没有引擎侧超时（评审 m15）：ask 可以无限等，只有停止/中断能打断
          try {
            const userText = buildTurnPrompt(prompt);
            const answer = await runner({
              runId,
              cwd,
              sessionId: session.id,
              actor: {
                siteId: node.instance.siteId,
                ordinal: node.instance.ordinal,
                name: actor.name,
                persona: actor.persona.system,
                model: actor.persona.model,
              },
              system: prompt.system,
              prompt: userText,
              instructions: node.instructions,
              typed: node.spec.typed === true,
              schema: node.spec.schema,
              signal: controller.signal,
              // 编程式升级通道：DSH 子代理没有回合内工具入口，生产路径走的是下面解析的回复围栏；
              // 这个回调留给宿主自驱的 runner（测试、以及将来支持工具注入的 provider）。
              escalate: (ask) => driverRef.raiseQuestion(actor, node.instance, ask ?? {}),
            });
            const rawText = answer?.text ?? '';
            // B3：回复标记协议——先摘出升级提问围栏块，再按需解析结果 JSON。
            const marker = parseEscalationMarkers(rawText);
            const text = marker.rest;
            const value = answer?.structured !== undefined
              ? answer.structured
              : (node.spec.typed === true ? parseJsonLoose(text) : undefined);
            session.lastText = text;
            session.lastValue = value;
            session.answer = undefined;
            const turn = {
              text,
              value,
              submitted: value !== undefined,
              tokens: answer?.tokens,
              toolCalls: answer?.toolCalls,
              escalations: marker.escalations,
            };
            if (session.nudge) session.nudge = false;
            if (session.repairNotice !== undefined) session.repairNotice = undefined;
            return turn;
          } finally {
            if (timer !== undefined) clearTimeout(timer);
            liveAsks.delete(refToString(node.instance));
            signal?.removeEventListener('abort', abort);
          }
        },
      };
      return session;
    },
    /**
     * 取消一个在飞 ask（`cancelAsk`）：abort 该回合。
     * @param {NodeRef} ref
     */
    cancelAsk(ref) {
      const controller = liveAsks.get(refToString(ref));
      controller?.abort(new Error('workflow ask cancelled'));
    },
    /**
     * world 读取：files/git/world.run 三种来源。
     * @param {string} op
     * @param {unknown[]} args
     * @returns {Promise<unknown>}
     */
    async executeWorldRead(op, args) {
      if (workspace === undefined) {
        throw new WorkflowError('DriverError', `world read "${op}" is unavailable: this host wired no workspace.`);
      }
      const [first, second, third] = args;
      switch (op) {
        case 'glob':
          return workspace.files.glob(String(first));
        case 'read':
          return workspace.files.read(String(first));
        case 'grep':
          return workspace.files.grep(String(first), second === undefined ? undefined : String(second));
        case 'git-changed-files':
          return workspace.git.changedFiles(first === undefined ? undefined : String(first));
        case 'git-diff':
          return workspace.git.diff(first === undefined ? undefined : String(first), second === undefined ? undefined : String(second));
        case 'git-status':
          return workspace.git.status();
        case 'git-log':
          return workspace.git.log(second === undefined ? first : second);
        case 'run': {
          const command = String(first);
          const commandArgs = Array.isArray(second) ? second.map(String) : [];
          const opts = third !== null && typeof third === 'object' ? third : {};
          const result = await workspace.runCommand(command, commandArgs, {
            ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
            ...(opts.output === undefined ? {} : { output: opts.output }),
          });
          return {
            exitCode: result.exitCode,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
          };
        }
        default:
          throw new WorkflowError('DriverError', `unknown world read "${op}"`);
      }
    },
    /**
     * 发布内容产物：交给宿主的 artifact store（`publish`）。
     * @param {object} request
     * @returns {Promise<object>}
     */
    async executeArtifactPublish(request) {
      if (artifacts === undefined || typeof artifacts.publish !== 'function') {
        throw new WorkflowError('ArtifactStoreUnavailable', `artifact.${request.op}: cannot publish "${request.id}" because this assembly has no artifact store.`);
      }
      return artifacts.publish(request);
    },
    /**
     * 注册一个问题（`escalate` 的实现）。
     * @param {object} actor
     * @param {object} instance
     * @param {{question: string, context?: string}} ask
     * @returns {Promise<object>}
     */
    async raiseQuestion(actor, instance, ask) {
      if (actor.escalationsUsed >= ESCALATIONS_PER_ASK) {
        return { status: 'refused', reason: 'budget_exhausted', message: ESCALATION_BUDGET_EXHAUSTED };
      }
      if (pendingQuestions.size >= RUNTIME_CAPS.maxPendingQuestions) {
        return {
          status: 'refused',
          reason: 'too_many_questions',
          message: `This run already has ${RUNTIME_CAPS.maxPendingQuestions} questions waiting for an answer, the maximum. Resolve one before asking another, or proceed on your best judgement.`,
        };
      }
      actor.escalationsUsed += 1;
      actor.escalationSeq += 1;
      const qid = `dwfq-${runId}-${actor.escalationSeq}`;
      const deferred = Promise.withResolvers();
      actor.escalations.set(qid, deferred);
      // The pending question names the *conversation* that asked, not the ask site: the contract's
      // `actorSiteId`/`actorOrdinal` identify the subagent so the reader can open it, and the ask
      // site is already recoverable from the node table.
      const record = {
        qid,
        actorSiteId: actor.ref.siteId,
        actorOrdinal: actor.ref.ordinal,
        ...(actor.name === undefined ? {} : { actorName: actor.name }),
        question: String(ask?.question ?? '').slice(0, RUNTIME_CAPS.maxQuestionLength),
        ...(ask?.context === undefined ? {} : { context: String(ask.context).slice(0, RUNTIME_CAPS.maxQuestionLength) }),
        askedAt: Date.now(),
      };
      pendingQuestions.set(qid, { record, deferred });
      resolvedQuestions.delete(qid);
      questionRuns.set(qid, runId);
      driverRef?.record?.({
        type: 'escalation-raised',
        qid,
        // The projection keys questions by the conversation that raised them, so the event carries
        // the same identity the pending record does.
        actorSiteId: record.actorSiteId,
        actorOrdinal: record.actorOrdinal,
        ...(record.actorName === undefined ? {} : { actorName: record.actorName }),
        question: record.question,
        ...(record.context === undefined ? {} : { context: record.context }),
        askedAt: record.askedAt,
      });
      return deferred.promise;
    },
    /**
     * 解决一个问题（`resolveQuestion`）：答案以 `message` 逐字回灌（评审 M9）。
     * 失败时按 22/23/24 区分：未知 / 已答 / run 已收尾。
     * @param {string} qid
     * @param {string} answer
     * @returns {{ok: true, qid: string, response: string} | {ok: false, code: string, message: string}}
     */
    answerQuestion(qid, answer) {
      const parked = pendingQuestions.get(qid);
      if (parked === undefined) {
        if (resolvedQuestions.has(qid)) {
          return { ok: false, code: 'ALREADY_RESOLVED', message: `Question ${qid} was already answered; the subagent that asked it has resumed.` };
        }
        return { ok: false, code: 'UNKNOWN_QUESTION', message: `No workflow question with ID ${qid} is pending. It may have been answered already, or the run may have settled.` };
      }
      pendingQuestions.delete(qid);
      resolvedQuestions.add(qid);
      driverRef?.record?.({ type: 'escalation-resolved', qid, answer });
      // 回灌对象：字段名是 `message`（契约 Zat），不是 `answer`。
      parked.deferred.resolve({ status: 'answered', message: String(answer ?? ''), qid });
      return { ok: true, qid, response: `Answer delivered for question ${qid}. The subagent that asked has resumed its turn with your answer; the run keeps going as before.` };
    },
    /**
     * 清掉提问通道（run 收尾）。
     */
    dispose() {
      for (const [qid, parked] of pendingQuestions.entries()) {
        parked.deferred.reject(new WorkflowError('Cancelled', `Escalation ${qid} was cancelled along with its run.`));
      }
      pendingQuestions.clear();
      for (const controller of liveAsks.values()) controller.abort(new Error('workflow run settled'));
      liveAsks.clear();
    },
    notify,
    journal,
  };
  driverRef = driver;
  return driver;
}

/**
 * 组装一次 turn 的完整用户提示词：ask 正文 + 质量尾巴 + 提交尾巴，再拼上修复/催促/历史。
 *
 * 为什么修复与催促放在**用户文本**而不是系统提示词：它们只对当前回合有效，
 * 写进 system 会污染 actor 的稳定前缀（缓存与 persona 语义都会被破坏）。
 *
 * @param {object} prompt
 * @returns {string}
 */
function buildTurnPrompt(prompt) {
  const base = buildAskPrompt({
    instructions: prompt.instructions,
    typed: prompt.typed === true,
    schema: prompt.schema,
  });
  if (prompt.repairNotice !== undefined) return `${base}\n\n---\n\n${prompt.repairNotice}`;
  if (prompt.nudge === true) return `${base}\n\n---\n\n${NUDGE_PROMPT}`;
  if (typeof prompt.answer === 'string' && prompt.answer !== '') {
    // 升级提问被回答后：答案原文进入下一回合，ask 正文与提交尾巴仍在（typed ask 还要交 JSON）。
    return `${base}\n\n---\n\nYour question was answered:\n${prompt.answer}`;
  }
  if (Array.isArray(prompt.history) && prompt.history.length > 0) {
    const transcript = prompt.history
      .map((entry, index) => `### Ask ${index + 1}\n${entry.ask}\n\n### Answer ${index + 1}\n${entry.answer}`)
      .join('\n\n');
    return `${base}\n\n---\n\nEarlier asks in this conversation, kept for context:\n${transcript}`;
  }
  return base;
}

/**
 * fill 落盘用的脚本标记前缀（评审 M4）。写进脚本注释里，因此重新编译/续跑都不会破坏脚本。
 */
const FILL_MARKER_PREFIX = '// zcode-workflow-fill ';

/**
 * 把一次 fill 追加到脚本尾部。
 * @param {string} scriptText
 * @param {string} siteId
 * @param {string} name
 * @param {string} code
 * @param {string} [filledBy]
 * @returns {string}
 */
function appendFillMarker(scriptText, siteId, name, code, filledBy) {
  const payload = JSON.stringify({
    siteId,
    name,
    code,
    filledAt: Date.now(),
    ...(filledBy === undefined ? {} : { filledBy }),
  });
  return `${scriptText.replace(/\s+$/u, '')}\n${FILL_MARKER_PREFIX}${payload}\n`;
}

/**
 * 从脚本里恢复已填留白。
 * @param {string} scriptText
 * @returns {Record<string, {code: string, name: string, filledAt?: number, filledBy?: string}>}
 */
export function parseFillMarkers(scriptText) {
  /** @type {Record<string, {code: string, name: string, filledAt?: number, filledBy?: string}>} */
  const fills = {};
  if (typeof scriptText !== 'string') return fills;
  for (const line of scriptText.split('\n')) {
    if (!line.startsWith(FILL_MARKER_PREFIX)) continue;
    try {
      const payload = JSON.parse(line.slice(FILL_MARKER_PREFIX.length));
      if (typeof payload?.siteId !== 'string' || typeof payload?.code !== 'string') continue;
      fills[payload.siteId] = {
        code: payload.code,
        name: typeof payload.name === 'string' ? payload.name : payload.siteId,
        ...(Number.isFinite(payload.filledAt) ? { filledAt: payload.filledAt } : {}),
        ...(typeof payload.filledBy === 'string' ? { filledBy: payload.filledBy } : {}),
      };
    } catch {
      // 坏行忽略，不影响脚本
    }
  }
  return fills;
}

/**
 * 脚本内容哈希（只用于判断“还是不是同一份脚本”，与 compiler 的 hashSource 同算法）。
 * @param {string} text
 * @returns {string}
 */
function computeScriptHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 255;
    hash ^= (text.charCodeAt(index) >> 8) & 255;
    hash = Math.imul(hash, 16777619);
  }
  return `s${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * 错误摘要（`describeCause`，最多 300 字符）。 */
function describeCause(error) {
  const text = (error instanceof Error ? error.message : String(error)).trim();
  if (text.length === 0) return 'unknown error';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * 创建 runtime。
 *
 * @param {object} [options]
 * @param {object} [options.journal] dev-host 的 journal；缺省用内存实现
 * @param {object} [options.projection] 可选的运行态投影（`apply(runId, event)`）
 * @param {object} [options.artifacts] 产物存储（`publish(record)`）
 * @param {(cwd: string) => object} [options.workspaceFor] 工作区只读视图
 * @param {object} [options.compiler] 编译器模块（缺省 import 本包 compiler.js）
 * @param {object} [options.config] 插件配置（maxConcurrency / stallMs / subagentModel …）
 * @param {object} [options.logger]
 */
export function createRuntime({
  journal, store: storeOption, projection, artifacts, workspaceFor, compiler, config = {}, logger = console,
} = {}) {
  const store = journal ?? storeOption ?? createMemoryJournal();
  const compiled = compiler ?? {};
  const runs = new Map();
  const cpuCount = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const defaultConcurrency = Number.isInteger(config.maxConcurrency) && config.maxConcurrency > 0
    ? config.maxConcurrency
    : defaultMaxConcurrency(cpuCount);
  const maxRuns = Number.isInteger(config.maxRuns) && config.maxRuns > 0 ? config.maxRuns : RUNTIME_CAPS.maxRuns;

  /**
   * @param {string} runId
   * @returns {object | undefined}
   */
  const entryFor = (runId) => runs.get(runId);

  /**
   * 通知订阅者。
   * @param {object} entry
   */
  const publish = (entry) => {
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
   * 编译 + 建 run 的前半段（prepare）：不创建 run，只返回给确认对话框需要的东西。
   * @param {object} request
   * @returns {object}
   */
  const prepare = (request) => {
    const code = String(request.code ?? '');
    const draftPath = request.scriptPath ?? request.draftPath ?? undefined;
    const result = compileSource({ compiler: compiled, code, filename: draftPath ?? 'workflow-script.ts' });
    if (result.ok !== true) {
      return {
        ok: false,
        diagnostics: result.diagnostics ?? [],
        ...(draftPath === undefined ? {} : { draftPath, scriptPath: draftPath }),
      };
    }
    return {
      ok: true,
      diagnostics: [],
      draftPath,
      scriptPath: draftPath,
      scriptHash: result.scriptHash,
      phases: result.phases ?? [],
      actors: result.actors ?? [],
      holes: result.holes ?? [],
      artifacts: result.artifacts ?? [],
      worldCommands: (result.worldReads ?? []).filter((site) => site.op === 'run').map((site) => site.siteId),
      prepared: {
        code,
        filename: draftPath ?? 'workflow-script.ts',
        compile: result,
      },
    };
  };

  /**
   * 启动一次 run。
   *
   * @param {object} request
   * @param {object} [request.prepared] `prepare()` 返回的 `prepared`（已确认过的编译产物）
   * @param {string} [request.code]
   * @param {string} [request.scriptPath]
   * @param {string} [request.name]
   * @param {string} [request.cwd]
   * @param {Record<string, unknown>} [request.args]
   * @param {number} [request.maxConcurrency]
   * @param {string} [request.subagentModel]
   * @param {(request: object) => Promise<object>} request.runner
   * @param {(text: string) => void} [request.notify]
   * @param {string} [request.runId]
   * @param {string} [request.resumedFrom]
   * @param {string} [request.origin]
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<object>}
   */
  const startRun = async (request) => {
    const active = [...runs.values()].filter((entry) => !entry.settled).length;
    if (active >= maxRuns) {
      return { ok: false, error: `too_many_runs: ${maxRuns} workflow runs are already in flight in this project; wait for one to settle. Nothing ran.` };
    }
    // prepared 允许三种形态：省略（本次编译）、`prepare()` 的整个返回、或它的 `.prepared`。
    const preparedInput = request.prepared;
    const preparedFull = preparedInput === undefined
      ? prepare({ code: request.code, scriptPath: request.scriptPath, draftPath: request.draftPath })
      : preparedInput;
    if (preparedFull.ok === false) return preparedFull;
    const preparedInner = preparedFull.prepared ?? preparedFull;
    const compileResult = preparedInner.compile ?? preparedFull.compile;
    if (compileResult === undefined) {
      return { ok: false, error: 'workflow_prepare_missing: `prepared` did not carry a compile result. Nothing ran.' };
    }
    const sourceCode = String(request.code ?? preparedInner.code ?? '');
    const scriptPath = request.scriptPath ?? preparedFull.scriptPath ?? preparedInner.scriptPath;
    const runId = request.runId ?? newRunId();
    const runName = String(request.name ?? 'workflow').replace(/[^\w\u4e00-\u9fa5 .-]+/gu, '-').slice(0, 80) || 'workflow';
    const cwd = String(request.cwd ?? process.cwd());
    const phaseNames = compileResult.phases ?? [];

    const allEvents = [];
    let entry;
    const emit = (event) => {
      allEvents.push(event);
      try {
        projection?.apply?.(runId, event);
      } catch (error) {
        logger.warn?.(`zcode-workflow: projection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      publish(entry);
    };
    const driver = createDriver({
      runId,
      cwd,
      journal: store,
      workspace: workspaceFor?.(cwd),
      artifacts,
      runner: request.runner,
      notify: request.notify,
      onEvent: emit,
      logger,
      signal: request.signal,
      phaseNames,
    });
    const engine = new WorkflowEngine({
      runId,
      journal: store,
      driver,
      caps: { maxConcurrency: normalizeConcurrency(request.maxConcurrency, defaultConcurrency) },
      askSpecs: compileResult.askSpecs ?? new Map(),
      sitePhases: compileResult.sitePhases ?? new Map(),
      holeTypes: new Map((compileResult.holes ?? [])
        .filter((hole) => typeof hole.typeText === 'string' && hole.typeText.length > 0)
        .map((hole) => [hole.siteId, hole.typeText])),
      launch: {
        runId,
        inputId: runId,
        name: runName,
        cwd,
        args: request.args ?? {},
        scriptText: sourceCode,
        scriptPath,
        scriptHash: compileResult.scriptHash,
        subagentModel: request.subagentModel,
        phaseNames,
        ...(request.resumedFrom === undefined ? {} : { resumedFrom: request.resumedFrom }),
      },
    });
    // driver 的提问通道要把 escalation 事件写回引擎（引擎创建后才能绑定）。
    driver.record = (event) => engine.record(event);
    // 续跑：脚本尾部的 fill 标记把已补全的留白装回引擎（评审 M4）。
    const seededFills = parseFillMarkers(sourceCode);
    if (Object.keys(seededFills).length > 0) engine.seedFills(seededFills);
    entry = {
      meta: {
        id: runId,
        name: runName,
        cwd,
        status: 'running',
        createdAt: Date.now(),
        scriptPath,
        args: request.args ?? {},
        maxConcurrency: engine.caps.maxConcurrency,
        subagentModel: request.subagentModel,
        origin: request.origin ?? 'workflow',
        phases: phaseNames,
        actors: (compileResult.actors ?? []).map((actor) => actor.name).filter((name) => typeof name === 'string'),
        resumedFrom: request.resumedFrom,
      },
      engine,
      events: allEvents,
      listeners: new Set(),
      waiters: new Set(),
      settled: false,
      notify: request.notify,
      driver,
      compile: compileResult,
      scriptText: sourceCode,
    };
    runs.set(runId, entry);

    const bridge = createFacadeBridge({
      engine,
      cell: { deliver: (response) => cell?.deliver(response) },
      onEvent: () => {},
    });
    const cell = createWorkflowCell({
      lowered: compileResult.lowered ?? '',
      args: request.args ?? {},
      run: { id: runId, ...(request.resumedFrom === undefined ? {} : { resumedFrom: request.resumedFrom }) },
      filename: scriptPath ?? 'workflow-script.js',
      onMessage: (message) => bridge.handle(message),
      // bridge 的 cell.deliver 需要 cell 实例；先建 cell 再回填（闭包引用，赋值发生在执行前）。
    });
    bridge.setCompleteHandler((message) => {
      if (message.ok === true) engine.complete(message.value === undefined ? null : message.value);
      else settleScriptFailure(engine, workflowErrorFromWire(message.error));
    });

    void (async () => {
      try {
        const outcome = await cell.execute();
        if (outcome.ok === true) engine.complete(outcome.value === undefined ? null : outcome.value);
        else settleScriptFailure(engine, workflowErrorFromWire(outcome.error));
      } catch (error) {
        settleScriptFailure(engine, error instanceof Error ? error : new Error(String(error)));
      }
    })();

    // 停滞判定（评审 M10）：每 60s 检查一次 lastProgressAt；超过 stallMs 记一次 run-stalled
    // 并发一条催促（预算 2 次），有进展后自动复位。
    const stallMs = Number.isFinite(config.stallMs) && config.stallMs > 0 ? config.stallMs : 30 * 60 * 1000;
    const reminderMs = Number.isFinite(config.stallCheckMs) && config.stallCheckMs > 0 ? config.stallCheckMs : 60 * 1000;
    const stallTimer = setInterval(() => {
      if (entry.settled) return;
      const idleMs = Date.now() - engine.lastProgressAt;
      if (idleMs < stallMs) return;
      if (engine.stalledSince === undefined) {
        // 契约 §1.5 的 `health.stalledSince` 是 epoch 毫秒（与 `lastProgressAt` 同型）。
        engine.stalledSince = engine.lastProgressAt;
        engine.stallReminders += 1;
        engine.record({ type: 'run-stalled', since: engine.lastProgressAt, idleMs, reminders: engine.stallReminders });
        try {
          entry.notify?.(`Workflow run ${runName} (${runId}) has made no progress for ${Math.round(idleMs / 60000)} minutes. It is still running; nothing times out on its behalf.`);
        } catch {
          // 催促失败不影响 run
        }
      } else if (engine.stallReminders < 2) {
        engine.stallReminders += 1;
        try {
          entry.notify?.(`Workflow run ${runName} (${runId}) is still stalled since ${new Date(engine.stalledSince).toISOString()}. Either way the run keeps waiting; nothing times out on its behalf.`);
        } catch {
          // 同上
        }
      }
    }, reminderMs);
    stallTimer.unref?.();
    entry.stallTimer = stallTimer;

    void engine.settleDeferred.promise.then((outcome) => {
      entry.settled = true;
      if (entry.stallTimer !== undefined) clearInterval(entry.stallTimer);
      entry.meta = {
        ...entry.meta,
        status: outcome.status,
        ...(outcome.reason === undefined ? {} : { stopReason: outcome.reason }),
        ...(outcome.supersededBy === undefined ? {} : { supersededBy: outcome.supersededBy }),
        ...(outcome.error === undefined ? {} : { error: outcome.error.message }),
        finishedAt: Date.now(),
        ...(outcome.status === 'completed' ? { result: outcome.value } : {}),
      };
      entry.generatedAt = new Date().toISOString();
      publish(entry);
      for (const waiter of entry.waiters) {
        try {
          waiter(entry.meta);
        } catch {
          // waiters 是消费者
        }
      }
      entry.waiters.clear();
      try {
        entry.notify?.(formatCompletionNotification(entry, outcome));
      } catch (error) {
        logger.warn?.(`zcode-workflow: completion notification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      logger.info?.(`zcode-workflow: run ${runId} ${outcome.status}`);
    });

    return {
      ok: true,
      runId,
      // `id` 是旧接线的字段名（`/dwf` 命令与卡片按 run.id 读）；两个名字同值。
      id: runId,
      draftPath: preparedFull.draftPath ?? preparedInner.draftPath,
      scriptPath,
      phases: phaseNames,
      actors: (compileResult.actors ?? []).map((actor) => actor.name).filter((name) => typeof name === 'string'),
      holes: (compileResult.holes ?? []).map((hole) => ({ siteId: hole.siteId, name: hole.name })),
    };
  };

  /**
   * 续跑：同一 run_id，重放已结算节点。
   * @param {string} runId
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  const resumeRun = async (runId, options = {}) => {
    const stored = store.getRun(runId);
    if (stored === undefined) return { ok: false, code: 'RUN_NOT_FOUND', message: `run_not_found: no workflow run with ID ${runId} exists for this project.` };
    if (stored.status === 'completed' || stored.status === 'errored') {
      return { ok: false, code: 'NOT_RESUMABLE', message: `workflow_run_not_resumable: run ${runId} is ${stored.status} and cannot be resumed. Fix the script and submit it with AmendWorkflow instead.` };
    }
    if (stored.stopReason === 'superseded') {
      return { ok: false, code: 'NOT_RESUMABLE', message: `workflow_run_not_resumable: run ${runId} was superseded by ${stored.supersededBy ?? 'a newer run'}; continue that run instead.` };
    }
    const code = stored.scriptText;
    if (typeof code !== 'string' || code === '') {
      return { ok: false, code: 'SCRIPT_MISMATCH', message: `workflow_amend_script_unavailable: run ${runId} has no recorded script, so it cannot be resumed.` };
    }
    const prepared = prepare({ code, scriptPath: stored.scriptPath });
    if (prepared.ok === false) return prepared;
    const previousStatus = stored.status;
    const result = await startRun({
      ...options,
      prepared,
      runId,
      name: stored.name,
      cwd: stored.cwd,
      args: stored.args,
      maxConcurrency: stored.caps?.maxConcurrency,
      subagentModel: stored.subagentModel,
      resumedFrom: stored.resumedFrom,
    });
    void previousStatus;
    return result;
  };

  /**
   * 运行中调整并发上限（上游的运行设置）：活跃 run 交给引擎改 caps 并记 `run-caps-changed`；
   * 已结算的 run 已经没有调度器，改不了。
   * @param {string} runId
   * @param {number} value
   * @returns {object}
   */
  const configureRun = (runId, value) => {
    // 参数非法与“值没变”是两回事：非有限数/非正整数要在改 caps 之前就被挡住（评审 R5）。
    if (!Number.isInteger(value) || value < 1) {
      return {
        ok: false,
        code: 'INVALID_CAP',
        message: `workflow_run_invalid_cap: the concurrency limit must be a positive integer; got ${String(value)}.`,
      };
    }
    const entry = entryFor(runId);
    if (entry === undefined || entry.settled === true) {
      const stored = store.getRun(runId);
      if (stored === undefined) {
        return { ok: false, code: 'RUN_NOT_FOUND', message: `run_not_found: no workflow run with ID ${runId} exists for this project.` };
      }
      // 已经结束 → run_settled；进程里没有它（另一个进程在跑、或上次进程退出留下的行）→ run_not_retunable。
      if (entry === undefined && !TERMINAL.has(stored.status)) {
        return { ok: false, code: 'RUN_NOT_RETUNABLE', message: `workflow_run_not_retunable: run ${runId} is ${stored.status}, but this agent is not executing it, so it cannot retune it.` };
      }
      return { ok: false, code: 'RUN_NOT_ACTIVE', message: `workflow_run_not_active: run ${runId} is ${entry === undefined ? stored.status : 'finished'}; only a running run takes a new concurrency limit.` };
    }
    // 契约把并发上限封在 1024（engine.md:1104）：超过就按上限算，不把越界值写进 caps。
    const bounded = Math.min(value, RUNTIME_CAPS.maxConcurrencyCeiling);
    const changed = entry.engine?.setMaxConcurrency?.(bounded) === true;
    if (!changed) {
      return { ok: false, code: 'CAPS_UNCHANGED', message: `workflow_run_settings_unchanged: run ${runId} already runs at that limit.` };
    }
    return { ok: true, runId, caps: { maxConcurrency: Math.max(1, Math.floor(bounded)) } };
  };

  /**
   * 停止一个 run。
   * @param {string} runId
   * @param {'user'|'model'|'provider'} [reason]
   * @returns {Promise<object>}
   */
  const stopRun = async (runId, reason = 'user') => {
    const entry = entryFor(runId);
    const stored = store.getRun(runId);
    if (entry === undefined && stored === undefined) {
      return { ok: false, code: 'RUN_NOT_FOUND', message: `run_not_found: no workflow run with ID ${runId} exists for this project.` };
    }
    if (entry !== undefined && !entry.settled) {
      entry.engine.stop(reason === 'provider' ? 'provider' : reason, undefined);
      return { ok: true, runId, stopReason: reason };
    }
    if (stored !== undefined && TERMINAL.has(stored.status)) {
      return { ok: false, code: 'RUN_SETTLED', message: `workflow_run_settled: run ${runId} already settled (${stored.status}).` };
    }
    return { ok: true, runId, stopReason: reason };
  };

  /**
   * 补齐留白。
   *
   * ZCode 的 FillWorkflowHole 收的是**留白函数体代码**（`script` 或 `path`），不是 JSON 值；
   * 运行时把它包成 `(async () => { … })` 在站点处 eval。为了兼容先前的字符串形态，
   * 直接传字符串也当作 script。
   *
   * @param {string} runId
   * @param {string} holeId
   * @param {{script?: string, path?: string} | string} body
   * @param {{filledBy?: string}} [options]
   * @returns {Promise<object>}
   */
  const fillHole = async (runId, holeId, body, options = {}) => {
    const entry = entryFor(runId);
    if (entry === undefined) return { ok: false, code: 'RUN_NOT_FOUND', message: `run_not_found: no workflow run with ID ${runId} exists for this project.` };
    if (entry.settled) return { ok: false, code: 'RUN_SETTLED', message: `workflow_run_settled: run ${runId} already settled; there is nothing waiting at ${holeId}.` };
    let script;
    if (typeof body === 'string') script = body;
    else if (body !== null && typeof body === 'object') {
      if (typeof body.script === 'string') script = body.script;
      else if (typeof body.path === 'string') {
        try {
          const { readFile } = await import('node:fs/promises');
          script = await readFile(body.path, 'utf8');
        } catch (error) {
          return { ok: false, code: 'BODY_UNAVAILABLE', message: `workflow_fill_body_unavailable: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
    }
    if (typeof script !== 'string' || script.trim() === '') {
      return { ok: false, code: 'BODY_UNAVAILABLE', message: 'workflow_fill_body_unavailable: the call reached the handler without a resolved body. Pass `script` or `path`. Nothing was filled.' };
    }
    const hole = entry.engine.openHoles().find((candidate) => candidate.siteId === holeId);
    // 包成表达式：cell 的 __evaluateFill 会 `evaluate(code)()`。
    const code = `(async () => {\n${script}\n})`;
    const result = entry.engine.fillHole(holeId, code, options.filledBy, hole?.name);
    if (result.ok !== true) {
      return { ok: false, code: 'NOT_WAITING', message: `workflow_hole_not_waiting: run ${runId} is not waiting at ${holeId}. It may have been filled already, or the run never reached it.` };
    }
    // 体落盘（评审 M4）：把 fill 追加成脚本里的标记块并写回 journal，resume 时据此把站点
    // 当成已补全（见 parseFillMarkers/seedFills）。`updateRunScript` 不存在的 journal 只跳过落盘。
    try {
      const stored = store.getRun(runId);
      const baseScript = typeof stored?.scriptText === 'string' && stored.scriptText !== ''
        ? stored.scriptText
        : (typeof entry.scriptText === 'string' ? entry.scriptText : '');
      if (baseScript !== '') {
        const appended = appendFillMarker(baseScript, holeId, hole?.name ?? holeId, code, options.filledBy);
        store.updateRunScript?.(runId, appended, computeScriptHash(appended));
        entry.scriptText = appended;
      }
    } catch (error) {
      logger.warn?.(`zcode-workflow: could not persist the filled body for ${holeId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const name = hole?.name ?? holeId;
    return {
      ok: true,
      siteId: holeId,
      name,
      // 契约 FillWorkflowHole 成功时必带 `fill`（评审 M7）。
      fill: { siteId: holeId, name },
    };
  };

  /**
   * 回答一个挂起的提问。
   * @param {string} qid
   * @param {string} answer
   * @returns {{ok: boolean, code?: string, message?: string, qid?: string, response?: string}}
   */
  const resolveQuestion = (qid, answer) => {
    for (const entry of runs.values()) {
      if (!entry.driver.pendingQuestions.has(qid)) continue;
      if (entry.settled) {
        return {
          ok: false,
          code: 'RUN_NOT_IN_FLIGHT',
          message: `Question ${qid} belongs to run ${entry.meta.id}, which is no longer running (${entry.meta.status}). Resume the run first, or start a new one.`,
        };
      }
      return entry.driver.answerQuestion(qid, String(answer ?? ''));
    }
    for (const entry of runs.values()) {
      if (entry.driver.resolvedQuestions?.has(qid)) {
        return { ok: false, code: 'ALREADY_RESOLVED', message: `Question ${qid} was already answered; the subagent that asked it has resumed.` };
      }
    }
    return {
      ok: false,
      code: 'UNKNOWN_QUESTION',
      message: `No workflow question with ID ${qid} is pending. It may have been answered already, or the run may have settled.`,
    };
  };

  /**
   * 一个 run 的对外快照。
   * @param {string} runId
   * @returns {Promise<object | undefined>}
   */
  const getRun = async (runId) => {
    const entry = entryFor(runId);
    const stored = store.getRun(runId);
    if (entry === undefined && stored === undefined) return undefined;
    const events = store.listEvents(runId, { types: 'all', reportItems: { limit: RUNTIME_CAPS.maxReports } });
    const nodes = store.listNodes(runId, { kinds: ['ask', 'world-read', 'world-run'], withResult: false, limit: RUNTIME_CAPS.maxNodes });
    const artifacts = store.listNodes(runId, { kinds: ['artifact'], withResult: true, limit: RUNTIME_CAPS.maxArtifacts });
    const reports = nodes.length === 0 && events.length === 0
      ? []
      : store.listNodes(runId, { kinds: ['report'], withResult: true, limit: RUNTIME_CAPS.maxReports });
    const actors = store.listActors(runId, { withPersona: false });
    const settledNodes = nodes.filter((node) => node.status === 'completed' || node.status === 'failed');
    const usage = {
      spentTokens: stored?.spentTokens ?? 0,
      nodesObserved: nodes.length,
      nodesRunning: nodes.length - settledNodes.length,
      nodesCompleted: nodes.filter((node) => node.status === 'completed').length,
      nodesFailed: nodes.filter((node) => node.status === 'failed').length,
    };
    const runStatus = stored?.status ?? 'running';
    // 契约 km 的 status 不是事件给的，是按引用该 actor 的 node 派生（engine.md:592-596）。
    const activeRun = runStatus === 'pending' || runStatus === 'running';
    // 快照是被轮询的，按 actor 建一次索引，避免 actors × nodes 的重复过滤。
    /** @type {Map<string, object[]>} */
    const nodesByActor = new Map();
    for (const node of nodes) {
      if (node.actorSiteId === undefined) continue;
      const key = `${node.actorSiteId}@${node.actorOrdinal ?? 0}`;
      const bucket = nodesByActor.get(key);
      if (bucket === undefined) nodesByActor.set(key, [node]);
      else bucket.push(node);
    }
    const nodesOfActor = (actor) => nodesByActor.get(`${actor.siteId}@${actor.ordinal}`) ?? [];
    const derivedActors = actors.map((actor) => {
      const mine = nodesOfActor(actor);
      const working = mine.some((node) => node.phase === 'executing' || node.phase === 'repairing' || node.phase === 'nudged');
      const pending = mine.length === 0
        || mine.some((node) => node.phase === 'queued' || node.phase === 'dispatched' || node.phase === 'waiting');
      const status = !activeRun ? 'completed' : (working ? 'running' : (pending ? 'waiting' : 'completed'));
      return { actor, mine, status };
    });
    const pendingQuestions = entry === undefined
      ? []
      : [...entry.driver.pendingQuestions.values()].map((parked) => parked.record);
    const snapshot = entry === undefined ? undefined : projection?.snapshot?.(runId);
    const result = {
      runId,
      id: runId,
      ...(stored?.name === undefined ? {} : { name: stored.name }),
      status: stored?.status ?? 'running',
      ...(stored?.stopReason === undefined && entry?.meta?.stopReason === undefined
        ? {}
        : { stopReason: stored?.stopReason ?? entry?.meta?.stopReason }),
      ...(stored?.supersededBy === undefined ? {} : { supersededBy: stored.supersededBy }),
      ...(stored?.resumedFrom === undefined ? {} : { resumedFrom: stored.resumedFrom }),
      ...(stored?.scriptPath === undefined ? {} : { scriptPath: stored.scriptPath }),
      ...(stored?.cwd === undefined ? {} : { cwd: stored.cwd }),
      ...(stored?.caps?.maxConcurrency === undefined ? {} : { maxConcurrency: stored.caps.maxConcurrency }),
      ...(stored?.subagentModel === undefined ? {} : { subagentModel: stored.subagentModel }),
      usage,
      spentTokens: usage.spentTokens,
      actors: derivedActors.map(({ actor, status }) => ({
        siteId: actor.siteId,
        ordinal: actor.ordinal,
        ...(actor.name === undefined ? {} : { name: actor.name }),
        ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
        status,
      })),
      // 契约 Uoe 的 subagents（cli.md:167-169）：状态派生同上，计数来自该 actor 的 node 行。
      subagents: derivedActors.map(({ actor, mine, status }) => {
        const settled = mine.filter((node) => node.outcome === 'ok').length;
        const failed = mine.filter((node) => node.outcome === 'failed').length;
        const tokens = mine.reduce((sum, node) => sum + (Number(node.stats?.tokens) || 0), 0);
        const state = failed > 0
          ? 'failed'
          : status === 'running' ? 'executing'
            : status === 'waiting' ? 'waiting'
              : 'done';
        return {
          siteId: actor.siteId,
          ordinal: actor.ordinal,
          ...(actor.name === undefined ? {} : { name: actor.name }),
          state,
          stepsSettled: settled,
          stepsFailed: failed,
          tokens,
        };
      }),
      nodes: nodes.map((node) => ({
        siteId: node.siteId,
        ordinal: node.ordinal,
        ...(node.kind === undefined ? {} : { kind: node.kind }),
        phase: node.phase ?? 'queued',
        ...(node.outcome === undefined ? {} : { outcome: node.outcome }),
        ...(node.actorSiteId === undefined ? {} : { actorSiteId: node.actorSiteId }),
        ...(node.actorOrdinal === undefined ? {} : { actorOrdinal: node.actorOrdinal }),
        ...(node.turn === undefined ? {} : { turn: node.turn }),
        ...(node.toolCalls === undefined ? {} : { toolCalls: node.toolCalls }),
      })),
      reports: reports.map((row) => ({
        siteId: row.siteId,
        ordinal: row.ordinal,
        preview: preview(safeJson(row.result), RUNTIME_CAPS.maxReportPreviewLength),
        ...(row.artifactId === undefined ? {} : { artifactId: row.artifactId }),
      })),
      artifacts: artifacts
        .filter((row) => row.status === 'completed' && row.result !== undefined)
        .map((row) => ({
          id: row.result.id,
          kind: row.result.kind,
          ...(row.result.title === undefined ? {} : { title: row.result.title }),
          version: row.result.version ?? 1,
          itemCount: entry?.engine.artifacts.get(row.result.id)?.items ?? 0,
          ...(row.result.primary === true ? { primary: true } : {}),
        })),
      // 已填的留白也要在列表里（契约 `holes[].state` 有 waiting/filled 两种，cli.md:174）。
      holes: entry === undefined ? [] : capHoleRows(entry.engine.holeRecords()),
      pendingQuestions,
      phases: stored?.phases ?? [],
      currentPhase: entry?.engine.currentPhase,
      // `logTail` 每行 `{sequence, message, at}`，message 截 1024（契约 cli.md:165/540）。
      logTail: store.listEvents(runId, { types: ['log'] }).slice(-50).map((event, index) => ({
        sequence: event.sequence ?? index,
        message: preview(String(event.event.message ?? ''), MAX_LOG_TAIL_MESSAGE),
        ...(typeof event.timeCreated === 'number' ? { at: event.timeCreated } : {}),
      })),
      ...(stored?.failure === undefined ? {} : { error: stored.failure }),
      // 有的 journal 实现只把 result 留在内存里的 run 记录上（store 的 updateRunStatus 不写 result），
      // 所以两处都看一眼：存储优先，其次本进程的终态。
      ...(stored?.result === undefined && entry?.meta?.result === undefined
        ? {}
        : { result: stored?.result ?? entry?.meta?.result }),
      events: events.slice(-1).map((row) => ({ sequence: row.sequence })),
      health: {
        consecutiveFailures: usage.nodesFailed,
        cachedSteps: 0,
        pendingQuestionsKnown: true,
        ...(entry === undefined ? {} : {
          // 契约 §1.5 的 `health.lastProgressAt`/`stalledSince`：模型面读得到才有用（评审 R6）。
          lastProgressAt: entry.engine.lastProgressAt,
          ...(entry.engine.stalledSince === undefined ? {} : { stalledSince: entry.engine.stalledSince }),
          concurrency: entry.engine.concurrency.contractSnapshot(entry.engine.now()),
        }),
      },
      ...(snapshot === undefined ? {} : { projection: snapshot }),
    };
    return { ...result, summary: summarizeRun(result) };
  };

  /**
   * 运行列表（新→旧）。
   *
   * `store.listRuns` 在 dev-host 的 store 里是 async（要读磁盘目录），其余 journal 方法是同步的
   * （引擎按同步接口设计），所以这里 await 一次、把两种形态都收下。
   * @param {{sessionId?: string, cwd?: string, limit?: number}} [options]
   * @returns {Promise<object[]>}
   */
  const listRuns = async (options = {}) => {
    const stored = await store.listRuns({ limit: options.limit ?? 20 });
    return stored
      .filter((run) => options.cwd === undefined || run.cwd === options.cwd)
      .map((run) => ({
        runId: run.runId,
        id: run.runId,
        // store 已按 name → 脚本首行 → runId 解析出 label（§1.1(1)），直接透出。
        label: run.label ?? run.name,
        ...(run.name === undefined ? {} : { name: run.name }),
        status: run.status,
        ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
        ...(run.resumedFrom === undefined ? {} : { resumedFrom: run.resumedFrom }),
        ...(run.supersededBy === undefined ? {} : { supersededBy: run.supersededBy }),
        createdAt: run.timeCreated,
        updatedAt: run.timeUpdated ?? run.timeCreated,
        spentTokens: run.spentTokens ?? 0,
        ownedByThisSession: options.sessionId === undefined ? true : run.sessionId === options.sessionId,
      }));
  };

  /**
   * 事件读取（UI 增量轮询）。
   * @param {string} runId
   * @param {number} [afterSequence]
   * @param {number} [limit]
   * @returns {object[]}
   */
  const eventsAfter = (runId, afterSequence = -1, limit = 500) => store.listEvents(runId, {
    types: 'all',
    afterSequence,
    limit,
    reportItems: { limit: RUNTIME_CAPS.maxReports },
  }).map((row) => ({
    sequence: row.sequence,
    // store 的 listEvents 同时给了 row.type（journal 行）与 row.event（事件体），两者取其一即可。
    type: row.event?.type ?? row.type,
    event: row.event ?? row,
    timeCreated: row.timeCreated,
  }));

  /**
   * 追加一条外部事件（UI/审批链路用；引擎自己走 engine.record）。
   * @param {string} runId
   * @param {object} event
   */
  const appendEvent = (runId, event) => store.appendEvent(runId, event);

  /**
   * 一个 run 的 journal 句柄（限定到该 run）。
   * @param {string} runId
   * @returns {object}
   */
  const journalFor = (runId) => ({
    getRun: () => store.getRun(runId),
    getActor: (siteId, ordinal) => store.getActor(runId, siteId, ordinal),
    listActors: (options) => store.listActors(runId, options),
    getNode: (siteId, ordinal, options) => store.getNode(runId, siteId, ordinal, options),
    listNodes: (options) => store.listNodes(runId, options),
    appendEvent: (event) => store.appendEvent(runId, event),
    listEvents: (options) => store.listEvents(runId, options),
  });

  /**
   * 等待一个 run 结束（TaskOutput 语义）。
   * @param {string} runId
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<object | undefined>}
   */
  const waitForRun = async (runId, options = {}) => {
    const entry = entryFor(runId);
    if (entry === undefined) return getRun(runId);
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
   * 订阅一个 run 的进度。
   * @param {string} runId
   * @param {(entry: object) => void} listener
   * @returns {() => void}
   */
  const subscribe = (runId, listener) => {
    const entry = entryFor(runId);
    if (entry === undefined) return () => {};
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  };

  /**
   * 编译并同步运行一个片段（EvalWorkflowSnippet）：不创建 run，不持久化，facade 是被裁剪的。
   * @param {{code: string, cwd?: string, timeoutMs?: number, signal?: AbortSignal}} request
   * @returns {Promise<object>}
   */
  const evaluate = async ({ code, cwd, timeoutMs = 60 * 1000, signal }) => {
    const startedAt = Date.now();
    const result = compileSource({ compiler: compiled, code, filename: 'snippet.ts', mode: 'snippet', snippet: true });
    if (result.ok !== true) return { ok: false, diagnostics: result.diagnostics ?? [], durationMs: Date.now() - startedAt };
    const workspace = workspaceFor?.(String(cwd ?? process.cwd()));
    const logs = [];
    const runId = `dwfeval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const events = [];
    const bridge = createFacadeBridge({
      engine: {
        createActor: () => { throw new WorkflowError('DriverError', 'agent() does not exist in a snippet'); },
        ask: () => Promise.reject(new WorkflowError('DriverError', 'agent() does not exist in a snippet')),
        worldRead: async (siteId, op, args) => {
          events.push({ type: 'world-read', siteId, op });
          return worldReadFor(workspace, op, args);
        },
        publishArtifact: () => Promise.reject(new WorkflowError('DriverError', 'artifact.* does not exist in a snippet')),
        declareArtifact: () => {},
        report: () => {},
        log: (message) => logs.push(String(message)),
        enterPhase: () => {},
        hole: () => Promise.reject(new WorkflowError('DriverError', 'hole() does not exist in a snippet')),
        fail: () => {},
      },
      cell: { deliver: (response) => cell?.deliver(response) },
      onEvent: () => {},
    });
    const cell = createWorkflowCell({
      lowered: result.lowered ?? '',
      args: {},
      run: { id: runId },
      filename: 'snippet.js',
      onMessage: (message) => bridge.handle(message),
    });
    let timer;
    try {
      const execution = cell.execute();
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __timeout: true }), Math.min(Math.max(timeoutMs, 1), 600000));
      });
      const abort = new Promise((resolve) => {
        if (signal === undefined) return;
        if (signal.aborted) resolve({ __aborted: true });
        signal.addEventListener('abort', () => resolve({ __aborted: true }), { once: true });
      });
      const outcome = await Promise.race([execution, timeout, abort]);
      if (outcome !== null && typeof outcome === 'object' && outcome.__timeout === true) {
        return { ok: false, error: `the snippet timed out after ${timeoutMs}ms`, logs, durationMs: Date.now() - startedAt };
      }
      if (outcome !== null && typeof outcome === 'object' && outcome.__aborted === true) {
        return { ok: false, error: 'the snippet was cancelled', logs, durationMs: Date.now() - startedAt };
      }
      if (outcome.ok === true) {
        return { ok: true, value: outcome.value === undefined ? null : outcome.value, logs, diagnostics: [], durationMs: Date.now() - startedAt };
      }
      return { ok: false, error: outcome.error?.message ?? 'the snippet failed', logs, durationMs: Date.now() - startedAt };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /**
   * amend：停前驱 + 新 run（DSH 侧没有 transcript 种子，缓存导入由 resume 的重放语义覆盖）。
   * @param {string} runId
   * @param {object} request
   * @returns {Promise<object>}
   */
  const amend = async (runId, request) => {
    const stored = store.getRun(runId);
    if (stored === undefined) return { ok: false, code: 'RUN_NOT_FOUND', message: `run_not_found: no workflow run with ID ${runId} exists for this project.` };
    if (stored.scriptHash !== undefined && request.code !== undefined) {
      const sameScript = computeCompile(request.code).scriptHash === stored.scriptHash;
      if (sameScript && request.name === undefined && request.maxConcurrency === undefined && request.subagentModel === undefined) {
        return { ok: false, code: 'SCRIPT_UNCHANGED', message: `workflow_script_unchanged: the script is byte-for-byte the script run ${runId} was started with, so amending it would repeat that run exactly. Edit the file first, then call AmendWorkflow again; to continue a stopped run under the same script, use ResumeWorkflowRun.` };
      }
    }
    const entry = entryFor(runId);
    const wasRunning = entry !== undefined && !entry.settled;
    // 后继 runId 必须先知道：契约 §4.9「被取代」要求前驱落
    // `stop_reason=superseded` + `superseded_by=<后继 runId>`（cli.md:1019），
    // 而 `engine.stop` 只能在停止时就带上它。
    const successorRunId = typeof request.runId === 'string' && request.runId.length > 0 ? request.runId : newRunId();
    if (wasRunning) entry.engine.stop('superseded', undefined, successorRunId);
    const started = await startRun({
      ...request,
      runId: successorRunId,
      resumedFrom: runId,
    });
    return started.ok === true ? { ...started, supersededRunId: runId } : started;
  };

  /**
   * @param {string} code
   * @returns {object}
   */
  const computeCompile = (code) => compileSource({ compiler: compiled, code, filename: 'workflow-script.ts' });

  return {
    prepare,
    startRun,
    start: startRun,
    resumeRun,
    // 工具层（Host 评审 B2）按名字 `resume` 调用 ResumeWorkflowRun；两个名字同一实现。
    resume: resumeRun,
    amend,
    configureRun,
    configure: configureRun,
    stopRun,
    fillHole,
    resolveQuestion,
    answerQuestion: resolveQuestion,
    getRun,
    listRuns,
    eventsAfter,
    appendEvent,
    journalFor,
    waitForRun,
    subscribe,
    evaluate,
    get runCount() {
      return runs.size;
    },
    /** 测试/接线用：暴露内部 journal（只读约定由调用方遵守）。 */
    get journal() {
      return store;
    },
  };
}

/**
 * 调用编译器（容忍不同的导出名，方便测试注入假编译器）。
 * @param {object} options
 * @returns {object}
 */
function compileSource({ compiler, code, filename, mode = 'workflow', snippet = false }) {
  if (typeof compiler.compileWorkflowScript === 'function') {
    return compiler.compileWorkflowScript({ code, filename, mode, snippet });
  }
  if (typeof compiler.compileWorkflow === 'function') {
    return compiler.compileWorkflow({ code, filename, mode, snippet });
  }
  throw new Error('zcode-workflow: no workflow compiler was wired');
}

/**
 * 把 cell 的 wire 错误还原成 WorkflowError。
 * @param {object | undefined} wire
 * @returns {WorkflowError}
 */
function workflowErrorFromWire(wire) {
  if (wire === undefined || wire === null) return new WorkflowError('DriverError', 'the workflow script failed');
  return new WorkflowError(
    typeof wire.code === 'string' ? wire.code : 'ScriptError',
    typeof wire.message === 'string' ? wire.message : String(wire),
    { violations: wire.violations, finalText: wire.finalText },
  );
}

/**
 * world read 的独立实现（片段求值路径没有引擎时用）。
 * @param {object | undefined} workspace
 * @param {string} op
 * @param {unknown[]} args
 * @returns {Promise<unknown>}
 */
async function worldReadFor(workspace, op, args) {
  if (workspace === undefined) throw new WorkflowError('DriverError', `world read "${op}" is unavailable: this host wired no workspace.`);
  const [first, second, third] = args;
  switch (op) {
    case 'glob': return workspace.files.glob(String(first));
    case 'read': return workspace.files.read(String(first));
    case 'grep': return workspace.files.grep(String(first), second === undefined ? undefined : String(second));
    case 'git-changed-files': return workspace.git.changedFiles(first === undefined ? undefined : String(first));
    case 'git-diff': return workspace.git.diff(first === undefined ? undefined : String(first), second === undefined ? undefined : String(second));
    case 'git-status': return workspace.git.status();
    case 'git-log': return workspace.git.log(second === undefined ? first : second);
    case 'run': {
      const opts = third !== null && typeof third === 'object' ? third : {};
      const result = await workspace.runCommand(String(first), Array.isArray(second) ? second.map(String) : [], {
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        ...(opts.output === undefined ? {} : { output: opts.output }),
      });
      return { exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
    default: throw new WorkflowError('DriverError', `unknown world read "${op}"`);
  }
}

/**
 * 完成通知（`Cya` 的信封 + 交付指引；模型侧看到的最终文本）。
 *
 * 为什么用 `<task-notification>`：主代理把它当后台任务通知读，才不会误以为是用户消息；
 * 交付指引按终态分支，避免"停跑后自动续跑"这类越权动作。
 *
 * @param {object} entry
 * @param {{status: string, reason?: string, value?: unknown, error?: Error}} outcome
 * @returns {string}
 */
export function formatCompletionNotification(entry, outcome) {
  const reports = entry.events.filter((event) => event.type === 'report');
  const artifacts = entry.events.filter((event) => event.type === 'artifact-published');
  const shownReports = reports.slice(-RUNTIME_CAPS.maxReports);
  const shownArtifacts = artifacts.slice(-RUNTIME_CAPS.maxArtifacts);
  const lines = [
    '[SYSTEM NOTIFICATION - NOT USER INPUT]',
    'This is an automated workflow event, NOT a message from the user.',
    'Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.',
    '',
    '<task-notification>',
    `<task-id>${entry.meta.id}</task-id>`,
    `<status>${outcome.status}</status>`,
    ...(entry.meta.stopReason === undefined ? [] : [`<stop-reason>${entry.meta.stopReason}</stop-reason>`]),
    ...(entry.meta.supersededBy === undefined ? [] : [`<superseded_by>${entry.meta.supersededBy}</superseded_by>`]),
    `<summary>${preview(`Run ${entry.meta.name} (${entry.meta.id}) ${outcome.status}`, MAX_NOTIFICATION_SUMMARY)}</summary>`,
    ...(outcome.status === 'completed' ? [`<result>${preview(safeJson(outcome.value), RUNTIME_CAPS.maxResultPreviewLength)}</result>`] : []),
    ...(outcome.error === undefined ? [] : [`<error>${preview(outcome.error.message, RUNTIME_CAPS.maxErrorLength)}</error>`]),
    `<reports count="${reports.length}"${shownReports.length < reports.length ? ` shown="${shownReports.length}"` : ''}>${shownReports.map((event) => preview(safeJson(event.item), 2048)).join('\n')}</reports>`,
    `<artifacts count="${artifacts.length}"${shownArtifacts.length < artifacts.length ? ` shown="${shownArtifacts.length}"` : ''}>${shownArtifacts.map((event) => `${event.artifact?.id} (${event.artifact?.kind})${event.artifact?.primary === true ? ' [primary]' : ''}`).join('\n')}</artifacts>`,
    '</task-notification>',
    '',
  ];
  if (outcome.status === 'completed') {
    lines.push('The workflow completed. Present its outcome to the user as a deliverable, in this order: the conclusion; each finding with its evidence (path and line, or the command and output that showed it); which findings were confirmed by a deterministic check or an independent subagent and which are judged only; what the run did not cover.');
    lines.push('The reported items above are individual findings: present them individually and keep their evidence. When the preview is partial (count greater than shown), say so and read the rest with GetWorkflowRun.');
    lines.push('Do not restate the phase graph or the script.');
  } else if (outcome.status === 'stopped') {
    if (outcome.reason === 'user') {
      lines.push('The user stopped this workflow on purpose. Do not resume it with ResumeWorkflowRun and do not amend or rebuild it unless the user asks you to.');
    } else if (outcome.reason === 'model') {
      // The tool name is the port's stop entry: upstream has no StopWorkflowRun and stops a run
      // through its generic background-task tool, so the guidance names the tool this assembly has.
      lines.push("You stopped this workflow with StopWorkflowRun. If you stopped it to fix the script, do that now: call AmendWorkflow with this run's ID and the corrected script — everything that settled before the stop is imported as cache, and the sooner the fix runs the less it re-pays. (Next time, amend the running run directly: AmendWorkflow stops it for you.)");
    } else if (outcome.reason === 'provider') {
      lines.push('A provider-side error stopped this run; the <error> block above names the cause and the fix.');
      lines.push(`Then resolve the cause with the user before calling ResumeWorkflowRun with run_id="${entry.meta.id}" — finished steps replay from the journal. Do not rebuild the workflow.`);
    } else if (outcome.reason === 'superseded') {
      lines.push('This run was stopped because you amended it: a newer run supersedes it and is already running. Do not resume this run and do not amend it again; wait for the successor\'s notification.');
    } else if (outcome.reason === 'interrupted') {
      lines.push('The process that owned this run exited before it finished.');
      lines.push(`Then call ResumeWorkflowRun with run_id="${entry.meta.id}" — finished steps replay from the journal and only the unfinished ones run again.`);
    } else {
      lines.push('This workflow was stopped before it finished.');
      lines.push(`It can be continued with ResumeWorkflowRun (run_id="${entry.meta.id}"); ask the user before resuming a run you did not stop yourself.`);
    }
  } else {
    lines.push('The workflow script failed.');
    lines.push(`Fix the script and submit it with AmendWorkflow (run_id="${entry.meta.id}") so finished work is reused. ResumeWorkflowRun will refuse this run: replaying the same script would fail the same way.`);
  }
  if (artifacts.length > 0) {
    lines.push('Artifacts listed above are already in front of the user as cards; refer to them by title and do not paste their contents. The one marked primary is the deliverable: point the user to it first.');
  }
  return lines.join('\n');
}

/** 供测试与接线用的常量出口。 */
export {
  ARTIFACT_CAPS, REPORT_CAPS, RUNTIME_CAPS, WORKSPACE_CAPS, ASK_BUDGET, ConcurrencyController,
  defaultMaxConcurrency, transientBackoffMs,
};

/** 引擎类也导出：单测可以直接构造它（不需要完整 runtime），dev-host 若要复用调度也可用。 */
export { WorkflowEngine };

/**
 * 快照里 `holes` 的上限（契约 `cli.md:174`：max 32）。等待中的留白永远保留在前——那是要点
 * `FillWorkflowHole` 的行；被截掉的是已填完的历史（留白按契约不能在扇出里并发，所以等待中的
 * 行数本来就极少）。
 * @param {object[]} rows
 * @returns {object[]}
 */
function capHoleRows(rows) {
  const limit = RUNTIME_CAPS.maxSnapshotHoles;
  if (rows.length <= limit) return rows;
  const waiting = rows.filter((row) => row.state === 'waiting').slice(-limit);
  const filled = rows.filter((row) => row.state !== 'waiting').slice(-(limit - waiting.length));
  return [...waiting, ...filled].slice(-limit);
}
