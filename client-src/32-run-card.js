/* The session-inline workflow run card (ZCode `lsn`).
 *
 * One card per CreateWorkflow / AmendWorkflow / FillWorkflowHole call. Three mutually exclusive
 * renderings, in this order:
 *
 *   1. a launch waiting for a decision — the run exists with `status: 'pending'`; the body is the
 *      shared confirmation block (`WF_PERMISSION.Block`, owned by 45-permission.js) and nothing
 *      else, because every field it needs comes from the run being approved;
 *   2. a run exists — header (kind, name, status, three-part detail), body (amend/saved source
 *      rows, phase timeline with agent pills, artifact chips, diagnostics) and footer (step,
 *      token, round and artifact tallies plus the resume action);
 *   3. no run yet — the draft states (writing / revising / draft / awaiting confirmation /
 *      validating), where the card keeps the source row, the script disclosure and the output.
 */

/** Status keys of the card header kind, in the order the run card resolves them. */
const WF_RUN_KIND_KEYS = {
  pending: 'card.started',
  running: 'card.running',
  completed: 'card.completed',
  errored: 'card.errored',
  stopped: 'card.stopped',
  superseded: 'card.superseded',
  unknown: 'card.ended',
};

/** How many agent pills one station shows before collapsing the rest into a counter. */
const WF_RUN_PILL_LIMIT = 6;
/** How many artifact chips the card shows. */
const WF_RUN_CHIP_LIMIT = 4;

/** The `已通过校验` static status of a call that compiled but produced no run. */
function WfRunStaticStatus(props) {
  return React.createElement('span', {
    className: 'zwf-state',
    'data-testid': 'workflow-card-static-status',
  }, props.failed === true
    ? React.createElement('span', { className: 'zwf-state-note' }, wfCardSay('run.status.errored'))
    : React.createElement(WF_ICON.check, { size: 12 }),
  props.failed === true ? null : React.createElement('span', null, wfCardSay('workflow.compiled')));
}

/** Kind wording of the card header. */
function wfRunCardKind(model, run, status) {
  if (run !== undefined) {
    if (status === 'superseded') return wfCardSay('card.superseded');
    if (model.key === 'AmendWorkflow') {
      if (status === 'pending' || status === 'running') return wfCardSay(WF_RUN_KIND_KEYS[status]);
      return wfCardSay('amend.ran');
    }
    if (model.key === 'FillWorkflowHole') {
      if (status === 'pending' || status === 'running') return wfCardSay(WF_RUN_KIND_KEYS[status]);
      return wfCardSay('hole.ran');
    }
    return wfCardSay(WF_RUN_KIND_KEYS[status] ?? 'workflow.ran');
  }
  const prefix = model.key === 'AmendWorkflow' ? 'amend' : model.key === 'FillWorkflowHole' ? 'hole' : 'workflow';
  if (model.phase === 'preparing') {
    const ordinal = wfCardNum(model.args('draft_ordinal') ?? model.args('draftOrdinal'));
    return ordinal !== undefined && ordinal >= 2 ? wfCardSay(`${prefix}.revising`) : wfCardSay(`${prefix}.writing`);
  }
  // A call that is already validating has no separate amendment wording; the revision line covers it.
  if (model.phase === 'start') return wfCardSay(prefix === 'workflow' ? 'workflow.running' : `${prefix}.revising`);
  if (model.failed === true) {
    return model.key === 'AmendWorkflow' ? wfCardSay('amend.draft')
      : model.key === 'FillWorkflowHole' ? wfCardSay('hole.draft')
        : wfCardSay('workflow.draft');
  }
  if (model.approval !== undefined && model.approval !== false && model.approval !== null) {
    return model.key === 'AmendWorkflow' ? wfCardSay('amend.awaitingConfirmation')
      : model.key === 'FillWorkflowHole' ? wfCardSay('hole.awaitingConfirmation')
        : wfCardSay('workflow.awaitingConfirmation');
  }
  if (model.key === 'AmendWorkflow') return wfCardSay('amend.draft');
  if (model.key === 'FillWorkflowHole') return wfCardSay('hole.draft');
  return wfCardSay('workflow.draft');
}

