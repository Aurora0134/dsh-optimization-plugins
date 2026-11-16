/**
 * 脚本 cell：工作流脚本真正执行的地方（G3 脚本侧运行时）。
 *
 * 移植对象：`beauty/zcode-cli.js:736641-737024`（`zpi` 流水线引导 + `qpi` cell 引导 + `start`）。
 * 那里脚本跑在**独立 node 子进程**的 `node:vm` context 里，宿主与 cell 之间走 newline-delimited
 * JSON 的 stdio 协议。本插件没有起子进程（要让一个 subagent 驱动的 run 与宿主同生命周期、
 * 可单测、可在插件内被停止），所以这里保留 **vm context 隔离 + 同一套 JSON 协议**，只把传输层
 * 换成进程内的同步回调：
 *
 * | 原实现 | 这里 |
 * | --- | --- |
 * | `stdout.write(line)` | `__send` → `onMessage(JSON.parse(line))` |
 * | `stdin` 行 → `context.__deliver(line)` | `cell.deliver(obj)` → `context.__deliver(JSON.stringify(obj))` |
 * | `setImmediate(checkStalled)`（外层 realm） | 同一写法，`checkStalled` 由宿主在每次投递后与启动后调用 |
 *
 * 与真子进程的**已知差异**（不是遗漏，是环境决定）：
 * 1. 没有进程级崩溃/内存隔离：脚本若把 V8 堆打爆会带走宿主进程。子进程版可以设
 *    `maxOldSpaceSizeMb` 并用退出码兜底。
 * 2. 没有 stdin 关闭这一步：cell 的「关流」就是 `__settled` 已成，宿主不再投递。
 * 3. cell 内拿不到 `process`/`require`（vm context 里没有），与子进程版一致；但宿主 realm 的
 *    intrinsics 在 vm 里是被复制过的另一套，跨 realm 传值时仍按 JSON 语义（协议本身就是 JSON）。
 *
 * 协议（与原实现一致）：
 * - cell→宿主：`{kind:'event', type:'log'|'phase-entered'|'report'|'declare-artifact', …}`
 * - cell→宿主：`{kind:'create-actor', localId, siteId, name, persona}`（即发即忘）
 * - cell→宿主：`{kind:'request', id:'r<n>', type:'ask'|'world-read'|'hole'|'publish-artifact', …}`
 * - cell→宿主：`{kind:'complete', ok:true, value}` / `{kind:'complete', ok:false, error:{…}}`
 * - 宿主→cell：`{kind:'response', id, ok:true, value}` / `{kind:'response', id, ok:false, error:{…}}`
 */

import vm from 'node:vm';

/**
 * cell 引导脚本（`qpi`）。逐字移植，只去掉 stdio 相关部分——`__send` 由 context 注入。
 * @type {string}
 */
