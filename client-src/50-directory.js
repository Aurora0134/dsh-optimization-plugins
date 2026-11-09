/* Main-panel workflow directory and its sidebar entry. */

const WF_DIRECTORY = {};

/** Panel key shared by the `main` slot and its `sidebar.panellist` entry. */
const WF_DIRECTORY_PANEL_ID = 'zcode-workflow';

/** Sidebar position: after the shipped task panel. */
const WF_DIRECTORY_ORDER = 20;

/** Copy from the directory dictionary, with the compiled English text as fallback. */
function wfDirectorySay(t, key, params) {
  return WF_UI.say(t, UI_EN, key, params);
}

/* -------------------------------- workspace -------------------------------- */

/**
 * Workspace rows that carry a usable project directory.
 * @param {object | undefined} snapshot `useWorkspaces` snapshot: `{ phase, items }`
 * @returns {{ key: string, workspaceId: string | undefined, path: string, title: string }[]}
 */
function wfDirectoryWorkspaces(snapshot) {
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

function wfDirectoryBasename(value) {
  const text = String(value).replace(/[\\/]+$/u, '');
  const parts = text.split(/[\\/]/u);
  const last = parts[parts.length - 1];
  return last === undefined || last === '' ? text : last;
}

function wfDirectoryWorkspaceLabel(t, row) {
  if (row === undefined || row === null) return '';
  if (row.title === 'default-workspace') return wfDirectorySay(t, 'directory.defaultWorkspace');
  if (row.title !== '') return row.title;
  return wfDirectoryBasename(row.path);
}

/** The Cordis service that opens a new conversation; absent in lighter profiles. */
function wfDirectoryWorkspaceService(ctx) {
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

/* ---------------------------------- args ----------------------------------- */

function wfDirectoryJsonText(value) {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? '' : text;
  } catch {
    return '';
  }
}

function wfDirectoryFieldText(type, enumValues, value) {
  if (value === undefined) return type === 'boolean' ? 'false' : '';
  if (enumValues !== undefined) return typeof value === 'string' ? value : String(value);
  switch (type) {
    case 'boolean':
      return value === true ? 'true' : 'false';
    case 'number':
      return String(value);
    case 'json':
    case 'object':
    case 'array':
      return wfDirectoryJsonText(value);
    default:
      return typeof value === 'string' ? value : wfDirectoryJsonText(value);
  }
}

/** One editable argument row per declared workflow argument. */
function wfDirectoryFields(entry) {
  const declarations = entry !== null && typeof entry === 'object'
    && entry.args !== null && typeof entry.args === 'object' && !Array.isArray(entry.args)
    ? entry.args
    : {};
  const fields = [];
  for (const [name, raw] of Object.entries(declarations)) {
    const declaration = raw !== null && typeof raw === 'object' ? raw : {};
    const type = typeof declaration.type === 'string' ? declaration.type : 'string';
    const enumValues = Array.isArray(declaration.enum) && declaration.enum.length > 0 ? declaration.enum : undefined;
    const hasDefault = declaration.default !== undefined;
    fields.push({
      name,
      type,
      enumValues,
      required: declaration.required === true,
      hasDefault,
      description: typeof declaration.description === 'string' && declaration.description.trim() !== ''
        ? declaration.description
        : undefined,
      value: wfDirectoryFieldText(type, enumValues, hasDefault ? declaration.default : undefined),
    });
  }
  return fields;
}

/** Parse one field's text; returns `{ ok: false, error }`, `{ ok: true, omitted }` or `{ ok: true, value }`. */
function wfDirectoryParseField(field, t) {
  const text = typeof field.value === 'string' ? field.value : '';
  if (field.type === 'boolean') return { ok: true, value: text === 'true' };
  const trimmed = text.trim();
  if (trimmed === '') {
    if (field.required && !field.hasDefault) {
      return { ok: false, error: wfDirectorySay(t, 'directory.launch.requiredError') };
    }
    return { ok: true, omitted: true };
  }
  if (field.enumValues !== undefined) {
    const index = field.enumValues.findIndex((option) => String(option) === text);
    if (index === -1) return { ok: false, error: wfDirectorySay(t, 'directory.launch.invalidChoice') };
    return { ok: true, value: field.enumValues[index] };
  }
  if (field.type === 'number') {
    const number = Number(trimmed);
    if (!Number.isFinite(number)) return { ok: false, error: wfDirectorySay(t, 'directory.launch.invalidNumber') };
    return { ok: true, value: number };
  }
  if (field.type === 'json' || field.type === 'object' || field.type === 'array') {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, error: wfDirectorySay(t, 'directory.launch.invalidJson') };
    }
  }
  return { ok: true, value: text };
}