/** Card name: the saved name, the workflow name, the hole name, else the fallback wording. */
function wfRunCardName(model) {
  const saved = wfCardRecord(model.args('saved')) ? model.args('saved') : undefined;
  const holeTargetRaw = wfCardFirst(model.args('hole_target'), model.args('holeTarget'));
  const holeTarget = wfCardRecord(holeTargetRaw) ? holeTargetRaw : undefined;
  const candidates = [
    model.argText('name'),
    saved === undefined ? '' : wfCardFirstText(saved.name),
    model.argText('run_name'),
    holeTarget === undefined ? '' : wfCardFirstText(holeTarget.name, holeTarget.holeId, holeTarget.hole_id),
    model.argText('hole_name'),
    model.argText('hole_id'),
  ];
  for (const candidate of candidates) if (candidate !== '') return candidate;
  return wfCardSay('workflow.fallbackName');
}

/** Phase count and waiting-hole count of a run, as the header detail reports them. */
function wfRunPhaseTally(run) {
  const stations = wfRunStations(run);
  const holes = stations.filter((station) => station.hole === 'waiting').length;
  return { phases: stations.length, holes };
}

/**
 * The three-part header detail: `phases · agents · subagent model`.
 * `phases` excludes waiting holes because those read as "not started yet"; running runs report the
 * subagents that are actually working, finished runs report how many there were.
 */
function wfRunCardDetail(model, run) {
  if (run === undefined) {
    const ordinal = wfCardNum(model.args('draft_ordinal') ?? model.args('draftOrdinal'));
    if (ordinal !== undefined) return wfCardSay('workflow.draftOrdinal', { ordinal });
    return '';
  }
  const parts = [];
  const tally = wfRunPhaseTally(run);
  const phases = Math.max(0, tally.phases - tally.holes);
  if (tally.phases > 0) {
    parts.push(wfCardSayCount('card.phase', 'card.phases', phases));
    if (tally.holes > 0) parts.push(wfCardSayCount('card.hole', 'card.holes', tally.holes));
  }
  const agents = wfRunAgents(run);
  if (wfRunIsActive(run)) {
    const working = agents.filter((agent) => agent.status === 'running').length;
    if (working > 0 || agents.length > 0) parts.push(wfCardSayCount('card.agentWorking', 'card.agentsWorking', working));
  } else if (agents.length > 0) {
    parts.push(wfCardSayCount('card.agent', 'card.agents', agents.length));
  }
  const subagentModel = wfRunSubagentModel(run);
  if (subagentModel !== '') parts.push(wfCardSay('run.subagentModel.label', { model: subagentModel }));
  return parts.join(' · ');
}

/** Footer tallies: steps, tokens, rounds, artifacts. */
function wfRunCardParts(run) {
  if (run === undefined) return [];
  const parts = [];
  const steps = wfRunSteps(run);
  if (steps.total > 0) parts.push(wfCardSay('card.steps', { done: steps.done, total: steps.total }));
  parts.push(wfCardSay('card.tokens', { count: (wfRunTokens(run) ?? 0).toLocaleString() }));
  const rounds = wfRunMaxRound(run);
  if (rounds >= 2) parts.push(wfCardSay('card.round', { count: rounds }));
  const artifacts = wfRunArtifacts(run);
  if (artifacts.length > 0) parts.push(wfCardSayCount('card.artifact', 'card.artifacts', artifacts.length));
  return parts;
}

/* ------------------------------- sub-surfaces ------------------------------ */

