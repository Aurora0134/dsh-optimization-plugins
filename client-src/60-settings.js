/* Settings row for dynamic workflows.
 *
 * One `settings.general.item` row: the title and the product description on the left, a three-way
 * selector on the right, and under it the explanation of the mode that is currently chosen. A
 * choice saves immediately; while it saves the control is disabled, and a failed save keeps the
 * previous choice on screen next to the failure.
 */

const WF_SETTINGS = {};

/** The three modes the Host accepts, in selector order. */
const WF_SETTINGS_MODES = ['disabled', 'onDemand', 'alwaysOn'];

/** Mode assumed when the Host publishes none; matches the facade default. */
const WF_SETTINGS_DEFAULT_MODE = 'alwaysOn';

/** Copy from the workspace dictionary, with the compiled English text as fallback. */
function wfSettingsSay(t, key, params) {
  return WF_UI.say(t, UI_EN, key, params);
}

/** The mode name of the selector: `settings.dynamicWorkflow.option.<mode>`. */
function wfSettingsModeLabel(t, mode) {
  return wfSettingsSay(t, `settings.dynamicWorkflow.option.${mode}`);
}

/** The policy request that mirrors one selector choice. */
function wfSettingsPolicy(mode) {
  return mode === 'disabled' ? { enabled: false } : { enabled: true, mode };
}

/** The selector choice a policy payload means. */
function wfSettingsMode(payload) {
  const record = payload !== null && typeof payload === 'object' ? payload : {};
  if (record.enabled === false) return 'disabled';
  return typeof record.mode === 'string' && WF_SETTINGS_MODES.includes(record.mode) ? record.mode : WF_SETTINGS_DEFAULT_MODE;
}

/**
 * @param {object} props slot props: `t`, and optionally `projectRoot`
 */
