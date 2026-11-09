/**
 * Host half of `dsh-team-slot-reclaim`: one Lead-scoped `delete_teammate` tool for the
 * experimental Agent Teams bundle.
 *
 * Agent Teams derives its roster from append-only Lead-log events and exposes no removal
 * operation, so every teammate ever created keeps consuming `maxMembers` — failed creations
 * included. This plugin removes one idle teammate from the live `agentTeam` projection,
 * releases the Agent behind it, returns its in-progress tasks to the board, and records the
 * removal so the freed slot survives a restart or a rebuilt projection.
 *
 * It registers nothing when the Agent Teams service is absent.
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const name = 'dsh-team-slot-reclaim'

/** The plugin registers a model-facing tool and needs the Agent registry to find Leads. */
export const inject = ['agents', 'tools']

/** Projection key owned by `@deepseek-ai/dsh-experimental-agent-team`. */
const TEAM_PROJECTION = 'agentTeam'

/** Removed teammates are remembered per Lead Session; the file is plugin-private state. */
const LEDGER_VERSION = 1
const LEDGER_FILE = 'removed.json'

/**
 * Resolve the Harness home directory that holds plugin state.
 * @returns {string}
 */
function dshHome() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), '.dsh')
}

/**
 * Render one tool result as compact JSON.
 * @param {unknown} value
 * @returns {{ type: 'text', text: string }[]}
 */
function jsonBlocks(value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Error text without the stack.
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Durable removal ledger: Lead Session id -> removed member id -> its reserved name.
 * `remember` persists before resolving, so a recorded removal survives a restart even when
 * the Session projection cache is rebuilt or lost.
 * @param {object} ctx Cordis context used only for logging.
 * @returns {{ entries: Map<string, Map<string, string>>, remember: (leadId: string, member: { id: string, name: string }) => Promise<void>, file: string }}
 */
function createLedger(ctx) {
  const file = path.join(dshHome(), 'team-slot-reclaim', LEDGER_FILE)
  const entries = new Map()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw?.version === LEDGER_VERSION && raw.teams !== null && typeof raw.teams === 'object') {
      for (const [leadId, rows] of Object.entries(raw.teams)) {
        if (!Array.isArray(rows)) continue
        const members = new Map()
        for (const row of rows) {
          if (typeof row?.id === 'string' && typeof row?.name === 'string') members.set(row.id, row.name)
        }
        if (members.size > 0) entries.set(leadId, members)
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') ctx.logger?.warn?.(`team-slot-reclaim: removal ledger "${file}" is unreadable: ${messageOf(error)}`)
  }
  const serialize = () => {
    const teams = {}
    for (const [leadId, members] of entries) teams[leadId] = [...members].map(([id, name]) => ({ id, name }))
    return `${JSON.stringify({ version: LEDGER_VERSION, teams }, null, 2)}\n`
  }
  const remember = async (leadId, member) => {
    const members = entries.get(leadId) ?? new Map()
    if (members.get(member.id) === member.name) return
    const previous = members.get(member.id)
    members.set(member.id, member.name)
    entries.set(leadId, members)
    try {
      await mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, serialize(), 'utf8')
      await rename(temporary, file)
    } catch (error) {
      if (previous === undefined) members.delete(member.id)
      else members.set(member.id, previous)
      if (members.size === 0) entries.delete(leadId)
      throw error
    }
  }
  return { entries, remember, file }
}

/**
 * Filter one Lead's recorded removals out of its live roster. Safe to call at any time: the
 * removal list only ever grows, and a roster that already lacks those members is untouched.
 * @param {object} ctx Context carrying `sessionProjections`.
 * @param {Map<string, Map<string, string>>} entries Removal ledger.
 * @param {object} agent Exact live Team Lead.
 * @returns {boolean} Whether the roster changed.
 */
function reapplyRemovals(ctx, entries, agent) {
  const removed = entries.get(agent.id)
  if (removed === undefined || removed.size === 0) return false
  let state
  try {
    state = ctx.sessionProjections.stateOf(agent.session, TEAM_PROJECTION)
  } catch {
    return false
  }
  if (state === undefined || state.failure !== undefined) return false
  const kept = state.members.filter((member) => !removed.has(member.id))
  if (kept.length === state.members.length) return false
  state.members = kept
  return true
}

/**
 * Reject a teammate name that a deleted teammate still reserves. The official roster check
 * cannot enforce this after removal, and reusing the name would make a later projection
 * rebuild fail permanently, so the reservation is enforced here.
 * @param {object} ctx Injected context with `agentTeams`.
 * @param {Map<string, Map<string, string>>} entries Removal ledger.
 * @returns {() => void} Restores the original service method.
 */