/** One agent pill of a station; opens the subagent transcript in the run detail. */
function WfRunAgentPill(props) {
  const agent = props.agent;
  const open = props.onOpen !== undefined;
  const name = agent.name === '' ? wfCardSay('graph.lane.anonymous') : agent.name;
  const attrs = {
    className: 'zwf-pill',
    'data-testid': 'workflow-agent-pill',
    'data-agent-status': agent.status ?? 'pending',
    'data-agent-open': open ? 'true' : undefined,
    title: open ? wfCardSay('timeline.openAgent', { name }) : name,
    'aria-label': open ? wfCardSay('timeline.openAgent', { name }) : name,
    onClick: open ? props.onOpen : undefined,
  };
  if (open) attrs.type = 'button';
  return React.createElement(open ? 'button' : 'span', attrs,
    React.createElement('span', { className: 'zwf-pill-avatar' }, React.createElement(WF_ICON.agent, { size: 10 })),
    React.createElement('span', { className: 'zwf-pill-name' }, name),
    agent.status === 'running'
      ? React.createElement('span', { className: 'zwf-pill-tail', 'data-testid': 'workflow-pill-status' }, React.createElement('span', { className: 'zwf-lamp', 'data-status': 'running' }))
      : null);
}

/** The phase timeline: one station per declared phase, each with its subagent pills. */
function WfRunTimeline(props) {
  const stations = props.stations;
  if (!Array.isArray(stations) || stations.length === 0) return null;
  const agents = Array.isArray(props.agents) ? props.agents : [];
  const children = [];
  for (const [index, station] of stations.entries()) {
    const own = agents.filter((agent) => agent.phaseName === station.name);
    const shown = own.slice(0, WF_RUN_PILL_LIMIT);
    const hidden = own.length - shown.length;
    children.push(React.createElement('div', {
      className: 'zwf-station',
      key: `${station.name}-${index}`,
      'data-testid': 'workflow-timeline-station',
      'data-station-status': station.status,
      'data-workflow-phase': station.name,
    },
    React.createElement('div', { className: 'zwf-station-head', 'data-testid': 'workflow-timeline-station-head' },
      React.createElement(WfCardLamp, { status: station.status === 'done' ? 'completed' : station.status === 'failed' ? 'errored' : station.status }),
      React.createElement('span', { className: 'zwf-station-name', title: station.name }, station.name),
      station.rounds !== undefined && station.rounds > 1
        ? React.createElement('span', { className: 'zwf-card-detail', 'data-testid': 'workflow-timeline-rounds' }, wfCardSay('timeline.rounds', { count: station.rounds }))
        : null,
      station.hole === 'waiting'
        ? React.createElement('span', { className: 'zwf-note', 'data-tone': 'warn', 'data-testid': 'workflow-hole-waiting' }, wfCardSay('hole.waiting'))
        : null),
    own.length > 0
      ? React.createElement('div', { className: 'zwf-pills', 'data-testid': 'workflow-timeline-pills' },
        shown.map((agent, pillIndex) => React.createElement(WfRunAgentPill, {
          key: `${agent.name}-${pillIndex}`,
          agent,
          onOpen: props.onOpenActor === undefined ? undefined : () => props.onOpenActor(agent, station),
        })),
        hidden > 0
          ? React.createElement('span', { className: 'zwf-pill', 'data-testid': 'workflow-timeline-pill-open' }, wfCardSay('timeline.roster.more', { count: hidden }))
          : null)
      : null));
  }
  return React.createElement('div', {
    className: 'zwf-timeline',
    'data-testid': 'workflow-timeline',
    role: 'list',
  }, React.createElement('div', { className: 'zwf-timeline-scroller', 'data-testid': 'workflow-timeline-scroller' }, children));
}

/** Artifact chips of a run; the详情 surface owns the preview, the card only opens it. */
function WfRunArtifacts(props) {
  const artifacts = props.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null;
  const shown = artifacts.slice(0, WF_RUN_CHIP_LIMIT);
  const more = artifacts.length - shown.length;
  return React.createElement('div', { className: 'zwf-chips', 'data-testid': 'workflow-card-artifacts' },
    shown.map((artifact, index) => React.createElement('button', {
      type: 'button',
      className: 'zwf-chip',
      key: `${artifact.id}-${index}`,
      'data-testid': 'workflow-card-artifact',
      title: artifact.title,
      onClick: props.onOpen === undefined ? undefined : () => props.onOpen(artifact),
    },
    React.createElement(WF_ICON.artifact, { size: 12 }),
    React.createElement('span', { className: 'zwf-chip-text' }, artifact.title))),
    more > 0
      ? React.createElement('span', { className: 'zwf-chip', 'data-static': 'true', 'data-testid': 'workflow-card-artifacts-more' }, `+${more}`)
      : null);
}

