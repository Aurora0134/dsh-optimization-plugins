/* Client entry: dictionaries, styles and slot registrations. */

/**
 * Run one surface's slot registration when that surface's part is present.
 *
 * Each part declares its own surface object, so a surface that has not been loaded yet (or was
 * removed) must not break the whole registration pass — hence the guarded read plus the caught
 * ReferenceError instead of a direct identifier reference.
 *
 * @param {() => { register?: (ctx: object, effect: Function) => void } | undefined} read
 * @param {object} ctx
 * @param {(callback: Function, label: string) => unknown} effect
 * @param {string} label
 */
function runSurface(read, ctx, effect, label) {
  let surface;
  try {
    surface = read();
  } catch {
    return;
  }
  if (surface === undefined || surface === null || typeof surface.register !== 'function') return;
  try {
    surface.register(ctx, effect);
  } catch (error) {
    console.error(`zcode-workflow: ${label} registration failed`, error);
  }
}

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

  runSurface(() => WF_CARDS, ctx, effect, 'tool cards');
  runSurface(() => WF_PERMISSION, ctx, effect, 'launch confirmation');
  runSurface(() => WF_DETAIL, ctx, effect, 'run detail');
  runSurface(() => WF_DIRECTORY, ctx, effect, 'workflow directory');
  runSurface(() => WF_SETTINGS, ctx, effect, 'settings row');
  runSurface(() => WF_STATUS, ctx, effect, 'session status');
}

return {
  name: 'zcode-workflow',
  inject: ['slots', 'locale'],
  apply,
};
