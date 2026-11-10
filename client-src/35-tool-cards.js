/* The remaining workflow tool cards.
 *
 * Each renderer here reads one tool's own contract and never borrows the run card's:
 *
 *   GetWorkflowRun / TaskOutput   the status card (`Xsn`): summary line, phase table, subagent
 *                                 tallies, health line, log tail, interruption and truncation notes;
 *   ListWorkflowRuns              the instance list (count, rows, interruption flags);
 *   ListSavedWorkflows            the saved-workflow catalogue (count, rows, unreadable files);
 *   SaveWorkflow                  the save card (name, scope, overwrite badge, path, argument table);
 *   StopWorkflowRun               the stop acknowledgement;
 *   ResumeWorkflowRun             the resume card (new run id, background hint);
 *   Resolve…Question              the answer card (question id, answer, outcome);
 *   default                       an unknown workflow tool: kind, output, diagnostics.
 */

/** Status card, list rows and argument tables. */
const WF_CARDS_TOOL_CSS = `
.zwf-phase-table{display:flex;flex-direction:column;gap:2px;box-sizing:border-box;min-width:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1)}
.zwf-phase-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;min-width:0;font-size:12.5px;line-height:19px}
.zwf-phase-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.zwf-phase-state{flex:none;color:var(--dsw-alias-label-secondary)}
.zwf-phase-state[data-state="done"]{color:var(--dsw-alias-state-success-primary)}
.zwf-phase-state[data-state="current"]{color:var(--dsw-alias-state-warn-primary)}
.zwf-phase-state[data-state="ahead"]{color:var(--dsw-alias-label-caption)}
.zwf-phase-state[data-state="unfinished"]{color:var(--dsw-alias-label-secondary)}
.zwf-run-line{display:flex;align-items:baseline;gap:6px;min-width:0}
.zwf-run-line-text{min-width:0;overflow-wrap:anywhere}
`;

WF_STYLE_PARTS.push(WF_CARDS_TOOL_CSS);

/* --------------------------------- shared ---------------------------------- */

/** Section list → body nodes; an empty section disappears so a card never shows a bare label. */
function wfCardSections(sections) {
  const nodes = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    if (section === undefined || section === null) continue;
    if (section.text !== undefined && String(section.text).trim() === '') continue;
    nodes.push(React.createElement('section', {
      className: 'zwf-section',
      key: section.key ?? `section-${nodes.length}`,
      'data-testid': section.testId,
    },
    section.title === undefined ? null : React.createElement('span', { className: 'zwf-section-label' }, section.title),
    section.node ?? React.createElement('pre', { className: 'zwf-pre' }, section.text)));
  }
  return nodes;
}

/* ------------------------------ GetWorkflowRun ----------------------------- */

/** Phase rows of the status card, merged from the run's stations and its per-phase tallies. */
function wfGetRunPhases(run) {
  const stations = wfRunStations(run);
  const detail = wfRunField(run, 'phasesDetail');
  const byName = new Map();
  if (Array.isArray(detail)) {
    for (const phase of detail) {
      if (wfCardRecord(phase) && typeof phase.name === 'string') byName.set(phase.name, phase);
    }
  }
  return stations.map((station, index) => {
    const record = byName.get(station.name);
    const state = station.status === 'running' ? 'current'
      : station.status === 'done' ? 'done'
        : station.status === 'failed' ? 'unfinished'
          : 'ahead';
    const ended = wfCardNum(record === undefined ? undefined : record.endedAt);
    const started = wfCardNum(record === undefined ? undefined : record.startedAt);
    return {
      index: index + 1,
      name: station.name,
      state,
      rounds: station.rounds,
      settled: wfCardNum(record === undefined ? undefined : record.settled) ?? wfCardNum(record === undefined ? undefined : record.asks) ?? 0,
      running: station.status === 'running' ? 1 : 0,
      duration: started === undefined ? '' : WF_UI.duration(started, ended ?? Date.now()),
    };
  });
}