/* --------------------------------- card body ------------------------------- */

/** The `调整自 run` row of an amend card. */
function WfRunAmendRow(props) {
  const runId = props.runId;
  if (runId === '') return null;
  const unchanged = props.scriptUnchanged === true;
  return React.createElement('p', {
    className: 'zwf-note',
    'data-workflow-amends': runId,
  }, `${wfCardSay('run.amends')} ${runId}${unchanged ? ` · ${wfCardSay('amend.scriptUnchanged')}` : ''}`);
}

/** The saved-source row of a card that launches a saved workflow. */
function WfRunSavedRow(props) {
  const saved = props.saved;
  if (saved === undefined) return null;
  const scope = wfCardFirstText(saved.scope);
  const path = wfCardFirstText(saved.path);
  return React.createElement('div', { className: 'zwf-card-foot' },
    React.createElement('span', { className: 'zwf-chip', 'data-static': 'true', 'data-testid': 'workflow-saved-source' },
      React.createElement(WF_ICON.folder, { size: 12 }),
      React.createElement('span', { className: 'zwf-chip-text' }, wfCardFirstText(saved.name) || wfCardSay('workflow.fallbackName'))),
    scope === '' || (scope !== 'project' && scope !== 'global')
      ? null
      : React.createElement('span', { className: 'zwf-card-detail', 'data-testid': 'workflow-scope-badge' }, wfCardSay(`save.scope.${scope}`)),
    path === '' ? null : React.createElement('span', { className: 'zwf-card-detail', title: path, 'data-testid': 'workflow-saved-path' }, path));
}

/** Waiting holes of a run, as the detail pane words them. */
function WfRunHoles(props) {
  const holes = props.holes;
  if (!Array.isArray(holes) || holes.length === 0) return null;
  return React.createElement('div', { className: 'zwf-card-foot' },
    holes.map((hole, index) => React.createElement('span', {
      className: 'zwf-note',
      key: `${wfCardFirstText(hole.id)}-${index}`,
      'data-tone': 'warn',
      'data-testid': 'workflow-run-hole-waiting',
      title: wfCardSay('hole.head.title.untimed', { name: wfCardFirstText(hole.name, hole.id) }),
    },
    React.createElement(WF_ICON.spark, { size: 12 }),
    ` ${wfCardSay('run.hole.waitingFor')}${wfCardFirstText(hole.name) === '' ? '' : ` · ${wfCardFirstText(hole.name)}`}`)));
}

/* -------------------------------- the card -------------------------------- */

