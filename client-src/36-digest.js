/* The run digest bar under a run card (`$fn`, ui.md F.5).
 *
 * The digest repeats the run as one collapsible section: a header (status word, what is waiting on
 * the user, the two actions a run offers from the transcript) over a body that carries the plot as
 * a mini phase timeline, the artifacts the run produced and the truncation notice. Every element is
 * a `workflow-digest-*` test id and every label comes from the `digest.*` / `run.*` copy table, so
 * the bar never invents wording.
 *
 * The bar only renders when it has something to say: a finished run with no artifacts, holes or
 * questions would otherwise add an empty row under every card.
 */

/** How many artifact chips the digest shows before collapsing into a counter. */
const WF_DIGEST_CHIPS = 3;
/** How many stations the plot draws before it says the graph was cut. */
const WF_DIGEST_STATIONS = 24;

/**
 * Test-id key of one card: the tool kind, then the tool-call id when the payload carries one.
 * @param {string} [kind]
 * @param {string} [toolId]
 * @returns {string}
 */
function wfDigestTestIdKey(kind, toolId) {
  const name = typeof kind === 'string' ? kind.trim() : '';
  const id = typeof toolId === 'string' ? toolId.trim() : '';
  if (name === '') return id;
  return id === '' ? name : `${name}-${id}`;
}

/** Digest styles: the collapsible section, its header row and the plot rail. */
const WF_CARDS_DIGEST_CSS = `
.zwf-digest{display:flex;flex-direction:column;gap:4px;box-sizing:border-box;min-width:0;padding:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border:0;background:transparent;text-align:left}
.zwf-digest[role="button"]{cursor:pointer}
.zwf-digest[role="button"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:var(--dsw-radius-sm,8px)}
.zwf-digest-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0}
.zwf-digest-caret{display:inline-flex;flex:none;align-items:center;color:var(--dsw-alias-label-secondary);transition:transform .12s}
.zwf-digest-caret[data-expanded="true"]{transform:rotate(0deg)}
.zwf-digest-caret[data-expanded="false"]{transform:rotate(-90deg)}
.zwf-digest-kind{flex:none;font-weight:500;color:var(--dsw-alias-label-primary)}
.zwf-digest-plot-wrap{display:flex;flex-direction:column;gap:2px;min-width:0}
.zwf-digest-plot{display:flex;align-items:flex-start;gap:0;max-height:44px;overflow:hidden;padding:2px 0}
.zwf-digest-station{display:inline-flex;flex:none;align-items:center;gap:4px;max-width:180px;height:22px;padding:0 8px}
.zwf-digest-station + .zwf-digest-station{position:relative}
.zwf-digest-station + .zwf-digest-station::before{content:"";position:absolute;left:0;top:50%;width:8px;height:1px;transform:translate(-4px,-50%);background:color-mix(in oklab,var(--dsw-alias-label-primary) 24%,transparent)}
.zwf-digest-station[data-station-status="running"]::before{background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 70%,transparent)}
.zwf-digest-station-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.zwf-digest-station[data-station-status="running"] .zwf-digest-station-name{color:var(--dsw-alias-label-primary)}
.zwf-digest-station-count{flex:none;font-size:10.5px;line-height:16px;opacity:.75;font-variant-numeric:tabular-nums}
.zwf-digest-pill{display:inline-flex;box-sizing:border-box;align-items:center;gap:4px;min-width:0;max-width:220px;height:20px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:17px;cursor:pointer}
.zwf-digest-pill:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.zwf-digest-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-digest-pill[data-tone="warn"]{border-color:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-border-l1));color:var(--dsw-alias-state-warn-primary)}
.zwf-digest-pill[data-static="true"]{cursor:default}
.zwf-digest-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-digest-artifacts{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0}
.zwf-digest-truncated{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-digest-actions{display:inline-flex;flex:none;align-items:center;gap:4px;margin-left:auto}
`;