/** The `getRun` phase table (`zsn`). */
function WfGetRunPhaseTable(props) {
  const rows = props.rows;
  if (rows.length === 0) return null;
  return React.createElement('div', { className: 'zwf-phase-table', 'data-testid': 'workflow-run-phases' },
    rows.map((row) => React.createElement('div', { className: 'zwf-phase-row', key: `${row.name}-${row.index}`, 'data-testid': 'workflow-run-line' },
      React.createElement('span', { className: 'zwf-card-detail' }, `${row.index}.`),
      React.createElement('span', { className: 'zwf-phase-name', title: row.name }, row.name),
      React.createElement('span', { className: `zwf-phase-state`, 'data-state': row.state }, wfCardSay(`getRun.phase.state.${row.state}`)),
      row.rounds === undefined || row.rounds < 2 ? null : React.createElement('span', { className: 'zwf-card-detail' }, wfCardSayCount('getRun.phase.roundsOne', 'getRun.phase.rounds', row.rounds)),
      row.settled === 0 ? null : React.createElement('span', { className: 'zwf-card-detail' }, wfCardSay('getRun.phase.settled', { count: row.settled })),
      row.running === 0 ? null : React.createElement('span', { className: 'zwf-card-detail' }, wfCardSay('getRun.phase.running', { count: row.running })),
      row.duration === '' ? null : React.createElement('span', { className: 'zwf-card-detail' }, wfCardSay('getRun.phase.soFar', { duration: row.duration })))));
}

/** The `getRun` subagent tallies (`Usn`). */
function WfGetRunAgents(props) {
  const agents = props.agents;
  if (agents.length === 0) return null;
  return React.createElement('div', { className: 'zwf-chips', 'data-testid': 'workflow-run-subagents' },
    agents.map((agent, index) => React.createElement('span', {
      className: 'zwf-pill',
      key: `${agent.name}-${index}`,
      'data-testid': 'workflow-run-line',
      'data-agent-status': agent.status,
      title: agent.phaseName === '' ? agent.name : wfCardSay('getRun.subagent.phase', { name: agent.phaseName }),
    },
    React.createElement('span', { className: 'zwf-pill-avatar' }, React.createElement(WF_ICON.agent, { size: 10 })),
    React.createElement('span', { className: 'zwf-pill-name' }, agent.name),
    React.createElement('span', { className: 'zwf-card-detail' }, wfCardSay(`getRun.subagent.state.${wfGetRunAgentState(agent.status)}`)))));
}

