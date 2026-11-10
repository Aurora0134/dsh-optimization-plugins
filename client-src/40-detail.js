/*
 * Right-Sidebar workflow run detail (`sidePane.workflowRun`).
 *
 * The pane reads one run from the session's run list, follows its event log while it is in flight
 * and renders the Host's derived station list. It owns the panel chrome (title, actions, status
 * row, provenance), the phase/timeline body (43/42), the roster (45) and the artifacts area (44);
 * the script-steps pane lives beside it as a second right-pane tab (46).
 */

/** Registered by `register`; `open`/`openScript` are the entry points other parts call. */
const WF_DETAIL = {};

/** Slot keys and right-pane tab ids for the two surfaces this part owns. */
const WF_DETAIL_RUN_ID = 'zcode-workflow/run';
const WF_DETAIL_SCRIPT_ID = 'zcode-workflow/script';
/** Pane id prefix, mirroring the product's `workflow-run:<id>` / `workflow-script:<id>` ids. */
const WF_DETAIL_RUN_KIND = 'workflow-run';
const WF_DETAIL_SCRIPT_KIND = 'workflow-script';

/** A live run refreshes its summary on this cadence. */
const WF_DETAIL_POLL_MS = 2000;
/** Event pages are pulled no faster than this, so a busy run stays one request per tick. */
const WF_DETAIL_EVENTS_MS = 1200;
/** How long a copy confirmation stays on screen. */
const WF_DETAIL_COPY_MS = 1500;
/** Stop asking for the artifact ledger at this cadence while the run publishes more. */
const WF_DETAIL_ARTIFACTS_MS = 6000;
/** Page size for the run list; one page covers the live-window runs. */
const WF_DETAIL_RUN_LIMIT = 40;

/** Sidebar services, captured once the profile provides them. */
const WF_DETAIL_SERVICES = { sidebar: undefined, tabs: undefined };

/**
 * The one target held when no Sidebar can host a pane.
 *
 * A static Client module cannot mount a panel on its own, so a profile without the right Sidebar
 * still shows the pane through `shell.overlay`; the pane component is shared.
 */
const WF_DETAIL_OVERLAY = (() => {
  let current;
  const listeners = new Set();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    read: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open(kind, params) {
      current = { kind, params };
      publish();
    },
    close() {
      if (current === undefined) return;
      current = undefined;
      publish();
    },
  };
})();

/** One locale string for this surface, with the embedded English fragment as fallback. */
function wfDetailSay(t, key, params) {
  return WF_UI.say(t, UI_EN, key, params);
}

/**
 * A stop/resume rejection, normalized to the copy the product shows for each reason code.
 * @returns {{ text: string, detail?: string }}
 */
function wfRunRejection(t, action, error) {
  const allowed = action === 'cancel'
    ? ['not_found', 'not_running', 'cancel_not_supported', 'unsupported', 'generic']
    : ['not_found', 'not_resumable', 'superseded', 'already_running', 'script_missing', 'script_mismatch', 'compile_failed', 'unsupported', 'generic'];
  const code = wfText(error?.code);
  const reason = code !== undefined && allowed.includes(code) ? code : 'generic';
  const key = `run.rejection.${action}.${reason}`;
  const detail = wfText(error?.message);
  return {
    text: wfDetailSay(t, key, { code: code ?? 'error' }),
    ...(detail === undefined || detail === '' ? {} : { detail }),
  };
}

/** A button that carries a `data-testid`; `WF_UI.Button` deliberately does not. */
function WfActionButton(props) {
  return WF_H('button', {
    type: 'button',
    className: ['zwf-btn', 'zwf-btn-sm', props.variant === 'subtle' ? 'zwf-btn-subtle' : 'zwf-btn-ghost', 'zwf-btn-iconic', props.className ?? ''].filter(Boolean).join(' '),
    'data-testid': props.testId,
    disabled: props.disabled === true,
    title: props.title,
    onClick: props.disabled === true ? undefined : props.onClick,
  },
  props.icon === undefined ? null : WF_H('span', { className: 'zwf-btn-glyph' }, props.icon),
  WF_H('span', { className: 'zwf-btn-label' }, props.children));
}

/** Peer view of the translate function so child parts can read the dictionary too. */
function useWfDetailSay(t) {
  return React.useCallback((key, params) => wfDetailSay(t, key, params), [t]);
}

/* -------------------------------- parameters ------------------------------- */

/** Narrow an opener's value to the run pane's navigation parameters. */
function wfDetailParams(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const runId = wfText(value.runId);
  if (runId === undefined) return undefined;
  const sessionId = wfText(value.sessionId);
  const projectRoot = wfText(value.projectRoot);
  const name = wfText(value.workflowName) ?? wfText(value.name);
  const focusPhaseId = wfText(value.focusPhaseId);
  return {
    runId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(name === undefined ? {} : { name }),
    ...(focusPhaseId === undefined ? {} : { focusPhaseId }),
  };
}

/** A tab record carries its opener parameters; the record omits them after a reload. */
function wfDetailTabParams(tab) {
  const navigation = tab?.navigation;
  if (navigation === null || typeof navigation !== 'object') return undefined;
  return wfDetailParams(navigation.params);
}