function wfDirectoryArgsLabel(t, entry) {
  const declarations = entry !== null && typeof entry === 'object'
    && entry.args !== null && typeof entry.args === 'object' && !Array.isArray(entry.args)
    ? entry.args
    : {};
  const count = Object.keys(declarations).length;
  if (count === 0) return wfDirectorySay(t, 'directory.args.zero');
  if (count === 1) return wfDirectorySay(t, 'directory.args.one');
  return wfDirectorySay(t, 'directory.args.count', { count });
}

/** One row of the launch form: name, required marker, control and validation line. */
function wfDirectoryArgRow(field, error, t, onChange) {
  const head = WF_H('span', { className: 'zwf-dir-arg-head' },
    WF_H('span', { className: 'zwf-dir-arg-name' }, field.name),
    field.required ? WF_H('span', { className: 'zwf-badge zwf-dir-required' }, wfDirectorySay(t, 'directory.launch.required')) : null);
  const hint = field.description;
  let control;
  if (field.type === 'boolean') {
    control = WF_H('label', { className: 'zwf-dir-check' },
      WF_H('input', {
        type: 'checkbox',
        className: 'zwf-dir-checkbox',
        checked: field.value === 'true',
        onChange: (event) => onChange(event.target.checked === true ? 'true' : 'false'),
      }),
      WF_H('span', null, field.value === 'true'
        ? wfDirectorySay(t, 'directory.launch.on')
        : wfDirectorySay(t, 'directory.launch.off')));
  } else if (field.enumValues !== undefined) {
    const options = [];
    if (field.value === '') {
      options.push(WF_H('option', { key: '__choose', value: '' }, wfDirectorySay(t, 'directory.launch.choose')));
    } else if (!field.enumValues.some((option) => String(option) === field.value)) {
      options.push(WF_H('option', { key: '__current', value: field.value }, field.value));
    }
    field.enumValues.forEach((option, index) => {
      options.push(WF_H('option', { key: String(index), value: String(option) }, String(option)));
    });
    control = WF_H('select', {
      className: 'zwf-select zwf-select-wide',
      value: field.value,
      onChange: (event) => onChange(event.target.value),
    }, options);
  } else if (field.type === 'json' || field.type === 'object' || field.type === 'array') {
    control = WF_H(WF_UI.Textarea, {
      rows: 3,
      value: field.value,
      onChange,
    });
  } else {
    control = WF_H(WF_UI.Input, {
      type: field.type === 'number' ? 'number' : 'text',
      value: field.value,
      onChange,
    });
  }
  const errorLine = error === undefined || error === null
    ? null
    : WF_H('p', { className: 'zwf-dir-arg-error', role: 'alert' }, error);
  if (field.type === 'boolean') {
    return WF_H('div', { className: 'zwf-dir-arg', key: field.name },
      head,
      hint === undefined ? null : WF_H('p', { className: 'zwf-field-hint' }, hint),
      control,
      errorLine);
  }
  return WF_H('div', { className: 'zwf-dir-arg', key: field.name },
    WF_H(WF_UI.Field, { label: head, hint }, control),
    errorLine);
}

/* ---------------------------------- page ----------------------------------- */

/**
 * Global workflow directory: saved workflows for the selected workspace plus the global list.
 * @param {object} props slot props: `t`, `useWorkspaces`, injected `openChat`
 */
function WorkflowDirectoryPage(props) {
  if (props === null || typeof props !== 'object' || typeof props.useWorkspaces !== 'function') {
    return WF_H('section', { className: 'zwf-page' },
      WF_H('div', { className: 'zwf-page-scroll' },
        WF_H('div', { className: 'zwf-page-inner' },
          WF_H(WF_UI.EmptyState, {
            icon: WF_H(WF_ICON.folder, { size: 22 }),
            title: wfDirectorySay(props?.t, 'directory.noWorkspace'),
          }))));
  }
  return WF_H(WorkflowDirectoryBody, props);
}

