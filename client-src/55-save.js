/* "Save this run as a workflow": the trailing action of a run's header and the popover behind it.
 *
 * Two paths lead to a saved workflow — hand the run to the agent and let it distil a reusable
 * script, or write the run's own script as it stands. The second path needs a name, a scope and a
 * description, warns before overwriting a same-named file, and tells the user which file it is
 * about to write.
 *
 * The mount site owns nothing here: `WF_SAVE.Slot` renders the button (or, once the run is saved,
 * the saved chip next to a "run again" action) and the popover, and reports a save upward.
 */

const WF_SAVE = {};

/** Delay before the duplicate-name probe runs, so typing does not fire one request per key. */
const WF_SAVE_PROBE_MS = 320;

/** Longest workflow name the facade accepts. */
const WF_SAVE_NAME_MAX = 64;

/** Name a workflow may carry: letters, digits, dash, underscore, dot. */
const WF_SAVE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;

/** Copy from the workspace dictionary, with the compiled English text as fallback. */
function wfSaveSay(t, key, params) {
  return WF_UI.say(t, UI_EN, key, params);
}

/** The workflow file name of one workflow name. */
function wfSaveFileName(name) {
  return `${name}.dwf.ts`;
}

/** Directory of the workflows the project already has, when one can be read from a path. */
function wfSaveDirectory(rows) {
  for (const row of rows ?? []) {
    const path = typeof row?.path === 'string' ? row.path : '';
    if (path === '' || !path.endsWith('.dwf.ts')) continue;
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (cut > 0) return path.slice(0, cut);
  }
  return '';
}

/** Save failure copy: the host's reason code, or the thrown message. */
function wfSaveFailure(t, error) {
  const record = error !== null && typeof error === 'object' ? error : {};
  const reason = typeof record.reason === 'string'
    ? record.reason
    : typeof record.code === 'string' ? record.code : '';
  const key = `chat.toolCall.workflow.saveRun.error.${reason}`;
  if (Object.prototype.hasOwnProperty.call(UI_EN, key)) return wfSaveSay(t, key);
  const message = typeof record.message === 'string' ? record.message : '';
  return message === '' ? wfSaveSay(t, 'chat.toolCall.workflow.saveRun.error.generic') : message;
}

/**
 * One workflow name the run may be saved under: the run's label, sanitized.
 * @param {unknown} run
 */
function wfSaveDefaultName(run) {
  const record = run !== null && typeof run === 'object' ? run : {};
  const raw = typeof record.label === 'string' && record.label !== ''
    ? record.label
    : typeof record.name === 'string' && record.name !== ''
      ? record.name
      : typeof record.runId === 'string' ? record.runId : '';
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, WF_SAVE_NAME_MAX);
  return cleaned;
}

