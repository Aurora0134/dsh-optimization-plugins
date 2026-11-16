/* Script blocks, compiler feedback and amend setting rows.
 *
 * The three presentations the workflow cards share:
 *
 *   WfCardScriptBlock      a TypeScript block with line numbers and the diagnostic lines marked —
 *                          the run card's `workflow-script-codeblock` and the permission block's
 *                          script viewer use the same renderer;
 *   WfCardDiagnostics      the compiler feedback block (`workflow-compiler-feedback`), shared by the
 *                          run card, the snippet card and the failed-launch card;
 *   WfSettingsChangeRow    what an AmendWorkflow changed, since the product shows a setting table
 *                          instead of a diff.
 */

/** How many diagnostic lines one block shows. */
const WF_CARD_DIAG_LIMIT = 6;

/** Source blocks, the script disclosure and the amend setting rows. */
const WF_CARDS_SCRIPT_CSS = `
.zwf-code{display:flex;flex-direction:column;box-sizing:border-box;min-width:0;max-height:320px;overflow:auto;padding:6px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-1))}
.zwf-code-line{display:flex;min-width:0;padding:0 10px 0 0;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;white-space:pre;tab-size:2}
.zwf-code-line[data-marked="true"]{background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 14%,transparent)}
.zwf-code-gutter{flex:none;width:34px;padding-right:8px;text-align:right;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;user-select:none}
.zwf-code-text{min-width:0;color:var(--dsw-alias-label-primary);white-space:pre}
.zwf-diag{display:flex;flex-direction:column;gap:4px;box-sizing:border-box;min-width:0;padding:7px 9px;border:1px solid color-mix(in oklab,var(--dsw-alias-state-error-primary) 36%,var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-sm,8px);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 7%,transparent)}
.zwf-diag-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-state-error-primary)}
.zwf-diag-lede{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-diag-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin:0;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.zwf-script{display:flex;flex-direction:column;gap:4px;min-width:0}
.zwf-script-toggle{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;max-width:100%;margin:0;padding:2px 0;border:0;background:transparent;color:var(--dsw-alias-label-caption);font:inherit;font-size:12px;line-height:18px;font-weight:500;cursor:pointer}
.zwf-script-toggle:hover{color:var(--dsw-alias-label-primary)}
.zwf-script-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:5px}
.zwf-script-toggle-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-script-body{min-width:0;max-height:288px;overflow:auto}
.zwf-settings-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-timeline{display:flex;box-sizing:border-box;min-width:0;overflow-x:auto;padding:2px 0}
.zwf-timeline-scroller{display:flex;align-items:flex-start;gap:14px;min-width:0}
.zwf-station{display:flex;flex-direction:column;gap:4px;flex:0 0 auto;min-width:0;max-width:220px}
.zwf-station-head{display:flex;align-items:center;gap:5px;min-width:0}
.zwf-station-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary)}
.zwf-pills{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0}
.zwf-pill{display:inline-flex;box-sizing:border-box;align-items:center;gap:5px;min-width:0;max-width:180px;height:22px;padding:0 6px;border:0;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:17px;text-align:left}
.zwf-pill[data-agent-open="true"]{cursor:pointer}
.zwf-pill[data-agent-open="true"]:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.zwf-pill[data-agent-open="true"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-pill-avatar{display:inline-flex;flex:none;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.zwf-pill-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-pill-tail{display:inline-flex;flex:none;align-items:center}
`;

WF_STYLE_PARTS.push(WF_CARDS_SCRIPT_CSS);

/* ------------------------------- diagnostics ------------------------------- */

/** `path:12:5 message`, `line 12: message`, `[rule] message` — the shapes the compiler emits. */
const WF_CARD_DIAG_PATTERNS = [
  /^(?<path>[^\s:]+):(?<line>\d+):(?<column>\d+)\s+(?<message>.+)$/,
  /^line\s+(?<line>\d+):\s*(?<message>.+)$/,
  /^(?<message>.+?)\s*\[(?<rule>[a-z0-9_.-]+)\]$/i,
];

/**
 * Compiler diagnostics of one card.
 * A structured `diagnostics` array wins over the text form because it keeps line and rule apart.
 * @returns {{line?: number, column?: number, message: string, rule?: string, severity: string}[]}
 */
