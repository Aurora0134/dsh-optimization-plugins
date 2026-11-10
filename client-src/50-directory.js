/* Main-panel workflow hub: the saved workflows of the open project, their detail, and the
 * dialogs that start, move or delete one.
 *
 * The hub is two surfaces in one panel: the list of saved workflows (project scope plus the global
 * scope every project can see) and the detail of one entry, with its definition and its run
 * history. Starting a saved workflow opens a new conversation in the target project and hands the
 * agent the arguments, because a run in this port always belongs to a conversation.
 */

const WF_DIRECTORY = {};

/** Panel key shared by the `main` slot and its `sidebar.panellist` entry. */
const WF_DIRECTORY_PANEL_ID = 'zcode-workflow';

/** Sidebar position: after the shipped task panel. */
const WF_DIRECTORY_ORDER = 20;

/** Runs requested for one workflow's history tab. */
const WF_HUB_HISTORY_LIMIT = 20;

/** Argument chips a list card shows before the rest collapse into a counter. */
const WF_HUB_ARG_CHIPS = 3;

/** How long a confirmation line stays on screen. */
const WF_HUB_TOAST_MS = 2600;

/** Declaration types the metadata editor offers. */
const WF_HUB_ARG_TYPES = ['string', 'number', 'boolean', 'json'];

/** Copy from the hub dictionary, with the compiled English text as fallback. */
function wfHubSay(t, key, params) {
  return WF_UI.say(t, UI_EN, key, params);
}

/** Pick a `…One` variant when the count is exactly one and the fragment carries one. */
function wfHubCountSay(t, key, count, params) {
  const oneKey = `${key}One`;
  const useOne = count === 1 && Object.prototype.hasOwnProperty.call(UI_EN, oneKey);
  return wfHubSay(t, useOne ? oneKey : key, { ...(params ?? {}), count });
}

/* -------------------------------- workspace -------------------------------- */

/**
 * Workspace rows that carry a usable project directory.
 * @param {object | undefined} snapshot `useWorkspaces` snapshot: `{ phase, items }`
 * @returns {{ key: string, workspaceId: string | undefined, path: string, title: string }[]}
 */
function wfHubWorkspaces(snapshot) {
  const items = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.items) ? snapshot.items : [];
  const seen = new Set();
  const rows = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const path = typeof item.path === 'string' ? item.path.trim() : '';
    if (path === '' || seen.has(path)) continue;
    seen.add(path);
    const workspaceId = typeof item.workspaceId === 'string' && item.workspaceId !== '' ? item.workspaceId : undefined;
    rows.push({
      key: workspaceId ?? path,
      workspaceId,
      path,
      title: typeof item.title === 'string' ? item.title.trim() : '',
    });
  }
  return rows;
}

function wfHubBasename(value) {
  const text = String(value).replace(/[\\/]+$/u, '');
  const parts = text.split(/[\\/]/u);
  const last = parts[parts.length - 1];
  return last === undefined || last === '' ? text : last;
}

function wfHubWorkspaceLabel(t, row) {
  if (row === undefined || row === null) return '';
  if (row.title === 'default-workspace') return wfHubSay(t, 'workflows.hub.group.current');
  if (row.title !== '') return row.title;
  return wfHubBasename(row.path);
}

/** The Cordis service that opens a new conversation; absent in lighter profiles. */
function wfHubWorkspaceService(ctx) {
  let service;
  if (typeof ctx?.get === 'function') {
    try {
      service = ctx.get('uiWorkspace');
    } catch {
      service = undefined;
    }
  }
  if (service === undefined || service === null) {
    try {
      service = ctx?.uiWorkspace;
    } catch {
      service = undefined;
    }
  }
  return service !== null && typeof service === 'object' ? service : undefined;
}

/** The layout service, resolved lazily so this part needs no extra injection. */
function wfHubLayoutService(ctx) {
  let service;
  if (typeof ctx?.get === 'function') {
    try {
      service = ctx.get('layout');
    } catch {
      service = undefined;
    }
  }
  if (service === undefined || service === null) {
    try {
      service = ctx?.layout;
    } catch {
      service = undefined;
    }
  }
  return service !== null && typeof service === 'object' ? service : undefined;
}

/* --------------------------------- entries --------------------------------- */

/** One saved-workflow row, in whichever shape the host published it. */
function wfHubEntry(raw, fallbackScope) {
  const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined;
  if (record === undefined) return undefined;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (name === '') return undefined;
  const scope = record.scope === 'global' || fallbackScope === 'global' ? 'global' : 'project';
  const args = record.args !== null && typeof record.args === 'object' && !Array.isArray(record.args) ? record.args : {};
  return {
    name,
    scope,
    path: typeof record.path === 'string' ? record.path : '',
    description: typeof record.description === 'string' ? record.description.trim() : '',
    whenToUse: typeof record.whenToUse === 'string' ? record.whenToUse.trim() : '',
    args,
    lastRun: record.lastRun ?? record.latestRun ?? record.run,
    raw: record,
  };
}

/** The run summary a card may show, normalized to the five states the badge knows. */
function wfHubRunState(run) {
  const record = run !== null && typeof run === 'object' ? run : undefined;
  if (record === undefined) return 'never';
  const status = typeof record.status === 'string' ? record.status : '';
  if (status === 'pending' || status === 'running') return 'running';
  if (status === 'errored' || status === 'failed') return 'errored';
  if (status === 'stopped' || status === 'cancelled') return 'stopped';
  if (status === 'completed') return 'completed';
  return 'never';
}