/** The run identity of a run row or snapshot, in either spelling. */
function wfSaveRunId(run) {
  const record = run !== null && typeof run === 'object' ? run : {};
  for (const value of [record.runId, record.id]) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/**
 * The save action of a run's header: a button that opens the popover, or — when the run was
 * already saved — the saved chip beside "run again".
 * @param {{ sessionId?: string, runId?: string, run?: unknown, projectRoot?: string, t?: Function, openChat?: Function, onSaved?: Function, onOpenHub?: Function }} props
 */
function WfSaveSlot(props) {
  const t = typeof props?.t === 'function' ? props.t : undefined;
  const say = (key, params) => wfSaveSay(t, key, params);
  const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
  const projectRoot = typeof props?.projectRoot === 'string' ? props.projectRoot : '';
  const runId = typeof props?.runId === 'string' && props.runId !== '' ? props.runId : wfSaveRunId(props?.run);
  const [open, setOpen] = React.useState(false);
  const [savedEntry, setSavedEntry] = React.useState(undefined);
  const anchorRef = React.useRef(null);
  const popRef = React.useRef(null);

  React.useEffect(() => {
    let active = true;
    if (runId === '' || projectRoot === '') return undefined;
    WF_API.workflowForRun({ projectRoot, runId })
      .then((payload) => {
        if (!active) return;
        const entry = payload !== null && typeof payload === 'object' && payload.entry !== null && typeof payload.entry === 'object'
          ? payload.entry
          : undefined;
        setSavedEntry(entry);
      })
      .catch((error) => {
        console.warn('zcode-workflow: looking up the saved workflow of a run failed', error);
        if (active) setSavedEntry(undefined);
      });
    return () => {
      active = false;
    };
  }, [projectRoot, runId]);

  const runAgain = () => {
    if (savedEntry === undefined) return;
    if (typeof props?.openChat !== 'function') return;
    const name = typeof savedEntry.name === 'string' ? savedEntry.name : '';
    if (name === '') return;
    props.openChat(say('workflows.hub.prompt.runNoArgs', { name }));
  };

  if (savedEntry !== undefined) {
    return WF_H('div', { className: 'zwf-save-slot' },
      WF_H('span', {
        className: 'zwf-save-chip',
        'data-testid': 'workflow-saved-chip',
        title: say('chat.toolCall.workflow.saveRun.chip.hint'),
        role: 'button',
        tabIndex: 0,
        onClick: () => {
          if (typeof props?.onOpenHub === 'function') props.onOpenHub(savedEntry);
        },
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          if (typeof props?.onOpenHub === 'function') props.onOpenHub(savedEntry);
        },
      },
      WF_H(WF_ICON.check, { size: 12 }),
      WF_H('span', null, say('chat.toolCall.workflow.saveRun.chip'))),
      WF_H(WF_UI.Button, {
        variant: 'subtle',
        size: 'sm',
        icon: WF_H(WF_ICON.run, { size: 13 }),
        'data-testid': 'workflow-save-run-again',
        disabled: typeof props?.openChat !== 'function',
        onClick: runAgain,
      }, say('chat.toolCall.workflow.saveRun.runAgain')));
  }

  return WF_H('div', { className: 'zwf-save-slot zwf-anchor', ref: anchorRef },
    WF_H(WF_UI.Button, {
      variant: 'subtle',
      size: 'sm',
      icon: WF_H(WF_ICON.artifact, { size: 13 }),
      'data-testid': 'workflow-save-open',
      disabled: runId === '' || projectRoot === '',
      pressed: open,
      onClick: () => setOpen((value) => value !== true),
    }, say('chat.toolCall.workflow.saveRun.action')),
    open
      ? WF_H(WfSavePopover, {
        t,
        sessionId,
        projectRoot,
        runId,
        run: props?.run,
        anchorRef,
        popRef: popRef,
        openChat: props?.openChat,
        onClose: () => setOpen(false),
        onSaved: (entry) => {
          setSavedEntry(entry);
          setOpen(false);
          if (typeof props?.onSaved === 'function') props.onSaved(entry);
        },
      })
      : null);
}

/**
 * The popover: hand the run to the agent, or write the script as it stands.
 * @param {{ t?: Function, sessionId: string, projectRoot: string, runId: string, run?: unknown, anchorRef?: object, popRef?: object, openChat?: Function, onClose: Function, onSaved: Function }} props
 */
