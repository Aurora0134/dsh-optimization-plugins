/**
 * 运行事件日志（对应 ZCode 3.17.2 的 `dwf_event` 表）。
 *
 * 设计约束来自契约（notes/engine.md §2.3、§2.5、§4.2）：
 * - 追加即真源：事件只增不改，`sequence` 在每个 run 内从 0 连续自增（SQL 里是
 *   `coalesce(max(sequence)+1, 0)`）；
 * - `afterSequence` 是排他下界（`sequence > ?`）；
 * - 分页同时受行数与字节数约束：行数上限 500、字节预算 4 MiB；**首行永远返回完整 payload**，
 *   即使它自己超过字节预算，否则客户端会卡在同一条事件上无法前进；
 * - `lastEventSequence` 是水位，供轮询与 reducer 判断 `advancesWaterMark`。
 *
 * 落盘用 JSONL 等价映射 `dwf_event(id, run_id, sequence, type, payload_json, time_created)`：
 * 一行一个 `{sequence, type, payload, time_created}`。读取时把 payload 摊平回事件对象，
 * 这样旧的扁平日志（没有 sequence）也能继续读。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 26 种事件类型（notes/engine.md §2.1 全集）。 */
export const EVENT_TYPES = Object.freeze({
  RUN_STARTED: 'run-started',
  RUN_LAUNCHED: 'run-launched',
  ACTOR_CREATED: 'actor-created',
  NODE_QUEUED: 'node-queued',
  NODE_DISPATCHED: 'node-dispatched',
  NODE_EXECUTING: 'node-executing',
  NODE_WAITING: 'node-waiting',
  NODE_REPAIRING: 'node-repairing',
  NODE_NUDGED: 'node-nudged',
  NODE_SETTLED: 'node-settled',
  NODE_PROGRESS: 'node-progress',
  REPORT: 'report',
  ARTIFACT_PUBLISHED: 'artifact-published',
  ARTIFACT_FAILED: 'artifact-failed',
  USAGE_UPDATED: 'usage-updated',
  ESCALATION_RAISED: 'escalation-raised',
  ESCALATION_RESOLVED: 'escalation-resolved',
  CONCURRENCY_CHANGED: 'concurrency-changed',
  RUN_CAPS_CHANGED: 'run-caps-changed',
  PHASE_ENTERED: 'phase-entered',
  HOLE_REACHED: 'hole-reached',
  HOLE_FILLED: 'hole-filled',
  RUN_SETTLED: 'run-settled',
  RUN_STALLED: 'run-stalled',
  LOG: 'log',
  IMPORT_CACHE_CLOSED: 'import-cache-closed',
});

/** 事件类型的有序表；用于校验、测试与文档生成。 */
export const WORKFLOW_EVENT_TYPES = Object.freeze(Object.values(EVENT_TYPES));

/** 事件类型集合，便于 O(1) 判断。 */
export const WORKFLOW_EVENT_TYPE_SET = Object.freeze(new Set(WORKFLOW_EVENT_TYPES));

/** `workflowRunEvents` 的默认与最大行数（§1.1(2)）。 */
export const DEFAULT_EVENT_LIMIT = 500;
/** `workflowRunEvents` 的字节预算：4 MiB（§2.5）。 */
export const MAX_EVENT_PAGE_BYTES = 4 * 1024 * 1024;

/**
 * 归一化事件条数：默认 500，超出上限按 500 处理，非法值同样按默认值处理。
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function normalizeEventLimit(raw) {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_EVENT_LIMIT;
  return Math.min(Math.floor(value), DEFAULT_EVENT_LIMIT);
}

/**
 * 归一化 `afterSequence`：缺省返回 undefined（表示从头读），负数/非整数视为缺省。
 *
 * @param {unknown} raw
 * @returns {number | undefined}
 */