/** One run row's identity, in either spelling. */
function wfHubRunId(row) {
  const record = row !== null && typeof row === 'object' ? row : undefined;
  if (record === undefined) return '';
  for (const value of [record.runId, record.id]) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/** Whatever timestamp a run row carries, newest field first. */
function wfHubRunTime(row) {
  const record = row !== null && typeof row === 'object' ? row : undefined;
  if (record === undefined) return 0;
  for (const value of [record.updatedAt, record.finishedAt, record.createdAt, record.startedAt]) {
    const time = Number(value);
    if (Number.isFinite(time) && time > 0) return time;
  }
  return 0;
}

/** Duration copy of one history row. */
function wfHubDuration(t, run) {
  const record = run !== null && typeof run === 'object' ? run : {};
  const from = Number(record.createdAt ?? record.startedAt);
  const to = Number(record.updatedAt ?? record.finishedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return '';
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return wfHubSay(t, 'workflows.hub.time.duration.seconds', { seconds });
  const minutes = Math.floor(seconds / 60);
  return wfHubSay(t, 'workflows.hub.time.duration.minutes', { minutes, seconds: seconds % 60 });
}

/** Localized status word of one run row. */
function wfHubRunStatusWord(t, run) {
  const status = typeof run?.status === 'string' ? run.status : 'unknown';
  const key = `chat.toolCall.workflow.run.status.${status}`;
  return Object.prototype.hasOwnProperty.call(UI_EN, key)
    ? wfHubSay(t, key)
    : wfHubSay(t, 'chat.toolCall.workflow.card.ended');
}

/** Localized stop reason, when the run recorded one. */
function wfHubStopReasonWord(t, run) {
  const reason = typeof run?.stopReason === 'string' ? run.stopReason : '';
  const key = `chat.toolCall.workflow.run.stopReason.${reason}`;
  return Object.prototype.hasOwnProperty.call(UI_EN, key) ? wfHubSay(t, key) : '';
}

/** Argument names of one entry, in declaration order. */
function wfHubArgNames(entry) {
  return Object.keys(entry?.args ?? {});
}

/** Copy text to the clipboard; resolves false when the browser refuses. */
async function wfHubCopyText(text) {
  if (typeof text !== 'string' || text === '') return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** One console warning per distinct failure. */
function wfHubWarn(scope, error) {
  console.warn(`zcode-workflow: ${scope} failed`, error);
}

/* --------------------------------- readers --------------------------------- */

/** Normalize one `/workflows/list` body into the two groups the page shows. */
function wfHubGroupPayload(payload, fallbackScope) {
  const record = payload !== null && typeof payload === 'object' ? payload : {};
  const rowsRaw = Array.isArray(record.workflows) ? record.workflows : Array.isArray(record.entries) ? record.entries : [];
  const entries = [];
  for (const row of rowsRaw) {
    const entry = wfHubEntry(row, fallbackScope);
    if (entry !== undefined) entries.push(entry);
  }
  const invalidRaw = Array.isArray(record.invalid) ? record.invalid : [];
  const invalid = [];
  for (const row of invalidRaw) {
    if (row === null || typeof row !== 'object') continue;
    invalid.push({
      path: typeof row.path === 'string' ? row.path : '',
      reason: typeof row.reason === 'string' ? row.reason : '',
    });
  }
  return { entries, invalid };
}

/** A declaration row of the metadata editor. */
function wfHubArgRows(args) {
  const rows = [];
  const source = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
  for (const [name, raw] of Object.entries(source)) {
    const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const type = typeof record.type === 'string' && WF_HUB_ARG_TYPES.includes(record.type) ? record.type : 'string';
    rows.push({
      key: `${name}:${String(rows.length)}`,
      name,
      type,
      required: record.required === true,
      value: wfHubDefaultText(type, record.default),
      description: typeof record.description === 'string' ? record.description : '',
    });
  }
  return rows;
}

/** One default value as editable text. */
function wfHubDefaultText(type, value) {
  if (value === undefined || value === null) return '';
  if (type === 'boolean') return value === true || value === 'true' ? 'true' : 'false';
  if (type === 'json') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

/**
 * Validate the declaration rows and turn them into the wire shape.
 * @returns {{ args: Record<string, unknown> | undefined, errors: Record<string, string> }}
 */
function wfHubValidateArgs(rows, t) {
  const args = {};
  const errors = {};
  const seen = new Set();
  for (const row of rows) {
    const name = row.name.trim();
    if (name === '') {
      errors[row.key] = wfHubSay(t, 'workflows.hub.detail.args.error.empty_name');
      continue;
    }
    if (seen.has(name)) {
      errors[row.key] = wfHubSay(t, 'workflows.hub.detail.args.error.duplicate_name');
      continue;
    }
    seen.add(name);
    const declaration = { type: row.type };
    if (row.required) declaration.required = true;
    if (row.description.trim() !== '') declaration.description = row.description.trim();
    const raw = row.value.trim();
    if (raw !== '') {
      if (row.type === 'number') {
        const number = Number(raw);
        if (!Number.isFinite(number)) {
          errors[row.key] = wfHubSay(t, 'workflows.hub.detail.args.error.invalid_default');
          continue;
        }
        declaration.default = number;
      } else if (row.type === 'boolean') {
        if (raw !== 'true' && raw !== 'false') {
          errors[row.key] = wfHubSay(t, 'workflows.hub.detail.args.error.invalid_default');
          continue;
        }
        declaration.default = raw === 'true';
      } else if (row.type === 'json') {
        try {
          declaration.default = JSON.parse(raw);
        } catch {
          errors[row.key] = wfHubSay(t, 'workflows.hub.detail.args.error.invalid_default');
          continue;
        }
      } else {
        declaration.default = raw;
      }
    }
    args[name] = declaration;
  }
  return { args: Object.keys(errors).length === 0 ? args : undefined, errors };
}

/* ----------------------------------- page ---------------------------------- */

/**
 * The workflow hub page.
 * @param {object} props slot props: `t`, `useWorkspaces`, injected `openChat`, `openSettings`
 */
function WfHubPage(props) {
  if (props === null || typeof props !== 'object' || typeof props.useWorkspaces !== 'function') {
    return WF_H('section', { className: 'zwf-page' },
      WF_H('div', { className: 'zwf-page-scroll' },
        WF_H('div', { className: 'zwf-page-inner' },
          WF_H(WF_UI.EmptyState, {
            icon: WF_H(WF_ICON.folder, { size: 22 }),
            title: wfHubSay(props?.t, 'workflows.hub.noWorkspace'),
          }))));
  }
  return WF_H(WfHubBody, props);
}

function WfHubBody(props) {
  const t = typeof props.t === 'function' ? props.t : undefined;
  const say = (key, params) => wfHubSay(t, key, params);
  const openChat = typeof props.openChat === 'function' ? props.openChat : undefined;
  const openSettings = typeof props.openSettings === 'function' ? props.openSettings : undefined;

  const snapshot = props.useWorkspaces((value) => value);
  const rows = React.useMemo(() => wfHubWorkspaces(snapshot), [snapshot]);
  const [selectedKey, setSelectedKey] = React.useState(null);
  const selected = React.useMemo(() => {
    const chosen = selectedKey === null ? undefined : rows.find((row) => row.key === selectedKey);
    if (chosen !== undefined) return chosen;
    return rows.find((row) => row.title === 'default-workspace') ?? rows[0];
  }, [rows, selectedKey]);
  const projectRoot = selected?.path;
  const projectLabel = wfHubWorkspaceLabel(t, selected);
  const [detail, setDetail] = React.useState(null);
  const [dialog, setDialog] = React.useState(null);
  const [toast, setToast] = React.useState(null);
  const timer = React.useRef(undefined);

  const announce = React.useCallback((text) => {
    setToast(text);
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), WF_HUB_TOAST_MS);
  }, []);
  React.useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
  }, []);

  const load = React.useCallback(async () => {
    if (typeof projectRoot !== 'string' || projectRoot === '') return { project: { entries: [], invalid: [] }, global: undefined };
    const project = await WF_API.workflows({ projectRoot });
    let global;
    try {
      global = await WF_API.workflows({ projectRoot, scope: 'global' });
    } catch (error) {
      wfHubWarn('global workflow list', error);
      global = undefined;
    }
    const projectGroup = wfHubGroupPayload(project, 'project');
    const globalGroup = global === undefined ? undefined : wfHubGroupPayload(global, 'global');
    const merged = projectGroup.entries.filter((entry) => entry.scope !== 'global');
    const globalEntries = globalGroup !== undefined
      ? globalGroup.entries
      : projectGroup.entries.filter((entry) => entry.scope === 'global');
    return {
      project: { entries: merged, invalid: projectGroup.invalid },
      global: globalGroup === undefined
        ? { entries: globalEntries, invalid: [], unsupported: true }
        : { entries: globalEntries, invalid: globalGroup.invalid },
    };
  }, [projectRoot]);
  const loaded = useWfAsync(load, [projectRoot]);
  const payload = loaded.data;
  const projectEntries = payload?.project?.entries ?? [];
  const globalGroup = payload?.global;
  const globalEntries = globalGroup?.entries ?? [];
  const invalid = [...(payload?.project?.invalid ?? []), ...(globalGroup?.invalid ?? [])];
  const workspacePhase = snapshot !== null && typeof snapshot === 'object' ? snapshot.phase : undefined;
  const workspacesPending = rows.length === 0 && workspacePhase !== 'ready';

  React.useEffect(() => {
    setDetail(null);
    setDialog(null);
  }, [projectRoot]);

  const createInChat = () => {
    if (typeof openChat !== 'function') return;
    const opened = openChat(selected?.workspaceId, say('workflows.hub.prompt.create'));
    if (opened !== true) announce(say('workflows.hub.launch.error.unsupported'));
  };

  const refresh = () => {
    loaded.reload();
    if (detail !== null) setDetail({ ...detail, revision: (detail.revision ?? 0) + 1 });
  };

  const startEntry = (entry) => setDialog({ kind: 'launch', entry });
  const openEntry = (entry) => setDetail({ entry, revision: 0 });

  const header = WF_H('div', { className: 'zwf-page-head' },
    WF_H('div', { className: 'zwf-page-titles' },
      WF_H('h1', { className: 'zwf-page-title' }, say('workflows.hub.sectionTitle')),
      WF_H('p', { className: 'zwf-page-sub' }, say('workflows.hub.description'))),
    WF_H('div', { className: 'zwf-page-actions' },
      typeof openSettings === 'function'
        ? WF_H(WF_UI.Button, { variant: 'ghost', size: 'sm', onClick: openSettings }, say('workflows.hub.openSettings'))
        : null,
      WF_H(WF_UI.Button, {
        variant: 'subtle',
        size: 'sm',
        icon: WF_H(WF_ICON.plus, { size: 14 }),
        onClick: createInChat,
      }, say('workflows.hub.createViaChat')),
      WF_H(WF_UI.IconButton, {
        icon: WF_H(WF_ICON.refresh, { size: 16 }),
        label: say('workflows.hub.refresh'),
        title: say('workflows.hub.refresh'),
        disabled: rows.length === 0 || workspacesPending || loaded.loading,
        onClick: refresh,
      })));

  const toolbar = rows.length === 0
    ? null
    : WF_H('div', { className: 'zwf-hub-toolbar' },
      WF_H('label', { className: 'zwf-hub-field' },
        WF_H('span', { className: 'zwf-hub-field-label' }, say('workflows.hub.detail.projectColumn')),
        WF_H('select', {
          className: 'zwf-hub-select',
          'data-testid': 'workflow-project-current',
          value: selected?.key ?? '',
          onChange: (event) => setSelectedKey(event.target.value),
        }, rows.map((row) => WF_H('option', { key: row.key, value: row.key }, wfHubWorkspaceLabel(t, row))))));

  const list = () => {
    if (detail !== null) {
      return WF_H(WfHubDetail, {
        key: `${detail.entry.scope}:${detail.entry.name}:${String(detail.revision ?? 0)}`,
        t,
        entry: detail.entry,
        projectRoot: projectRoot ?? '',
        projectLabel,
        workspaceId: selected?.workspaceId,
        onBack: () => setDetail(null),
        onRun: startEntry,
        onRevise: (entry) => {
          if (typeof openChat !== 'function') return;
          openChat(selected?.workspaceId, say('workflows.hub.prompt.revise', { name: entry.name }));
        },
        onDelete: (entry) => setDialog({ kind: 'delete', entry }),
        onCopyPath: async (entry) => {
          if (await wfHubCopyText(entry.path)) announce(say('workflows.hub.copied'));
        },
        onOpenRun: (run) => {
          const runId = wfHubRunId(run);
          const sessionId = typeof run?.parentSessionId === 'string' ? run.parentSessionId : undefined;
          if (runId === '' || typeof WF_DETAIL !== 'object' || WF_DETAIL === null || typeof WF_DETAIL.open !== 'function') return;
          try {
            WF_DETAIL.open({ runId, sessionId });
          } catch (error) {
            wfHubWarn('run detail', error);
          }
        },
        onSaved: (text) => {
          announce(text);
          refresh();
        },
      });
    }
    if (rows.length === 0) {
      if (workspacesPending) return WF_H('div', { className: 'zwf-hub-loading' }, WF_H(WF_UI.Spinner));
      return WF_H(WF_UI.EmptyState, {
        icon: WF_H(WF_ICON.folder, { size: 22 }),
        title: say('workflows.hub.noWorkspace'),
      });
    }
    if (loaded.loading && payload === undefined) return WF_H('div', { className: 'zwf-hub-loading' }, WF_H(WF_UI.Spinner));
    if (loaded.error !== undefined && payload === undefined) {
      return WF_H(WF_UI.ErrorNotice, {
        message: say('workflows.hub.loadError', { error: wfHubFailure(loaded.error) }),
        retryLabel: say('ui.retry'),
        onRetry: () => loaded.reload(),
      });
    }
    const nodes = [];
    if (loaded.error !== undefined) {
      nodes.push(WF_H(WF_UI.ErrorNotice, {
        key: 'error',
        message: say('workflows.hub.loadError', { error: '' }),
        retryLabel: say('ui.retry'),
        onRetry: () => loaded.reload(),
      }));
    }
    if (projectEntries.length === 0 && globalEntries.length === 0) {
      nodes.push(WF_H(WF_UI.EmptyState, {
        key: 'empty',
        icon: WF_H(WF_ICON.workflow, { size: 22 }),
        title: say('workflows.hub.empty.title'),
        body: say('workflows.hub.empty.hint'),
        action: WF_H(WF_UI.Button, {
          variant: 'primary',
          size: 'md',
          icon: WF_H(WF_ICON.plus, { size: 15 }),
          onClick: createInChat,
        }, say('workflows.hub.createViaChat')),
      }));
    } else {
      nodes.push(WF_H(WfHubGroup, {
        key: 'project',
        t,
        testId: 'workflow-list',
        title: say('workflows.hub.group.current'),
        caption: projectLabel,
        emptyText: say('workflows.hub.empty.title'),
        entries: projectEntries,
        onOpen: openEntry,
        onRun: startEntry,
        onRevise: (entry) => {
          if (typeof openChat === 'function') openChat(selected?.workspaceId, say('workflows.hub.prompt.revise', { name: entry.name }));
        },
        onCopyPath: async (entry) => {
          if (await wfHubCopyText(entry.path)) announce(say('workflows.hub.copied'));
        },
        onMove: (entry) => setDialog({ kind: 'move', entry }),
        onDelete: (entry) => setDialog({ kind: 'delete', entry }),
      }));
      nodes.push(WF_H(WfHubGroup, {
        key: 'global',
        t,
        testId: 'workflow-list-global',
        title: say('workflows.hub.global.title'),
        caption: globalGroup?.unsupported === true ? say('workflows.hub.global.unsupported') : say('workflows.hub.global.hint'),
        emptyText: say('workflows.hub.global.empty'),
        entries: globalEntries,
        onOpen: openEntry,
        onRun: startEntry,
        onRevise: (entry) => {
          if (typeof openChat === 'function') openChat(selected?.workspaceId, say('workflows.hub.prompt.revise', { name: entry.name }));
        },
        onCopyPath: async (entry) => {
          if (await wfHubCopyText(entry.path)) announce(say('workflows.hub.copied'));
        },
        onMove: (entry) => setDialog({ kind: 'move', entry }),
        onDelete: (entry) => setDialog({ kind: 'delete', entry }),
      }));
    }
    return WF_H(WF_FRAGMENT, null, nodes);
  };

  let dialogNode = null;
  if (dialog !== null && dialog.entry !== undefined) {
    if (dialog.kind === 'launch') {
      dialogNode = WF_H(WfHubLaunchDialog, {
        t,
        entry: dialog.entry,
        projectRoot: projectRoot ?? '',
        projectLabel,
        rows,
        workspaceId: selected?.workspaceId,
        openChat,
        onClose: () => setDialog(null),
        onStarted: () => setDialog(null),
      });
    } else if (dialog.kind === 'delete') {
      dialogNode = WF_H(WfHubDeleteDialog, {
        t,
        entry: dialog.entry,
        projectRoot: projectRoot ?? '',
        onClose: () => setDialog(null),
        onDeleted: () => {
          setDialog(null);
          setDetail(null);
          announce(say('workflows.hub.deleted', { name: dialog.entry.name }));
          loaded.reload();
        },
      });
    } else if (dialog.kind === 'move') {
      dialogNode = WF_H(WfHubMoveDialog, {
        t,
        entry: dialog.entry,
        projectRoot: projectRoot ?? '',
        rows,
        onClose: () => setDialog(null),
        onMoved: (target) => {
          setDialog(null);
          setDetail(null);
          announce(say('workflows.hub.move.toast.project', { project: target }));
          loaded.reload();
        },
      });
    }
  }

  return WF_H('section', { className: 'zwf-page', 'aria-label': say('workflows.hub.sectionTitle'), 'data-testid': 'workflow-hub-page' },
    WF_H('div', { className: 'zwf-page-scroll' },
      WF_H('div', { className: 'zwf-page-inner' },
        header,
        toolbar,
        invalid.length > 0
          ? WF_H('div', { className: 'zwf-hub-warn', role: 'status' },
            WF_H('span', { className: 'zwf-hub-warn-glyph' }, WF_H(WF_ICON.alert, { size: 15 })),
            WF_H('div', { className: 'zwf-hub-warn-main' },
              WF_H('p', { className: 'zwf-hub-warn-title' }, wfHubCountSay(t, 'workflows.hub.invalid', invalid.length)),
              invalid.map((row, index) => WF_H('p', { className: 'zwf-hub-warn-line', key: `${row.path}:${String(index)}` },
                `${row.path} \u2014 ${wfHubReasonWord(t, row.reason)}`))))
          : null,
        toast === null ? null : WF_H('div', { className: 'zwf-hub-toast', role: 'status' }, toast),
        WF_H('div', { className: 'zwf-hub-content' }, list()))),
    dialogNode);
}

