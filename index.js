/**
 * Host half of dsh-visualizer.
 *
 * Two tools and one client renderer:
 *   visual_guide - returns the design contract the model should follow
 *   show_visual  - validates an SVG payload and lets the Client draw it
 *
 * The SVG never becomes a result content block. It travels as a tool argument
 * and is persisted in ToolCallBlock.arguments, which is also what lets a
 * refreshed conversation rebuild the card without any attachment.
 */
import { normalizeSvg } from './src/normalize.js';
import { GUIDE } from './src/guide.js';

export const name = 'dsh-visualizer';
export const inject = ['tools', 'systemPrompt'];

const SHOW_TOOL = 'show_visual';
const GUIDE_TOOL = 'visual_guide';
const SECTION_ORDER = 2900;
const DEFAULT_MAX_PER_TURN = 3;
const MAX_TITLE = 80;
const MAX_CAPTION = 200;
const MAX_LOADING = 4;

const SHOW_DESCRIPTION = [
  'Render an SVG visual inline in the conversation: a flow diagram, architecture sketch, chart, comparison table, or UI mockup. The SVG is shown as a card under this tool call, so the user sees the picture without opening a file.',
  '',
  '**Before drawing:** call visual_guide once in the conversation to get the canvas, palette, type, spacing, and hard limits. It is cheap and prevents rework.',
  '',
  '**Payload:** a complete SVG string in the svg argument. It must be one <svg> root with a viewBox (normally "0 0 720 H"). Only a strict subset is accepted: svg, g, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, defs, linearGradient, radialGradient, stop. No HTML, script, style, class, href, event handler, image, use, foreignObject, animation, or external URL.',
  '',
  '**Limits:** at most 24 KB of SVG, 1500 nodes, and 3 visuals per turn. Keep a single drawing under about 120 elements. A rejected payload returns a readable reason and draws nothing.',
  '',
  '**Do not use it:** for decorative filler, for code or logs, for content that is clearer as a sentence or a Markdown table, or when the user did not ask for a picture and prose is enough. Do not paste the SVG into the assistant message as well; the card already shows it.',
].join('\n');

const GUIDE_DESCRIPTION = [
  'Return the design guide for show_visual: canvas and safe area, the palette, the three type sizes, spacing and stroke rules, supported scenarios, and the hard security/limit rules.',
  '',
  'Call this before the first show_visual in a conversation, and again if the user asks for a different visual style. It returns text only; it does not draw anything.',
].join('\n');

const GUIDANCE = [
  'When a picture would explain something better than prose, use visual_guide and then show_visual.',
  'Call visual_guide once before the first visual to get the canvas, palette, type, spacing, and limits.',
  'show_visual takes a complete SVG string; it is rendered inline as a card. It is not for decoration, code, logs, or content that a sentence or Markdown table states more clearly.',
  'Keep one visual under about 120 elements and 24 KB, and draw at most 3 per turn. Do not repeat the SVG in the message text.',
].join('\n');