export const CELL_BOOTSTRAP = String.raw`
"use strict";

var __nextLocal = 0;
var __nextReq = 0;
var __pending = new Map();
// 本世已补全的留白：站点 id → 体的文本。同一站点再次到达（循环）时直接求值，不再过线。
var __fills = new Map();

function __emit(obj) {
  __send(JSON.stringify(obj));
}

function __createActor(siteId, name, persona) {
  // 同步造 child-local 句柄并即发即忘 create-actor；宿主按到达顺序在后续 ask 前完成映射。
  var localId = "local#" + (++__nextLocal);
  __emit({ kind: "create-actor", localId: localId, siteId: siteId, name: name, persona: persona });
  return localId;
}

function __ask(siteId, actor, instructions) {
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "ask", siteId: siteId, actor: actor, instructions: instructions });
  });
}

function __worldRead(siteId, op, args) {
  // args 是 lowering 打包好的位置实参数组；本 shim 原样透传，不看 op、不校验元数（归宿主）。
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "world-read", siteId: siteId, op: op, args: args });
  });
}

function __evaluateFill(evaluate, code) {
  // evaluate 是 lowering 在站点处发出的 (__src) => eval(__src)：直接 eval，闭包住作者代码在
  // 那一点的全部绑定（__host 在内），求出 (async () => { … }) 这个函数；调它，结果即留白的值。
  // 每次到达都新造一个 evaluate，循环里的留白因此看见各轮自己的绑定。
  return Promise.resolve().then(function () {
    return evaluate(code)();
  });
}

function __hole(siteId, name, prompt, evaluate, body) {
  // 已补全（体就在脚本里）：直接调体，不过线。同步抛出转成拒绝，与 future 同规。
  if (body !== undefined) {
    try {
      return Promise.resolve(body());
    } catch (e) {
      return Promise.reject(e);
    }
  }
  var remembered = __fills.get(siteId);
  if (remembered !== undefined) return __evaluateFill(evaluate, remembered);
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "hole", siteId: siteId, name: name, prompt: prompt });
  }).then(function (answer) {
    __fills.set(siteId, answer.code);
    return __evaluateFill(evaluate, answer.code);
  });
}

function __log(message) {
  __emit({ kind: "event", type: "log", message: String(message) });
}

function __enterPhase(name) {
  // 阶段标记：无站点、不落 journal，只让引擎发一条事件——所以与 log 同走事件通道。
  __emit({ kind: "event", type: "phase-entered", name: String(name) });
}

function __publishArtifact(siteId, op, args) {
  // 内容产物是效应：脚本 await 它、要能 catch 它的拒绝，所以与 ask / world-read 同走
  // request/response。args 是 lowering 打包的位置实参（[id, path|content, opts]），原样透传。
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "publish-artifact", siteId: siteId, artifactOp: op, args: args });
  });
}

function __declareArtifact(siteId, op, args) {
  // 预置产物是声明：同步返回 void，没有可等的东西，所以走事件通道。它与 report 共用同一条
  // FIFO——一条打了标签的 report 必须晚于它的声明到达宿主，而顺序正是由这一点保证的。
  __emit({ kind: "event", type: "declare-artifact", siteId: siteId, op: op, args: args });
}

function __report(siteId, item, artifactId) {
  // 即发即忘：脚本从不 await 它，所以走 event 通道而不是 request/response。宿主按 siteId ×
  // ordinal 落一行 journal，故本条消息的**到达顺序**是承重的。
  // item 里若有环，这里的 JSON.stringify 会抛错——就在 report() 的调用点上，脚本要么 catch
  // 要么让 run 失败。
  __emit({ kind: "event", type: "report", siteId: siteId, item: item, artifactId: artifactId });
}

// —— 运行实参（args）与 run 身份 ——
// 在 context **内**用 JSON.parse 构造，所以脚本拿到的是 context-native 对象，外层 realm 的
// intrinsics 一点都不掺进来。Object.freeze 是**浅**冻结（与原实现同一条界限）。
var __args = Object.freeze(JSON.parse(__argsJson));
var __run = Object.freeze(JSON.parse(__runJson));

globalThis.__host = {
  args: __args,
  run: __run,
  createActor: __createActor,
  ask: __ask,
  worldRead: __worldRead,
  publishArtifact: __publishArtifact,
  declareArtifact: __declareArtifact,
  report: __report,
  log: __log,
  enterPhase: __enterPhase,
  hole: __hole,
};

// —— 入站 response 消费（由宿主以行字符串调用）——
globalThis.__deliver = function (line) {
  var msg = JSON.parse(line);
  if (msg.kind !== "response") return;
  var waiter = __pending.get(msg.id);
  if (!waiter) return;
  __pending.delete(msg.id);
  if (msg.ok) {
    waiter.resolve(msg.value);
    return;
  }
  // 拒绝以 context-native Error 过界，带上 code/violations/finalText 供脚本 try/catch 结构化处理。
  var e = msg.error || {};
  var err = new Error(e.message || "workflow host error");
  if (e.name) err.name = e.name;
  if (e.code !== undefined) err.code = e.code;
  if (e.violations !== undefined) err.violations = e.violations;
  if (e.finalText !== undefined) err.finalText = e.finalText;
  waiter.reject(err);
};

// run 是否已发出 complete。停滞检测（streams 引导里的 __checkStalled）也读写它。
var __settled = false;

function __complete(ok, payload) {
  // 幂等：停滞检测已经以 error-complete 结束 run 之后，脚本（理论上）再完成也不再发第二条。
  if (__settled) return;
  __settled = true;
  if (ok) {
    __emit({ kind: "complete", ok: true, value: payload });
    return;
  }
  var wire;
  if (payload instanceof Error) {
    wire = {
      name: payload.name,
      message: payload.message,
      stack: payload.stack,
      code: payload.code,
      violations: payload.violations,
      finalText: payload.finalText,
    };
  } else {
    wire = { name: "Error", message: String(payload) };
  }
  __emit({ kind: "complete", ok: false, error: wire });
}

// 宿主调用它跑脚本；始终 resolve（错误已转成 complete 消息），便于外层收尾。
globalThis.__execute = async function (runFn) {
  try {
    var value = await runFn(globalThis.__host);
    __complete(true, value);
  } catch (e) {
    __complete(false, e);
  }
};

// —— 运行期禁令（belt；编译诊断是 suspenders）——
var __NativeDate = Date;
class __WorkflowDate extends __NativeDate {
  constructor() {
    if (arguments.length === 0) throw new Error("argless new Date() is disabled in workflows");
    super(...arguments);
  }
  static now() {
    throw new Error("Date.now() is disabled in workflows");
  }
  static parse(value) {
    return __NativeDate.parse(value);
  }
  static UTC() {
    return __NativeDate.UTC.apply(__NativeDate, arguments);
  }
}
globalThis.Date = __WorkflowDate;
Math.random = function () {
  throw new Error("Math.random() is disabled in workflows");
};
`;