/** One file-level failure reason. */
function wfHubReasonWord(t, reason) {
  const key = `workflows.hub.reason.${reason}`;
  return Object.prototype.hasOwnProperty.call(UI_EN, key) ? wfHubSay(t, key) : wfHubSay(t, 'workflows.hub.reason.read_error');
}

/** Text of a thrown error, for the header of a failed read. */
function wfHubFailure(error) {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  return String(error);
}

/* --------------------------------- groups ---------------------------------- */

function WfHubGroup(props) {
  const { t, title, caption, emptyText, entries, testId } = props;
  return WF_H(WF_FRAGMENT, null,
    WF_H(WF_UI.SectionHeader, {
      title,
      count: entries.length > 0 ? String(entries.length) : undefined,
      action: typeof caption === 'string' && caption !== '' ? WF_H('span', { className: 'zwf-caption' }, caption) : undefined,
    }),
    entries.length === 0
      ? WF_H('p', { className: 'zwf-empty-inline' }, emptyText)
      : WF_H('div', { className: 'zwf-hub-grid', 'data-testid': testId }, entries.map((entry) => WF_H(WfHubCard, {
        key: `${entry.scope}:${entry.name}`,
        t,
        entry,
        onOpen: props.onOpen,
        onRun: props.onRun,
        onRevise: props.onRevise,
        onCopyPath: props.onCopyPath,
        onMove: props.onMove,
        onDelete: props.onDelete,
      }))));
}