/** CreateWorkflow / AmendWorkflow / FillWorkflowHole card. */
function WfRunCard(props) {
  const model = props.model;
  const live = props.live;
  // A launch waiting for a decision may not be this card's result run yet, so it gets its own
  // subscription; the hook is always called, with nothing to watch when no launch is pending.
  const pendingGuess = wfCardPendingRun(model, live);
  const pendingId = pendingGuess === undefined ? undefined : wfRunId(pendingGuess.run);
  const pendingLive = useWfCardRunById(model.sessionId, pendingId);
  const pendingDetail = pendingLive === undefined ? undefined : pendingLive.run;
  const permission = pendingGuess === undefined
    ? undefined
    : { sessionId: pendingGuess.sessionId, run: wfRunId(pendingDetail) === pendingId ? pendingDetail : pendingGuess.run };

  const run = permission !== undefined ? undefined : (live?.run ?? live?.summary);
  const status = run === undefined ? '' : wfRunStatus(run);
  const runId = wfRunId(run) || wfCardResultRunId(model);
  const kind = wfRunCardKind(model, run, status);
  const liveKind = status === 'running' || (run === undefined && model.phase !== 'result');
  const name = wfRunCardName(model);
  const detail = wfRunCardDetail(model, run);
  const stations = run === undefined ? [] : wfRunStations(run);
  const agents = run === undefined ? [] : wfRunAgents(run);
  const artifacts = run === undefined ? [] : wfRunArtifacts(run);
  const holes = run === undefined ? [] : wfRunHoles(run);
  const script = model.argText('script');
  const saved = wfCardRecord(model.args('saved')) ? model.args('saved') : undefined;
  const canResume = run !== undefined && run.resumable === true && status === 'stopped';
  const diagnostics = wfCardDiagnostics(model);

  const statusSlot = run === undefined
    ? React.createElement(WfRunStaticStatus, { failed: model.failed })
    : React.createElement(WfCardState, {
      status,
      stopReason: typeof wfRunField(run, 'stopReason', 'stop_reason') === 'string' ? wfRunField(run, 'stopReason', 'stop_reason') : undefined,
      testId: 'workflow-card-status',
    });

  const actions = [];
  if (runId !== '') {
    actions.push(React.createElement(WfCardIconButton, {
      key: 'details',
      testId: 'workflow-card-open-details',
      icon: React.createElement(WF_UI.icons.external, { size: 13 }),
      label: wfCardSay('workflow.openRunDetails'),
      title: wfCardSay('workflow.openRunDetails'),
      onClick: () => wfCardOpenDetail({ sessionId: model.sessionId, runId, tab: 'run' }),
    }));
  }
  if (props.expandable === true) {
    actions.push(React.createElement(WfCardIconButton, {
      key: 'toggle',
      testId: 'workflow-card-toggle',
      icon: React.createElement(WfCardChevron, { open: props.open }),
      label: wfCardSay(props.open === true ? 'card.collapseDetails' : 'card.expandDetails'),
      title: wfCardSay(props.open === true ? 'card.collapseDetails' : 'card.expandDetails'),
      expanded: props.open === true,
      onClick: props.toggle,
    }));
  }

  const body = [];
  if (permission !== undefined) {
    const surface = wfCardSurface('permission');
    body.push(React.createElement(surface.Block, {
      key: 'permission',
      sessionId: permission.sessionId,
      run: permission.run,
    }));
  } else {
    if (model.key === 'AmendWorkflow') {
      body.push(React.createElement(WfRunAmendRow, {
        key: 'amend',
        runId: wfCardFirstText(model.args('run_id'), model.args('runId')),
        scriptUnchanged: model.args('script_inherited') === true || model.args('scriptInherited') === true,
      }));
      body.push(React.createElement(WfSettingsChangeRow, { key: 'settings', model }));
    }
    if (saved !== undefined) body.push(React.createElement(WfRunSavedRow, { key: 'saved', saved }));
    if (stations.length > 0) {
      body.push(React.createElement(WfRunTimeline, {
        key: 'timeline',
        stations,
        agents,
        onOpenActor: (agent) => {
          wfCardOpenDetail({
            sessionId: model.sessionId,
            runId,
            tab: 'run',
            actor: { ordinal: agent.ordinal, siteId: agent.siteId, sessionId: agent.sessionId, name: agent.name },
          });
        },
      }));
    }
    if (artifacts.length > 0) {
      body.push(React.createElement(WfRunArtifacts, {
        key: 'artifacts',
        artifacts,
        onOpen: (artifact) => wfCardOpenDetail({ sessionId: model.sessionId, runId, tab: 'run', artifactId: artifact.id }),
      }));
    }
    if (holes.length > 0) body.push(React.createElement(WfRunHoles, { key: 'holes', holes }));
    if (wfCardRecord(run) && run.truncated === true) {
      body.push(React.createElement('p', { className: 'zwf-note', key: 'truncated' }, wfCardSay('graph.truncated')));
    }
    if (diagnostics.length > 0) body.push(React.createElement(WfCardDiagnostics, { key: 'diagnostics', diagnostics, failed: model.failed }));
    if (model.failed === true && script !== undefined) {
      body.push(React.createElement(WfCardScriptBlock, { key: 'script-block', script, diagnostics }));
    } else if (script !== undefined && run === undefined && model.phase !== 'preparing') {
      body.push(React.createElement(WfCardScriptDisclosure, { key: 'script', script, diagnostics }));
    } else if (script === undefined && model.resultText === '' && model.phase !== 'result') {
      body.push(React.createElement('p', { className: 'zwf-note', key: 'no-script' }, wfCardSay('workflow.noScript')));
    }
    if (model.resultText !== '' && (model.failed === true || run === undefined)) {
      body.push(React.createElement('pre', { className: 'zwf-pre', key: 'output' }, model.resultText));
    }
  }

  const parts = wfRunCardParts(run);
  const footer = run === undefined && parts.length === 0
    ? null
    : React.createElement('div', { className: 'zwf-card-foot', 'data-testid': 'workflow-card-footer' },
      React.createElement(WfCardState, { status: status === '' ? 'pending' : status }),
      parts.length === 0
        ? null
        : React.createElement(WF_FRAGMENT, null,
          React.createElement(WF_UI.icons.log, { size: 12 }),
          React.createElement('span', { className: 'zwf-card-parts' },
            parts.map((part, index) => React.createElement(WF_FRAGMENT, { key: `part-${index}` },
              index > 0 ? React.createElement('span', { className: 'zwf-card-sep' }, '·') : null,
              React.createElement('span', null, part))))),
      canResume
        ? React.createElement('span', { className: 'zwf-card-trail' },
          React.createElement(WfCardAction, {
            testId: 'workflow-card-resume',
            icon: React.createElement(WF_ICON.refresh, { size: 12 }),
            title: wfCardSay('run.resumeHint'),
            onClick: () => wfCardResume(model.sessionId, runId),
          }, wfCardSay('run.resume')))
        : null);

  const header = React.createElement('div', { className: 'zwf-card-head', 'data-testid': 'workflow-card-header' },
    React.createElement('span', { className: 'zwf-card-glyph' }, React.createElement(WF_UI.icons.workflow, { size: 15 })),
    React.createElement('span', {
      className: 'zwf-card-kind',
      'data-live': liveKind ? 'true' : 'false',
      'data-testid': 'workflow-card-kind',
    }, kind),
    React.createElement('span', { className: 'zwf-card-name', title: name, 'data-testid': 'workflow-card-name' }, name),
    React.createElement('span', { className: 'zwf-card-cluster' },
      statusSlot,
      detail === '' ? null : React.createElement('span', { className: 'zwf-card-detail', title: detail, 'data-testid': 'workflow-card-detail' }, detail),
      actions));

  const children = [header];
  // A launch waiting for a decision must stay visible even when the card's body is collapsed.
  if ((props.open === true || permission !== undefined) && body.length > 0) {
    children.push(React.createElement('div', { className: 'zwf-card-body', key: 'body', 'data-testid': 'workflow-card-body' }, body));
  }
  if (footer !== null) children.push(React.cloneElement(footer, { key: 'footer' }));

  return React.createElement('section', {
    className: 'zwf-card',
    'data-testid': 'workflow-card',
    'data-tool': model.key,
    'data-workflow-card-state': status !== '' ? status : (model.phase === 'preparing' ? 'writing' : 'static'),
    'data-workflow-run-id': runId === '' ? undefined : runId,
    'data-workflow-run-status': status === '' ? undefined : status,
  }, children);
}

/** Resume a stopped run from its card. */
function wfCardResume(sessionId, runId) {
  if (typeof WF_API !== 'object' || WF_API === null || typeof WF_API.resumeRun !== 'function') return;
  wfRunChannelRefresh(sessionId, runId);
  WF_API.resumeRun({ sessionId, runId }).then(() => {
    wfRunChannelRefresh(sessionId, runId);
  }).catch((error) => {
    console.warn('zcode-workflow: resuming the run failed', error);
  });
}

/* --------------------------------- renderers ------------------------------- */

WF_CARDS.render.CreateWorkflow = WfRunCard;
WF_CARDS.render.AmendWorkflow = WfRunCard;
WF_CARDS.render.FillWorkflowHole = WfRunCard;
