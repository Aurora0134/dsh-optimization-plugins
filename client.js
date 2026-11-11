/**
 * Browser half of `dsh-creator-overlay`.
 *
 * One switch in `conversation.input.dock` — the full-width strip above the
 * composer card. The switch is offered only while the Session is still blank:
 * the Host binds one preset composition before the first turn and refuses to
 * swap it afterwards. Flipping the switch selects the composed creation preset
 * on the blank Session; choosing another base mode while it is on re-applies
 * the creation composition for the new base.
 */
window.__ModuleLoader__.load({
  id: 'dsh-creator-overlay',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'creatorOverlay'

    /** Shipped preset ids and the composed creation preset for each base. */
    const CREATION_FOR_BASE = {
      standard: 'cordis',
      ptc: 'ptc-creation',
      minimal: 'minimal-creation',
    }
    /** Composed creation id -> base id it overlays. */
    const BASE_FOR_CREATION = {
      cordis: 'standard',
      'ptc-creation': 'ptc',
      'minimal-creation': 'minimal',
    }
    const BASE_IDS = new Set(['standard', 'ptc', 'minimal'])

    /** The base a preset id belongs to, or undefined for unrelated custom presets. */
    function baseOf(preset) {
      if (typeof preset !== 'string') return undefined
      if (BASE_FOR_CREATION[preset] !== undefined) return BASE_FOR_CREATION[preset]
      return BASE_IDS.has(preset) ? preset : undefined
    }

    /** Whether a preset id is a creation composition, and which base it overlays. */
    function creationOf(preset) {
      return typeof preset === 'string' ? BASE_FOR_CREATION[preset] : undefined
    }

    /** The "创造" switch above the composer card. */
    function CreationSwitch({ session, useSessions, toggle, t }) {
      const preset = useSessions((state) => {
        const value = state.byId[session.id]?.projectionValues?.agentPreset
        return typeof value === 'string' ? value : undefined
      })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const lastPreset = React.useRef(preset)
      const suppressContinuity = React.useRef(false)
      const blank = session.blank === true
      const base = baseOf(preset)
      const on = creationOf(preset) !== undefined

      // Choosing another base mode while creation is on keeps creation on: the
      // shipped chip just switched the preset, so re-apply the new composition.
      React.useEffect(() => {
        const previous = lastPreset.current
        lastPreset.current = preset
        if (suppressContinuity.current) {
          suppressContinuity.current = false
          return
        }
        if (creationOf(previous) === undefined) return
        if (creationOf(preset) !== undefined) return
        const nextBase = baseOf(preset)
        if (nextBase === undefined || !blank) return
        const target = CREATION_FOR_BASE[nextBase]
        if (target === undefined) return
        suppressContinuity.current = true
        setBusy(true)
        setError(null)
        Promise.resolve(toggle(session.id, target)).then((reason) => {
          setBusy(false)
          if (typeof reason === 'string' && reason.length > 0) {
            suppressContinuity.current = false
            setError(t('switchFailed', { reason }))
          }
        })
      }, [preset, blank, session.id, toggle, t])

      if (!blank || base === undefined) return null

      const onClick = async () => {
        if (busy) return
        const target = on ? base : CREATION_FOR_BASE[base]
        if (target === undefined) return
        setBusy(true)
        setError(null)
        suppressContinuity.current = true
        let reason
        try {
          reason = await toggle(session.id, target)
        } catch (failure) {
          reason = failure instanceof Error ? failure.message : String(failure)
        }
        setBusy(false)
        if (typeof reason === 'string' && reason.length > 0) {
          suppressContinuity.current = false
          setError(t('switchFailed', { reason }))
        }
      }

      return h('div', { className: 'dsh-creator-dock' },
        h('div', { className: 'dsh-creator-row' },
          error === null ? null : h('span', { className: 'dsh-creator-error', role: 'alert' }, error),
          h('button', {
            type: 'button',
            role: 'switch',
            className: 'dsh-creator-switch',
            'aria-checked': on,
            'aria-label': t('switch'),
            title: t('switchHint'),
            disabled: busy,
            onClick,
          },
            h('span', { className: 'dsh-creator-track', 'data-on': on ? 'true' : 'false' },
              h('span', { className: 'dsh-creator-thumb' })),
            h('span', { className: 'dsh-creator-text' }, t('switch')),
          )),
      )
    }

    const CSS = `
.dsh-creator-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));margin:0 auto}
.dsh-creator-row{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width,100%) - 4 * var(--dsh-composer-dock-inset,0px));margin:0 auto;display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:26px}
.dsh-creator-switch{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px 0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:22px;cursor:pointer;transition:color .15s ease,border-color .15s ease,background-color .15s ease}
.dsh-creator-switch:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-creator-switch:disabled{opacity:.5;cursor:default}
.dsh-creator-switch[aria-checked="true"]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.dsh-creator-track{box-sizing:border-box;position:relative;flex:none;width:26px;height:14px;border-radius:999px;background:var(--dsw-alias-state-idle-primary);transition:background-color .15s ease}
.dsh-creator-track[data-on="true"]{background:var(--dsw-alias-brand-primary)}
.dsh-creator-thumb{position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease}
.dsh-creator-track[data-on="true"] .dsh-creator-thumb{transform:translateX(12px)}
.dsh-creator-error{min-width:0;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
@media (prefers-reduced-motion:reduce){.dsh-creator-switch,.dsh-creator-track,.dsh-creator-thumb{transition:none}}
`

    const zh = {
      switch: '创造',
      switchHint: '在当前基础模式上叠加创造能力，需在会话开始前设置',
      switchFailed: '切换失败：{reason}',
    }
    const en = {
      switch: 'Creation',
      switchHint: 'Add the creation toolset on top of the selected base mode; set it before the session starts',
      switchFailed: 'Could not switch: {reason}',
    }

    const inject = ['slots', 'locale', 'remote.agentPresets']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'creator-overlay: dictionaries')
      ctx.effect(() => {
        if (typeof document === 'undefined') return
        const selector = 'style[data-plugin-css="dsh-creator-overlay"]'
        if (document.querySelector(selector) !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-creator-overlay'
        tag.dataset.pluginCss = 'dsh-creator-overlay'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'creator-overlay: styles')

      const toggle = async (sessionId, target) => {
        try {
          const result = await ctx.remote.agentPresets.select(sessionId, target)
          if (result?.ok === true) return undefined
          const error = result?.error
          const detail = error?.details
          return (detail !== null && typeof detail === 'object' && typeof detail.reason === 'string' ? detail.reason : undefined)
            ?? (typeof error?.message === 'string' ? error.message : 'unknown error')
        } catch (failure) {
          return failure instanceof Error ? failure.message : String(failure)
        }
      }

      ctx.slots.inject('conversation.input.dock', () => {
        try {
          return ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'creation-overlay',
            order: 30,
            locale: NS,
            inject: () => ({ toggle }),
          }, CreationSwitch)
        } catch (error) {
          console.error('[creator-overlay] dock registration failed', error)
          return () => {}
        }
      })
    }

    return { inject, apply }
  },
})