/** The last-run badge of one list card; four states, silent while unknown. */
function WfHubLastRunBadge(props) {
  const state = wfHubRunState(props.run);
  const t = props.t;
  const now = useWfClock();
  const key = `workflows.hub.lastRun.${state}`;
  const word = wfHubSay(t, key);
  if (state === 'never' && props.run === undefined) return null;
  const time = state === 'never' ? '' : WF_UI.relative(t, UI_EN, wfHubRunTime(props.run), now);
  const tone = state === 'completed' ? 'success' : state === 'errored' ? 'error' : state === 'running' ? 'warn' : 'idle';
  const icon = state === 'completed'
    ? WF_H(WF_ICON.check, { size: 12 })
    : state === 'errored'
      ? WF_H(WF_ICON.alert, { size: 12 })
      : state === 'running'
        ? WF_H(WF_UI.Spinner)
        : state === 'stopped'
          ? WF_H(WF_ICON.stop, { size: 12 })
          : null;
  return WF_H('span', {
    className: `zwf-hub-lastrun zwf-hub-lastrun-${tone}`,
    'data-testid': 'workflow-last-run',
    title: time === '' ? word : `${word} \u00b7 ${time}`,
  },
  icon === null ? null : WF_H('span', { className: 'zwf-hub-lastrun-glyph' }, icon),
  WF_H('span', null, word));
}

function WfHubCard(props) {
  const { t, entry } = props;
  const say = (key, params) => wfHubSay(t, key, params);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const anchorRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const names = wfHubArgNames(entry);
  const shown = names.slice(0, WF_HUB_ARG_CHIPS);
  const rest = names.length - shown.length;
  const description = entry.description !== '' ? entry.description : entry.whenToUse;
  const items = [
    { id: 'open', label: say('workflows.hub.card.open'), icon: WF_H(WF_ICON.file, { size: 14 }), onSelect: () => props.onOpen(entry) },
    { id: 'revise', label: say('workflows.hub.card.revise'), icon: WF_H(WF_ICON.spark, { size: 14 }), onSelect: () => props.onRevise(entry) },
    { id: 'copy', label: say('workflows.hub.card.copyPath'), icon: WF_H(WF_ICON.copy, { size: 14 }), onSelect: () => props.onCopyPath(entry) },
    entry.scope === 'global'
      ? { id: 'move', label: say('workflows.hub.card.moveToProject'), icon: WF_H(WF_ICON.folder, { size: 14 }), onSelect: () => props.onMove(entry) }
      : { id: 'promote', label: say('workflows.hub.card.promoteToGlobal'), icon: WF_H(WF_ICON.globe, { size: 14 }), disabled: true },
    null,
    { id: 'delete', label: say('workflows.hub.card.delete'), icon: WF_H(WF_ICON.close, { size: 14 }), danger: true, onSelect: () => props.onDelete(entry) },
  ];
  return WF_H('article', {
    className: 'zwf-hub-card',
    role: 'button',
    tabIndex: 0,
    'data-testid': `workflow-card-${entry.name}`,
    'data-workflow-name': entry.name,
    onClick: () => props.onOpen(entry),
    onKeyDown: (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      props.onOpen(entry);
    },
  },
  WF_H('span', { className: 'zwf-hub-card-name', 'data-testid': 'workflow-name', title: entry.name }, entry.name),
  WF_H('p', { className: 'zwf-hub-card-desc', title: description }, description === '' ? say('workflows.hub.empty.hint') : description),
  WF_H('div', { className: 'zwf-hub-card-foot' },
    WF_H(WfHubLastRunBadge, { t, run: entry.lastRun }),
    WF_H('div', { className: 'zwf-hub-args', 'data-testid': 'workflow-args' },
      shown.map((name) => WF_H('span', { className: 'zwf-hub-arg', key: name, title: name }, name)),
      rest > 0 ? WF_H('span', { className: 'zwf-hub-arg zwf-hub-arg-more', key: 'more' }, say('workflows.hub.card.argsMore', { count: rest })) : null)),
  WF_H('div', { className: 'zwf-hub-card-actions', onClick: (event) => event.stopPropagation() },
    WF_H(WF_UI.Button, {
      variant: 'subtle',
      size: 'sm',
      icon: WF_H(WF_ICON.run, { size: 14 }),
      'data-testid': `workflow-card-run-${entry.name}`,
      onClick: () => props.onRun(entry),
    }, say('workflows.hub.card.run')),
    WF_H('span', { className: 'zwf-anchor', ref: anchorRef },
      WF_H(WF_UI.IconButton, {
        icon: WF_H(WF_ICON.more, { size: 16 }),
        label: say('workflows.hub.card.menu'),
        title: say('workflows.hub.card.menu'),
        onClick: () => setMenuOpen((value) => value !== true),
      }),
      WF_H(WF_UI.Menu, {
        open: menuOpen,
        onClose: () => setMenuOpen(false),
        items,
        anchorRef,
        menuRef,
      }))));
}

/* --------------------------------- detail ---------------------------------- */

function WfHubDetail(props) {
  const { t, entry, projectRoot, projectLabel } = props;
  const say = (key, params) => wfHubSay(t, key, params);
  const [tab, setTab] = React.useState('definition');
  const [busy, setBusy] = React.useState(false);
  const definition = useWfAsync(
    () => (projectRoot === ''
      ? Promise.resolve(undefined)
      : WF_API.workflow({ projectRoot, name: entry.name, scope: entry.scope })),
    [projectRoot, entry.name, entry.scope],
  );
  const history = useWfAsync(
    () => (projectRoot === ''
      ? Promise.resolve(undefined)
      : WF_API.workflowRuns({ projectRoot, name: entry.name, scope: entry.scope, limit: WF_HUB_HISTORY_LIMIT })),
    [projectRoot, entry.name, entry.scope],
  );
  const payload = definition.data;
  const failedReason = payload !== null && typeof payload === 'object' && payload.ok === false
    ? typeof payload.reason === 'string' ? payload.reason : 'read_error'
    : undefined;
  const meta = payload !== null && typeof payload === 'object' && payload.meta !== null && typeof payload.meta === 'object' ? payload.meta : {};
  const script = typeof payload?.script === 'string' ? payload.script : '';
  const path = typeof payload?.path === 'string' && payload.path !== '' ? payload.path : entry.path;
  const description = typeof meta.description === 'string' ? meta.description : entry.description;
  const whenToUse = typeof meta.whenToUse === 'string' ? meta.whenToUse : entry.whenToUse;
  const args = meta.args !== null && typeof meta.args === 'object' && !Array.isArray(meta.args) ? meta.args : entry.args;
  const historyRows = Array.isArray(history.data?.runs) ? history.data.runs : [];
  const latest = historyRows[0];

  const saveMeta = async (next) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await WF_API.updateWorkflowMeta({
        projectRoot,
        name: entry.name,
        scope: entry.scope,
        meta: next,
      });
      if (result !== null && typeof result === 'object' && result.ok === false) {
        props.onSaved?.(say('workflows.hub.detail.meta.saveFailed', { reason: wfHubReasonWord(t, typeof result.reason === 'string' ? result.reason : 'read_error') }));
        setBusy(false);
        return;
      }
      definition.reload();
      props.onSaved?.(say('workflows.hub.detail.meta.saved'));
    } catch (error) {
      wfHubWarn('saving workflow metadata', error);
      props.onSaved?.(say('workflows.hub.detail.meta.saveFailed', { reason: wfHubFailure(error) }));
    }
    setBusy(false);
  };

  let body;
  if (definition.loading && payload === undefined) {
    body = WF_H('div', { className: 'zwf-hub-loading' }, WF_H(WF_UI.Spinner));
  } else if (failedReason !== undefined) {
    body = WF_H(WF_UI.EmptyState, {
      icon: WF_H(WF_ICON.alert, { size: 22 }),
      title: failedReason === 'not_found' ? say('workflows.hub.detail.notFound') : say('workflows.hub.detail.loadError', { reason: wfHubReasonWord(t, failedReason) }),
      action: WF_H(WF_UI.Button, { variant: 'subtle', size: 'sm', onClick: () => definition.reload() }, say('ui.retry')),
    });
  } else if (definition.error !== undefined && payload === undefined) {
    body = WF_H(WF_UI.ErrorNotice, {
      message: say('workflows.hub.detail.loadError', { reason: wfHubFailure(definition.error) }),
      retryLabel: say('ui.retry'),
      onRetry: () => definition.reload(),
    });
  } else if (tab === 'history') {
    body = WF_H(WfHubHistory, {
      t,
      rows: historyRows,
      loading: history.loading,
      error: history.error,
      onOpenRun: props.onOpenRun,
      onRetry: () => history.reload(),
    });
  } else {
    body = WF_H(WfHubDefinition, {
      key: `${entry.scope}:${entry.name}:${String(payload?.path ?? '')}`,
      t,
      name: entry.name,
      description,
      whenToUse,
      args,
      script,
      busy,
      onSave: saveMeta,
      onDiscard: () => definition.reload(),
    });
  }

  return WF_H('div', { className: 'zwf-hub-detail' },
    WF_H('div', { className: 'zwf-hub-detail-head' },
      WF_H('div', { className: 'zwf-hub-detail-titles' },
        WF_H('h1', { className: 'zwf-hub-detail-name', title: entry.name }, entry.name),
        WF_H('span', { className: 'zwf-hub-tag', 'data-testid': 'workflow-project-current' },
          entry.scope === 'global' ? say('workflows.hub.global.title') : projectLabel),
        description === '' ? null : WF_H('p', { className: 'zwf-hub-detail-desc' }, description)),
      WF_H('div', { className: 'zwf-hub-detail-actions' },
        WF_H(WF_UI.Button, {
          variant: 'subtle',
          size: 'md',
          icon: WF_H(WF_ICON.run, { size: 15 }),
          onClick: () => props.onRun(entry),
        }, say('workflows.hub.detail.run')),
        WF_H(WF_UI.Button, {
          variant: 'ghost',
          size: 'sm',
          onClick: () => props.onBack(),
        }, say('workflows.hub.sectionTitle')))),
    latest !== undefined && Array.isArray(latest.artifacts) && latest.artifacts.length > 0
      ? WF_H(WfHubArtifacts, { t, artifacts: latest.artifacts })
      : null,
    WF_H('div', { className: 'zwf-hub-detail-bar' },
      WF_H(WF_UI.Tabs, {
        tabs: [
          { id: 'definition', label: say('workflows.hub.detail.tab.definition') },
          { id: 'history', label: say('workflows.hub.detail.tab.history') },
        ],
        active: tab,
        onChange: setTab,
      }),
      path === ''
        ? null
        : WF_H('div', { className: 'zwf-hub-path' },
          WF_H('code', { className: 'zwf-hub-path-text', title: path }, path),
          WF_H(WF_UI.IconButton, {
            icon: WF_H(WF_ICON.copy, { size: 14 }),
            label: say('workflows.hub.detail.copyPath'),
            title: say('workflows.hub.detail.copyPath'),
            onClick: () => props.onCopyPath(entry),
          }))),
    WF_H('div', { className: 'zwf-hub-detail-body' }, body));
}

