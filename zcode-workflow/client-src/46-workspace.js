/*
 * The script-steps workspace: one card per world operation (`world.read` / `world.run`) the run
 * performed, grouped into chapters by the phase that issued it.
 *
 * This surface shows the workspace ledger, not the script text and not agent nodes: the Host
 * records what touched the project, and one card's result is fetched only when it is expanded.
 */

/** Card entrance stagger: the product waits 24 ms per card, up to 360 ms. */
const WF_WORKSPACE_STAGGER_MS = 24;
const WF_WORKSPACE_STAGGER_MAX_MS = 360;

/** Clock label: `+m:ss` under an hour, `+h:mm:ss` past it. */
function wfWorkspaceOffset(origin, at) {
  const start = wfNum(origin);
  const value = wfNum(at);
  if (start === undefined || value === undefined) return '';
  const seconds = Math.max(0, Math.round((value - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `+${minutes}:${String(rest).padStart(2, '0')}`;
  const hours = Math.floor(minutes / 60);
  return `+${hours}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** One world operation, normalized from the workspace ledger. */
function wfWorkspaceNode(node, index) {
  const args = Array.isArray(node.args) ? node.args : [];
  return {
    key: `${wfText(node.siteId) ?? 'site'}-${wfNum(node.ordinal) ?? index}`,
    siteId: wfText(node.siteId) ?? '',
    ordinal: wfNum(node.ordinal) ?? index,
    kind: wfText(node.kind) ?? 'world-run',
    op: wfText(node.op),
    args,
    inputTruncated: node.inputTruncated === true,
    status: ['running', 'completed', 'failed'].includes(node.status) ? node.status : 'completed',
    error: node.error !== null && typeof node.error === 'object'
      ? { code: wfText(node.error.code), message: wfText(node.error.message) }
      : undefined,
    summary: node.summary !== null && typeof node.summary === 'object' ? node.summary : {},
    phaseName: wfText(node.phaseName) ?? wfText(node.phase),
    createdAt: wfNum(node.createdAt),
    updatedAt: wfNum(node.updatedAt),
  };
}

/**
 * Chapters: consecutive nodes of one phase belong to one chapter, numbered per phase entry.
 * @param {object[]} nodes normalised nodes, in ledger order
 */
function wfWorkspaceChapters(nodes) {
  const chapters = [];
  for (const node of nodes) {
    const name = node.phaseName ?? '';
    const last = chapters[chapters.length - 1];
    if (last !== undefined && last.name === name) {
      last.nodes.push(node);
      last.startedAt = Math.min(last.startedAt ?? node.createdAt ?? Infinity, node.createdAt ?? Infinity);
      last.endedAt = Math.max(last.endedAt ?? 0, node.updatedAt ?? node.createdAt ?? 0);
      continue;
    }
    const round = chapters.filter((chapter) => chapter.name === name).length + 1;
    chapters.push({
      key: `${name === '' ? 'unphased' : name}#${round}-${node.key}`,
      name,
      round,
      nodes: [node],
      startedAt: node.createdAt,
      endedAt: node.updatedAt ?? node.createdAt,
    });
  }
  return chapters.map((chapter) => ({
    ...chapter,
    startedAt: Number.isFinite(chapter.startedAt) ? chapter.startedAt : undefined,
    endedAt: Number.isFinite(chapter.endedAt) ? chapter.endedAt : undefined,
  }));
}

/** The action word for one operation. */
function wfWorkspaceVerb(t, node) {
  if (node.kind === 'world-read') {
    const op = (node.op ?? '').toLowerCase();
    if (op.includes('search') || op.includes('grep') || op.includes('find')) return WF_UI.say(t, UI_EN, 'script.verb.searched');
    return WF_UI.say(t, UI_EN, 'script.verb.read');
  }
  return node.op ?? WF_UI.say(t, UI_EN, 'script.kind.step');
}

/** The main argument of one operation: the path, pattern or command. */
function wfWorkspaceSubject(node) {
  for (const value of node.args) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return node.op ?? '';
}