/**
 * 流水线原语与停滞检测（`zpi`）。channel/future 与 `__checkStalled` 都在这里，
 * 因为它们要被 cell 引导脚本里的 `__host.channel/future` 引用。
 * @type {string}
 */
export const STREAMS_BOOTSTRAP = String.raw`
"use strict";

// —— 流水线原语：channel / future ——
var __channels = [];
var __parkedReceivers = 0;
var __CHANNEL_COMPACT_MIN = 1024;
var __END = Object.freeze({ value: undefined, done: true });

function __channel(name) {
  var label = name === undefined || name === null ? "channel #" + (__channels.length + 1) : String(name);
  var state = { label: label, items: [], head: 0, waiters: [], waitHead: 0, closed: false };
  __channels.push(state);

  function compact() {
    if (state.head >= __CHANNEL_COMPACT_MIN && state.head * 2 >= state.items.length) {
      state.items = state.items.slice(state.head);
      state.head = 0;
    }
    if (state.waitHead >= __CHANNEL_COMPACT_MIN && state.waitHead * 2 >= state.waiters.length) {
      state.waiters = state.waiters.slice(state.waitHead);
      state.waitHead = 0;
    }
  }
  function takeWaiter() {
    if (state.waitHead >= state.waiters.length) return undefined;
    var waiter = state.waiters[state.waitHead];
    state.waiters[state.waitHead] = undefined;
    state.waitHead += 1;
    __parkedReceivers -= 1;
    compact();
    return waiter;
  }
  function next() {
    if (state.head < state.items.length) {
      var item = state.items[state.head];
      state.items[state.head] = undefined;
      state.head += 1;
      compact();
      return Promise.resolve({ value: item, done: false });
    }
    if (state.closed) return Promise.resolve(__END);
    return new Promise(function (resolve) {
      state.waiters.push(resolve);
      __parkedReceivers += 1;
    });
  }
  var channel = {
    send: function (item) {
      if (state.closed) {
        var err = new Error("Channel \"" + state.label + "\" is closed: send() after close(). The stage that produces into a channel owns its close; close it in a finally once every producer has finished.");
        err.name = "ChannelClosed";
        err.code = "ChannelClosed";
        throw err;
      }
      var waiter = takeWaiter();
      if (waiter !== undefined) waiter({ value: item, done: false });
      else state.items.push(item);
    },
    close: function () {
      if (state.closed) return;
      state.closed = true;
      for (var waiter = takeWaiter(); waiter !== undefined; waiter = takeWaiter()) waiter(__END);
    },
  };
  channel[Symbol.asyncIterator] = function () {
    var iterator = {
      next: next,
      return: function () {
        return Promise.resolve(__END);
      },
    };
    iterator[Symbol.asyncIterator] = function () {
      return iterator;
    };
    return iterator;
  };
  return channel;
}

function __future(body) {
  // 立即调用、原样返回其 promise：future 是 async IIFE 的命名形态。同步抛出转成拒绝，
  // 让「一个 stage 的失败」永远走 join 那一条路，而不是从 future() 的调用点同步逃出。
  try {
    var result = body();
    return result instanceof Promise ? result : Promise.resolve(result);
  } catch (e) {
    return Promise.reject(e);
  }
}

// —— 停滞检测 ——
// cell 没有定时器、没有 I/O：能唤醒挂起脚本的只有宿主 response。于是「没有在飞请求、微任务
// 已排空、脚本未完成」就是「永远不会再有任何事发生」。宿主在每条 response 投递之后与
// __execute 起步之后各调一次（setImmediate，在微任务之后），命中即以 error-complete 结束 run。
// 有接收者停在 channel 上时报 ChannelDeadlock 并点名通道；否则报 ScriptStalled。
globalThis.__checkStalled = function () {
  if (__settled || __pending.size > 0) return false;
  var waiting = [];
  for (var i = 0; i < __channels.length; i++) {
    var ch = __channels[i];
    var count = ch.waiters.length - ch.waitHead;
    if (count > 0) waiting.push(count + " on \"" + ch.label + "\"");
  }
  var err;
  if (waiting.length > 0) {
    err = new Error(
      "Deadlock: " + __parkedReceivers + " receiver(s) waiting (" + waiting.join(", ") +
        ") with no request in flight, so nothing can ever send again. Close each channel from the stage that produces into it (ch.close() in a finally) once its producers are done."
    );
    err.name = "ChannelDeadlock";
    err.code = "ChannelDeadlock";
  } else {
    err = new Error(
      "Stalled: the script is suspended with no request in flight and no channel receiver waiting, so nothing can ever resolve what it awaits (a promise that is never settled)."
    );
    err.name = "ScriptStalled";
    err.code = "ScriptStalled";
  }
  __complete(false, err);
  return true;
};

globalThis.__host.channel = __channel;
globalThis.__host.future = __future;
`;