function wfCardDiagnostics(model) {
  const structured = wfCardRecord(model.structured) ? model.structured.diagnostics : undefined;
  const rows = [];
  if (Array.isArray(structured)) {
    for (const entry of structured) {
      if (wfCardRecord(entry)) {
        const message = wfCardFirstText(entry.message, entry.text);
        if (message === '') continue;
        rows.push({
          line: wfCardNum(entry.line),
          column: wfCardNum(entry.column),
          message,
          rule: wfCardFirstText(entry.rule, entry.code) || undefined,
          severity: wfCardFirstText(entry.severity) || 'error',
        });
        continue;
      }
      if (typeof entry === 'string' && entry.trim() !== '') {
        rows.push({ message: entry.trim(), severity: 'error' });
      }
    }
    if (rows.length > 0) return rows;
  }
  for (const line of model.resultText.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    for (const pattern of WF_CARD_DIAG_PATTERNS) {
      const match = pattern.exec(text);
      if (match === null) continue;
      const groups = match.groups ?? {};
      rows.push({
        line: groups.line === undefined ? undefined : Number(groups.line),
        column: groups.column === undefined ? undefined : Number(groups.column),
        message: groups.message ?? text,
        rule: groups.rule,
        severity: 'error',
      });
      break;
    }
  }
  return rows;
}

/** Called lines of a source, for the code gutter marks. */
function wfCardMarkedLines(diagnostics) {
  const lines = new Set();
  for (const diagnostic of diagnostics ?? []) {
    if (typeof diagnostic.line === 'number' && diagnostic.line > 0) lines.add(diagnostic.line);
  }
  return lines;
}

/**
 * The compiler feedback block (`i1`).
 * A passing compile is not shown: the block exists to explain why nothing ran.
 */
function WfCardDiagnostics(props) {
  const diagnostics = Array.isArray(props.diagnostics) ? props.diagnostics : [];
  if (diagnostics.length === 0) return null;
  const shown = diagnostics.slice(0, WF_CARD_DIAG_LIMIT);
  const more = diagnostics.length - shown.length;
  return React.createElement('div', {
    className: 'zwf-diag',
    'data-testid': 'workflow-compiler-feedback',
    role: 'status',
  },
  React.createElement('div', { className: 'zwf-diag-head' },
    React.createElement(WF_ICON.alert, { size: 13 }),
    React.createElement('span', { 'data-testid': 'workflow-compiler-feedback-title' }, wfCardSay('workflow.feedback')),
    React.createElement('span', { 'data-testid': 'workflow-compiler-feedback-count' }, wfCardSayCount('feedback.countOne', 'feedback.count', diagnostics.length))),
  React.createElement('p', {
    className: 'zwf-diag-lede',
    'data-testid': 'workflow-compiler-feedback-lede',
  }, wfCardSay('feedback.lede')),
  shown.map((diagnostic, index) => React.createElement('p', {
    className: 'zwf-diag-line',
    key: `diag-${index}`,
    'data-testid': 'workflow-compiler-feedback-line',
  },
  typeof diagnostic.line === 'number' ? React.createElement('span', { className: 'zwf-card-detail' }, `L${diagnostic.line}${typeof diagnostic.column === 'number' ? `:${diagnostic.column}` : ''}`) : null,
  React.createElement('span', null, diagnostic.message),
  diagnostic.rule === undefined ? null : React.createElement('span', { className: 'zwf-card-detail' }, wfCardSay('feedback.rule', { code: diagnostic.rule })))),
  more > 0 ? React.createElement('p', { className: 'zwf-note' }, wfCardSay('workflow.truncated')) : null);
}

/* -------------------------------- code block -------------------------------- */

/** One line of a code block, with the gutter and the diagnostic mark. */
function WfCodeLine(props) {
  return React.createElement('div', {
    className: 'zwf-code-line',
    'data-marked': props.marked === true ? 'true' : undefined,
  },
  props.gutter === true ? React.createElement('span', { className: 'zwf-code-gutter' }, String(props.number)) : null,
  React.createElement('span', { className: 'zwf-code-text' }, props.text === '' ? ' ' : props.text));
}

/**
 * A source block: line numbers, marked diagnostic lines, one scroll container.
 * @param {{code: string, gutter?: boolean, marked?: Set<number>, testId?: string, maxHeight?: number}} props
 */
