/**
 * The Host service `sessionRollback`: the operations the browser half uses.
 *
 * `state` answers whether a session can be rolled back right now and which user
 * messages the current surface holds; `prepare` resolves the clicked message and
 * the fork cut that removes its turn; `restore` brings back the files those
 * turns changed and clears the input the child inherited, after the browser half
 * created the child Session; `release` drops a preparation whose fork never
 * happened. The browser reaches all four through the same-origin HTTP routes
 * `host/api.js` registers; this module owns only the behaviour and the service
 * identity.
 *
 * The instance also carries Typert Remote markers, which cost nothing and keep
 * any consumer of the Remote protocol able to read the same operations. This
 * package ships no generated `./typert` artifact, so it declares the same class
 * metadata that the protocol decorators write: a versioned descriptor on the
 * class prototype, and the `typertRemote` binding a Cordis Service constructor
 * publishes. Both methods therefore use only plain identifier parameters.
 *
 * @module dsh-session-rollback/host/service
 */

import { availability, listUserMessages, prepareRollback, restoreRollback } from './rollback.js'

/**
 * Prototype property the Typert protocol stores Remote markers under. The name is
 * a stable string rather than a symbol so another installed copy of the protocol
 * package reads the same record; this source-mode marker is exactly what
 * `@Remote()` appends, minus compiler-generated reflection.
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Cordis service key and wire namespace of this service. */
export const SERVICE_KEY = 'sessionRollback'

/**
 * Attach source-mode Remote markers to a service prototype.
 * @param {object} prototype the service class prototype
 * @param {string[]} methods public instance method names, in declaration order
 */
function markRemoteMethods(prototype, methods) {
  const existing = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)
  const descriptors = Array.isArray(existing?.value?.methods) ? [...existing.value.methods] : []
  for (const method of methods) {
    if (descriptors.some((marker) => marker.method === method)) continue
    descriptors.push(Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))
  }
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze(descriptors) }),
  })
}

/**
 * Prepare one user-message row for the wire: a preview instead of the whole text,
 * so `state` stays small for long conversations.
 * @param {object} row one entry of `listUserMessages`
 */
function summarize(row) {
  return {
    seq: row.seq,
    index: row.index,
    ordinal: row.ordinal,
    turn: row.turn ?? null,
    preview: row.preview,
    nonTextParts: row.nonTextParts,
  }
}

/**
 * Resolve the session a Remote call names.
 *
 * The Gateway may hand the raw wire value or, when a lookup provider claims the
 * `sessionId` parameter name, the live Session it resolved; accepting both keeps
 * this service independent of that registry.
 * @param {object} ctx Cordis context carrying `sessions`
 * @param {unknown} value session id string, Session instance, or anything else
 * @returns {object | undefined} live Session
 */
function sessionOf(ctx, value) {
  if (typeof value === 'string') return ctx.sessions.get(value)
  if (typeof value === 'object' && value !== null) {
    if (typeof value.id === 'string') {
      const live = ctx.sessions.get(value.id)
      if (live !== undefined) return live
      if (typeof value.surface === 'object' && value.surface !== null) return value
    }
  }
  return undefined
}

/**
 * Create the service instance that becomes `ctx.sessionRollback`.
 * @param {object} options
 * @param {object} options.ctx Cordis context of the plugin
 * @param {object} options.store snapshot store
 * @param {object} options.recorder turn recorder
 * @param {{ warn?: Function }} [options.logger]
 * @returns {object} the service value to provide
 */
