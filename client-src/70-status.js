/* Session header entry: the open session's workflow runs, as the status panel shows them.
 *
 * The entry is one compact island button carrying the live count; beside it sits a non-portal
 * panel with three views of the same run list:
 *   - `live`: one island pill per running run (name, elapsed, phase progress, stop) and one
 *     background-result card per run that ended or is blocked, stalled or waiting on an answer;
 *   - `directory`: the conversation's run directory, split into running and ended sections.
 * A session without runs renders nothing at all, and a failing route only warns in the console —
 * this entry sits in every session header, so it must never grow a permanent error banner.
 */

/** The session status entry: `register(ctx, effect)` is called by the client entry. */
const WF_STATUS = {};

/** Runs requested per poll; the header only needs one screen of history. */
const WF_STATUS_RUN_LIMIT = 20;
/** Poll interval for the session's run catalog. */
const WF_STATUS_POLL_MS = 5000;
/** Ended runs listed in one panel view. */
const WF_STATUS_ENDED_ROWS = 5;
/** A run with no success for this long is reported as stalled. */
const WF_STATUS_STALL_MS = 10 * 60 * 1000;
/** Lamps of the inline phase rail before the rest collapse into a counter. */
const WF_STATUS_RAIL = 6;

/**
 * Live UI-dictionary translator, bound when the header entry registers.
 * The tool card renders `card.detailAction` from the same dictionary, and a card cannot bind a
 * second namespace by itself.
 */
var WF_STATUS_UI = undefined;

/** One console warning per distinct failure, so a failing route cannot flood a busy session. */
const WF_STATUS_WARNED = new Set();

/**
 * UI copy with the English dictionary as the fallback.
 * The tool cards call this too, so the name and the signature are part of the client contract.
 */
function wfUiCopy(key, params) {
  return WF_UI.say(WF_STATUS_UI, UI_EN, key, params);
}

/** Report a background failure once; these surfaces never show an error banner. */
function wfStatusWarn(scope, error) {
  const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error);
  const key = `${scope}:${message}`;
  if (WF_STATUS_WARNED.has(key)) return;
  WF_STATUS_WARNED.add(key);
  console.warn(`zcode-workflow: ${scope} failed`, error);
}

/** Copy of this surface; the bound translator wins when the slot did not pass one. */
function wfStatusSay(t, key, params) {
  const translate = typeof t === 'function' ? t : WF_STATUS_UI;
  return WF_UI.say(translate, UI_EN, key, params);
}

/* ---------------------------------- readers --------------------------------- */

/**
 * One run row. The host publishes camelCase snapshots and summaries; the older snake_case spelling
 * is still read so a partially upgraded host keeps rendering.
 */
