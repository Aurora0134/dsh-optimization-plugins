/* Workflow tool cards — shared core.
 *
 * `WorkflowCard` is the single component on the `tool.call.toolview` slot; the slot keys of
 * `TOOL_NAMES` all land here and it dispatches per tool. This part owns what every card shares:
 *
 *   props    the slot payload, normalized by `wfCardModel`. Hosts deliver either the broker shape
 *            (`toolName` / `arguments` / `result` / `status` / `session`) or the scaffold block
 *            shape (`phase` / `block` / `t`), so both are read and either one may be partial:
 *            a streaming call has arguments but no result, a settled call both.
 *   copy     the UI_NS dictionary (`locale/ui/cards.json`); bound in `WF_CARDS.register` because a
 *            card cannot bind a namespace by itself. `props.t` covers the tool-namespace keys.
 *   data     `31-cache.js` owns the only timers in the card layer; a card subscribes.
 *   layout   `WfCardShell` (one header row + body) and the run card in `32-run-card.js`.
 */

/** Tool-card surface: the client entry calls `WF_CARDS.register(ctx, effect)` when present. */
const WF_CARDS = {};

/** Renderers by canonical tool name; each part contributes `WF_CARDS.render[key]`. */
WF_CARDS.render = {};

/** UI_NS translator, bound once per registration pass. */
var WF_CARDS_UI = undefined;

/**
 * Bind the card dictionary and start the shared run channel.
 * The slot itself is registered by the client entry; this only wires what a card cannot reach on
 * its own (the UI namespace) and the one timer the card layer is allowed to own.
 */
WF_CARDS.register = function registerCards(ctx, effect) {
  if (ctx !== undefined && ctx !== null && ctx.locale !== undefined && typeof ctx.locale.bind === 'function') {
    try {
      WF_CARDS_UI = ctx.locale.bind(UI_NS);
    } catch (error) {
      WF_CARDS_UI = undefined;
      console.warn('zcode-workflow: card dictionary failed to bind', error);
    }
  }
  if (typeof effect === 'function') effect(() => wfRunChannelStart(), 'zcode-workflow: card run channel');
  else wfRunChannelStart();
};

/** How many result rows a list card shows. */
const WF_CARD_MAX_ROWS = 8;

/* ---------------------------------- styles --------------------------------- */

