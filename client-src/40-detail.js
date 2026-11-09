/* Right-Sidebar workflow run detail. */

/** Registered by `register` and used by other parts to open one run. */
const WF_DETAIL = {};

/** Tab type identity: the registry id and the key both Sidebar seats render under. */
const WF_DETAIL_ID = 'zcode-workflow/run';
/** The page kind callers pass to `ctx.sidebarRight.openTab`. */
const WF_DETAIL_KIND = 'zcode-workflow/run';
/** A visible run in flight refreshes on this cadence. */
const WF_DETAIL_POLL_MS = 2000;
/** How long a copy confirmation stays on screen. */
const WF_DETAIL_COPY_MS = 1500;
/** Longest artifact text one preview keeps before the tail is cut. */
const WF_DETAIL_PREVIEW_CHARS = 400000;

/** Sidebar services, captured once the profile provides them. */
const WF_DETAIL_SERVICES = { sidebar: undefined };

/**
 * The one detail target held when no sidebar can host it.
 *
 * A static Client module cannot mount a panel on its own, so a profile without the right
 * Sidebar still shows the detail through `shell.overlay`; the pane component is shared.
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
    open(params) {
      current = params;
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

/** Pick a `…One` variant when the count is exactly one and the fragment carries one. */
function wfDetailCountSay(t, key, count, params) {
  const oneKey = `${key}One`;
  const useOne = count === 1 && Object.prototype.hasOwnProperty.call(UI_EN, oneKey);
  return wfDetailSay(t, useOne ? oneKey : key, { ...(params ?? {}), count });
}

/* ---------------------------------- readers -------------------------------- */

/** Narrow an opener's value to this tab's navigation parameters. */
function wfDetailParams(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const runId = typeof value.runId === 'string' && value.runId !== '' ? value.runId : undefined;
  if (runId === undefined) return undefined;
  const sessionId = typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : undefined;
  const projectRoot = typeof value.projectRoot === 'string' && value.projectRoot !== '' ? value.projectRoot : undefined;
  if (sessionId === undefined && projectRoot === undefined) return undefined;
  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim() : undefined;
  return {
    runId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(name === undefined ? {} : { name }),
  };
}

/** The opener's parameters from a tab record; the record omits them after a reload. */
function wfDetailTabParams(tab) {
  const navigation = tab?.navigation;
  if (navigation === null || typeof navigation !== 'object') return undefined;
  return wfDetailParams(navigation.params);
}

const WF_DETAIL_STATUSES = ['pending', 'running', 'completed', 'errored', 'stopped', 'superseded'];

/** Unknown or missing status words keep a neutral label instead of leaking a wire value. */
function wfDetailStatusWord(t, status) {
  const key = WF_DETAIL_STATUSES.includes(status) ? `detail.status.${status}` : 'detail.status.unknown';
  return wfDetailSay(t, key);
}

function wfDetailIsTerminal(status) {
  return status === 'completed' || status === 'errored' || status === 'stopped' || status === 'superseded';
}

function wfDetailCanStop(status) {
  return status === 'pending' || status === 'running';
}

const WF_DETAIL_STOP_REASONS = ['user', 'model', 'provider', 'interrupted', 'superseded'];

function wfDetailStopReasonLabel(t, reason) {
  const key = WF_DETAIL_STOP_REASONS.includes(reason) ? `detail.stopReason.${reason}` : 'detail.stopReason.other';
  return wfDetailSay(t, key);
}

const WF_DETAIL_ARTIFACT_KINDS = ['file', 'markdown', 'chart', 'table', 'metrics', 'board'];

function wfDetailArtifactKind(t, kind) {
  return wfDetailSay(t, WF_DETAIL_ARTIFACT_KINDS.includes(kind) ? `detail.artifact.kind.${kind}` : 'detail.artifact.kind.file');
}

/** Minute-level relative copy for the subagent rows; the pane re-renders on the shared clock. */
function wfDetailRelative(t, timestamp, now) {
  const value = Number(timestamp);
  const current = Number(now);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(current)) return '';
  const diff = Math.max(0, current - value);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return wfDetailSay(t, 'detail.relative.justNow');
  if (minutes < 60) return wfDetailSay(t, 'detail.relative.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return wfDetailSay(t, 'detail.relative.hoursAgo', { count: hours });
  return wfDetailSay(t, 'detail.relative.daysAgo', { count: Math.floor(hours / 24) });
}

/** Compact elapsed copy in the surface's own units, with no dependency on another part's keys. */
function wfDetailDuration(t, from, to) {
  const start = Number(from);
  const end = Number(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return wfDetailSay(t, 'detail.duration.seconds', { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return wfDetailSay(t, 'detail.duration.minutes', { minutes, seconds: seconds % 60 });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return wfDetailSay(t, 'detail.duration.hours', { hours, minutes: minutes % 60 });
  return wfDetailSay(t, 'detail.duration.days', { days: Math.floor(hours / 24), hours: hours % 24 });
}

function wfDetailClock(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  try {
    return new Date(value).toLocaleTimeString();
  } catch {
    return '';
  }
}

function wfDetailJsonText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return WF_UI.json(value);
}

function wfDetailArgText(value) {
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}

function wfDetailArgsText(args) {
  if (args === undefined) return '';
  if (!Array.isArray(args)) return wfDetailArgText(args);
  return args.map(wfDetailArgText).join(' ');
}

const WF_DETAIL_TEXTUAL = /^(?:text\/|application\/json$)/u;

function wfDetailIsTextual(contentType) {
  return typeof contentType === 'string' && WF_DETAIL_TEXTUAL.test(contentType);
}

function wfDetailIsImage(contentType) {
  return typeof contentType === 'string' && contentType.startsWith('image/');
}

/** Group the manifest rows by artifact id and keep the newest version's row. */
function wfDetailArtifacts(run) {
  const rows = Array.isArray(run?.artifacts) ? run.artifacts : [];
  const byId = new Map();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    if (typeof row.id !== 'string' || row.id === '') continue;
    const list = byId.get(row.id);
    if (list === undefined) byId.set(row.id, [row]);
    else list.push(row);
  }
  const groups = [];
  for (const [id, list] of byId) {
    const ordered = [...list].sort((left, right) => Number(left.version ?? 0) - Number(right.version ?? 0));
    groups.push({ id, row: ordered[ordered.length - 1], versions: ordered.length });
  }
  return groups;
}

/** Workflow arguments travel only when a Host exposes them; nothing is composed in the client. */
function wfDetailRunArgs(run) {
  const args = run?.args;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return Object.keys(args).length === 0 ? undefined : args;
}

/**
 * One copyable JSON block of the run's parameters.
 *
 * Workflow arguments keep their own names because the script author chose them; the engine
 * facts the Host always records use product labels instead of wire field names.
 */
function wfDetailRunParams(run, say) {
  if (run === undefined) return undefined;
  const params = {};
  const args = wfDetailRunArgs(run);
  if (args !== undefined) {
    for (const [key, value] of Object.entries(args)) params[key] = value;
  }
  if (typeof run.cwd === 'string' && run.cwd !== '') params[say('detail.cwd')] = run.cwd;
  if (typeof run.scriptPath === 'string' && run.scriptPath !== '') params[say('detail.scriptTitle')] = run.scriptPath;
  const cap = Number(run.maxConcurrency);
  if (Number.isFinite(cap) && cap > 0) params[say('detail.config.maxConcurrency')] = cap;
  if (typeof run.subagentModel === 'string' && run.subagentModel !== '') params[say('detail.config.model')] = run.subagentModel;
  if (typeof run.resumedFrom === 'string' && run.resumedFrom !== '') params[say('detail.resumedFrom')] = run.resumedFrom;
  return Object.keys(params).length === 0 ? undefined : params;
}

async function wfDetailCopy(text) {
  if (typeof text !== 'string' || text === '') return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/* ----------------------------------- hooks --------------------------------- */

function useWfDetailOverlay() {
  const [value, setValue] = React.useState(WF_DETAIL_OVERLAY.read);
  React.useEffect(() => WF_DETAIL_OVERLAY.subscribe(() => setValue(WF_DETAIL_OVERLAY.read())), []);
  return value;
}

/** A short-lived confirmation token shared by every copy control in the pane. */
function useWfDetailCopy() {
  const [token, setToken] = React.useState('');
  const timer = React.useRef(undefined);
  React.useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
  }, []);
  const flash = React.useCallback((next) => {
    setToken(next);
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToken(''), WF_DETAIL_COPY_MS);
  }, []);
  return [token, flash];
}