/** Map the run's actor status onto the status card's wording. */
function wfGetRunAgentState(status) {
  switch (status) {
    case 'running':
      return 'executing';
    case 'waiting':
      return 'waiting';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

/** The `getRun` health line (`Vsn`): only the facts the snapshot actually carries. */
function wfGetRunHealthParts(run) {
  const parts = [];
  const updated = wfCardNum(wfRunField(run, 'updatedAt', 'updated_at', 'lastEventAt'));
  if (updated !== undefined) parts.push(wfCardSay('getRun.health.lastProgress', { age: wfCardAge(Date.now() - updated) }));
  const concurrency = wfRunField(run, 'concurrency');
  if (wfCardRecord(concurrency)) {
    const cap = wfCardNum(concurrency.cap) ?? 0;
    const effective = wfCardNum(concurrency.limit) ?? cap;
    parts.push(wfCardSay('getRun.health.concurrency', { effective, cap }));
  }
  const steps = wfRunSteps(run);
  if (steps.failed > 0) {
    parts.push(wfCardSayCount('getRun.health.failuresOne', 'getRun.health.failures', steps.failed));
  }
  const cached = wfCardNum(wfRunField(run, 'cachedSteps'));
  if (cached !== undefined && cached > 0) {
    parts.push(wfCardSayCount('getRun.health.cachedStepsOne', 'getRun.health.cachedSteps', cached));
  }
  return parts;
}

/** GetWorkflowRun / TaskOutput card. */
function WfGetRunCard(props) {
  const model = props.model;
  const live = props.live;
  const structured = wfCardRecord(model.structured) ? model.structured : undefined;
  const fromTool = structured === undefined ? undefined : wfCardRecord(structured.run) ? structured.run : structured;
  const run = wfRunId(fromTool) !== '' ? fromTool : (live?.run ?? live?.summary);
  const settled = model.phase === 'result';
  const status = run === undefined ? '' : wfRunStatus(run);
  const runId = wfRunId(run) || wfCardResultRunId(model);
  const steps = run === undefined ? { total: 0, done: 0, failed: 0, running: 0 } : wfRunSteps(run);
  const agents = run === undefined ? [] : wfRunAgents(run);
  const phases = run === undefined ? [] : wfGetRunPhases(run);
  const tokens = run === undefined ? 0 : wfRunTokens(run);
  const logTail = run === undefined ? [] : wfCardLogTail(run);
  const healthParts = run === undefined ? [] : wfGetRunHealthParts(run);
  const interrupted = wfCardRecord(run) && wfRunField(run, 'possibleInterruption') === true;
  const questionsUnknown = wfCardRecord(run) && wfCardRecord(wfRunField(run, 'health')) && wfRunField(run, 'health').pendingQuestionsKnown === false;

  const sections = [];
  const summary = wfCardRecord(run) ? wfRunName(run) : '';
  if (settled && model.failed === true) {
    sections.push({ key: 'error', testId: 'workflow-run-error-message', title: wfCardSay('getRun.section.error'), text: model.resultText });
  }
  if (phases.length > 0) {
    sections.push({
      key: 'phases',
      title: wfCardSay('getRun.section.actors'),
      node: React.createElement(WfGetRunPhaseTable, { rows: phases }),
    });
  }
  if (agents.length > 0) {
    sections.push({
      key: 'agents',
      title: wfCardSay('getRun.section.actors'),
      node: React.createElement(WfGetRunAgents, { agents }),
    });
  }
  if (run !== undefined && status === 'completed') {
    const result = wfCardFirstText(wfRunField(run, 'result'), wfRunField(run, 'resultPreview'));
    if (result !== '') {
      sections.push({ key: 'result', testId: 'workflow-run-result', title: wfCardSay('getRun.section.result'), text: result });
    }
  }
  if (logTail.length > 0) {
    sections.push({
      key: 'log',
      title: wfCardSay('getRun.section.logTail'),
      text: logTail.join('\n'),
    });
  }

  const body = [];
  if (summary !== '') {
    body.push(React.createElement('p', { className: 'zwf-note', key: 'summary', 'data-testid': 'workflow-run-summary' }, summary));
  }
  if (questionsUnknown) {
    body.push(React.createElement('p', { className: 'zwf-note', key: 'questions', 'data-tone': 'warn', 'data-testid': 'workflow-run-questions-unknown' }, wfCardSay('getRun.questionsUnknown')));
  }
  for (const node of wfCardSections(sections)) body.push(node);
  if (healthParts.length > 0) {
    body.push(React.createElement('p', { className: 'zwf-note', key: 'health', 'data-testid': 'workflow-run-rail' },
      React.createElement('span', { 'data-testid': 'workflow-run-health' }, healthParts.join(' · '))));
  }
  if (run !== undefined) {
    const line = [];
    line.push(wfCardSay(`run.status.${status}`));
    const stopReason = wfCardFirstText(wfRunField(run, 'stopReason', 'stop_reason'));
    if (stopReason !== '') line.push(wfCardSay(`run.stopReason.${stopReason}`));
    line.push(wfCardSay('getRun.nodesLine', {
      observed: steps.total,
      done: steps.done,
      running: steps.running,
      failed: steps.failed,
    }));
    line.push(wfCardSay('run.usage.tokens', { tokens: tokens.toLocaleString() }));
    body.push(React.createElement('p', { className: 'zwf-note', key: 'status-line', 'data-testid': 'workflow-run-status-row' }, line.join(' · ')));
  }
  if (interrupted) {
    body.push(React.createElement('p', { className: 'zwf-note', key: 'interrupted', 'data-tone': 'warn', 'data-testid': 'workflow-run-untracked' }, wfCardSay('getRun.interruptedHint')));
  }
  if (wfCardRecord(run) && run.truncated === true) {
    body.push(React.createElement('p', { className: 'zwf-note', key: 'truncated', 'data-testid': 'workflow-run-truncated' }, wfCardSay('getRun.truncated')));
  }
  if (body.length === 0 && settled) {
    body.push(React.createElement('pre', { className: 'zwf-pre', key: 'output' }, model.resultText));
  }

  return React.createElement(WfCardShell, {
    tool: model.key,
    state: settled ? (model.failed === true ? 'error' : 'ok') : 'running',
    kind: wfCardSay(settled ? 'getRun.fetched' : 'getRun.fetching'),
    live: !settled,
    summary: runId,
    summaryMono: runId !== '',
    nameTestId: 'workflow-run-summary-line',
    detail: run === undefined ? '' : wfCardStatusText(status),
    detailTestId: 'workflow-tool-summary',
    status: run === undefined
      ? null
      : React.createElement(WfCardState, { status, testId: 'workflow-run-stop-reason' }),
    actions: run === undefined || runId === '' ? null : React.createElement(WfCardIconButton, {
      icon: React.createElement(WF_UI.icons.external, { size: 13 }),
      label: wfCardSay('workflow.openRunDetails'),
      title: wfCardSay('workflow.openRunDetails'),
      onClick: () => wfCardOpenDetail({ sessionId: model.sessionId, runId, tab: 'run' }),
    }),
    body: body.length === 0 ? undefined : body,
    expandable: props.expandable,
    open: props.open,
    onToggle: props.toggle,
    bodyTestId: 'workflow-status-body',
  });
}

/** The `log` rows of a run snapshot, oldest first, capped. */
function wfCardLogTail(run) {
  const log = wfRunField(run, 'log');
  if (!Array.isArray(log)) return [];
  return log.slice(-40).map((entry) => {
    const text = wfCardRecord(entry) ? wfCardFirstText(entry.text, entry.message) : wfCardTextOf(entry);
    if (text === '') return '';
    const at = wfCardRecord(entry) ? wfCardNum(wfCardFirst(entry.at, entry.at_ms)) : undefined;
    return at === undefined ? text : `${wfCardSay('getRun.age', { age: wfCardAge(Date.now() - at) })}  ${text}`;
  }).filter((line) => line !== '');
}

/* ------------------------------ list cards -------------------------------- */

/** The `- ` rows of a result list. */
function wfCardBulletRows(text, limit) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('- ')) continue;
    const row = line.slice(2).trim();
    if (row === '') continue;
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows;
}