function WorkflowDirectoryBody(props) {
  const translate = typeof props.t === 'function' ? props.t : undefined;
  const openChat = typeof props.openChat === 'function' ? props.openChat : undefined;
  const say = (key, params) => wfDirectorySay(translate, key, params);

  const snapshot = props.useWorkspaces((value) => value);
  const rows = React.useMemo(() => wfDirectoryWorkspaces(snapshot), [snapshot]);
  const [selectedKey, setSelectedKey] = React.useState(null);
  const selected = React.useMemo(() => {
    const chosen = selectedKey === null ? undefined : rows.find((row) => row.key === selectedKey);
    if (chosen !== undefined) return chosen;
    return rows.find((row) => row.title === 'default-workspace') ?? rows[0];
  }, [rows, selectedKey]);
  const projectRoot = selected?.path;
  const loaded = useWfAsync(
    () => (typeof projectRoot === 'string' && projectRoot !== ''
      ? WF_API.workflows({ projectRoot })
      : Promise.resolve(null)),
    [projectRoot],
  );
  const [dialog, setDialog] = React.useState(null);
  const [createFailure, setCreateFailure] = React.useState(null);

  const payload = loaded.data;
  const entries = (payload !== null && typeof payload === 'object' && Array.isArray(payload.entries) ? payload.entries : [])
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string' && entry.name !== '');
  const invalid = payload !== null && typeof payload === 'object' && Array.isArray(payload.invalid) ? payload.invalid : [];
  const projectEntries = entries.filter((entry) => entry.scope !== 'global');
  const globalEntries = entries.filter((entry) => entry.scope === 'global');
  const workspacePhase = snapshot !== null && typeof snapshot === 'object' ? snapshot.phase : undefined;
  const workspacesPending = rows.length === 0 && workspacePhase !== 'ready';
  const projectLabel = wfDirectoryWorkspaceLabel(translate, selected);

  const createInChat = () => {
    setCreateFailure(null);
    if (openChat === undefined) {
      setCreateFailure(say('directory.launch.openFailed'));
      return;
    }
    const opened = openChat(selected?.workspaceId, say('directory.prompt.create'));
    if (opened !== true) setCreateFailure(say('directory.launch.openFailed'));
  };

  const header = WF_H('div', { className: 'zwf-page-head' },
    WF_H('div', { className: 'zwf-page-titles' },
      WF_H('h1', { className: 'zwf-page-title' }, say('directory.title')),
      WF_H('p', { className: 'zwf-page-sub' }, say('directory.subtitle'))),
    WF_H('div', { className: 'zwf-page-actions' },
      WF_H(WF_UI.IconButton, {
        icon: WF_H(WF_ICON.refresh, { size: 16 }),
        label: say('directory.refresh'),
        title: say('directory.refresh'),
        disabled: rows.length === 0 || workspacesPending || loaded.loading,
        onClick: () => loaded.reload(),
      })));

  const toolbar = rows.length === 0
    ? null
    : WF_H('div', { className: 'zwf-dir-toolbar' },
      WF_H('label', { className: 'zwf-dir-field' },
        WF_H('span', { className: 'zwf-dir-field-label' }, say('directory.project')),
        WF_H('select', {
          className: 'zwf-select',
          value: selected?.key ?? '',
          onChange: (event) => setSelectedKey(event.target.value),
        }, rows.map((row) => WF_H('option', { key: row.key, value: row.key }, wfDirectoryWorkspaceLabel(translate, row))))));

  const work = () => {
    if (rows.length === 0) {
      if (workspacesPending) return WF_H('div', { className: 'zwf-dir-loading' }, WF_H(WF_UI.Spinner));
      return WF_H(WF_UI.EmptyState, {
        icon: WF_H(WF_ICON.folder, { size: 22 }),
        title: say('directory.noWorkspace'),
        body: say('directory.noWorkspaceBody'),
      });
    }
    if (loaded.loading) return WF_H('div', { className: 'zwf-dir-loading' }, WF_H(WF_UI.Spinner));
    if (loaded.error !== undefined && payload === undefined) {
      return WF_H(WF_UI.ErrorNotice, {
        message: say('directory.loadError'),
        retryLabel: say('directory.retry'),
        onRetry: () => loaded.reload(),
      });
    }
    const nodes = [];
    if (loaded.error !== undefined) {
      nodes.push(WF_H(WF_UI.ErrorNotice, {
        key: 'error',
        message: say('directory.loadError'),
        retryLabel: say('directory.retry'),
        onRetry: () => loaded.reload(),
      }));
    }
    if (entries.length === 0) {
      nodes.push(WF_H(WF_UI.EmptyState, {
        key: 'empty',
        icon: WF_H(WF_ICON.workflow, { size: 22 }),
        title: say('directory.empty.title'),
        body: say('directory.empty.body'),
        action: WF_H(WF_UI.Button, {
          variant: 'primary',
          size: 'md',
          icon: WF_H(WF_ICON.plus, { size: 15 }),
          onClick: createInChat,
        }, say('directory.empty.create')),
      }));
    } else {
      nodes.push(WF_H(WorkflowDirectoryGroup, {
        key: 'project',
        t: translate,
        title: say('directory.projectGroup'),
        caption: projectLabel,
        emptyText: say('directory.projectEmpty'),
        entries: projectEntries,
        canMove: false,
        onRun: (entry) => setDialog({ kind: 'launch', entry }),
        onDelete: (entry) => setDialog({ kind: 'delete', entry }),
        onMove: (entry) => setDialog({ kind: 'move', entry }),
      }));
      nodes.push(WF_H(WorkflowDirectoryGroup, {
        key: 'global',
        t: translate,
        title: say('directory.globalGroup'),
        caption: say('directory.globalHint'),
        emptyText: say('directory.globalEmpty'),
        entries: globalEntries,
        canMove: selected !== undefined,
        onRun: (entry) => setDialog({ kind: 'launch', entry }),
        onDelete: (entry) => setDialog({ kind: 'delete', entry }),
        onMove: (entry) => setDialog({ kind: 'move', entry }),
      }));
    }
    return WF_H(WF_FRAGMENT, null, nodes);
  };

  let dialogNode = null;
  if (dialog !== null && dialog.entry !== null && typeof dialog.entry === 'object') {
    if (dialog.kind === 'launch') {
      dialogNode = WF_H(WorkflowLaunchDialog, {
        t: translate,
        entry: dialog.entry,
        workspaceId: selected?.workspaceId,
        projectLabel,
        onOpenChat: openChat,
        onClose: () => setDialog(null),
      });
    } else if (dialog.kind === 'delete') {
      dialogNode = WF_H(WorkflowDeleteDialog, {
        t: translate,
        entry: dialog.entry,
        projectRoot,
        onClose: () => setDialog(null),
        onDone: () => {
          setDialog(null);
          loaded.reload();
        },
      });
    } else if (dialog.kind === 'move') {
      dialogNode = WF_H(WorkflowMoveDialog, {
        t: translate,
        entry: dialog.entry,
        projectRoot,
        projectLabel,
        onClose: () => setDialog(null),
        onDone: () => {
          setDialog(null);
          loaded.reload();
        },
      });
    }
  }

  return WF_H('section', { className: 'zwf-page', 'aria-label': say('directory.title') },
    WF_H('div', { className: 'zwf-page-scroll' },
      WF_H('div', { className: 'zwf-page-inner' },
        header,
        toolbar,
        invalid.length > 0
          ? WF_H('div', { className: 'zwf-dir-warn', role: 'status' },
            WF_H('span', { className: 'zwf-dir-warn-glyph' }, WF_H(WF_ICON.alert, { size: 15 })),
            WF_H('span', null, say('directory.invalid', { count: invalid.length })))
          : null,
        createFailure === null ? null : WF_H(WF_UI.ErrorNotice, { message: createFailure }),
        WF_H('div', { className: 'zwf-dir-content' }, work()))),
    dialogNode);
}

