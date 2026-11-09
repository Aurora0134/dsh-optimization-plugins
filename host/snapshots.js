/**
 * Snapshot store for `dsh-session-rollback`.
 *
 * One directory per Session, one JSON record per turn, one file per distinct
 * content hash. Every captured file is stored *before* the tool mutates it, so a
 * turn record describes the content each touched path had when that turn began.
 * Restoring turns newest to oldest therefore yields the content the oldest
 * restored turn started from.
 *
 * The store lives under the Harness home, never inside a user workspace, and is
 * removed when its Session is disposed or the plugin unloads.
 *
 * @module dsh-session-rollback/host/snapshots
 */
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Layout version of a turn record; a mismatch is ignored rather than guessed. */
const RECORD_VERSION = 1

/** Default ceilings. A turn that exceeds one is reported as not fully restorable. */
const DEFAULTS = Object.freeze({
  maxFileBytes: 512 * 1024,
  maxTurnBytes: 8 * 1024 * 1024,
  maxTurnFiles: 200,
  maxSessionBytes: 64 * 1024 * 1024,
})

/**
 * Read one numeric config field, falling back to the default for anything that
 * is not a positive safe integer.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * Error text without the stack.
 * @param {unknown} error
 * @returns {string}
 */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Normalize the plugin config into the store's limits.
 * @param {Record<string, unknown>} config
 */
export function resolveLimits(config = {}) {
  return {
    maxFileBytes: positive(config.maxFileBytes, DEFAULTS.maxFileBytes),
    maxTurnBytes: positive(config.maxTurnBytes, DEFAULTS.maxTurnBytes),
    maxTurnFiles: positive(config.maxTurnFiles, DEFAULTS.maxTurnFiles),
    maxSessionBytes: positive(config.maxSessionBytes, DEFAULTS.maxSessionBytes),
  }
}

/**
 * Create the snapshot store.
 * @param {object} options
 * @param {string} options.root directory owned by this plugin, outside any workspace
 * @param {object} [options.config] plugin config
 * @param {{ warn?: Function }} [options.logger]
 * @returns {object} store
 */