/** Leading count of a result headline (`3 runs`). */
function wfCardLeadingCount(text) {
  const match = /^(\d+)\b/.exec(String(text ?? '').trim().split('\n')[0] ?? '');
  return match === null ? undefined : Number(match[1]);
}

/** The `Run <id> "<name>" — <status>` words of one list row. */
function wfCardRunRowStatus(row) {
  const match = /\b(pending|running|completed|errored|stopped|superseded)\b/.exec(row);
  return match === null ? '' : match[1];
}

/** ListWorkflowRuns card. */
function WfListRunsCard(props) {
  const model = props.model;
  const text = model.resultText;
  const settled = model.phase === 'result';
  const rows = wfCardBulletRows(text, WF_CARD_MAX_ROWS);
  const count = wfCardLeadingCount(text);
  const total = count ?? rows.length;
  const empty = /^No workflow runs\b/m.test(text);
  const sections = [];
  const body = [];
  if (rows.length > 0) {
    body.push(React.createElement('div', { className: 'zwf-rows', key: 'rows', 'data-testid': 'workflow-run-lines' },
      rows.map((row, index) => React.createElement('div', { className: 'zwf-row-item zwf-run-line', key: `row-${index}` },
        React.createElement('span', { className: 'zwf-lamp', 'data-status': wfCardRunRowStatus(row) || 'idle' }),
        React.createElement('span', { className: 'zwf-run-line-text' }, row)))));
  } else if (settled && model.failed === true) {
    sections.push({ key: 'output', text });
  } else if (settled && empty) {
    body.push(React.createElement('p', { className: 'zwf-note', key: 'empty' }, wfCardSay('listRuns.empty')));
  }
  for (const node of wfCardSections(sections)) body.push(node);
  const truncated = settled && !model.failed && rows.length > 0 && (total === undefined || total > rows.length);
  if (truncated) body.push(React.createElement('p', { className: 'zwf-note', key: 'truncated' }, wfCardSay('listRuns.truncated')));

  return React.createElement(WfCardShell, {
    tool: model.key,
    state: model.failed === true ? 'error' : settled ? 'ok' : 'running',
    kind: wfCardSay(settled ? 'listRuns.listed' : 'listRuns.listing'),
    live: !settled,
    summary: settled && total !== undefined ? wfCardSayCount('listRuns.countOne', 'listRuns.count', total) : '',
    status: settled ? (model.failed === true ? React.createElement('span', { className: 'zwf-state', 'data-status': 'errored' }, wfCardSay('status.failed')) : null) : null,
    body: body.length === 0 ? undefined : body,
    expandable: props.expandable,
    open: props.open,
    onToggle: props.toggle,
    bodyTestId: 'workflow-list-runs',
  });
}