/* --------------------------------- groups ---------------------------------- */

function WorkflowDirectoryGroup(props) {
  const { t, title, caption, emptyText, entries, canMove, onRun, onDelete, onMove } = props;
  return WF_H(WF_FRAGMENT, null,
    WF_H(WF_UI.SectionHeader, {
      title,
      count: entries.length > 0 ? String(entries.length) : undefined,
      action: typeof caption === 'string' && caption !== '' ? WF_H('span', { className: 'zwf-caption' }, caption) : undefined,
    }),
    entries.length === 0
      ? WF_H('p', { className: 'zwf-empty-inline' }, emptyText)
      : WF_H('div', { className: 'zwf-dir-grid' }, entries.map((entry) => WF_H(WorkflowDirectoryCard, {
        key: `${String(entry.scope)}:${entry.name}:${typeof entry.path === 'string' ? entry.path : ''}`,
        t,
        entry,
        canMove,
        onRun,
        onDelete,
        onMove,
      }))));
}

function WorkflowDirectoryCard(props) {
  const { t, entry, canMove, onRun, onDelete, onMove } = props;
  const say = (key, params) => wfDirectorySay(t, key, params);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const anchorRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const scope = entry.scope === 'global' ? 'global' : 'project';
  const description = typeof entry.description === 'string' && entry.description.trim() !== ''
    ? entry.description.trim()
    : typeof entry.whenToUse === 'string' && entry.whenToUse.trim() !== ''
      ? entry.whenToUse.trim()
      : say('directory.noDescription');
  const items = [];
  if (scope === 'global') {
    items.push({
      id: 'move',
      label: say('directory.menu.moveToProject'),
      icon: WF_H(WF_ICON.folder, { size: 14 }),
      disabled: canMove !== true,
      onSelect: () => onMove(entry),
    });
    items.push(null);
  }
  items.push({
    id: 'delete',
    label: say('directory.menu.delete'),
    icon: WF_H(WF_ICON.close, { size: 14 }),
    danger: true,
    onSelect: () => onDelete(entry),
  });
  return WF_H('article', { className: 'zwf-card zwf-dir-card' },
    WF_H('div', { className: 'zwf-card-head' },
      WF_H('span', { className: 'zwf-card-glyph' }, WF_H(WF_ICON.workflow, { size: 16 })),
      WF_H('div', { className: 'zwf-card-titles' },
        WF_H('h3', { className: 'zwf-card-name', title: entry.name }, entry.name),
        WF_H('p', { className: 'zwf-card-desc', title: description }, description))),
    WF_H('div', { className: 'zwf-dir-card-foot' },
      WF_H('div', { className: 'zwf-wrap' },
        WF_H('span', { className: `zwf-badge${scope === 'global' ? ' zwf-badge-brand' : ''}` },
          say(scope === 'global' ? 'directory.scope.global' : 'directory.scope.project')),
        WF_H('span', { className: 'zwf-dir-args' }, wfDirectoryArgsLabel(t, entry))),
      WF_H('div', { className: 'zwf-card-actions' },
        WF_H(WF_UI.Button, {
          variant: 'subtle',
          size: 'sm',
          icon: WF_H(WF_ICON.run, { size: 14 }),
          onClick: () => onRun(entry),
        }, say('directory.run')),
        WF_H('span', { className: 'zwf-anchor', ref: anchorRef },
          WF_H(WF_UI.IconButton, {
            icon: WF_H(WF_ICON.more, { size: 16 }),
            label: say('directory.more'),
            title: say('directory.more'),
            onClick: () => setMenuOpen((value) => value !== true),
          }),
          WF_H(WF_UI.Menu, {
            open: menuOpen,
            onClose: () => setMenuOpen(false),
            items,
            anchorRef,
            menuRef,
          })))));
}