WF_STYLE_PARTS.push(WF_CARDS_DIGEST_CSS);

/* ---------------------------------- render --------------------------------- */

/** One digest pill; a button when it does something, a plain span otherwise. */
function WfDigestPill(props) {
  const attrs = {
    className: 'zwf-digest-pill',
    'data-testid': props.testId,
    'data-tone': props.tone,
    'data-static': props.onClick === undefined ? 'true' : undefined,
    title: props.title,
  };
  if (props.onClick !== undefined) {
    attrs.type = 'button';
    attrs.onClick = props.onClick;
  }
  return React.createElement(props.onClick === undefined ? 'span' : 'button', attrs,
    props.icon === undefined ? null : props.icon,
    React.createElement('span', { className: 'zwf-digest-text' }, props.children));
}

/**
 * The mini phase timeline of one run: one chip per station, in phase order, joined by a rail.
 * The plot is a summary, not the live timeline: it keeps the lamp, the name and how many steps the
 * station has settled, and nothing that would need a click target of its own.
 */
function WfDigestPlot(props) {
  const stations = Array.isArray(props.stations) ? props.stations : [];
  const counts = props.counts instanceof Map ? props.counts : undefined;
  if (stations.length === 0) return null;
  const shown = stations.slice(0, WF_DIGEST_STATIONS);
  const omitted = stations.length - shown.length;
  return React.createElement('div', { className: 'zwf-digest-plot-wrap' },
    React.createElement('div', {
      className: 'zwf-digest-plot',
      'data-testid': 'workflow-digest-plot',
      role: 'list',
      title: stations.map((station) => station.name).join(' · '),
    }, shown.map((station, index) => {
      const count = counts === undefined ? undefined : counts.get(station.name);
      return React.createElement('span', {
        className: 'zwf-digest-station',
        key: `${station.name}-${index}`,
        role: 'listitem',
        'data-station-status': station.status,
        'data-workflow-phase': station.name,
        title: station.name,
      },
      React.createElement('span', { className: 'zwf-lamp', 'data-status': station.status === 'done' ? 'completed' : station.status, 'aria-hidden': 'true' }),
      React.createElement('span', { className: 'zwf-digest-station-name' }, station.name),
      count === undefined || count.total === 0
        ? null
        : React.createElement('span', { className: 'zwf-digest-station-count' }, `${count.settled}/${count.total}`),
      station.rounds !== undefined && station.rounds > 1
        ? React.createElement('span', { className: 'zwf-digest-station-count' }, `×${station.rounds}`)
        : null);
    })),
  omitted <= 0
    ? null
    : React.createElement('p', { className: 'zwf-digest-truncated', key: 'graph-truncated' }, wfCardSay('graph.truncated')));
}

/**
 * The digest section of one run.
 * @param {{run: object, sessionId?: string, runId?: string, stations?: object[], artifacts?: object[],
 *   kind?: string, kindWord?: string, toolId?: string}} props
 */