/**
 * Read one run snapshot, polling only while the tab is visible and the run is in flight.
 *
 * The first read seeds the header before any action is available; terminal states stop the
 * cadence and keep the snapshot until a manual refresh. A hidden tab issues no requests.
 */
function useWfDetailRun(scope) {
  const { runId, sessionId, projectRoot, visible } = scope;
  const usable = runId !== undefined && (sessionId !== undefined || projectRoot !== undefined);
  const scopeKey = [sessionId ?? '', projectRoot ?? '', runId ?? ''].join('\u0000');
  const [state, setState] = React.useState({ scopeKey: '', run: undefined, error: undefined, loading: usable });
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    if (!usable) {
      setState({ scopeKey, run: undefined, error: undefined, loading: false });
      return undefined;
    }
    if (!visible) {
      setState((current) => (current.scopeKey === scopeKey
        ? current
        : { scopeKey, run: undefined, error: undefined, loading: true }));
      return undefined;
    }
    let cancelled = false;
    let timer;
    setState((current) => (current.scopeKey === scopeKey
      ? { ...current, loading: true }
      : { scopeKey, run: undefined, error: undefined, loading: true }));
    const tick = async () => {
      let nextRun;
      let nextError;
      try {
        const payload = await WF_API.run({ sessionId, projectRoot, runId });
        nextRun = payload !== null && typeof payload === 'object' ? payload.run : undefined;
        if (nextRun === undefined) {
          nextError = new Error('run snapshot is missing');
          nextError.code = 'run-not-found';
        }
      } catch (error) {
        nextError = error;
      }
      if (cancelled) return;
      if (nextRun !== undefined) setState({ scopeKey, run: nextRun, error: undefined, loading: false });
      else setState((current) => ({ ...current, scopeKey, error: nextError, loading: false }));
      const missing = nextError !== undefined && (nextError.status === 404 || nextError.code === 'run-not-found');
      const terminal = nextRun !== undefined && wfDetailIsTerminal(nextRun.status);
      // A network failure retries, a missing run does not, and the cadence follows the status
      // the last answer carried rather than the status this render started from.
      const continues = nextRun === undefined ? nextError !== undefined : !terminal;
      if (!cancelled && visible && continues && !missing) timer = setTimeout(tick, WF_DETAIL_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runId, sessionId, projectRoot, usable, visible, revision]);
  const reload = React.useCallback(() => setRevision((value) => value + 1), []);
  const replace = React.useCallback((run) => {
    if (run === undefined || run === null) return;
    setState((current) => ({ ...current, run, error: undefined, loading: false }));
  }, []);
  const current = state.scopeKey === scopeKey
    ? state
    : { scopeKey, run: undefined, error: undefined, loading: usable };
  return { run: current.run, error: current.error, loading: current.loading, reload, replace };
}

/** Load the payload behind the artifact preview modal; images use their byte URL directly. */
function useWfDetailArtifact(scope, target) {
  const id = target === undefined ? undefined : target.id;
  const version = target === undefined ? undefined : target.version;
  const contentType = target !== undefined && typeof target.contentType === 'string' ? target.contentType : '';
  const image = target !== undefined && wfDetailIsImage(contentType);
  const textual = target !== undefined && wfDetailIsTextual(contentType);
  const [state, setState] = React.useState({ kind: 'idle', text: undefined, error: undefined });
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    if (target === undefined) {
      setState({ kind: 'idle' });
      return undefined;
    }
    if (image) {
      setState({ kind: 'image' });
      return undefined;
    }
    if (!textual) {
      setState({ kind: 'unsupported' });
      return undefined;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    WF_API.artifact({
      sessionId: scope.sessionId,
      projectRoot: scope.projectRoot,
      runId: scope.runId,
      artifactId: id,
      version,
    }).then((payload) => {
      if (cancelled) return;
      const text = payload !== null && typeof payload === 'object' && typeof payload.text === 'string'
        ? payload.text
        : wfDetailJsonText(payload === null || typeof payload !== 'object' ? payload : payload.text);
      setState({ kind: 'text', text });
    }).catch((error) => {
      if (!cancelled) setState({ kind: 'error', error });
    });
    return () => {
      cancelled = true;
    };
  }, [id, version, contentType, image, textual, scope.runId, scope.sessionId, scope.projectRoot, revision]);
  const reload = React.useCallback(() => setRevision((value) => value + 1), []);
  const url = image
    ? WF_API.artifactUrl({ sessionId: scope.sessionId, projectRoot: scope.projectRoot, runId: scope.runId, artifactId: id, version })
    : undefined;
  return { kind: state.kind, text: state.text, error: state.error, url, reload };
}

/* --------------------------------- sections -------------------------------- */

function WfDetailSection(props) {
  return WF_H('section', { className: 'zwf-detail-section', 'data-testid': props.testId },
    WF_H('div', { className: 'zwf-run-section-head' },
      WF_H('h3', { className: 'zwf-detail-section-title' }, props.title),
      props.count === undefined ? null : WF_H('span', { className: 'zwf-run-section-count' }, String(props.count))),
    props.children);
}

function WfDetailHoles(props) {
  const { t } = props;
  return WF_H('div', { className: 'zwf-stack' }, props.holes.map((hole, index) => WF_H('div', {
    className: 'zwf-run-hole',
    key: `hole-${index}`,
  },
  WF_H('div', { className: 'zwf-run-hole-head' },
    WF_H('span', { className: 'zwf-run-hole-name' }, typeof hole.name === 'string' && hole.name !== '' ? hole.name : String(index + 1)),
    WF_H('span', { className: 'zwf-run-hole-state' }, wfDetailSay(t, 'detail.hole.waiting'))),
  typeof hole.phase === 'string' && hole.phase !== ''
    ? WF_H('span', { className: 'zwf-caption' }, wfDetailSay(t, 'detail.meta.phase', { name: hole.phase }))
    : null,
  typeof hole.prompt === 'string' && hole.prompt !== ''
    ? WF_H('p', { className: 'zwf-run-hole-prompt' }, hole.prompt)
    : null)));
}

