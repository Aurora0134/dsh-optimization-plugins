/**
 * The Host service `sessionRollback`: the two operations the browser half uses.
 *
 * `state` answers whether a session can be rolled back right now and which user
 * messages the current surface holds; `rollback` performs the surface
 * replacement and the file restoration and returns what the composer gets back.
 * The browser reaches both through the same-origin HTTP routes `host/api.js`
 * registers; this module owns only the behaviour and the service identity.
 *
 * The instance also carries Typert Remote markers, which cost nothing and keep
 * any consumer of the Remote protocol able to read the same two operations. This
 * package ships no generated `./typert` artifact, so it declares the same class
 * metadata that the protocol decorators write: a versioned descriptor on the
 * class prototype, and the `typertRemote` binding a Cordis Service constructor
 * publishes. Both methods therefore use only plain identifier parameters.
 *
 * @module dsh-session-rollback/host/service
 */

import { availability, listUserMessages, performRollback } from './rollback.js'

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
  /** Sessions with a rollback in flight, so two calls cannot interleave. */
  const running = new Set()

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
        const busy = running.has(session.id)
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
          busy: running.has(session.id),
          userMessages: [],
          snapshotTurns,
          snapshotComplete,
          limits: store.limits,
        }
      }
    }

    /**
     * Truncate the conversation at one user message and restore the files that
     * message's turn and every later turn changed.
     * @param {object} request `{ sessionId, seq?, ordinal?, index? }`
     * @returns {Promise<object>} the rollback report
     */
    async rollback(request) {
      const asked = request !== null && typeof request === 'object' ? request : {}
      const session = sessionOf(ctx, asked.sessionId)
      if (session === undefined) {
        return {
          ok: false,
          stage: 'precheck',
          reason: 'session-not-live',
          detail: 'this session is not open in the running Host',
          conversation: null,
          target: null,
          files: null,
          incompleteTurns: [],
          complete: false,
          writeBack: null,
        }
      }
      if (running.has(session.id)) {
        return {
          ok: false,
          stage: 'precheck',
          reason: 'rollback-in-progress',
          detail: 'another rollback of this session is still finishing',
          conversation: null,
          target: null,
          files: null,
          incompleteTurns: [],
          complete: false,
          writeBack: null,
        }
      }
      running.add(session.id)
      try {
        return await performRollback({ ctx, session, store, recorder, request: asked, logger })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        logger.warn?.(`session-rollback: rollback of session "${session.id}" failed: ${detail}`)
        return {
          ok: false,
          stage: 'internal',
          reason: 'internal-error',
          detail,
          conversation: null,
          target: null,
          files: null,
          incompleteTurns: [],
          complete: false,
          writeBack: null,
        }
      } finally {
        running.delete(session.id)
      }
    }
  }

  markRemoteMethods(SessionRollback.prototype, ['state', 'rollback'])
  return new SessionRollback(ctx)
}
