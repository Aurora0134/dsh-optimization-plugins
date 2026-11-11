/**
 * Host half of `dsh-creator-overlay`.
 *
 * The Web preset model is one flat plugin list per preset: a session selects a
 * single preset id before its first turn and keeps that composition for its
 * whole life. There is no inheritance and no per-session overlay, so the
 * "creation mode on top of a base mode" switch is realized as three composed
 * presets:
 *
 *   standard  -> `cordis`            (the shipped creation preset, reused as-is)
 *   ptc       -> `ptc-creation`      (copied ptc list + the creation increment)
 *   minimal   -> `minimal-creation`  (copied minimal list + the creation increment)
 *
 * The composed ids are hidden from the agent-preset roster by wrapping the
 * registry's `remoteExportList`; `cordis` is hidden too, so the Web surface no
 * longer offers Creator as a mode and its native creator entry points disappear.
 * The client half puts the "创造模式" switch beside the mode chip and selects the
 * composed id on the blank session.
 *
 * The copied ptc/minimal lists live in ./host/presets.js and must be re-synced
 * when the shipped presets change.
 *
 * @module dsh-creator-overlay
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { minimalPlugins, ptcPlugins } from './host/presets.js'

/** Loader row id and plugin name. */
export const name = 'dsh-creator-overlay'

/** Composing needs the preset registry; the plugin is inert without one. */
export const inject = ['agentPresets']

/** Preset ids this plugin owns. */
const PTC_CREATION = 'ptc-creation'
const MINIMAL_CREATION = 'minimal-creation'
const CORDIS = 'cordis'

/** Ids hidden from the client roster: the creation composites plus the shipped creator preset. */
const HIDDEN_IDS = new Set([CORDIS, PTC_CREATION, MINIMAL_CREATION])

/** Error text without the stack. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the packaged Harness root that holds `node_modules/@deepseek-ai`. */
function packagedDshRoot() {
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    return path.join(process.resourcesPath, 'app.asar', 'dsh')
  }
  return undefined
}

/** The directory holding the creation skills shipped with `@deepseek-ai/dsh-agent-preset`. */
function creationSkillsDir(dshRoot) {
  if (dshRoot === undefined) return undefined
  const dir = path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-agent-preset', 'skills')
  return existsSync(dir) ? dir : undefined
}

/**
 * Resolve the `!!js` disabled conditions copied from the shipped presets into
 * plain booleans. The original expressions only cover the current platform and
 * the presence of a profile; unknown expressions stay enabled so a composition
 * never silently loses a row.
 * @param {string} expression
 * @param {boolean} hasProfile
 * @returns {boolean}
 */
function evaluateDisabled(expression, hasProfile) {
  if (expression.includes("process.platform === 'win32'")) return process.platform === 'win32'
  if (expression.includes("process.platform !== 'win32'")) return process.platform !== 'win32'
  if (expression.includes("!ctx.get('profileContext')")) return !hasProfile
  return false
}

/**
 * Deep-copy a copied preset list, resolving `{ __js }` markers.
 * @param {unknown} value
 * @param {boolean} hasProfile
 * @returns {unknown}
 */
function materialize(value, hasProfile) {
  if (Array.isArray(value)) return value.map((entry) => materialize(entry, hasProfile))
  if (value !== null && typeof value === 'object') {
    if (typeof value.__js === 'string') return evaluateDisabled(value.__js, hasProfile)
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = materialize(entry, hasProfile)
    return out
  }
  return value
}

/** Find a top-level row by id. */
function rowById(rows, id) {
  return rows.find((row) => row?.id === id)
}

/**
 * Append the creation increment to a copied base list.
 * @param {object[]} rows
 * @param {string | undefined} skillsDir
 * @param {{ withSkillSystem: boolean, withMarket: boolean, hasProfile: boolean }} options
 * @returns {object[]}
 */
function withCreationIncrement(rows, skillsDir, options) {
  const next = [...rows]

  const skillRow = rowById(next, 'skill-filesystem')
  if (skillRow !== undefined && skillsDir !== undefined) {
    skillRow.config = { ...(skillRow.config ?? {}), customSkillDirs: [skillsDir] }
  } else if (skillRow === undefined && skillsDir !== undefined) {
    next.push({ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: { customSkillDirs: [skillsDir] } })
  }
  if (options.withSkillSystem && rowById(next, 'tool-skill') === undefined) {
    next.push({ id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' })
  }

  next.push({ id: 'tool-cordis', name: '@deepseek-ai/dsh-tool-cordis' })

  const manager = rowById(next, 'tool-plugin-manager')
  if (manager === undefined) {
    next.push({ id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: !options.hasProfile })
  } else {
    manager.disabled = !options.hasProfile
  }

  if (options.withMarket) {
    const market = rowById(next, 'tool-plugin-market')
    if (market === undefined) {
      next.push({ id: 'tool-plugin-market', name: '@deepseek-ai/dsh-plugin-market/tools', disabled: !options.hasProfile })
    } else {
      market.disabled = !options.hasProfile
    }
  }

  return next
}

/**
 * Find a property descriptor by walking the prototype chain.
 * @param {object} service
 * @param {string} property
 * @returns {{ owner: object, descriptor: PropertyDescriptor } | undefined}
 */
function findDescriptor(service, property) {
  let owner = Object.getPrototypeOf(service)
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, property)
    if (descriptor !== undefined) return { owner, descriptor }
    owner = Object.getPrototypeOf(owner)
  }
  return undefined
}

/**
 * Keep a service method patched on its declaring prototype for the plugin
 * lifetime and restore it on unload. Patching the prototype (rather than the
 * instance) keeps the override alive when the service instance is recreated.
 * The gateway resolves remote methods through `Reflect.get` on the instance, so
 * the prototype method is what it calls.
 * @param {object} ctx
 * @param {object} service
 * @param {string} method
 * @param {(original: Function) => Function} wrap
 */