function WfSavePopover(props) {
  const t = typeof props.t === 'function' ? props.t : undefined;
  const say = (key, params) => wfSaveSay(t, key, params);
  const [name, setName] = React.useState(() => wfSaveDefaultName(props.run));
  const [scope, setScope] = React.useState('project');
  const [description, setDescription] = React.useState('');
  const [probe, setProbe] = React.useState({ project: undefined, global: undefined });
  const [failure, setFailure] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [handed, setHanded] = React.useState(false);
  const [directory, setDirectory] = React.useState('');
  const timer = React.useRef(undefined);

  React.useEffect(() => {
    let active = true;
    WF_API.workflows({ projectRoot })
      .then((payload) => {
        if (!active) return;
        const rows = Array.isArray(payload?.workflows) ? payload.workflows : Array.isArray(payload?.entries) ? payload.entries : [];
        setDirectory(wfSaveDirectory(rows));
      })
      .catch(() => {
        if (active) setDirectory('');
      });
    return () => {
      active = false;
    };
  }, [projectRoot]);

  const trimmed = name.trim();
  const nameInvalid = trimmed === '' || trimmed.length > WF_SAVE_NAME_MAX || !WF_SAVE_NAME_PATTERN.test(trimmed);
  const overwrite = probe.project !== undefined;
  const shadowing = probe.project === undefined && probe.global !== undefined && scope === 'project'
    ? 'chat.toolCall.workflow.save.scope.hidesGlobal'
    : probe.project !== undefined && probe.global !== undefined && scope === 'global'
      ? 'chat.toolCall.workflow.save.scope.hiddenByProject'
      : undefined;
  const predictedPath = directory === '' ? wfSaveFileName(trimmed) : `${directory}/${wfSaveFileName(trimmed)}`;

  React.useEffect(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    if (trimmed === '' || nameInvalid) {
      setProbe({ project: undefined, global: undefined });
      return undefined;
    }
    timer.current = setTimeout(() => {
      let active = true;
      Promise.all([
        WF_API.workflow({ projectRoot, name: trimmed, scope: 'project' }).catch(() => undefined),
        WF_API.workflow({ projectRoot, name: trimmed, scope: 'global' }).catch(() => undefined),
      ]).then(([projectPayload, globalPayload]) => {
        if (!active) return;
        setProbe({
          project: wfSaveFound(projectPayload) ? projectPayload : undefined,
          global: wfSaveFound(globalPayload) ? globalPayload : undefined,
        });
      });
      return () => {
        active = false;
      };
    }, WF_SAVE_PROBE_MS);
    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, [projectRoot, trimmed, nameInvalid]);

  const submit = async () => {
    if (saving || nameInvalid || props.runId === '') return;
    setSaving(true);
    setFailure(null);
    try {
      const payload = await WF_API.saveWorkflow({
        projectRoot: props.projectRoot,
        runId: props.runId,
        name: trimmed,
        scope,
        meta: description.trim() === '' ? undefined : { description: description.trim() },
        overwrite: overwrite,
      });
      if (payload !== null && typeof payload === 'object' && payload.ok === false) {
        setSaving(false);
        setFailure(wfSaveFailure(t, payload));
        if (payload.reason === 'target_exists') {
          setProbe((current) => ({ ...current, project: payload }));
        }
        return;
      }
      setSaving(false);
      props.onSaved(payload !== null && typeof payload === 'object' ? payload : undefined);
    } catch (error) {
      console.warn('zcode-workflow: saving a run as a workflow failed', error);
      setSaving(false);
      setFailure(wfSaveFailure(t, error));
    }
  };

  const handToAgent = () => {
    if (handed) return;
    if (typeof props.openChat !== 'function') {
      setFailure(say('chat.toolCall.workflow.saveRun.lead.unsupported'));
      return;
    }
    const opened = props.openChat(say('chat.toolCall.workflow.saveRun.lead'));
    if (opened !== true) {
      setFailure(say('chat.toolCall.workflow.saveRun.lead.unsupported'));
      return;
    }
    setHanded(true);
  };

  return WF_H('div', {
    className: 'zwf-save-pop',
    role: 'dialog',
    'data-testid': 'workflow-save-popover',
    ref: props.popRef,
    onKeyDown: (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        props.onClose();
        return;
      }
      if (event.key === 'Enter' && (event.metaKey === true || event.ctrlKey === true)) {
        event.preventDefault();
        handToAgent();
      }
    },
  },
  WF_H('div', { className: 'zwf-save-head' }, say('chat.toolCall.workflow.saveRun.title')),
  WF_H('button', {
    type: 'button',
    className: 'zwf-save-lead',
    'data-testid': 'workflow-save-lead',
    disabled: handed || typeof props.openChat !== 'function',
    onClick: handToAgent,
  },
  WF_H('span', { className: 'zwf-save-lead-label' }, say(handed ? 'chat.toolCall.workflow.saveRun.lead.sending' : 'chat.toolCall.workflow.saveRun.lead')),
  WF_H('span', { className: 'zwf-save-lead-hint' },
    typeof props.openChat === 'function'
      ? say('chat.toolCall.workflow.saveRun.lead.hint')
      : say('chat.toolCall.workflow.saveRun.lead.unsupported'))),
  WF_H('div', { className: 'zwf-save-or' },
    WF_H('span', { className: 'zwf-save-rule' }),
    WF_H('span', null, say('chat.toolCall.workflow.saveRun.or')),
    WF_H('span', { className: 'zwf-save-rule' })),
  WF_H('label', { className: 'zwf-save-field' },
    WF_H('span', { className: 'zwf-save-label' }, say('chat.toolCall.workflow.saveRun.name')),
    WF_H('span', { className: 'zwf-save-input-wrap' },
      WF_H('input', {
        className: `zwf-save-input${nameInvalid ? ' zwf-save-input-invalid' : ''}`,
        type: 'text',
        maxLength: WF_SAVE_NAME_MAX,
        value: name,
        'data-testid': 'workflow-save-name',
        placeholder: say('chat.toolCall.workflow.saveRun.name.placeholder'),
        onChange: (event) => setName(event.target.value),
        onKeyDown: (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          void submit();
        },
      }),
      WF_H('span', { className: 'zwf-save-suffix' }, '.dwf.ts')),
    WF_H('span', {
      className: `zwf-save-helper${nameInvalid ? ' zwf-save-helper-invalid' : ''}`,
      'data-testid': 'workflow-save-name-helper',
    }, say(nameInvalid ? 'chat.toolCall.workflow.saveRun.name.invalid' : 'chat.toolCall.workflow.saveRun.name.helper'))),
  WF_H('div', { className: 'zwf-save-field' },
    WF_H('span', { className: 'zwf-save-label' }, say('chat.toolCall.workflow.save.scope.label')),
    WF_H('div', { className: 'zwf-save-seg', role: 'radiogroup', 'data-testid': 'workflow-save-scope', 'aria-label': say('chat.toolCall.workflow.save.scope.label') },
      [['project', 'chat.toolCall.workflow.save.scope.project'], ['global', 'chat.toolCall.workflow.save.scope.global']].map(([value, key]) => WF_H('button', {
        key: value,
        type: 'button',
        role: 'radio',
        'aria-checked': scope === value,
        className: `zwf-save-seg-item${scope === value ? ' zwf-save-seg-item-active' : ''}`,
        onClick: () => setScope(value),
      }, say(key))))),
  WF_H('label', { className: 'zwf-save-field' },
    WF_H('span', { className: 'zwf-save-label' }, say('chat.toolCall.workflow.saveRun.description')),
    WF_H('textarea', {
      className: 'zwf-save-textarea',
      rows: 2,
      value: description,
      'data-testid': 'workflow-save-description',
      onChange: (event) => setDescription(event.target.value),
    }),
    WF_H('span', { className: 'zwf-save-helper' }, say('chat.toolCall.workflow.saveRun.description.helper'))),
  failure === null
    ? null
    : WF_H('p', { className: 'zwf-save-failure', role: 'alert', 'data-testid': 'workflow-save-failure' }, failure),
  overwrite
    ? WF_H('div', { className: 'zwf-save-overwrite', 'data-testid': 'workflow-save-overwrite' },
      WF_H('p', { className: 'zwf-save-overwrite-line' }, say('chat.toolCall.workflow.saveRun.overwrite')),
      shadowing === undefined ? null : WF_H('p', { className: 'zwf-save-overwrite-line' }, say('chat.toolCall.workflow.saveRun.shadowing', { text: say(shadowing) })))
    : WF_H('div', { className: 'zwf-save-consequence', 'data-testid': 'workflow-save-consequence' },
      say('chat.toolCall.workflow.saveRun.consequence', { path: predictedPath }),
      shadowing === undefined ? null : WF_H('span', { className: 'zwf-save-consequence-extra' }, say('chat.toolCall.workflow.saveRun.shadowing', { text: say(shadowing) }))),
  WF_H('div', { className: 'zwf-save-foot' },
    WF_H(WF_UI.Button, {
      variant: 'subtle',
      size: 'sm',
      'data-testid': 'workflow-save-submit',
      disabled: saving || nameInvalid,
      onClick: () => {
        void submit();
      },
    }, say(saving
      ? 'chat.toolCall.workflow.saveRun.submit.saving'
      : overwrite ? 'chat.toolCall.workflow.saveRun.submit.overwrite' : 'chat.toolCall.workflow.saveRun.submit'))));
}

