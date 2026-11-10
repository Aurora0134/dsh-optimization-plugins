/* `EvalWorkflowSnippet` card (ZCode `vsn`).
 *
 * The smallest card of the family: a title row (`工作流片段 · 5667ms`) and a body that switches
 * between the running code, the returned value and the failure report. The duration wording is the
 * part users quoted from the product, so it keeps the product's two units:
 *
 *   running   `{n}s`    — whole seconds since the snippet started;
 *   settled   `{n}ms`   — the duration the tool reports, unrounded.
 *
 * The tool result wraps the value in a protocol shell (`The snippet completed in 12ms.`,
 * `Return value:`, `Logs:`); `wfSnippetBody` strips it so the card shows what the script produced.
 */

/* ---------------------------------- glyph ---------------------------------- */

/** The snippet glyph: a flask, matching the product's science-instrument icon. */
const WF_SNIPPET_GLYPH = wfIcon([
  ['path', { d: 'M9.5 3.5h5M11 3.5v5.2L6.2 17a2.2 2.2 0 0 0 1.9 3.3h7.8a2.2 2.2 0 0 0 1.9-3.3L13 8.7V3.5' }],
  ['path', { d: 'M8.1 14.4h7.8' }],
]);

/* --------------------------------- readers --------------------------------- */

/** Strip the tool's protocol shell from a snippet result; '' when nothing is left. */
function wfSnippetBody(text) {
  let value = typeof text === 'string' ? text : '';
  if (value === '') return '';
  value = value.replace(/^The snippet completed in \d+ms\.\n?/u, '');
  value = value.replace(/^It returned no value\.\n?/u, '');
  value = value.replace(/^Return value:\n/u, '');
  value = value.replace(/^The snippet has errors:\n[\s\S]*?NOTE: [^\n]*\n?/u, '');
  value = value.replace(/\n\nLogs:\n(- [^\n]*\n?)*(\(logs truncated\))?\s*$/u, '');
  const trimmed = value.trim();
  return trimmed === '' ? '' : trimmed;
}

/** Log lines the tool appends after the result, when it reports any. */
function wfSnippetLogs(text) {
  const match = /\n\nLogs:\n([\s\S]*)$/u.exec(typeof text === 'string' ? text : '');
  if (match === null) return [];
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^- /u, '').trim())
    .filter((line) => line !== '' && line !== '(logs truncated)');
}

/** A returned value as code: JSON pretty-printed when it parses, plain text otherwise. */
function wfSnippetValue(text) {
  const body = wfSnippetBody(text);
  if (body === '') return { code: '', language: 'text' };
  try {
    return { code: JSON.stringify(JSON.parse(body), null, 2), language: 'json' };
  } catch {
    return { code: body, language: 'text' };
  }
}

/** `{n}s` while running, `{n}ms` once the tool reports a duration. */
function wfSnippetDuration(model, startedAt) {
  if (model.phase !== 'result') {
    if (typeof startedAt !== 'number') return '';
    return `${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s`;
  }
  const structured = wfCardRecord(model.structured) ? model.structured : undefined;
  const direct = wfCardNum(structured === undefined ? undefined : structured.durationMs);
  if (direct !== undefined) return `${direct}ms`;
  const match = /completed in (\d+)ms/u.exec(model.resultText);
  return match === null ? '' : `${match[1]}ms`;
}

/* --------------------------------- sections -------------------------------- */

/** One titled block of the snippet body. */
function WfSnippetSection(props) {
  return React.createElement('section', { className: 'zwf-section', 'data-testid': props.testId },
    React.createElement('span', { className: 'zwf-section-label' }, props.title),
    props.children);
}

/** Snippet body styles: the details block and the log pre of the failure report. */
const WF_CARDS_SNIPPET_CSS = `
.zwf-mono-tab{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-variant-numeric:tabular-nums}
.zwf-details{display:flex;flex-direction:column;gap:4px;min-width:0}
.zwf-details-summary{cursor:pointer;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-caption)}
.zwf-details-summary:hover{color:var(--dsw-alias-label-primary)}
.zwf-details[open] .zwf-details-summary{color:var(--dsw-alias-label-secondary)}
.zwf-prewrap{margin:0;box-sizing:border-box;max-height:256px;overflow:auto;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere}
`;

