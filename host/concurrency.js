/**
 * 并发调控器与运行期上限常量。
 *
 * 这是 G2 宿主引擎的并发算法移植（`beauty/zcode-cli.js:651452-651641` `ConcurrencyController`）：
 * 每个 run 一个 cap，成功 streak 到 4 次且还有排队者时 +1（加性增长），被限流时乘性下降
 * （有 lastGood 就回到 lastGood，否则 ×0.75），限流可带 cooldownUntil；空闲 5 分钟后整体复位。
 *
 * 为什么单独成模块：增长/下降/冷却都是纯函数式状态迁移，可脱离 run 单测；引擎只负责把
 * `change()` 产出的迁移写成 `concurrency-changed` 事件（engine.md §2.2）。
 */

/** 由 validation.js:8353-8378 抄录的运行态上限（host 与 UI 共用同一组数字）。 */
export const RUNTIME_CAPS = Object.freeze({
  maxRuns: 8,
  maxActors: 1024,
  maxNodes: 1024,
  maxTotalEntries: 6144,
  maxReports: 64,
  maxReportPreviewLength: 2048,
  maxResultPreviewLength: 2048,
  maxErrorLength: 2048,
  maxPendingQuestions: 32,
  maxQuestionLength: 2048,
  maxConcurrencyKeyLength: 256,
  maxSubagentModelLength: 256,
  maxSessionIdLength: 256,
  maxConcurrencyCeiling: 1024,
  maxActorNameLength: 128,
  maxArtifacts: 32,
  maxPhases: 32,
  maxPhaseNameLength: 128,
  maxHoles: 32,
  maxHoleTypeLength: 128,
  maxHolePromptLength: 500,
  maxInstructionsHeadLength: 240,
  maxLastToolNameLength: 64,
  maxLastToolTargetLength: 120,
});

/** `report()` 的三条上限（cli:427810-427814 `VZ`）。 */
export const REPORT_CAPS = Object.freeze({
  maxItemsPerRun: 65536,
  maxItemSerializedBytes: 1048576,
  maxBytesPerRun: 1073741824,
});

/** 产物上限（cli:427820-427830 `J_`）。 */
export const ARTIFACT_CAPS = Object.freeze({
  maxArtifactsPerRun: 32,
  maxVersionsPerArtifact: 16,
  maxFileBytes: 20971520,
  maxMarkdownBytes: 262144,
  maxTitleLength: 120,
  maxDescriptionLength: 500,
  maxSpecSerializedBytes: 8192,
  maxIdLength: 64,
});

/** facade 的 id 字符集（cli:427830 `r8e`）。 */
export const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_.-]+$/u;

/** files/git/world 的读取上限（cli:427795-427805 `qP`）。 */
export const WORKSPACE_CAPS = Object.freeze({
  globMaxFiles: 2000,
  grepMaxMatches: 2000,
  grepMaxSerializedBytes: 262144,
  gitDiffMaxBytes: 524288,
  gitLogMaxCount: 100,
  gitLogDefaultCount: 20,
  runStdoutMaxBytes: 16777216,
  runStderrMaxBytes: 16777216,
  runDefaultTimeoutMs: 300000,
});

/** 单个 ask 的预算（cli:649161 `Nkt/Kwe/Lkt`）。 */
export const ASK_BUDGET = Object.freeze({
  instructionsHead: 4096,
  repairs: 3,
  nudges: 1,
});

/** 模型请求瞬断退避（cli:739867-739871 `mmi/k_c/x_c`）。 */
export const TRANSIENT_BACKOFF = Object.freeze({
  baseMs: 2000,
  maxMs: 60000,
  /** 单条瞬断原因的抑制窗口，避免同一原因刷屏。 */
  suppressMs: 2000,
});

/** 空闲复位窗口（`idleReset`）。 */
export const IDLE_RESET_MS = 300000;

/**
 * ZCode 的默认并行上限：`clamp(cores - 2, 4, 16)`。
 * @param {number} cores
 * @returns {number}
 */
export function defaultMaxConcurrency(cores) {
  return Math.min(16, Math.max(4, Math.floor(cores) - 2));
}

