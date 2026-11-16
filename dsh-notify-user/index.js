/**
 * Host half of the dsh-notify-user bundle.
 *
 * Everything here is registered on the plugin's own context, so unloading the row removes it:
 * the notify_user tool (a progress update card that does not end the turn), the prompt sentence
 * that tells the model when to post one, and a reminder for a model that has gone a long run of
 * tool calls without posting.
 */
import { randomUUID } from 'node:crypto';

export const name = 'dsh-notify-user';
export const inject = ['tools', 'systemPrompt'];

const TOOL_NAME = 'notify_user';
const DELIVERED = 'Update shown to the user.';
const SUPPRESSED = 'Notifications are disabled; the update was not displayed.';
const NUDGE_SOURCE = 'notify-user-nudge';

/**
 * Prompt placement: SECTION_ORDERS.TOOL_REPORT = 2900 (dsh-system-prompt/lib/types/index.d.ts),
 * the band that already carries reporting guidance, ahead of the MCP and SDK sections.
 */
const SECTION_ORDER = 2900;

const DEFAULT_NUDGE_AFTER = 8;
const DEFAULT_NUDGE_REPEAT = 8;

const DESCRIPTION = [
  'Post a progress update to the user in the conversation without ending your turn. The update stays in the conversation, so the user can read it again later.',
  '',
  '**When to use:**',
  '1. Early in a multi-step task, describe your approach so the user can follow your work.',
  '2. Report meaningful findings and phase conclusions, separating confirmed results from hypotheses.',
  '3. Before a long-running step, say what you are waiting for and why.',
  '4. When blocked, explain the blocker and your next step.',
  '',
  '**How to use:**',
  '- Keep the title to one line of plain text, without Markdown or a trailing period: the conclusion or the current phase, short enough to take in at a glance.',
  '- Write the message as you would update a colleague in chat: open with two to four sentences giving the evidence and reasoning behind the title, then put the details in a few bullet points, short paragraphs, or key-value lines with file paths and error excerpts. Avoid tables and wide code blocks: the update can be shown in a narrow column. Do not repeat the title.',
  '- When working as a subagent, describe only your own subtask; finishing it is not the whole task finishing.',
  '- Batch the update with your next tool calls.',
  '- Keep every finding the user needs in your final reply: an update is a progress note, not the answer.',
  '- Do not use an update to ask a question, request a decision, or deliver the final answer.',
].join('\n');

const GUIDANCE =
  'When notify_user is available, use it proactively to keep the end user informed while you work: ' +
  'for a multi-step task, post an early update describing your approach, then report meaningful findings, ' +
  'phase conclusions, long waits, and blockers.';

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      // Rendered as a single heading line: no line break, and never blank.
      pattern: '^(?!\\s+$)[^\\r\\n]+$',
      description:
        'A one-line headline the user can take in at a glance: the conclusion or the current phase, under roughly 60 characters, in plain text.',
    },
    message: {
      type: 'string',
      minLength: 1,
      description:
        'The details behind the title, without repeating it: a short paragraph followed by a few bullet points, under roughly 1000 characters.',
    },
  },
};

/**
 * Check the arguments the model sent. The Host forwards bare tool parameters without validating
 * them, so a malformed argument has to come back as a tool result instead of an exception.
 * @param {unknown} args
 * @returns {string | undefined} the model-facing rejection, or undefined when the arguments are usable
 */
function argumentError(args) {
  const input = typeof args === 'object' && args !== null ? args : {};
  const title = input.title;
  if (title !== undefined && typeof title !== 'string') return 'title must be a string.';
  if (title !== undefined) {
    if (title.trim().length === 0) return 'title must not be empty.';
    if (/[\r\n]/u.test(title)) return 'title must be a single line.';
  }
  const message = input.message;
  if (typeof message !== 'string' || message.trim().length === 0) return 'message must not be empty.';
  return undefined;
}

/**
 * The reminder text. This plugin counts individual tool calls in tools/post-execute rather than
 * the model's rounds, so the sentence has to say tool calls.
 * @param {number} calls
 */
const nudgeText = (calls) =>
  '<system-reminder>\nYou have made ' + calls + ' tool calls without a notify_user update \u2014 the user has seen no progress from you since. ' +
  'Post one now: a one-line title stating what you have concluded so far, and a message under roughly 1000 characters ' +
  'with the details and what you will do next. Batch it with your next tool calls.\n</system-reminder>';

