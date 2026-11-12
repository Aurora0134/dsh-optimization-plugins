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
     * Copy key of each base mode name. A composed preset is labelled from its
     * base: the composed ids stay out of the preset roster, so the shipped
     * surfaces that resolve a mode name from it would print the raw id.
     */
    const BASE_NAME_KEY = {
      standard: 'modeStandard',
      ptc: 'modePtc',
      minimal: 'modeMinimal',
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

    /** Whether a rendered string is a raw preset id the mode label must rewrite. */
    function isModeId(text) {
      return creationOf(text) !== undefined || BASE_NAME_KEY[text] !== undefined
    }

    /**
     * Whether the switch is on, including the round trip in which the Session
     * still carries the base preset. The mode label reads it so the label does
     * not lose the creation layer for that round trip.
     */
    let creationOn = false
    const creationListeners = new Set()
    function setCreationOn(next) {
      if (creationOn === next) return
      creationOn = next
      for (const listener of creationListeners) listener()
    }

    /**
     * Base mode used by a blank Session whose preset projection has not loaded
     * yet. The Host roster marks the effective default; the switch falls back to
     * it so a fresh new-session screen still offers "创造模式".
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

    /** The "创造模式" switch beside the mode chip on the New Session row. */
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
      const seenPreset = React.useRef(preset)
      const bridging = React.useRef(false)
      const inflight = React.useRef(undefined)
      const suppressContinuity = React.useRef(false)
      const base = preset === undefined ? fallbackBase : baseOf(preset)
      const creation = creationOf(preset) !== undefined
      /**
       * A base picked while creation is on is only the first half of the
       * switch: the Session turns into that base's creation composition one
       * round trip later. Keep reporting creation as on across that gap, or the
       * switch slides off and back on for every base change.
       */
      const seen = seenPreset.current
      seenPreset.current = preset
      if (creation) bridging.current = false
      else if (
        bridging.current === false
        && creationOf(seen) !== undefined
        && suppressContinuity.current === false
        && blank
        && base !== undefined
      ) bridging.current = true
      const on = creation || bridging.current

      // The mode label shows the creation layer, so it has to know the switch is
      // on before the Session carries the composition — not a paint later.
      const useBeforePaint = React.useLayoutEffect ?? React.useEffect
      useBeforePaint(() => {
        setCreationOn(on)
      }, [on])

      // Choosing another base mode while creation is on keeps creation on: the
      // shipped chip just switched the preset, so re-apply the new composition.
      React.useEffect(() => {
        const previous = lastPreset.current
        lastPreset.current = preset
        if (suppressContinuity.current) {
          suppressContinuity.current = false
          return
        }
        if (creationOf(preset) !== undefined) {
          bridging.current = false
          inflight.current = undefined
          return
        }
        if (creationOf(previous) === undefined && bridging.current !== true) return
        const nextBase = baseOf(preset)
        if (nextBase === undefined || !blank) return
        const target = CREATION_FOR_BASE[nextBase]
        if (target === undefined || inflight.current === target) return
        inflight.current = target
        suppressContinuity.current = true
        bridging.current = true
        setError(null)
        Promise.resolve(toggle(id, target)).then((refused) => {
          if (inflight.current === target) inflight.current = undefined
          if (refused === true) {
            suppressContinuity.current = false
            bridging.current = false
            setError(t('switchFailed'))
          }
        })
      }, [preset, blank, id, toggle, t])

      if (id === undefined || !blank || base === undefined) return null

      const onClick = async () => {
        if (busy || bridging.current) return
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
      switch: '创造模式',
      switchHint: '编写插件为 DSH 添加工具或界面，也可以创建自定义模式。需在新会话开始前设置。',
      switchFailed: '切换失败，请重试',
      modeStandard: '标准模式',
      modePtc: 'PTC 模式',
      modeMinimal: '极简模式',
      creationSuffix: '创造',
    }
    const en = {
      switch: 'Creator mode',
      switchHint: 'Write plugins that add tools or UI to DSH, or create a custom mode. Set it before the session starts.',
      switchFailed: 'Could not switch. Try again.',
      modeStandard: 'Standard mode',
      modePtc: 'PTC mode',
      modeMinimal: 'Minimal mode',
      creationSuffix: 'Creator',
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
       * Labels the rendered mode name. A Session with creation on carries a
       * composed preset, which the roster no longer lists, so the header label
       * would print the raw id, and the New Session chip would print the id of
       * the base it re-applies next. The roster is the only seam those surfaces
       * read and it also feeds the mode menu, so the composed ids cannot simply
       * stay in it: rewrite the rendered strings instead, and leave every other
       * node alone.
       */
      ctx.effect(() => {
        if (typeof document === 'undefined' || document.body === null) return
        const t = ctx.locale.bind(NS)
        /**
         * Surfaces that render the mode name: the header label names the preset
         * the Session runs on, and the New Session chip — with its own label and
         * the titled label span — names the base mode the choice is made in. The
         * class suffixes keep the rewrite alive if a slot attribute changes name.
         */
        const headerScope = '[data-slot="conversation.session.header.actions"],[class*="_label"][title]'
        const scopes = [
          '[data-slot="conversation.hero.agentPreset"]',
          '[class*="_seatLabel"]',
          headerScope,
        ].join(',')
        const inScope = (node) => {
          const parent = node.parentElement
          return parent !== null && parent.closest(scopes) !== null
        }
        /** Whether a label describes the running Session rather than the next one. */
        const namesSession = (node) => {
          const parent = node.parentElement
          return parent !== null && parent.closest(headerScope) !== null
        }
        /**
         * Mode a rendered string belongs to, and whether creation is on in it.
         * The roster may already have resolved a base name before the composed
         * preset arrives, so a resolved name counts as its base id.
         */
        const resolve = (text) => {
          const composite = creationOf(text)
          if (composite !== undefined) return { base: composite, layer: true }
          if (BASE_NAME_KEY[text] !== undefined) return { base: text, layer: creationOn }
          const named = Object.keys(BASE_NAME_KEY).find((mode) => t(BASE_NAME_KEY[mode]) === text)
          return named === undefined ? undefined : { base: named, layer: creationOn }
        }
        /**
         * Text a mode label shows. The chip offers a base mode, so creation stays
         * a switch beside it; the header reports what the Session carries, which
         * includes the creation layer.
         */
        const labelOf = (text, session) => {
          const mode = resolve(text)
          if (mode === undefined) return undefined
          const name = t(BASE_NAME_KEY[mode.base])
          return mode.layer && session ? `${name}--${t('creationSuffix')}` : name
        }
        const patched = new Map()
        /**
         * Rewrite a rendered mode id. The record keeps the text a node was
         * renamed from; a node whose text changed to something else belongs to a
         * new render, so the record is dropped and the new text judged afresh —
         * otherwise the first name would stick for the session's whole life.
         */
        const relabel = (node, refresh = false) => {
          const session = namesSession(node)
          const held = patched.get(node)
          if (held !== undefined) {
            if (!node.isConnected) {
              patched.delete(node)
              return
            }
            const next = labelOf(held.source, session)
            if (next === undefined) {
              patched.delete(node)
              return
            }
            if (refresh) {
              held.name = next
              node.nodeValue = next
              return
            }
            if (node.nodeValue === held.name) return
            if (node.nodeValue === held.source) {
              held.name = next
              node.nodeValue = next
              return
            }
            patched.delete(node)
          }
          const source = node.nodeValue
          if (typeof source !== 'string') return
          const text = source.trim()
          if (text.length === 0 || text.length > 32) return
          const name = labelOf(text, session)
          if (name === undefined || name === text) return
          if (!inScope(node)) return
          patched.set(node, { source: text, name })
          node.nodeValue = name
        }
        const scan = (root) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) relabel(node)
        }
        scan(document.body)
        /**
         * A label arrives as one committed subtree: the text node is created
         * while the span is still detached, so inserting the span yields a
         * childList record whose added node is the span itself, never the text
         * inside it. Text nodes therefore cannot be the only thing observed.
         */
        const holdsLabel = (element) => element.matches(scopes) || element.querySelector(scopes) !== null
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === 'characterData') {
              relabel(record.target)
              continue
            }
            for (const added of record.addedNodes) {
              if (added.nodeType === Node.TEXT_NODE) relabel(added)
              else if (added.nodeType === Node.ELEMENT_NODE && holdsLabel(added)) scan(added)
            }
          }
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        const refreshAll = () => {
          for (const node of [...patched.keys()]) relabel(node, true)
        }
        const unsubscribe = ctx.locale.subscribe(refreshAll)
        creationListeners.add(refreshAll)
        /**
         * The selectors are the only link to the shipped labels, so a renamed
         * slot or class turns the rewrite off without raising anything and the
         * label falls back to the raw id. Watch for that for the whole session,
         * not just at startup: a session usually opens long after the plugin
         * applies. Each distinct leftover is reported once.
         */
        const reported = new Set()
        const diagnose = window.setInterval(() => {
          for (const element of document.querySelectorAll('[class*="_seatLabel"],[class*="_label"][title]')) {
            const text = String(element.textContent ?? '').trim()
            if (!isModeId(text)) continue
            const slot = element.closest('[data-slot]')?.getAttribute('data-slot') ?? null
            const signature = `${slot}|${text}`
            if (reported.has(signature)) continue
            reported.add(signature)
            console.warn('[creator-overlay] mode name left as an id', { slot, text })
          }
        }, 5000)
        return () => {
          observer.disconnect()
          unsubscribe()
          creationListeners.delete(refreshAll)
          window.clearInterval(diagnose)
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