/* --------------------------------- dialogs --------------------------------- */

function WorkflowLaunchDialog(props) {
  const { entry, t, workspaceId, projectLabel, onOpenChat, onClose } = props;
  const say = (key, params) => wfDirectorySay(t, key, params);
  const [fields, setFields] = React.useState(() => wfDirectoryFields(entry));
  const [errors, setErrors] = React.useState({});
  const [failure, setFailure] = React.useState(null);
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
    const args = {};
    const nextErrors = {};
    for (const field of fields) {
      const parsed = wfDirectoryParseField(field, t);
      if (parsed.ok !== true) nextErrors[field.name] = parsed.error;
      else if (parsed.omitted !== true) args[field.name] = parsed.value;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const hasArgs = Object.keys(args).length > 0;
    const prompt = hasArgs
      ? say('directory.prompt.run', { name: entry.name, args: JSON.stringify(args, null, 2) })
      : say('directory.prompt.runNoArgs', { name: entry.name });
    const opened = typeof onOpenChat === 'function' ? onOpenChat(workspaceId, prompt) : false;
    if (opened !== true) {
      setFailure(say('directory.launch.openFailed'));
      return;
    }
    onClose();
  };
  return WF_H(WF_UI.Modal, {
    open: true,
    title: say('directory.launch.title', { name: entry.name }),
    onClose,
    closeLabel: say('directory.close'),
    wide: fields.length > 6,
    footer: WF_H(WF_FRAGMENT, null,
      WF_H(WF_UI.Button, { variant: 'ghost', size: 'md', onClick: onClose }, say('directory.launch.cancel')),
      WF_H(WF_UI.Button, {
        variant: 'primary',
        size: 'md',
        icon: WF_H(WF_ICON.run, { size: 15 }),
        onClick: submit,
      }, say('directory.launch.submit'))),
  },
  typeof entry.description === 'string' && entry.description.trim() !== ''
    ? WF_H('p', { className: 'zwf-dir-dialog-desc' }, entry.description.trim())
    : null,
  fields.length === 0
    ? WF_H('p', { className: 'zwf-caption' }, say('directory.launch.noArgs'))
    : WF_H('div', { className: 'zwf-dir-form' }, fields.map((field) => wfDirectoryArgRow(field, errors[field.name], t, (value) => update(field.name, value)))),
  WF_H('div', { className: 'zwf-dir-dialog-note' },
    WF_H('span', { className: 'zwf-dir-dialog-note-glyph' }, WF_H(WF_ICON.external, { size: 14 })),
    WF_H('p', null, say('directory.launch.note', { project: projectLabel }))),
  failure === null ? null : WF_H(WF_UI.ErrorNotice, { message: failure }));
}