/** Base card stylesheet: host theme tokens only, one class per row element. */
const CSS = [
  '.zwf-card{display:flex;box-sizing:border-box;flex-direction:column;gap:8px;width:100%;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
  '.zwf-card-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;box-sizing:border-box;min-width:0;font-size:13px;line-height:20px}',
  '.zwf-card-glyph{display:inline-flex;flex:none;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}',
  '.zwf-card-kind{flex:none;white-space:nowrap;font-weight:500;color:var(--dsw-alias-label-primary)}',
  '.zwf-card-kind[data-live="true"]{background:linear-gradient(90deg,var(--dsw-alias-brand-primary),var(--dsw-alias-label-primary),var(--dsw-alias-brand-primary));background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:zwf-card-shimmer 2.4s linear infinite}',
  '@keyframes zwf-card-shimmer{from{background-position:0 0}to{background-position:200% 0}}',
  '.zwf-card-name{flex:1 1 80px;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
  '.zwf-card-cluster{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;margin-left:auto}',
  '.zwf-card-detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption)}',
  '.zwf-card-body{display:flex;box-sizing:border-box;flex-direction:column;gap:8px;min-width:0}',
  '.zwf-card-foot{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
  '.zwf-card-parts{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0;font-variant-numeric:tabular-nums}',
  '.zwf-card-sep{color:var(--dsw-alias-label-caption)}',
  '.zwf-card-trail{margin-left:auto;display:inline-flex;align-items:center;gap:6px}',
  '.zwf-lamp{display:inline-block;flex:none;width:6px;height:6px;border-radius:999px;background:transparent}',
  '.zwf-lamp[data-status="pending"],.zwf-lamp[data-status="stopped"]{border:1.5px solid var(--dsw-alias-label-caption)}',
  '.zwf-lamp[data-status="running"]{background:var(--dsw-alias-state-warn-primary);animation:zwf-card-pulse 1.4s ease-in-out infinite}',
  '.zwf-lamp[data-status="completed"]{background:var(--dsw-alias-state-success-primary)}',
  '.zwf-lamp[data-status="errored"]{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 2px color-mix(in oklab,var(--dsw-alias-state-error-primary) 30%,transparent)}',
  '.zwf-lamp[data-status="superseded"],.zwf-lamp[data-status="idle"]{background:var(--dsw-alias-state-idle-primary)}',
  '@keyframes zwf-card-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
  '.zwf-state{display:inline-flex;align-items:center;gap:5px;min-width:0;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
  '.zwf-state[data-status="running"]{color:var(--dsw-alias-state-warn-primary)}',
  '.zwf-state[data-status="completed"]{color:var(--dsw-alias-state-success-primary)}',
  '.zwf-state[data-status="errored"]{color:var(--dsw-alias-state-error-primary)}',
  '.zwf-state-note{color:var(--dsw-alias-label-caption)}',
  '.zwf-icon-btn{display:inline-flex;box-sizing:border-box;flex:none;align-items:center;justify-content:center;width:24px;height:24px;margin:0;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-caption);cursor:pointer}',
  '.zwf-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.zwf-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
  '.zwf-icon-btn:disabled{opacity:.5;cursor:default}',
  '.zwf-chev{display:inline-flex;flex:none;transition:transform .12s}',
  '.zwf-chev[data-open="true"]{transform:rotate(90deg)}',
  '.zwf-chips{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0}',
  '.zwf-chip{display:inline-flex;box-sizing:border-box;align-items:center;gap:5px;min-width:0;max-width:240px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
  '.zwf-chip:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
  '.zwf-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
  '.zwf-chip[data-static="true"]{cursor:default}',
  '.zwf-chip[data-static="true"]:hover{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
  '.zwf-chip-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.zwf-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}',
  '.zwf-note[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
  '.zwf-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
  '.zwf-rows{display:flex;flex-direction:column;gap:2px;box-sizing:border-box;min-width:0;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1)}',
  '.zwf-row-item{font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}',
  '.zwf-pre{margin:0;box-sizing:border-box;max-height:240px;overflow:auto;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.zwf-section{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.zwf-section-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-caption)}',
  '@media (prefers-reduced-motion:reduce){.zwf-card-kind[data-live="true"]{animation:none}.zwf-lamp[data-status="running"]{animation:none}.zwf-chev{transition:none}}',
].join('');

/* ---------------------------------- readers -------------------------------- */

/** @returns {boolean} true for a plain record (not null, not an array). */
function wfCardRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @returns {string} the value when it is a non-empty string, else ''. */
function wfCardTextOf(value) {
  return typeof value === 'string' ? value : '';
}

