/**
 * Bridge from a workflow run to DSH's subagent service.
 *
 * ZCode runs each subagent as a full model session with a persona, its own tools and a shared
 * conversation across asks. DSH exposes that capability through `ctx.subagents`: a provider
 * launches a child session and its `result` resolves with the child's final content blocks and
 * optional structured output. This module wraps that contract in the one function the run
 * engine calls: `ask({ agentName, persona, prompt, schema, model, signal })`.
 */

/**
 * Split a ZCode model reference ("providerId/modelId" or "modelId") into DSH agent options.
 * A bare model id keeps the caller's provider, which is what ZCode does for a bare name.
 * @param {string | { __zcodeModelRef?: string } | undefined} model
 * @returns {{ provider?: string, model?: string } | undefined}
 */
export function resolveModelRoute(model) {
  const value = typeof model === 'string'
    ? model
    : (model !== null && typeof model === 'object' ? model.__zcodeModelRef : undefined);
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const slash = value.indexOf('/');
  if (slash > 0 && slash < value.length - 1) {
    return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
  }
  return { model: value };
}

/**
 * Join the text blocks of one subagent result.
 * @param {readonly { type: string, text?: string }[]} output
 * @returns {string}
 */
function textOf(output) {
  return output
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * ZCode's "Workflow Actor Identity" root block plus the "# Working inside a workflow"
 * contract, copied from the ZCode agent runtime (see docs/recon/zcode-host.md §2.11).
 * Every workflow subagent receives it ahead of its persona and ask.
 * @param {string | undefined} name
 * @param {string | undefined} persona
 * @param {string} instructions
 * @returns {string}
 */
export function buildChildPrompt(name, persona, instructions) {
  const identity = `You are a subagent inside a dynamic workflow run${name === undefined ? '' : `, named "${name}"`}. A script created you and hands you work one ask at a time; the script — not a person — consumes what you return. There is no user in this conversation to talk to.`;
  const personaBlock = typeof persona === 'string' && persona.trim().length > 0 ? `\n\n${persona}` : '';
  const contract = [
    '# Working inside a workflow',
    '- You have the regular working tools — reading, searching, editing, running commands — plus `submit_result` and `escalate`. There is no tool that asks a person anything.',
    '- Each ask states what to do. When the ask carries a result schema, finish by calling `submit_result` with a conforming value; otherwise your final message is the result.',
    '- Ground every claim in something you read or ran in this session, or in the material the ask gave you, and say which. Cite code as `path:line`. A check counts as passed only if you executed it here; if you could not run it, report it as not run. Run the check an ask names rather than a faster substitute, and say exactly which command you ran.',
    '- Report outcomes faithfully. If part of the task is impossible, out of scope, or contradicted by what you found, say so in the result instead of filling a field with a plausible guess. Never fake a passing result to satisfy an instruction.',
    "- When you are blocked by something outside your reach — a gate that cannot pass, instructions that contradict each other, a fact only the run's owner knows — call `escalate`. Questions written in prose reach nobody.",
    '- Do not write report or summary files on your own initiative; findings go in the result. When the ask names an output path, write exactly there and return that path in the result — the script publishes it to the user.',
  ].join('\n');
  return `${identity}${personaBlock}\n\n${contract}\n\n---\n\n${instructions}`;
}

/**
 * Build the runner a workflow run uses for every `ask`.
 *
 * @param {object} options
 * @param {object} options.ctx plugin context (or any context exposing `get`)
 * @param {object} [options.config] plugin config
 * @param {object} [options.logger]
 * @returns {(request: { agentName?: string, persona?: { system?: string, model?: string }, prompt: string, schema?: object, model?: string, cwd?: string, agent: object, signal: AbortSignal }) => Promise<{ text: string, structured?: unknown }>}
 */
export function createSubagentRunner({ ctx, config = {}, logger = console }) {
  /**
   * @param {{ agentName?: string, persona?: { system?: string, model?: string }, prompt: string, schema?: object, model?: string, cwd?: string, agent: object, signal: AbortSignal }} request
   */
  return async function askChild(request) {
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
    const route = resolveModelRoute(request.model ?? request.persona?.model ?? config.subagentModel);
    const agentOptions = route === undefined ? undefined : { ...route };
    const label = request.agentName === undefined || request.agentName.length === 0
      ? 'Workflow subagent'
      : request.agentName;
    const requestCwd = request.cwd;
    const prompt = [{
      type: 'text',
      text: buildChildPrompt(request.agentName, request.persona?.system, request.prompt),
    }];
    /** @type {object | undefined} */
    let activation;
    try {
      activation = await subagents.startActivation({
        provider,
        label,
        request: {
          prompt,
          parent: request.agent,
          ...(requestCwd === undefined ? {} : { cwd: requestCwd }),
          ...(agentOptions === undefined ? {} : { agentOptions }),
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
      const text = textOf(result.output);
      return {
        text,
        ...(result.structured === undefined ? {} : { structured: result.structured }),
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