/** The artifact chips of the newest run. */
function WfHubArtifacts(props) {
  const artifacts = props.artifacts.slice(0, 6);
  return WF_H('div', { className: 'zwf-hub-artifacts' },
    WF_H('span', { className: 'zwf-hub-artifacts-label' }, wfHubSay(props.t, 'workflows.hub.artifacts.latest')),
    WF_H('div', { className: 'zwf-hub-artifacts-list', 'data-testid': 'workflow-run-artifact-chips' },
      artifacts.map((artifact, index) => {
        const record = artifact !== null && typeof artifact === 'object' ? artifact : {};
        const title = typeof record.title === 'string' && record.title !== '' ? record.title : String(record.id ?? '');
        return WF_H('span', { className: 'zwf-hub-chip', key: String(record.id ?? index), title },
          WF_H('span', { className: 'zwf-hub-chip-glyph' }, WF_H(WF_UI.artifactIcon(record.kind), { size: 13 })),
          WF_H('span', { className: 'zwf-hub-chip-text' }, title));
      }),
      props.artifacts.length > artifacts.length
        ? WF_H('span', { className: 'zwf-hub-chip zwf-hub-chip-more', key: 'more', 'data-testid': 'workflow-run-artifact-chips-more' },
          wfHubSay(props.t, 'workflows.hub.card.argsMore', { count: props.artifacts.length - artifacts.length }))
        : null));
}

/** The definition tab: metadata editor, argument table and the read-only script. */
function WfHubDefinition(props) {
  const { t } = props;
  const say = (key, params) => wfHubSay(t, key, params);
  const [description, setDescription] = React.useState(props.description);
  const [whenToUse, setWhenToUse] = React.useState(props.whenToUse);
  const [rows, setRows] = React.useState(() => wfHubArgRows(props.args));
  const [errors, setErrors] = React.useState({});
  const [failure, setFailure] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const dirty = description !== props.description
    || whenToUse !== props.whenToUse
    || JSON.stringify(wfHubArgRows(props.args)) !== JSON.stringify(rows);

  const submit = () => {
    if (description.trim() === '') {
      setFailure(say('workflows.hub.detail.meta.descriptionRequired'));
      return;
    }
    const parsed = wfHubValidateArgs(rows, t);
    setErrors(parsed.errors);
    if (parsed.args === undefined) return;
    setFailure(null);
    props.onSave({
      description: description.trim(),
      ...(whenToUse.trim() === '' ? {} : { whenToUse: whenToUse.trim() }),
      ...(Object.keys(parsed.args).length === 0 ? {} : { args: parsed.args }),
    });
  };

  const update = (key, patch) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  return WF_H(WF_FRAGMENT, null,
    WF_H('div', { className: 'zwf-hub-section' },
      WF_H('h2', { className: 'zwf-hub-section-title' }, say('workflows.hub.detail.basics')),
      WF_H(WF_UI.Field, { label: say('workflows.hub.detail.description') },
        WF_H(WF_UI.Textarea, {
          rows: 2,
          value: description,
          onChange: (value) => setDescription(value),
        })),
      WF_H('label', { className: 'zwf-hub-field-block' },
        WF_H('span', { className: 'zwf-hub-field-label' }, say('workflows.hub.detail.whenToUse')),
        WF_H(WF_UI.Input, {
          value: whenToUse,
          onChange: (value) => setWhenToUse(value),
        }),
        WF_H('span', { className: 'zwf-hub-field-hint' }, say('workflows.hub.detail.whenToUse.help'))),
      WF_H('p', { className: 'zwf-hub-note' }, say('workflows.hub.detail.meta.note')),
      failure === null ? null : WF_H('p', { className: 'zwf-hub-error', role: 'alert' }, failure),
      WF_H('div', { className: 'zwf-hub-savebar' },
        WF_H(WF_UI.Button, {
          variant: 'ghost',
          size: 'sm',
          disabled: props.busy || dirty !== true,
          onClick: () => props.onDiscard(),
        }, say('workflows.hub.detail.meta.discard')),
        WF_H(WF_UI.Button, {
          variant: 'primary',
          size: 'sm',
          disabled: props.busy || dirty !== true,
          onClick: submit,
        }, say('workflows.hub.detail.meta.save')))),
    WF_H(WfHubArgsTable, {
      t,
      rows,
      errors,
      onUpdate: update,
      onAdd: () => setRows((current) => [...current, {
        key: `arg:${String(current.length)}:${String(Date.now())}`,
        name: '',
        type: 'string',
        required: false,
        value: '',
        description: '',
      }]),
      onRemove: (key) => setRows((current) => current.filter((row) => row.key !== key)),
    }),
    WF_H('div', { className: 'zwf-hub-section' },
      WF_H('div', { className: 'zwf-hub-section-head' },
        WF_H('h2', { className: 'zwf-hub-section-title' }, say('workflows.hub.detail.script')),
        WF_H(WF_UI.Button, {
          variant: 'ghost',
          size: 'sm',
          icon: WF_H(WF_ICON.copy, { size: 13 }),
          onClick: async () => {
            const ok = await wfHubCopyText(props.script);
            setCopied(ok);
            if (ok) setTimeout(() => setCopied(false), WF_HUB_TOAST_MS);
          },
        }, copied ? say('ui.copied') : say('workflows.hub.detail.script.copy'))),
      WF_H('p', { className: 'zwf-hub-note' }, say('workflows.hub.detail.script.note')),
      WF_H('div', { className: 'zwf-hub-code' },
        WF_H('div', { className: 'zwf-hub-code-head' },
          WF_H('span', { className: 'zwf-hub-code-title' }, `${props.name}.dwf.ts \u00b7 TypeScript`)),
        WF_H('pre', { className: 'zwf-hub-code-body', 'data-testid': 'workflow-script-codeblock' }, props.script))));
}

