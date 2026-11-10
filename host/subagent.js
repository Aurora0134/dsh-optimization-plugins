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

/**
 * 构造 runtime 需要的 runner。
 *
 * @param {object} options
 * @param {object} options.ctx 插件上下文（需要 `ctx.get('subagents')`）
 * @param {object} [options.config] 插件配置（subagentProvider / subagentModel）
 * @param {object} [options.logger]
 * @returns {(request: object) => Promise<{text: string, structured?: unknown, tokens?: number, toolCalls?: number}>}
 */
export function createSubagentRunner({ ctx, config = {}, logger = console }) {
  return async function runActorTurn(request) {
    const subagents = ctx.get?.('subagents');
    if (subagents === undefined) {
      throw new Error('workflow subagents are unavailable: this profile has no subagents service');
    }
    const provider = typeof config.subagentProvider === 'string' && config.subagentProvider.length > 0
      ? config.subagentProvider
      : 'spawn';
    if (!subagents.list().includes(provider)) {
      throw new Error(`workflow subagents are unavailable: subagent provider "${provider}" is not registered (available: ${subagents.list().join(', ') || 'none'})`);
    }
    const route = resolveModelRoute(request.actor?.model ?? config.subagentModel);
    const label = typeof request.actor?.name === 'string' && request.actor.name.length > 0
      ? request.actor.name
      : 'Workflow subagent';
    const prompt = [{
      type: 'text',
      text: composeActorPrompt({
        system: request.system,
        actorName: request.actor?.name,
        persona: request.actor?.persona,
        prompt: request.prompt,
      }),
    }];
    /** @type {object | undefined} */
    let activation;
    try {
      activation = await subagents.startActivation({
        provider,
        label,
        request: {
          prompt,
          parent: request.parent,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...(route === undefined ? {} : { agentOptions: { ...route } }),
          // typed ask：把编译期 schema 交给 provider，能返回结构化输出时优先用它。
          ...(request.schema === undefined ? {} : { outputSchema: request.schema }),
        },
        signal: request.signal,
        delivery: 'caller',
      });
    } catch (error) {
      throw new Error(`workflow subagent "${label}" could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const result = await activation.result;
      if (result.stopReason === 'error') {
        throw new Error(result.diagnostic ?? `workflow subagent "${label}" failed`);
      }
      if (result.stopReason === 'aborted') {
        throw new Error(`workflow subagent "${label}" was stopped`);
      }
      const tokens = tokensOf(result);
      return {
        text: textOf(result.output),
        ...(result.structured === undefined ? {} : { structured: result.structured }),
        ...(tokens === undefined ? {} : { tokens }),
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
