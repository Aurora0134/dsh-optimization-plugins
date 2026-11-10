/**
 * facade 的宿主侧：cell 发来的 JSON 消息在这里变成引擎调用，结果/错误再按协议回给 cell。
 *
 * 为什么 facade 与引擎分两层：
 * - 协议层（本文件）只负责「名字 → 调用」和「异常 → wire 错误」，它不知道节点状态机、并发、
 *   journal 长什么样，因此可以用一个假引擎做单测；
 * - 引擎层（runtime.js）只暴露动作（createActor/ask/worldRead/…），不解析 JSON。
 *
 * facade 的完整 API 集合（§2 全集，cell 引导脚本挂到 `__host` 上）：
 * - `args` / `run`：值（浅冻结）
 * - `createActor(name?, persona?)` ← `agent(...)`
 * - `ask(siteId, actor, instructions)` ← `a.ask<T>(…)`
 * - `worldRead(siteId, op, args)` ← `files.*` / `git.*` / `world.run`
 * - `publishArtifact(siteId, op, args)` ← `artifact.file/markdown`
 * - `declareArtifact(siteId, op, args)` ← `artifact.chart/table/metrics/board`
 * - `report(siteId, item, artifactId?)` / `log(message)` / `enterPhase(name)` / `hole(...)`
 * - `channel(name?)` / `future(body)`：cell 内实现（streams 引导脚本）
 *
 * 旧版 `Workflow` 工具的 facade（`agent(prompt, opts)`、`parallel`、`pipeline`、`budget`、
 * `workflow`）在现行实现里**不存在**，这里既不实现也不导出；脚本里写它们会得到
 * ReferenceError / 编译期「不存在」诊断。
 */

/** `__host` 上的键全集（cell 引导脚本挂载的那一组）。 @type {readonly string[]} */
export const HOST_API_KEYS = Object.freeze([
  'args', 'run', 'createActor', 'ask', 'worldRead', 'publishArtifact', 'declareArtifact',
  'report', 'log', 'enterPhase', 'hole', 'channel', 'future',
]);

/** 脚本可见的 facade 全局名（`__host` 之外由 cell 引导脚本补上的 `channel`/`future`）。 */
export const FACADE_GLOBALS = Object.freeze([
  'agent', 'phase', 'report', 'artifact', 'files', 'git', 'world', 'channel', 'future',
  'hole', 'log', 'model', 'run', 'args',
]);

/**
 * 引擎动作的 wire 错误：把宿主异常压成 cell 能 catch 的结构。
 *
 * 为什么保留 `name`：脚本常按 `err.name === 'ValidationFailed'` 分支；`code` 是宿主内部
 * 稳定码，`violations`/`finalText` 只在 typed ask 失败时出现（与原实现 736906-736913 一致）。
 *
 * @param {unknown} error
 * @returns {{ name: string, message: string, code?: string, violations?: unknown, finalText?: string }}
 */
export function toWireError(error) {
  if (error !== null && typeof error === 'object') {
    const record = /** @type {Record<string, unknown>} */ (error);
    const wire = {
      name: typeof record.name === 'string' ? record.name : 'Error',
      message: typeof record.message === 'string' ? record.message : String(error),
    };
    if (typeof record.code === 'string') wire.code = record.code;
    if (record.violations !== undefined) wire.violations = record.violations;
    if (typeof record.finalText === 'string') wire.finalText = record.finalText;
    return wire;
  }
  return { name: 'Error', message: String(error) };
}

/**
 * 建立 cell ↔ 引擎的桥。
 *
 * @param {object} options
 * @param {object} options.engine 引擎动作集合（runtime.js 的 WorkflowEngine）
 * @param {{ deliver: (response: object) => void }} options.cell
 * @param {(event: object) => void} [options.onEvent] 事件观察（run 列表/通知用，可选）
 * @returns {{ handle: (message: object) => void, onComplete: (outcome: object) => void, setCompleteHandler: (fn: (outcome: object) => void) => void, pendingRequests: () => number }}
 */
export function createFacadeBridge({ engine, cell, onEvent }) {
  /** cell 的 localId（`local#1`）→ 引擎 actor 句柄 */
  const actors = new Map();
  let completeHandler = () => {};
  let pending = 0;

  /**
   * 应答一条 request：成功回 value，失败回 wire 错误。
   * @param {string} id
   * @param {Promise<unknown>} work
   */
  const respond = (id, work) => {
    pending += 1;
    work.then(
      (value) => {
        pending -= 1;
        cell.deliver({ kind: 'response', id, ok: true, value });
      },
      (error) => {
        pending -= 1;
        cell.deliver({ kind: 'response', id, ok: false, error: toWireError(error) });
      },
    );
  };

  /**
   * 处理一条 cell 消息。事件类消息同步处理；请求类消息立即返回、异步应答。
   * @param {object} message
   */
  const handle = (message) => {
    switch (message.kind) {
      case 'create-actor': {
        // 即发即忘：actor 必须在后续 ask 之前登记好，所以这里同步调用（引擎的 createActor 是同步的）。
        try {
          const ref = engine.createActor(message.siteId, message.name, message.persona);
          actors.set(message.localId, ref);
        } catch (error) {
          // 造 actor 失败 = 整个 run 失败（重名等）。引擎内部已 failRun，这里只需不再登记。
          engine.fail?.(error);
        }
        return;
      }
      case 'request': {
        if (message.type === 'ask') {
          const actor = actors.get(message.actor);
          if (actor === undefined) {
            respond(message.id, Promise.reject(Object.assign(new Error(`unknown subagent handle: ${message.actor}`), { name: 'WorkflowError', code: 'UnknownActor' })));
            return;
          }
          respond(message.id, engine.ask(message.siteId, actor, message.instructions));
          return;
        }
        if (message.type === 'world-read') {
          respond(message.id, engine.worldRead(message.siteId, message.op, message.args ?? []));
          return;
        }
        if (message.type === 'publish-artifact') {
          respond(message.id, engine.publishArtifact(message.siteId, message.artifactOp, message.args ?? []));
          return;
        }
        if (message.type === 'hole') {
          respond(message.id, engine.hole(message.siteId, message.name, message.prompt));
          return;
        }
        respond(message.id, Promise.reject(Object.assign(new Error(`unknown request type: ${message.type}`), { name: 'DriverError', code: 'UnknownRequest' })));
        return;
      }
      case 'event': {
        onEvent?.(message);
        if (message.type === 'log') {
          engine.log(String(message.message ?? ''));
          return;
        }
        if (message.type === 'phase-entered') {
          engine.enterPhase(String(message.name ?? ''));
          return;
        }
        if (message.type === 'report') {
          engine.report(message.siteId, message.item, message.artifactId);
          return;
        }
        if (message.type === 'declare-artifact') {
          engine.declareArtifact(message.siteId, message.op, message.args ?? []);
          return;
        }
        return;
      }
      case 'complete': {
        // cell 的终局：转交 run 收尾（成功值 / 结构化错误）。
        completeHandler(message);
        return;
      }
      default:
        return;
    }
  };

  return {
    handle,
    setCompleteHandler: (fn) => {
      completeHandler = fn;
    },
    pendingRequests: () => pending,
  };
}