export function createSnapshotStore({ root, config = {}, logger = console }) {
  const limits = resolveLimits(config)
  /** @type {Map<string, object>} */
  const sessions = new Map()
  let disposed = false
  let tempCounter = 0

  /**
   * Per-Session bookkeeping, loaded from disk on first use so a plugin reload
   * keeps the snapshots of Sessions that are still live.
   * @param {string} sessionId
   * @returns {object}
   */
  const sessionState = (sessionId) => {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing
    const dir = path.join(root, encodeURIComponent(sessionId))
    const state = {
      id: sessionId,
      dir,
      blobs: new Map(),
      turns: new Map(),
      bytes: 0,
      loaded: false,
      targets: new Map(),
    }
    sessions.set(sessionId, state)
    return state
  }

  /**
   * Read persisted turn records for one Session.
   * @param {object} state session state
   * @returns {Promise<void>}
   */
  const ensureLoaded = async (state) => {
    if (state.loaded) return
    state.loaded = true
    let names
    try {
      names = await fsp.readdir(path.join(state.dir, 'turns'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn?.(`session-rollback: cannot list snapshots of session "${state.id}": ${messageOf(error)}`)
      }
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(state.dir, 'turns', name), 'utf8'))
        if (raw?.version !== RECORD_VERSION || !Number.isSafeInteger(raw.turn) || !Array.isArray(raw.entries)) continue
        const record = {
          turn: raw.turn,
          entries: new Map(),
          bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
          files: Array.isArray(raw.entries) ? raw.entries.length : 0,
          complete: raw.complete === true,
          reasons: Array.isArray(raw.reasons) ? raw.reasons.filter((reason) => typeof reason?.code === 'string') : [],
          dirty: false,
        }
        for (const entry of raw.entries) {
          if (typeof entry?.path !== 'string') continue
          const hash = typeof entry.hash === 'string' ? entry.hash : null
          record.entries.set(entry.path, { path: entry.path, hash, size: typeof entry.size === 'number' ? entry.size : 0 })
          if (hash !== null) state.blobs.set(hash, true)
        }
        state.bytes += record.bytes
        state.turns.set(record.turn, record)
      } catch {
        // A half-written or foreign record is ignored: the turn simply has no snapshot.
      }
    }
  }

  /**
   * One turn record, created on first capture.
   * @param {object} state session state
   * @param {number} turn
   */
  const turnRecord = (state, turn) => {
    const existing = state.turns.get(turn)
    if (existing !== undefined) return existing
    const created = { turn, entries: new Map(), bytes: 0, files: 0, complete: true, reasons: [], dirty: false }
    state.turns.set(turn, created)
    return created
  }

  /**
   * Mark a turn as not fully restorable. The first reason per code and path wins,
   * so a repeated write to one oversized file does not grow the report.
   * @param {object} record
   * @param {string} code
   * @param {string} [filePath]
   */
  const markIncomplete = (record, code, filePath) => {
    record.complete = false
    if (!record.reasons.some((reason) => reason.code === code && reason.path === filePath)) {
      record.reasons.push(filePath === undefined ? { code } : { code, path: filePath })
    }
  }

  /**
   * Publish one blob atomically; identical content is stored once per Session.
   * @param {object} state
   * @param {string} content
   * @returns {Promise<{ hash: string, size: number, created: boolean }>}
   */
  const writeBlob = async (state, content) => {
    const bytes = Buffer.byteLength(content, 'utf8')
    const hash = createHash('sha256').update(content, 'utf8').digest('hex')
    if (state.blobs.has(hash)) return { hash, size: bytes, created: false }
    const dir = path.join(state.dir, 'blobs')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, hash)
    const temporary = `${file}.${process.pid}.${tempCounter++}.tmp`
    await fsp.writeFile(temporary, content, 'utf8')
    try {
      await fsp.rename(temporary, file)
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    state.blobs.set(hash, true)
    return { hash, size: bytes, created: true }
  }

  /**
   * Persist one turn record.
   * @param {object} state
   * @param {object} record
   */
  const flushTurn = async (state, record) => {
    if (!record.dirty) return
    const dir = path.join(state.dir, 'turns')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${record.turn}.json`)
    const temporary = `${file}.${process.pid}.${tempCounter++}.tmp`
    const payload = {
      version: RECORD_VERSION,
      turn: record.turn,
      bytes: record.bytes,
      complete: record.complete,
      reasons: record.reasons,
      entries: [...record.entries.values()],
    }
    await fsp.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    try {
      await fsp.rename(temporary, file)
      record.dirty = false
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Durably write every dirty turn record of one Session.
   * @param {string} sessionId
   */
  const flushSession = async (sessionId) => {
    const state = sessions.get(sessionId)
    if (state === undefined) return
    for (const record of state.turns.values()) {
      if (!record.dirty) continue
      try {
        await flushTurn(state, record)
      } catch (error) {
        logger.warn?.(`session-rollback: cannot persist snapshot of session "${sessionId}" turn ${record.turn}: ${messageOf(error)}`)
      }
    }
  }

  return {
    root,
    limits,

    /**
     * Capture the pre-mutation content of one target for one turn.
     * The first capture of a path in a turn wins: later mutations in the same
     * turn keep the content the turn started from.
     * @param {object} options
     * @param {string} options.sessionId
     * @param {number} options.turn
     * @param {object} options.target resolved `FsTarget`
     * @param {string} options.path canonical path used as the record key
     * @param {object} options.fs the injected `ctx.fs` service
     * @returns {Promise<{ captured: boolean, reason?: string }>}
     */
    async capture({ sessionId, turn, target, path: filePath, fs }) {
      if (disposed) return { captured: false, reason: 'store-disposed' }
      const state = sessionState(sessionId)
      await ensureLoaded(state)
      const record = turnRecord(state, turn)
      if (!record.complete) return { captured: false, reason: 'turn-incomplete' }
      if (record.entries.has(filePath)) return { captured: false, reason: 'already-captured' }
      if (record.entries.size >= limits.maxTurnFiles) {
        markIncomplete(record, 'turn-file-limit')
        record.dirty = true
        return { captured: false, reason: 'turn-file-limit' }
      }
      let info
      try {
        info = await fs.stat(target)
      } catch (error) {
        markIncomplete(record, 'stat-failed', filePath)
        return { captured: false, reason: `stat-failed: ${messageOf(error)}` }
      }
      if (info !== undefined && info.type !== 'file') {
        state.targets.set(filePath, target)
        return { captured: false, reason: 'not-a-file' }
      }
      if (info !== undefined && typeof info.size === 'number' && info.size > limits.maxFileBytes) {
        markIncomplete(record, 'file-too-large', filePath)
        state.targets.set(filePath, target)
        record.dirty = true
        return { captured: false, reason: 'file-too-large' }
      }
      if (info === undefined) {
        // The mutation creates the file; restoring this turn removes it again.
        record.entries.set(filePath, { path: filePath, hash: null, size: 0 })
        record.files = record.entries.size
        record.dirty = true
        state.targets.set(filePath, target)
        return { captured: true }
      }
      let content
      try {
        content = await fs.readText(target)
      } catch (error) {
        markIncomplete(record, 'read-failed', filePath)
        state.targets.set(filePath, target)
        record.dirty = true
        return { captured: false, reason: `read-failed: ${messageOf(error)}` }
      }
      const size = Buffer.byteLength(content, 'utf8')
      if (size > limits.maxFileBytes) {
        markIncomplete(record, 'file-too-large', filePath)
        state.targets.set(filePath, target)
        record.dirty = true
        return { captured: false, reason: 'file-too-large' }
      }
      if (record.bytes + size > limits.maxTurnBytes || state.bytes + size > limits.maxSessionBytes) {
        markIncomplete(record, record.bytes + size > limits.maxTurnBytes ? 'turn-byte-limit' : 'session-byte-limit')
        record.dirty = true
        return { captured: false, reason: 'byte-limit' }
      }
      let stored
      try {
        stored = await writeBlob(state, content)
      } catch (error) {
        markIncomplete(record, 'store-failed', filePath)
        record.dirty = true
        return { captured: false, reason: `store-failed: ${messageOf(error)}` }
      }
      state.targets.set(filePath, target)
      record.entries.set(filePath, { path: filePath, hash: stored.hash, size })
      record.bytes += stored.created ? size : 0
      record.files = record.entries.size
      if (stored.created) state.bytes += size
      record.dirty = true
      return { captured: true }
    },

    /**
     * The report a Session's turns can carry: whether the range from `fromTurn`
     * on can be restored completely.
     * @param {string} sessionId
     * @param {number} fromTurn
     * @returns {Promise<{ complete: boolean, turns: { turn: number, files: number, complete: boolean, reasons: object[] }[] }>}
     */
    async inspect(sessionId, fromTurn) {
      const state = sessionState(sessionId)
      await ensureLoaded(state)
      const turns = []
      let complete = true
      for (const record of state.turns.values()) {
        if (record.turn < fromTurn) continue
        if (!record.complete) complete = false
        turns.push({ turn: record.turn, files: record.files, complete: record.complete, reasons: [...record.reasons] })
      }
      turns.sort((left, right) => left.turn - right.turn)
      return { complete, turns }
    },

    /**
     * Durably write every turn record of one Session. Called at turn end and
     * before a restore reads anything back.
     * @param {string} sessionId
     * @returns {Promise<void>}
     */
    flush: flushSession,

    /**
     * The newest-to-oldest restore plan for turns `fromTurn`..latest.
     * @param {string} sessionId
     * @param {number} fromTurn
     * @returns {Promise<{ turn: number, entries: { path: string, hash: string|null, target?: object }[], complete: boolean, reasons: object[] }[]>}
     */
    async plan(sessionId, fromTurn) {
      const state = sessionState(sessionId)
      await ensureLoaded(state)
      await flushSession(sessionId)
      const records = [...state.turns.values()].filter((record) => record.turn >= fromTurn)
      records.sort((left, right) => right.turn - left.turn)
      return records.map((record) => ({
        turn: record.turn,
        complete: record.complete,
        reasons: [...record.reasons],
        entries: [...record.entries.values()].map((entry) => ({
          path: entry.path,
          hash: entry.hash,
          target: state.targets.get(entry.path),
        })),
      }))
    },

    /**
     * Read one stored content back.
     * @param {string} sessionId
     * @param {string} hash
     * @returns {Promise<string>}
     */
    async readBlob(sessionId, hash) {
      const state = sessionState(sessionId)
      return await fsp.readFile(path.join(state.dir, 'blobs', hash), 'utf8')
    },

    /**
     * Drop one Session's snapshots.
     * @param {string} sessionId
     * @returns {Promise<void>}
     */
    async forget(sessionId) {
      const state = sessionState(sessionId)
      sessions.delete(sessionId)
      await fsp.rm(state.dir, { recursive: true, force: true }).catch((error) => {
        logger.warn?.(`session-rollback: cannot remove snapshots of session "${sessionId}": ${messageOf(error)}`)
      })
    },

    /**
     * Drop every Session's snapshots and the plugin's root directory.
     * @returns {Promise<void>}
     */
    async dispose() {
      if (disposed) return
      disposed = true
      const ids = [...sessions.keys()]
      sessions.clear()
      for (const id of ids) {
        await fsp.rm(path.join(root, encodeURIComponent(id)), { recursive: true, force: true }).catch(() => {})
      }
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
    },
  }
}