export function createRollbackService({ ctx, store, recorder, logger = console }) {
  /**
   * Sessions whose browser half is between `prepare` and `restore`. A caller that
   * never reaches `restore` (closed page, failed fork) stops blocking the session
   * after this long instead of leaving it unusable until the plugin reloads.
   */
  const running = new Map()
  const RUNNING_TTL_MS = 30_000

  /**
   * @param {string} sessionId
   * @returns {boolean} whether a rollback of this session is in flight
   */
  const isRunning = (sessionId) => {
    const started = running.get(sessionId)
    if (started === undefined) return false
    if (Date.now() - started > RUNNING_TTL_MS) {
      running.delete(sessionId)
      return false
    }
    return true
  }

  /**
   * The uniform "cannot start here" report.
   * @param {string} reason stable refusal code
   * @param {string | null} detail developer-facing detail
   * @returns {object}
   */
  const refusal = (reason, detail) => ({
    ok: false,
    stage: 'precheck',
    reason,
    detail,
    target: null,
    forkAtSeq: null,
    writeBack: null,
    incompleteTurns: [],
    complete: false,
  })

  class SessionRollback {
    /**
     * @param {object} context owning Cordis context
     */
    constructor(context) {
      this.ctx = context
      this.name = SERVICE_KEY
      // The Gateway's source-mode discovery reads this visible binding instead of
      // a decorator's class metadata; `service` must be this exact instance.
      this.typertRemote = Object.freeze({ service: this, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY })
    }

    /**
     * Whether the session can be rolled back right now, and what the surface holds.
     * @param {string} sessionId live session id
     * @returns {Promise<object>} availability, user messages and limits
     */
    async state(sessionId) {
      const session = sessionOf(ctx, sessionId)
      if (session === undefined) {
        const raw = typeof sessionId === 'string' ? sessionId : null
        return {
          available: false,
          reason: 'session-not-live',
          detail: 'this session is not open in the running Host',
          sessionId: raw,
          busy: false,
          userMessages: [],
          snapshotTurns: [],
          limits: store.limits,
        }
      }
      const gate = availability(ctx, session)
      let snapshotTurns = []
      let snapshotComplete = true
      try {
        const userMessages = listUserMessages(session, recorder)
        const firstTurn = userMessages.reduce(
          (lowest, row) => (row.turn !== undefined && (lowest === undefined || row.turn < lowest) ? row.turn : lowest),
          undefined,
        )
        if (firstTurn !== undefined) {
          const inspected = await store.inspect(session.id, firstTurn)
          snapshotTurns = inspected.turns
          snapshotComplete = inspected.complete
        }
        const busy = isRunning(session.id)
        const available = gate.available && !busy && userMessages.length > 0
        return {
          available,
          reason: busy
            ? 'rollback-in-progress'
            : (gate.available && userMessages.length === 0 ? 'no-user-message' : gate.reason),
          detail: gate.detail ?? null,
          sessionId: session.id,
          busy,
          userMessages: userMessages.map(summarize),
          snapshotTurns,
          snapshotComplete,
          limits: store.limits,
        }
      } catch (error) {
        logger.warn?.(`session-rollback: state of session "${session.id}" failed: ${error instanceof Error ? error.message : String(error)}`)
        return {
          available: false,
          reason: 'internal-error',
          detail: error instanceof Error ? error.message : String(error),
          sessionId: session.id,
          busy: isRunning(session.id),
          userMessages: [],
          snapshotTurns,
          snapshotComplete,
          limits: store.limits,
        }
      }
    }

    /**
     * Resolve one user message and the fork cut that removes its whole turn.
     * The browser half creates the child Session from the cut, then calls
     * `restore`; nothing changes in the log here.
     * @param {object} request `{ sessionId, seq?, ordinal?, index? }`
     * @returns {Promise<object>} the prepare report
     */
    async prepare(request) {
      const asked = request !== null && typeof request === 'object' ? request : {}
      const session = sessionOf(ctx, asked.sessionId)
      if (session === undefined) {
        return refusal('session-not-live', 'this session is not open in the running Host')
      }
      if (isRunning(session.id)) {
        return refusal('rollback-in-progress', 'another rollback of this session is still finishing')
      }
      running.set(session.id, Date.now())
      try {
        const report = await prepareRollback({ ctx, session, store, recorder, request: asked, logger })
        if (report.ok !== true) running.delete(session.id)
        return report
      } catch (error) {
        running.delete(session.id)
        const detail = error instanceof Error ? error.message : String(error)
        logger.warn?.(`session-rollback: preparing a rollback of session "${session.id}" failed: ${detail}`)
        return refusal('internal-error', detail)
      }
    }

    /**
     * Restore the files of the rolled-back turns, and let the child Session inherit
     * the parent's records for the turns it continues. The conversation fork is
     * already done by the browser half; this step never undoes it.
     * @param {object} request `{ sessionId, childSessionId?, turn? }`
     * @returns {Promise<object>} the restore report
     */
    async restore(request) {
      const asked = request !== null && typeof request === 'object' ? request : {}
      const session = sessionOf(ctx, asked.sessionId)
      if (session === undefined) {
        running.delete(typeof asked.sessionId === 'string' ? asked.sessionId : '')
        return {
          ...refusal('session-not-live', 'this session is not open in the running Host'),
          files: null,
          conversation: null,
        }
      }
      try {
        return await restoreRollback({ ctx, store, recorder, request: asked, logger })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        logger.warn?.(`session-rollback: restoring the files of session "${session.id}" failed: ${detail}`)
        return {
          ...refusal('internal-error', detail),
          files: null,
          conversation: null,
        }
      } finally {
        running.delete(session.id)
      }
    }

    /**
     * Drop the claim `prepare` took, without touching the conversation or the files.
     * The browser half calls this when the fork step failed, so the next attempt is
     * not refused by a rollback that never started.
     * @param {object} request `{ sessionId }`
     * @returns {{ ok: boolean, sessionId: string }} the released identity
     */
    release(request) {
      const asked = request !== null && typeof request === 'object' ? request : {}
      const sessionId = typeof asked.sessionId === 'string' ? asked.sessionId : ''
      if (sessionId !== '') running.delete(sessionId)
      return { ok: true, sessionId }
    }
  }

  markRemoteMethods(SessionRollback.prototype, ['state', 'prepare', 'restore', 'release'])
  return new SessionRollback(ctx)
}
