/**
 * Browser half of `dsh-creator-overlay`.
 *
 * One switch in `conversation.hero.options` — the cluster the New Session row
 * keeps to the right of the mode chip. The switch is offered only while the
 * Session is still blank: the Host binds one preset composition before the
 * first turn and refuses to swap it afterwards. Flipping the switch selects the
 * composed creation preset on the blank Session; choosing another base mode
 * while it is on re-applies the creation composition for the new base.
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

    /**
     * Copy key of the mode name a composed preset must display. The composed
     * presets stay out of the preset roster, so the shipped surfaces that
     * resolve a mode name from it fall back to the raw id.
     */
    const BASE_NAME_KEY = {
      cordis: 'modeStandard',
      'ptc-creation': 'modePtc',
      'minimal-creation': 'modeMinimal',
    }

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
     * Base mode used by a blank Session whose preset projection has not loaded
     * yet. The Host roster marks the effective default; the switch falls back to
     * it so a fresh new-session screen still offers "创造".
     */
    let defaultBase = 'standard'
    const defaultListeners = new Set()
    const defaultSource = {
      getSnapshot: () => defaultBase,
      subscribe: (listener) => {
        defaultListeners.add(listener)
        return () => {
          defaultListeners.delete(listener)
        }
      },
    }
    async function loadDefaultBase(ctx) {
      try {
        const result = await ctx.remote.agentPresets.list()
        if (result === undefined || result.ok !== true) return
        const row = result.value?.presets?.find((preset) => preset.isDefault === true)
        if (row === undefined || !BASE_IDS.has(row.id) || row.id === defaultBase) return
        defaultBase = row.id
        for (const listener of defaultListeners) listener()
      } catch {
        // Keep the last known default; the switch hides when no base is known.
      }
    }

    /** The "创造" switch beside the mode chip on the New Session row. */
    function CreationSwitch({ sessionId, useSessions, toggle, t }) {
      const id = sessionId
      const projected = useSessions((state) => {
        const value = state.byId[id]?.projectionValues?.agentPreset
        return typeof value === 'string' ? value : undefined
      })
      const blank = useSessions((state) => state.byId[id]?.blank === true)
      const fallbackBase = React.useSyncExternalStore(defaultSource.subscribe, defaultSource.getSnapshot)
      const preset = projected
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const lastPreset = React.useRef(preset)
      const suppressContinuity = React.useRef(false)
      const base = preset === undefined ? fallbackBase : baseOf(preset)
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
        Promise.resolve(toggle(id, target)).then((refused) => {
          setBusy(false)
          if (refused === true) {
            suppressContinuity.current = false
            setError(t('switchFailed'))
          }
        })
      }, [preset, blank, id, toggle, t])

      if (id === undefined || !blank || base === undefined) return null

      const onClick = async () => {
        if (busy) return
        const target = on ? base : CREATION_FOR_BASE[base]
        if (target === undefined) return
        setBusy(true)
        setError(null)
        suppressContinuity.current = true
        let refused
        try {
          refused = await toggle(id, target)
        } catch (failure) {
          console.error('[creator-overlay] preset switch failed', failure)
          refused = true
        }
        setBusy(false)
        if (refused === true) {
          suppressContinuity.current = false
          setError(t('switchFailed'))
        }
      }

      return h('div', { className: 'dsh-creator-inline' },
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
        ))
    }

    const CSS = `
.dsh-creator-inline{display:flex;align-items:center;gap:8px;min-width:0;margin-left:6px}
[class*="_heroOptions"]:has(.dsh-creator-inline){margin-left:0}
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
      switchFailed: '切换失败，请重试',
      modeStandard: '标准模式',
      modePtc: 'PTC 模式',
      modeMinimal: '极简模式',
    }
    const en = {
      switch: 'Creation',
      switchHint: 'Add the creation toolset on top of the selected base mode; set it before the session starts',
      switchFailed: 'Could not switch. Try again.',
      modeStandard: 'Standard mode',
      modePtc: 'PTC mode',
      modeMinimal: 'Minimal mode',
    }

    const inject = ['slots', 'locale', 'remote', 'remote.agentPresets']

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

      /**
       * Keeps the mode name unchanged when creation is on. The New Session chip
       * and the header label both resolve their text through the preset roster,
       * which no longer lists the composed ids, so they print the raw id. The
       * roster is the only seam those surfaces read, and it also feeds the mode
       * menu, so the composed ids cannot simply stay in it: rewrite the two
       * rendered strings instead, and leave every other node alone.
       */
      ctx.effect(() => {
        if (typeof document === 'undefined' || document.body === null) return
        const t = ctx.locale.bind(NS)
        const scopes = '[data-slot="conversation.hero.agentPreset"],[data-slot="conversation.session.header.actions"]'
        const nameOf = (id) => {
          const key = BASE_NAME_KEY[id]
          return key === undefined ? undefined : t(key)
        }
        const inScope = (node) => {
          const parent = node.parentElement
          return parent !== null && parent.closest(scopes) !== null
        }
        const patched = new Map()
        const relabel = (node) => {
          const held = patched.get(node)
          if (held !== undefined) {
            if (!node.isConnected) {
              patched.delete(node)
              return
            }
            const name = nameOf(held)
            if (node.nodeValue !== name) node.nodeValue = name
            return
          }
          const text = node.nodeValue
          if (typeof text !== 'string' || text.length > 24) return
          const id = text.trim()
          const name = nameOf(id)
          if (name === undefined || !inScope(node)) return
          patched.set(node, id)
          node.nodeValue = name
        }
        const scan = (root) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) relabel(node)
        }
        scan(document.body)
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === 'characterData') {
              relabel(record.target)
              continue
            }
            for (const added of record.addedNodes) {
              if (added.nodeType === Node.TEXT_NODE) relabel(added)
            }
          }
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        const unsubscribe = ctx.locale.subscribe(() => {
          for (const node of [...patched.keys()]) relabel(node)
        })
        return () => {
          observer.disconnect()
          unsubscribe()
          patched.clear()
        }
      }, 'creator-overlay: mode names')

      /**
       * Applies `target` to the blank Session. Resolves to `undefined` when the
       * Host applied exactly that preset, and to `true` when it refused, so the
       * switch never claims a change the Session does not have.
       */
      const toggle = async (sessionId, target) => {
        try {
          const result = await ctx.remote.agentPresets.select(sessionId, target)
          if (result?.ok === true && result.value === target) return undefined
          console.error('[creator-overlay] preset switch refused', result)
          return true
        } catch (failure) {
          console.error('[creator-overlay] preset switch failed', failure)
          return true
        }
      }

      ctx.slots.inject('conversation.hero.options', () => {
        try {
          return ctx.slots.register({
            name: 'conversation.hero.options',
            id: 'creation-overlay',
            order: 0,
            locale: NS,
            inject: () => ({ toggle }),
          }, CreationSwitch)
        } catch (error) {
          console.error('[creator-overlay] switch registration failed', error)
          return () => {}
        }
      })

      loadDefaultBase(ctx)
      ctx.on('connection/reset', () => {
        loadDefaultBase(ctx)
      })
    }

    return { inject, apply }
  },
})
