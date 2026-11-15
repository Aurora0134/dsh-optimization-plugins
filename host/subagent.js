/**
 * 子代理桥：把一次工作流 ask 变成一个 DSH subagent activation。
 *
 * 对应 ZCode 的 actor 运行时（`beauty/zcode-cli.js:735630-735697` 的 `lRt` 配置 +
 * `740452-740564` 的 `createActorSession` + `740566-740632` 的 `startAsk`/回合循环）。
 *
 * ## 与原实现的差异（DSH 能力决定，不是遗漏）
 * 1. **system 段的位置**：ZCode 的 actor 身份是 system 段落（`{name:"Workflow Actor Identity",
 *    injectionTarget:"system", cacheHint:"stable"}`）。DSH 的 `subagents.startActivation` 只有
 *    `prompt`（用户消息），没有独立 system 槽，所以身份段作为提示词开头、用 `---` 与 ask 分隔。
 * 2. **submit_result / escalate 不是真工具**：DSH 子会话不能动态注册工具。typed ask 依赖
 *    schema 尾巴让模型直接给出 JSON（并在可用时用 `outputSchema` 收结构化结果）；
 *    escalate 通道在 runner 上以回调形式暴露，但子代理无法在一轮中途调用它——
 *    只有宿主自己驱动的 runner（测试、或未来支持工具注入的 provider）能真正挂起提问。
 * 3. 一个 activation 一个回合：actor 的跨 ask 上下文由 runtime 在提示词尾部拼接历史
 *    （见 host/runtime.js 文件头偏差 2）。
 *
 * 因此本模块只做三件事：路由模型、拼提示词、把 activation 结果收敛成
 * `{text, structured?, tokens?}`。
 */

import { buildWorkflowActorIdentity } from './prompts.js';

/**
 * 把 ZCode 的模型引用（"providerId/modelId" 或 "modelId"）拆成 DSH 的 agentOptions。
 * 裸模型名沿用调用方 provider（与 ZCode 对裸名的处理一致）。
 * @param {string | undefined} model
 * @returns {{provider?: string, model?: string} | undefined}
 */
export function resolveModelRoute(model) {
  if (typeof model !== 'string' || model.length === 0) return undefined;
  const slash = model.indexOf('/');
  if (slash > 0 && slash < model.length - 1) {
    return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
  }
  return { model };
}

/**
 * 拼接一个 actor 的首段提示词：身份段 + 分隔 + ask 正文。
 *
 * 为什么保留 `---` 分隔：模型把身份段当背景、把分隔之后当任务；没有分隔时它会把
 * 「没有真人可对话」的说明混进结果。
 *
 * @param {{ system?: string, actorName?: string, persona?: string, prompt: string }} request
 * @returns {string}
 */
export function composeActorPrompt({ system, actorName, persona, prompt }) {
  const identity = typeof system === 'string' && system.length > 0
    ? system
    : buildWorkflowActorIdentity({ name: actorName, persona });
  return `${identity}\n\n---\n\n${prompt}`;
}

/**
 * 把 activation 结果的 content blocks 拼成文本。
 * @param {readonly {type: string, text?: string}[]} output
 * @returns {string}
 */
