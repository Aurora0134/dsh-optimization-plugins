/* The run digest bar under a run card (`$fn`, ui.md F.5).
 *
 * A compact second row for the runs that are still interesting: what the plot looks like, what is
 * waiting on the user (questions, holes), what has been produced (artifacts) and the two actions a
 * run offers from the transcript (resume, stop). Every element is a `workflow-digest-*` test id and
 * every label comes from the `digest.*` / `run.*` copy table, so the bar never invents wording.
 *
 * The bar only renders when it has something to say: a finished run with no artifacts, holes or
 * questions would otherwise add an empty row under every card.
 */

/** How many artifact chips the digest shows before collapsing into a counter. */
const WF_DIGEST_CHIPS = 3;

/** Digest styles: one inline row of small pills plus the plot rail. */
const WF_CARDS_DIGEST_CSS = `
.zwf-digest{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;box-sizing:border-box;min-width:0;padding:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-digest-plot{display:inline-flex;flex:none;align-items:center;gap:3px;min-width:0;padding:0 2px}
.zwf-digest-dot{display:inline-block;flex:none;width:5px;height:5px;border-radius:999px;background:var(--dsw-alias-state-idle-primary)}
.zwf-digest-dot[data-station-status="done"]{background:var(--dsw-alias-state-success-primary)}
.zwf-digest-dot[data-station-status="running"]{background:var(--dsw-alias-state-warn-primary)}
.zwf-digest-dot[data-station-status="failed"]{background:var(--dsw-alias-state-error-primary)}
.zwf-digest-pill{display:inline-flex;box-sizing:border-box;align-items:center;gap:4px;min-width:0;max-width:220px;height:20px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:17px;cursor:pointer}
.zwf-digest-pill:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.zwf-digest-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-digest-pill[data-tone="warn"]{border-color:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-border-l1));color:var(--dsw-alias-state-warn-primary)}
.zwf-digest-pill[data-static="true"]{cursor:default}
.zwf-digest-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
 * The digest bar of one run.
 * @param {{run: object, sessionId?: string, runId?: string, stations?: object[], artifacts?: object[]}} props
 */
function WfRunDigest(props) {
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
  const rows = [];

  if (stations.length > 0) {
    rows.push(React.createElement('span', {
      className: 'zwf-digest-plot',
      key: 'plot',
      'data-testid': 'workflow-digest-plot',
      role: 'img',
      'aria-label': stations.map((station) => station.name).join(' · '),
      title: stations.map((station) => station.name).join(' · '),
    }, stations.slice(0, 24).map((station, index) => React.createElement('span', {
      className: 'zwf-digest-dot',
      key: `${station.name}-${index}`,
      'data-station-status': station.status,
    }))));
  }
  if (questions.length > 0) {
    rows.push(React.createElement(WfDigestPill, {
      key: 'questions',
      testId: 'workflow-digest-questions',
      tone: 'warn',
      title: wfCardSay('digest.questions', { count: questions.length }),
      onClick: openRun,
    }, wfCardSayCount('digest.question', 'digest.questions', questions.length)));
  }
  if (holes.length > 0) {
    rows.push(React.createElement(WfDigestPill, {
      key: 'holes',
      testId: 'workflow-digest-holes',
      tone: 'warn',
      title: wfCardSay('digest.holes', { count: holes.length }),
      onClick: openRun,
    }, wfCardSayCount('digest.hole', 'digest.holes', holes.length)));
  }
  if (artifacts.length > 0) {
    const shown = artifacts.slice(0, WF_DIGEST_CHIPS);
    const more = artifacts.length - shown.length;
    rows.push(React.createElement('span', {
      className: 'zwf-digest-plot',
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
  if (run.truncated === true) {
    rows.push(React.createElement(WfDigestPill, {
      key: 'truncated',
      testId: 'workflow-digest-truncated',
      tone: 'warn',
      title: wfCardSay('graph.truncated'),
    }, wfCardSay('graph.truncated')));
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

  if (rows.length === 0 && actions.length === 0) return null;
  return React.createElement('div', { className: 'zwf-digest' },
    rows,
    actions.length === 0 ? null : React.createElement('span', { className: 'zwf-digest-actions' }, actions));
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