function guardSpawnNames(ctx, entries) {
  const service = ctx.agentTeams
  const original = service.spawnTeammate
  if (typeof original !== 'function') return () => {}
  const wrapped = function spawnTeammate(caller, request) {
    const name = request?.name
    if (typeof name === 'string') {
      let leadId
      try {
        leadId = service.tryMembership(caller)?.root?.id
      } catch {
        leadId = undefined
      }
      const reserved = leadId === undefined ? undefined : entries.get(leadId)
      if (reserved !== undefined && [...reserved.values()].includes(name)) {
        return Promise.reject(new Error(`teammate name "${name}" belonged to a deleted teammate and stays reserved; choose another name`))
      }
    }
    return original.call(this, caller, request)
  }
  service.spawnTeammate = wrapped
  return () => {
    if (service.spawnTeammate === wrapped) delete service.spawnTeammate
  }
}

/**
 * Read the live Team projection of one Lead Session.
 * @param {object} ctx Context carrying `sessionProjections`.
 * @param {object} root Exact live Team Lead.
 * @returns {object} Mutable projection state (never a copy).
 */
function teamState(ctx, root) {
  const state = ctx.sessionProjections.stateOf(root.session, TEAM_PROJECTION)
  if (state === undefined) throw new Error('the Agent Teams projection is not active in this session')
  if (state.failure !== undefined) throw new Error(`the Agent Teams state is broken: ${String(state.failure)}`)
  return state
}

/**
 * Durably checkpoint every projection unit of the Lead Session, so the edited roster is what
 * a later restore reads.
 * @param {object} ctx Context carrying `sessions` and optionally `sessionProjectionCache`.
 * @param {object} root Exact live Team Lead.
 * @returns {Promise<void>}
 */
async function checkpointTeamState(ctx, root) {
  const cache = ctx.get('sessionProjectionCache')
  if (cache !== undefined && typeof cache.write === 'function') {
    await cache.write(root.session)
    return
  }
  await ctx.sessions.flush(root.session)
}

/**
 * Return the in-progress tasks owned by one teammate to the board, unowned and pending.
 * Runs before any destructive step so a failed hand-back aborts the whole deletion.
 * @param {object} ctx Injected context with `agentTeams`.
 * @param {object} caller Exact live Lead Agent.
 * @param {string} target Teammate name.
 * @returns {Promise<string[]>} Released task ids.
 */
async function releaseOwnedTasks(ctx, caller, target) {
  const owned = ctx.agentTeams.listTasks(caller).filter((task) => task.status === 'in_progress' && task.ownerName === target)
  const released = []
  for (const task of owned) {
    try {
      await ctx.agentTeams.updateTask(caller, { taskId: task.id, expectedRevision: task.revision, action: 'reassign' })
    } catch (error) {
      throw new Error(`teammate "${target}" owns in-progress task "${task.id}", and returning it to the board failed: ${messageOf(error)}`)
    }
    released.push(task.id)
  }
  return released
}

/**
 * Remove one idle teammate: return its tasks, release its Agent, record the removal, and
 * drop it from the live roster.
 * @param {object} ctx Injected context with the Agent Teams services.
 * @param {{ entries: Map<string, Map<string, string>>, remember: Function }} ledger Removal ledger.
 * @param {object} caller Exact live calling Agent.
 * @param {string} rawTarget Teammate name from the model.
 * @returns {Promise<{ deleted: true, target: string, releasedTasks?: string[] }>}
 */