function textOf(output) {
  if (!Array.isArray(output)) return '';
  return output
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * 从 activation 结果里取 token 用量（字段名随 provider 不同，能取到就记）。
 *
 * rc.3 的 `SubagentResult` 只有 `{output, structured, diagnostic, stopReason}`
 * （dsh-subagent/lib/typert.host.js:855-856），所以这几个字段在 rc.3 上恒为 undefined；
 * 真实的用量读口见 {@link childUsageTokens}。保留本函数是为了不改动调用方契约：
 * 将来的 provider 若真的把 usage 放进 result，这里仍能接住。
 *
 * @param {object} result
 * @returns {number | undefined}
 */
function tokensOf(result) {
  const candidates = [
    result?.usage?.totalTokens,
    result?.usage?.total_tokens,
    result?.usage?.outputTokens,
    result?.stats?.tokens?.total,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/** 子会话用量投影的 key（dsh-token-meter/lib/index.js:396）。 */
const USAGE_PROJECTION_KEY = 'tokenUsage';

/**
 * 读这次 activation 真实消耗的 token：子会话自己的用量账本。
 *
 * rc.3 没有把用量放进 `SubagentResult`，但子会话是一等会话，它的 provider 用量按
 * 「每步一次抽样」折进 `tokenUsage` 会话投影（dsh-token-meter/lib/index.js:395-428 注册，
 * usage-projection.js:371-375 从 `assistant/message`/`assistant/attempt` 的 stream 取样本）。
 * 该投影带 wire view，所以不必注册同名单元也能按 key 读：
 * `sessionProjections.snapshot(session, keys)`（dsh-session-projection/lib/index.js:233-247）。
 *
 * 全链路的身份是同一个：`activation.childId` 就是子会话 id（typert.host.js:788、
 * index.js:1496-1524），而 `sessions.get(id)` 是官方按 id 取会话的服务面
 * （index.js:1803 用它查重、ui-api.js:626 用它取会话）。`tokenMeter` 由 dsh-base 挂载
 * （cordis.patch.yml:353-354），且投影表是进程级的（dsh-web-app/cordis.patch.yml:570-572），
 * 所以子会话的账本在桥这一侧可读。
 *
 * 四个桶互不重叠（dsh-token-meter/lib/index.js:781-783 的 usageTokens 就是这套加总），
 * 合计即这次 activation 的花费。读不到一律 undefined：用量是附加信息，
 * 既不能编一个近似值，也不能让 ask 因此失败。
 *
 * @param {object} ctx 插件上下文
 * @param {string | undefined} childId activation 返回的子会话 id
 * @returns {number | undefined}
 */
function childUsageTokens(ctx, childId) {
  if (typeof childId !== 'string' || childId.length === 0) return undefined;
  try {
    const session = ctx?.get?.('sessions')?.get?.(childId);
    if (session === undefined || session === null) return undefined;
    const projections = ctx?.get?.('sessionProjections');
    if (typeof projections?.snapshot !== 'function') return undefined;
    const usage = projections.snapshot(session, [USAGE_PROJECTION_KEY])?.values?.[USAGE_PROJECTION_KEY];
    if (usage === null || typeof usage !== 'object') return undefined;
    let total = 0;
    for (const value of [usage.uncachedInputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
      total += value;
    }
    // 全零说明这次 activation 还没有任何一步上报过用量，不是「真的花了 0」。
    return total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 构造 runtime 需要的 runner。
 *
 * @param {object} options
 * @param {object} options.ctx 插件上下文（需要 `ctx.get('subagents')`）
 * @param {object} [options.config] 插件配置（subagentProvider / subagentModel）
 * @param {object} [options.logger]
 * @returns {(request: object) => Promise<{text: string, structured?: unknown, tokens?: number, toolCalls?: number, childId?: string, childName?: string}>}
 */
export function createSubagentRunner({ ctx, config = {}, logger = console }) {
  return async function runActorTurn(request) {
    const subagents = ctx.get?.('subagents');
    if (subagents === undefined) {
      throw new Error('workflow subagents are unavailable: this profile has no subagents service');
    }
    const providerName = typeof config.subagentProvider === 'string' && config.subagentProvider.length > 0
      ? config.subagentProvider
      : 'spawn';
    // DSH 0.2.2-rc.3 的 subagents 服务用 getProvider(name) 做查询
    // （typert.host.js:239-240），没有枚举名单的 list()；旧实现的 `subagents.list()`
    // 在磁盘实证里就是 "subagents.list is not a function" 的根因。
    // 查询面缺失时给出可读错误，而不是让调用现场退化成 "is not a function"。
    if (typeof subagents.getProvider !== 'function') {
      throw new Error('workflow subagents are unavailable: the subagents service does not expose getProvider(name), so the subagent provider cannot be resolved');
    }
    if (subagents.getProvider(providerName) === undefined) {
      throw new Error(`workflow subagents are unavailable: subagent provider "${providerName}" is not registered in this profile`);
    }
    // 兼容两种调用方：runtime 的 `{actor:{name,persona,model}, system, prompt, parent}`，
    // 以及工具层旧包装的 `{agentName, persona, model, prompt, agent}`（`agent` 即父会话）。
    const actorName = request.actor?.name ?? request.agentName;
    const persona = request.actor?.persona
      ?? (typeof request.persona === 'string' ? request.persona : request.persona?.system);
    const model = request.actor?.model ?? request.model;
    const route = resolveModelRoute(model ?? config.subagentModel);
    const label = typeof actorName === 'string' && actorName.length > 0 ? actorName : 'Workflow subagent';
    // rc.3 的身份校验是 `agents.get(spec.parent.id) !== spec.parent`（index.js:3025），
    // 所以 parent 必须是一个真正的活 Agent。缺了它旧实现会先抛 TypeError（读 undefined.id），
    // 这里改成可读的前置错误，说明是「工作流子代理需要父会话」。
    const parent = request.parent ?? request.agent;
    if (parent === null || typeof parent !== 'object' || typeof parent.id !== 'string' || parent.id.length === 0) {
      throw new Error(`workflow subagent "${label}" needs a live parent session: the workflow runner was called without a parent agent (request.parent / request.agent missing or not an Agent)`);
    }
    // rc.3 的 startLocal/startExternal 都把 spec.signal 直接交给 trackStartup
    // （index.js:1494、1600），所以调用方没给信号时桥自己兜底一个，否则 provider 侧会因 undefined 抛错。
    const signal = request.signal?.throwIfAborted === undefined ? new AbortController().signal : request.signal;
    const prompt = [{
      type: 'text',
      text: composeActorPrompt({
        system: request.system,
        actorName,
        persona,
        prompt: request.prompt,
      }),
    }];
    /** @type {object | undefined} */
    let activation;
    try {
      // rc.3 的 SubagentActivationSpec 是扁平的（typert.host.js:791-792）：
      // provider/label/signal/delivery 与 prompt/parent/cwd/agentOptions/outputSchema 同层，
      // 没有嵌套的 request 字段（index.js:3025、1480、1558 都直接读 spec.parent/spec.prompt）。
      activation = await subagents.startActivation({
        provider: providerName,
        label,
        prompt,
        parent,
        signal,
        delivery: 'caller',
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(route === undefined ? {} : { agentOptions: { ...route } }),
        // typed ask：把编译期 schema 交给 provider，能返回结构化输出时优先用它。
        ...(request.schema === undefined ? {} : { outputSchema: request.schema }),
      });
    } catch (error) {
      throw new Error(`workflow subagent "${label}" could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const result = await activation.result;
      // stopReason 只有 'completed' 算成功。旧实现只认 error/aborted，
      // 'max-tokens'、'refusal' 会带着（通常为空的）文本被当成成功返回，
      // 上层就把空答复记成了 actor 的答案。
      if (result.stopReason !== 'completed') {
        const diagnostic = typeof result.diagnostic === 'string' && result.diagnostic.length > 0
          ? `: ${result.diagnostic}`
          : '';
        if (result.stopReason === 'aborted') {
          throw new Error(`workflow subagent "${label}" was stopped (stopReason: aborted)${diagnostic}`);
        }
        throw new Error(`workflow subagent "${label}" failed (stopReason: ${String(result.stopReason)})${diagnostic}`);
      }
      // rc.3 的 activation 带 childId 与 name（typert.host.js:788）：前者是子会话身份，
      // 后者是它在父会话里的成员名，留给上层把 actor 与子会话关联。
      const childId = typeof activation.childId === 'string' && activation.childId.length > 0
        ? activation.childId
        : undefined;
      const childName = typeof activation.name === 'string' && activation.name.length > 0
        ? activation.name
        : undefined;
      // 用量不在 SubagentResult 里（typert.host.js:855-856），所以先读子会话的账本，
      // 再把 result 上的遗留字段当作兜底。必须在下面 dispose() 之前读——dispose 之后
      // 子会话随时会被回收。
      const tokens = childUsageTokens(ctx, childId) ?? tokensOf(result);
      return {
        text: textOf(result.output),
        ...(result.structured === undefined ? {} : { structured: result.structured }),
        ...(tokens === undefined ? {} : { tokens }),
        ...(childId === undefined ? {} : { childId }),
        ...(childName === undefined ? {} : { childName }),
      };
    } finally {
      try {
        await activation.dispose();
      } catch (error) {
        logger.warn?.(`zcode-workflow: subagent dispose failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}