/**
 * 瞬时失败的退避时长：`min(60000, 2000 * 2^(attempt-1))`，再乘 `0.5 + 0.5 * random`（`gmi`）。
 * @param {number} attempt 1 起的重试序号
 * @param {() => number} [random]
 * @returns {number}
 */
export function transientBackoffMs(attempt, random = Math.random) {
  const ceiling = Math.min(TRANSIENT_BACKOFF.maxMs, TRANSIENT_BACKOFF.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + 0.5 * random()));
}

/**
 * 一个 key（run）的并发窗口。
 *
 * 语义与原实现逐条一致：
 * - `canAdmit(now)`：在飞数未到 cap，且不在冷却期。
 * - `succeeded(now, epoch)`：streak ≥ 4、有排队者、未到增长上限时 cap +1，产出 `recovered`。
 * - `throttled(now, epoch, reason, cooldownMs)`：有 lastGood 就回落，否则 ×0.75；epoch 自增使在飞请求
 *   的成功不再计入新窗口（它们是旧 cap 下发出的）。
 * - `setGrowthLimit`：amend 改小上限时立即收敛。
 * - `seed`：从 journal 恢复时按记录的上限起跳，但最近 5 分钟内被限流过就不跳。
 * - `idleReset`：5 分钟无请求且在飞为 0 时整体复位。
 */
export class ConcurrencyController {
  /**
   * @param {string} key
   * @param {number} initial
   * @param {number} [growthLimit]
   * @param {() => number} [now]
   */
  constructor(key, initial, growthLimit = initial, now = Date.now) {
    this.key = key;
    this.initial = Math.max(1, Math.floor(initial));
    this.cap = this.initial;
    this.growthLimit = Math.max(this.initial, Math.floor(growthLimit));
    this.now = now;
    this.epoch = 0;
    this.inFlight = 0;
    this.waiters = 0;
    this.successStreak = 0;
    this.cooldownUntil = undefined;
    this.lastRequestAt = undefined;
    this.lastGood = undefined;
    this.lastBad = undefined;
    this.lastThrottledAt = undefined;
  }

  /** @returns {object} 供 `health.concurrency` / `concurrency-changed` 使用的快照。 */
  snapshot() {
    return {
      key: this.key,
      initial: this.initial,
      growthLimit: this.growthLimit,
      cap: this.cap,
      epoch: this.epoch,
      inFlight: this.inFlight,
      waiters: this.waiters,
      successStreak: this.successStreak,
      ...(this.cooldownUntil === undefined ? {} : { cooldownUntil: this.cooldownUntil }),
      ...(this.lastRequestAt === undefined ? {} : { lastRequestAt: this.lastRequestAt }),
      ...(this.lastGood === undefined ? {} : { lastGood: this.lastGood }),
      ...(this.lastBad === undefined ? {} : { lastBad: this.lastBad }),
      ...(this.lastThrottledAt === undefined ? {} : { lastThrottledAt: this.lastThrottledAt }),
    };
  }

  /**
   * @param {number} [now]
   * @returns {boolean}
   */
  canAdmit(now = this.now()) {
    return this.inFlight < this.cap && (this.cooldownUntil === undefined || now >= this.cooldownUntil);
  }

  /**
   * @param {number} [now]
   * @returns {object[]} 需要写出的迁移
   */
  observe(now = this.now()) {
    return this.idleReset(now);
  }

  /**
   * @param {number} now
   * @returns {number} 本次请求所属 epoch
   */
  admitted(now = this.now()) {
    this.lastRequestAt = now;
    this.inFlight += 1;
    return this.epoch;
  }

  /**
   * @param {number} now
   * @param {number} epoch 请求发出时的 epoch
   * @returns {object[]}
   */
  succeeded(now, epoch) {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (epoch !== this.epoch) return changes;
    this.successStreak += 1;
    if (this.successStreak < 4) return changes;
    if (this.lastGood === undefined || this.cap > this.lastGood) this.lastGood = this.cap;
    if (this.waiters <= 0 || this.cap >= this.growthLimit) return changes;
    const previous = this.cap;
    this.cap = Math.min(this.growthLimit, previous + 1);
    this.successStreak = 0;
    changes.push(this.change(previous, 'recovered'));
    return changes;
  }