/** The argument table of the definition tab. */
function WfHubArgsTable(props) {
  const { t, rows, errors } = props;
  const say = (key, params) => wfHubSay(t, key, params);
  return WF_H('div', { className: 'zwf-hub-section' },
    WF_H('div', { className: 'zwf-hub-section-head' },
      WF_H('h2', { className: 'zwf-hub-section-title' }, say('workflows.hub.detail.args')),
      WF_H(WF_UI.Button, {
        variant: 'ghost',
        size: 'sm',
        icon: WF_H(WF_ICON.plus, { size: 13 }),
        onClick: props.onAdd,
      }, say('workflows.hub.detail.args.add'))),
    rows.length === 0
      ? null
      : WF_H('div', { className: 'zwf-hub-args-table' },
        WF_H('div', { className: 'zwf-hub-args-head' },
          WF_H('span', { key: 'name' }, say('workflows.hub.detail.args.name')),
          WF_H('span', { key: 'type' }, say('workflows.hub.detail.args.type')),
          WF_H('span', { key: 'required' }, say('workflows.hub.detail.args.required')),
          WF_H('span', { key: 'default' }, say('workflows.hub.detail.args.default')),
          WF_H('span', { key: 'description' }, say('workflows.hub.detail.args.description')),
          WF_H('span', { key: 'remove' }, '')),
        rows.map((row) => WF_H('div', {
          className: 'zwf-hub-args-row',
          key: row.key,
          'data-testid': 'workflow-arg-row',
          'data-workflow-arg-row': 'true',
        },
        WF_H('div', { className: 'zwf-hub-args-cell' },
          WF_H('input', {
            className: 'zwf-hub-input',
            value: row.name,
            placeholder: say('workflows.hub.detail.args.name'),
            onChange: (event) => props.onUpdate(row.key, { name: event.target.value }),
          })),
        WF_H('div', { className: 'zwf-hub-args-cell' },
          WF_H('select', {
            className: 'zwf-hub-select',
            value: row.type,
            onChange: (event) => props.onUpdate(row.key, { type: event.target.value }),
          }, WF_HUB_ARG_TYPES.map((type) => WF_H('option', { key: type, value: type }, type)))),
        WF_H('div', { className: 'zwf-hub-args-cell zwf-hub-args-cell-required' },
          WF_H('input', {
            type: 'checkbox',
            className: 'zwf-hub-checkbox',
            checked: row.required,
            'aria-label': say('workflows.hub.detail.args.required'),
            onChange: (event) => props.onUpdate(row.key, { required: event.target.checked === true }),
          })),
        WF_H('div', { className: 'zwf-hub-args-cell' },
          WF_H('input', {
            className: 'zwf-hub-input zwf-hub-input-mono',
            value: row.value,
            placeholder: say('workflows.hub.detail.args.default'),
            onChange: (event) => props.onUpdate(row.key, { value: event.target.value }),
          })),
        WF_H('div', { className: 'zwf-hub-args-cell' },
          WF_H('input', {
            className: 'zwf-hub-input',
            value: row.description,
            placeholder: say('workflows.hub.detail.args.description'),
            onChange: (event) => props.onUpdate(row.key, { description: event.target.value }),
          })),
        WF_H('div', { className: 'zwf-hub-args-cell zwf-hub-args-cell-remove' },
          WF_H(WF_UI.IconButton, {
            icon: WF_H(WF_ICON.close, { size: 13 }),
            label: say('workflows.hub.detail.args.remove'),
            title: say('workflows.hub.detail.args.remove'),
            onClick: () => props.onRemove(row.key),
          })),
        errors[row.key] === undefined
          ? null
          : WF_H('p', { className: 'zwf-hub-args-error', role: 'alert' }, errors[row.key])))));
}

/** The run-history tab. */
function WfHubHistory(props) {
  const { t, rows, loading, error } = props;
  const say = (key, params) => wfHubSay(t, key, params);
  const now = useWfClock();
  if (loading && rows.length === 0) return WF_H('div', { className: 'zwf-hub-loading' }, WF_H(WF_UI.Spinner));
  if (error !== undefined && rows.length === 0) {
    return WF_H(WF_UI.ErrorNotice, {
      message: say('workflows.hub.loadError', { error: wfHubFailure(error) }),
      retryLabel: say('ui.retry'),
      onRetry: () => props.onRetry(),
    });
  }
  if (rows.length === 0) {
    return WF_H(WF_UI.EmptyState, {
      icon: WF_H(WF_ICON.clock, { size: 22 }),
      title: say('workflows.hub.history.empty'),
      body: say('workflows.hub.history.note'),
    });
  }
  return WF_H('div', { className: 'zwf-hub-history' },
    rows.map((row, index) => {
      const runId = wfHubRunId(row);
      const time = wfHubRunTime(row);
      const duration = wfHubDuration(t, row);
      const reason = wfHubStopReasonWord(t, row);
      const tokens = Number(row?.spentTokens);
      return WF_H('div', { className: 'zwf-hub-history-row', key: runId === '' ? String(index) : runId },
        WF_H(WF_UI.StatusDot, { tone: WF_UI.statusTone(typeof row?.status === 'string' ? row.status : 'unknown') }),
        WF_H('div', { className: 'zwf-hub-history-main' },
          WF_H('span', { className: 'zwf-hub-history-name' },
            typeof row?.name === 'string' && row.name !== '' ? row.name : wfHubRunStatusWord(t, row)),
          WF_H('span', { className: 'zwf-hub-history-meta' },
            [
              wfHubRunStatusWord(t, row),
              reason === '' ? '' : `\u00b7 ${reason}`,
              time === 0 ? '' : WF_UI.relative(t, UI_EN, time, now),
              duration === '' ? '' : `\u00b7 ${duration}`,
              Number.isFinite(tokens) && tokens > 0 ? `\u00b7 ${say('workflows.hub.history.tokens', { tokens })}` : '',
            ].filter((part) => part !== '').join(' '))),
        WF_H(WF_UI.Button, {
          variant: 'ghost',
          size: 'sm',
          onClick: () => props.onOpenRun(row),
        }, say('workflows.hub.history.open')));
    }),
    WF_H('p', { className: 'zwf-hub-note' }, say('workflows.hub.history.note')));
}

/* --------------------------------- dialogs --------------------------------- */

/** One launch form row. */
function wfHubLaunchRow(field, error, t, onChange) {
  const say = (key, params) => wfHubSay(t, key, params);
  let control;
  if (field.type === 'boolean') {
    control = WF_H('input', {
      type: 'checkbox',
      className: 'zwf-hub-checkbox',
      'data-testid': `workflow-arg-${field.name}`,
      checked: field.value === 'true',
      onChange: (event) => onChange(event.target.checked === true ? 'true' : 'false'),
    });
  } else if (field.type === 'json') {
    control = WF_H('textarea', {
      className: 'zwf-hub-textarea zwf-hub-input-mono',
      rows: 3,
      'data-testid': `workflow-arg-${field.name}`,
      value: field.value,
      onChange: (event) => onChange(event.target.value),
    });
  } else {
    control = WF_H('input', {
      className: 'zwf-hub-input',
      type: field.type === 'number' ? 'number' : 'text',
      inputMode: field.type === 'number' ? 'decimal' : undefined,
      'data-testid': `workflow-arg-${field.name}`,
      value: field.value,
      onChange: (event) => onChange(event.target.value),
    });
  }
  return WF_H('div', { className: 'zwf-hub-launch-row', key: field.name, 'data-testid': 'workflow-arg-row', 'data-workflow-arg-row': 'true' },
    WF_H('div', { className: 'zwf-hub-launch-label' },
      WF_H('span', { className: 'zwf-hub-launch-name' }, field.name),
      field.required ? WF_H('span', { className: 'zwf-hub-required' }, say('workflows.hub.launch.required')) : null),
    field.description === undefined ? null : WF_H('p', { className: 'zwf-hub-field-hint' }, field.description),
    control,
    error === undefined ? null : WF_H('p', { className: 'zwf-hub-args-error', role: 'alert' }, error));
}

/** Launch error copy for one failure code. */
function wfHubLaunchError(t, code) {
  const key = `workflows.hub.launch.error.${code}`;
  return Object.prototype.hasOwnProperty.call(UI_EN, key)
    ? wfHubSay(t, key)
    : wfHubSay(t, 'workflows.hub.launch.error.generic');
}