/** ListSavedWorkflows card. */
function WfListSavedCard(props) {
  const model = props.model;
  const text = model.resultText;
  const settled = model.phase === 'result';
  const rows = wfCardBulletRows(text, WF_CARD_MAX_ROWS);
  const count = wfCardLeadingCount(text);
  const total = count ?? rows.length;
  const empty = /^No saved workflows\b/m.test(text);
  const invalidMatch = /(\d+) files? could not be read/m.exec(text);
  const body = [];
  if (rows.length > 0) {
    body.push(React.createElement('div', { className: 'zwf-rows', key: 'rows', 'data-testid': 'workflow-list' },
      rows.map((row, index) => React.createElement('div', { className: 'zwf-row-item', key: `row-${index}` }, row))));
  } else if (settled && empty && !model.failed) {
    body.push(React.createElement('p', { className: 'zwf-note', key: 'empty' }, wfCardSay('list.empty')));
  } else if (settled && model.failed) {
    body.push(React.createElement('pre', { className: 'zwf-pre', key: 'output' }, text));
  }
  if (invalidMatch !== null) {
    body.push(React.createElement('p', { className: 'zwf-note', key: 'invalid', 'data-tone': 'warn' },
      wfCardSayCount('list.invalidOne', 'list.invalid', Number(invalidMatch[1]))));
  }
  return React.createElement(WfCardShell, {
    tool: model.key,
    state: model.failed === true ? 'error' : settled ? 'ok' : 'running',
    kind: wfCardSay(settled ? 'list.listed' : 'list.listing'),
    live: !settled,
    summary: settled && total !== undefined ? wfCardSayCount('list.countOne', 'list.count', total) : '',
    status: settled && model.failed === true
      ? React.createElement('span', { className: 'zwf-state', 'data-status': 'errored' }, wfCardSay('status.failed'))
      : null,
    body: body.length === 0 ? undefined : body,
    expandable: props.expandable,
    open: props.open,
    onToggle: props.toggle,
    bodyTestId: 'workflow-list-saved',
  });
}

/* --------------------------------- save card ------------------------------- */

/** The declared-argument table of a saved workflow (`save.args.*`). */
function WfSaveArgTable(props) {
  const args = props.args;
  const names = Object.keys(args ?? {});
  if (names.length === 0) return null;
  return React.createElement('div', { className: 'zwf-rows', 'data-testid': 'workflow-args' },
    React.createElement('div', { className: 'zwf-row-item', 'data-testid': 'workflow-arg-row' }, wfCardSay('save.args.title')),
    names.map((name) => {
      const declaration = wfCardRecord(args[name]) ? args[name] : {};
      const required = declaration.required === true;
      return React.createElement('div', { className: 'zwf-row-item', key: name, 'data-testid': `workflow-arg-${name}` },
        `${name} · ${wfCardFirstText(declaration.type) || 'string'} · ${wfCardSay(required ? 'save.args.requiredYes' : 'save.args.requiredNo')}`,
        declaration.default === undefined ? null : ` · ${wfCardSay('save.args.default')} ${wfCardTextOf(wfCardJsonText(declaration.default))}`);
    }));
}

