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
 *
 * Which run a card shows is decided by the tool call, not by its result text: the Session's run
 * catalogue carries the `toolCallId` of the call that launched each run, and the card takes the row
 * that names its own `callId`. A launch still waiting for its answer has no journal yet and is
 * claimed by the confirmation block instead.
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
 * The header detail as parts: `phases · agents · subagent model`, plus the hole a Fill call closed.
 * `phases` excludes waiting holes because those read as "not started yet"; running runs report the
 * subagents that are actually working, finished runs report how many there were. Each part can carry
 * its own official summary anchor, so the collapsed summary of a call keeps the hole name, the
 * phases it added and the subagent tally readable on their own elements.
 * @returns {{key: string, text: string, testId?: string}[]}
 */
function wfRunCardDetailParts(model, run) {
  if (run === undefined) {
    const ordinal = wfCardNum(model.args('draft_ordinal') ?? model.args('draftOrdinal'));
    if (ordinal === undefined) return [];
    return [{ key: 'ordinal', text: wfCardSay('workflow.draftOrdinal', { ordinal }) }];
  }
  const parts = [];
  const tally = wfRunPhaseTally(run);
  const phases = Math.max(0, tally.phases - tally.holes);
  if (model.key === 'FillWorkflowHole') {
    const target = wfCardRecord(model.args('hole_target')) ? model.args('hole_target') : undefined;
    const holeName = wfCardFirstText(
      target === undefined ? '' : target.name,
      model.argText('hole_name'),
      model.argText('hole_id'),
    );
    if (holeName !== '') parts.push({ key: 'hole-name', text: holeName, testId: 'workflow-summary-hole-name' });
    if (tally.phases > 0) {
      parts.push({
        key: 'hole-phases',
        text: wfCardSay('hole.phasesAdded', { count: tally.phases }),
        testId: 'workflow-summary-hole-phases',
      });
    }
  }
  // A Fill summary already reports the phases it added; repeating the run total would say it twice.
  const addedPhases = parts.some((part) => part.key === 'hole-phases');
  if (tally.phases > 0 && addedPhases !== true) {
    parts.push({ key: 'phases', text: wfCardSayCount('card.phase', 'card.phases', phases) });
    if (tally.holes > 0) parts.push({ key: 'holes', text: wfCardSayCount('card.hole', 'card.holes', tally.holes) });
  }
  const agents = wfRunAgents(run);
  if (wfRunIsActive(run)) {
    const working = agents.filter((agent) => agent.status === 'running').length;
    if (working > 0 || agents.length > 0) {
      parts.push({
        key: 'agents',
        text: wfCardSayCount('card.agentWorking', 'card.agentsWorking', working),
        testId: 'workflow-summary-agents',
      });
    }
  } else if (agents.length > 0) {
    parts.push({
      key: 'agents',
      text: wfCardSayCount('card.agent', 'card.agents', agents.length),
      testId: 'workflow-summary-agents',
    });
  }
  const subagentModel = wfRunSubagentModel(run);
  if (subagentModel !== '') parts.push({ key: 'model', text: wfCardSay('run.subagentModel.label', { model: subagentModel }) });
  return parts;
}

/** The same detail as one line, for the header's title attribute. */
function wfRunCardDetail(model, run) {
  return wfRunCardDetailParts(model, run).map((part) => part.text).join(' · ');
}