/** Whether a `workflows/get` body means "this workflow exists". */
function wfSaveFound(payload) {
  if (payload === null || typeof payload !== 'object') return false;
  if (payload.ok === false) return false;
  return payload.ok === true || typeof payload.path === 'string';
}

/* ---------------------------------- surface -------------------------------- */

/** The trailing save action of a run's header. */
WF_SAVE.Slot = WfSaveSlot;

/** The popover on its own, for a surface that owns the trigger. */
WF_SAVE.Popover = WfSavePopover;

/* ---------------------------------- styles --------------------------------- */

const WF_SAVE_CSS = `
.zwf-save-slot{display:inline-flex;align-items:center;gap:6px;flex:none}
.zwf-save-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;cursor:pointer}
.zwf-save-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.zwf-save-pop{position:absolute;z-index:70;top:calc(100% + 6px);right:0;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;width:min(320px,calc(100vw - 16px));padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-overlay);box-shadow:0 14px 40px rgb(0 0 0 / .22)}
.zwf-save-head{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.zwf-save-lead{box-sizing:border-box;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.zwf-save-lead:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.zwf-save-lead:disabled{opacity:.6;cursor:default}
.zwf-save-lead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-save-lead-label{font-size:12.5px;line-height:18px;font-weight:500}
.zwf-save-lead-hint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.zwf-save-or{display:flex;align-items:center;gap:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.zwf-save-rule{flex:1;height:1px;background:var(--dsw-alias-border-l1)}
.zwf-save-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.zwf-save-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.zwf-save-input-wrap{position:relative;display:block;min-width:0}
.zwf-save-input{box-sizing:border-box;width:100%;height:30px;padding:0 58px 0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:20px}
.zwf-save-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;border-color:transparent}
.zwf-save-input-invalid{border-color:var(--dsw-alias-state-error-primary)}
.zwf-save-suffix{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);pointer-events:none}
.zwf-save-helper{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.zwf-save-helper-invalid{color:var(--dsw-alias-state-error-primary)}
.zwf-save-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);align-self:flex-start;max-width:100%}
.zwf-save-seg-item{box-sizing:border-box;height:26px;padding:0 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:18px;font-weight:500;white-space:nowrap;cursor:pointer}
.zwf-save-seg-item:hover{color:var(--dsw-alias-label-primary)}
.zwf-save-seg-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-save-seg-item-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgb(0 0 0 / .08)}
.zwf-save-textarea{box-sizing:border-box;width:100%;min-height:52px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:18px;resize:vertical}
.zwf-save-textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;border-color:transparent}
.zwf-save-failure{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.zwf-save-overwrite{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid color-mix(in oklab,var(--dsw-alias-state-warn-primary) 40%,transparent);border-radius:var(--dsw-radius-sm,8px);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.zwf-save-overwrite-line{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-primary)}
.zwf-save-consequence{display:flex;flex-direction:column;gap:2px;margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.zwf-save-consequence-extra{color:var(--dsw-alias-label-secondary)}
.zwf-save-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px}
`;

WF_STYLE_PARTS.push(WF_SAVE_CSS);