function patchServiceMethod(ctx, service, method, wrap) {
  const found = findDescriptor(service, method)
  if (found === undefined || typeof found.descriptor.value !== 'function') {
    ctx.logger?.warn?.(`creator-overlay: service method "${method}" is unavailable; the creation presets stay visible`)
    return false
  }
  const patched = wrap(found.descriptor.value)
  try {
    Object.defineProperty(found.owner, method, { ...found.descriptor, value: patched })
  } catch (error) {
    ctx.logger?.warn?.(`creator-overlay: cannot patch "${method}": ${messageOf(error)}`)
    return false
  }
  ctx.effect(() => () => {
    try {
      Object.defineProperty(found.owner, method, found.descriptor)
    } catch (error) {
      ctx.logger?.warn?.(`creator-overlay: cannot restore "${method}": ${messageOf(error)}`)
    }
  })
  return true
}

/**
 * Keep the effective new-task default off the hidden ids. A profile that still
 * saves Creator as its default would otherwise start every new session in
 * creation mode now that Creator is no longer a selectable mode.
 * @param {object} ctx
 * @param {object} service
 * @returns {boolean} whether the effective default is now guarded
 */
function patchDefaultId(ctx, service) {
  const found = findDescriptor(service, 'defaultId')
  if (typeof found?.descriptor.get !== 'function') {
    ctx.logger?.warn?.('creator-overlay: default preset getter is unavailable; a saved hidden default stays effective')
    return false
  }
  const getter = found.descriptor.get
  try {
    Object.defineProperty(found.owner, 'defaultId', {
      ...found.descriptor,
      get() {
        const id = getter.call(this)
        return typeof id === 'string' && HIDDEN_IDS.has(id) ? 'standard' : id
      },
    })
  } catch (error) {
    ctx.logger?.warn?.(`creator-overlay: cannot guard the default preset: ${messageOf(error)}`)
    return false
  }
  ctx.effect(() => () => {
    try {
      Object.defineProperty(found.owner, 'defaultId', found.descriptor)
    } catch {
      // The plugin is unloading; a failed restore leaves the guard in place.
    }
  })
  return true
}

/**
 * Register the Host half.
 * @param {object} ctx Cordis context of this plugin
 */
export async function apply(ctx) {
  const hasProfile = ctx.get('profileContext') !== undefined
  const dshRoot = packagedDshRoot()
  const skillsDir = creationSkillsDir(dshRoot)
  if (dshRoot === undefined) {
    ctx.logger?.warn?.('creator-overlay: packaged Harness root not found; child rows resolve against the profile base')
  }
  if (skillsDir === undefined) {
    ctx.logger?.warn?.('creator-overlay: creation skill directory not found; the creation presets will lack the shipped skills')
  }

  // Child rows resolve from the declaring context's base URL. Point that base
  // at the packaged Harness packages so the copied rows keep resolving the
  // shipped plugin names exactly like the built-in presets do.
  const baseDir = dshRoot === undefined ? undefined : path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-web-app')
  const baseUrl = baseDir !== undefined && existsSync(baseDir) ? pathToFileURL(`${baseDir}${path.sep}`).href : undefined
  const scope = baseUrl === undefined ? ctx : ctx.extend({ baseUrl })
  const presets = scope.agentPresets

  const ptcRows = withCreationIncrement(materialize(ptcPlugins, hasProfile), skillsDir, {
    withSkillSystem: false,
    withMarket: true,
    hasProfile,
  })
  const minimalRows = withCreationIncrement(materialize(minimalPlugins, hasProfile), skillsDir, {
    withSkillSystem: true,
    withMarket: true,
    hasProfile,
  })

  const definitions = [
    { id: PTC_CREATION, name: 'PTC 模式 + 创造', description: 'PTC mode with the creation toolset.', order: 30, plugins: ptcRows },
    { id: MINIMAL_CREATION, name: '极简模式 + 创造', description: 'Minimal mode with the creation toolset.', order: 40, plugins: minimalRows },
  ]

  const disposers = []
  for (const definition of definitions) {
    try {
      const dispose = await presets.register(definition)
      disposers.push(dispose)
      const resolved = await presets.resolve(definition.id)
      if (resolved?.broken !== undefined) {
        ctx.logger?.warn?.(`creator-overlay: preset "${definition.id}" is broken: ${resolved.broken}`)
      } else {
        ctx.logger?.info?.(`creator-overlay: registered preset "${definition.id}"`)
      }
    } catch (error) {
      ctx.logger?.error?.(`creator-overlay: cannot register preset "${definition.id}": ${messageOf(error)}`)
    }
  }
  ctx.effect(() => async () => {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch (error) {
        ctx.logger?.warn?.(`creator-overlay: preset disposal failed: ${messageOf(error)}`)
      }
    }
  }, 'creator-overlay: composed presets')

  // Hide the creation compositions (and the shipped Creator preset) from the
  // client roster. The registry still resolves them for session binding.
  patchServiceMethod(ctx, ctx.agentPresets, 'remoteExportList', (original) => async function patchedRoster(...args) {
    const roster = await original.apply(this, args)
    if (roster === null || typeof roster !== 'object' || !Array.isArray(roster.presets)) return roster
    return { ...roster, presets: roster.presets.filter((row) => !HIDDEN_IDS.has(row?.id)) }
  })

  // A profile that still saves Creator as its new-task default must not start
  // every session in creation mode now that Creator is no longer selectable.
  patchDefaultId(ctx, ctx.agentPresets)
}