/** Footer tallies: steps, tokens, rounds, artifacts. */
function wfRunCardParts(run) {
  if (run === undefined) return [];
  const parts = [];
  const steps = wfRunSteps(run);
  if (steps.total > 0) parts.push(wfCardSay('card.steps', { done: steps.done, total: steps.total }));
  parts.push(wfCardSay('card.tokens', { count: (wfRunTokens(run) ?? 0).toLocaleString() }));
  const rounds = wfRunMaxRound(run);
  // A live run reports the round it is on; a finished one reports how many it visited.
  if (rounds >= 2) parts.push(wfCardSay(wfRunIsActive(run) ? 'card.round' : 'card.rounds', { count: rounds }));
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

/* ------------------------------ draft timeline ----------------------------- */

/**
 * Stations of a call that has not produced a run yet.
 * The Host projection may hand a draft its phases; otherwise the call's own `phaseNames` /
 * `phase_streams` argument is the only source, and a draft without declared phases renders none.
 * @returns {{name: string, status: string, current: boolean, rounds?: number}[]}
 */
function wfCardDraftStations(model) {
  const declared = wfCardFirst(
    model.args('draftStations'),
    model.args('draft_stations'),
    model.args('phaseNames'),
    model.args('phase_names'),
    model.args('phase_streams'),
    model.args('phaseStreams'),
  );
  if (!Array.isArray(declared)) return [];
  const names = [];
  for (const entry of declared) {
    const name = typeof entry === 'string' ? entry : wfCardFirstText(wfCardRecord(entry) ? entry.name : '', wfCardRecord(entry) ? entry.id : '');
    if (name !== '' && !names.includes(name)) names.push(name);
  }
  const current = wfCardFirstText(model.args('currentPhase'), model.args('current_phase'));
  return names.map((name) => ({
    name,
    status: name === current ? 'running' : model.phase === 'preparing' ? 'pending' : 'done',
    current: name === current,
  }));
}

/**
 * The draft phase timeline (`workflow-draft-timeline` family).
 * Read-only: it shows the shape the model has written so far, not a live run, so a station is
 * pending, current or done and nothing else.
 */
function WfRunDraftTimeline(props) {
  const stations = Array.isArray(props.stations) ? props.stations : [];
  const ordinal = wfCardNum(props.ordinal);
  return React.createElement('div', {
    className: 'zwf-draft-timeline',
    'data-testid': 'workflow-draft-timeline',
    role: 'list',
  },
  stations.map((station, index) => React.createElement('span', {
    className: 'zwf-draft-station',
    key: `${station.name}-${index}`,
    role: 'listitem',
    title: station.name,
  },
  React.createElement('span', {
    className: 'zwf-lamp',
    'data-status': station.status === 'done' ? 'completed' : station.status,
    'data-testid': 'workflow-draft-lamp',
    'data-draft-station': station.name,
  }),
  React.createElement('span', { className: 'zwf-draft-name' }, station.name))),
  ordinal === undefined
    ? null
    : React.createElement('span', { className: 'zwf-card-detail', 'data-testid': 'workflow-draft-ordinal' }, wfCardSay('workflow.draftOrdinal', { ordinal })),
  React.createElement('span', { className: 'zwf-card-detail', 'data-testid': 'workflow-draft-status' }, props.status));
}

/* ------------------------------- completion ------------------------------- */

/** How many artifacts the completion card folds into its index before counting the rest. */
const WF_COMPLETION_LINES = 5;

/**
 * The completion card of a finished run (ui.md N-1).
 *
 * It answers "what did this run produce": a header that opens the run, one row for the newest
 * artifact inside a preview frame, an index of the next few as one line each, and the four
 * figures. The card carries the official `-<kind>-<toolCallId>` suffix so a transcript with several
 * completions can address each one.
 */
function WfRunCompletion(props) {
  const run = props.run;
  const model = props.model;
  const steps = wfRunSteps(run);
  const agents = wfRunAgents(run);
  const phases = wfRunStations(run);
  const artifacts = wfRunArtifacts(run);
  const elapsed = wfRunElapsed(run);
  const runId = props.runId === undefined ? wfRunId(run) : props.runId;
  const name = props.name === undefined ? wfRunName(run) : props.name;
  const figures = [
    elapsed === '' ? undefined : { key: 'time', label: wfCardSay('completion.time'), value: elapsed },
    { key: 'tokens', label: wfCardSay('completion.tokens'), value: (wfRunTokens(run) ?? 0).toLocaleString() },
    { key: 'subagents', label: wfCardSay('completion.subagents'), value: String(agents.length) },
    { key: 'phases', label: wfCardSay('completion.phases'), value: String(phases.length) },
  ].filter(Boolean);
  if (figures.length === 0 && artifacts.length === 0 && steps.total === 0) return null;
  const openArtifact = (artifact) => wfCardOpenDetail({
    sessionId: model.sessionId,
    runId,
    tab: 'run',
    ...(artifact === undefined ? {} : { artifactId: artifact.id }),
  });
  const primary = artifacts[0];
  const folded = artifacts.slice(1, 1 + WF_COMPLETION_LINES);
  const more = artifacts.length - 1 - folded.length;
  const testKey = wfDigestTestIdKey(props.kind ?? model.key, model.toolId);
  return React.createElement('section', {
    className: 'zwf-completion',
    'data-testid': `workflow-completion-card-${testKey}`,
    'data-workflow-completion-card': 'true',
    'aria-label': wfCardSay('card.completed'),
  },
  React.createElement('div', { className: 'zwf-completion-head', 'data-workflow-completion-header': 'true' },
    React.createElement('span', { className: 'zwf-card-kind', 'data-testid': 'workflow-completion-status' }, wfCardSay('card.completed')),
    name === ''
      ? null
      : React.createElement('span', { className: 'zwf-card-name', title: name }, name),
    runId === ''
      ? null
      : React.createElement(WfCardIconButton, {
        testId: 'workflow-card-open-details',
        icon: React.createElement(WF_UI.icons.external, { size: 13 }),
        label: wfCardSay('workflow.openRunDetails'),
        title: wfCardSay('workflow.openRunDetails'),
        onClick: () => openArtifact(undefined),
      })),
  primary === undefined
    ? null
    : React.createElement('div', {
      className: 'zwf-completion-row',
      'data-testid': 'workflow-completion-row',
      'data-artifact-id': primary.id,
      'data-artifact-kind': primary.kind,
    },
    React.createElement('span', {
      className: 'zwf-completion-frame',
      'data-testid': 'workflow-artifact-tile-frame',
      'aria-hidden': 'true',
    }, React.createElement(WF_UI.artifactIcon(primary.kind), { size: 15 })),
    React.createElement('button', {
      type: 'button',
      className: 'zwf-completion-hit',
      'data-testid': 'workflow-artifact-tile-open',
      title: wfArtifactTitle(primary),
      onClick: () => openArtifact(primary),
    },
    React.createElement(WF_UI.artifactIcon(primary.kind), { size: 13 }),
    React.createElement('span', { className: 'zwf-completion-hit-text' }, wfArtifactTitle(primary)),
    React.createElement(WfArtifactVersionMark, { artifact: primary, version: primary.version }))),
  folded.length === 0 && more <= 0
    ? null
    : React.createElement('div', { className: 'zwf-completion-index', 'data-testid': 'workflow-completion-index' },
      folded.map((artifact) => React.createElement('button', {
        type: 'button',
        className: 'zwf-completion-line',
        key: artifact.id,
        'data-testid': 'workflow-completion-line',
        'data-artifact-id': artifact.id,
        title: wfArtifactTitle(artifact),
        onClick: () => openArtifact(artifact),
      },
      React.createElement('span', { className: 'zwf-completion-line-text' }, wfArtifactTitle(artifact)),
      React.createElement(WfArtifactVersionMark, { artifact, version: artifact.version }))),
      more > 0
        ? React.createElement('span', { className: 'zwf-card-detail', 'data-testid': 'workflow-completion-more' }, wfCardSay('completion.moreArtifacts', { count: more }))
        : null),
  React.createElement('div', { className: 'zwf-completion-figures', 'data-testid': 'workflow-completion-figures' },
    figures.map((figure) => React.createElement('span', {
      className: 'zwf-completion-figure',
      key: figure.key,
      'data-testid': `workflow-completion-figure-${figure.key}`,
      'data-value': figure.value,
    },
    React.createElement('span', { className: 'zwf-card-detail' }, figure.label),
    React.createElement('span', { className: 'zwf-completion-value' }, figure.value)))));
}

/* ---------------------------- pending questions --------------------------- */

/**
 * Questions the run is waiting on inside the transcript (ui.md F.1).
 * The card shows who asked, what was asked, the context and how long it has waited; answering
 * happens in the run detail, which owns the answer form.
 */
function WfRunQuestions(props) {
  const questions = Array.isArray(props.questions) ? props.questions : [];
  if (questions.length === 0) return null;
  return React.createElement('div', { className: 'zwf-questions' },
    React.createElement('span', { className: 'zwf-section-label' }, wfCardSay('run.questions.title')),
    questions.map((question, index) => React.createElement('div', {
      className: 'zwf-question',
      key: question.qid === '' ? `question-${index}` : question.qid,
      'data-qid': question.qid === '' ? undefined : question.qid,
      'data-testid': 'workflow-run-question',
    },
    React.createElement(WF_ICON.agent, { size: 12 }),
    React.createElement('span', { className: 'zwf-question-body' },
      question.actorName === '' ? null : React.createElement('span', { className: 'zwf-question-asker' }, question.actorName),
      React.createElement('span', { className: 'zwf-question-text' }, question.question),
      question.context === ''
        ? null
        : React.createElement('span', { className: 'zwf-question-context', 'data-testid': 'workflow-run-question-context' }, question.context)),
    React.createElement('span', { className: 'zwf-question-tail' },
      question.askedAt === undefined
        ? null
        : React.createElement('span', { 'data-testid': 'workflow-run-question-waited' }, wfCardSay('getRun.subagent.waitedFor', { age: wfCardAge(Date.now() - question.askedAt) })),
      question.qid === '' ? null : React.createElement('span', { className: 'zwf-question-qid' }, question.qid)))));
}

/* -------------------------------- the card -------------------------------- */

/* ---------------------------------- styles --------------------------------- */

/** Draft timeline, completion figures and the pending-question block. */
const WF_CARDS_RUN_CSS = `
.zwf-card-state{display:none}
.zwf-draft-timeline{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;box-sizing:border-box;min-width:0;font-size:12px;line-height:18px}
.zwf-draft-station{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:180px}
.zwf-draft-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.zwf-completion{display:flex;flex-direction:column;gap:4px;box-sizing:border-box;min-width:0;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px}
.zwf-completion-head{display:flex;align-items:center;gap:8px;min-width:0}
.zwf-completion-head .zwf-card-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-completion-row{display:flex;align-items:center;gap:8px;min-width:0}
.zwf-completion-frame{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:22px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary)}
.zwf-completion-hit{display:inline-flex;flex:1;align-items:center;gap:6px;min-width:0;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left}
.zwf-completion-hit-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-completion-index{display:flex;flex-direction:column;gap:2px;min-width:0;padding-left:36px}
.zwf-completion-line{display:flex;align-items:center;gap:6px;min-width:0;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:17px;cursor:pointer;text-align:left}
.zwf-completion-line-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-completion-hit:hover,.zwf-completion-line:hover{color:var(--dsw-alias-label-primary)}
.zwf-completion-figures{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px;min-width:0;margin-top:2px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1)}
.zwf-completion-figure{display:inline-flex;align-items:baseline;gap:4px;min-width:0}
.zwf-completion-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.zwf-questions{display:flex;flex-direction:column;gap:4px;min-width:0}
.zwf-question{display:flex;align-items:flex-start;gap:8px;box-sizing:border-box;min-width:0;padding:6px 8px;border-radius:var(--dsw-radius-sm,8px);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:19px}
.zwf-question-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.zwf-question-asker{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.zwf-question-text{white-space:pre-wrap;overflow-wrap:anywhere}
.zwf-question-context{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.zwf-question-tail{display:flex;flex:none;align-items:baseline;gap:6px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}
.zwf-question-qid{opacity:.7}
`;

WF_STYLE_PARTS.push(WF_CARDS_RUN_CSS);

/* ---------------------------------- glyph --------------------------------- */

/**
 * The run row this card owns.
 *
 * ZCode pairs a transcript card with its run through the tool call that launched it: the Session's
 * run catalogue is reduced to a `toolCallId → run` map and the card reads its own entry. A launch
 * still waiting for its answer is not a run yet — the confirmation block owns that row — so only
 * rows that already have a journal are returned here.
 *
 * @param {object} model card model
 * @param {object | undefined} live the Session-level snapshot (its `runs` listing)
 * @returns {object | undefined}
 */
function wfRunCardOwnRow(model, live) {
  if (model === undefined || model.toolId === undefined) return undefined;
  const runs = Array.isArray(live?.runs) ? live.runs : [];
  for (const row of runs) {
    if (wfRunStatus(row) === 'pending') continue;
    if (wfRunToolCallId(row) === model.toolId) return row;
  }
  return undefined;
}

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

  // The run this call launched, claimed by tool call the way the product pairs the two, and read
  // from its own subscription so the card keeps updating after the result text scrolls away.
  const ownedRow = wfRunCardOwnRow(model, live);
  const ownedId = ownedRow === undefined ? undefined : wfRunId(ownedRow);
  const ownedLive = useWfCardRunById(model.sessionId, ownedId);
  const ownedRun = wfRunId(ownedLive === undefined ? undefined : ownedLive.run) === ownedId && ownedId !== undefined
    ? ownedLive.run
    : ownedRow;

  const run = permission !== undefined ? undefined : (ownedRun ?? live?.run ?? live?.summary);
  const status = run === undefined ? '' : wfRunStatus(run);
  const runId = wfRunId(run) || wfCardResultRunId(model);
  const kind = wfRunCardKind(model, run, status);
  const liveKind = status === 'running' || (run === undefined && model.phase !== 'result');
  const name = wfRunCardName(model);
  const detailParts = wfRunCardDetailParts(model, run);
  const detail = detailParts.map((part) => part.text).join(' · ');
  const stations = run === undefined ? [] : wfRunStations(run);
  const agents = run === undefined ? [] : wfRunAgents(run);
  const artifacts = run === undefined ? [] : wfRunArtifacts(run);
  const holes = run === undefined ? [] : wfRunHoles(run);
  const questions = run === undefined ? [] : wfRunQuestions(run);
  const draftStations = run === undefined ? wfCardDraftStations(model) : [];
  const draftOrdinal = wfCardNum(model.args('draft_ordinal') ?? model.args('draftOrdinal'));
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
    if (questions.length > 0) body.push(React.createElement(WfRunQuestions, { key: 'questions', questions }));
    if (run !== undefined && status === 'completed') {
      body.push(React.createElement(WfRunCompletion, {
        key: 'completion',
        run,
        model,
        kind: model.key,
        name,
        runId,
      }));
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
      detail === ''
        ? null
        : React.createElement('span', { className: 'zwf-card-detail', title: detail, 'data-testid': 'workflow-card-detail' },
          detailParts.map((part, index) => React.createElement(WF_FRAGMENT, { key: part.key },
            index > 0 ? React.createElement('span', { className: 'zwf-card-sep' }, '·') : null,
            React.createElement('span', { 'data-testid': part.testId }, part.text)))),
      actions));

  const children = [header];
  // A call that has not produced a run yet shows the shape it has written so far.
  if (run === undefined && permission === undefined && (draftStations.length > 0 || draftOrdinal !== undefined)) {
    children.push(React.createElement(WfRunDraftTimeline, {
      key: 'draft',
      stations: draftStations,
      ordinal: draftOrdinal,
      status: kind,
    }));
  }
  // A launch waiting for a decision must stay visible even when the card's body is collapsed.
  if ((props.open === true || permission !== undefined) && body.length > 0) {
    children.push(React.createElement('div', { className: 'zwf-card-body', key: 'body', 'data-testid': 'workflow-card-body' }, body));
  }
  // The digest sits under the fold: it summarises the run without opening the details.
  if (run !== undefined && permission === undefined) {
    children.push(React.createElement(WfRunDigest, {
      key: 'digest',
      run,
      sessionId: model.sessionId,
      runId,
      stations,
      artifacts,
      kind: model.key,
      kindWord: kind,
      toolId: model.toolId,
    }));
  }
  children.push(React.createElement('span', {
    key: 'state',
    className: 'zwf-card-state',
    'data-testid': 'workflow-card-state',
    'data-workflow-card-state': status !== '' ? status : (model.phase === 'preparing' ? 'writing' : 'static'),
    'aria-hidden': 'true',
  }));
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