function WfCodeBlock(props) {
  const code = typeof props.code === 'string' ? props.code : '';
  const lines = code === '' ? [] : code.replace(/\r\n/g, '\n').split('\n');
  const marked = props.marked ?? new Set();
  return React.createElement('div', {
    className: 'zwf-code',
    'data-testid': props.testId,
    style: props.maxHeight === undefined ? undefined : { maxHeight: `${props.maxHeight}px`, overflow: 'auto' },
  }, lines.map((line, index) => React.createElement(WfCodeLine, {
    key: `line-${index}`,
    number: index + 1,
    text: line,
    gutter: props.gutter !== false,
    marked: marked.has(index + 1),
  })));
}

/** `workflow-script-codeblock`: the script with its failing lines marked. */
function WfCardScriptBlock(props) {
  const diagnostics = Array.isArray(props.diagnostics) ? props.diagnostics : [];
  return WfCodeBlock({
    code: props.script,
    marked: wfCardMarkedLines(diagnostics),
    testId: 'workflow-script-codeblock',
    maxHeight: 320,
  });
}

/**
 * The `显示完整脚本` disclosure of a card whose call produced no run.
 * Collapsed by default; the trigger is the spec's `workflow-card-script-toggle`.
 */
function WfCardScriptDisclosure(props) {
  const [open, setOpen] = React.useState(false);
  const label = wfCardSay(open ? 'script.hide' : 'script.show');
  return React.createElement('div', { className: 'zwf-script' },
    React.createElement('button', {
      type: 'button',
      className: 'zwf-script-toggle',
      'data-testid': 'workflow-card-script-toggle',
      'aria-expanded': open ? 'true' : 'false',
      onClick: () => setOpen((previous) => previous !== true),
    },
    React.createElement(WfCardChevron, { open }),
    React.createElement('span', { className: 'zwf-script-toggle-text' }, label)),
    open
      ? React.createElement('div', { className: 'zwf-script-body' },
        React.createElement(WfCardScriptBlock, { script: props.script, diagnostics: props.diagnostics }))
      : null);
}

/* ----------------------------- amend set changes ---------------------------- */

/**
 * The rows an AmendWorkflow introduced, in the product's wording.
 * There is no line diff: the card reports the settings that moved and whether the script changed.
 */
function wfCardSettingsRows(model) {
  if (model.key !== 'AmendWorkflow') return [];
  const settings = wfCardFirst(model.args('settings'), model.args('adjust'));
  const rows = [];
  if (wfCardRecord(settings)) {
    const model0 = wfCardFirstText(settings.subagent_model, settings.subagentModel);
    if (model0 === 'session') rows.push(wfCardSay('settingsChange.modelSession'));
    else if (model0 !== '') rows.push(wfCardSay('settingsChange.model', { model: model0 }));
    const limit = wfCardNum(wfCardFirst(settings.max_concurrency, settings.maxConcurrency));
    if (limit !== undefined) rows.push(wfCardSay('settingsChange.limit', { n: limit }));
  }
  const subagentModel = model.argText('subagent_model') ?? model.argText('subagentModel');
  if (rows.length === 0 && subagentModel !== undefined) {
    if (subagentModel === 'session') rows.push(wfCardSay('settingsChange.modelSession'));
    else rows.push(wfCardSay('settingsChange.model', { model: subagentModel }));
  }
  const limit = wfCardNum(wfCardFirst(model.args('max_concurrency'), model.args('maxConcurrency')));
  if (limit !== undefined && rows.length === 0) rows.push(wfCardSay('settingsChange.limit', { n: limit }));
  return rows;
}

/** `workflow-settings-change-row`: one amended setting. */
function WfSettingsChangeRow(props) {
  const rows = wfCardSettingsRows(props.model);
  if (rows.length === 0) return null;
  return React.createElement('div', {
    className: 'zwf-settings-row',
    'data-testid': 'workflow-settings-change-row',
  },
  React.createElement('span', { className: 'zwf-section-label' }, wfCardSay('settingsChange.kind')),
  React.createElement('span', { className: 'zwf-card-parts' },
    rows.map((row, index) => React.createElement(WF_FRAGMENT, { key: `row-${index}` },
      index > 0 ? React.createElement('span', { className: 'zwf-card-sep' }, '·') : null,
      React.createElement('span', null, row)))));
}