function WfDetailPhases(props) {
  const { t, phases, currentIndex } = props;
  return WF_H('div', { className: 'zwf-stack', 'data-testid': 'workflow-run-phase-list' }, phases.map((phase, index) => {
    const asks = Number(phase?.asks);
    const failed = Number(phase?.failed);
    const current = index === currentIndex;
    const tone = Number.isFinite(failed) && failed > 0 ? 'error' : current ? 'success' : 'idle';
    const name = typeof phase?.name === 'string' && phase.name !== '' ? phase.name : String(index + 1);
    const meta = [];
    const startedAt = Number(phase?.startedAt);
    if (Number.isFinite(startedAt) && startedAt > 0) meta.push(wfDetailSay(t, 'detail.phase.startedAt', { time: WF_UI.date(startedAt) }));
    if (Number.isFinite(asks) && asks > 0) meta.push(wfDetailCountSay(t, 'detail.phase.steps', asks));
    if (Number.isFinite(failed) && failed > 0) meta.push(wfDetailCountSay(t, 'detail.phase.failed', failed));
    return WF_H('div', {
      className: 'zwf-run-phase',
      key: `phase-${index}`,
      'data-testid': 'workflow-run-phase',
      'data-phase-status': Number.isFinite(failed) && failed > 0 ? 'failed' : current ? 'running' : 'pending',
      'data-current': current ? 'true' : 'false',
    },
    WF_H('span', { className: 'zwf-run-phase-dot' }, WF_H(WF_UI.StatusDot, { tone })),
    WF_H('div', { className: 'zwf-run-phase-main' },
      WF_H('span', { className: 'zwf-run-phase-name', title: name }, name),
      meta.length === 0 ? null : WF_H('span', { className: 'zwf-run-phase-meta' }, meta.join(' · '))),
    current ? WF_H('span', { className: 'zwf-run-tag zwf-run-tag-success' }, wfDetailSay(t, 'detail.phase.current')) : null);
  }));
}

function WfDetailAgents(props) {
  const { t, agents, now } = props;
  return WF_H('div', { className: 'zwf-stack' }, agents.map((agent, index) => {
    const asks = Number(agent?.asks) || 0;
    const settled = Number(agent?.settled) || 0;
    const failed = Number(agent?.failed) || 0;
    const name = typeof agent?.name === 'string' && agent.name !== '' && agent.name !== '(anonymous)'
      ? agent.name
      : wfDetailSay(t, 'detail.agent.anonymous');
    const tone = failed > 0 ? 'error' : asks > 0 && settled >= asks ? 'success' : 'idle';
    const meta = [];
    if (asks > 0) meta.push(wfDetailCountSay(t, 'detail.agent.steps', asks));
    if (settled > 0) meta.push(wfDetailCountSay(t, 'detail.agent.settled', settled));
    if (failed > 0) meta.push(wfDetailCountSay(t, 'detail.agent.failed', failed));
    const last = wfDetailRelative(t, agent?.lastEvent, now);
    if (last !== '') meta.push(wfDetailSay(t, 'detail.agent.lastAt', { time: last }));
    return WF_H('div', { className: 'zwf-run-agent', key: `agent-${index}` },
      WF_H('span', { className: 'zwf-run-agent-glyph' }, WF_H(WF_UI.icons.agent, { size: 15 })),
      WF_H('div', { className: 'zwf-run-agent-main' },
        WF_H('span', { className: 'zwf-run-agent-name', title: name }, name),
        meta.length === 0 ? null : WF_H('span', { className: 'zwf-run-agent-meta' }, meta.join(' · '))),
      WF_H(WF_UI.StatusDot, { tone }));
  }));
}

function WfDetailArtifacts(props) {
  const { t, groups, onOpen } = props;
  return WF_H('div', { className: 'zwf-run-artifacts' }, groups.map((group) => {
    const row = group.row ?? {};
    const title = typeof row.title === 'string' && row.title.trim() !== ''
      ? row.title.trim()
      : (typeof row.id === 'string' ? row.id : wfDetailSay(t, 'detail.section.artifacts'));
    const kind = wfDetailArtifactKind(t, row.kind);
    const version = Number(row.version);
    const size = WF_UI.fileSize(row.bytes);
    const meta = [kind];
    if (Number.isFinite(version) && version > 0) meta.push(wfDetailSay(t, 'detail.artifact.version', { version }));
    if (group.versions > 1) meta.push(wfDetailSay(t, 'detail.artifact.versions', { count: group.versions }));
    if (size !== '') meta.push(size);
    return WF_H('button', {
      key: group.id,
      type: 'button',
      className: 'zwf-run-artifact',
      'data-testid': 'workflow-run-artifact',
      'data-workflow-artifact-id': group.id,
      title: `${kind} · ${title}`,
      onClick: () => onOpen(group.row),
    },
    WF_H('span', { className: 'zwf-run-artifact-glyph' }, WF_H(WF_UI.artifactIcon(row.kind), { size: 15 })),
    WF_H('span', { className: 'zwf-run-artifact-main' },
      WF_H('span', { className: 'zwf-run-artifact-title' }, title),
      WF_H('span', { className: 'zwf-run-artifact-meta' }, meta.join(' · '))),
    row.primary === true
      ? WF_H('span', { className: 'zwf-run-tag zwf-run-tag-brand' }, wfDetailSay(t, 'detail.artifact.primary'))
      : null,
    WF_H('span', { className: 'zwf-run-artifact-chevron' }, WF_H(WF_UI.icons.chevronRight, { size: 14 })));
  }));
}

function WfDetailReports(props) {
  const { t, reports } = props;
  return WF_H('div', { className: 'zwf-stack' }, reports.map((report, index) => {
    const meta = [];
    if (typeof report?.phase === 'string' && report.phase !== '') meta.push(wfDetailSay(t, 'detail.meta.phase', { name: report.phase }));
    const at = wfDetailClock(report?.at);
    if (at !== '') meta.push(at);
    return WF_H('div', { className: 'zwf-run-report', key: `report-${index}` },
      meta.length === 0 ? null : WF_H('div', { className: 'zwf-run-report-meta' }, meta.join(' · ')),
      WF_H('pre', { className: 'zwf-code zwf-run-report-body' }, wfDetailJsonText(report?.item)));
  }));
}

function WfDetailLog(props) {
  return WF_H('div', { className: 'zwf-log zwf-run-log', 'data-testid': 'workflow-run-log' }, props.entries.map((entry, index) => {
    const at = wfDetailClock(entry?.at);
    return WF_H('div', { className: 'zwf-log-row', key: `log-${index}` },
      typeof entry?.phase === 'string' && entry.phase !== ''
        ? WF_H('span', { className: 'zwf-log-phase' }, entry.phase)
        : null,
      at === '' ? null : WF_H('span', { className: 'zwf-run-time' }, at),
      WF_H('span', { className: 'zwf-log-text' }, typeof entry?.text === 'string' ? entry.text : ''));
  }));
}