/** Summary counts under the card head: what the operation produced. */
function wfWorkspaceResultParts(t, node) {
  const parts = [];
  const summary = node.summary ?? {};
  const exit = wfNum(summary.exitCode);
  if (exit !== undefined) parts.push(WF_UI.say(t, UI_EN, 'script.status.exit', { code: exit }));
  const count = wfNum(summary.resultCount);
  if (count !== undefined) {
    const key = node.kind === 'world-read'
      ? ((node.op ?? '').toLowerCase().includes('search') ? 'script.result.matches' : 'script.result.files')
      : 'script.result.lines';
    parts.push(WF_UI.say(t, UI_EN, key, { count }));
  }
  const bytes = wfArtifactSize(summary.resultBytes ?? summary.stdoutBytes);
  if (bytes !== undefined) parts.push(bytes);
  return parts;
}

/** Fetch one node's recorded result; only an expanded card asks. */
function useWfNodeResult(scope, node, enabled) {
  const [state, setState] = React.useState({ kind: 'idle' });
  const key = [scope?.sessionId ?? '', scope?.runId ?? '', node?.siteId ?? '', node?.ordinal ?? '', enabled ? '1' : '0'].join('\u0000');
  React.useEffect(() => {
    if (!enabled || node === undefined) {
      setState({ kind: 'idle' });
      return undefined;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    WF_API.runNode({
      sessionId: scope.sessionId,
      runId: scope.runId,
      siteId: node.siteId,
      ordinal: node.ordinal,
      maxBytes: 32 * 1024,
    }).then((payload) => {
      if (cancelled) return;
      setState({
        kind: 'loaded',
        status: payload?.status,
        result: payload?.result,
        error: payload?.error,
        truncated: payload?.truncated === true,
        totalBytes: wfNum(payload?.totalBytes),
      });
    }).catch((error) => {
      if (!cancelled) setState({ kind: 'error', error });
    });
    return () => { cancelled = true; };
  }, [key, enabled, scope?.sessionId, scope?.runId, node?.siteId, node?.ordinal]);
  return state;
}

/** Result body: running, failed, list-shaped or plain text. */
function WfWorkspaceResult(props) {
  const { node, t, result } = props;
  if (result.kind === 'loading') {
    return WF_H('p', { className: 'zwf-ws-result-line' }, WF_UI.say(t, UI_EN, 'script.result.loading'));
  }
  if (result.kind === 'error') {
    return WF_H('p', { className: 'zwf-ws-result-error' }, WF_UI.say(t, UI_EN, 'script.result.loadFailed', { error: wfText(result.error?.message) ?? wfText(result.error?.code) ?? '' }));
  }
  if (result.kind !== 'loaded') return null;
  const payload = result.result;
  if (result.status === 'failed') {
    const message = wfText(result.error?.message) ?? wfText(result.error?.code) ?? WF_UI.say(t, UI_EN, 'run.result.noError');
    return WF_H('pre', { className: 'zwf-ws-result-error' }, message);
  }
  if (result.status === 'running') {
    return WF_H('p', { className: 'zwf-ws-result-line' }, WF_UI.say(t, UI_EN, 'run.status.running'));
  }
  if (payload === undefined || payload === null) {
    return WF_H('p', { className: 'zwf-ws-result-line' }, WF_UI.say(t, UI_EN, 'script.result.empty'));
  }
  const lines = typeof payload === 'string'
    ? payload.split('\n')
    : Array.isArray(payload?.lines) ? payload.lines.map(String)
      : Array.isArray(payload) ? payload.map((entry) => (typeof entry === 'string' ? entry : WF_UI.json(entry))) : [];
  if (lines.length > 0) {
    return WF_H('ul', { className: 'zwf-ws-lines' },
      lines.slice(0, 200).map((line, index) => WF_H('li', { key: String(index) },
        WF_H('span', { className: 'zwf-ws-line-no zwf-mono' }, String(index + 1)),
        WF_H('span', { className: 'zwf-ws-line-text' }, line))),
      lines.length > 200
        ? WF_H('li', { className: 'zwf-ws-line-more' }, WF_UI.say(t, UI_EN, 'script.result.more', { count: lines.length - 200 }))
        : null);
  }
  return WF_H('pre', { className: 'zwf-ws-pre' }, WF_UI.json(payload));
}

/** One operation card. */
function WfWorkspaceCard(props) {
  const { node, t, scope, origin, delay, open, onToggle } = props;
  const result = useWfNodeResult(scope, node, open);
  const [copied, setCopied] = React.useState(false);
  const subject = wfWorkspaceSubject(node);
  const parts = wfWorkspaceResultParts(t, node);
  const stdout = open && result.kind === 'loaded' && typeof result.result === 'string' ? result.result : '';
  const stderr = open && result.kind === 'loaded' && typeof result.error?.message === 'string' ? result.error.message : '';
  const copy = () => {
    const text = [node.op ?? '', ...node.args.map((value) => (typeof value === 'string' ? value : WF_UI.json(value)))].join(' ');
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    try {
      void navigator.clipboard?.writeText(text).then(done).catch(done);
    } catch {
      done();
    }
  };
  const tone = node.status === 'failed' ? 'failed' : node.status === 'running' ? 'running' : 'completed';
  return WF_H('div', {
    className: `zwf-ws-card zwf-ws-card-${tone}`,
    'data-testid': 'workflow-workspace-card',
    'data-card-key': node.key,
    'data-open': open ? 'true' : 'false',
    'data-ordinal': node.ordinal,
    'data-phase-id': node.phaseName ?? '',
    'data-site-id': node.siteId,
    'data-status': node.status,
    style: delay > 0 ? { animationDelay: `${delay}ms` } : undefined,
  },
  WF_H('span', { className: 'zwf-ws-glyph' }, WF_H(node.kind === 'world-read' ? WF_UI.icons.file : WF_UI.icons.log, { size: 14 })),
  WF_H('div', {
    className: 'zwf-ws-main',
    role: 'button',
    tabIndex: 0,
    'aria-expanded': open,
    onClick: () => onToggle?.(node.key),
    onKeyDown: (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onToggle?.(node.key);
    },
  },
  WF_H('div', { className: 'zwf-ws-head' },
    WF_H('span', { className: 'zwf-ws-verb' }, wfWorkspaceVerb(t, node)),
    WF_H('span', { className: 'zwf-ws-subject zwf-mono', title: subject }, subject),
    WF_H('span', { className: `zwf-chevron${open ? ' zwf-chevron-open' : ''}`, 'aria-hidden': 'true' }, WF_H(WF_UI.icons.chevronRight, { size: 12 }))),
  WF_H('div', { className: 'zwf-ws-result', 'data-testid': 'workflow-workspace-result' },
    WF_H('span', { className: `zwf-ws-status zwf-ws-status-${tone}`, 'data-testid': 'workflow-workspace-status' },
      node.status === 'running' ? WF_H('span', { className: 'zwf-lamp zwf-lamp-running' }) : null,
      node.status === 'failed' ? WF_H(WF_UI.icons.alert, { size: 11 }) : null,
      node.status === 'completed' ? WF_H(WF_UI.icons.check, { size: 11 }) : null),
    parts.map((part, index) => WF_H('span', { key: String(index), className: 'zwf-ws-part zwf-mono' }, part)),
    node.error?.code === undefined ? null : WF_H('span', { className: 'zwf-ws-part zwf-ws-part-error zwf-mono' }, node.error.code)),
  node.status === 'completed' && !open && parts.length === 0
    ? WF_H('span', { className: 'zwf-ws-peek', 'data-testid': 'workflow-workspace-peek' }, WF_UI.say(t, UI_EN, 'script.result.empty'))
    : null,
  open
    ? WF_H('div', { className: 'zwf-ws-body', 'data-testid': 'workflow-workspace-card-body' },
      WF_H('div', { className: 'zwf-ws-command' },
        WF_H('span', { className: 'zwf-ws-prompt zwf-mono' }, '$'),
        WF_H('pre', { className: 'zwf-ws-command-text' }, [node.op ?? '', ...node.args.map((value) => (typeof value === 'string' ? value : WF_UI.json(value)))].join(' ')),
        node.inputTruncated
          ? WF_H('span', { className: 'zwf-ws-args-truncated', 'data-testid': 'workflow-workspace-truncated' }, WF_UI.say(t, UI_EN, 'script.args.truncated'))
          : null),
      WF_H(WfWorkspaceResult, { node, t, result }),
      stderr === ''
        ? null
        : WF_H('pre', { className: 'zwf-ws-stderr', 'data-testid': 'workflow-workspace-stderr' },
          WF_H('span', { className: 'zwf-ws-stderr-label' }, WF_UI.say(t, UI_EN, 'script.result.stderr')),
          stderr),
      result.kind === 'loaded' && result.truncated === true
        ? WF_H('p', { className: 'zwf-ws-note' }, WF_UI.say(t, UI_EN, 'script.result.truncated', { shown: stdout.length, total: result.totalBytes ?? '' }))
        : null,
      WF_H('div', { className: 'zwf-ws-footer', 'data-testid': 'workflow-workspace-card-footer' },
        WF_H('span', { className: 'zwf-ws-parts' }, parts.join(' · ')),
        node.status === 'completed' && node.summary?.exitCode === 0
          ? WF_H('span', { className: 'zwf-ws-replayed', 'data-testid': 'workflow-workspace-replayed', title: WF_UI.say(t, UI_EN, 'script.status.replayedHint') }, WF_UI.say(t, UI_EN, 'script.status.replayed'))
          : null,
        WF_H('button', { type: 'button', className: 'zwf-link', 'data-testid': 'workflow-workspace-copy', onClick: copy },
          copied ? WF_UI.say(t, UI_EN, 'run.artifacts.copied') : WF_UI.say(t, UI_EN, 'run.artifacts.copy'))))
    : null),
  WF_H('span', { className: 'zwf-ws-when zwf-mono', 'data-testid': 'workflow-workspace-when' },
    node.status === 'running'
      ? WF_H(WF_FRAGMENT, null, WF_H('span', { className: 'zwf-lamp zwf-lamp-running' }), WF_UI.say(t, UI_EN, 'script.now'))
      : wfWorkspaceOffset(origin, node.createdAt)));
}

/** One chapter: a phase (and its round) with the operations it issued. */
function WfWorkspaceChapter(props) {
  const { chapter, t } = props;
  const duration = chapter.startedAt === undefined || chapter.endedAt === undefined
    ? ''
    : WF_UI.duration(chapter.startedAt, chapter.endedAt);
  return WF_H('section', { className: 'zwf-ws-chapter', 'data-testid': 'workflow-workspace-chapter' },
    WF_H('div', { className: 'zwf-ws-chapter-head' },
      WF_H('span', { className: 'zwf-ws-chapter-name' },
        chapter.name === '' ? WF_UI.say(t, UI_EN, 'graph.phase.unphased') : chapter.name),
      chapter.round > 1
        ? WF_H('span', { className: 'zwf-ws-round', title: WF_UI.say(t, UI_EN, 'timeline.rounds', { count: chapter.round }) },
          WF_H(WF_UI.icons.clock, { size: 10 }),
          WF_H('span', { className: 'zwf-mono' }, String(chapter.round)))
        : null,
      WF_H('span', { className: 'zwf-ws-rule' }),
      WF_H('span', { className: 'zwf-ws-chapter-meta zwf-mono' },
        WF_UI.say(t, UI_EN, chapter.nodes.length === 1 ? 'script.summary.steps.one' : 'script.summary.steps', { count: chapter.nodes.length }),
        duration === '' ? '' : ` · ${duration}`)),
    chapter.nodes.map((node) => WF_H(WfWorkspaceCard, {
      key: node.key,
      node,
      t,
      scope: props.scope,
      origin: props.origin,
      delay: props.delayOf(node),
      open: props.opened?.has(node.key) === true,
      onToggle: props.onToggle,
    })));
}

/** Load the workspace ledger of one run, refreshed whenever the run records a new event. */
function useWfWorkspace(scope, refreshKey) {
  const [state, setState] = React.useState({ nodes: [], truncated: false, unavailable: false, loading: true, error: undefined });
  const [revision, setRevision] = React.useState(0);
  const sessionId = scope?.sessionId;
  const runId = scope?.runId;
  React.useEffect(() => {
    if (typeof sessionId !== 'string' || typeof runId !== 'string') {
      setState({ nodes: [], truncated: false, unavailable: true, loading: false, error: undefined });
      return undefined;
    }
    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
    WF_API.runWorkspace({ sessionId, runId }).then((payload) => {
      if (cancelled) return;
      const rows = Array.isArray(payload?.nodes) ? payload.nodes : [];
      setState({
        nodes: rows.map(wfWorkspaceNode),
        truncated: payload?.truncated === true,
        unavailable: payload?.unavailable === true,
        loading: false,
        error: undefined,
      });
    }).catch((error) => {
      if (cancelled) return;
      setState({ nodes: [], truncated: false, unavailable: false, loading: false, error });
    });
    return () => { cancelled = true; };
  }, [sessionId, runId, refreshKey, revision]);
  return { ...state, reload: () => setRevision((value) => value + 1) };
}

/**
 * The script-steps pane.
 * @param {{ t: Function, params?: { runId?: string, sessionId?: string, workflowName?: string, projectRoot?: string },
 *   run?: object, visible?: boolean }} props
 */
function WfWorkspacePane(props) {
  const { t, params } = props;
  const sessionId = wfText(params?.sessionId) ?? wfText(props.scope?.sessionId);
  const runId = wfText(params?.runId);
  const scope = React.useMemo(() => ({ sessionId, runId }), [sessionId, runId]);
  const refreshKey = wfNum(props.run?.lastEventSequence) ?? 0;
  const workspace = useWfWorkspace(scope, refreshKey);
  const listRef = React.useRef(undefined);
  const [opened, setOpened] = React.useState(() => new Set());
  const [loadedCount, setLoadedCount] = React.useState(0);
  React.useEffect(() => {
    if (!workspace.loading && workspace.nodes.length > 0 && loadedCount === 0) setLoadedCount(workspace.nodes.length);
  }, [workspace.loading, workspace.nodes.length, loadedCount]);
  const chapters = React.useMemo(() => wfWorkspaceChapters(workspace.nodes), [workspace.nodes]);
  const origin = workspace.nodes.reduce((min, node) => (node.createdAt === undefined ? min : Math.min(min, node.createdAt)), Infinity);
  const delayOf = React.useCallback((node) => {
    const index = workspace.nodes.indexOf(node);
    if (index < 0 || index >= loadedCount) return 0;
    return Math.min(WF_WORKSPACE_STAGGER_MAX_MS, index * WF_WORKSPACE_STAGGER_MS);
  }, [workspace.nodes, loadedCount]);
  const toggle = React.useCallback((key) => {
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // The card a click lands on is brought to the top of the ledger once it has expanded.
    if (typeof requestAnimationFrame === 'function' && listRef.current !== null && listRef.current !== undefined) {
      requestAnimationFrame(() => {
        const node = listRef.current?.querySelector(`[data-card-key="${key}"]`);
        node?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      });
    }
  }, []);
  const statusWord = WF_UI.statusText(t, UI_EN, wfDetailRunStatus(props.run));
  const phases = new Set(workspace.nodes.map((node) => node.phaseName).filter(Boolean)).size;
  const elapsed = wfDuration(props.run?.createdAt, props.run?.finishedAt ?? Date.now());
  const header = WF_H('header', { className: 'zwf-ws-head-block' },
    WF_H('div', { className: 'zwf-ws-headline' },
      WF_H('span', { className: 'zwf-ws-brand' }, WF_H(WF_UI.icons.log, { size: 15 })),
      WF_H('div', { className: 'zwf-ws-titles' },
        WF_H('span', { className: 'zwf-ws-eyebrow' }, WF_UI.say(t, UI_EN, 'script.title')),
        WF_H('span', { className: 'zwf-ws-title', 'data-testid': 'workflow-workspace-title' },
          wfDetailRunName(props.run, params) ?? WF_UI.say(t, UI_EN, 'script.title'))),
      WF_H('span', {
        className: `zwf-ws-run-status zwf-status-word zwf-status-word-${WF_UI.statusTone(wfDetailRunStatus(props.run))}`,
        'data-testid': 'workflow-workspace-run-status',
      }, statusWord)),
    WF_H('div', { className: 'zwf-ws-summary', 'data-testid': 'workflow-workspace-summary' },
      WF_H('span', {}, WF_UI.say(t, UI_EN, phases === 1 ? 'script.summary.phases.one' : 'script.summary.phases', { count: phases })),
      WF_H('span', { className: 'zwf-ws-dot', 'aria-hidden': 'true' }),
      WF_H('span', {}, WF_UI.say(t, UI_EN, workspace.nodes.length === 1 ? 'script.summary.steps.one' : 'script.summary.steps', { count: workspace.nodes.length })),
      elapsed === '' ? null : WF_H('span', { className: 'zwf-ws-dot', 'aria-hidden': 'true' }),
      elapsed === '' ? null : WF_H('span', { className: 'zwf-mono' }, elapsed)));
  let body;
  if (workspace.error !== undefined) {
    body = WF_H('div', { className: 'zwf-ws-state', 'data-testid': 'workflow-workspace-error' },
      WF_H(WF_UI.ErrorNotice, {
        message: WF_UI.say(t, UI_EN, 'script.loadFailed', { error: wfText(workspace.error.message) ?? '' }),
        onRetry: workspace.reload,
        retryLabel: WF_UI.say(t, UI_EN, 'ui.retry'),
      }));
  } else if (workspace.unavailable) {
    body = WF_H('div', { className: 'zwf-ws-state', 'data-testid': 'workflow-workspace-unavailable' },
      WF_H(WF_UI.EmptyState, {
        icon: WF_H(WF_UI.icons.log, { size: 18 }),
        title: WF_UI.say(t, UI_EN, 'script.unavailable'),
      }));
  } else if (workspace.loading) {
    body = WF_H('div', { className: 'zwf-empty-inline' }, WF_H(WF_UI.Spinner, { inline: true }), WF_UI.say(t, UI_EN, 'script.result.loading'));
  } else if (workspace.nodes.length === 0) {
    body = WF_H('div', { className: 'zwf-ws-state', 'data-testid': 'workflow-workspace-not-started' },
      WF_H(WF_UI.EmptyState, {
        icon: WF_H(WF_UI.icons.log, { size: 18 }),
        title: WF_UI.say(t, UI_EN, 'script.notStarted.title'),
        body: WF_UI.say(t, UI_EN, 'script.notStarted.body'),
      }));
  } else {
    body = WF_H('div', { className: 'zwf-ws-list', 'data-testid': 'workflow-workspace-list', ref: listRef },
      chapters.map((chapter) => WF_H(WfWorkspaceChapter, {
        key: chapter.key,
        chapter,
        t,
        scope,
        origin: Number.isFinite(origin) ? origin : undefined,
        opened,
        toggle,
        onToggle: toggle,
        delayOf,
      })),
      workspace.truncated
        ? WF_H('p', { className: 'zwf-ws-truncated', 'data-testid': 'workflow-workspace-truncated' }, WF_UI.say(t, UI_EN, 'script.listTruncated', { count: workspace.nodes.length }))
        : null);
  }
  return WF_H('div', {
    className: 'zwf-ws',
    'data-testid': 'workflow-workspace',
    'data-workflow-run-id': runId,
  },
  WF_H('div', { className: 'zwf-ws-pane', 'data-testid': 'workflow-workspace-pane' }, header, body));
}