/** @returns {number | undefined} a finite number from a number or numeric string. */
function wfCardNum(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** First argument that is neither undefined nor null. */
function wfCardFirst(...values) {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
}

/** First non-empty string among the candidates. */
function wfCardFirstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/** The call slice of a preparing/start/result block, whichever shape carries it. */
function wfCardCall(block) {
  if (!wfCardRecord(block)) return undefined;
  return wfCardRecord(block.call) ? block.call : block;
}

const WF_CARD_ARGS_CACHE = new WeakMap();

/** Parse one call's raw argument JSON once; a still-streaming payload parses to `{}`. */
function wfCardParsedArgs(block) {
  const call = wfCardCall(block);
  if (!wfCardRecord(call)) return {};
  const cached = WF_CARD_ARGS_CACHE.get(call);
  if (cached !== undefined) return cached;
  let parsed = {};
  const raw = typeof call.argsRaw === 'string' ? call.argsRaw : '';
  if (raw !== '') {
    try {
      const value = JSON.parse(raw);
      if (wfCardRecord(value)) parsed = value;
    } catch {
      // Still streaming: the lazy view below serves the fields that already arrived.
    }
  }
  WF_CARD_ARGS_CACHE.set(call, parsed);
  return parsed;
}

/**
 * Read one field from a block's lazy argument view.
 * The broker view exposes `text`/`complete`/`value`; a partial or foreign shape may expose a
 * getter (`read`, `get`) or be the arguments object itself.
 */
function wfCardViewField(view, key) {
  if (view === undefined || view === null) return undefined;
  try {
    if (typeof view.text === 'function') {
      const value = view.text(key);
      if (value !== undefined) return value;
    }
  } catch {
    // fall through to the next shape
  }
  try {
    if (typeof view.complete === 'function' && view.complete(key) && typeof view.value === 'function') {
      const value = view.value(key);
      if (value !== undefined) return value;
    }
  } catch {
    // fall through
  }
  try {
    if (typeof view === 'function') {
      const all = view();
      return wfCardRecord(all) ? all[key] : undefined;
    }
  } catch {
    // fall through
  }
  try {
    if (typeof view.read === 'function') {
      const all = view.read();
      return wfCardRecord(all) ? all[key] : undefined;
    }
  } catch {
    // fall through
  }
  try {
    if (typeof view.get === 'function') {
      const value = view.get(key);
      if (value !== undefined) return value;
    }
  } catch {
    // fall through
  }
  return wfCardRecord(view) && Object.prototype.hasOwnProperty.call(view, key) ? view[key] : undefined;
}

/** Read one call argument at any lifecycle stage. */
function wfCardArgValue(block, key) {
  if (!wfCardRecord(block)) return undefined;
  const direct = wfCardViewField(block.args, key);
  if (direct !== undefined) return direct;
  const call = wfCardCall(block);
  if (call !== undefined && call !== block) {
    const nested = wfCardViewField(call.args, key);
    if (nested !== undefined) return nested;
  }
  const parsed = wfCardParsedArgs(block);
  return Object.prototype.hasOwnProperty.call(parsed, key) ? parsed[key] : undefined;
}

/** Read one string argument. */
function wfCardArgText(block, key) {
  const value = wfCardArgValue(block, key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Flatten a settled block's content to display text, falling back to its structured error.
 * @returns {string} the result text, or ''.
 */
function wfCardResultText(block) {
  if (!wfCardRecord(block)) return '';
  const sources = [
    block.content,
    wfCardRecord(block.result) ? block.result.content : undefined,
    wfCardRecord(block.call) ? block.call.content : undefined,
    wfCardRecord(block.call) && wfCardRecord(block.call.result) ? block.call.result.content : undefined,
    wfCardRecord(block.output) ? block.output.content : undefined,
    block.text,
    typeof block.result === 'string' ? block.result : undefined,
    typeof block.output === 'string' ? block.output : undefined,
  ];
  for (const content of sources) {
    if (typeof content === 'string') {
      if (content !== '') return content;
      continue;
    }
    if (!Array.isArray(content) || content.length === 0) continue;
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') {
        if (item !== '') parts.push(item);
        continue;
      }
      if (wfCardRecord(item) && item.type === 'text' && typeof item.text === 'string') {
        if (item.text !== '') parts.push(item.text);
        continue;
      }
      if (item === undefined || item === null) continue;
      try {
        parts.push(JSON.stringify(item, null, 2));
      } catch {
        // unprintable block: keep the rest
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  const error = [block.error, wfCardRecord(block.call) ? block.call.error : undefined].find(wfCardRecord);
  if (error === undefined) return '';
  const name = typeof error.name === 'string' && error.name !== '' ? error.name : 'Error';
  const code = typeof error.code === 'string' && error.code !== '' ? error.code : '';
  return code === '' ? name : `${name}: ${code}`;
}

/** The tool-owned structured value a broker block records beside its text. */
function wfCardStructured(block) {
  if (!wfCardRecord(block)) return undefined;
  const candidates = [
    block.value,
    block.meta,
    wfCardRecord(block.output) ? block.output.value : undefined,
    wfCardRecord(block.result) ? block.result.value : undefined,
    wfCardRecord(block.output) && wfCardRecord(block.output.meta) ? block.output.meta : undefined,
  ];
  for (const candidate of candidates) if (wfCardRecord(candidate)) return candidate;
  return undefined;
}

/* ------------------------------ props normalizing --------------------------- */

/** Tool names compare without punctuation so `AmendWorkflow`/`amend_workflow` agree. */
function wfCardNormalizeName(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/gu, '') : '';
}

const WF_CARD_BY_NORMALIZED = (() => {
  const table = {};
  for (const name of TOOL_NAMES) table[wfCardNormalizeName(name)] = name;
  return table;
})();

/** The canonical tool name of a card, or ''. */
function wfCardToolName(props) {
  const candidates = [
    props.toolName,
    props.tool,
    props.name,
    props.key,
    wfCardRecord(props.block) ? props.block.toolName : undefined,
    wfCardRecord(props.block) && wfCardRecord(props.block.call) ? props.block.call.toolName : undefined,
    wfCardRecord(props.result) ? props.result.toolName : undefined,
  ];
  for (const candidate of candidates) {
    const canonical = WF_CARD_BY_NORMALIZED[wfCardNormalizeName(candidate)];
    if (canonical !== undefined) return canonical;
  }
  return '';
}

/** The lifecycle phase a card renders: preparing, start (in flight), or result. */
function wfCardPhase(props) {
  const raw = wfCardFirstText(props.phase, props.status, wfCardRecord(props.block) ? props.block.phase : undefined);
  if (raw === 'preparing' || raw === 'writing') return 'preparing';
  if (raw === 'start' || raw === 'running' || raw === 'streaming' || raw === 'executing') return 'start';
  if (raw === 'result' || raw === 'complete' || raw === 'completed' || raw === 'error' || raw === 'failed' || raw === 'cancelled') return 'result';
  const block = props.block;
  if (wfCardRecord(block)) {
    if ('kind' in block) return 'result';
    if (block.phase === 'preparing') return 'preparing';
    if (block.phase === 'start') return 'start';
  }
  if (props.result !== undefined) return 'result';
  return 'preparing';
}

/**
 * One block carrying arguments and result in the shape the readers above understand.
 * A broker payload keeps its lazy argument view; a scaffold block already is one.
 */
function wfCardBlock(props) {
  const given = wfCardRecord(props.block) ? props.block : undefined;
  const synth = {};
  const args = wfCardFirst(props.arguments, props.input, props.args);
  if (args !== undefined && args !== null) {
    if (typeof args === 'string') synth.argsRaw = args;
    else synth.args = args;
  }
  const result = props.result;
  if (typeof result === 'string') synth.text = result;
  else if (wfCardRecord(result)) {
    if (Array.isArray(result.content)) synth.content = result.content;
    else if (typeof result.content === 'string') synth.content = [result.content];
    if (typeof result.isError === 'boolean') synth.isError = result.isError;
    if (result.value !== undefined) synth.value = result.value;
  }
  if (props.error !== undefined) synth.error = props.error;
  if (given === undefined) return synth;
  const merged = { ...given };
  if (merged.args === undefined && synth.args !== undefined) merged.args = synth.args;
  if (merged.argsRaw === undefined && synth.argsRaw !== undefined) merged.argsRaw = synth.argsRaw;
  if (merged.content === undefined && synth.content !== undefined) merged.content = synth.content;
  if (merged.text === undefined && synth.text !== undefined) merged.text = synth.text;
  if (merged.error === undefined && synth.error !== undefined) merged.error = synth.error;
  if (merged.value === undefined && synth.value !== undefined) merged.value = synth.value;
  return merged;
}

/** Session id from the slot payload, whichever shape carries it. */
function wfCardSessionId(props) {
  const direct = wfCardFirstText(props.sessionId, wfCardRecord(props.session) ? props.session.id : undefined, props.session);
  if (direct !== '') return direct;
  return undefined;
}

/** Whether the settled call failed. */
function wfCardFailed(props, phase) {
  if (props.isError === true) return true;
  if (wfCardRecord(props.result) && props.result.isError === true) return true;
  if (wfCardRecord(props.block) && props.block.isError === true) return true;
  if (props.error !== undefined && props.error !== null && props.error !== false) return phase === 'result';
  return false;
}

/** Tool-call identity, used to correlate a card with the run it launched. */
function wfCardToolCallId(props) {
  const block = wfCardRecord(props.block) ? props.block : undefined;
  return wfCardFirstText(
    // The Harness delivers the wire call id as `callId` on the slot owner and on the block; the
    // broker shape spells the same fact `toolId` / `toolCallId`. A run row carries it as
    // `toolCallId`, so every spelling has to land on one value for the card to claim its run.
    props.callId,
    props.toolId,
    props.toolCallId,
    props.id,
    block === undefined ? undefined : block.callId,
    block === undefined ? undefined : block.toolCallId,
    block === undefined ? undefined : block.id,
  ) || undefined;
}

/**
 * Normalize the slot payload the whole card layer renders from.
 * The result is a plain record so a card can memoize on it: every reader below closes over it.
 */
function wfCardModel(props) {
  const source = wfCardRecord(props) ? props : {};
  const key = wfCardToolName(source);
  const phase = wfCardPhase(source);
  const block = wfCardBlock(source);
  const failed = wfCardFailed(source, phase);
  return {
    key,
    rawName: wfCardFirstText(source.toolName, source.tool, source.name),
    toolId: wfCardToolCallId(source),
    phase,
    block,
    failed,
    sessionId: wfCardSessionId(source),
    args: (name) => wfCardArgValue(block, name),
    argText: (name) => wfCardArgText(block, name),
    resultText: wfCardResultText(block),
    structured: wfCardStructured(block),
    forceOpen: source.forceOpen === true,
    canToggle: source.canToggle !== false,
    approval: source.approval ?? source.gate ?? source.pendingApproval,
  };
}

/* --------------------------------- wording -------------------------------- */

/** Copy from the card dictionary; the English table keeps a missing key readable. */
function wfCardSay(key, params) {
  return WF_UI.say(WF_CARDS_UI, UI_EN, key, params);
}

/**
 * Plural pick: `key` for a count of one, `pluralKey` otherwise.
 * The dictionaries carry both forms because Chinese often repeats the same wording.
 */
function wfCardSayCount(key, pluralKey, count, params) {
  return wfCardSay(count === 1 ? key : pluralKey, { count, ...(params ?? {}) });
}

/* --------------------------------- shared UI ------------------------------- */

/** A card-level icon button (open details, toggle). */
function WfCardIconButton(props) {
  return React.createElement('button', {
    type: 'button',
    className: `zwf-icon-btn${props.className === undefined ? '' : ` ${props.className}`}`,
    title: props.title,
    'aria-label': props.label,
    'aria-expanded': props.expanded,
    'data-testid': props.testId,
    onClick: props.onClick,
    onKeyDown: (event) => {
      if (event !== null && typeof event === 'object' && typeof event.stopPropagation === 'function') event.stopPropagation();
    },
  }, props.icon);
}

/** The disclosure chevron; rotates when open. */
function WfCardChevron(props) {
  return React.createElement('span', {
    className: 'zwf-chev',
    'data-open': props.open === true ? 'true' : 'false',
    'aria-hidden': 'true',
  }, React.createElement(WF_UI.icons.chevronRight, { size: 13 }));
}

/** A labelled card action (resume, retry); the shared button has no test id hook. */
function WfCardAction(props) {
  return React.createElement('button', {
    type: 'button',
    className: `zwf-btn zwf-btn-sm${props.variant === undefined ? '' : ` zwf-btn-${props.variant}`}`,
    'data-testid': props.testId,
    title: props.title,
    disabled: props.disabled === true,
    onClick: props.onClick,
  },
  props.icon === undefined ? null : React.createElement('span', { className: 'zwf-btn-glyph' }, props.icon),
  React.createElement('span', { className: 'zwf-btn-label' }, props.children));
}

/** Status lamp: one dot per lifecycle status. */
function WfCardLamp(props) {
  return React.createElement('span', { className: 'zwf-lamp', 'data-status': props.status ?? 'idle', 'aria-hidden': 'true' });
}

/** Stop reasons the dictionary covers; anything else is dropped rather than shown as a key. */
const WF_CARD_STOP_REASONS = new Set(['user', 'model', 'provider', 'interrupted', 'superseded']);

/** Status word of a lifecycle status; an unknown status says the run ended. */
function wfCardStatusText(status) {
  switch (status) {
    case 'pending':
    case 'running':
    case 'completed':
    case 'errored':
    case 'stopped':
      return wfCardSay(`run.status.${status}`);
    default:
      return wfCardSay('card.ended');
  }
}

/**
 * Lamp + status word + stop reason + resumability, the `workflow-run-lamp` family.
 * @param {{status?: string, stopReason?: string, resumable?: boolean, testId?: string}} props
 */
function WfCardState(props) {
  const status = typeof props.status === 'string' && props.status !== '' ? props.status : 'idle';
  const text = props.text ?? wfCardStatusText(status);
  const parts = React.createElement('span', {
    className: 'zwf-state',
    'data-status': status,
    'data-testid': props.testId,
    'data-workflow-run-lamp': status,
  }, React.createElement(WfCardLamp, { status }),
  React.createElement('span', null, text),
  typeof props.stopReason === 'string' && WF_CARD_STOP_REASONS.has(props.stopReason)
    ? React.createElement('span', { className: 'zwf-state-note', 'data-testid': props.stopReasonTestId }, ` · ${wfCardSay(`run.stopReason.${props.stopReason}`)}`)
    : null,
  props.resumable === true
    ? React.createElement('span', { className: 'zwf-state-note' }, ` · ${wfCardSay('run.resumable')}`)
    : null);
  return parts;
}

/**
 * One card frame: header row, optional body, optional footer.
 * Every card renders through this so the row rhythm and the disclosure behaviour match.
 */
function WfCardShell(props) {
  const t = typeof props.t === 'function' ? props.t : wfCardSay;
  const toggleLabel = t(props.open === true ? 'card.collapseDetails' : 'card.expandDetails');
  const chevron = props.expandable === true
    ? React.createElement(WfCardIconButton, {
      testId: props.toggleTestId,
      icon: React.createElement(WfCardChevron, { open: props.open === true }),
      label: toggleLabel,
      title: toggleLabel,
      expanded: props.open === true,
      onClick: (event) => {
        if (event !== null && typeof event === 'object' && typeof event.stopPropagation === 'function') event.stopPropagation();
        props.onToggle?.();
      },
    })
    : null;
  const head = React.createElement('div', { className: 'zwf-card-head', 'data-testid': props.headTestId },
    React.createElement('span', { className: 'zwf-card-glyph' }, props.icon ?? React.createElement(WF_UI.icons.workflow, { size: 15 })),
    React.createElement('span', {
      className: 'zwf-card-kind',
      'data-live': props.live === true ? 'true' : 'false',
      'data-testid': props.kindTestId,
      title: props.kindTitle,
    }, props.kind),
    props.separator === true && props.summary !== undefined && props.summary !== ''
      ? React.createElement('span', { className: 'zwf-card-sep' }, '·')
      : null,
    props.summary === undefined || props.summary === ''
      ? null
      : React.createElement('span', {
        className: `zwf-card-name${props.summaryMono === true ? ' zwf-mono-tab' : ''}`,
        title: props.summary,
        'data-testid': props.nameTestId,
      }, props.summary),
    React.createElement('span', { className: 'zwf-card-cluster' },
      props.status ?? null,
      props.detail === undefined || props.detail === ''
        ? null
        : React.createElement('span', { className: 'zwf-card-detail', title: props.detail, 'data-testid': props.detailTestId }, props.detail),
      props.actions ?? null,
      chevron));
  const children = [head];
  if (props.expandable === true && props.open === true && props.body !== undefined) {
    children.push(React.createElement('div', { className: 'zwf-card-body', key: 'body', 'data-testid': props.bodyTestId }, props.body));
  }
  if (props.footer !== undefined) children.push(props.footer);
  return React.createElement('section', {
    className: 'zwf-card',
    'data-tool': props.tool,
    'data-state': props.state,
    'data-testid': props.testId,
  }, children);
}

/* ------------------------------- expansion state --------------------------- */

/**
 * Expansion remembered per tool call, so a transcript re-render keeps a card open.
 * `forceOpen` pins it open and drops the toggle.
 */
const WF_CARD_OPEN = new Map();

function useWfCardOpen(toolId, defaultOpen, forceOpen, canToggle) {
  const [open, setOpen] = React.useState(() => {
    if (toolId !== undefined && WF_CARD_OPEN.has(toolId)) return WF_CARD_OPEN.get(toolId) === true;
    return defaultOpen === true;
  });
  const toggle = React.useCallback(() => {
    setOpen((previous) => {
      const next = previous !== true;
      if (toolId !== undefined) WF_CARD_OPEN.set(toolId, next);
      return next;
    });
  }, [toolId]);
  if (forceOpen === true) return { open: true, toggle, expandable: false };
  return { open: open === true, toggle, expandable: canToggle !== false };
}

/* ---------------------------------- dispatch ------------------------------- */

/** The run id a card's arguments already name, before the result arrives. */
function wfCardArgRunId(model) {
  return wfCardFirstText(model.args('run_id'), model.args('runId'), model.args('run')) || undefined;
}

/** The run id a settled result names for the given tool. */
function wfCardResultRunId(model) {
  if (model.failed) return wfCardArgRunId(model);
  const text = model.resultText;
  const structured = model.structured;
  const fromValue = structured === undefined
    ? ''
    : wfCardFirstText(structured.runId, structured.run_id, wfCardRecord(structured.run) ? structured.run.id : undefined, structured.id);
  if (fromValue !== '') return fromValue;
  const patterns = {
    CreateWorkflow: /^Run ID:\s*(\S+)/m,
    AmendWorkflow: /^Started revised run\s+(\S+)/m,
    GetWorkflowRun: /^Run\s+(\S+)\s/m,
    TaskOutput: /^Run\s+(\S+)\s/m,
    StopWorkflowRun: /^Stopped run\s+(\S+?)\./m,
    ResumeWorkflowRun: /^Resumed run\s+\S+\s+as\s+([^\s(]+)/m,
    FillWorkflowHole: /on run\s+(\S+?);/m,
  };
  const pattern = patterns[model.key];
  if (pattern !== undefined) {
    const match = pattern.exec(text);
    if (match !== null && typeof match[1] === 'string' && match[1] !== '') return match[1];
  }
  return wfCardArgRunId(model);
}

/** Open one run (or its script steps) in the right Sidebar; false when unavailable. */
function wfCardOpenDetail(params) {
  if (typeof WF_DETAIL !== 'object' || WF_DETAIL === null || typeof WF_DETAIL.open !== 'function') return false;
  try {
    WF_DETAIL.open(params);
    return true;
  } catch (error) {
    console.warn('zcode-workflow: run detail failed to open', error);
    return false;
  }
}

/** Read a late-loaded surface (`WF_PERMISSION`) without tripping its temporal dead zone. */
function wfCardSurface(name) {
  try {
    const surface = name === 'permission' ? WF_PERMISSION : undefined;
    return wfCardRecord(surface) || typeof surface === 'function' ? surface : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One workflow tool card.
 * @param {object} props slot payload (see the header comment)
 */
function WorkflowCard(props) {
  const model = React.useMemo(() => wfCardModel(props), [props]);
  const live = useWfCardRun(model); // eslint-disable-line no-undef -- 31-cache.js
  const openState = useWfCardOpen(model.toolId, wfCardDefaultOpen(model), model.forceOpen, model.canToggle);
  const render = Object.prototype.hasOwnProperty.call(WF_CARDS.render, model.key)
    ? WF_CARDS.render[model.key]
    : WF_CARDS.render.default;
  return React.createElement(render, {
    model,
    live,
    open: openState.open,
    toggle: openState.toggle,
    expandable: openState.expandable,
    t: wfCardSay,
  });
}

/** Cards arrive expanded, as the product's per-call memory defaults to open. */
function wfCardDefaultOpen() {
  return true;
}