/**
 * 建立一次 cell 执行。
 *
 * @param {object} options
 * @param {string} options.lowered 编译产物（已是 `__host.*` 形式的 JS 函数体语句）
 * @param {Record<string, unknown>} [options.args] 脚本的 `args`
 * @param {{ id: string, resumedFrom?: string }} options.run 脚本的 `run`
 * @param {(message: object) => void} options.onMessage 宿主侧消息处理
 * @param {string} [options.filename] 栈里显示的脚本文件名
 * @returns {{ deliver: (response: object) => void, execute: () => Promise<{ok: boolean, value?: unknown, error?: object}>, checkStalled: () => boolean, isSettled: () => boolean }}
 */
export function createWorkflowCell({ lowered, args, run, onMessage, filename = 'workflow-script.js' }) {
  let settled = false;
  /** @type {(outcome: { ok: boolean, value?: unknown, error?: object }) => void} */
  let resolveComplete;
  const completed = new Promise((resolve) => {
    resolveComplete = resolve;
  });

  const deliverMessage = (message) => {
    if (message.kind === 'complete') {
      if (settled) return;
      settled = true;
      resolveComplete({
        ok: message.ok === true,
        ...(message.ok === true ? { value: message.value } : { error: message.error ?? { name: 'Error', message: 'workflow cell failed' } }),
      });
    }
    try {
      onMessage(message);
    } catch (error) {
      // 宿主侧处理失败不能吞掉：转成 complete 让 run 以 errored 收尾（原实现里宿主异常同样终结 run）。
      if (!settled) {
        settled = true;
        resolveComplete({
          ok: false,
          error: { name: 'Error', message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  };

  const sandbox = {
    __argsJson: JSON.stringify(args ?? {}),
    __runJson: JSON.stringify(run),
    /** cell 的出口：一行 JSON。原实现写 stdout，这里直接交给宿主。 */
    __send: (line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      deliverMessage(parsed);
    },
    // 与真 cell 的差异：原 cell 里 console 不存在；这里把它接到 log 事件上，脚本里残留的
    // console.log 因此变成可见的进度 narration，而不是一条 ReferenceError 把 run 打挂。
    console: {
      log: (...parts) => {
        try {
          sandbox.__send(JSON.stringify({ kind: 'event', type: 'log', message: parts.map((part) => (typeof part === 'string' ? part : safeStringify(part))).join(' ') }));
        } catch {
          // console 永不影响 run
        }
      },
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };

  const context = vm.createContext(sandbox, { name: 'workflow-sandbox' });
  vm.runInContext(CELL_BOOTSTRAP, context, { filename: 'workflow-bootstrap.js' });
  vm.runInContext(STREAMS_BOOTSTRAP, context, { filename: 'workflow-streams.js' });

  let launch;
  try {
    launch = vm.runInContext(`(async (__host) => {\n${lowered}\n})`, context, { filename });
  } catch (error) {
    // 语法/编译期错误：立即以 complete(ok:false) 收尾（原实现同样在这里兜底）。
    settled = true;
    resolveComplete({
      ok: false,
      error: {
        name: error?.name ?? 'SyntaxError',
        message: error?.message ?? String(error),
        stack: error?.stack,
      },
    });
    return {
      deliver: () => {},
      execute: () => completed,
      checkStalled: () => false,
      isSettled: () => true,
    };
  }

  const checkStalled = () => {
    if (settled) return false;
    try {
      return context.__checkStalled() === true;
    } catch {
      return false;
    }
  };

  const deliver = (response) => {
    if (settled) return;
    try {
      context.__deliver(JSON.stringify(response));
    } catch {
      // 投递失败（脚本已结束）不改变 run 的结局
      return;
    }
    setImmediate(() => {
      checkStalled();
    });
  };

  const execute = async () => {
    void context.__execute(launch);
    setImmediate(() => {
      checkStalled();
    });
    return completed;
  };

  return { deliver, execute, checkStalled, isSettled: () => settled };
}

/**
 * cell 内 console 的字符串化（宿主 realm，只用一次）。
 * @param {unknown} value
 * @returns {string}
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
