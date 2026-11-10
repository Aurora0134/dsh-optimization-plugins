/*
 * The vertical phase list of the run-detail pane: one folding row per station, the spine that
 * joins them, the fill heading a hole leaves behind, the roster behind each row, the pending
 * questions and the states that replace the list entirely (no graph, orphan questions).
 */

/** One pending question, with the answer control the resolve route backs. */
function WfQuestionBlock(props) {
  const question = props.question;
  const [answering, setAnswering] = React.useState(false);
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(undefined);
  const asker = question.actorName
    ?? (question.actorSiteId === undefined ? undefined : `${question.actorSiteId}@${question.actorOrdinal ?? 0}`);
  const submit = async () => {
    if (busy || value.trim() === '' || typeof props.scope?.runId !== 'string') return;
    setBusy(true);
    setError(undefined);
    try {
      await WF_API.answerQuestion({
        sessionId: props.scope.sessionId,
        runId: props.scope.runId,
        qid: question.qid,
        answer: value,
      });
      setAnswering(false);
      setValue('');
      props.onRefresh?.();
    } catch (failure) {
      setError(wfText(failure?.message) ?? wfText(failure?.code));
    } finally {
      setBusy(false);
    }
  };
  return WF_H('div', {
    className: 'zwf-question',
    'data-testid': 'workflow-run-question',
    'data-qid': question.qid,
  },
  WF_H('span', { className: 'zwf-question-glyph' }, WF_H(WF_UI.icons.alert, { size: 13 })),
  WF_H('div', { className: 'zwf-question-main' },
    props.showAsker === true && asker !== undefined
      ? WF_H('span', { className: 'zwf-question-asker zwf-mono' }, asker)
      : null,
    WF_H('span', { className: 'zwf-question-text' }, question.question),
    question.context === undefined
      ? null
      : WF_H('p', { className: 'zwf-question-context', 'data-testid': 'workflow-run-question-context' }, question.context),
    answering
      ? WF_H('div', { className: 'zwf-question-form' },
        WF_H(WF_UI.Textarea, {
          rows: 3,
          value,
          placeholder: WF_UI.say(props.t, UI_EN, 'run.questions.answer.placeholder'),
          onChange: setValue,
        }),
        WF_H('div', { className: 'zwf-question-form-actions' },
          WF_H('button', {
            type: 'button',
            className: 'zwf-btn zwf-btn-primary zwf-btn-sm',
            disabled: busy || value.trim() === '',
            onClick: () => { void submit(); },
          }, WF_H('span', { className: 'zwf-btn-label' }, WF_UI.say(props.t, UI_EN, 'run.questions.answer.submit'))),
          WF_H('button', {
            type: 'button',
            className: 'zwf-btn zwf-btn-ghost zwf-btn-sm',
            disabled: busy,
            onClick: () => {
              setAnswering(false);
              setError(undefined);
            },
          }, WF_H('span', { className: 'zwf-btn-label' }, WF_UI.say(props.t, UI_EN, 'ui.cancel')))))
      : null,
    error === undefined
      ? null
      : WF_H('div', { className: 'zwf-form-error' },
        WF_H('p', { className: 'zwf-form-error-text' }, WF_UI.say(props.t, UI_EN, 'run.questions.answer.failed')),
        WF_H('pre', { className: 'zwf-form-error-detail' }, error))),
  WF_H('span', { className: 'zwf-question-meta zwf-mono' },
    question.askedAt === undefined
      ? null
      : WF_H('span', { 'data-testid': 'workflow-run-question-waited' }, WF_UI.say(props.t, UI_EN, 'getRun.subagent.waitedFor', { age: wfAge(question.askedAt, props.now) })),
    WF_H('span', { className: 'zwf-question-qid' }, question.qid),
    answering
      ? null
      : WF_H('button', {
        type: 'button',
        className: 'zwf-link zwf-question-answer',
        onClick: () => setAnswering(true),
      }, WF_UI.say(props.t, UI_EN, 'run.questions.answer.action'))));
}