function WfHubLaunchDialog(props) {
  const { t, entry, projectLabel, rows } = props;
  const say = (key, params) => wfHubSay(t, key, params);
  const [fields, setFields] = React.useState(() => wfHubLaunchFields(entry));
  const [errors, setErrors] = React.useState({});
  const [failure, setFailure] = React.useState(null);
  const [targetKey, setTargetKey] = React.useState(props.projectRoot);
  const [busy, setBusy] = React.useState(false);

  const update = (name, value) => {
    setFields((current) => current.map((field) => (field.name === name ? { ...field, value } : field)));
    setErrors((current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const submit = () => {
    if (busy) return;
    const args = {};
    const nextErrors = {};
    for (const field of fields) {
      const parsed = wfHubParseField(field);
      if (parsed.ok !== true) nextErrors[field.name] = wfHubLaunchError(t, parsed.code);
      else if (parsed.omitted !== true) args[field.name] = parsed.value;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (typeof props.openChat !== 'function') {
      setFailure(say('workflows.hub.launch.error.unsupported'));
      return;
    }
    const target = rows.find((row) => row.path === targetKey) ?? rows.find((row) => row.path === props.projectRoot);
    const prompt = Object.keys(args).length === 0
      ? say('workflows.hub.prompt.runNoArgs', { name: entry.name })
      : say('workflows.hub.prompt.run', { name: entry.name, args: JSON.stringify(args, null, 2) });
    setBusy(true);
    const opened = props.openChat(target?.workspaceId ?? props.workspaceId, prompt);
    setBusy(false);
    if (opened !== true) {
      setFailure(say('workflows.hub.launch.error.start_failed'));
      return;
    }
    props.onStarted(args);
  };

  const targetLabel = rows.find((row) => row.path === targetKey)?.title ?? projectLabel;
  return WF_H(WF_UI.Modal, {
    open: true,
    title: say('workflows.hub.launch.title', { name: entry.name }),
    closeLabel: say('ui.close'),
    wide: fields.length > 4,
    onClose: props.onClose,
    footer: WF_H(WF_FRAGMENT, null,
      WF_H(WF_UI.Button, { variant: 'ghost', size: 'md', onClick: props.onClose }, say('workflows.hub.launch.cancel')),
      WF_H(WF_UI.Button, {
        variant: 'primary',
        size: 'md',
        icon: WF_H(WF_ICON.run, { size: 15 }),
        disabled: busy,
        'data-testid': 'workflow-launch-submit',
        onClick: submit,
      }, say('workflows.hub.launch.submit'))),
  },
  WF_H('div', { className: 'zwf-hub-launch', 'data-testid': 'workflow-launch' },
    rows.length === 0
      ? WF_H('p', { className: 'zwf-hub-note' }, say('workflows.hub.launch.noLocalProject'))
      : WF_H('label', { className: 'zwf-hub-field' },
        WF_H('span', { className: 'zwf-hub-field-label' }, say('workflows.hub.launch.target')),
        WF_H('select', {
          className: 'zwf-hub-select',
          value: targetKey,
          onChange: (event) => setTargetKey(event.target.value),
        }, rows.map((row) => WF_H('option', { key: row.path, value: row.path }, row.title === '' ? wfHubBasename(row.path) : row.title)))),
    WF_H('div', { className: 'zwf-hub-launch-meta' },
      WF_H('span', { className: 'zwf-hub-tag', 'data-testid': 'workflow-launch-scope' },
        say(entry.scope === 'global' ? 'workflows.hub.launch.scope.global' : 'workflows.hub.launch.scope.project')),
      WF_H('span', { className: 'zwf-hub-tag', 'data-testid': 'workflow-launch-kind' }, `${wfHubArgNames(entry).length}`)),
    fields.length === 0
      ? null
      : WF_H('div', { className: `zwf-hub-launch-args${fields.length >= 3 ? ' zwf-hub-launch-args-scroll' : ''}` },
        fields.map((field) => wfHubLaunchRow(field, errors[field.name], t, (value) => update(field.name, value)))),
    WF_H('div', { className: 'zwf-hub-launch-note' },
      WF_H('span', { className: 'zwf-hub-launch-note-glyph' }, WF_H(WF_ICON.external, { size: 14 })),
      WF_H('p', null, say('workflows.hub.launch.note', { project: targetLabel }))),
    failure === null ? null : WF_H(WF_UI.ErrorNotice, { message: failure })));
}

/** Editable fields of one launch form, from the entry's argument declarations. */
function wfHubLaunchFields(entry) {
  const fields = [];
  for (const [name, raw] of Object.entries(entry.args ?? {})) {
    const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const type = typeof record.type === 'string' && WF_HUB_ARG_TYPES.includes(record.type) ? record.type : 'string';
    fields.push({
      name,
      type,
      required: record.required === true,
      description: typeof record.description === 'string' && record.description.trim() !== '' ? record.description.trim() : undefined,
      value: wfHubDefaultText(type, record.default),
    });
  }
  return fields;
}

/** Parse one launch field; `{ ok: false, code }` carries the launch error key. */
function wfHubParseField(field) {
  const raw = field.value.trim();
  if (field.type === 'boolean') return { ok: true, value: raw === 'true' };
  if (raw === '') {
    if (field.required) return { ok: false, code: 'required' };
    return { ok: true, omitted: true };
  }
  if (field.type === 'number') {
    const number = Number(raw);
    return Number.isFinite(number) ? { ok: true, value: number } : { ok: false, code: 'invalid_number' };
  }
  if (field.type === 'json') {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false, code: 'invalid_json' };
    }
  }
  return { ok: true, value: raw };
}

function WfHubDeleteDialog(props) {
  const { t, entry, projectRoot } = props;
  const say = (key, params) => wfHubSay(t, key, params);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState(null);
  const confirm = async () => {
    if (busy || projectRoot === '') return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await WF_API.deleteWorkflow({ projectRoot, name: entry.name, scope: entry.scope });
      if (result !== null && typeof result === 'object' && result.ok === false) {
        setBusy(false);
        setFailure(say('workflows.hub.deleteFailed', { reason: wfHubReasonWord(t, typeof result.reason === 'string' ? result.reason : 'read_error') }));
        return;
      }
    } catch (error) {
      wfHubWarn('deleting a saved workflow', error);
      setBusy(false);
      setFailure(say('workflows.hub.deleteFailed', { reason: wfHubFailure(error) }));
      return;
    }
    setBusy(false);
    props.onDeleted();
  };
  return WF_H(WF_UI.Modal, {
    open: true,
    title: say('workflows.hub.delete.title', { name: entry.name }),
    closeLabel: say('ui.close'),
    onClose: props.onClose,
    footer: WF_H(WF_FRAGMENT, null,
      WF_H(WF_UI.Button, { variant: 'ghost', size: 'md', disabled: busy, onClick: props.onClose }, say('ui.cancel')),
      WF_H(WF_UI.Button, {
        variant: 'danger',
        size: 'md',
        disabled: busy,
        icon: busy ? WF_H(WF_UI.Spinner) : undefined,
        onClick: () => {
          void confirm();
        },
      }, say('workflows.hub.delete.confirm'))),
  },
  WF_H('p', { className: 'zwf-hub-dialog-text' }, say('workflows.hub.delete.description', { path: entry.path })),
  failure === null ? null : WF_H(WF_UI.ErrorNotice, { message: failure }));
}

function WfHubMoveDialog(props) {
  const { t, entry, projectRoot, rows } = props;
  const say = (key, params) => wfHubSay(t, key, params);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState(null);
  const [targetKey, setTargetKey] = React.useState(projectRoot);
  const confirm = async () => {
    const target = rows.find((row) => row.path === targetKey);
    if (busy || target === undefined) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await WF_API.moveWorkflow({ projectRoot: target.path, name: entry.name });
      if (result !== null && typeof result === 'object' && result.ok === false) {
        const reason = typeof result.reason === 'string' ? result.reason : '';
        setBusy(false);
        setFailure(reason === 'target_exists'
          ? say('workflows.hub.move.targetExists')
          : say('workflows.hub.move.failed', { reason: wfHubReasonWord(t, reason === '' ? 'read_error' : reason) }));
        return;
      }
    } catch (error) {
      wfHubWarn('moving a saved workflow', error);
      setBusy(false);
      setFailure(say('workflows.hub.move.failed', { reason: wfHubFailure(error) }));
      return;
    }
    setBusy(false);
    props.onMoved(target.title === '' ? wfHubBasename(target.path) : target.title);
  };
  return WF_H(WF_UI.Modal, {
    open: true,
    title: say('workflows.hub.moveDialog.title'),
    closeLabel: say('ui.close'),
    onClose: props.onClose,
    footer: WF_H(WF_FRAGMENT, null,
      WF_H(WF_UI.Button, { variant: 'ghost', size: 'md', disabled: busy, onClick: props.onClose }, say('ui.cancel')),
      WF_H(WF_UI.Button, {
        variant: 'primary',
        size: 'md',
        disabled: busy || targetKey === '',
        icon: busy ? WF_H(WF_UI.Spinner) : undefined,
        onClick: () => {
          void confirm();
        },
      }, say('workflows.hub.moveDialog.submit'))),
  },
  rows.length === 0
    ? WF_H('p', { className: 'zwf-hub-dialog-text' }, say('workflows.hub.moveDialog.noLocalProject'))
    : WF_H('label', { className: 'zwf-hub-field' },
      WF_H('span', { className: 'zwf-hub-field-label' }, say('workflows.hub.detail.projectColumn')),
      WF_H('select', {
        className: 'zwf-hub-select',
        value: targetKey,
        onChange: (event) => setTargetKey(event.target.value),
      }, rows.map((row) => WF_H('option', { key: row.path, value: row.path }, row.title === '' ? wfHubBasename(row.path) : row.title)))),
  failure === null ? null : WF_H(WF_UI.ErrorNotice, { message: failure }));
}

/* --------------------------------- sidebar --------------------------------- */

function WfHubPanelIcon(props) {
  const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 20;
  return WF_H(WF_ICON.workflow, { size, strokeWidth: props?.active === true ? 1.8 : 1.6 });
}

/* -------------------------------- register --------------------------------- */

