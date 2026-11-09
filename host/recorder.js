/**
 * Turn tracking and pre-mutation file capture for `dsh-session-rollback`.
 *
 * Two feeds cooperate:
 *  - the `fs/write-intent`, `fs/edit-intent` and `fs/delete-intent` waterfalls
 *    report the exact target a file mutation is about to touch, before it
 *    happens. A listener delegates the policy decision with `next()` first (this
 *    plugin never blocks, changes, or consumes that decision), then captures the
 *    current content of the target and returns the decision unchanged;
 *  - `session/event` records each `turn/start`, so a capture is attributed to the
 *    turn it belongs to, and an intent knows which turn a mutation happened in
 *    (`ctx.agents.turnBoundaryOf()` is the authoritative live reading).
 *
 * Attribution of a capture to its Session uses the process-local initiator chain
 * (`ctx.agents.currentInitiator()`), and falls back to the `ToolExecution` object
 * `tools/pre-execute` announced when the filesystem intent reports that same
 * object as its `actor`.
 *
 * @module dsh-session-rollback/host/recorder
 */

/**
 * Error text without the stack.
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the recorder.
 * @param {object} options
 * @param {object} options.ctx Cordis context
 * @param {object} options.store snapshot store
 * @param {{ warn?: Function }} [options.logger]
 * @returns {object} recorder with the capture hooks installed
 */
export function createRecorder({ ctx, store, logger = console }) {
  /** `ToolExecution` → the Agent that dispatched it. */
  const actors = new Map()
  /** Session id → `{ starts: { turn, seq }[], scanned }`. */
  const turns = new Map()
  /** Set while this plugin restores files, so its own writes are not captured. */
  let suspended = false
  let disposed = false
  let unattributed = 0

  /**
   * Read a Session's committed events for the turn index.
   * @param {object} session live Session
   * @returns {object[]}
   */
  function readAllEvents(session) {
    try {
      if (typeof session.snapshotEvents === 'function') {
        const events = session.snapshotEvents()
        if (Array.isArray(events)) return events
      }
    } catch {
      // fall through to whatever the instance exposes
    }
    return Array.isArray(session.log) ? session.log : []
  }

  /**
   * Per-Session turn index, built from the log the first time the Session is used
   * so a conversation that predates this plugin still rolls back correctly.
   * @param {object} session live Session
   * @returns {{ starts: { turn: number, seq: number }[], scanned: boolean }}
   */
  function stateOf(session) {
    let state = turns.get(session.id)
    if (state !== undefined) return state
    state = { starts: [], scanned: false }
    turns.set(session.id, state)
    state.scanned = true
    for (const event of readAllEvents(session)) {
      if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) {
        state.starts.push({ turn: event.data.turn, seq: event.seq })
      }
    }
    return state
  }

  /**
   * The turn a Session is running, read from the live turn boundary.
   * @param {object} session live Session
   * @returns {number | undefined}
   */
  function liveTurn(session) {
    try {
      const boundary = ctx.agents.turnBoundaryOf(session)
      return Number.isSafeInteger(boundary?.lastTurn) ? boundary.lastTurn : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The live Session an fs intent belongs to.
   * @param {object | undefined} actor the intent's actor object
   * @returns {object | undefined}
   */
  function sessionOfActor(actor) {
    const mapped = actor !== undefined ? actors.get(actor) : undefined
    let agent = mapped?.agent
    if (agent === undefined) {
      try {
        agent = ctx.agents.currentInitiator()
      } catch {
        agent = undefined
      }
    }
    if (agent === undefined) return undefined
    const session = agent.session
    if (session !== undefined && typeof session.id === 'string') return session
    const id = typeof agent.id === 'string' ? agent.id : undefined
    return id === undefined ? undefined : ctx.sessions.get(id)
  }

  /**
   * Capture the pre-mutation content of one target for its Session and turn.
   * Never throws: a failed capture is logged and the mutation proceeds unchanged.
   * @param {object} target resolved `FsTarget`
   * @param {object | undefined} actor the intent's actor object
   * @returns {Promise<void>}
   */
  async function capture(target, actor) {
    if (disposed || suspended) return
    try {
      const session = sessionOfActor(actor)
      if (session === undefined) {
        unattributed += 1
        return
      }
      const turn = liveTurn(session)
      if (turn === undefined) return
      let filePath
      try {
        filePath = ctx.fs.processPath(target)
      } catch (error) {
        logger.warn?.(`session-rollback: cannot resolve the path of a file target: ${messageOf(error)}`)
        return
      }
      const outcome = await store.capture({
        sessionId: session.id,
        turn,
        target,
        path: filePath,
        fs: ctx.fs,
      })
      if (outcome.captured !== true && outcome.reason !== undefined && outcome.reason !== 'already-captured') {
        // Limits and unreadable files are recorded in the turn record itself; the
        // log line helps a maintainer without changing the user-visible report.
        logger.warn?.(`session-rollback: "${filePath}" was not captured (turn ${turn}): ${outcome.reason}`)
      }
    } catch (error) {
      logger.warn?.(`session-rollback: file capture failed: ${messageOf(error)}`)
    }
  }

  const disposers = []

  disposers.push(ctx.on('session/event', (session, event) => {
    if (disposed || event?.type !== 'turn/start') return
    const turn = event.data?.turn
    if (!Number.isSafeInteger(turn)) return
    const state = stateOf(session)
    const last = state.starts[state.starts.length - 1]
    if (last === undefined || last.seq < event.seq) state.starts.push({ turn, seq: event.seq })
  }))

  disposers.push(ctx.on('tools/pre-execute', (exec, next) => {
    if (exec !== null && typeof exec === 'object' && exec.agent !== undefined) {
      actors.set(exec, { agent: exec.agent })
    }
    return next()
  }))

  disposers.push(ctx.on('tools/result', (exec) => {
    actors.delete(exec)
  }))

  disposers.push(ctx.on('fs/write-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(target, actor)
    return intent
  }))

  disposers.push(ctx.on('fs/edit-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(target, actor)
    return intent
  }))

  disposers.push(ctx.on('fs/delete-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(target, actor)
    return intent
  }))

  return {
    /**
     * The turn a surface event belongs to: the latest turn that started at or
     * before it. A user message is appended inside its turn, after `turn/start`.
     * @param {object} session live Session
     * @param {number} seq surface event sequence
     * @returns {number | undefined}
     */
    turnForSeq(session, seq) {
      const state = stateOf(session)
      let found
      for (const start of state.starts) {
        if (start.seq >= seq) break
        found = start.turn
      }
      return found
    },

    /**
     * Run `body` without capturing the writes it performs.
     * @template T
     * @param {() => Promise<T>} body
     * @returns {Promise<T>}
     */
    async withCaptureSuspended(body) {
      const previous = suspended
      suspended = true
      try {
        return await body()
      } finally {
        suspended = previous
      }
    },

    /**
     * How many fs mutations could not be attributed to a Session.
     * @returns {number}
     */
    unattributedCount() {
      return unattributed
    },

    /** Remove every listener and drop the bookkeeping. */
    dispose() {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // best effort during unload
        }
      }
      actors.clear()
      turns.clear()
    },
  }
}