function WfRunDigest(props) {
  // Declared before the guard: a card can go from "no run yet" to "run" on the next push.
  const [expanded, setExpanded] = React.useState(true);
  const run = props.run;
  if (!wfCardRecord(run)) return null;
  const runId = wfCardFirstText(props.runId, wfRunId(run));
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined;
  const stations = Array.isArray(props.stations) ? props.stations : wfRunStations(run);
  const artifacts = Array.isArray(props.artifacts) ? props.artifacts : wfRunArtifacts(run);
  const questions = wfRunQuestions(run);
  const holes = wfRunHoles(run).filter((hole) => hole.state !== 'filled');
  const status = wfRunStatus(run);
  const resumable = run.resumable === true && status === 'stopped';
  const stoppable = status === 'running' || status === 'pending';
  const open = (extra) => {
    if (runId === '') return undefined;
    return () => wfCardOpenDetail({ sessionId, runId, tab: 'run', ...(extra ?? {}) });
  };
  const openRun = open();
  // Clicks on a pill belong to the pill; only the section itself folds.
  const foldable = (event) => {
    const target = event?.target;
    const inner = target !== null && typeof target?.closest === 'function'
      ? target.closest('button, a, input, textarea, select')
      : null;
    return inner === null || inner === event.currentTarget;
  };
  const toggle = (event) => {
    if (!foldable(event)) return;
    setExpanded((value) => value !== true);
  };
  const onKeyDown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!foldable(event)) return;
    event.preventDefault();
    setExpanded((value) => value !== true);
  };

  const leading = [];
  if (questions.length > 0) {
    leading.push(React.createElement(WfDigestPill, {
      key: 'questions',
      testId: 'workflow-digest-questions',
      tone: 'warn',
      title: wfCardSay('digest.questions', { count: questions.length }),
      onClick: openRun,
    }, wfCardSayCount('digest.question', 'digest.questions', questions.length)));
  }
  if (holes.length > 0) {
    leading.push(React.createElement(WfDigestPill, {
      key: 'holes',
      testId: 'workflow-digest-holes',
      tone: 'warn',
      title: wfCardSay('digest.holes', { count: holes.length }),
      onClick: openRun,
    }, wfCardSayCount('digest.hole', 'digest.holes', holes.length)));
  }

  const actions = [];
  if (runId !== '') {
    actions.push(React.createElement(WfDigestPill, {
      key: 'configure',
      testId: 'workflow-digest-configure',
      title: wfCardSay('run.configure'),
      icon: React.createElement(WF_ICON.more, { size: 11 }),
      onClick: openRun,
    }, wfCardSay('run.configure')));
  }
  if (resumable && runId !== '') {
    actions.push(React.createElement(WfDigestPill, {
      key: 'resume',
      testId: 'workflow-digest-resume',
      title: wfCardSay('run.resumeHint'),
      icon: React.createElement(WF_ICON.refresh, { size: 11 }),
      onClick: () => wfDigestResume(sessionId, runId),
    }, wfCardSay('run.resume')));
  }
  if (stoppable && runId !== '') {
    actions.push(React.createElement(WfDigestPill, {
      key: 'cancel',
      testId: 'workflow-digest-cancel',
      title: wfCardSay('run.stopHint'),
      icon: React.createElement(WF_ICON.stop, { size: 11 }),
      onClick: () => wfDigestStop(sessionId, runId),
    }, wfCardSay('run.cancel')));
  }

  const truncation = wfDigestTruncation(run);

  const body = [];
  if (stations.length > 0) {
    body.push(React.createElement(WfDigestPlot, {
      key: 'plot',
      stations,
      counts: wfDigestStationCounts(run, stations),
    }));
  }
  if (artifacts.length > 0) {
    const shown = artifacts.slice(0, WF_DIGEST_CHIPS);
    const more = artifacts.length - shown.length;
    body.push(React.createElement('span', {
      className: 'zwf-digest-artifacts',
      key: 'artifacts',
      'data-testid': 'workflow-digest-artifacts',
    },
    shown.map((artifact, index) => React.createElement('button', {
      type: 'button',
      className: 'zwf-digest-pill',
      key: `${artifact.id}-${index}`,
      'data-testid': 'workflow-digest-artifact',
      title: artifact.title,
      onClick: open({ artifactId: artifact.id }),
    },
    React.createElement(WF_ICON.artifact, { size: 11 }),
    React.createElement('span', { className: 'zwf-digest-text' }, artifact.title))),
    more > 0
      ? React.createElement(WfDigestPill, {
        key: 'more',
        testId: 'workflow-digest-artifacts-more',
        title: wfCardSay('digest.artifactsMore', { count: more }),
      }, wfCardSay('digest.artifactsMore', { count: more }))
      : null));
  }
  if (truncation !== undefined) {
    body.push(React.createElement('p', {
      className: 'zwf-digest-truncated',
      key: 'truncated',
      'data-testid': 'workflow-digest-truncated',
    }, wfCardSay('run.truncated', { shown: truncation.shown, total: truncation.total })));
  }

  if (leading.length === 0 && actions.length === 0 && body.length === 0) return null;

  const identity = wfDigestTestIdKey(props.kind, props.toolId);
  const testId = identity === '' ? 'workflow-run-digest' : `workflow-run-digest-${identity}`;
  return React.createElement('section', {
    className: 'zwf-digest',
    'data-testid': testId,
    'data-workflow-run-digest': 'true',
    'data-workflow-run-id': runId === '' ? undefined : runId,
    'data-workflow-run-status': status === '' ? 'absent' : status,
    'data-expanded': String(expanded === true),
    role: 'button',
    tabIndex: 0,
    'aria-expanded': expanded === true,
    'aria-label': typeof props.kindWord === 'string' && props.kindWord !== '' ? props.kindWord : undefined,
    onClick: toggle,
    onKeyDown,
  },
  React.createElement('div', { className: 'zwf-digest-head', 'data-workflow-digest-header': 'true' },
    React.createElement('span', {
      className: 'zwf-digest-caret',
      'data-expanded': String(expanded === true),
      'aria-hidden': 'true',
    }, React.createElement(WF_ICON.chevronDown, { size: 12 })),
    typeof props.kindWord === 'string' && props.kindWord !== ''
      ? React.createElement('span', { className: 'zwf-digest-kind' }, props.kindWord)
      : null,
    leading,
    actions.length === 0 ? null : React.createElement('span', { className: 'zwf-digest-actions' }, actions)),
  expanded === true && body.length > 0
    ? React.createElement('div', { className: 'zwf-digest-body', key: 'body' }, body)
    : null);
}