export function normalizeAfterSequence(raw) {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

/**
 * 一条日志行的 payload 字节数。SQL 用 `octet_length(payload_json)`，这里用 UTF-8 字节数等价。
 *
 * @param {unknown} payload
 * @returns {number}
 */
function payloadByteLength(payload) {
  try {
    const text = JSON.stringify(payload ?? null);
    return Buffer.byteLength(text ?? 'null', 'utf8');
  } catch {
    return Buffer.byteLength(String(payload ?? ''), 'utf8');
  }
}

/**
 * 把一条已存储的事件摊平成调用方熟悉的形状。
 *
 * @param {{ sequence?: number, type?: string, payload?: unknown, time_created?: number }} row
 * @param {number} fallbackSequence
 * @returns {Record<string, any>}
 */
function flattenRow(row, fallbackSequence) {
  const payload = row.payload !== null && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? /** @type {Record<string, any>} */ (row.payload)
    : {};
  const sequence = Number.isInteger(row.sequence) && row.sequence >= 0 ? row.sequence : fallbackSequence;
  const type = typeof row.type === 'string' && row.type !== ''
    ? row.type
    : (typeof payload.type === 'string' ? payload.type : 'log');
  const timeCreated = Number.isFinite(row.time_created) ? /** @type {number} */ (row.time_created) : 0;
  return {
    ...payload,
    sequence,
    type,
    payload,
    at: timeCreated,
    time_created: timeCreated,
  };
}

/**
 * 在一组已按 sequence 排序的事件上做行数 + 字节双预算分页。
 *
 * 语义严格对齐 §2.5 的 SQL：第一行无条件返回（保底前进一条）；从第二行起，只有
 * `rowNumber <= limit` 且累计字节数不超过预算才返回；一旦某行被拒，它和其后的全部行都
 * 丢弃，`hasMore=true`。这里的字节数按 `payload` 的 JSON UTF-8 长度计算。
 *
 * @param {{ sequence: number, payload?: unknown }[]} events 已排序的事件
 * @param {{ afterSequence?: number, limit?: number, maxBytes?: number }} [options]
 * @returns {{ events: Record<string, any>[], hasMore: boolean, lastEventSequence: number }}
 */
export function pageEvents(events, options = {}) {
  const afterSequence = normalizeAfterSequence(options.afterSequence);
  const limit = normalizeEventLimit(options.limit);
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(/** @type {number} */ (options.maxBytes))
    : MAX_EVENT_PAGE_BYTES;

  const ordered = [...(events ?? [])]
    .filter((event) => Number.isInteger(event?.sequence) && event.sequence >= 0)
    .sort((left, right) => left.sequence - right.sequence)
    .filter((event) => afterSequence === undefined || event.sequence > afterSequence);

  /** @type {Record<string, any>[]} */
  const page = [];
  let bytes = 0;
  let hasMore = false;
  for (let index = 0; index < ordered.length; index += 1) {
    const event = ordered[index];
    const size = payloadByteLength(event.payload ?? event);
    const withinRows = index + 1 <= limit;
    const withinBytes = bytes + size <= maxBytes;
    if (index > 0 && (!withinRows || !withinBytes)) {
      hasMore = true;
      break;
    }
    page.push(event);
    bytes += size;
  }

  return {
    events: page,
    hasMore,
    lastEventSequence: page.length > 0 ? page[page.length - 1].sequence : Math.max(0, afterSequence ?? 0),
  };
}

/**
 * 一个 run 的 JSONL 事件日志。
 *
 * 同一进程内的 append 通过 promise 链串行化，保证并发 `record()` 不会拿到重复 sequence；
 * 跨进程并发不在保证范围内（ZCode 用 SQLite 事务，这里用等价 JSON 文件实现）。
 */
export class Journal {
  /**
   * @param {{ file: string }} options `file` 是 journal.jsonl 的绝对路径
   */
  constructor({ file }) {
    this.file = file;
    /** @type {Promise<unknown>} */
    this.tail = Promise.resolve();
    /** @type {number | undefined} */
    this.cachedWatermark = undefined;
  }

  /**
   * 读取原始行；损坏的行（崩溃时常见的半行）直接跳过，不能拖垮整个 run。
   *
   * @returns {Promise<{ sequence: number, type: string, payload: unknown, time_created: number }[]>}
   */
  async readRows() {
    let text;
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    /** @type {{ sequence: number, type: string, payload: unknown, time_created: number }[]} */
    const rows = [];
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      const record = /** @type {Record<string, any>} */ (parsed);
      if (Number.isInteger(record.sequence)) {
        rows.push({
          sequence: record.sequence,
          type: typeof record.type === 'string' ? record.type : 'log',
          payload: record.payload ?? record,
          time_created: Number.isFinite(record.time_created)
            ? record.time_created
            : (Number.isFinite(record.at) ? record.at : 0),
        });
      } else {
        // 旧版日志没有 sequence：按"有效行"补号，保证升级后仍然连续。
        rows.push({
          sequence: rows.length,
          type: typeof record.type === 'string' ? record.type : 'log',
          payload: record,
          time_created: Number.isFinite(record.at) ? record.at : 0,
        });
      }
    }
    rows.sort((left, right) => left.sequence - right.sequence);
    return rows;
  }

  /**
   * 读取全部事件，摊平成 `{...payload, sequence, type, at}`。
   *
   * @returns {Promise<Record<string, any>[]>}
   */
  async readAll() {
    const rows = await this.readRows();
    return rows.map((row) => flattenRow(row, row.sequence));
  }

  /**
   * 追加一条事件，返回存储行。`sequence` 由日志分配，调用方传入的旧 sequence 会被忽略。
   *
   * @param {Record<string, any>} event 事件对象；payload 就是事件自身（`type` 保留在 payload 内）
   * @returns {Promise<{ sequence: number, type: string, payload: Record<string, any>, time_created: number }>}
   */
  async append(event) {
    const job = this.tail.then(() => this.appendNow(event));
    // 即使本次 append 失败，也不能让后续 append 永久排队在 rejected promise 上。
    this.tail = job.catch(() => undefined);
    return job;
  }

  /**
   * @param {Record<string, any>} event
   */
  async appendNow(event) {
    const rows = await this.readRows();
    const last = rows.length === 0 ? -1 : rows[rows.length - 1].sequence;
    // 旧日志的行号与 sequence 可能不一致：取两者最大值保证严格递增。
    const sequence = Math.max(last + 1, rows.length);
    const { sequence: _ignoredSequence, ...rest } = event ?? {};
    const payload = { ...rest };
    const type = typeof payload.type === 'string' && payload.type !== '' ? payload.type : 'log';
    const timeCreated = Number.isFinite(payload.at)
      ? /** @type {number} */ (payload.at)
      : (Number.isFinite(payload.time_created) ? /** @type {number} */ (payload.time_created) : Date.now());
    const row = { sequence, type, payload, time_created: timeCreated };
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.appendFile(this.file, `${JSON.stringify(row)}\n`, 'utf8');
    this.cachedWatermark = Math.max(this.cachedWatermark ?? 0, sequence);
    return row;
  }

  /**
   * 水位：已存储事件的最大 sequence；空日志为 0（快照字段要求 >=0）。
   *
   * @returns {Promise<number>}
   */
  async watermark() {
    if (this.cachedWatermark !== undefined) return this.cachedWatermark;
    const rows = await this.readRows();
    this.cachedWatermark = rows.length === 0 ? 0 : rows[rows.length - 1].sequence;
    return this.cachedWatermark;
  }

  /**
   * 分页读取，响应对象即 `workflowRunEvents` 的线上形态。
   *
   * @param {{ afterSequence?: unknown, limit?: unknown, maxBytes?: number }} [options]
   * @returns {Promise<{ events: Record<string, any>[], hasMore: boolean, lastEventSequence: number }>}
   */
  async page(options = {}) {
    const rows = await this.readRows();
    const watermark = rows.length === 0 ? 0 : rows[rows.length - 1].sequence;
    const qued = pageEvents(rows, options);
    return {
      events: qued.events.map((row) => ({
        sequence: row.sequence,
        type: row.type,
        payload: row.payload,
      })),
      hasMore: qued.hasMore,
      // 水位取整个日志的最大值：客户端用 lastEventSequence 作为下一次的 afterSequence，
      // 若只给本页最后一条，空页会导致水位倒退。
      lastEventSequence: Math.max(watermark, qued.lastEventSequence),
    };
  }
}

/**
 * 便捷构造器，避免调用方关心文件命名。
 *
 * @param {string} runDir
 * @returns {Journal}
 */
export function createJournal(runDir) {
  return new Journal({ file: path.join(runDir, 'journal.jsonl') });
}