function positiveInteger(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

function oneLine(value, field, maximum) {
  if (typeof value !== 'string') throw new Error(SHOW_TOOL + ': ' + field + ' must be a string.');
  const line = value.replace(/\r\n?/g, '\n');
  if (line.includes('\n')) throw new Error(SHOW_TOOL + ': ' + field + ' must be a single line.');
  const trimmed = line.trim();
  if (trimmed === '') throw new Error(SHOW_TOOL + ': ' + field + ' must not be empty.');
  if (trimmed.length > maximum) {
    throw new Error(SHOW_TOOL + ': ' + field + ' is longer than ' + maximum + ' characters; shorten it.');
  }
  return trimmed;
}

function readArguments(args) {
  const input = typeof args === 'object' && args !== null ? args : {};
  if (typeof input.svg !== 'string' || input.svg.trim() === '') {
    throw new Error(SHOW_TOOL + ': svg must be a non-empty SVG string.');
  }
  const title = oneLine(input.title, 'title', MAX_TITLE);
  const caption = input.caption === undefined ? undefined : oneLine(input.caption, 'caption', MAX_CAPTION);
  if (input.loading !== undefined) {
    if (!Array.isArray(input.loading) || input.loading.length === 0 || input.loading.length > MAX_LOADING) {
      throw new Error(SHOW_TOOL + ': loading must be an array of 1-' + MAX_LOADING + ' short strings.');
    }
    input.loading.forEach((item, index) => oneLine(item, 'loading[' + index + ']', 80));
  }
  return { svg: input.svg, title, caption };
}

/** Summary line kept in the tool result; the SVG itself stays in the arguments. */
function summary(input, stats, bytes) {
  const size = (bytes / 1024).toFixed(1);
  const caption = input.caption === undefined ? '' : ' - ' + input.caption;
  return '[visual] ' + input.title + ' - ' + (stats.elementCount - 1) + ' shapes, ' + size + ' KB' + caption;
}

/**
 * Register the Host half.
 * @param {object} ctx Cordis context
 * @param {object} [config] Loader row config
 */
export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false;
  const maxPerTurn = positiveInteger(config.maxPerTurn, DEFAULT_MAX_PER_TURN, 10);

  /** Per-agent turn quota, released with the agent. */
  const quota = new WeakMap();

  const turnOf = (exec) => {
    try {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
      const session = exec && exec.agent ? exec.agent.session : undefined;
      const value = agents && typeof agents.turnBoundaryOf === 'function'
        ? agents.turnBoundaryOf(session).lastTurn
        : undefined;
      return Number.isInteger(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const takeQuota = (exec) => {
    const agent = exec && exec.agent ? exec.agent : ctx;
    const turn = turnOf(exec);
    let state = quota.get(agent);
    if (state === undefined || state.turn !== turn) {
      state = { turn, count: 0 };
      quota.set(agent, state);
    }
    if (state.count >= maxPerTurn) {
      throw new Error(
        SHOW_TOOL + ': this turn already rendered ' + maxPerTurn + ' visuals. ' +
          'Answer in text or combine the remaining points into one visual next turn.',
      );
    }
    state.count += 1;
  };

  ctx.tools.register(
    {
      name: SHOW_TOOL,
      description: SHOW_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['svg', 'title'],
        properties: {
          svg: {
            type: 'string',
            description:
              'A complete SVG document as one string: one <svg> root with viewBox, no HTML or Markdown wrapper, at most 24 KB.',
          },
          title: {
            type: 'string',
            description: 'A one-line card title, at most 80 characters, in the user language.',
          },
          caption: {
            type: 'string',
            description: 'An optional one-line footnote under the drawing, at most 200 characters.',
          },
          loading: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional 1-4 short lines shown while the card is being prepared. They are not part of the final drawing.',
          },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        const input = readArguments(args);
        let stats;
        try {
          stats = normalizeSvg(input.svg, 'host');
        } catch (error) {
          throw new Error(SHOW_TOOL + ': ' + error.message);
        }
        takeQuota(exec);
        return summary(input, stats, new TextEncoder().encode(input.svg).length);
      },
    },
    { when: () => enabled },
  );

  ctx.tools.register(
    {
      name: GUIDE_TOOL,
      description: GUIDE_DESCRIPTION,
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => true,
      execute() {
        return GUIDE;
      },
    },
    { when: () => enabled },
  );

  ctx.systemPrompt.section({
    name: 'tool:' + SHOW_TOOL,
    order: SECTION_ORDER,
    text: ({ scope, toolSet }) => (ctx.tools.get(SHOW_TOOL, scope, toolSet) === undefined ? '' : GUIDANCE),
  });

  // A message from the person starts a new turn: drop the previous quota so the
  // cap applies to what the model draws now, not to the whole session.
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (messages.some((message) => message.source?.kind === 'user')) quota.delete(agent);
    return next();
  });
}