function WfSettingsRow(props) {
  const t = typeof props?.t === 'function' ? props.t : undefined;
  const say = (key, params) => wfSettingsSay(t, key, params);
  const projectRoot = typeof props?.projectRoot === 'string' && props.projectRoot !== '' ? props.projectRoot : undefined;
  const loaded = useWfAsync(() => WF_API.policy({ projectRoot }), [projectRoot]);
  const [saved, setSaved] = React.useState(null);
  const [pending, setPending] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState(null);
  const payload = loaded.data;

  React.useEffect(() => {
    if (payload === null || typeof payload !== 'object') return;
    setSaved({
      mode: wfSettingsMode(payload),
      defaultMode: typeof payload.default === 'string' && WF_SETTINGS_MODES.includes(payload.default)
        ? payload.default
        : WF_SETTINGS_DEFAULT_MODE,
      effective: payload.effective === 'restart' ? 'restart' : 'immediate',
      writable: payload.writable !== false,
    });
  }, [payload]);

  const mode = pending ?? (saved === null ? WF_SETTINGS_DEFAULT_MODE : saved.mode);
  const defaultMode = saved === null ? WF_SETTINGS_DEFAULT_MODE : saved.defaultMode;
  const writable = saved === null ? true : saved.writable !== false;
  const loading = saved === null && loaded.loading;
  const loadError = saved === null && loaded.error !== undefined;
  const restart = saved !== null && saved.effective === 'restart';

  const choose = async (next) => {
    if (saving || writable !== true || saved === null || next === saved.mode) return;
    setPending(next);
    setSaving(true);
    setFailure(null);
    try {
      const result = await WF_API.setPolicy({ projectRoot, ...wfSettingsPolicy(next) });
      const record = result !== null && typeof result === 'object' ? result : {};
      // The save response reports the workspace and whether the choice needs a restart; the mode
      // itself is the one that was just accepted, so the selector keeps the user's choice.
      setSaved({
        mode: next,
        defaultMode,
        effective: record.effective === 'restart' ? 'restart' : 'immediate',
        writable,
      });
    } catch (error) {
      console.warn('zcode-workflow: saving the dynamic workflow setting failed', error);
      setFailure(say('settings.dynamicWorkflow.saveError'));
    } finally {
      setSaving(false);
      setPending(null);
    }
  };

  let control;
  if (loading) {
    control = WF_H(WF_UI.Spinner);
  } else if (loadError) {
    control = WF_H(WF_FRAGMENT, null,
      WF_H('span', { className: 'zwf-set-error', role: 'alert' }, say('settings.dynamicWorkflow.loadError')),
      WF_H(WF_UI.Button, {
        variant: 'subtle',
        size: 'sm',
        onClick: () => loaded.reload(),
      }, say('settings.dynamicWorkflow.retry')));
  } else {
    control = WF_H('div', {
      className: 'zwf-set-seg',
      role: 'radiogroup',
      'aria-label': say('settings.dynamicWorkflow'),
    }, WF_SETTINGS_MODES.map((option) => WF_H('button', {
      key: option,
      type: 'button',
      role: 'radio',
      'aria-checked': mode === option,
      'data-testid': `workflow-settings-mode-${option}`,
      className: `zwf-set-seg-item${mode === option ? ' zwf-set-seg-item-active' : ''}`,
      disabled: saving || writable !== true || saved === null,
      onClick: () => {
        void choose(option);
      },
    },
    WF_H('span', { className: 'zwf-set-seg-label' }, wfSettingsModeLabel(t, option)),
    option === defaultMode ? WF_H('span', { className: 'zwf-set-seg-tag' }, say('settings.dynamicWorkflow.defaultTag')) : null)));
  }

  return WF_H('div', { className: 'zwf-set-row', 'data-testid': 'workflow-settings-row' },
    WF_H('div', { className: 'zwf-set-main' },
      WF_H('div', { className: 'zwf-set-title' }, say('settings.dynamicWorkflow')),
      WF_H('div', { className: 'zwf-set-desc' }, say('settings.dynamicWorkflowDescription')),
      loading ? null : WF_H('div', { className: 'zwf-set-detail' }, wfSettingsSay(t, `settings.dynamicWorkflow.option.${mode}.description`)),
      restart && loading === false ? WF_H('div', { className: 'zwf-set-note' }, say('settings.dynamicWorkflow.restart')) : null,
      saved !== null && saved.writable === false
        ? WF_H('div', { className: 'zwf-set-note' }, say('settings.dynamicWorkflow.readOnly'))
        : null,
      failure === null ? null : WF_H('div', { className: 'zwf-set-error', role: 'alert' }, failure)),
    WF_H('div', { className: 'zwf-set-control' },
      control,
      saving
        ? WF_H('span', { className: 'zwf-set-saving' }, WF_H(WF_UI.Spinner), say('settings.dynamicWorkflow.saving'))
        : null));
}

/* -------------------------------- register --------------------------------- */

/**
 * Register the settings row.
 * @param {object} ctx client plugin context
 * @param {(callback: Function, label?: string) => unknown} effect effect registrar
 */
WF_SETTINGS.register = function register(ctx, effect) {
  if (ctx === null || typeof ctx !== 'object') return;
  const slots = ctx.slots;
  if (slots === undefined || slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;
  slots.inject('settings.general.item', () => slots.register({
    name: 'settings.general.item',
    id: 'dynamic-workflow',
    order: 60,
    locale: UI_NS,
  }, WfSettingsRow));
};

/* ---------------------------------- styles --------------------------------- */

const WF_SETTINGS_CSS = `
.zwf-set-row{box-sizing:border-box;display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.zwf-set-row:last-child{border-bottom:0}
.zwf-set-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.zwf-set-title{font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.zwf-set-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-set-detail{margin-top:2px;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-set-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-set-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.zwf-set-control{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none;max-width:100%}
.zwf-set-saving{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-set-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);max-width:100%}
.zwf-set-seg-item{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;font-weight:500;white-space:nowrap;cursor:pointer}
.zwf-set-seg-item:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.zwf-set-seg-item:disabled{opacity:.5;cursor:default}
.zwf-set-seg-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-set-seg-item-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgb(0 0 0 / .08)}
.zwf-set-seg-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.zwf-set-seg-tag{flex:none;height:16px;padding:0 5px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px;font-weight:400}
@media (max-width:560px){.zwf-set-row{flex-direction:column;align-items:stretch;gap:12px}.zwf-set-control{align-items:flex-start}.zwf-set-seg{flex-wrap:wrap}}
`;

WF_STYLE_PARTS.push(WF_SETTINGS_CSS);