function WfDetailWorld(props) {
  const { t, entries } = props;
  return WF_H('div', { className: 'zwf-run-world' }, entries.map((entry, index) => {
    const command = [typeof entry?.cmd === 'string' ? entry.cmd : wfDetailArgText(entry?.cmd), wfDetailArgsText(entry?.args)]
      .filter((text) => text !== '')
      .join(' ');
    const code = Number(entry?.exitCode);
    const meta = [];
    if (typeof entry?.phase === 'string' && entry.phase !== '') meta.push(entry.phase);
    const at = wfDetailClock(entry?.at);
    if (at !== '') meta.push(at);
    return WF_H('div', { className: 'zwf-run-world-row', key: `world-${index}` },
      WF_H('code', { className: 'zwf-run-world-cmd' }, command),
      WF_H('span', { className: 'zwf-run-world-meta' },
        meta.length === 0 ? null : WF_H('span', { className: 'zwf-caption' }, meta.join(' · ')),
        Number.isFinite(code)
          ? WF_H('span', { className: `zwf-run-tag${code === 0 ? '' : ' zwf-run-tag-error'}` }, wfDetailSay(t, 'detail.world.exitCode', { code }))
          : null));
  }));
}

/** The three result shapes the Host can report once a run is no longer in flight. */
function wfDetailHasOutcome(run) {
  if (run === undefined) return false;
  return run.status === 'completed' || run.status === 'errored' || run.status === 'stopped' || run.status === 'superseded';
}

function WfDetailOutcome(props) {
  const { t, run } = props;
  if (!wfDetailHasOutcome(run)) return null;
  if (run.status === 'errored' || run.status === 'stopped' || run.status === 'superseded') {
    const errored = run.status === 'errored';
    const reason = typeof run.stopReason === 'string' && run.stopReason !== '' ? run.stopReason : undefined;
    const message = typeof run.error === 'string' && run.error !== '' ? run.error : undefined;
    return WF_H(WfDetailSection, {
      title: wfDetailSay(t, errored ? 'detail.result.errored' : 'detail.result.stopped'),
      testId: 'workflow-run-error',
    },
    reason === undefined || errored
      ? null
      : WF_H('div', { className: 'zwf-wrap' }, WF_H('span', { className: 'zwf-run-tag zwf-run-tag-warn' }, wfDetailStopReasonLabel(t, reason))),
    WF_H('p', { className: 'zwf-run-error-body', 'data-testid': 'workflow-run-error-message' }, message ?? wfDetailSay(t, 'detail.result.noError')));
  }
  if (run.status === 'completed') {
    return WF_H(WfDetailSection, {
      title: wfDetailSay(t, 'detail.section.result'),
      testId: 'workflow-run-result',
    },
    run.result === undefined
      ? WF_H('p', { className: 'zwf-caption' }, wfDetailSay(t, 'detail.result.empty'))
      : WF_H('pre', { className: 'zwf-code', 'data-testid': 'workflow-run-result-json' }, wfDetailJsonText(run.result)));
  }
  return null;
}

function WfDetailRunArgs(props) {
  return WF_H(WfDetailSection, { title: wfDetailSay(props.t, 'detail.section.args') },
    WF_H('pre', { className: 'zwf-code' }, WF_UI.json(props.params)));
}

/* ---------------------------------- header --------------------------------- */

function WfDetailChip(props) {
  return WF_H('span', { className: `zwf-chip zwf-run-chip${props.tone === undefined ? '' : ` zwf-run-chip-${props.tone}`}` },
    props.icon === undefined ? null : WF_H('span', { className: 'zwf-run-chip-glyph' }, props.icon),
    WF_H('span', { className: 'zwf-run-chip-text' }, props.text));
}

function WfDetailHeader(props) {
  const { t, run, params, copied, loading, stopping } = props;
  const say = props.say;
  const name = typeof run?.name === 'string' && run.name.trim() !== ''
    ? run.name.trim()
    : (params?.name ?? say('detail.title'));
  const status = typeof run?.status === 'string' ? run.status : undefined;
  const tone = WF_UI.statusTone(status);
  const statusWord = status === undefined ? undefined : wfDetailStatusWord(t, status);
  const canStop = wfDetailCanStop(status);
  const created = Number(run?.createdAt);
  const finished = Number(run?.finishedAt);
  const duration = Number.isFinite(created) && created > 0
    ? wfDetailDuration(t, created, Number.isFinite(finished) && finished > 0 ? finished : Date.now())
    : '';
  const steps = run !== undefined && run.steps !== null && typeof run.steps === 'object' ? run.steps : undefined;
  const started = Number(steps?.started);
  const settled = Number(steps?.settled);
  const failed = Number(steps?.failed);
  const running = Number(steps?.running);
  const chips = [];
  if (Number.isFinite(started) && started > 0) {
    const done = Number.isFinite(settled) ? settled : 0;
    chips.push(WF_H(WfDetailChip, {
      key: 'steps',
      icon: WF_H(WF_UI.icons.check, { size: 12 }),
      text: wfDetailCountSay(t, 'detail.stepsValue', started, { settled: done, started }),
    }));
  }
  if (Number.isFinite(running) && running > 0) {
    chips.push(WF_H(WfDetailChip, { key: 'running', icon: WF_H(WF_UI.icons.run, { size: 12 }), text: say('detail.stepsRunning', { count: running }) }));
  }
  if (Number.isFinite(failed) && failed > 0) {
    chips.push(WF_H(WfDetailChip, { key: 'failed', icon: WF_H(WF_UI.icons.alert, { size: 12 }), tone: 'error', text: say('detail.stepsFailed', { count: failed }) }));
  }
  if (typeof run?.subagentModel === 'string' && run.subagentModel !== '') {
    chips.push(WF_H(WfDetailChip, { key: 'model', icon: WF_H(WF_UI.icons.spark, { size: 12 }), text: say('detail.modelShort', { model: run.subagentModel }) }));
  }
  const cap = Number(run?.maxConcurrency);
  if (Number.isFinite(cap) && cap > 0) {
    chips.push(WF_H(WfDetailChip, { key: 'concurrency', icon: WF_H(WF_UI.icons.workflow, { size: 12 }), text: say('detail.concurrency', { cap }) }));
  }
  const facts = [];
  const id = typeof run?.id === 'string' && run.id !== '' ? run.id : params?.runId;
  if (typeof id === 'string' && id !== '') {
    facts.push({ key: 'detail.runId', label: say('detail.runId'), value: id, mono: true, wide: true });
  }
  if (duration !== '') facts.push({ key: 'detail.duration', label: say('detail.duration'), value: duration });
  if (Number.isFinite(created) && created > 0) facts.push({ key: 'detail.createdAt', label: say('detail.createdAt'), value: WF_UI.date(created) });
  if (Number.isFinite(finished) && finished > 0) facts.push({ key: 'detail.finishedAt', label: say('detail.finishedAt'), value: WF_UI.date(finished) });
  if (typeof run?.resumedFrom === 'string' && run.resumedFrom !== '') {
    facts.push({ key: 'detail.resumedFrom', label: say('detail.resumedFrom'), value: run.resumedFrom, mono: true, wide: true });
  }
  const scriptPath = typeof run?.scriptPath === 'string' && run.scriptPath !== '' ? run.scriptPath : undefined;
  const copyTitle = copied === 'runId' ? say('detail.copied') : copied === 'error' ? say('detail.copyFailed') : say('detail.copyRunId');
  return WF_H('header', { className: 'zwf-detail-head' },
    WF_H('div', { className: 'zwf-detail-headline' },
      WF_H('h2', { className: 'zwf-detail-title', title: name }, name),
      WF_H('div', { className: 'zwf-detail-actions' },
        WF_H(WF_UI.Button, {
          variant: 'ghost',
          size: 'sm',
          className: 'zwf-run-stop',
          icon: WF_H(WF_UI.icons.stop, { size: 13 }),
          disabled: !canStop || stopping,
          title: canStop ? say('detail.stopHint') : say('detail.stopDisabled'),
          ariaLabel: say('detail.stop'),
          onClick: props.onStop,
        }, stopping ? say('detail.stopPending') : say('detail.stop')),
        WF_H(WF_UI.IconButton, {
          icon: loading ? WF_H(WF_UI.Spinner) : WF_H(WF_UI.icons.refresh, { size: 15 }),
          label: say('detail.refresh'),
          title: say('detail.refresh'),
          onClick: props.onRefresh,
        }),
        WF_H(WF_UI.IconButton, {
          icon: copied === 'runId'
            ? WF_H(WF_UI.icons.check, { size: 15 })
            : copied === 'error' ? WF_H(WF_UI.icons.alert, { size: 15 }) : WF_H(WF_UI.icons.copy, { size: 15 }),
          label: copyTitle,
          title: copyTitle,
          disabled: typeof id !== 'string' || id === '',
          onClick: props.onCopyRunId,
        }),
        WF_H(WF_UI.IconButton, {
          icon: WF_H(WF_UI.icons.file, { size: 15 }),
          label: say('detail.scriptOpen'),
          title: say('detail.scriptOpen'),
          disabled: scriptPath === undefined,
          onClick: props.onOpenScript,
        }))),
    statusWord === undefined && chips.length === 0
      ? null
      : WF_H('div', { className: 'zwf-detail-sub' },
        statusWord === undefined
          ? null
          : WF_H('span', { className: 'zwf-inline' },
            WF_H(WF_UI.StatusDot, { tone }),
            WF_H('span', { className: `zwf-status-word${tone === 'idle' ? '' : ` zwf-status-word-${tone}`}`, 'data-testid': 'workflow-run-status' }, statusWord)),
        chips),
    facts.length === 0
      ? null
      : WF_H('div', { className: 'zwf-run-facts' }, facts.map((fact, index) => WF_H('div', {
        className: `zwf-run-fact${fact.wide === true ? ' zwf-run-fact-wide' : ''}`,
        key: `${fact.key}-${index}`,
      },
      WF_H('span', { className: 'zwf-run-fact-key' }, fact.label),
      WF_H('span', { className: `zwf-run-fact-value${fact.mono === true ? ' zwf-run-mono' : ''}`, title: fact.value }, fact.value)))));
}