/** Status-aware failure copy: missing and duplicate-name answers are actionable, the rest is not. */
function wfDirectoryFailureText(t, kind, error) {
  const status = error !== null && typeof error === 'object' ? error.status : undefined;
  if (status === 404) return kind === 'move'
    ? wfDirectorySay(t, 'directory.move.missing')
    : wfDirectorySay(t, 'directory.delete.missing');
  if (kind === 'move' && status === 409) return wfDirectorySay(t, 'directory.move.exists');
  return wfDirectorySay(t, kind === 'move' ? 'directory.move.failed' : 'directory.delete.failed');
}

function WorkflowDeleteDialog(props) {
  const { entry, t, projectRoot, onClose, onDone } = props;
  const say = (key, params) => wfDirectorySay(t, key, params);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState(null);
  const confirm = async () => {
    if (busy || typeof projectRoot !== 'string' || projectRoot === '') return;
    setBusy(true);
    setFailure(null);
    try {
      await WF_API.deleteWorkflow({
        projectRoot,
        name: entry.name,
        scope: entry.scope === 'global' ? 'global' : 'project',
      });
    } catch (error) {
      console.warn('zcode-workflow: deleting a saved workflow failed', error);
      setBusy(false);
      setFailure(wfDirectoryFailureText(t, 'delete', error));
      return;
    }
    setBusy(false);
    onDone();
  };
  return WF_H(WF_UI.Modal, {
    open: true,
    title: say('directory.delete.title', { name: entry.name }),
    onClose,
    closeLabel: say('directory.close'),
    footer: WF_H(WF_FRAGMENT, null,
      WF_H(WF_UI.Button, { variant: 'ghost', size: 'md', disabled: busy, onClick: onClose }, say('directory.launch.cancel')),
      WF_H(WF_UI.Button, {
        variant: 'danger',
        size: 'md',
        disabled: busy,
        icon: busy === true ? WF_H(WF_UI.Spinner) : undefined,
        onClick: () => {
          void confirm();
        },
      }, say('directory.delete.confirm'))),
  },
  WF_H('p', { className: 'zwf-dir-dialog-desc' }, say('directory.delete.body')),
  failure === null ? null : WF_H(WF_UI.ErrorNotice, { message: failure }));
}