/**
 * How many steps the run still holds against how many it ran.
 * The digest only reports this when the snapshot was cut short (`truncated`) and something is
 * actually missing, so a complete run never carries the note.
 * @returns {{shown: number, total: number} | undefined}
 */
function wfDigestTruncation(run) {
  if (run.truncated !== true) return undefined;
  const nodes = wfRunField(run, 'nodes');
  const shown = Array.isArray(nodes) ? nodes.length : 0;
  const steps = wfRunField(run, 'steps');
  const total = wfCardRecord(steps) ? (wfCardNum(steps.started) ?? shown) : shown;
  if (shown >= total) return undefined;
  return { shown, total };
}

/**
 * Settled and observed step counts per station, as the detail timeline reports them.
 * @param {object} run
 * @param {object[]} stations
 * @returns {Map<string, {settled: number, total: number}>}
 */
function wfDigestStationCounts(run, stations) {
  const counts = new Map();
  const nodes = wfObjects(run?.nodes);
  for (const station of stations) {
    const own = nodes.filter((node) => wfPhaseMatches(station.name, wfText(node.phaseName)));
    counts.set(station.name, {
      settled: own.filter((node) => node.phase === 'settled').length,
      total: own.length,
    });
  }
  return counts;
}

/** Stop one run from its digest; the channel refreshes whether or not the command is accepted. */
function wfDigestStop(sessionId, runId) {
  if (typeof WF_API !== 'object' || WF_API === null || typeof WF_API.stopRun !== 'function') return;
  WF_API.stopRun({ sessionId, runId }).catch((error) => {
    console.warn('zcode-workflow: stopping the run failed', error);
  }).finally(() => wfRunChannelRefresh(sessionId, runId));
}

/** Resume one stopped run from its digest. */
function wfDigestResume(sessionId, runId) {
  if (typeof WF_API !== 'object' || WF_API === null || typeof WF_API.resumeRun !== 'function') return;
  WF_API.resumeRun({ sessionId, runId }).catch((error) => {
    console.warn('zcode-workflow: resuming the run failed', error);
  }).finally(() => wfRunChannelRefresh(sessionId, runId));
}
