/* Session header entry: the open session's workflow runs.
 *
 * Registers one `conversation.session.header.utilities` list item (id `workflow-status`, order -4)
 * and renders a compact trigger with a non-portal panel beside it: running runs first, the most
 * recent ended runs below, and a footer that opens the workflow directory. A session without runs
 * renders nothing at all, and a failing route only warns in the console — this entry sits in every
 * session header, so it must never grow a permanent error banner. */

/** The session status entry: `register(ctx, effect)` is called by the client entry. */
const WF_STATUS = {};

/** Runs requested per poll; the header only needs one screen of history. */
const WF_STATUS_RUN_LIMIT = 20;
/** Poll interval for the session's run catalog. */
const WF_STATUS_POLL_MS = 5000;
/** Ended runs listed in the panel; the directory holds the full history. */
const WF_STATUS_ENDED_ROWS = 5;

/**
 * Live UI-dictionary translator, bound when the header entry registers.
 * The tool card renders `card.detailAction` from the same dictionary, and a card cannot bind a
 * second namespace by itself.
 */
var WF_STATUS_UI = undefined;

/** One console warning per distinct failure, so a failing route cannot flood a busy session. */
const WF_STATUS_WARNED = new Set();

/** UI copy with the English dictionary as the fallback. */
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

/** Open one run in the right Sidebar detail. False while the detail surface is unavailable. */
function wfStatusOpenRun(runId, sessionId) {
  if (typeof runId !== 'string' || runId === '') return false;
  if (typeof WF_DETAIL !== 'object' || WF_DETAIL === null || typeof WF_DETAIL.open !== 'function') return false;
  try {
    WF_DETAIL.open({ runId, sessionId });
    return true;
  } catch (error) {
    wfStatusWarn('run detail', error);
    return false;
  }
}

/* ---------------------------------- readers --------------------------------- */