WF_STYLE_PARTS.push(WF_CARDS_SNIPPET_CSS);

/* ----------------------------------- card ---------------------------------- */

/** `EvalWorkflowSnippet` card. */
function WfSnippetCard(props) {
  const model = props.model;
  const t = wfCardSay;
  const startedAt = React.useRef(Date.now());
  const running = model.phase !== 'result';
  const duration = wfSnippetDuration(model, startedAt.current);
  const code = model.argText('code');
  const filePath = model.argText('path');
  const value = wfSnippetValue(model.resultText);
  const logs = wfSnippetLogs(model.resultText);
  const diagnostics = wfCardDiagnostics(model);
  const shownCode = code === undefined ? (filePath === undefined ? '' : `// ${filePath}`) : code;

  const body = [];
  if (running) {
    if (shownCode !== '') {
      body.push(React.createElement('div', { key: 'running', 'data-testid': 'snippet-running-code' },
        WfCodeBlock({ code: shownCode, maxHeight: 320 })));
    }
  } else if (model.failed === true) {
    if (diagnostics.length > 0) body.push(React.createElement(WfCardDiagnostics, { key: 'diag', diagnostics, failed: true }));
    if (value.code !== '') {
      body.push(React.createElement(WfSnippetSection, {
        key: 'result',
        testId: 'snippet-result',
        title: wfCardSay('status.failed'),
      }, WfCodeBlock({ code: value.code, maxHeight: 320 })));
    }
    body.push(React.createElement(WfSnippetSection, {
      key: 'logs',
      testId: 'snippet-logs',
      title: wfCardSay('snippet.section.logs'),
    }, logs.length === 0
      ? React.createElement('p', { className: 'zwf-note' }, wfCardSay('snippet.logsEmpty'))
      : React.createElement('pre', { className: 'zwf-prewrap' }, logs.join('\n'))));
    if (shownCode !== '') {
      body.push(React.createElement('details', { key: 'code', className: 'zwf-details', 'data-testid': 'snippet-code' },
        React.createElement('summary', { className: 'zwf-details-summary' }, wfCardSay('snippet.section.code')),
        WfCodeBlock({ code: shownCode, maxHeight: 256 })));
    }
    if (diagnostics.length > WF_CARD_DIAG_LIMIT) {
      body.push(React.createElement('p', { className: 'zwf-note', key: 'truncated' }, wfCardSay('workflow.truncated')));
    }
  } else {
    body.push(React.createElement(WfSnippetSection, {
      key: 'value',
      testId: 'snippet-result',
      title: wfCardSay('snippet.section.response'),
    }, value.code === ''
      ? React.createElement('p', { className: 'zwf-note' }, wfCardSay('snippet.logsEmpty'))
      : WfCodeBlock({ code: value.code, maxHeight: 320 })));
    if (logs.length > 0) {
      body.push(React.createElement(WfSnippetSection, {
        key: 'logs',
        testId: 'snippet-logs',
        title: wfCardSay('snippet.section.logs'),
      }, React.createElement('pre', { className: 'zwf-prewrap' }, logs.join('\n'))));
    }
  }

  const status = model.failed === true
    ? React.createElement('span', { className: 'zwf-state', 'data-status': 'errored' }, wfCardSay('status.failed'))
    : running
      ? React.createElement('span', { className: 'zwf-state', 'data-status': 'running' }, React.createElement(WFSpinner, { inline: true }))
      : React.createElement('span', { className: 'zwf-state', 'data-status': 'completed' }, wfCardSay('snippet.passed'));

  const expandable = props.expandable === true && body.length > 0;
  return React.createElement(WfCardShell, {
    tool: model.key,
    state: model.failed === true ? 'error' : running ? 'running' : 'ok',
    icon: React.createElement(WF_SNIPPET_GLYPH, { size: 15 }),
    kind: wfCardSay(running ? 'snippet.validating' : 'snippet.ran'),
    live: running,
    separator: true,
    summary: duration,
    summaryMono: true,
    status,
    body: body.length === 0 ? undefined : body,
    expandable,
    open: props.open,
    onToggle: props.toggle,
    bodyTestId: 'workflow-snippet-body',
  });
}

WF_CARDS.render.EvalWorkflowSnippet = WfSnippetCard;