/* ---------------------------------- modals --------------------------------- */

function WfDetailScriptModal(props) {
  const { t, run, onClose } = props;
  const say = (key, params) => wfDetailSay(t, key, params);
  const [copied, flash] = useWfDetailCopy();
  const scriptPath = typeof run?.scriptPath === 'string' && run.scriptPath !== '' ? run.scriptPath : undefined;
  const cwd = typeof run?.cwd === 'string' && run.cwd !== '' ? run.cwd : undefined;
  const rows = [];
  if (scriptPath !== undefined) rows.push({ label: say('detail.scriptTitle'), value: scriptPath });
  if (cwd !== undefined) rows.push({ label: say('detail.cwd'), value: cwd });
  const onCopy = async () => {
    const text = scriptPath ?? cwd ?? '';
    const ok = await wfDetailCopy(text);
    flash(ok ? 'path' : 'error');
  };
  return WF_H(WF_UI.Modal, {
    open: true,
    title: say('detail.scriptTitle'),
    closeLabel: say('detail.close'),
    onClose,
    footer: WF_H(WF_FRAGMENT, null,
      scriptPath === undefined
        ? null
        : WF_H(WF_UI.Button, {
          key: 'copy',
          variant: 'ghost',
          size: 'sm',
          icon: WF_H(WF_UI.icons.copy, { size: 14 }),
          onClick: () => {
            void onCopy();
          },
        }, copied === 'path' ? say('detail.copied') : copied === 'error' ? say('detail.copyFailed') : say('detail.copyPath')),
      WF_H(WF_UI.Button, { key: 'close', variant: 'subtle', size: 'sm', onClick: onClose }, say('detail.close'))),
  },
  WF_H('p', { className: 'zwf-caption' }, rows.length === 0 ? say('detail.scriptMissing') : say('detail.scriptBody')),
  rows.length === 0
    ? null
    : WF_H('div', { className: 'zwf-run-paths' }, rows.map((row) => WF_H('div', { className: 'zwf-run-fact', key: row.label },
      WF_H('span', { className: 'zwf-run-fact-key' }, row.label),
      WF_H('span', { className: 'zwf-run-fact-value zwf-run-mono' }, row.value)))));
}

