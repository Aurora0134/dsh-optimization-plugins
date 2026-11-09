/* Settings row for the dynamic-workflow mode. */

const WF_SETTINGS = {};

/** The three modes the Host accepts, in selector order. */
const WF_SETTINGS_MODES = ['disabled', 'onDemand', 'alwaysOn'];

/** Copy from the settings-row dictionary, with the compiled English text as fallback. */
function wfSettingsSay(t, key, params) {
  return WF_UI.say(t, UI_EN, key, params);
}

/**
 * One General Settings row: title and explanation on the left, a three-way mode selector on the
 * right. A choice saves immediately; while it saves the control is disabled, and a failure keeps
 * the previous value on screen next to the error.
 * @param {object} props slot props: `t`
 */
function WorkflowModeRow(props) {
  const t = typeof props?.t === 'function' ? props.t : undefined;
  const say = (key, params) => wfSettingsSay(t, key, params);
  const loaded = useWfAsync(() => WF_API.mode(), []);
  const [saved, setSaved] = React.useState(null);
  const [pending, setPending] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState(null);
  const payload = loaded.data;

  React.useEffect(() => {
    if (payload === null || typeof payload !== 'object') return;
    const mode = typeof payload.mode === 'string' && WF_SETTINGS_MODES.includes(payload.mode) ? payload.mode : 'alwaysOn';
    setSaved({
      mode,
      effective: payload.effective === 'restart' ? 'restart' : 'immediate',
      writable: payload.writable !== false,
    });
  }, [payload]);

  const mode = pending ?? (saved === null ? 'alwaysOn' : saved.mode);
  const writable = saved === null
    ? payload === null || typeof payload !== 'object' || payload.writable !== false
    : saved.writable !== false;
  const loading = saved === null && loaded.loading;
  const loadError = saved === null && loaded.error !== undefined;
  const restart = saved !== null && saved.effective === 'restart';

  const choose = async (next) => {
    if (saving || writable !== true || saved === null || next === saved.mode) return;
    setPending(next);
    setSaving(true);
    setFailure(null);
    try {
      const result = await WF_API.setMode(next);
      const savedMode = result !== null && typeof result === 'object' && typeof result.mode === 'string' && WF_SETTINGS_MODES.includes(result.mode)
        ? result.mode
        : next;
      setSaved({
        mode: savedMode,
        effective: result !== null && typeof result === 'object' && result.effective === 'restart' ? 'restart' : 'immediate',
        writable,
      });
    } catch (error) {
      console.warn('zcode-workflow: saving the dynamic-workflow mode failed', error);
      setFailure(say('settingsRow.saveError'));
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
      WF_H('span', { className: 'zwf-set-error', role: 'alert' }, say('settingsRow.loadError')),
      WF_H(WF_UI.Button, {
        variant: 'subtle',
        size: 'sm',
        onClick: () => loaded.reload(),
      }, say('settingsRow.retry')));
  } else {
    control = WF_H('div', { className: 'zwf-seg', role: 'radiogroup', 'aria-label': say('settingsRow.ariaLabel') },
      WF_SETTINGS_MODES.map((option) => WF_H('button', {
        key: option,
        type: 'button',
        role: 'radio',
        'aria-checked': mode === option,
        className: `zwf-seg-item${mode === option ? ' zwf-seg-item-active' : ''}`,
        disabled: saving || writable !== true || saved === null,
        onClick: () => {
          void choose(option);
        },
      }, say(`settingsRow.option.${option}`))));
  }

  return WF_H('div', { className: 'zwf-set-row' },
    WF_H('div', { className: 'zwf-set-main' },
      WF_H('div', { className: 'zwf-set-title' }, say('settingsRow.title')),
      WF_H('div', { className: 'zwf-set-desc' }, say('settingsRow.description')),
      loading ? null : WF_H('div', { className: 'zwf-set-detail' }, say(`settingsRow.option.${mode}.description`)),
      restart && loading === false ? WF_H('div', { className: 'zwf-set-note' }, say('settingsRow.restart')) : null,
      saved !== null && saved.writable === false
        ? WF_H('div', { className: 'zwf-set-note' }, say('settingsRow.readOnly'))
        : null,
      failure === null ? null : WF_H('div', { className: 'zwf-set-error', role: 'alert' }, failure)),
    WF_H('div', { className: 'zwf-set-control' },
      control,
      saving
        ? WF_H('span', { className: 'zwf-set-saving' }, WF_H(WF_UI.Spinner), say('settingsRow.saving'))
        : null));
}

/* -------------------------------- register --------------------------------- */

WF_SETTINGS.register = function register(ctx, effect) {
  if (ctx === null || typeof ctx !== 'object') return;
  const slots = ctx.slots;
  if (slots === undefined || slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;
  slots.inject('settings.general.item', () => slots.register({
    name: 'settings.general.item',
    id: 'dynamic-workflow',
    order: 60,
    locale: UI_NS,
  }, WorkflowModeRow));
};

/* ---------------------------------- styles --------------------------------- */

const WF_SETTINGS_CSS = `
.zwf-set-row{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.zwf-set-row:last-child{border-bottom:0}
.zwf-set-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.zwf-set-title{font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.zwf-set-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-set-detail{margin-top:2px;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-set-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-set-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.zwf-set-control{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none;max-width:100%}
.zwf-set-saving{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);max-width:100%}
.zwf-seg-item{box-sizing:border-box;height:28px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;font-weight:500;white-space:nowrap;cursor:pointer}
.zwf-seg-item:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.zwf-seg-item:disabled{opacity:.5;cursor:default}
.zwf-seg-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-seg-item-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgb(0 0 0 / .08)}
@media (max-width:560px){.zwf-set-row{flex-direction:column;align-items:stretch;gap:12px}.zwf-set-control{align-items:flex-start}.zwf-seg{flex-wrap:wrap}}
`;

WF_STYLE_PARTS.push(WF_SETTINGS_CSS);