function WorkflowMoveDialog(props) {
  const { entry, t, projectRoot, projectLabel, onClose, onDone } = props;
  const say = (key, params) => wfDirectorySay(t, key, params);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState(null);
  const confirm = async () => {
    if (busy || typeof projectRoot !== 'string' || projectRoot === '') return;
    setBusy(true);
    setFailure(null);
    try {
      await WF_API.moveWorkflow({ projectRoot, name: entry.name });
    } catch (error) {
      console.warn('zcode-workflow: moving a saved workflow failed', error);
      setBusy(false);
      setFailure(wfDirectoryFailureText(t, 'move', error));
      return;
    }
    setBusy(false);
    onDone();
  };
  return WF_H(WF_UI.Modal, {
    open: true,
    title: say('directory.move.title'),
    onClose,
    closeLabel: say('directory.close'),
    footer: WF_H(WF_FRAGMENT, null,
      WF_H(WF_UI.Button, { variant: 'ghost', size: 'md', disabled: busy, onClick: onClose }, say('directory.launch.cancel')),
      WF_H(WF_UI.Button, {
        variant: 'primary',
        size: 'md',
        disabled: busy,
        icon: busy === true ? WF_H(WF_UI.Spinner) : undefined,
        onClick: () => {
          void confirm();
        },
      }, say('directory.move.confirm'))),
  },
  WF_H('p', { className: 'zwf-dir-dialog-desc' }, say('directory.move.body', { name: entry.name, project: projectLabel })),
  failure === null ? null : WF_H(WF_UI.ErrorNotice, { message: failure }));
}

/* --------------------------------- sidebar --------------------------------- */

function WorkflowDirectoryPanelIcon(props) {
  const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 20;
  return WF_H(WF_ICON.workflow, { size, strokeWidth: props?.active === true ? 1.8 : 1.6 });
}

/* -------------------------------- register --------------------------------- */

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
    const service = wfDirectoryWorkspaceService(ctx);
    if (service === undefined || typeof service.startSession !== 'function') return false;
    try {
      service.startSession(workspaceId, { prompt: String(prompt), whenDraftExists: 'append' });
      return true;
    } catch (error) {
      console.warn('zcode-workflow: opening a conversation failed', error);
      return false;
    }
  };
  slots.inject('main', () => slots.register({
    name: 'main',
    key: WF_DIRECTORY_PANEL_ID,
    locale: UI_NS,
    inject: () => ({ openChat }),
  }, WorkflowDirectoryPage));
  slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: WF_DIRECTORY_PANEL_ID,
    order: WF_DIRECTORY_ORDER,
    locale: UI_NS,
    label: () => WF_UI.say(translate, UI_EN, 'directory.panel'),
  }, WorkflowDirectoryPanelIcon));
};

/* ---------------------------------- styles --------------------------------- */

const WF_DIRECTORY_CSS = `
.zwf-dir-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin:16px 0 4px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.zwf-dir-field{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%}
.zwf-dir-field-label{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-select{box-sizing:border-box;max-width:280px;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.zwf-select:disabled{opacity:.5;cursor:default}
.zwf-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.zwf-select-wide{max-width:none;width:100%}
.zwf-dir-content{display:flex;flex-direction:column;min-width:0;margin-top:4px}
.zwf-dir-loading{display:flex;align-items:center;justify-content:center;padding:48px 0}
.zwf-dir-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;min-width:0}
.zwf-dir-card{gap:10px;justify-content:space-between}
.zwf-dir-card .zwf-card-desc{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;white-space:normal;overflow:hidden}
.zwf-dir-card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.zwf-dir-args{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.zwf-dir-card .zwf-anchor{display:inline-flex}
.zwf-dir-warn{display:flex;align-items:flex-start;gap:8px;margin-top:12px;padding:8px 10px;border:1px solid color-mix(in oklab,var(--dsw-alias-state-warn-primary) 35%,transparent);border-radius:var(--dsw-radius-sm,8px);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 8%,transparent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-dir-warn-glyph{display:flex;flex:none;color:var(--dsw-alias-state-warn-primary)}
.zwf-dir-dialog-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.zwf-dir-dialog-note{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-dir-dialog-note p{margin:0}
.zwf-dir-dialog-note-glyph{display:flex;flex:none;margin-top:1px;color:var(--dsw-alias-label-secondary)}
.zwf-dir-form{display:flex;flex-direction:column;gap:12px}
.zwf-dir-arg{display:flex;flex-direction:column;gap:5px;min-width:0}
.zwf-dir-arg-head{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}
.zwf-dir-arg-name{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.zwf-dir-required{height:18px;font-size:11px;line-height:18px}
.zwf-dir-arg-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.zwf-dir-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}
.zwf-dir-checkbox{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
`;

WF_STYLE_PARTS.push(WF_DIRECTORY_CSS);