/**
 * Register the hub page and its sidebar entry.
 * @param {object} ctx client plugin context
 * @param {(callback: Function, label?: string) => unknown} effect effect registrar
 */
WF_DIRECTORY.register = function register(ctx, effect) {
  if (ctx === null || typeof ctx !== 'object') return;
  const slots = ctx.slots;
  if (slots === undefined || slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;
  let translate;
  try {
    if (ctx.locale !== undefined && ctx.locale !== null && typeof ctx.locale.bind === 'function') {
      translate = ctx.locale.bind(UI_NS);
    }
  } catch {
    translate = undefined;
  }
  const openChat = (workspaceId, prompt) => {
    const service = wfHubWorkspaceService(ctx);
    if (service === undefined || typeof service.startSession !== 'function') return false;
    try {
      service.startSession(workspaceId, { prompt: String(prompt), whenDraftExists: 'append' });
      return true;
    } catch (error) {
      wfHubWarn('opening a conversation', error);
      return false;
    }
  };
  const layout = wfHubLayoutService(ctx);
  const openSettings = layout === undefined || typeof layout.selectPanel !== 'function'
    ? undefined
    : () => {
      try {
        layout.selectPanel('settings');
      } catch (error) {
        wfHubWarn('opening settings', error);
      }
    };
  slots.inject('main', () => slots.register({
    name: 'main',
    key: WF_DIRECTORY_PANEL_ID,
    locale: UI_NS,
    inject: () => ({ openChat, ...(openSettings === undefined ? {} : { openSettings }) }),
  }, WfHubPage));
  slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: WF_DIRECTORY_PANEL_ID,
    order: WF_DIRECTORY_ORDER,
    locale: UI_NS,
    label: () => WF_UI.say(translate, UI_EN, 'workflows.hub.sectionTitle'),
  }, WfHubPanelIcon));
};

/* ---------------------------------- styles --------------------------------- */

const WF_DIRECTORY_CSS = `
.zwf-hub-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin:16px 0 4px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.zwf-hub-field{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%}
.zwf-hub-field-block{display:flex;flex-direction:column;gap:5px;min-width:0}
.zwf-hub-field-label{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-hub-field-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-hub-select{box-sizing:border-box;max-width:260px;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.zwf-hub-select:disabled{opacity:.5;cursor:default}
.zwf-hub-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.zwf-hub-input,.zwf-hub-textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 8px}
.zwf-hub-input{height:30px}
.zwf-hub-textarea{resize:vertical;min-height:72px}
.zwf-hub-input:focus,.zwf-hub-textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;border-color:transparent}
.zwf-hub-input-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.zwf-hub-checkbox{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.zwf-hub-content{display:flex;flex-direction:column;min-width:0;margin-top:4px}
.zwf-hub-loading{display:flex;align-items:center;justify-content:center;padding:40px 0}
.zwf-hub-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:12px;min-width:0}
.zwf-hub-card{box-sizing:border-box;position:relative;display:flex;flex-direction:column;gap:8px;min-width:0;min-height:132px;padding:14px 16px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:border-color .12s,background-color .12s}
.zwf-hub-card:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.zwf-hub-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.zwf-hub-card-name{display:block;padding-right:88px;font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-hub-card-desc{margin:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);min-height:36px}
.zwf-hub-card-foot{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin-top:auto;min-width:0;min-height:18px}
.zwf-hub-card-actions{position:absolute;top:10px;right:10px;display:flex;align-items:center;gap:4px;opacity:0;transition:opacity .12s}
.zwf-hub-card:hover .zwf-hub-card-actions,.zwf-hub-card:focus-within .zwf-hub-card-actions{opacity:1}
.zwf-hub-args{display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0}
.zwf-hub-arg{display:inline-flex;align-items:center;max-width:120px;height:18px;padding:0 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-hub-arg-more{font-family:inherit;border-style:dashed}
.zwf-hub-lastrun{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-hub-lastrun-glyph{display:inline-flex;flex:none}
.zwf-hub-lastrun-success{color:var(--dsw-alias-state-success-primary)}
.zwf-hub-lastrun-warn{color:var(--dsw-alias-state-warn-primary)}
.zwf-hub-lastrun-error{color:var(--dsw-alias-state-error-primary)}
.zwf-hub-warn{display:flex;align-items:flex-start;gap:8px;margin-top:12px;padding:8px 10px;border:1px solid color-mix(in oklab,var(--dsw-alias-state-warn-primary) 35%,transparent);border-radius:var(--dsw-radius-sm,8px);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 8%,transparent)}
.zwf-hub-warn-glyph{display:flex;flex:none;margin-top:1px;color:var(--dsw-alias-state-warn-primary)}
.zwf-hub-warn-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.zwf-hub-warn-title{margin:0;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.zwf-hub-warn-line{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.zwf-hub-toast{position:sticky;top:8px;z-index:5;align-self:flex-start;margin:8px 0;padding:6px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.zwf-hub-detail{display:flex;flex-direction:column;gap:14px;min-width:0;padding-top:14px}
.zwf-hub-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;min-width:0}
.zwf-hub-detail-titles{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.zwf-hub-detail-name{margin:0;font-size:18px;line-height:26px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-hub-detail-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.zwf-hub-detail-actions{display:flex;align-items:center;gap:8px;flex:none}
.zwf-hub-tag{display:inline-flex;align-items:center;align-self:flex-start;max-width:240px;height:20px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-hub-artifacts{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}
.zwf-hub-artifacts-label{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-hub-artifacts-list{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}
.zwf-hub-chip{display:inline-flex;align-items:center;gap:5px;max-width:200px;height:22px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);font-size:11.5px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.zwf-hub-chip-glyph{display:inline-flex;flex:none}
.zwf-hub-chip-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-hub-chip-more{border-style:dashed}
.zwf-hub-detail-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.zwf-hub-path{display:inline-flex;align-items:center;gap:4px;margin-left:auto;min-width:0;max-width:60%}
.zwf-hub-path-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.zwf-hub-detail-body{display:flex;flex-direction:column;gap:18px;min-width:0}
.zwf-hub-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.zwf-hub-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.zwf-hub-section-title{margin:0;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.zwf-hub-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-hub-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.zwf-hub-savebar{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.zwf-hub-args-table{display:flex;flex-direction:column;gap:6px;min-width:0}
.zwf-hub-args-head,.zwf-hub-args-row{display:grid;grid-template-columns:minmax(0,1.4fr) 104px 56px minmax(0,1fr) minmax(0,1.5fr) 28px;gap:8px;align-items:center;min-width:0}
.zwf-hub-args-head{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-hub-args-row{grid-template-areas:none}
.zwf-hub-args-cell{min-width:0}
.zwf-hub-args-cell-required{display:flex;align-items:center;justify-content:center}
.zwf-hub-args-cell-remove{display:flex;align-items:center;justify-content:flex-end}
.zwf-hub-args-row .zwf-hub-select{max-width:none;width:100%;height:30px}
.zwf-hub-args-error{grid-column:1/-1;margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.zwf-hub-code{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.zwf-hub-code-head{display:flex;align-items:center;justify-content:space-between;height:32px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-hub-code-title{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}
.zwf-hub-code-body{margin:0;max-height:480px;overflow:auto;padding:10px 12px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-primary);white-space:pre;tab-size:2}
.zwf-hub-history{display:flex;flex-direction:column;gap:4px;min-width:0}
.zwf-hub-history-row{display:flex;align-items:center;gap:10px;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1)}
.zwf-hub-history-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.zwf-hub-history-name{min-width:0;font-size:13px;line-height:19px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-hub-history-meta{min-width:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.zwf-hub-launch{display:flex;flex-direction:column;gap:10px;min-width:0}
.zwf-hub-launch-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.zwf-hub-launch-args{display:flex;flex-direction:column;gap:12px;min-width:0}
.zwf-hub-launch-args-scroll{max-height:min(46vh,320px);overflow-y:auto;padding-right:2px}
.zwf-hub-launch-row{display:flex;flex-direction:column;gap:5px;min-width:0}
.zwf-hub-launch-label{display:inline-flex;align-items:center;gap:6px;min-width:0}
.zwf-hub-launch-name{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.zwf-hub-required{flex:none;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-hub-launch-note{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-hub-launch-note p{margin:0}
.zwf-hub-launch-note-glyph{display:flex;flex:none;margin-top:1px}
.zwf-hub-dialog-text{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
@media (max-width:640px){.zwf-hub-args-head,.zwf-hub-args-row{grid-template-columns:minmax(0,1fr) 88px 44px minmax(0,1fr) 28px}.zwf-hub-args-head span:nth-child(5),.zwf-hub-args-row .zwf-hub-args-cell:nth-child(5){display:none}}
`;

WF_STYLE_PARTS.push(WF_DIRECTORY_CSS);