/** JSON-ish display of a declared default. */
function wfCardJsonText(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** SaveWorkflow card. */
function WfSaveCard(props) {
  const model = props.model;
  const settled = model.phase === 'result';
  const scope = wfCardFirstText(model.args('scope'));
  const name = model.argText('name') ?? '';
  const description = model.argText('description') ?? '';
  const whenToUse = model.argText('when_to_use') ?? model.argText('whenToUse') ?? '';
  const overwrite = model.args('overwrite') === true;
  const savedPath = wfCardFirstText(
    wfCardRecord(model.structured) ? model.structured.path : undefined,
    model.argText('path'),
  );
  const body = [];
  if (description !== '') body.push(React.createElement('p', { className: 'zwf-note', key: 'description' }, description));
  body.push(React.createElement('p', { className: 'zwf-note', key: 'scope' },
    `${wfCardSay('save.scope.label')} · ${wfCardSay(scope === 'global' ? 'save.scope.global' : 'save.scope.project')}`));
  if (overwrite) {
    body.push(React.createElement('p', { className: 'zwf-note', key: 'overwrite', 'data-tone': 'warn' }, wfCardSay('save.overwriteHint')));
  }
  if (savedPath !== '') {
    body.push(React.createElement('p', { className: 'zwf-note', key: 'path' },
      React.createElement('span', { className: 'zwf-section-label' }, wfCardSay('save.path')),
      React.createElement('span', { className: 'zwf-mono-tab', title: savedPath }, ` ${savedPath}`)));
  }
  if (whenToUse !== '') {
    body.push(React.createElement('section', { className: 'zwf-section', key: 'when' },
      React.createElement('span', { className: 'zwf-section-label' }, wfCardSay('save.whenToUse')),
      React.createElement('p', { className: 'zwf-note' }, whenToUse)));
  }
  const args = wfCardRecord(model.args('args')) ? model.args('args') : {};
  const table = WfSaveArgTable({ args });
  if (table !== null) body.push(table);
  if (body.length === 0 && settled) body.push(React.createElement('pre', { className: 'zwf-pre', key: 'output' }, model.resultText));

  return React.createElement(WfCardShell, {
    tool: model.key,
    state: model.failed === true ? 'error' : settled ? 'ok' : 'running',
    kind: wfCardSay(settled && !model.failed ? 'save.saved' : 'save.saving'),
    kindTitle: wfCardSay('save.title'),
    live: !settled,
    summary: name,
    summaryMono: name !== '',
    status: settled && model.failed === true
      ? React.createElement('span', { className: 'zwf-state', 'data-status': 'errored' }, wfCardSay('status.failed'))
      : null,
    detail: scope === '' ? '' : wfCardSay(scope === 'global' ? 'save.scope.global' : 'save.scope.project'),
    actions: React.createElement('span', { className: 'zwf-chips' },
      overwrite
        ? React.createElement('span', { className: 'zwf-chip', 'data-static': 'true', 'data-testid': 'workflow-overwrite-badge', title: wfCardSay('save.overwriteTitle') }, wfCardSay('save.overwrite'))
        : null,
      scope === '' || (scope !== 'project' && scope !== 'global')
        ? null
        : React.createElement('span', { className: 'zwf-chip', 'data-static': 'true', 'data-testid': 'workflow-scope-badge' }, wfCardSay(`save.scope.${scope}`))),
    body: body.length === 0 ? undefined : body,
    expandable: props.expandable,
    open: props.open,
    onToggle: props.toggle,
    headTestId: 'workflow-save-header',
  });
}

/* ------------------------------ stop / resume ------------------------------ */

/** StopWorkflowRun card. */
function WfStopCard(props) {
  const model = props.model;
  const settled = model.phase === 'result';
  const runId = wfCardResultRunId(model) ?? '';
  return React.createElement(WfCardShell, {
    tool: model.key,
    state: model.failed === true ? 'error' : settled ? 'ok' : 'running',
    icon: React.createElement(WF_ICON.stop, { size: 14 }),
    kind: wfCardSay(settled && !model.failed ? 'card.stopped' : 'run.cancel'),
    live: !settled,
    summary: runId,
    summaryMono: runId !== '',
    status: settled && model.failed === true
      ? React.createElement('span', { className: 'zwf-state', 'data-status': 'errored' }, wfCardSay('status.failed'))
      : null,
    body: model.resultText === '' ? undefined : [React.createElement('pre', { className: 'zwf-pre', key: 'output' }, model.resultText)],
    expandable: props.expandable,
    open: props.open,
    onToggle: props.toggle,
  });
}

/** ResumeWorkflowRun card. */
function WfResumeCard(props) {
  const model = props.model;
  const settled = model.phase === 'result';
  const resumed = /^Resumed run\s+\S+\s+as\s+([^\s(]+)/m.exec(model.resultText);
  const previous = model.argText('run_id') ?? '';
  const runId = resumed === null ? previous : resumed[1];
  const body = [React.createElement('p', { className: 'zwf-note', key: 'hint' }, wfCardSay('resumeRun.hint'))];
  if (model.resultText !== '' && model.failed === true) {
    body.push(React.createElement('pre', { className: 'zwf-pre', key: 'output' }, model.resultText));
  }
  return React.createElement(WfCardShell, {
    tool: model.key,
    state: model.failed === true ? 'error' : settled ? 'ok' : 'running',
    icon: React.createElement(WF_ICON.refresh, { size: 14 }),
    kind: wfCardSay(model.failed === true ? 'resumeRun.label' : settled ? 'resumeRun.label' : 'resumeRun.resuming'),
    live: !settled,
    summary: runId,
    summaryMono: runId !== '',
    detail: resumed !== null && previous !== '' ? previous : '',
    status: settled && model.failed === true
      ? React.createElement('span', { className: 'zwf-state', 'data-status': 'errored' }, wfCardSay('status.failed'))
      : React.createElement('span', { className: 'zwf-state', 'data-status': settled ? 'running' : 'pending' }, wfCardSay('resumeRun.inBackground')),
    body,
    expandable: props.expandable,
    open: props.open,
    onToggle: props.toggle,
  });
}

/* -------------------------------- questions -------------------------------- */

/** ResolveWorkflowQuestion card (`Ocn`). */
function WfResolveCard(props) {
  const model = props.model;
  const settled = model.phase === 'result';
  const questionId = model.argText('question_id') ?? model.argText('questionId') ?? '';
  const answer = model.argText('answer') ?? '';
  const sections = [
    questionId === '' ? undefined : { key: 'qid', title: wfCardSay('resolveQuestion.questionId'), node: React.createElement('p', { className: 'zwf-note zwf-mono-tab' }, questionId) },
    answer === '' ? undefined : { key: 'answer', title: wfCardSay('resolveQuestion.answer'), node: React.createElement('p', { className: 'zwf-note' }, answer) },
    settled && model.resultText !== '' ? { key: 'outcome', title: wfCardSay('resolveQuestion.outcome'), node: React.createElement('p', { className: 'zwf-note' }, model.resultText) } : undefined,
  ].filter(Boolean);
  const body = wfCardSections(sections);
  return React.createElement(WfCardShell, {
    tool: model.key,
    state: model.failed === true ? 'error' : settled ? 'ok' : 'running',
    icon: React.createElement(WF_ICON.check, { size: 14 }),
    kind: wfCardSay(settled ? 'resolveQuestion.answered' : 'resolveQuestion.answering'),
    live: !settled,
    summary: questionId,
    summaryMono: questionId !== '',
    status: settled && model.failed === true
      ? React.createElement('span', { className: 'zwf-state', 'data-status': 'errored' }, wfCardSay('status.failed'))
      : null,
    body: body.length === 0 ? undefined : body,
    expandable: props.expandable,
    open: props.open,
    onToggle: props.toggle,
  });
}

/* --------------------------------- default -------------------------------- */

/** Any other workflow tool: kind, run id when the result names one, output and diagnostics. */
function WfDefaultCard(props) {
  const model = props.model;
  const settled = model.phase === 'result';
  const diagnostics = wfCardDiagnostics(model);
  const body = [];
  if (diagnostics.length > 0) body.push(React.createElement(WfCardDiagnostics, { key: 'diagnostics', diagnostics, failed: model.failed }));
  if (model.resultText !== '') body.push(React.createElement('pre', { className: 'zwf-pre', key: 'output' }, model.resultText));
  return React.createElement(WfCardShell, {
    tool: model.key,
    state: model.failed === true ? 'error' : settled ? 'ok' : 'running',
    kind: settled ? wfCardSay('workflow.ran') : wfCardSay('workflow.writing'),
    live: !settled,
    summary: wfCardResultRunId(model) ?? '',
    summaryMono: true,
    status: settled && model.failed === true
      ? React.createElement('span', { className: 'zwf-state', 'data-status': 'errored' }, wfCardSay('status.failed'))
      : null,
    body: body.length === 0 ? undefined : body,
    expandable: props.expandable,
    open: props.open,
    onToggle: props.toggle,
  });
}

/* -------------------------------- registry -------------------------------- */

WF_CARDS.render.GetWorkflowRun = WfGetRunCard;
WF_CARDS.render.TaskOutput = WfGetRunCard;
WF_CARDS.render.ListWorkflowRuns = WfListRunsCard;
WF_CARDS.render.ListSavedWorkflows = WfListSavedCard;
WF_CARDS.render.SaveWorkflow = WfSaveCard;
WF_CARDS.render.StopWorkflowRun = WfStopCard;
WF_CARDS.render.ResumeWorkflowRun = WfResumeCard;
WF_CARDS.render.ResolveWorkflowQuestion = WfResolveCard;
WF_CARDS.render.default = WfDefaultCard;