/** The actor's own steps: enough to see what it was asked and how far it got. */
function WfActorLedger(props) {
  const { entry, t } = props;
  const nodes = entry.nodes ?? [];
  if (nodes.length === 0) {
    return WF_H('div', { className: 'zwf-actor', 'data-testid': 'workflow-actor-not-started' },
      WF_H('span', { className: 'zwf-actor-glyph' }, WF_H(WF_UI.icons.agent, { size: 16 })),
      WF_H('p', { className: 'zwf-actor-title' }, WF_UI.say(t, UI_EN, 'run.actor.notStarted.title')),
      WF_H('p', { className: 'zwf-actor-body' }, WF_UI.say(t, UI_EN, 'run.actor.notStarted.body')));
  }
  return WF_H('div', { className: 'zwf-actor', 'data-testid': 'workflow-actor-session' },
    nodes.map((node, index) => WF_H('div', { key: `${node.siteId ?? ''}-${node.ordinal ?? index}`, className: 'zwf-actor-row' },
      WF_H('span', { className: `zwf-dot zwf-dot-${node.outcome === 'failed' ? 'error' : node.phase === 'settled' ? 'success' : 'warn'}` }),
      WF_H('span', { className: 'zwf-actor-phase' }, node.phaseName ?? WF_UI.say(t, UI_EN, 'graph.phase.unphased')),
      node.instructionsHead === undefined
        ? null
        : WF_H('span', { className: 'zwf-actor-brief' }, node.instructionsHead),
      node.turn === undefined ? null : WF_H('span', { className: 'zwf-actor-meta zwf-mono' }, WF_UI.say(t, UI_EN, 'card.round', { count: node.turn })),
      node.toolCalls === undefined ? null : WF_H('span', { className: 'zwf-actor-meta zwf-mono' }, `${node.toolCalls}`),
      node.lastTool?.name === undefined
        ? null
        : WF_H('span', { className: 'zwf-actor-meta zwf-mono' }, node.lastTool.name))));
}

/** The hole waiting block, with the fill control the fill route backs. */
function WfHoleWaiting(props) {
  const hole = props.hole;
  const [filling, setFilling] = React.useState(false);
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(undefined);
  const submit = async () => {
    if (busy || value.trim() === '' || typeof props.scope?.runId !== 'string') return;
    setBusy(true);
    setError(undefined);
    try {
      await WF_API.fillHole({
        sessionId: props.scope.sessionId,
        runId: props.scope.runId,
        holeId: hole.id,
        script: value,
      });
      setFilling(false);
      setValue('');
      props.onRefresh?.();
    } catch (failure) {
      setError(wfText(failure?.message) ?? wfText(failure?.code));
    } finally {
      setBusy(false);
    }
  };
  return WF_H('div', { className: 'zwf-hole-waiting', 'data-testid': 'workflow-run-hole-waiting' },
    WF_H('span', { className: 'zwf-hole-waiting-text' },
      WF_UI.say(props.t, UI_EN, 'run.hole.waitingFor'),
      hole.since === undefined ? '' : ` · ${wfAge(hole.since, props.now)}`),
    hole.prompt === undefined
      ? null
      : WF_H('p', { className: 'zwf-hole-prompt', 'data-testid': 'workflow-run-hole-prompt' }, hole.prompt),
    filling
      ? WF_H('div', { className: 'zwf-hole-fill' },
        WF_H(WF_UI.Textarea, {
          rows: 5,
          value,
          placeholder: WF_UI.say(props.t, UI_EN, 'run.hole.fill.placeholder'),
          onChange: setValue,
        }),
        WF_H('div', { className: 'zwf-hole-fill-actions' },
          WF_H('button', {
            type: 'button',
            className: 'zwf-btn zwf-btn-primary zwf-btn-sm',
            disabled: busy || value.trim() === '',
            onClick: () => { void submit(); },
          }, WF_H('span', { className: 'zwf-btn-label' }, WF_UI.say(props.t, UI_EN, 'run.hole.fill.submit'))),
          WF_H('button', {
            type: 'button',
            className: 'zwf-btn zwf-btn-ghost zwf-btn-sm',
            disabled: busy,
            onClick: () => {
              setFilling(false);
              setError(undefined);
            },
          }, WF_H('span', { className: 'zwf-btn-label' }, WF_UI.say(props.t, UI_EN, 'ui.cancel'))),
          busy ? WF_H(WF_UI.Spinner, { inline: true }) : null))
      : null,
    error === undefined
      ? null
      : WF_H('div', { className: 'zwf-form-error' },
        WF_H('p', { className: 'zwf-form-error-text' }, WF_UI.say(props.t, UI_EN, 'run.hole.fill.failed')),
        WF_H('pre', { className: 'zwf-form-error-detail' }, error)),
    filling
      ? null
      : WF_H('button', {
        type: 'button',
        className: 'zwf-link',
        onClick: () => setFilling(true),
      }, WF_UI.say(props.t, UI_EN, 'run.hole.fill.action')));
}

/**
 * One folding phase row with everything that hangs under it.
 *
 * @param {{
 *   station: object, run: object, t: Function, index: number, open: boolean, door: boolean,
 *   pins: object[], rest: object[], counts: object, unlisted: number, fraction: object, rounds?: number,
 *   hole?: object, questions: Map<string, object[]>, orphanPins: object[], now: number,
 *   landed: boolean, onToggle: Function, onDoor: Function, onOpenEntry: Function,
 * }} props
 */