/** Whether the browser tab is visible; hidden surfaces issue no requests. */
function useWfVisible(forced) {
  const [visible, setVisible] = React.useState(() => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'));
  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return forced === false ? false : visible;
}

/* ------------------------------- run source -------------------------------- */

/**
 * One run's live record plus the event page it has not folded yet.
 *
 * The summary comes from the session run list (the Host derives stations and counters there); the
 * event log is pulled only after `lastEventSequence`, at a lower cadence, and only while the run
 * is active and the pane is visible.
 */
function useWfDetailRun(scope, options) {
  const { runId, sessionId, visible } = scope;
  const withEvents = options?.events === true;
  const usable = typeof runId === 'string' && typeof sessionId === 'string';
  const scopeKey = [sessionId ?? '', runId ?? ''].join('\u0000');
  const [state, setState] = React.useState({ scopeKey: '', run: undefined, error: undefined, loading: usable, events: [], watermark: undefined });
  const [revision, setRevision] = React.useState(0);
  const watermark = React.useRef(undefined);
  const lastEvents = React.useRef(0);
  React.useEffect(() => {
    if (!usable) {
      setState({ scopeKey, run: undefined, error: undefined, loading: false, events: [], watermark: undefined });
      return undefined;
    }
    if (!visible) return undefined;
    let cancelled = false;
    let timer;
    watermark.current = undefined;
    lastEvents.current = 0;
    setState((current) => (current.scopeKey === scopeKey
      ? { ...current, loading: true }
      : { scopeKey, run: undefined, error: undefined, loading: true, events: [], watermark: undefined }));
    const pullEvents = async (run) => {
      if (!withEvents || run === undefined) return;
      const sequence = wfNum(run.lastEventSequence);
      if (sequence === undefined || sequence <= (watermark.current ?? -1)) return;
      const now = Date.now();
      if (now - lastEvents.current < WF_DETAIL_EVENTS_MS) return;
      lastEvents.current = now;
      try {
        const page = await WF_API.runEvents({ sessionId, runId, afterSequence: watermark.current, limit: 200 });
        if (cancelled) return;
        const events = Array.isArray(page?.events) ? page.events : [];
        if (events.length === 0) {
          watermark.current = sequence;
          return;
        }
        watermark.current = events.reduce((max, event) => Math.max(max, wfNum(event.sequence) ?? 0), sequence);
        setState((current) => ({ ...current, events: current.events.concat(events).slice(-400), watermark: watermark.current }));
      } catch {
        // The summary remains authoritative; a failed page is retried on the next tick.
      }
    };
    const tick = async () => {
      let nextRun;
      let nextError;
      try {
        const payload = await WF_API.runs({ sessionId, limit: WF_DETAIL_RUN_LIMIT });
        const rows = Array.isArray(payload?.runs) ? payload.runs : [];
        nextRun = rows.find((row) => wfDetailRunId(row) === runId);
        if (nextRun === undefined) {
          nextError = new Error('run is not in the live run list');
          nextError.code = 'run-not-tracked';
        }
      } catch (error) {
        nextError = error;
      }
      if (cancelled) return;
      if (nextRun !== undefined) {
        setState((current) => (current.scopeKey === scopeKey
          ? { ...current, run: nextRun, error: undefined, loading: false, watermark: watermark.current }
          : { scopeKey, run: nextRun, error: undefined, loading: false, events: [], watermark: watermark.current }));
      } else setState((current) => ({ ...current, scopeKey, error: nextError, loading: false }));
      const active = nextRun !== undefined && wfDetailActive(nextRun);
      const stillLooking = nextRun === undefined && nextError !== undefined;
      if (!cancelled) await pullEvents(nextRun);
      if (!cancelled && visible && (active || stillLooking)) timer = setTimeout(tick, WF_DETAIL_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [scopeKey, runId, sessionId, usable, visible, withEvents, revision]);
  const reload = React.useCallback(() => setRevision((value) => value + 1), []);
  const replace = React.useCallback((run) => {
    if (run === undefined || run === null) return;
    setState((current) => ({ ...current, run, error: undefined, loading: false }));
  }, []);
  const current = state.scopeKey === scopeKey
    ? state
    : { scopeKey, run: undefined, error: undefined, loading: usable, events: [], watermark: undefined };
  return { run: current.run, error: current.error, loading: current.loading, events: current.events, watermark: current.watermark, reload, replace };
}

/**
 * The artifact ledger: the run record's own list when the Host carries it, otherwise one read of
 * `/run/artifacts`, refreshed at a slower cadence than the run summary.
 */
function useWfArtifacts(scope, run) {
  const inline = React.useMemo(() => wfDetailArtifacts(run), [run]);
  const signature = inline.map((artifact) => `${artifact.id}@${artifact.version}`).join(',');
  const [state, setState] = React.useState({ scopeKey: '', artifacts: [], error: undefined });
  const scopeKey = [scope.sessionId ?? '', scope.runId ?? '', signature, run?.status ?? ''].join('\u0000');
  const [revision, setRevision] = React.useState(0);
  const lastFetch = React.useRef(0);
  React.useEffect(() => {
    if (inline.length > 0 || typeof scope.runId !== 'string' || typeof scope.sessionId !== 'string') return undefined;
    const terminal = run !== undefined && wfRunIsTerminal(run);
    const now = Date.now();
    if (!terminal && now - lastFetch.current < WF_DETAIL_ARTIFACTS_MS) return undefined;
    lastFetch.current = now;
    let cancelled = false;
    WF_API.runArtifacts({ sessionId: scope.sessionId, runId: scope.runId }).then((payload) => {
      if (cancelled) return;
      setState({ scopeKey, artifacts: wfDetailArtifacts({ artifacts: payload?.artifacts }), error: undefined });
    }).catch((error) => {
      if (!cancelled) setState({ scopeKey, artifacts: [], error });
    });
    return () => { cancelled = true; };
  }, [scopeKey, scope.sessionId, scope.runId, inline.length, run?.status, revision]);
  const fetched = state.scopeKey === scopeKey || signature === '' ? state.artifacts : [];
  return {
    artifacts: inline.length > 0 ? inline : fetched,
    error: state.error,
    reload: () => setRevision((value) => value + 1),
  };
}

/* -------------------------------- chrome ----------------------------------- */

/** Status pill: dot, status word and, for a stopped run, why it stopped. */
function WfRunStatusPill(props) {
  const { run, t } = props;
  const status = wfDetailRunStatus(run);
  const tone = WF_UI.statusTone(status);
  const reason = status === 'stopped' ? wfText(run?.stopReason) : undefined;
  return WF_H('span', {
    className: `zwf-run-status zwf-run-status-${tone}`,
    'data-testid': 'workflow-run-status',
    'data-status': status,
  },
  WF_H('span', { className: `zwf-dot zwf-dot-${tone}` }),
  WF_H('span', { className: 'zwf-run-status-word' }, WF_UI.statusText(t, UI_EN, status)),
  reason === undefined
    ? null
    : WF_H('span', { className: 'zwf-run-status-reason', 'data-testid': 'workflow-run-stop-reason' },
      WF_UI.say(t, UI_EN, `run.stopReason.${['user', 'model', 'provider', 'interrupted', 'superseded'].includes(reason) ? reason : 'user'}`)));
}

/** One status-row chip. */
function WfStatusChip(props) {
  return WF_H('span', {
    className: `zwf-chip-inline${props.tone === undefined ? '' : ` zwf-chip-inline-${props.tone}`}`,
    'data-testid': props.testId,
    title: props.title,
  },
  props.icon === undefined ? null : WF_H('span', { className: 'zwf-chip-inline-glyph' }, props.icon),
  props.children);
}

/**
 * The status row: what the run is doing, how much of it is done, who is working, and every
 * deviation the ledger recorded (rejection, amend chain, supersession, truncated steps).
 */
function WfRunStatusRow(props) {
  const { run, t, stations, holes, rejection, onOpenSuccessor } = props;
  const say = (key, params) => wfDetailSay(t, key, params);
  const status = wfDetailRunStatus(run);
  const active = wfDetailActive(run);
  const steps = wfDetailSteps(run);
  const tokens = wfDetailTokens(run);
  const rounds = wfRunRounds(run, stations);
  const roster = wfRunRoster(run);
  const working = roster.filter((entry) => entry.status === 'running').length;
  const artifacts = wfDetailArtifacts(run).length;
  const model = wfText(run?.subagentModel);
  const concurrency = wfRunConcurrency(run);
  const amends = wfText(run?.resumedFrom);
  const supersededBy = wfText(run?.supersededBy);
  const truncated = run?.truncated === true && Array.isArray(run?.nodes) && run.nodes.length < steps.total;
  const parts = [];
  if (model !== undefined) parts.push({ key: 'model', node: WF_H(WfStatusChip, { key: 'model', testId: 'workflow-run-subagent-model' }, say('run.subagentModel.label', { model })) });
  parts.push({
    key: 'subagents',
    node: WF_H(WfStatusChip, {
      key: 'subagents',
      testId: 'workflow-run-subagents',
      icon: WF_H(WF_UI.icons.agent, { size: 12 }),
      title: say(model === undefined ? 'card.agents' : 'run.subagentModel.label', { count: roster.length, model }),
    }, active
      ? say(working === 1 ? 'card.agentWorking' : 'card.agentsWorking', { count: working })
      : say(roster.length === 1 ? 'card.agent' : 'card.agents', { count: Math.max(roster.length, roster.length) })),
  });
  parts.push({ key: 'steps', node: WF_H(WfStatusChip, { key: 'steps' }, say('card.steps', { done: steps.settled, total: steps.total })) });
  parts.push({ key: 'usage', node: WF_H(WfStatusChip, { key: 'usage', testId: 'workflow-run-usage', title: say('run.usage.label') }, say('run.usage.value', { tokens: wfGroup(tokens), steps: say('card.steps', { done: steps.settled, total: steps.total }) })) });
  if (rounds >= 2) parts.push({ key: 'rounds', node: WF_H(WfStatusChip, { key: 'rounds' }, say(active ? 'card.round' : 'card.rounds', { count: rounds })) });
  if (artifacts > 0) parts.push({ key: 'artifacts', node: WF_H(WfStatusChip, { key: 'artifacts' }, say(artifacts === 1 ? 'card.artifact' : 'card.artifacts', { count: artifacts })) });
  if (holes.length > 0) {
    parts.push({
      key: 'holes',
      node: WF_H(WfStatusChip, {
        key: 'holes',
        testId: 'workflow-run-holes',
        tone: 'warn',
        icon: WF_H(WF_UI.icons.spark, { size: 12 }),
      }, say(holes.length === 1 ? 'card.hole' : 'card.holes', { count: holes.length })),
    });
  }
  if (concurrency !== undefined) {
    parts.push({
      key: 'concurrency',
      node: WF_H(WfStatusChip, { key: 'concurrency', testId: 'workflow-run-concurrency' },
        say('run.concurrency.label', { cap: concurrency.cap }),
        concurrency.cooldownUntil === undefined
          ? null
          : ` · ${say('run.concurrency.cooldown', { time: WF_UI.date(concurrency.cooldownUntil) })}`),
    });
  }
  if (amends !== undefined) {
    parts.push({ key: 'amends', node: WF_H(WfStatusChip, { key: 'amends', testId: 'workflow-run-amends' }, `${say('run.amends')} ${amends}`) });
  }
  if (supersededBy !== undefined) {
    parts.push({
      key: 'superseded',
      node: WF_H('button', {
        key: 'superseded',
        type: 'button',
        className: 'zwf-chip-inline zwf-chip-inline-link',
        'data-testid': 'workflow-run-superseded-by',
        onClick: () => onOpenSuccessor?.(supersededBy),
      }, `${say('run.supersededBy')} ${supersededBy}`, WF_H(WF_UI.icons.external, { size: 11 })),
    });
  }
  if (truncated) {
    parts.push({ key: 'truncated', node: WF_H(WfStatusChip, { key: 'truncated', testId: 'workflow-run-truncated', tone: 'warn' }, say('run.truncated', { shown: run.nodes.length, total: steps.total })) });
  }
  return WF_H('div', { className: 'zwf-status-row', 'data-testid': 'workflow-run-status-row' },
    WF_H(WfRunStatusPill, { run, t }),
    parts.map((part, index) => WF_H(WF_FRAGMENT, { key: part.key },
      index === 0 ? null : WF_H('span', { className: 'zwf-status-sep', 'aria-hidden': 'true' }, '·'),
      part.node)),
    rejection === undefined
      ? null
      : WF_H('span', {
        className: 'zwf-status-rejection',
        'data-testid': 'workflow-run-rejection',
        role: 'status',
      },
      WF_H('span', { className: 'zwf-status-rejection-text' }, rejection.text),
      rejection.detail === undefined ? null : WF_H('pre', { className: 'zwf-status-rejection-detail' }, rejection.detail)));
}

/** Where the run came from: started by you, or amended from an earlier run, plus its arguments. */
function WfRunProvenance(props) {
  const { run, t, params } = props;
  const say = (key, value) => wfDetailSay(t, key, value);
  const scope = wfText(run?.scope) ?? wfText(params?.scope);
  const changed = wfText(run?.resumedFrom) !== undefined || run?.origin === 'settings';
  const args = run?.args;
  const entries = args !== null && typeof args === 'object' && Array.isArray(args) === false ? Object.entries(args) : [];
  const createdAt = wfNum(run?.createdAt);
  return WF_H('div', { className: 'zwf-provenance', 'data-testid': 'workflow-run-provenance' },
    WF_H('span', { className: 'zwf-provenance-text' },
      changed ? say('launch.settingsChangedByYou') : say('launch.startedByYou'),
      createdAt === undefined ? null : ` · ${WF_UI.date(createdAt)}`),
    scope === 'project' || scope === 'global'
      ? WF_H('span', { className: 'zwf-tag', 'data-testid': 'workflow-run-provenance-scope' }, say(`launch.scope.${scope}`))
      : null,
    entries.length === 0
      ? null
      : WF_H('dl', { className: 'zwf-provenance-args', 'data-testid': 'workflow-run-provenance-args' },
        entries.slice(0, 8).map(([key, value]) => WF_H(WF_FRAGMENT, { key },
          WF_H('dt', { className: 'zwf-mono' }, key),
          WF_H('dd', null, typeof value === 'string' ? value : WF_UI.json(value).replace(/\s+/gu, ' ').slice(0, 200))))),
    WF_H('span', {
      className: 'zwf-provenance-settings',
      'data-testid': 'workflow-run-provenance-settings',
      title: say('subagentModel.tooltip', { model: wfText(run?.subagentModel) ?? say('launch.settings.sessionModel') }),
    },
    wfText(run?.subagentModel) === undefined
      ? say('launch.settings.sessionModel')
      : say('launch.settings.model'),
    ` ${wfText(run?.subagentModel) ?? say('launch.settings.defaultLimitValue', { n: wfNum(run?.concurrency?.cap) ?? 1 })}`,
    wfNum(run?.concurrency?.cap) === undefined ? null : ` · ${say('launch.settings.limit')} ${run.concurrency.cap}`));
}

/** Result, error and untracked states: what the run left behind. */
function WfRunResultBlock(props) {
  const { run, t, rejection } = props;
  const say = (key, params) => wfDetailSay(t, key, params);
  if (run === undefined) {
    return WF_H('div', { className: 'zwf-result-block zwf-result-untracked', 'data-testid': 'workflow-run-untracked' },
      WF_H('p', { className: 'zwf-result-title' }, say('run.untracked.title')),
      WF_H('p', { className: 'zwf-result-body' }, say('run.untracked.body')));
  }
  const status = wfDetailRunStatus(run);
  if (status === 'errored') {
    const message = wfText(run?.error) ?? wfText(run?.failureMessage) ?? say('run.result.noError');
    return WF_H('div', { className: 'zwf-result-block zwf-result-error', 'data-testid': 'workflow-run-error' },
      WF_H('p', { className: 'zwf-result-title' }, say('run.result.erroredTitle')),
      WF_H('pre', { className: 'zwf-result-message', 'data-testid': 'workflow-run-error-message' }, message));
  }
  if (status === 'stopped') {
    const reason = wfText(run?.stopReason);
    return WF_H('div', { className: 'zwf-result-block', 'data-testid': 'workflow-run-result', 'data-result': 'stopped' },
      WF_H('p', { className: 'zwf-result-title' }, say('run.result.stoppedTitle')),
      reason === undefined ? null : WF_H('p', { className: 'zwf-result-body' }, say(`run.stopReason.${['user', 'model', 'provider', 'interrupted', 'superseded'].includes(reason) ? reason : 'user'}`)));
  }
  if (status !== 'completed') return null;
  const preview = wfText(run?.resultPreview) ?? wfText(run?.result);
  return WF_H('div', { className: 'zwf-result-block', 'data-testid': 'workflow-run-result', 'data-result': 'completed' },
    WF_H('p', { className: 'zwf-result-title' }, say('run.result.title')),
    WF_H('p', { className: 'zwf-result-body' }, say('run.result.completedHint')),
    preview === undefined ? null : WF_H('pre', { className: 'zwf-result-preview' }, preview),
    rejection === undefined ? null : WF_H('p', { className: 'zwf-result-body zwf-result-warn' }, rejection.text));
}

/** Health: last progress, concurrency, cached and failed steps, plus the leftover warning. */
function WfRunHealth(props) {
  const { run, t, stations } = props;
  const health = wfRunHealth(run, stations.length);
  if (health.items.length === 0) return null;
  return WF_H('div', { className: 'zwf-health', 'data-testid': 'workflow-run-health' },
    health.items.map((item, index) => WF_H(WF_FRAGMENT, { key: String(index) },
      index === 0 ? null : WF_H('span', { className: 'zwf-health-sep', 'aria-hidden': 'true' }, '·'),
      WF_H('span', { className: 'zwf-health-item' }, wfDetailSay(t, item.key, item.params)))),
    health.leftover > 0
      ? WF_H('p', { className: 'zwf-leftover', 'data-testid': 'workflow-run-leftover' },
        wfDetailSay(t, health.leftoverKey, { count: health.leftover }))
      : null);
}

/**
 * The configure popover: the subagent model and the concurrency bound for this run, the
 * consequence of changing either, and the apply control.
 */
function WfRunSettingsPopover(props) {
  const { run, t, open, onClose } = props;
  if (open !== true) return null;
  const say = (key, params) => wfDetailSay(t, key, params);
  const concurrency = wfRunConcurrency(run);
  const status = wfDetailRunStatus(run);
  const defaultBound = wfNum(props.defaultBound) ?? 4;
  const [bound, setBound] = React.useState(() => concurrency?.limit ?? concurrency?.cap ?? defaultBound);
  const [rejection, setRejection] = React.useState(undefined);
  const configure = props.onConfigure;
  const model = wfText(run?.subagentModel);
  const consequence = status === 'running'
    ? 'run.settings.consequence.running'
    : status === 'pending' ? 'run.settings.consequence.pending'
      : status === 'stopped' ? 'run.settings.consequence.stopped'
        : status === 'errored' ? 'run.settings.consequence.errored'
          : 'run.settings.consequence.running';
  const apply = async () => {
    setRejection(undefined);
    if (typeof configure === 'function') {
      const answer = await configure({ bound, model });
      if (answer !== undefined) setRejection(answer);
      return;
    }
    setRejection({ key: 'run.settings.rejection.unsupported' });
  };
  return WF_H('div', {
    className: 'zwf-settings-popover',
    'data-testid': 'workflow-run-settings-popover',
    role: 'dialog',
    'aria-label': say('run.settings.title'),
  },
  WF_H('div', { className: 'zwf-settings-head' },
    WF_H('span', { className: 'zwf-settings-title' }, say('run.settings.title')),
    WF_H(WF_UI.IconButton, {
      icon: WF_H(WF_UI.icons.close, { size: 13 }),
      label: say('ui.close'),
      onClick: onClose,
    })),
  WF_H('div', { className: 'zwf-settings-row', 'data-testid': 'workflow-retune-row' },
    WF_H('span', { className: 'zwf-settings-label' }, say('run.settings.model')),
    WF_H('div', { className: 'zwf-settings-model', 'data-testid': 'workflow-run-settings-model' },
      WF_H('button', {
        type: 'button',
        className: 'zwf-settings-trigger',
        'data-testid': 'workflow-run-settings-model-trigger',
        title: say('subagentModel.tooltip', { model: model ?? say('run.settings.model.session') }),
      },
      WF_H('span', { className: 'zwf-settings-model-name' }, model ?? say('run.settings.model.sessionFallback')),
      WF_H('span', { className: 'zwf-settings-model-badge', 'data-testid': 'workflow-run-settings-model-badge' },
        say('models.current'))),
      WF_H('p', { className: 'zwf-settings-note' }, say('run.settings.model.noCatalog')))),
  WF_H('div', { className: 'zwf-settings-row' },
    WF_H('span', { className: 'zwf-settings-label' }, say('run.settings.limit')),
    WF_H('div', { className: 'zwf-settings-bound', 'data-testid': 'workflow-run-settings-bound' },
      WF_H('button', {
        type: 'button',
        className: 'zwf-settings-step',
        'data-testid': 'workflow-run-settings-bound-decrease',
        'aria-label': say('run.settings.limit.decrease'),
        disabled: bound <= 1,
        onClick: () => setBound((value) => Math.max(1, value - 1)),
      }, '−'),
      WF_H('span', { className: 'zwf-settings-bound-value zwf-mono', 'data-testid': 'workflow-run-settings-bound-value' }, String(bound)),
      WF_H('button', {
        type: 'button',
        className: 'zwf-settings-step',
        'data-testid': 'workflow-run-settings-bound-increase',
        'aria-label': say('run.settings.limit.increase'),
        disabled: bound >= 32,
        onClick: () => setBound((value) => Math.min(32, value + 1)),
      }, '+'),
      WF_H('span', { className: 'zwf-settings-default' },
        say(bound === defaultBound ? 'run.settings.limit.atDefault' : 'run.settings.limit.default', { n: defaultBound })))),
  WF_H('p', { className: 'zwf-settings-consequence', 'data-testid': 'workflow-run-settings-consequence' }, say(consequence)),
  rejection === undefined
    ? null
    : WF_H('p', { className: 'zwf-settings-rejection', 'data-testid': 'workflow-run-settings-rejection', role: 'status' },
      say(rejection.key, rejection.params)),
  WF_H('div', { className: 'zwf-settings-foot' },
    WF_H(WF_UI.Button, { variant: 'subtle', size: 'sm', onClick: onClose }, say('ui.close')),
    WF_H('button', {
      type: 'button',
      className: 'zwf-btn zwf-btn-primary zwf-btn-sm',
      'data-testid': 'workflow-run-settings-apply',
      onClick: () => { void apply(); },
    }, WF_H('span', { className: 'zwf-btn-label' }, say('run.settings.apply')))));
}

/* ---------------------------------- pane ----------------------------------- */

/**
 * The run pane: chrome, live record, and the body that renders the timeline, the phase list and
 * the artifacts area. An empty `run` is a tracked-absent state, not an error.
 *
 * @param {{ t: Function, params?: object, visible?: boolean }} props
 */
function WfDetailPane(props) {
  const { t, params } = props;
  const say = useWfDetailSay(t);
  const visible = useWfVisible(props.visible);
  const runId = params?.runId;
  const scope = React.useMemo(() => ({ runId, sessionId: params?.sessionId, visible }), [runId, params?.sessionId, visible]);
  const state = useWfDetailRun(scope, { events: true });
  const workspaceScope = React.useMemo(() => ({ sessionId: params?.sessionId, runId }), [params?.sessionId, runId]);
  const workspace = useWfWorkspace(workspaceScope, 0);
  const run = state.run;
  const artifacts = useWfArtifacts(scope, run);
  const now = useWfClock();
  const [copied, flash] = React.useState('');
  const copyTimer = React.useRef(undefined);
  React.useEffect(() => () => {
    if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
  }, []);
  const copy = (value, token) => {
    const done = () => {
      flash(token);
      if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => flash(''), WF_DETAIL_COPY_MS);
    };
    try {
      void navigator.clipboard?.writeText(value).then(done).catch(done);
    } catch {
      done();
    }
  };
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [artifactsOpen, setArtifactsOpen] = React.useState(true);
  const [expanded, setExpanded] = React.useState(() => new Set());
  const [doors, setDoors] = React.useState(() => new Set());
  const [actorEntry, setActorEntry] = React.useState(undefined);
  const [landed, setLanded] = React.useState(undefined);
  const [rejection, setRejection] = React.useState(undefined);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    setSettingsOpen(false);
    setArtifactsOpen(true);
    setExpanded(new Set());
    setDoors(new Set());
    setActorEntry(undefined);
    setLanded(undefined);
    setRejection(undefined);
  }, [runId]);
  const stations = React.useMemo(() => wfDetailStations(run), [run]);
  const holes = React.useMemo(() => wfDetailHoles(run), [run]);
  const roster = React.useMemo(() => wfRunRoster(run), [run]);
  const questions = React.useMemo(() => wfRunQuestions(run), [run]);
  const ownership = React.useMemo(() => wfQuestionOwners(questions, roster), [questions, roster]);
  const rosters = React.useMemo(() => {
    const map = new Map();
    for (const station of stations) map.set(station.name, wfStationRoster(run, station, roster, run?.unlistedByPhase));
    return map;
  }, [stations, roster, run]);
  const rosterByPhase = React.useMemo(() => {
    const map = new Map();
    for (const station of stations) map.set(station.name, (rosters.get(station.name)?.pins ?? []).concat(rosters.get(station.name)?.rest ?? []));
    return map;
  }, [stations, rosters]);
  // Running (and hole-waiting) phases start open, and follow the run as it advances.
  const runningNames = stations.filter((station) => station.status === 'running' || station.hole === 'waiting').map((station) => station.name).join('\u0000');
  React.useEffect(() => {
    if (runningNames === '') return;
    setExpanded((current) => {
      const next = new Set(current);
      for (const name of runningNames.split('\u0000')) next.add(name);
      return next;
    });
  }, [runningNames]);
  const scriptPhases = React.useMemo(() => new Set(workspace.nodes.map((node) => node.phaseName).filter(Boolean)), [workspace.nodes]);
  const focus = params?.focusPhaseId === undefined
    ? undefined
    : stations.findIndex((station) => wfPhaseMatches(station.name, params.focusPhaseId));
  const togglePhase = (name) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const toggleDoor = (name) => {
    setDoors((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const openStation = (station) => {
    setExpanded((current) => {
      const next = new Set(current);
      next.add(station.name);
      return next;
    });
    setLanded(station.name);
  };
  const openActor = (entry) => {
    setActorEntry((current) => (current?.key === entry.key ? undefined : entry));
  };
  const openScript = () => {
    WF_DETAIL.openScript({
      runId,
      sessionId: params?.sessionId,
      projectRoot: params?.projectRoot,
      workflowName: wfDetailRunName(run, params),
      focusPhaseId: params?.focusPhaseId,
    });
  };
  const openSuccessor = (nextId) => {
    WF_DETAIL.open({
      runId: nextId,
      sessionId: params?.sessionId,
      projectRoot: params?.projectRoot,
    });
  };
  const stop = async () => {
    if (busy || runId === undefined) return;
    setBusy(true);
    setRejection(undefined);
    try {
      const payload = await WF_API.stopRun({ runId, sessionId: params?.sessionId, projectRoot: params?.projectRoot });
      const next = payload !== null && typeof payload === 'object' ? payload.run : undefined;
      if (next !== undefined) state.replace(next);
      state.reload();
    } catch (error) {
      setRejection(wfRunRejection(t, 'cancel', error));
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    if (busy || runId === undefined) return;
    setBusy(true);
    setRejection(undefined);
    try {
      const payload = await WF_API.resumeRun({ runId, sessionId: params?.sessionId, projectRoot: params?.projectRoot });
      const next = payload !== null && typeof payload === 'object' ? payload.run : undefined;
      if (next !== undefined) state.replace(next);
      state.reload();
    } catch (error) {
      setRejection(wfRunRejection(t, 'resume', error));
    } finally {
      setBusy(false);
    }
  };
  const status = wfDetailRunStatus(run);
  const title = wfDetailRunName(run, params) ?? say('pane.run');
  const cancellable = status === 'running';
  const resumable = run?.resumable === true && status === 'stopped';
  const configurable = run !== undefined && status !== 'completed';
  if (runId === undefined) {
    return WF_H('div', { className: 'zwf-run' },
      WF_H('header', { className: 'zwf-run-head' },
        WF_H('div', { className: 'zwf-run-headline' },
          WF_H('h2', { className: 'zwf-run-title' }, say('pane.run')))),
      WF_H('div', { className: 'zwf-run-body' },
        WF_H(WF_UI.EmptyState, {
          icon: WF_H(WF_UI.icons.run, { size: 20 }),
          title: say('run.result.title'),
          body: say('run.graph.unavailable'),
        })));
  }
  return WF_H('div', {
    className: 'zwf-run',
    'data-testid': 'workflow-run',
    'data-workflow-run-id': runId,
    'data-workflow-run-status': run === undefined ? 'absent' : status,
  },
  WF_H('header', { className: 'zwf-run-head' },
    WF_H('div', { className: 'zwf-run-headline' },
      WF_H('h2', { className: 'zwf-run-title', title }, title),
      WF_H('div', { className: 'zwf-run-actions' },
        WF_H(WfActionButton, {
          variant: 'subtle',
          icon: WF_H(WF_UI.icons.more, { size: 13 }),
          onClick: () => setSettingsOpen((value) => !value),
          disabled: configurable !== true,
          testId: 'workflow-run-configure',
          title: configurable === true ? say('run.configure') : say('run.settings.rejection.not_configurable'),
        }, say('run.configure')),
        resumable
          ? WF_H(WfActionButton, {
            variant: 'subtle',
            icon: WF_H(WF_UI.icons.refresh, { size: 13 }),
            title: say('run.resumeHint'),
            testId: 'workflow-run-resume',
            onClick: () => { void resume(); },
          }, say('run.resume'))
          : null,
        WF_H(WfActionButton, {
          variant: 'subtle',
          icon: WF_H(WF_UI.icons.log, { size: 13 }),
          title: say('script.title'),
          testId: 'workflow-run-workspace-open',
          onClick: openScript,
        }, say('script.title')),
        typeof WF_SAVE === 'object' && WF_SAVE !== null && WF_SAVE.Slot !== undefined
          ? WF_H(WF_SAVE.Slot, {
            key: 'save',
            sessionId: params?.sessionId,
            runId,
            projectRoot: params?.projectRoot,
            run,
            t,
          })
          : null,
        WF_H(WfActionButton, {
          variant: 'subtle',
          icon: WF_H(WF_UI.icons.stop, { size: 12 }),
          disabled: cancellable !== true || busy,
          title: cancellable === true ? say('run.stopHint') : say('run.cancelDisabled'),
          testId: 'workflow-run-cancel',
          className: 'zwf-run-stop',
          onClick: () => { void stop(); },
        }, busy ? say('run.cancelling') : say('run.cancel')))),
    WF_H(WfRunStatusRow, {
      run,
      t,
      stations,
      holes,
      rejection,
      onOpenSuccessor: openSuccessor,
    }),
    WF_H(WfRunHealth, { run, t, stations }),
    run === undefined
      ? null
      : WF_H('div', { className: 'zwf-run-idline' },
        WF_H('span', { className: 'zwf-run-id zwf-mono', 'data-testid': 'workflow-run-id' }, runId),
        WF_H('button', {
          type: 'button',
          className: 'zwf-link',
          title: say('ui.copyRunId'),
          onClick: () => copy(runId, 'runId'),
        }, copied === 'runId' ? say('ui.copied') : say('ui.copy')))),
  WF_H(WfRunSettingsPopover, {
    run,
    t,
    open: settingsOpen,
    onClose: () => setSettingsOpen(false),
  }),
  WF_H('div', { className: 'zwf-run-body' },
    WF_H(WfRunResultBlock, { run, t, rejection }),
    run === undefined
      ? null
      : WF_H(WF_FRAGMENT, null,
        stations.length > 0
          ? WF_H(WfTimeline, {
            stations,
            roster: rosterByPhase,
            t,
            focus,
            scriptPhases,
            counts: new Map(stations.map((station) => [station.name, rosters.get(station.name)?.counts ?? {}])),
            fractions: new Map(stations.map((station) => [station.name, rosters.get(station.name)?.fraction ?? { settled: 0, observed: 0 }])),
            rounds: new Map(stations.map((station) => [station.name, rosters.get(station.name)?.rounds])),
            onOpenEntry: openActor,
            onOpenStation: openStation,
            onOpenScript: openScript,
          })
          : null,
        WF_H(WfRunPhaseList, {
          run,
          stations,
          t,
          rosters,
          roster,
          holes,
          fills: holes,
          questions: ownership.owned,
          orphans: ownership.orphans,
          expanded,
          doors,
          now,
          landed,
          onToggle: togglePhase,
          onDoor: toggleDoor,
          onOpenEntry: openActor,
        }),
        actorEntry === undefined
          ? null
          : WF_H('div', { className: 'zwf-actor-wrap' },
            WF_H(WfActorLedger, { entry: actorEntry, t })),
        run?.health?.pendingQuestionsKnown === false
          ? WF_H('p', { className: 'zwf-questions-unknown', 'data-testid': 'workflow-run-questions-unknown' }, say('getRun.questionsUnknown'))
          : null,
        WF_H(WfArtifactsSection, {
          artifacts: artifacts.artifacts,
          t,
          scope: workspaceScope,
          open: artifactsOpen,
          onToggle: () => setArtifactsOpen((value) => !value),
        }),
        artifacts.error === undefined || artifacts.artifacts.length > 0
          ? null
          : WF_H('p', { className: 'zwf-caption' }, say('run.artifacts.unavailable')))));
}


/* ---------------------------------- seats ---------------------------------- */

/** The run pane as a right-Sidebar tab. */
function WfDetailTab(props) {
  const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined;
  const tab = info === undefined ? undefined : info.tab;
  return WF_H(WfDetailPane, {
    t: props.t,
    params: wfDetailTabParams(tab),
    visible: tab === undefined || tab.visible !== false,
  });
}

/** The run pane's tab title: the workflow name, else the pane's own name. */
function WfDetailTabTitle(props) {
  const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined;
  const params = wfDetailTabParams(info === undefined ? undefined : info.tab);
  const name = params === undefined || params.name === undefined ? wfDetailSay(props.t, 'pane.run') : params.name;
  return WF_H('span', { className: 'zwf-run-tab-title' },
    WF_H('span', { className: 'zwf-run-tab-glyph' }, WF_H(WF_UI.icons.run, { size: 14 })),
    WF_H('span', { className: 'zwf-run-tab-text', title: name }, name));
}

/** The script-steps pane as a right-Sidebar tab. */
function WfScriptTab(props) {
  const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined;
  const tab = info === undefined ? undefined : info.tab;
  const params = props.params ?? wfDetailTabParams(tab);
  const visible = useWfVisible(tab === undefined || tab.visible !== false);
  const scope = React.useMemo(() => ({
    runId: params?.runId,
    sessionId: params?.sessionId,
    visible,
  }), [params?.runId, params?.sessionId, visible]);
  const state = useWfDetailRun(scope, { events: false });
  return WF_H(WfWorkspacePane, { t: props.t, params, run: state.run, scope, visible });
}

/** The script pane's tab title: the workflow name, else the pane's own name. */
function WfScriptTabTitle(props) {
  const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined;
  const params = wfDetailTabParams(info === undefined ? undefined : info.tab);
  const name = params === undefined || params.name === undefined ? wfDetailSay(props.t, 'pane.script') : params.name;
  return WF_H('span', { className: 'zwf-run-tab-title' },
    WF_H('span', { className: 'zwf-run-tab-glyph' }, WF_H(WF_UI.icons.log, { size: 14 })),
    WF_H('span', { className: 'zwf-run-tab-text', title: name }, name));
}

/** The no-Sidebar fallback for both panes: the same component, centered in the shell overlay. */
function WfDetailOverlay(props) {
  const target = useWfDetailOverlay();
  if (target === undefined) return null;
  const say = (key, params) => wfDetailSay(props.t, key, params);
  const script = target.kind === 'script';
  return WF_H(WF_UI.Modal, {
    open: true,
    wide: true,
    title: say(script ? 'pane.script' : 'pane.run'),
    closeLabel: say('ui.close'),
    onClose: () => WF_DETAIL_OVERLAY.close(),
  },
  WF_H('div', { className: 'zwf-run-overlay' },
    script
      ? WF_H(WfScriptTabContent, { t: props.t, params: target.params })
      : WF_H(WfDetailPane, { t: props.t, params: target.params, visible: true })));
}

/** Overlay host for the script pane: it needs the run record, so it wraps the tab body. */
function WfScriptTabContent(props) {
  return WF_H(WfScriptTab, { t: props.t, useTabInfo: () => undefined, params: props.params });
}

/** The overlay store's current target, subscribing to changes. */
function useWfDetailOverlay() {
  const [value, setValue] = React.useState(WF_DETAIL_OVERLAY.read);
  React.useEffect(() => WF_DETAIL_OVERLAY.subscribe(() => setValue(WF_DETAIL_OVERLAY.read())), []);
  return value;
}

/* -------------------------------- registration ----------------------------- */

/**
 * Register both pane types, their titles, the overlay fallbacks and the tab types.
 *
 * @param {object} ctx Client root carrying slots, locale and the Sidebar services.
 * @param {(callback: Function, label: string) => unknown} effect Owner-scoped effect runner.
 */
WF_DETAIL.register = function register(ctx, effect) {
  if (ctx === null || typeof ctx !== 'object') return;
  const runEffect = typeof effect === 'function' ? effect : (callback) => callback();
  const t = ctx.locale !== undefined && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(UI_NS) : undefined;
  const slots = ctx.slots;
  if (slots !== undefined && typeof slots.inject === 'function' && typeof slots.register === 'function') {
    slots.inject('sidebar.right.pane.tab', () => slots.register({
      name: 'sidebar.right.pane.tab',
      key: WF_DETAIL_RUN_ID,
      locale: UI_NS,
    }, WfDetailTab));
    slots.inject('sidebar.right.pane.tab', () => slots.register({
      name: 'sidebar.right.pane.tab',
      key: WF_DETAIL_SCRIPT_ID,
      locale: UI_NS,
    }, WfScriptTab));
    slots.inject('sidebar.right.pane.tab.title', () => slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: WF_DETAIL_RUN_ID,
      locale: UI_NS,
    }, WfDetailTabTitle));
    slots.inject('sidebar.right.pane.tab.title', () => slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: WF_DETAIL_SCRIPT_ID,
      locale: UI_NS,
    }, WfScriptTabTitle));
    slots.inject('shell.overlay', () => slots.register({
      name: 'shell.overlay',
      id: WF_DETAIL_RUN_ID,
      locale: UI_NS,
    }, WfDetailOverlay));
  }
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (child) => {
    const sidebar = child.sidebarRight;
    const tabs = child.sidebarRightTabs;
    if (sidebar !== undefined && typeof sidebar.openTab === 'function') WF_DETAIL_SERVICES.sidebar = sidebar;
    if (tabs === undefined || typeof tabs.register !== 'function') return;
    WF_DETAIL_SERVICES.tabs = tabs;
    runEffect(() => tabs.register({
      id: WF_DETAIL_RUN_ID,
      kind: WF_DETAIL_RUN_KIND,
      priority: 'extension',
      title: () => wfDetailSay(t, 'pane.run'),
    }), 'zcode-workflow: run detail tab type');
    runEffect(() => tabs.register({
      id: WF_DETAIL_SCRIPT_ID,
      kind: WF_DETAIL_SCRIPT_KIND,
      priority: 'extension',
      title: () => wfDetailSay(t, 'pane.script'),
    }), 'zcode-workflow: script steps tab type');
  });
};