/** One run object from the wire, when it is an object. */
function wfStatusRunRow(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/** One finite timestamp, or 0. */
function wfStatusTime(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? time : 0;
}

/** When a run settled: its finish time, or its start time while it has none. */
function wfStatusSettledAt(run) {
  const finished = wfStatusTime(run.finishedAt);
  return finished > 0 ? finished : wfStatusTime(run.createdAt);
}

/**
 * Split one `/runs` payload into the two groups the panel shows.
 * Running runs keep their start order; ended runs are newest first and capped.
 * @param {unknown} payload `{ runs, truncated }` response body
 * @returns {{ running: object[], ended: object[], endedTotal: number }} grouped rows
 */
function wfStatusRunGroups(payload) {
  const rows = wfStatusRunRow(payload) !== undefined && Array.isArray(payload.runs) ? payload.runs : [];
  const running = [];
  const ended = [];
  for (const row of rows) {
    const run = wfStatusRunRow(row);
    if (run === undefined) continue;
    if (typeof run.id !== 'string' || run.id === '') continue;
    if (run.status === 'running' || run.status === 'pending') running.push(run);
    else ended.push(run);
  }
  running.sort((left, right) => wfStatusTime(left.createdAt) - wfStatusTime(right.createdAt));
  ended.sort((left, right) => wfStatusSettledAt(right) - wfStatusSettledAt(left));
  return { running, ended: ended.slice(0, WF_STATUS_ENDED_ROWS), endedTotal: ended.length };
}

const WF_STATUS_WORDS = {
  pending: 'status.run.pending',
  running: 'status.run.running',
  completed: 'status.run.completed',
  errored: 'status.run.errored',
  stopped: 'status.run.stopped',
  superseded: 'status.run.superseded',
};

/** Localized status word of one run row. */
function wfStatusRunWord(say, status) {
  return say(WF_STATUS_WORDS[status] ?? 'status.run.unknown');
}

/** Display name of one run row; an unnamed run keeps the product fallback. */
function wfStatusRunName(say, run) {
  return typeof run.name === 'string' && run.name.trim() !== '' ? run.name : say('status.name.fallback');
}

/* -------------------------------- rendering -------------------------------- */

/** One run row: open its detail, and stop it while it is live. */
function WfStatusRun(props) {
  const run = props.run;
  const live = run.status === 'running' || run.status === 'pending';
  const settledAt = wfStatusSettledAt(run);
  const time = run.status === 'running'
    ? WF_UI.duration(run.createdAt, props.now)
    : live || settledAt === 0
      ? ''
      : WF_UI.relative(props.translate, UI_EN, settledAt, props.now);
  const name = wfStatusRunName(props.say, run);
  const word = wfStatusRunWord(props.say, run.status);
  const tone = WF_UI.statusTone(run.status);
  const label = `${props.say('card.detailAction')} · ${name} · ${word}`;
  const stopping = props.stopping === true;

  return WF_H('li', {
    className: 'zwf-runs-row',
    'data-workflow-run-id': run.id,
    'data-workflow-run-status': typeof run.status === 'string' ? run.status : 'unknown',
  },
  WF_H('button', {
    type: 'button',
    className: 'zwf-runs-open',
    'aria-label': label,
    title: name,
    onClick: () => props.onOpen(run),
  },
  WF_H(WF_UI.StatusDot, { tone }),
  WF_H('span', { className: 'zwf-runs-name' }, name),
  WF_H('span', { className: `zwf-status-word zwf-status-word-${tone}` }, word),
  time === '' ? null : WF_H('span', { className: 'zwf-runs-time' }, time)),
  props.showStop === true
    ? WF_H('button', {
      type: 'button',
      className: 'zwf-runs-stop',
      disabled: stopping,
      'aria-label': props.say(stopping ? 'status.stop.pending' : 'status.stop.aria'),
      title: props.say('status.stop.aria'),
      onClick: (event) => {
        event.stopPropagation();
        props.onStop(run);
      },
    },
    stopping ? WF_H(WF_UI.Spinner) : WF_H(WF_UI.icons.stop, { size: 11 }),
    WF_H('span', { className: 'zwf-runs-stop-label' }, props.say(stopping ? 'status.stop.pending' : 'status.stop')))
    : null);
}

/**
 * The session header entry.
 * @param {object} props slot standard props: `sessionId`, `t`, and the injected `openDirectory`
 */
function WorkflowStatusEntry(props) {
  const safe = wfStatusRunRow(props) !== undefined;
  const sessionId = safe && typeof props.sessionId === 'string' ? props.sessionId : '';
  const translate = safe ? props.t : undefined;
  const openDirectory = safe && typeof props.openDirectory === 'function' ? props.openDirectory : undefined;
  const say = (key, params) => WF_UI.say(translate, UI_EN, key, params);

  const [open, setOpen] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const [confirming, setConfirming] = React.useState(undefined);
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
  const { data, reload } = useWfPolling(load, [sessionId], WF_STATUS_POLL_MS);
  const groups = React.useMemo(() => wfStatusRunGroups(data), [data]);
  const running = groups.running;
  const live = running.length > 0;

  React.useEffect(() => {
    setOpen(false);
    setConfirming(undefined);
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
      if (event.key !== 'Escape' || confirming !== undefined) return;
      setOpen(false);
      if (triggerRef.current !== null) triggerRef.current.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, confirming]);

  const openRun = (run) => {
    if (wfStatusOpenRun(run.id, sessionId)) setOpen(false);
  };
  const requestStop = (run) => setConfirming(run);
  const closeConfirm = () => setConfirming(undefined);
  const confirmStop = () => {
    const run = confirming;
    closeConfirm();
    if (run === undefined) return;
    setStopping(run.id);
    WF_API.stopRun({ sessionId, runId: run.id })
      .catch((error) => wfStatusWarn('stop run', error))
      .then(() => {
        setStopping('');
        reload();
      });
  };

  if (sessionId === '' || (running.length === 0 && groups.endedTotal === 0)) return null;

  const triggerLabel = say('status.trigger.aria', { running: running.length, ended: groups.endedTotal });
  const rows = (list, withStop) => WF_H('ul', { className: 'zwf-runs-list' },
    list.map((run) => WF_H(WfStatusRun, {
      key: run.id,
      run,
      now,
      say,
      translate,
      showStop: withStop,
      stopping: stopping === run.id,
      onOpen: openRun,
      onStop: requestStop,
    })));

  const groupsContent = [];
  if (running.length > 0) {
    groupsContent.push(WF_H('div', { className: 'zwf-runs-group', key: 'running' },
      WF_H('div', { className: 'zwf-runs-head' },
        WF_H('span', { className: 'zwf-runs-head-label' }, say('status.group.running')),
        WF_H('span', { className: 'zwf-runs-head-count' }, String(running.length))),
      rows(running, true)));
  }
  if (groups.ended.length > 0) {
    groupsContent.push(WF_H('div', { className: 'zwf-runs-group', key: 'ended' },
      WF_H('div', { className: 'zwf-runs-head' },
        WF_H('span', { className: 'zwf-runs-head-label' }, say('status.group.ended')),
        WF_H('span', { className: 'zwf-runs-head-count' }, String(groups.endedTotal))),
      rows(groups.ended, false)));
  }

  const footer = typeof openDirectory === 'function'
    ? WF_H('button', {
      type: 'button',
      className: 'zwf-runs-foot',
      onClick: () => {
        setOpen(false);
        openDirectory();
      },
    },
    WF_H('span', { className: 'zwf-runs-foot-glyph' }, WF_H(WF_UI.icons.folder, { size: 15 })),
    WF_H('span', { className: 'zwf-runs-foot-label' }, say('status.openDirectory')),
    WF_H('span', { className: 'zwf-runs-foot-glyph zwf-runs-foot-end' }, WF_H(WF_UI.icons.chevronRight, { size: 14 })))
    : null;

  const trigger = WF_H('button', {
    ref: triggerRef,
    type: 'button',
    className: 'zwf-runs-trigger',
    'data-workflow-status-entry': 'true',
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
  WF_H(WF_UI.icons.workflow, { size: 16 }),
  running.length > 0 ? WF_H('span', { className: 'zwf-runs-count' }, String(running.length)) : null);

  const panel = open
    ? WF_H('div', { className: 'zwf-runs-menu', role: 'dialog', 'aria-label': say('status.menu.aria') }, groupsContent, footer)
    : null;

  const confirmedRun = confirming;
  const dialog = WF_H(WF_UI.Modal, {
    open: confirmedRun !== undefined,
    title: say('status.stop.title'),
    closeLabel: say('ui.close'),
    onClose: closeConfirm,
    footer: [
      WF_H(WF_UI.Button, { key: 'cancel', variant: 'ghost', onClick: closeConfirm }, say('ui.cancel')),
      WF_H(WF_UI.Button, { key: 'stop', variant: 'danger', onClick: confirmStop }, say('status.stop.confirm')),
    ],
  },
  WF_H('p', { className: 'zwf-runs-confirm' }, say('status.stop.body')),
  confirmedRun === undefined ? null : WF_H('p', { className: 'zwf-runs-confirm-name' }, wfStatusRunName(say, confirmedRun)));

  return WF_H('div', { className: 'zwf-runs-anchor', ref: rootRef }, trigger, panel, dialog);
}

/* -------------------------------- registration ------------------------------- */

/**
 * Register the session header entry.
 * @param {object} ctx client plugin context
 * @param {(callback: () => (() => void) | void, label?: string) => void} effect effect registrar
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
          service.selectPanel('zcode-workflow');
        } catch (error) {
          wfStatusWarn('open workflow directory', error);
        }
      },
    }),
  }, WorkflowStatusEntry));
};

/* ----------------------------------- styles ---------------------------------- */

const WF_STATUS_CSS = `
.zwf-runs-anchor{position:relative;display:inline-flex;align-items:center;flex:none}
.zwf-runs-trigger{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;min-width:28px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;transition:background-color .12s,color .12s}
.zwf-runs-trigger:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-primary)}
.zwf-runs-trigger[aria-expanded=true]{background:color-mix(in oklab,var(--dsw-alias-label-primary) 9%,transparent);color:var(--dsw-alias-label-primary)}
.zwf-runs-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.zwf-runs-count{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px;line-height:16px;font-weight:600;font-variant-numeric:tabular-nums}
.zwf-runs-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:70;box-sizing:border-box;display:flex;flex-direction:column;width:min(320px,calc(100vw - 24px));max-height:min(420px,60vh);overflow-y:auto;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 36px rgb(0 0 0 / .18)}
.zwf-runs-group{display:flex;flex-direction:column;min-width:0;padding:2px 0}
.zwf-runs-head{display:flex;align-items:center;gap:6px;padding:6px 8px 4px;font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.zwf-runs-head-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-runs-head-count{margin-left:auto;flex:none;font-weight:500;font-variant-numeric:tabular-nums}
.zwf-runs-list{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none}
.zwf-runs-row{display:flex;align-items:center;gap:2px;min-width:0;border-radius:var(--dsw-radius-sm,8px)}
.zwf-runs-row:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,transparent)}
.zwf-runs-open{box-sizing:border-box;display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.zwf-runs-open:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.zwf-runs-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.zwf-runs-open .zwf-status-word{flex:none}
.zwf-runs-time{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.zwf-runs-stop{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;height:24px;padding:0 6px;margin-right:2px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.zwf-runs-stop:hover:not(:disabled){background:color-mix(in oklab,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary)}
.zwf-runs-stop:disabled{opacity:.6;cursor:default}
.zwf-runs-stop:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-runs-stop .zwf-spinner{width:12px;height:12px}
.zwf-runs-stop-label{white-space:nowrap}
.zwf-runs-foot{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;margin-top:2px;padding:8px;border:0;border-top:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;border-radius:0 0 var(--dsw-radius-sm,8px) var(--dsw-radius-sm,8px)}
.zwf-runs-foot:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,transparent)}
.zwf-runs-foot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.zwf-runs-foot-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.zwf-runs-foot-label{flex:1;min-width:0}
.zwf-runs-foot-end{margin-left:auto}
.zwf-runs-confirm{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.zwf-runs-confirm-name{margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
`;

WF_STYLE_PARTS.push(WF_STATUS_CSS);