function WfPhaseRow(props) {
  const { station, t, open, door } = props;
  const expandLabel = WF_UI.say(t, UI_EN, open ? 'run.phase.collapse' : 'run.phase.expand', { name: station.name });
  const cluster = open
    ? WF_H(WfRosterMeter, { counts: props.counts })
    : WF_H('span', { className: 'zwf-phase-cluster', 'data-testid': 'workflow-run-phase-cluster' },
      WF_H(WfRosterMeter, { counts: props.counts, mini: true }),
      WF_H(WfAvatarStack, { entries: props.pins.concat(props.rest), max: 3 }));
  return WF_H('section', {
    className: `zwf-phase${props.landed ? ' zwf-phase-landed' : ''}`,
    'data-testid': 'workflow-run-phase',
    'data-phase-id': station.name,
    'data-phase-status': station.status,
    'data-phase-hole': station.hole ?? '',
    'data-phase-track': (station.alongside ?? []).join(',') || '0',
    'data-phase-open': open ? 'true' : 'false',
    'data-phase-landed': props.landed ? 'true' : undefined,
  },
  WF_H('button', {
    type: 'button',
    className: 'zwf-phase-toggle',
    'data-testid': 'workflow-run-phase-toggle',
    'aria-expanded': open,
    'aria-label': expandLabel,
    onClick: () => props.onToggle?.(station.name),
  },
  WF_H('span', {
    className: `zwf-lamp zwf-lamp-${station.status}${station.hole === 'waiting' ? ' zwf-lamp-hole-waiting' : ''}${station.hole === 'open' ? ' zwf-lamp-hole-open' : ''}`,
    'data-testid': 'workflow-run-phase-lamp',
    'data-status': station.status,
    'data-hole': station.hole ?? '',
    'aria-hidden': 'true',
  }),
  WF_H('span', {
    className: `zwf-phase-name${station.status === 'pending' ? ' zwf-phase-name-idle' : ''}`,
    title: station.name,
  }, station.name),
  station.hole === 'filled' || station.hole === 'open'
    ? WF_H('span', { className: 'zwf-phase-fillmark', 'data-testid': 'workflow-hole-fill-mark', title: WF_UI.say(t, UI_EN, 'run.hole.filledAt', { time: '' }) },
      WF_H(WF_UI.icons.spark, { size: 11 }))
    : null,
  station.hole === 'waiting'
    ? WF_H('span', { className: 'zwf-phase-holew', 'data-testid': 'workflow-hole-waiting' }, WF_UI.say(t, UI_EN, 'hole.waiting'))
    : null,
  WF_H('span', { className: 'zwf-phase-right' },
    cluster,
    WF_H('span', { className: 'zwf-phase-fraction zwf-mono', 'data-testid': 'workflow-run-phase-fraction' }, `${props.fraction.settled}/${props.fraction.observed}`),
    props.rounds === undefined || props.rounds <= 0
      ? null
      : WF_H('span', { className: 'zwf-phase-rounds zwf-mono', 'data-testid': 'workflow-run-phase-rounds', title: WF_UI.say(t, UI_EN, 'timeline.rounds', { count: props.rounds }) }, String(props.rounds)),
    WF_H('span', { className: `zwf-chevron${open ? ' zwf-chevron-open' : ''}`, 'aria-hidden': 'true' }, WF_H(WF_UI.icons.chevronRight, { size: 13 })))),
  open
    ? WF_H('div', { className: 'zwf-phase-body', 'data-testid': 'workflow-run-phase-body' },
      station.hole === 'waiting' && props.hole !== undefined
        ? WF_H(WfHoleWaiting, { hole: props.hole, t, now: props.now, scope: props.scope, onRefresh: props.onRefresh })
        : null,
      props.pins.length > 0
        ? WF_H('div', { className: 'zwf-roster-pins', 'data-testid': 'workflow-roster-pins' },
          props.pins.map((entry) => WF_H('div', { key: entry.key, className: 'zwf-roster-pin' },
            WF_H(WfAgentPill, {
              entry,
              t,
              size: 'row',
              open: { testId: 'workflow-run-agent-open', onOpen: () => props.onOpenEntry?.(entry) },
            }),
            (props.questions.get(entry.key) ?? []).map((question) => WF_H(WfQuestionBlock, {
              key: question.qid,
              question,
              t,
              now: props.now,
              scope: props.scope,
              onRefresh: props.onRefresh,
            })))))
        : null,
      props.rest.length > 0 || props.unlisted > 0
        ? WF_H(WfRosterDoor, {
          t,
          open: door,
          total: props.rest.length + props.unlisted,
          entries: props.pins.concat(props.rest),
          counts: props.counts,
          onToggle: () => props.onDoor?.(station.name),
        })
        : null,
      door
        ? WF_H(WfRosterRoll, {
          t,
          groups: [{ status: 'failed', entries: [] }, { status: 'running', entries: [] }, { status: 'pending', entries: [] }, { status: 'done', entries: [] }]
            .map((group) => ({ status: group.status, entries: props.rest.filter((entry) => entry.status === group.status) })),
          unlisted: props.unlisted,
          onOpenEntry: props.onOpenEntry,
        })
        : null)
    : null);
}