/**
 * Open one run's detail in the right Sidebar; without a Sidebar (or with no session surface
 * mounted) the same pane opens through the shell overlay instead.
 *
 * @param {{ runId: string, sessionId?: string, projectRoot?: string, workflowName?: string, name?: string,
 *   focusPhaseId?: string }} value
 * @returns {boolean} whether a surface accepted the request.
 */
WF_DETAIL.open = function open(value) {
  const params = wfDetailParams(value);
  if (params === undefined) return false;
  const sidebar = WF_DETAIL_SERVICES.sidebar;
  if (sidebar !== undefined && typeof sidebar.openTab === 'function') {
    try {
      sidebar.openTab(WF_DETAIL_RUN_KIND, { params });
      WF_DETAIL_OVERLAY.close();
      return true;
    } catch (error) {
      console.warn('zcode-workflow: cannot open the run detail in the right sidebar', error);
    }
  }
  WF_DETAIL_OVERLAY.open('run', params);
  return true;
};

/**
 * Open the script-steps pane of one run, optionally focused on a phase.
 * @param {{ runId: string, sessionId?: string, projectRoot?: string, workflowName?: string, focusPhaseId?: string }} value
 * @returns {boolean} whether a surface accepted the request.
 */
WF_DETAIL.openScript = function openScript(value) {
  const params = wfDetailParams({ ...value, focusPhaseId: value?.focusPhaseId });
  if (params === undefined) return false;
  const sidebar = WF_DETAIL_SERVICES.sidebar;
  if (sidebar !== undefined && typeof sidebar.openTab === 'function') {
    try {
      sidebar.openTab(WF_DETAIL_SCRIPT_KIND, { params });
      WF_DETAIL_OVERLAY.close();
      return true;
    } catch (error) {
      console.warn('zcode-workflow: cannot open the script steps in the right sidebar', error);
    }
  }
  WF_DETAIL_OVERLAY.open('script', params);
  return true;
};