/**
 * The reminder as a user-role notice. The source kind is load-bearing: without a kind of its own
 * the reminder would render as a message the person wrote.
 * @param {number} calls
 */
function nudgeMessage(calls) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: nudgeText(calls) }],
    source: { kind: NUDGE_SOURCE, form: 'notice', summary: 'notify_user \u00d7 ' + calls },
  };
}

/**
 * Register the Host half.
 * @param {object} ctx Cordis context
 * @param {object} [config] Loader row config
 */
export function apply(ctx, config = {}) {
  /** The Host logger is optional: without it an unusable setting is dropped silently. */
  let logger;
  try {
    logger = ctx.get?.('logger');
  } catch {
    logger = undefined;
  }
  const warn = (message) => logger?.warn?.(message);

  /** A positive integer setting, keeping the fallback when the row's value is unusable. */
  const setting = (raw, fallback, field) => {
    if (raw === undefined) return fallback;
    if (Number.isInteger(raw) && raw > 0) return raw;
    warn('dsh-notify-user: ' + field + ' must be a positive integer; using ' + fallback + '.');
    return fallback;
  };

  const enabled = config.enabled !== false;
  const nudgeAfter = setting(config.nudgeAfterRounds, DEFAULT_NUDGE_AFTER, 'nudgeAfterRounds');
  const nudgeRepeat = setting(config.nudgeRepeatRounds, DEFAULT_NUDGE_REPEAT, 'nudgeRepeatRounds');

  /**
   * Per-agent run of tool calls, released with the agent. remindedAt is the run length at the last
   * reminder, which also throttles the next one.
   * @type {WeakMap<object, { calls: number, remindedAt: number }>}
   */
  const runs = new WeakMap();

  ctx.tools.register(
    {
      name: TOOL_NAME,
      description: DESCRIPTION,
      parameters: PARAMETERS,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      // Posting an update touches nothing shared, so its siblings need not wait for it.
      isConcurrencySafe: () => true,
      execute(args, exec) {
        // The call is the reset. A nested program call never reaches this plugin's post-execute
        // listener, but every call runs its body, so an update always clears the run.
        if (exec?.agent !== undefined) runs.delete(exec.agent);
        const failure = argumentError(args);
        if (failure !== undefined) return failure;
        return enabled ? DELIVERED : SUPPRESSED;
      },
    },
    // A disabled deployment hides the tool from every agent rather than answering its calls.
    { when: () => enabled },
  );

  ctx.systemPrompt.section({
    name: 'tool:notify_user',
    order: SECTION_ORDER,
    // Only agents that can actually call the tool are told about it.
    text: ({ scope, toolSet }) => (ctx.tools.get(TOOL_NAME, scope, toolSet) === undefined ? '' : GUIDANCE),
  });

  /**
   * Advance the calling agent's run and build the reminder when one is due.
   * @param {{ agent?: object, name: string }} exec tool run context
   */
  const observe = (exec) => {
    const agent = exec.agent;
    if (agent === undefined) return undefined;
    if (exec.name === TOOL_NAME) {
      runs.delete(agent);
      return undefined;
    }
    if (ctx.tools.get(TOOL_NAME, agent) === undefined) return undefined;
    const run = runs.get(agent) ?? { calls: 0, remindedAt: 0 };
    run.calls += 1;
    runs.set(agent, run);
    if (run.calls < nudgeAfter) return undefined;
    if (run.calls - run.remindedAt < nudgeRepeat) return undefined;
    run.remindedAt = run.calls;
    return nudgeMessage(run.calls);
  };

  // The reminder rides on the tool result: unlike an inbox injection it is guaranteed to reach
  // the next request even when that request has already claimed its messages.
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const reminder = observe(exec);
    const decision = await next();
    if (reminder === undefined || typeof decision !== 'object' || decision === null) return decision;
    return { ...decision, additionalContexts: [reminder, ...(decision.additionalContexts ?? [])] };
  });

  // A message from the person restarts the run: the model is answering them now.
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (messages.some((message) => message.source?.kind === 'user')) runs.delete(agent);
    return next();
  });
}