async function deleteTeammate(ctx, ledger, caller, rawTarget) {
  const target = typeof rawTarget === 'string' ? rawTarget.trim() : ''
  if (target.length === 0) throw new Error('target must be the name of a teammate from list_agents')
  if (target === 'lead') throw new Error('the Team Lead cannot be deleted')
  const membership = ctx.agentTeams.membership(caller)
  if (membership.role !== 'lead') throw new Error('only the Team Lead can delete teammates')
  const root = membership.root
  // Heal a roster rebuilt from the log before deciding anything about it.
  reapplyRemovals(ctx, ledger.entries, root)
  const member = ctx.agentTeams.listMembers(caller).find((row) => row.role === 'teammate' && row.name === target)
  if (member === undefined) throw new Error(`no teammate named "${target}" in this team; list_agents shows the current roster`)
  if (member.status === 'running') {
    throw new Error(`teammate "${target}" is running; interrupt it with interrupt_agent and delete it once its turn has ended`)
  }
  if (member.status === 'provisioning') {
    throw new Error(`teammate "${target}" is still being created; delete it after creation settles`)
  }
  if (ctx.agents.get(member.id)?.status === 'running') {
    throw new Error(`teammate "${target}" started a turn; interrupt it before deleting`)
  }
  if (!teamState(ctx, root).members.some((record) => record.id === member.id)) {
    throw new Error(`teammate "${target}" is no longer part of this team`)
  }
  const releasedTasks = await releaseOwnedTasks(ctx, caller, target)
  // Release the live Agent of a loaded member; a stored-only member has no Activation to drain.
  await ctx.subagents.drainChildren(root, [member.id])
  try {
    await ledger.remember(root.id, { id: member.id, name: member.name })
  } catch (error) {
    throw new Error(`teammate "${target}" was released but its removal could not be recorded, so it stays in the roster: ${messageOf(error)}`)
  }
  // Re-read: releasing tasks or the Agent may have replaced the projection state.
  const current = teamState(ctx, root)
  current.members = current.members.filter((record) => record.id !== member.id)
  try {
    await checkpointTeamState(ctx, root)
  } catch (error) {
    // The removal is recorded, so a rebuilt roster drops the member again; report the partial.
    ctx.logger?.warn?.(`team-slot-reclaim: roster checkpoint after deleting "${member.name}" failed: ${messageOf(error)}`)
  }
  return releasedTasks.length === 0
    ? { deleted: true, target: member.name }
    : { deleted: true, target: member.name, releasedTasks }
}

/**
 * Build the model-facing definition of `delete_teammate`.
 * @param {object} ctx Injected context with the Agent Teams services.
 * @param {{ entries: Map<string, Map<string, string>>, remember: Function }} ledger Removal ledger.
 * @returns {object} Tool definition for `tools.register`.
 */
function defineDeleteTool(ctx, ledger) {
  return {
    name: 'delete_teammate',
    description:
      'Delete one teammate from this team and free its member slot. Only the Team Lead may call this, ' +
      'and only for a teammate that is not running and not being created. In-progress tasks it owns ' +
      'return to the board unowned. The teammate cannot be listed, messaged, or resumed afterwards; ' +
      'its session history is kept and its name stays reserved.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          description: 'Teammate name from list_agents or spawn_teammate. The Lead cannot be deleted.',
        },
      },
      required: ['target'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', const: true },
          target: { type: 'string' },
          releasedTasks: { type: 'array', items: { type: 'string' } },
        },
        required: ['deleted', 'target'],
      },
      render: (_args, value) => jsonBlocks(value),
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: typeof args?.target === 'string' && args.target.length > 0
        ? `Delete teammate: ${args.target}`
        : 'Delete teammate',
    }),
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined) throw new Error('delete_teammate needs a calling Agent')
      return await deleteTeammate(ctx, ledger, agent, args?.target)
    },
  }
}

/**
 * Register the tool on every live and future Lead scope, enforce the name reservation, and
 * unwind everything on disposal.
 * @param {object} ctx Injected context with the Agent Teams services.
 * @returns {void}
 */
function install(ctx) {
  const ledger = createLedger(ctx)
  const restoreSpawnGuard = guardSpawnNames(ctx, ledger.entries)
  /** @type {Map<object, () => void>} */
  const installed = new Map()
  const maybeInstall = (agent) => {
    if (installed.has(agent)) return
    let membership
    try {
      membership = ctx.agentTeams.tryMembership(agent)
    } catch {
      return
    }
    if (membership?.role !== 'lead') return
    reapplyRemovals(ctx, ledger.entries, agent)
    try {
      installed.set(agent, agent.ctx.tools.register(defineDeleteTool(ctx, ledger)))
    } catch (error) {
      ctx.logger?.warn?.(`team-slot-reclaim: could not install delete_teammate for agent "${agent.id}": ${messageOf(error)}`)
    }
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => maybeInstall(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  // A rebuilt projection (plugin reload, restore without a checkpoint row) resurrects removed
  // members; re-filter as soon as a changed roster reaches the client feed.
  ctx.sessionProjections.onChanged((session, key, value) => {
    if (key !== TEAM_PROJECTION) return
    const removed = ledger.entries.get(session.id)
    if (removed === undefined || removed.size === 0) return
    if (!Array.isArray(value?.members) || !value.members.some((member) => removed.has(member.id))) return
    const agent = ctx.agents.get(session.id)
    if (agent !== undefined) reapplyRemovals(ctx, ledger.entries, agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
    restoreSpawnGuard()
  }, 'team-slot-reclaim.scopedTool')
}

/**
 * Register the Host half. Inert unless the Agent Teams domain is mounted.
 * @param {object} ctx Cordis context of this plugin.
 */
export function apply(ctx) {
  ctx.inject(['agentTeams', 'subagents', 'sessionProjections', 'sessions'], (scoped) => {
    install(scoped)
  })
}
