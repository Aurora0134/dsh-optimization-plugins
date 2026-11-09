/* Client entry: dictionaries, styles and slot registrations. */

function apply(ctx) {
  if (typeof ctx !== 'object' || ctx === null) return;
  const effect = typeof ctx.effect === 'function'
    ? (callback, label) => ctx.effect(callback, label)
    : (callback) => callback();
  if (ctx.locale && typeof ctx.locale.register === 'function') {
    effect(() => {
      const disposers = [];
      try {
        disposers.push(ctx.locale.register(NS, { en: EN, zh: ZH }));
        disposers.push(ctx.locale.register(UI_NS, { en: UI_EN, zh: UI_ZH }));
        disposers.push(ctx.locale.register(SETTINGS_NS, { en: SETTINGS_EN, zh: SETTINGS_ZH }));
      } catch (error) {
        console.error('zcode-workflow: locale registration failed', error);
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // best effort
          }
        }
      };
    }, 'zcode-workflow: dictionaries');
  }
  if (typeof document !== 'undefined' && document.head) {
    effect(() => {
      const style = document.createElement('style');
      style.dataset.plugin = 'zcode-workflow';
      style.textContent = CSS + WF_STYLE_PARTS.join('');
      document.head.append(style);
      return () => style.remove();
    }, 'zcode-workflow: styles');
  }
  if (!ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') return;

  ctx.slots.inject('tool.call.toolview', function* workflowToolCards() {
    for (const key of TOOL_NAMES) {
      yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS }, WorkflowCard);
    }
  });

  if (typeof WF_DETAIL.register === 'function') WF_DETAIL.register(ctx, effect);
  if (typeof WF_DIRECTORY.register === 'function') WF_DIRECTORY.register(ctx, effect);
  if (typeof WF_SETTINGS.register === 'function') WF_SETTINGS.register(ctx, effect);
  if (typeof WF_STATUS.register === 'function') WF_STATUS.register(ctx, effect);
}

return {
  name: 'zcode-workflow',
  inject: ['slots', 'locale'],
  apply,
};