function WfDetailArtifactModal(props) {
  const { t, scope, target, onClose } = props;
  const say = (key, params) => wfDetailSay(t, key, params);
  const [copied, flash] = useWfDetailCopy();
  const artifact = useWfDetailArtifact(scope, target);
  const [imageBroken, setImageBroken] = React.useState(false);
  const row = target ?? {};
  const title = typeof row.title === 'string' && row.title.trim() !== ''
    ? row.title.trim()
    : (typeof row.id === 'string' ? row.id : say('detail.section.artifacts'));
  const kind = wfDetailArtifactKind(t, row.kind);
  const version = Number(row.version);
  const size = WF_UI.fileSize(row.bytes);
  const meta = [kind];
  if (Number.isFinite(version) && version > 0) meta.push(say('detail.artifact.version', { version }));
  if (size !== '') meta.push(size);
  const file = typeof row.file === 'string' && row.file !== '' ? row.file : undefined;
  const text = artifact.kind === 'text' && typeof artifact.text === 'string' ? artifact.text : '';
  const clipped = text.length > WF_DETAIL_PREVIEW_CHARS;
  const shown = clipped ? text.slice(0, WF_DETAIL_PREVIEW_CHARS) : text;
  const copyValue = async (token, value) => {
    const ok = await wfDetailCopy(value);
    flash(ok ? token : 'error');
  };
  let body;
  if (artifact.kind === 'image' && imageBroken) {
    body = WF_H(WF_UI.ErrorNotice, {
      message: say('detail.artifact.loadError'),
      onRetry: () => setImageBroken(false),
      retryLabel: say('detail.retry'),
    });
  } else if (artifact.kind === 'image') {
    body = WF_H('img', {
      className: 'zwf-run-preview-image',
      src: artifact.url,
      alt: title,
      onError: () => setImageBroken(true),
    });
  } else if (artifact.kind === 'loading') {
    body = WF_H('div', { className: 'zwf-empty-inline' },
      WF_H(WF_UI.Spinner, { inline: true }),
      say('detail.artifact.loading'));
  } else if (artifact.kind === 'error') {
    body = WF_H(WF_UI.ErrorNotice, {
      message: say('detail.artifact.loadError'),
      onRetry: artifact.reload,
      retryLabel: say('detail.retry'),
    });
  } else if (artifact.kind === 'text') {
    body = WF_H('div', { className: 'zwf-run-preview' },
      WF_H('pre', { className: 'zwf-code zwf-run-preview-text' }, shown),
      clipped ? WF_H('p', { className: 'zwf-caption' }, say('detail.artifact.truncated')) : null);
  } else if (artifact.kind === 'unsupported') {
    body = WF_H('div', { className: 'zwf-run-preview' },
      WF_H('p', { className: 'zwf-caption' }, say('detail.artifact.unsupported')),
      file === undefined
        ? null
        : WF_H('div', { className: 'zwf-run-fact' },
          WF_H('span', { className: 'zwf-run-fact-key' }, say('detail.artifact.file')),
          WF_H('span', { className: 'zwf-run-fact-value zwf-run-mono zwf-run-break' }, file)));
  } else {
    body = null;
  }
  const footer = WF_H(WF_FRAGMENT, null,
    artifact.kind === 'text' && text !== ''
      ? WF_H(WF_UI.Button, {
        key: 'copy',
        variant: 'ghost',
        size: 'sm',
        icon: WF_H(WF_UI.icons.copy, { size: 14 }),
        onClick: () => {
          void copyValue('text', text);
        },
      }, copied === 'text' ? say('detail.copied') : copied === 'error' ? say('detail.copyFailed') : say('detail.artifact.copyText'))
      : null,
    artifact.kind === 'unsupported' && file !== undefined
      ? WF_H(WF_UI.Button, {
        key: 'copy-path',
        variant: 'ghost',
        size: 'sm',
        icon: WF_H(WF_UI.icons.copy, { size: 14 }),
        onClick: () => {
          void copyValue('path', file);
        },
      }, copied === 'path' ? say('detail.copied') : copied === 'error' ? say('detail.copyFailed') : say('detail.copyPath'))
      : null,
    WF_H(WF_UI.Button, { key: 'close', variant: 'subtle', size: 'sm', onClick: onClose }, say('detail.close')));
  return WF_H(WF_UI.Modal, {
    open: true,
    wide: true,
    title,
    closeLabel: say('detail.close'),
    onClose,
    footer,
  },
  WF_H('div', { className: 'zwf-run-preview-meta' },
    WF_H('span', {}, meta.join(' · ')),
    row.primary === true ? WF_H('span', { className: 'zwf-run-tag zwf-run-tag-brand' }, say('detail.artifact.primary')) : null),
  body);
}

/* ---------------------------------- pane ----------------------------------- */