/**
 * The whole phase list: spine, one row per station, the fill heading of a hole, the orphan
 * question area and the "no graph" notice.
 */
function WfRunPhaseList(props) {
  const { run, stations, t } = props;
  if (stations.length === 0) {
    return WF_H('p', { className: 'zwf-graph-unavailable', 'data-testid': 'workflow-run-graph-unavailable' },
      WF_UI.say(t, UI_EN, 'run.graph.unavailable'));
  }
  const fillHoles = (props.fills ?? []).filter((hole) => hole.state === 'filled');
  const orphans = props.orphans ?? [];
  return WF_H('div', { className: 'zwf-phases', 'data-testid': 'workflow-run-phases' },
    fillHoles.length > 0
      ? WF_H('div', { className: 'zwf-fill-frames', 'data-testid': 'workflow-run-fill-frames' },
        fillHoles.map((hole) => WF_H('span', {
          key: hole.id ?? hole.name,
          className: 'zwf-fill-frame-run',
          'data-testid': 'workflow-run-fill-frame',
          'data-fill-frame': hole.id ?? hole.name,
        })))
      : null,
    stations.map((station, index) => {
      const roster = props.rosters?.get(station.name);
      const hole = (props.holes ?? []).find((entry) => wfPhaseMatches(station.name, entry.name));
      const fillRow = hole !== undefined && hole.state === 'filled'
        ? WF_H('div', {
          key: `fill-${hole.name}`,
          className: 'zwf-fill-heading',
          'data-testid': 'workflow-run-fill-heading',
          'data-fill-head': hole.id ?? hole.name,
          title: hole.filledAt === undefined
            ? WF_UI.say(t, UI_EN, 'hole.head.title.untimed', { name: hole.name })
            : WF_UI.say(t, UI_EN, 'hole.head.title', { name: hole.name, time: WF_UI.date(hole.filledAt) }),
        },
        WF_H('span', { className: 'zwf-fill-heading-glyph' }, WF_H(WF_UI.icons.spark, { size: 11 })),
        WF_H('span', { className: 'zwf-fill-heading-name' }, hole.name))
        : null;
      return WF_H(WF_FRAGMENT, { key: station.name },
        WF_H('div', { className: 'zwf-spine', 'aria-hidden': 'true' },
          WF_H('span', { className: 'zwf-spine-rail', 'data-testid': 'workflow-run-spine-rail' }),
          index === stations.length - 1 ? null : WF_H('span', { className: 'zwf-spine-joint', 'data-testid': 'workflow-run-spine-joint', 'data-joint-open': index === 0 ? 'start' : 'end' })),
        fillRow,
        WF_H(WfPhaseRow, {
          station,
          run,
          t,
          index,
          open: props.expanded?.has(station.name) === true,
          door: props.doors?.has(station.name) === true,
          pins: roster?.pins ?? [],
          rest: roster?.rest ?? [],
          counts: roster?.counts ?? { done: 0, failed: 0, running: 0, pending: 0 },
          unlisted: roster?.unlisted ?? 0,
          fraction: roster?.fraction ?? { settled: 0, observed: 0 },
          rounds: roster?.rounds,
          hole,
          questions: props.questions ?? new Map(),
          now: props.now,
          landed: props.landed === station.name,
          onToggle: props.onToggle,
          onDoor: props.onDoor,
          onOpenEntry: props.onOpenEntry,
          scope: props.scope,
          onRefresh: props.onRefresh,
        }));
    }),
    orphans.length > 0
      ? WF_H('div', { className: 'zwf-orphan-questions', 'data-testid': 'workflow-run-orphan-questions' },
        WF_H('h3', { className: 'zwf-orphan-title' }, WF_UI.say(t, UI_EN, 'run.questions.title')),
        orphans.map((question) => WF_H(WfQuestionBlock, {
          key: question.qid,
          question,
          t,
          showAsker: true,
          now: props.now,
          scope: props.scope,
          onRefresh: props.onRefresh,
        })))
      : null);
}