function wfStatusRun(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

function wfStatusText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

function wfStatusNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function wfStatusList(value) {
  return Array.isArray(value) ? value.filter((entry) => wfStatusRun(entry) !== undefined) : [];
}

/** The run identity. */
function wfStatusId(run) {
  return wfStatusText(run?.runId, run?.id);
}

/** The run's display name; the product fallback keeps an unnamed run readable. */
function wfStatusName(run, t) {
  return wfStatusText(run?.label, run?.name, run?.title) || wfStatusSay(t, 'hub.common.scriptFallback');
}

/** The normalized run state. */
function wfStatusState(run) {
  const status = wfStatusText(run?.status);
  if (status === 'pending' || status === 'running') return status;
  if (status === 'completed' || status === 'errored' || status === 'stopped' || status === 'superseded') return status;
  return 'unknown';
}

/** Terminal states: a run here keeps no live progress. */
function wfStatusTerminal(state) {
  return state === 'completed' || state === 'errored' || state === 'stopped' || state === 'superseded' || state === 'unknown';
}

/** When a run settled: its finish time, or its last update while it has none. */
function wfStatusSettledAt(run) {
  const finished = wfStatusNumber(run?.finishedAt, run?.updatedAt);
  return finished > 0 ? finished : wfStatusNumber(run?.createdAt);
}

/** When a run started. */
function wfStatusStartedAt(run) {
  return wfStatusNumber(run?.createdAt, run?.startedAt, run?.updatedAt);
}

/** Localized status word of one run. */
function wfStatusWord(t, state) {
  const key = `chat.toolCall.workflow.run.status.${state}`;
  return Object.prototype.hasOwnProperty.call(UI_EN, key)
    ? wfStatusSay(t, key)
    : wfStatusSay(t, 'chat.toolCall.workflow.card.ended');
}

/** Localized stop reason, when the run recorded one. */
function wfStatusStopReason(t, run) {
  const reason = wfStatusText(run?.stopReason);
  const key = `chat.toolCall.workflow.run.stopReason.${reason}`;
  return reason !== '' && Object.prototype.hasOwnProperty.call(UI_EN, key) ? wfStatusSay(t, key) : '';
}

/** The hole rows of one run. */
function wfStatusHoles(run) {
  return wfStatusList(run?.holes).map((hole) => ({
    id: wfStatusText(hole.siteId, hole.id, hole.name),
    name: wfStatusText(hole.name, hole.siteId, hole.id),
    status: wfStatusText(hole.status),
    prompt: wfStatusText(hole.prompt, hole.question),
    draftPath: wfStatusText(hole.draftPath, hole.draft_path),
    since: wfStatusNumber(hole.waitingSince, hole.reachedAt, hole.createdAt),
  }));
}

/** The questions a run is waiting on. */
function wfStatusQuestions(run) {
  return wfStatusList(run?.pendingQuestions);
}

/** The questions a run has already had answered. */
function wfStatusAnswered(run) {
  return wfStatusList(run?.answeredQuestions);
}

/** One question row: the prompt plus the context the agent gave it. */
function wfStatusQuestionText(question) {
  const text = wfStatusText(question?.prompt, question?.question, question?.text, question?.title);
  return text;
}

/** The artifact summaries of one run. */
function wfStatusArtifacts(run) {
  return wfStatusList(run?.artifacts);
}

/** Steps counted from the node table, when the host published one. */
function wfStatusSteps(run) {
  const nodes = wfStatusList(run?.nodes);
  if (nodes.length === 0) return undefined;
  let done = 0;
  for (const node of nodes) {
    if (node.status === 'settled' || node.settled === true) done += 1;
  }
  return { done, total: nodes.length };
}

/** Names of the phases currently executing. */
function wfStatusRunningPhases(run) {
  const rows = [];
  for (const phase of wfStatusList(run?.phases)) {
    const state = wfStatusText(phase.status);
    const name = wfStatusText(phase.name, phase.id);
    if (name !== '' && (state === 'running' || state === 'current')) rows.push(name);
  }
  if (rows.length === 0) {
    const current = wfStatusText(run?.currentPhase);
    if (current !== '') rows.push(current);
  }
  return rows;
}

/**
 * The progress line of one island pill (J.1 `R8t`): running phases, else the step tally, else the
 * status word. The kind decides whether the status word is the line itself or a trailing word.
 */
function wfStatusProgress(t, run) {
  const phases = wfStatusRunningPhases(run);
  if (phases.length > 0) return { kind: 'phases', text: phases.join(' \u2225 '), rail: wfStatusList(run?.phases) };
  const steps = wfStatusSteps(run);
  if (steps !== undefined) {
    return {
      kind: 'steps',
      text: wfStatusSay(t, 'chat.toolCall.workflow.card.steps', { done: steps.done, total: steps.total }),
    };
  }
  return { kind: 'status', text: wfStatusWord(t, wfStatusState(run)) };
}

/**
 * Split one `/runs` payload into the two groups the panel shows.
 * @param {unknown} payload `{ runs, truncated }` response body
 */
function wfStatusGroups(payload) {
  const record = wfStatusRun(payload) ?? {};
  const rows = Array.isArray(record.runs) ? record.runs : Array.isArray(record.entries) ? record.entries : [];
  const running = [];
  const ended = [];
  for (const row of rows) {
    const run = wfStatusRun(row);
    if (run === undefined) continue;
    const id = wfStatusId(run);
    if (id === '') continue;
    const state = wfStatusState(run);
    if (state === 'running' || state === 'pending') running.push(run);
    else ended.push(run);
  }
  running.sort((left, right) => wfStatusStartedAt(left) - wfStatusStartedAt(right));
  ended.sort((left, right) => wfStatusSettledAt(right) - wfStatusSettledAt(left));
  return {
    running,
    ended,
    endedTotal: ended.length,
    truncated: record.truncated === true,
  };
}

/** Whether one run waits on something the user may resolve. */
function wfStatusNotice(t, run, now) {
  const state = wfStatusState(run);
  const holes = wfStatusHoles(run);
  const waitingHoles = holes.filter((hole) => hole.status === '' || hole.status === 'waiting' || hole.status === 'open');
  const questions = wfStatusQuestions(run);
  const stopReason = wfStatusStopReason(t, run);
  if (!wfStatusTerminal(state)) {
    const health = wfStatusRun(run?.health) ?? {};
    const lastSuccess = wfStatusNumber(health.lastProgressAt, health.lastSuccessAt, run?.updatedAt);
    const stalled = health.stalled === true || (lastSuccess > 0 && now - lastSuccess > WF_STATUS_STALL_MS);
    if (stalled) {
      return {
        kind: 'stall',
        label: wfStatusSay(t, 'chat.backgroundResult.workflow.stall'),
        minutes: Math.max(1, Math.round((now - lastSuccess) / 60000)),
        reason: wfStatusText(health.lastError, health.retryReason, run?.error),
        cap: wfStatusNumber(health.concurrencyCeiling, run?.concurrencyCeiling),
      };
    }
    if (questions.length > 0) {
      const asked = wfStatusQuestionText(questions[0]);
      const waiting = wfStatusText(questions[0]?.status) !== 'answered';
      return {
        kind: 'escalation',
        label: wfStatusSay(t, waiting
          ? 'chat.backgroundResult.workflow.waiting'
          : 'chat.backgroundResult.workflow.asked'),
        question: asked,
        context: wfStatusText(questions[0]?.context, questions[0]?.background),
        waited: wfStatusNumber(questions[0]?.askedAt, questions[0]?.createdAt, run?.updatedAt),
      };
    }
    const answered = wfStatusAnswered(run);
    if (answered.length > 0) {
      return {
        kind: 'escalation',
        label: wfStatusSay(t, 'chat.backgroundResult.workflow.answered'),
        question: wfStatusQuestionText(answered[0]),
        context: wfStatusText(answered[0]?.context, answered[0]?.background),
      };
    }
    if (waitingHoles.length > 0) {
      return {
        kind: 'blocked',
        label: wfStatusSay(t, 'chat.backgroundResult.workflow.blocked'),
        holes: waitingHoles.length,
        waited: wfStatusNumber(waitingHoles[0]?.since, run?.updatedAt),
      };
    }
    return undefined;
  }
  return {
    kind: state === 'unknown' ? 'stopped' : state,
    label: wfStatusNoticeLabel(t, state),
    stopReason,
    ...(typeof run?.error === 'string' && run.error !== '' ? { error: run.error } : {}),
  };
}

/** Label of one terminal background result; unknown and superseded fall back to "ended". */
function wfStatusNoticeLabel(t, state) {
  const key = `chat.backgroundResult.workflow.${state}`;
  return Object.prototype.hasOwnProperty.call(UI_EN, key)
    ? wfStatusSay(t, key)
    : wfStatusSay(t, 'chat.toolCall.workflow.card.ended');
}

/* -------------------------------- rendering -------------------------------- */

/** One island pill of a live run (J.1). */
function WfStatusIsland(props) {
  const { t, run, now } = props;
  const say = (key, params) => wfStatusSay(t, key, params);
  const state = wfStatusState(run);
  const id = wfStatusId(run);
  const name = wfStatusName(run, t);
  const started = wfStatusStartedAt(run);
  const elapsed = started === 0 ? '' : WF_UI.duration(started, now);
  const progress = wfStatusProgress(t, run);
  const word = wfStatusWord(t, state);
  const label = `${say('chat.toolCall.workflow.openRunDetails')} \u00b7 ${name} \u00b7 ${word}${progress.text === '' ? '' : ` \u00b7 ${progress.text}`}`;
  const tone = WF_UI.statusTone(state);
  return WF_H('li', {
    className: 'zwf-island',
    'data-background-task-kind': 'workflow',
    'data-workflow-run-id': id,
    'data-work-id': id,
    'data-work-status': state,
    'data-testid': 'workflow-run-row',
  },
  props.openable !== false
    ? WF_H('button', {
      type: 'button',
      className: 'zwf-island-hit',
      'data-testid': 'workflow-run-details-trigger',
      'data-workflow-run-id': id,
      'data-workflow-run-details-trigger': 'true',
      'aria-label': label,
      title: name,
      onClick: () => props.onOpen(run),
    })
    : null,
  WF_H('span', { className: 'zwf-island-glyph' }, WF_H(WF_ICON.workflow, { size: 16 })),
  WF_H('div', { className: 'zwf-island-main' },
    WF_H('div', { className: 'zwf-island-line', 'data-workflow-island-line': 'name', 'data-testid': 'workflow-island-line' },
      WF_H('span', { className: 'zwf-island-name', title: name }, name),
      elapsed === '' ? null : WF_H('span', { className: 'zwf-island-time', 'data-workflow-run-elapsed': 'true', 'data-testid': 'workflow-run-elapsed' }, elapsed)),
    WF_H('div', {
      className: 'zwf-island-line zwf-island-line-phase',
      'data-workflow-island-line': 'phase',
      'data-testid': 'workflow-run-line',
    },
    progress.rail === undefined
      ? WF_H(WF_UI.StatusDot, { tone })
      : WF_H(WfStatusRail, { t, phases: progress.rail }),
    progress.kind === 'status'
      ? null
      : WF_H('span', { className: 'zwf-island-phase', title: progress.text }, progress.text),
    WF_H('span', {
      className: `zwf-island-state${progress.kind === 'status' ? ' zwf-island-state-lead' : ''}`,
      'data-testid': 'workflow-run-row-status',
    }, progress.kind === 'status' ? progress.text : word))),
  props.stoppable !== false
    ? WF_H('button', {
      type: 'button',
      className: 'zwf-island-stop',
      'aria-label': say('chat.toolCall.workflow.run.cancel'),
      title: say('chat.toolCall.workflow.run.cancel'),
      disabled: props.stopping === true,
      onClick: () => props.onStop(run),
    }, props.stopping === true ? WF_H(WF_UI.Spinner) : WF_H(WF_ICON.stop, { size: 11 }))
    : null);
}

/** The inline phase rail of one island pill: one lamp per phase, the rest counted. */
function WfStatusRail(props) {
  const phases = props.phases.slice(0, WF_STATUS_RAIL);
  const rest = props.phases.length - phases.length;
  return WF_H('span', { className: 'zwf-rail', 'data-testid': 'workflow-run-rail', 'aria-hidden': 'true' },
    phases.map((phase, index) => {
      const state = wfStatusText(phase.status);
      const tone = state === 'done' || state === 'completed' ? 'success' : state === 'running' || state === 'current' ? 'warn' : state === 'failed' || state === 'errored' ? 'error' : 'idle';
      return WF_H('span', { className: `zwf-rail-lamp zwf-rail-lamp-${tone}`, key: `${wfStatusText(phase.name, phase.id)}:${String(index)}` });
    }),
    rest > 0
      ? WF_H('span', { className: 'zwf-rail-more', 'data-testid': 'workflow-run-overflow' }, `+${String(rest)}`)
      : null);
}

/** The background-result card of one run (J.4): eight kinds, one label each. */
function WfStatusNotice(props) {
  const { t, run, notice, now } = props;
  const say = (key, params) => wfStatusSay(t, key, params);
  const name = wfStatusName(run, t);
  const word = wfStatusWord(t, wfStatusState(run));
  const artifacts = wfStatusArtifacts(run);

  let body;
  if (notice.kind === 'escalation') {
    const text = notice.question.length > 160 ? `${notice.question.slice(0, 159)}\u2026` : notice.question;
    body = WF_H('div', { className: 'zwf-notice-body zwf-notice-body-quote', 'data-testid': 'workflow-notification-escalation' },
      text === '' ? null : WF_H('p', { className: 'zwf-notice-text' }, text),
      notice.context === undefined || notice.context === '' ? null : WF_H('p', { className: 'zwf-notice-meta' }, notice.context),
      notice.waited === undefined || notice.waited === 0
        ? null
        : WF_H('p', { className: 'zwf-notice-meta' }, say('chat.backgroundResult.workflow.blocked.openFor', { minutes: Math.max(1, Math.round((now - notice.waited) / 60000)) })));
  } else if (notice.kind === 'stall') {
    body = WF_H('div', { className: 'zwf-notice-body', 'data-testid': 'workflow-notification-stall' },
      WF_H('p', { className: 'zwf-notice-text' }, say('chat.backgroundResult.workflow.stall.body', { minutes: notice.minutes })),
      notice.reason === '' ? null : WF_H('p', { className: 'zwf-notice-meta' }, `${say('chat.backgroundResult.workflow.stall.reason')} \u00b7 ${notice.reason}`),
      notice.cap === 0 ? null : WF_H('p', { className: 'zwf-notice-meta' }, `${say('chat.backgroundResult.workflow.stall.cap')} \u00b7 ${String(notice.cap)}`));
  } else if (notice.kind === 'blocked') {
    const parts = [];
    if (notice.holes > 0) parts.push(say('chat.permission.workflow.holesCount', { count: notice.holes }));
    if (notice.waited > 0) parts.push(say('chat.backgroundResult.workflow.blocked.openFor', { minutes: Math.max(1, Math.round((now - notice.waited) / 60000)) }));
    body = WF_H('div', { className: 'zwf-notice-body', 'data-testid': 'workflow-notification-blocked' },
      WF_H('p', { className: 'zwf-notice-text' }, parts.join(' \u00b7 ')));
  } else if (notice.error !== undefined) {
    body = WF_H('div', { className: 'zwf-notice-body zwf-notice-body-error', 'data-testid': 'workflow-notification-result' },
      WF_H('p', { className: 'zwf-notice-text' }, notice.error));
  } else {
    body = WF_H('div', { className: 'zwf-notice-body', 'data-testid': 'workflow-notification-result' },
      WF_H('p', { className: 'zwf-notice-meta' }, `${word}${notice.stopReason === '' ? '' : ` \u00b7 ${notice.stopReason}`}`));
  }

  return WF_H('div', { className: 'zwf-notice', 'data-testid': 'workflow-notification-row', 'data-workflow-run-id': wfStatusId(run) },
    WF_H('div', { className: 'zwf-notice-head' },
      WF_H('span', { className: `zwf-notice-glyph zwf-notice-glyph-${WF_UI.statusTone(wfStatusState(run))}` }, WF_H(WF_ICON.workflow, { size: 14 })),
      WF_H('span', { className: 'zwf-notice-label' }, notice.label),
      WF_H('span', { className: 'zwf-notice-name', title: name }, `\u00b7 ${name}`),
      WF_H('span', {
        className: 'zwf-notice-status',
        // A terminal result has been surfaced here: ZCode marks that state on the notification.
        ...(wfStatusTerminal(wfStatusState(run)) ? { 'data-testid': 'workflow-run-acknowledged' } : {}),
      }, word)),
    artifacts.length === 0
      ? null
      : WF_H('div', { className: 'zwf-notice-artifacts', 'data-testid': 'workflow-notification-artifacts' },
        artifacts.slice(0, 4).map((artifact, index) => WF_H('span', { className: 'zwf-notice-chip', key: `${wfStatusText(artifact.id)}:${String(index)}`, title: wfStatusText(artifact.title, artifact.id) },
          WF_H('span', { className: 'zwf-notice-chip-glyph' }, WF_H(WF_UI.artifactIcon(wfStatusText(artifact.kind)), { size: 12 })),
          WF_H('span', { className: 'zwf-notice-chip-text' }, wfStatusText(artifact.title, artifact.id)))),
        artifacts.length > 4
          ? WF_H('span', { className: 'zwf-notice-chip zwf-notice-chip-more', key: 'more', 'data-testid': 'workflow-notification-artifacts-more' },
            say('chat.backgroundResult.workflow.artifacts.more', { count: artifacts.length - 4 }))
          : null),
    body,
    WF_H('button', {
      type: 'button',
      className: 'zwf-notice-link',
      onClick: () => props.onOpen(run),
    }, say('chat.toolCall.workflow.openRunDetails')));
}

/** The hole notice of one run (F.4f): the hole waiting for the agent's code. */
function WfStatusHoleNotice(props) {
  const { t, run, hole, now } = props;
  const say = (key, params) => wfStatusSay(t, key, params);
  const name = wfStatusName(run, t);
  const waited = hole.since === 0 ? '' : WF_UI.duration(hole.since, now);
  const kindLabel = hole.status === 'filled'
    ? say('chat.backgroundResult.workflow.hole.filled')
    : hole.status === 'waiting' || hole.status === '' ? say('chat.backgroundResult.workflow.hole.waiting') : say('chat.backgroundResult.workflow.hole.left');
  return WF_H('div', { className: 'zwf-notice', 'data-workflow-run-id': wfStatusId(run) },
    WF_H('div', { className: 'zwf-notice-head' },
      WF_H('span', { className: 'zwf-notice-glyph zwf-notice-glyph-warn' }, WF_H(WF_ICON.spark, { size: 14 })),
      WF_H('span', { className: 'zwf-notice-label' }, kindLabel),
      WF_H('span', { className: 'zwf-notice-name', title: name }, `\u00b7 ${name}`),
      waited === '' ? null : WF_H('span', { className: 'zwf-notice-status', 'data-testid': 'workflow-hole-notification-waited' },
        say('chat.toolCall.workflow.hole.waited', { time: waited }))),
    WF_H('p', { className: 'zwf-notice-title', 'data-testid': 'workflow-hole-notification-name' },
      say('chat.toolCall.workflow.hole.head.title.untimed', { name: hole.name })),
    hole.prompt === '' ? null : WF_H('p', { className: 'zwf-notice-text', 'data-testid': 'workflow-hole-notification-body' }, hole.prompt),
    hole.draftPath === '' ? null : WF_H('p', { className: 'zwf-notice-meta zwf-notice-mono', 'data-testid': 'workflow-hole-notification-draft' }, hole.draftPath),
    WF_H('button', {
      type: 'button',
      className: 'zwf-notice-link',
      onClick: () => props.onOpen(run),
    }, say('chat.toolCall.workflow.hole.open', { name: hole.name })));
}

/** One directory row of the run directory (J.3). */
function WfStatusDirectoryRow(props) {
  const { t, run, now } = props;
  const say = (key, params) => wfStatusSay(t, key, params);
  const state = wfStatusState(run);
  const name = wfStatusName(run, t);
  const settled = wfStatusSettledAt(run);
  const reason = wfStatusStopReason(t, run);
  const time = settled === 0 ? '' : WF_UI.relative(t, UI_EN, settled, now);
  const detail = reason === '' ? '' : `\u00b7 ${reason}`;
  return WF_H('button', {
    type: 'button',
    className: 'zwf-dirrow',
    'data-testid': 'workflow-run-card',
    'data-run-id': wfStatusId(run),
    'data-run-status': state,
    'data-workflow-run-id': wfStatusId(run),
    'data-workflow-run-status': state,
    'aria-label': say('chat.toolCall.workflow.openRunDetails'),
    onClick: () => props.onOpen(run),
  },
  WF_H('span', { className: 'zwf-dirrow-main' },
    WF_H('span', { className: 'zwf-dirrow-name', title: name }, name),
    WF_H('span', { className: 'zwf-dirrow-meta' },
      WF_H('span', { className: `zwf-dirrow-status zwf-status-word-${WF_UI.statusTone(state)}` }, wfStatusWord(t, state)),
      detail === '' ? null : WF_H('span', { className: 'zwf-dirrow-reason' }, detail))),
  time === '' ? null : WF_H('span', { className: 'zwf-dirrow-time' }, time),
  WF_H('span', { className: 'zwf-dirrow-glyph' }, WF_H(WF_ICON.chevronRight, { size: 14 })));
}

/** The run directory view (J.3): running and ended sections, with their own empty states. */
function WfStatusDirectory(props) {
  const { t, groups, now, error } = props;
  const say = (key, params) => wfStatusSay(t, key, params);
  const section = (kind, rows, heading, emptyTestId) => WF_H('section', {
    className: `zwf-dirsect${kind === 'ended' ? ' zwf-dirsect-ended' : ''}`,
    'data-testid': 'workflow-directory-section',
    'data-workflow-directory-section': kind,
  },
  WF_H('h3', { className: 'zwf-dirsect-head' },
    WF_H('span', null, `${heading} \u00b7 ${String(rows.length)}`),
    WF_H('span', { className: 'zwf-dirsect-count', 'data-testid': `workflow-run-directory-${kind}-count` }, String(rows.length))),
  rows.length === 0
    ? WF_H('p', { className: 'zwf-empty-inline', 'data-testid': emptyTestId }, say(kind === 'running' ? 'workflowDirectory.runningEmpty' : 'workflowDirectory.endedEmpty'))
    : WF_H('div', { className: 'zwf-dirsect-rows' }, rows.map((run) => WF_H(WfStatusDirectoryRow, {
      key: wfStatusId(run),
      t,
      run,
      now,
      onOpen: props.onOpen,
    }))));

  if (error !== undefined && groups.running.length === 0 && groups.ended.length === 0) {
    return WF_H('div', { className: 'zwf-dirsect', 'data-testid': 'workflow-directory' },
      WF_H('p', { className: 'zwf-empty-inline', 'data-testid': 'workflow-run-directory-unavailable' }, say('workflowDirectory.unavailable')));
  }
  if (groups.running.length === 0 && groups.ended.length === 0) {
    return WF_H('div', { className: 'zwf-dirsect', 'data-testid': 'workflow-directory' },
      WF_H('p', { className: 'zwf-empty-inline', 'data-testid': 'workflow-run-directory-empty' }, say('workflowDirectory.empty')));
  }
  return WF_H('div', { className: 'zwf-directory', 'data-testid': 'workflow-directory' },
    section('running', groups.running, say('workflowDirectory.running'), 'workflow-run-directory-running-empty'),
    section('ended', groups.ended, say('workflowDirectory.ended'), 'workflow-run-directory-ended-empty'),
    groups.truncated
      ? WF_H('p', { className: 'zwf-dirsect-note', 'data-testid': 'workflow-run-directory-truncated' },
        say('workflowDirectory.truncated', { count: WF_STATUS_RUN_LIMIT }))
      : null);
}

/**
 * The session header entry.
 * @param {object} props slot standard props: `sessionId`, `t`, and the injected `openDirectory`
 */
function WfStatusEntry(props) {
  const safe = wfStatusRun(props) !== undefined;
  const sessionId = safe && typeof props.sessionId === 'string' ? props.sessionId : '';
  const t = safe && typeof props.t === 'function' ? props.t : undefined;
  const say = (key, params) => wfStatusSay(t, key, params);
  const openDirectory = safe && typeof props.openDirectory === 'function' ? props.openDirectory : undefined;

  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState('live');
  const [now, setNow] = React.useState(() => Date.now());
  const [stopping, setStopping] = React.useState('');
  const rootRef = React.useRef(null);
  const triggerRef = React.useRef(null);

  const load = React.useCallback(async () => {
    if (sessionId === '') return { runs: [] };
    try {
      return await WF_API.runs({ sessionId, limit: WF_STATUS_RUN_LIMIT });
    } catch (error) {
      wfStatusWarn('session runs', error);
      throw error;
    }
  }, [sessionId]);
  const { data, error, reload } = useWfPolling(load, [sessionId], WF_STATUS_POLL_MS);
  const groups = React.useMemo(() => wfStatusGroups(data), [data]);
  const running = groups.running;
  const live = running.length > 0;

  React.useEffect(() => {
    setOpen(false);
    setView('live');
    setStopping('');
  }, [sessionId]);

  React.useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current !== null && rootRef.current.contains(event.target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      if (triggerRef.current !== null) triggerRef.current.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const openRun = (run) => {
    if (typeof WF_DETAIL !== 'object' || WF_DETAIL === null || typeof WF_DETAIL.open !== 'function') return;
    const runId = wfStatusId(run);
    if (runId === '') return;
    try {
      WF_DETAIL.open({ runId, sessionId });
      setOpen(false);
    } catch (error) {
      wfStatusWarn('run detail', error);
    }
  };

  const stopRun = (run) => {
    const runId = wfStatusId(run);
    if (runId === '' || stopping !== '') return;
    setStopping(runId);
    WF_API.stopRun({ sessionId, runId })
      .catch((error) => wfStatusWarn('stop run', error))
      .then(() => {
        setStopping('');
        reload();
      });
  };

  if (sessionId === '' || (running.length === 0 && groups.endedTotal === 0)) return null;

  const triggerLabel = running.length === 0
    ? say('chat.statusPanel.workflows')
    : `${say('chat.statusPanel.workflows')} \u00b7 ${say('chat.statusPanel.workflowsLive', { count: running.length })}`;
  const trigger = WF_H('button', {
    ref: triggerRef,
    type: 'button',
    className: 'zwf-status-trigger',
    'data-workflow-status-entry': 'true',
    'data-testid': 'workflow-status-trigger',
    'data-workflow-running-count': String(running.length),
    'aria-label': triggerLabel,
    'aria-haspopup': 'dialog',
    'aria-expanded': open ? 'true' : 'false',
    title: triggerLabel,
    onClick: () => {
      setNow(Date.now());
      setOpen((current) => current !== true);
    },
  },
  WF_H(WF_ICON.workflow, { size: 16 }),
  running.length > 0 ? WF_H('span', { className: 'zwf-status-count' }, String(running.length)) : null);

  const endedRows = groups.ended.slice(0, WF_STATUS_ENDED_ROWS);
  const liveNodes = running.map((run) => WF_H(WfStatusIsland, {
    key: `island-${wfStatusId(run)}`,
    t,
    run,
    now,
    stopping: stopping === wfStatusId(run),
    onOpen: openRun,
    onStop: stopRun,
  }));
  const notices = [];
  for (const run of [...running, ...endedRows]) {
    const holes = wfStatusHoles(run).filter((hole) => hole.status !== 'filled');
    if (holes.length > 0) {
      notices.push(WF_H(WfStatusHoleNotice, {
        key: `hole-${wfStatusId(run)}`,
        t,
        run,
        hole: holes[0],
        now,
        onOpen: openRun,
      }));
    }
    const notice = wfStatusNotice(t, run, now);
    if (notice === undefined) continue;
    notices.push(WF_H(WfStatusNotice, {
      key: `notice-${wfStatusId(run)}`,
      t,
      run,
      notice,
      now,
      onOpen: openRun,
    }));
  }

  const liveView = WF_H('div', { className: 'zwf-status-view' },
    WF_H('div', { className: 'zwf-status-head' },
      WF_H('span', { className: 'zwf-status-title' }, say('chat.statusPanel.workflows')),
      running.length === 0
        ? null
        : WF_H('span', { className: 'zwf-status-trailing' },
          WF_H(WF_UI.StatusDot, { tone: 'success' }),
          say('chat.statusPanel.workflowsLive', { count: running.length }))),
    WF_H('div', { className: 'zwf-status-body', 'data-testid': 'workflow-status-body' },
      liveNodes.length === 0
        ? WF_H('p', { className: 'zwf-empty-inline' }, say('workflowDirectory.runningEmpty'))
        : WF_H('ul', { className: 'zwf-islands', 'data-testid': 'workflow-run-list' }, liveNodes),
      notices.length === 0 ? null : WF_H('div', { className: 'zwf-notices' }, notices)),
    WF_H('button', {
      type: 'button',
      className: 'zwf-status-foot',
      'data-testid': 'workflow-run-directory-trigger',
      onClick: () => setView('directory'),
    },
    WF_H('span', { className: 'zwf-status-foot-glyph' }, WF_H(WF_ICON.log, { size: 14 })),
    WF_H('span', { className: 'zwf-status-foot-label' }, say('chat.statusPanel.endedWorkflows')),
    WF_H('span', { className: 'zwf-status-foot-count' }, String(groups.endedTotal)),
    WF_H('span', { className: 'zwf-status-foot-glyph' }, WF_H(WF_ICON.chevronRight, { size: 13 }))));

  const directoryView = WF_H('div', { className: 'zwf-status-view' },
    WF_H('div', { className: 'zwf-status-head' },
      WF_H('button', {
        type: 'button',
        className: 'zwf-status-back',
        'aria-label': say('workflowDirectory.title'),
        title: say('workflowDirectory.title'),
        onClick: () => setView('live'),
      },
      WF_H('span', { className: 'zwf-status-back-glyph' }, WF_H(WF_ICON.chevronRight, { size: 13 })),
      WF_H('span', { className: 'zwf-status-title' }, say('workflowDirectory.title'))),
      typeof openDirectory === 'function'
        ? WF_H('button', {
          type: 'button',
          className: 'zwf-status-link',
          onClick: () => {
            setOpen(false);
            openDirectory();
          },
        }, WF_H(WF_ICON.external, { size: 12 }))
        : null),
    WF_H(WfStatusDirectory, {
      t,
      groups: { ...groups, ended: groups.ended.slice(0, WF_STATUS_RUN_LIMIT) },
      now,
      error,
      onOpen: openRun,
    }));

  const panel = open
    ? WF_H('div', { className: 'zwf-status-menu', role: 'dialog', 'aria-label': say('sidePane.workflowDirectory') },
      view === 'live' ? liveView : directoryView)
    : null;

  return WF_H('div', { className: 'zwf-status-anchor', ref: rootRef }, trigger, panel);
}

/* -------------------------------- registration ------------------------------- */

/**
 * Register the session header entry.
 * @param {object} ctx client plugin context
 * @param {(callback: () => (() => void) | void, label?: string) => unknown} effect effect registrar
 */
WF_STATUS.register = function register(ctx, effect) {
  if (typeof ctx !== 'object' || ctx === null) return;
  if (ctx.locale !== undefined && ctx.locale !== null && typeof ctx.locale.bind === 'function') {
    try {
      WF_STATUS_UI = ctx.locale.bind(UI_NS);
    } catch (error) {
      console.warn('zcode-workflow: UI dictionary bind failed', error);
    }
  }
  const slots = ctx.slots;
  if (slots === undefined || slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;
  /** The layout service, resolved lazily so this plugin needs no extra injection. */
  const layout = () => {
    try {
      if (typeof ctx.get === 'function') {
        const service = ctx.get('layout');
        if (service !== undefined && service !== null) return service;
      }
    } catch {
      // fall through to the plain property
    }
    try {
      return ctx.layout;
    } catch {
      return undefined;
    }
  };
  slots.inject('conversation.session.header.utilities', () => slots.register({
    name: 'conversation.session.header.utilities',
    id: 'workflow-status',
    order: -4,
    locale: UI_NS,
    inject: () => ({
      openDirectory: () => {
        const service = layout();
        if (service === undefined || service === null || typeof service.selectPanel !== 'function') return;
        try {
          service.selectPanel(WF_DIRECTORY_PANEL_ID);
        } catch (error) {
          wfStatusWarn('open workflow directory', error);
        }
      },
    }),
  }, WfStatusEntry));
};

/* ----------------------------------- styles ---------------------------------- */

const WF_STATUS_CSS = `
.zwf-status-anchor{position:relative;display:inline-flex;align-items:center;flex:none}
.zwf-status-trigger{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;min-width:28px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;transition:background-color .12s,color .12s}
.zwf-status-trigger:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-primary)}
.zwf-status-trigger[aria-expanded=true]{background:color-mix(in oklab,var(--dsw-alias-label-primary) 9%,transparent);color:var(--dsw-alias-label-primary)}
.zwf-status-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.zwf-status-count{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px;line-height:16px;font-weight:600;font-variant-numeric:tabular-nums}
.zwf-status-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:70;box-sizing:border-box;display:flex;flex-direction:column;width:min(360px,calc(100vw - 24px));max-height:min(520px,70vh);overflow-y:auto;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-shadow-lv3)}
.zwf-status-view{display:flex;flex-direction:column;gap:4px;min-width:0}
.zwf-status-head{display:flex;align-items:center;gap:6px;min-width:0;padding:6px 8px 4px}
.zwf-status-title{font-size:11.5px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.zwf-status-trailing{display:inline-flex;align-items:center;gap:5px;margin-left:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-status-body{display:flex;flex-direction:column;gap:4px;min-width:0}
.zwf-status-back{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.zwf-status-back:hover{color:var(--dsw-alias-label-primary)}
.zwf-status-back-glyph{display:inline-flex;transform:rotate(180deg)}
.zwf-status-link{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-left:auto;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.zwf-status-link:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.zwf-status-foot{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;height:30px;margin-top:2px;padding:0 8px;border:0;border-top:1px solid var(--dsw-alias-border-l1);border-radius:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.zwf-status-foot:hover{color:var(--dsw-alias-label-primary)}
.zwf-status-foot-glyph{display:inline-flex;flex:none}
.zwf-status-foot-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-status-foot-count{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.zwf-islands{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.zwf-island{position:relative;display:grid;grid-template-columns:1rem minmax(0,1fr);align-items:center;gap:0 8px;min-width:0;padding:8px;border-radius:var(--dsw-radius-sm,8px)}
.zwf-island:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,transparent)}
.zwf-island-hit{position:absolute;inset:0;z-index:0;border:0;border-radius:inherit;background:transparent;cursor:pointer}
.zwf-island-hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.zwf-island-glyph{position:relative;align-self:start;display:inline-flex;margin-top:2px;color:var(--dsw-alias-label-secondary)}
.zwf-island-main{display:flex;flex-direction:column;gap:2px;min-width:0;padding-right:24px}
.zwf-island-line{display:flex;align-items:baseline;gap:8px;min-width:0;height:20px;line-height:20px}
.zwf-island-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.zwf-island-time{flex:none;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.zwf-island-line-phase{height:18px;font-size:11.5px}
.zwf-island-phase{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.zwf-island-state{flex:none;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.zwf-island-state-lead{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.zwf-island-project{flex:none;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);opacity:.85}
.zwf-rail{display:inline-flex;align-items:center;gap:3px;flex:none}
.zwf-rail-lamp{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);opacity:.5}
.zwf-rail-lamp-success{background:var(--dsw-alias-state-success-primary);opacity:1}
.zwf-rail-lamp-warn{background:var(--dsw-alias-state-warn-primary);opacity:1}
.zwf-rail-lamp-error{background:var(--dsw-alias-state-error-primary);opacity:1}
.zwf-rail-more{font-size:10px;line-height:12px;color:var(--dsw-alias-label-secondary)}
.zwf-island-stop{position:absolute;right:6px;top:6px;z-index:2;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);opacity:0;cursor:pointer;transition:opacity .12s}
.zwf-island:hover .zwf-island-stop,.zwf-island:focus-within .zwf-island-stop{opacity:1}
.zwf-island-stop:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.zwf-island-stop:disabled{opacity:.5;cursor:default}
.zwf-island-stop:focus-visible{opacity:1;outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-notices{display:flex;flex-direction:column;gap:4px;margin-top:2px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1)}
.zwf-notice{display:flex;flex-direction:column;gap:4px;min-width:0;padding:8px;border-radius:var(--dsw-radius-sm,8px)}
.zwf-notice:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 5%,transparent)}
.zwf-notice-head{display:flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;line-height:17px}
.zwf-notice-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.zwf-notice-glyph-success{color:var(--dsw-alias-state-success-primary)}
.zwf-notice-glyph-warn{color:var(--dsw-alias-state-warn-primary)}
.zwf-notice-glyph-error{color:var(--dsw-alias-state-error-primary)}
.zwf-notice-label{flex:none;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap}
.zwf-notice-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.zwf-notice-status{margin-left:auto;flex:none;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.zwf-notice-title{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.zwf-notice-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.zwf-notice-body-error{padding:6px 8px;border:1px solid color-mix(in oklab,var(--dsw-alias-state-error-primary) 35%,transparent);border-radius:var(--dsw-radius-sm,8px)}
.zwf-notice-body-quote{padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1)}
.zwf-notice-text{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow:auto}
.zwf-notice-meta{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.zwf-notice-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}
.zwf-notice-artifacts{display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0}
.zwf-notice-chip{display:inline-flex;align-items:center;gap:4px;max-width:160px;height:20px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:10.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-notice-chip-glyph{display:inline-flex;flex:none}
.zwf-notice-chip-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-notice-chip-more{border-style:dashed}
.zwf-notice-link{align-self:flex-start;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:17px;text-decoration:underline dotted;text-underline-offset:2px;cursor:pointer}
.zwf-notice-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.zwf-directory{display:flex;flex-direction:column;gap:10px;min-width:0;padding:2px 4px 4px}
.zwf-dirsect{display:flex;flex-direction:column;gap:2px;min-width:0}
.zwf-dirsect-head{display:flex;align-items:center;gap:6px;margin:0;padding:4px 6px;font-size:11.5px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.zwf-dirsect-count{margin-left:auto;font-weight:400;font-variant-numeric:tabular-nums}
.zwf-dirsect-rows{display:flex;flex-direction:column;gap:1px;min-width:0}
.zwf-dirrow{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:7px 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.zwf-dirrow:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,transparent)}
.zwf-dirrow:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.zwf-dirrow-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.zwf-dirrow-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.zwf-dirrow-meta{display:flex;align-items:center;gap:6px;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-dirrow-status{flex:none}
.zwf-dirrow-reason{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-dirrow-time{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);opacity:.85}
.zwf-dirrow-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.zwf-dirsect-ended{margin-top:6px}
.zwf-dirsect-note{margin:2px 0 0;padding:0 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
@media (prefers-reduced-motion:reduce){.zwf-status-trigger,.zwf-island-stop{transition:none}}
`;

WF_STYLE_PARTS.push(WF_STATUS_CSS);