function WfDetailPane(props) {
  const { t, params, visible } = props;
  const say = React.useCallback((key, values) => wfDetailSay(t, key, values), [t]);
  const sessionId = params === undefined ? undefined : params.sessionId;
  const projectRoot = params === undefined ? undefined : params.projectRoot;
  const runId = params === undefined ? undefined : params.runId;
  const scope = React.useMemo(() => ({ sessionId, projectRoot, runId, visible }), [sessionId, projectRoot, runId, visible]);
  const state = useWfDetailRun(scope);
  const now = useWfClock();
  const [copied, flash] = useWfDetailCopy();
  const [stopOpen, setStopOpen] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [stopError, setStopError] = React.useState(undefined);
  const [scriptOpen, setScriptOpen] = React.useState(false);
  const [preview, setPreview] = React.useState(undefined);
  React.useEffect(() => {
    setPreview(undefined);
    setScriptOpen(false);
    setStopOpen(false);
    setStopError(undefined);
  }, [runId]);
  const run = state.run;
  const artifactScope = React.useMemo(() => ({ sessionId, projectRoot, runId }), [sessionId, projectRoot, runId]);
  const onCopyRunId = async () => {
    const ok = await wfDetailCopy(runId ?? '');
    flash(ok ? 'runId' : 'error');
  };
  const onStop = async () => {
    if (stopping || runId === undefined) return;
    setStopping(true);
    setStopError(undefined);
    try {
      const payload = await WF_API.stopRun({ runId, sessionId, projectRoot });
      const next = payload !== null && typeof payload === 'object' ? payload.run : undefined;
      if (next !== undefined) state.replace(next);
      setStopOpen(false);
      state.reload();
    } catch (error) {
      setStopError(error);
    } finally {
      setStopping(false);
    }
  };
  const closeStop = () => {
    if (stopping) return;
    setStopOpen(false);
    setStopError(undefined);
  };
  if (runId === undefined) {
    return WF_H('div', { className: 'zwf-run' },
      WF_H('header', { className: 'zwf-detail-head' },
        WF_H('div', { className: 'zwf-detail-headline' }, WF_H('h2', { className: 'zwf-detail-title' }, say('detail.title')))),
      WF_H('div', { className: 'zwf-detail-body' },
        WF_H(WF_UI.EmptyState, {
          icon: WF_H(WF_UI.icons.workflow, { size: 20 }),
          title: say('detail.missing.title'),
          body: say('detail.missing.body'),
        })));
  }
  const sections = [];
  let empty = true;
  if (state.error !== undefined && run !== undefined) {
    const detail = Number(state.error.status) === 404 ? undefined : (typeof state.error.message === 'string' ? state.error.message : undefined);
    sections.push(WF_H('div', { className: 'zwf-stack', key: 'refresh-error' },
      WF_H(WF_UI.ErrorNotice, {
        message: say('detail.loadError'),
        onRetry: state.reload,
        retryLabel: say('detail.retry'),
      }),
      detail === undefined ? null : WF_H('p', { className: 'zwf-caption zwf-run-mono' }, detail)));
    empty = false;
  }
  if (run !== undefined) {
    if (wfDetailHasOutcome(run)) {
      sections.push(WF_H(WfDetailOutcome, { key: 'outcome', t, run }));
      empty = false;
    }
    const holes = Array.isArray(run.holes) ? run.holes.filter((hole) => hole !== null && typeof hole === 'object') : [];
    if (holes.length > 0) {
      sections.push(WF_H(WfDetailSection, { key: 'holes', title: say('detail.section.holes'), count: holes.length, testId: 'workflow-run-holes' },
        WF_H(WfDetailHoles, { t, holes })));
      empty = false;
    }
    const phases = Array.isArray(run.phasesDetail) ? run.phasesDetail.filter((phase) => phase !== null && typeof phase === 'object') : [];
    if (phases.length > 0) {
      // The Host records a phase start but never an end, so only an in-flight run has a phase
      // that can honestly be called current: its last one.
      const currentIndex = run.status === 'running' ? phases.length - 1 : -1;
      sections.push(WF_H(WfDetailSection, { key: 'phases', title: say('detail.section.phases'), count: phases.length, testId: 'workflow-run-phases' },
        WF_H(WfDetailPhases, { t, phases, currentIndex })));
      empty = false;
    }
    const agents = Array.isArray(run.agents) ? run.agents.filter((agent) => agent !== null && typeof agent === 'object') : [];
    if (agents.length > 0) {
      sections.push(WF_H(WfDetailSection, { key: 'agents', title: say('detail.section.agents'), count: agents.length, testId: 'workflow-run-agents' },
        WF_H(WfDetailAgents, { t, agents, now })));
      empty = false;
    }
    const artifacts = wfDetailArtifacts(run);
    if (artifacts.length > 0) {
      sections.push(WF_H(WfDetailSection, { key: 'artifacts', title: say('detail.section.artifacts'), count: artifacts.length, testId: 'workflow-run-artifacts' },
        WF_H(WfDetailArtifacts, { t, groups: artifacts, onOpen: (target) => setPreview(target) })));
      empty = false;
    }
    const reports = Array.isArray(run.reports) ? run.reports.filter((report) => report !== null && typeof report === 'object') : [];
    if (reports.length > 0) {
      sections.push(WF_H(WfDetailSection, { key: 'reports', title: say('detail.section.reports'), count: reports.length, testId: 'workflow-run-reports' },
        WF_H(WfDetailReports, { t, reports })));
      empty = false;
    }
    const log = Array.isArray(run.log) ? run.log.filter((entry) => entry !== null && typeof entry === 'object') : [];
    if (log.length > 0) {
      sections.push(WF_H(WfDetailSection, { key: 'log', title: say('detail.section.log'), count: log.length, testId: 'workflow-run-logs' },
        WF_H(WfDetailLog, { entries: log })));
      empty = false;
    }
    const world = Array.isArray(run.world) ? run.world.filter((entry) => entry !== null && typeof entry === 'object') : [];
    if (world.length > 0) {
      sections.push(WF_H(WfDetailSection, { key: 'world', title: say('detail.section.world'), count: world.length, testId: 'workflow-run-world' },
        WF_H(WfDetailWorld, { t, entries: world })));
      empty = false;
    }
    const runParams = wfDetailRunParams(run, say);
    if (runParams !== undefined) {
      sections.push(WF_H(WfDetailRunArgs, { key: 'args', t, params: runParams }));
      empty = false;
    }
  }
  let body;
  if (run === undefined) {
    if (state.error !== undefined) {
      const notFound = Number(state.error.status) === 404 || state.error.code === 'run-not-found';
      const detail = notFound || typeof state.error.message !== 'string' ? undefined : state.error.message;
      body = WF_H('div', { className: 'zwf-stack' },
        WF_H(WF_UI.ErrorNotice, {
          message: say(notFound ? 'detail.notFound' : 'detail.loadError'),
          onRetry: state.reload,
          retryLabel: say('detail.retry'),
        }),
        detail === undefined ? null : WF_H('p', { className: 'zwf-caption zwf-run-mono' }, detail));
    } else if (state.loading) {
      body = WF_H('div', { className: 'zwf-empty-inline' }, WF_H(WF_UI.Spinner, { inline: true }), say('detail.loading'));
    } else {
      body = WF_H('div', { className: 'zwf-empty-inline' }, say('detail.emptyBody'));
    }
  } else if (empty) {
    body = WF_H('div', { className: 'zwf-empty-inline' }, say('detail.emptyBody'));
  } else {
    body = WF_H(WF_FRAGMENT, null, sections);
  }
  return WF_H('div', {
    className: 'zwf-run',
    'data-workflow-run-id': runId,
    'data-workflow-run-status': run === undefined ? 'absent' : (typeof run.status === 'string' ? run.status : 'unknown'),
  },
  WF_H(WfDetailHeader, {
    t,
    say,
    run,
    params,
    copied,
    loading: state.loading,
    stopping,
    onCopyRunId: () => {
      void onCopyRunId();
    },
    onRefresh: state.reload,
    onStop: () => {
      setStopError(undefined);
      setStopOpen(true);
    },
    onOpenScript: () => setScriptOpen(true),
  }),
  WF_H('div', { className: 'zwf-detail-body' }, body),
  WF_H(WF_UI.Modal, {
    open: stopOpen,
    title: say('detail.stopConfirm.title'),
    closeLabel: say('detail.close'),
    onClose: closeStop,
    footer: WF_H(WF_FRAGMENT, null,
      WF_H(WF_UI.Button, { key: 'cancel', variant: 'ghost', size: 'sm', disabled: stopping, onClick: closeStop }, say('detail.cancel')),
      WF_H(WF_UI.Button, {
        key: 'stop',
        variant: 'danger',
        size: 'sm',
        icon: WF_H(WF_UI.icons.stop, { size: 13 }),
        disabled: stopping,
        onClick: () => {
          void onStop();
        },
      }, stopping ? say('detail.stopPending') : say('detail.stopConfirm.confirm'))),
  },
  WF_H('p', { className: 'zwf-caption' }, say('detail.stopConfirm.body')),
  stopError === undefined
    ? null
    : WF_H(WF_FRAGMENT, null,
      WF_H(WF_UI.ErrorNotice, { message: say('detail.stopError') }),
      typeof stopError.message === 'string' && stopError.message !== ''
        ? WF_H('p', { className: 'zwf-caption zwf-run-mono' }, stopError.message)
        : null)),
  scriptOpen ? WF_H(WfDetailScriptModal, { t, run, onClose: () => setScriptOpen(false) }) : null,
  preview === undefined
    ? null
    : WF_H(WfDetailArtifactModal, {
      t,
      scope: artifactScope,
      target: preview,
      onClose: () => setPreview(undefined),
    }));
}

/* ---------------------------------- seats ---------------------------------- */

function WfDetailTab(props) {
  const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined;
  const tab = info === undefined ? undefined : info.tab;
  return WF_H(WfDetailPane, {
    t: props.t,
    params: wfDetailTabParams(tab),
    visible: tab === undefined || tab.visible !== false,
  });
}

function WfDetailTabTitle(props) {
  const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined;
  const params = wfDetailTabParams(info === undefined ? undefined : info.tab);
  const name = params === undefined || params.name === undefined ? wfDetailSay(props.t, 'detail.title') : params.name;
  return WF_H('span', { className: 'zwf-run-tab-title' },
    WF_H('span', { className: 'zwf-run-tab-glyph' }, WF_H(WF_UI.icons.run, { size: 14 })),
    WF_H('span', { className: 'zwf-run-tab-text', title: name }, name));
}

/** The no-sidebar fallback: the same pane, centered in the shell overlay. */
function WfDetailOverlay(props) {
  const target = useWfDetailOverlay();
  if (target === undefined) return null;
  const say = (key, params) => wfDetailSay(props.t, key, params);
  return WF_H(WF_UI.Modal, {
    open: true,
    wide: true,
    title: say('detail.title'),
    closeLabel: say('detail.close'),
    onClose: () => WF_DETAIL_OVERLAY.close(),
  },
  WF_H('div', { className: 'zwf-run-overlay' },
    WF_H(WfDetailPane, { t: props.t, params: target, visible: true })));
}