  /**
   * @param {number} now
   * @param {number} epoch
   * @param {string} reason
   * @param {number} [cooldownMs]
   * @returns {object[]}
   */
  throttled(now, epoch, reason, cooldownMs) {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.successStreak = 0;
    this.lastThrottledAt = now;
    const cooldown = typeof cooldownMs === 'number' && cooldownMs > 0 ? cooldownMs : undefined;
    if (cooldown !== undefined) this.cooldownUntil = Math.max(this.cooldownUntil ?? 0, now + cooldown);
    if (epoch !== this.epoch) return changes;
    const previous = this.cap;
    if (this.lastGood !== undefined && this.cap > this.lastGood) {
      this.lastBad = this.cap;
      this.cap = this.lastGood;
    } else {
      this.cap = Math.max(1, Math.floor(this.cap * 0.75));
      this.lastBad = previous;
      this.lastGood = undefined;
    }
    this.epoch += 1;
    if (previous !== this.cap || cooldown !== undefined) changes.push(this.change(previous, reason, cooldown));
    return changes;
  }

  /**
   * @param {number} now
   * @returns {object[]}
   */
  failedTransient(now) {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.successStreak = 0;
    return changes;
  }

  /**
   * @param {number} now
   * @returns {object[]}
   */
  ended(now) {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    return changes;
  }

  /**
   * @param {number} now
   * @param {number} waiters
   * @returns {object[]}
   */
  noteWaiters(now, waiters) {
    const changes = this.idleReset(now);
    this.waiters = Math.max(0, waiters);
    return changes;
  }

  /**
   * @param {number} now
   * @param {number} limit
   * @returns {object[]}
   */
  setGrowthLimit(now, limit) {
    const changes = this.idleReset(now);
    this.growthLimit = Math.max(this.initial, Math.floor(limit));
    if (this.cap <= this.growthLimit) return changes;
    const previous = this.cap;
    this.cap = this.growthLimit;
    if (this.lastGood !== undefined && this.lastGood > this.cap) this.lastGood = this.cap;
    this.successStreak = 0;
    this.epoch += 1;
    changes.push(this.change(previous, 'limit_lowered'));
    return changes;
  }

  /**
   * @param {number} now
   * @param {number} limit
   * @returns {object[]}
   */
  seed(now, limit) {
    const changes = this.idleReset(now);
    const target = Math.min(this.growthLimit, Math.floor(limit));
    if (target <= this.cap) return changes;
    if (this.lastThrottledAt !== undefined && now - this.lastThrottledAt < IDLE_RESET_MS) return changes;
    const previous = this.cap;
    this.cap = target;
    this.lastGood = undefined;
    this.lastBad = undefined;
    this.successStreak = 0;
    this.epoch += 1;
    changes.push(this.change(previous, 'seeded'));
    return changes;
  }

  /**
   * @param {number} now
   * @returns {object[]}
   */
  idleReset(now) {
    if (this.lastRequestAt === undefined || this.inFlight !== 0 || now - this.lastRequestAt < IDLE_RESET_MS) {
      return [];
    }
    const settled = this.cap === this.initial
      && this.successStreak === 0
      && this.cooldownUntil === undefined
      && this.lastGood === undefined
      && this.lastBad === undefined
      && this.lastThrottledAt === undefined;
    if (settled) return [];
    const previous = this.cap;
    this.cap = this.initial;
    this.successStreak = 0;
    this.cooldownUntil = undefined;
    this.lastGood = undefined;
    this.lastBad = undefined;
    this.lastThrottledAt = undefined;
    this.epoch += 1;
    return previous === this.cap ? [] : [this.change(previous, 'idle_reset')];
  }

  /**
   * @param {number} previous
   * @param {string} reason
   * @param {number} [cooldownMs]
   * @returns {object}
   */
  change(previous, reason, cooldownMs) {
    return {
      key: this.key,
      previous,
      next: this.cap,
      reason,
      ...(this.lastGood === undefined ? {} : { lastGood: this.lastGood }),
      ...(this.lastBad === undefined ? {} : { lastBad: this.lastBad }),
      ...(cooldownMs === undefined ? {} : { cooldownMs }),
    };
  }
}
