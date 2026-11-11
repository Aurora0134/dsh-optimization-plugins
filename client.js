/**
 * Browser half of `dsh-creator-overlay`.
 *
 * One switch in `conversation.input.dock` (the full-width strip above the
 * composer card) plus a replacement for the session-header preset label.
 *
 * The switch is only offered while the Session is still blank: the Host binds
 * one preset composition before the first turn and refuses to swap it after
 * that. Flipping the switch selects the composed creation preset on the blank
 * Session; choosing another base mode while it is on re-applies the creation
 * composition for the new base.
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

    /**
     * Roster snapshot shared by every header label. The Host filters the
     * creation ids out of this list, so a composed session's name comes from
     * the static mapping below.
     */
    let rosterRows = []
    const rosterListeners = new Set()
    const rosterSource = {
      getSnapshot: () => rosterRows,
      subscribe: (listener) => {
        rosterListeners.add(listener)
        return () => {
          rosterListeners.delete(listener)
        }
      },
    }
    function publishRoster(rows) {
      rosterRows = rows
      for (const listener of rosterListeners) listener()
    }
    let rosterLoading
    function loadRoster(ctx) {
      if (rosterLoading !== undefined) return rosterLoading
      rosterLoading = (async () => {
        try {
          const result = await ctx.remote.agentPresets.list()
          if (result === undefined || result.ok !== true) return
          const presets = result.value?.presets
          if (!Array.isArray(presets)) return
          publishRoster(presets.map((row) => ({
            id: row.id,
            ...(row.name === undefined ? {} : { name: row.name }),
            ...(row.description === undefined ? {} : { description: row.description }),
          })))
        } catch {
          // A missing connection keeps the previous roster; the label falls back to ids.
        } finally {
          rosterLoading = undefined
        }
      })()
      return rosterLoading
    }

    /** The regular agent-preset glyph, copied from the Host primitive (14px). */
    function AgentPresetIcon({ className }) {
      return h('svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        fill: 'none',
        strokeWidth: 1.2,
        className,
        'aria-hidden': true,
      },
        h('path', {
          d: 'M6.51867 12.3282C7.29816 12.6011 8.16475 12.6514 9.02269 12.4216C9.57879 12.2726 10.0784 12.0185 10.5087 11.6888C10.7819 12.0555 11.1606 12.3304 11.5913 12.4805C10.9688 13.029 10.2149 13.4478 9.35911 13.6771C8.13946 14.0038 6.90632 13.8971 5.82126 13.4533C6.15821 13.1562 6.4021 12.7652 6.51867 12.3282ZM9.17629 2.89409C11.1101 3.34433 12.739 4.81872 13.2889 6.87043C13.4219 7.3665 13.4811 7.8649 13.4774 8.35466C13.0924 8.13213 12.6422 8.01837 12.1741 8.05276L12.1711 8.05257C12.1539 7.77199 12.109 7.48889 12.0334 7.20684C11.6363 5.72533 10.5048 4.6372 9.13549 4.22844C9.25559 3.87667 9.29214 3.49087 9.22309 3.09892C9.2108 3.02922 9.19451 2.96108 9.17629 2.89409ZM4.7311 3.89107L4.78302 4.11879C4.87648 4.4488 5.04146 4.74263 5.25579 4.98896C3.98078 6.01355 3.35848 7.72904 3.8089 9.41059C3.81828 9.44559 3.82866 9.48025 3.83885 9.51479C3.38217 9.61268 2.98548 9.84137 2.68107 10.1556C2.63414 10.022 2.5897 9.88632 2.55244 9.74726C1.93301 7.43489 2.86717 5.07173 4.71504 3.76697L4.7311 3.89107Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M7.99136 5.28105C8.87501 5.28105 9.59136 4.56471 9.59136 3.68105C9.59136 2.7974 8.87501 2.08105 7.99136 2.08105C7.1077 2.08105 6.39136 2.7974 6.39136 3.68105C6.39136 4.56471 7.1077 5.28105 7.99136 5.28105Z',
          stroke: 'currentColor',
        }),
        h('path', {
          d: 'M3.94009 12.9417C4.82374 12.9417 5.54009 12.2254 5.54009 11.3417C5.54009 10.458 4.82374 9.7417 3.94009 9.7417C3.05643 9.7417 2.34009 10.458 2.34009 11.3417C2.34009 12.2254 3.05643 12.9417 3.94009 12.9417Z',
          stroke: 'currentColor',
        }),
        h('path', {
          d: 'M12.0851 12.9417C12.9688 12.9417 13.6851 12.2254 13.6851 11.3417C13.6851 10.458 12.9688 9.7417 12.0851 9.7417C11.2015 9.7417 10.4851 10.458 10.4851 11.3417C10.4851 12.2254 11.2015 12.9417 12.0851 12.9417Z',
          stroke: 'currentColor',
        }),
      )
    }

    /** Display text for a session's preset, including the creation composition. */
    function presetText(preset, row, t) {
      const creationBase = creationOf(preset)
      if (creationBase !== undefined) {
        return t('creationLabel', { base: t(`${creationBase}Mode`) })
      }
      if (preset === 'standard') return t('standardMode')
      if (preset === 'ptc') return t('ptcMode')
      if (preset === 'minimal') return t('minimalMode')
      return row?.name ?? preset
    }

    /** The header label replacement: reads the live preset and the filtered roster. */
    function AgentModeLabel({ sessionId, useSessions, usePresetRoster, load, t }) {
      const preset = useSessions((state) => {
        const value = state.byId[sessionId]?.projectionValues?.agentPreset
        return typeof value === 'string' ? value : undefined
      })
      React.useEffect(() => {
        if (preset !== undefined) load()
      }, [preset, load])
      const roster = usePresetRoster()
      if (preset === undefined) return null
      const row = roster.find((entry) => entry.id === preset)
      const text = presetText(preset, row, t)
      return h('span', {
        className: 'dsh-creator-label',
        title: row?.description ?? text,
      }, h(AgentPresetIcon, { className: 'dsh-creator-labelIcon' }), text)
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
.dsh-creator-label{border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-fill-tsp-secondary);max-width:180px;height:22px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;align-items:center;gap:4px;padding:0 2px 0 0;font-size:12px;line-height:22px;display:inline-flex;overflow:hidden}
.dsh-creator-labelIcon{opacity:.7;flex:none}
@container (width<=540px){.dsh-creator-label{display:none}}
@media (prefers-reduced-motion:reduce){.dsh-creator-switch,.dsh-creator-track,.dsh-creator-thumb{transition:none}}
`

    const zh = {
      switch: '创造',
      switchHint: '在当前基础模式上叠加创造能力，需在会话开始前设置',
      standardMode: '标准模式',
      ptcMode: 'PTC 模式',
      minimalMode: '极简模式',
      creationLabel: '{base} + 创造',
      switchFailed: '切换失败：{reason}',
    }
    const en = {
      switch: 'Creation',
      switchHint: 'Add the creation toolset on top of the selected base mode; set it before the session starts',
      standardMode: 'Standard mode',
      ptcMode: 'PTC mode',
      minimalMode: 'Minimal mode',
      creationLabel: '{base} + Creation',
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

      loadRoster(ctx)
      ctx.on('connection/reset', () => {
        loadRoster(ctx)
      })

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'creation-overlay',
        order: 30,
        locale: NS,
        inject: () => ({ toggle }),
      }, CreationSwitch))

      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'agent-preset',
        order: -10,
        locale: NS,
        inject: () => ({
          hooks: { presetRoster: rosterSource },
          load: () => loadRoster(ctx),
        }),
      }, AgentModeLabel))
    }

    return { inject, apply }
  },
})