/* ---------------------------------- styles --------------------------------- */

const WF_DETAIL_CSS = `
.zwf-run{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.zwf-run-tab-title{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}
.zwf-run-tab-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-brand-primary)}
.zwf-run-tab-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-run-stop:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.zwf-run-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px;min-width:0}
.zwf-run-fact{display:flex;flex-direction:column;gap:0;min-width:0}
.zwf-run-fact-wide{grid-column:1/-1}
.zwf-run-fact-key{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-run-fact-value{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-run-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}
.zwf-run-break{white-space:normal;overflow-wrap:anywhere}
.zwf-run-paths{display:flex;flex-direction:column;gap:8px;min-width:0}
.zwf-run-paths .zwf-run-fact-value{white-space:normal;overflow-wrap:anywhere}
.zwf-run-section-head{display:flex;align-items:baseline;gap:6px;min-width:0}
.zwf-run-section-count{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.zwf-run-chip{cursor:default;max-width:100%}
.zwf-run-chip:hover{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}
.zwf-run-chip-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.zwf-run-chip-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-run-chip-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in oklab,var(--dsw-alias-state-error-primary) 35%,transparent)}
.zwf-run-chip-error:hover{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in oklab,var(--dsw-alias-state-error-primary) 45%,transparent)}
.zwf-run-chip-error .zwf-run-chip-glyph{color:inherit}
.zwf-run-tag{display:inline-flex;align-items:center;flex:none;height:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:18px;font-weight:500;white-space:nowrap}
.zwf-run-tag-brand{background:color-mix(in oklab,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}
.zwf-run-tag-success{background:color-mix(in oklab,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}
.zwf-run-tag-warn{background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}
.zwf-run-tag-error{background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
.zwf-run-phase{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:var(--dsw-radius-sm,8px);min-width:0}
.zwf-run-phase[data-current=true]{background:color-mix(in oklab,var(--dsw-alias-state-success-primary) 7%,transparent)}
.zwf-run-phase-dot{display:inline-flex;flex:none;margin-top:6px}
.zwf-run-phase-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.zwf-run-phase-name{font-size:13px;line-height:19px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-run-phase-meta{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.zwf-run-agent{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:var(--dsw-radius-sm,8px);min-width:0}
.zwf-run-agent-glyph{display:inline-flex;flex:none;margin-top:2px;color:var(--dsw-alias-label-secondary)}
.zwf-run-agent-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.zwf-run-agent-name{font-size:13px;line-height:19px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-run-agent-meta{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.zwf-run-artifacts{display:flex;flex-direction:column;gap:4px;min-width:0}
.zwf-run-artifact{box-sizing:border-box;display:flex;align-items:center;gap:9px;width:100%;min-width:0;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.zwf-run-artifact:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,transparent);border-color:var(--dsw-alias-border-l2)}
.zwf-run-artifact:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.zwf-run-artifact-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.zwf-run-artifact-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.zwf-run-artifact-title{font-size:13px;line-height:19px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-run-artifact-meta{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-run-artifact-chevron{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.zwf-run-hole{display:flex;flex-direction:column;gap:3px;padding:7px 9px;border:1px solid color-mix(in oklab,var(--dsw-alias-state-warn-primary) 32%,transparent);border-radius:var(--dsw-radius-sm,8px);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 6%,transparent);min-width:0}
.zwf-run-hole-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}
.zwf-run-hole-name{font-size:13px;line-height:19px;font-weight:500;color:var(--dsw-alias-label-primary)}
.zwf-run-hole-state{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}
.zwf-run-hole-prompt{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow:auto}
.zwf-run-report{display:flex;flex-direction:column;gap:5px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);min-width:0}
.zwf-run-report-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.zwf-run-report-body{margin:0;max-height:180px}
.zwf-run-log{max-height:260px;overflow:auto;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:color-mix(in oklab,var(--dsw-alias-label-primary) 4%,transparent)}
.zwf-run-time{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.zwf-run-world{display:flex;flex-direction:column;gap:4px;min-width:0}
.zwf-run-world-row{display:flex;align-items:center;gap:8px;min-width:0;padding:6px 9px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:color-mix(in oklab,var(--dsw-alias-label-primary) 4%,transparent)}
.zwf-run-world-cmd{flex:1;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.zwf-run-world-meta{display:flex;align-items:center;gap:6px;flex:none}
.zwf-run-error-body{margin:0;padding:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto}
.zwf-run-preview{display:flex;flex-direction:column;gap:8px;min-width:0}
.zwf-run-preview-meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-run-preview-text{margin:0;max-height:min(52vh,420px)}
.zwf-run-preview-image{display:block;max-width:100%;max-height:min(52vh,420px);margin:0 auto;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);object-fit:contain;background:var(--dsw-alias-bg-layer-1)}
.zwf-run-overlay{display:flex;flex-direction:column;min-height:0;height:min(68vh,620px)}
.zwf-run-overlay .zwf-run{height:100%}
`;

WF_STYLE_PARTS.push(WF_DETAIL_CSS);

/* -------------------------------- registration ----------------------------- */

/**
 * Register the page type, both Sidebar seats, and the no-sidebar fallback.
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
      key: WF_DETAIL_ID,
      locale: UI_NS,
    }, WfDetailTab));
    slots.inject('sidebar.right.pane.tab.title', () => slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: WF_DETAIL_ID,
      locale: UI_NS,
    }, WfDetailTabTitle));
    slots.inject('shell.overlay', () => slots.register({
      name: 'shell.overlay',
      id: WF_DETAIL_ID,
      locale: UI_NS,
    }, WfDetailOverlay));
  }
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (child) => {
    const sidebar = child.sidebarRight;
    const tabs = child.sidebarRightTabs;
    if (sidebar !== undefined && typeof sidebar.openTab === 'function') WF_DETAIL_SERVICES.sidebar = sidebar;
    if (tabs === undefined || typeof tabs.register !== 'function') return;
    runEffect(() => tabs.register({
      id: WF_DETAIL_ID,
      kind: WF_DETAIL_KIND,
      priority: 'extension',
      title: () => wfDetailSay(t, 'detail.title'),
    }), 'zcode-workflow: run detail tab type');
  });
};

/**
 * Open one run's detail in the right Sidebar; without a Sidebar (or with no session surface
 * mounted) the same pane opens through the shell overlay instead.
 *
 * @param {{ runId: string, sessionId?: string, projectRoot?: string, name?: string }} value
 * @returns {boolean} whether a surface accepted the request.
 */
WF_DETAIL.open = function open(value) {
  const params = wfDetailParams(value);
  if (params === undefined) return false;
  const sidebar = WF_DETAIL_SERVICES.sidebar;
  if (sidebar !== undefined && typeof sidebar.openTab === 'function') {
    try {
      sidebar.openTab(WF_DETAIL_KIND, { params });
      WF_DETAIL_OVERLAY.close();
      return true;
    } catch (error) {
      console.warn('zcode-workflow: cannot open the run detail in the right sidebar', error);
    }
  }
  WF_DETAIL_OVERLAY.open(params);
  return true;
};
