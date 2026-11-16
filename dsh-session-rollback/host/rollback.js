/**
 * Conversation rollback and file restoration for `dsh-session-rollback`.
 *
 * Rolling back is a native session fork: the conversation is cut at the end of
 * the turn before the clicked message and continued in a child Session. The
 * child's transcript and model input therefore start after that message, so the
 * clicked message and its whole turn are absent from the conversation the user
 * continues in, while the parent Session keeps the raw record.
 *
 * Files are restored newest turn first: a turn record holds the content each path
 * had when that turn began, so replaying the records newest to oldest ends at the
 * content the target turn started from. The child inherits the parent's records
 * for the turns it continues, so a later rollback inside the child can still
 * restore files.
 *
 * @module dsh-session-rollback/host/rollback
 */

import { messageOf } from './snapshots.js'

/** Stable reason codes; the browser half owns every piece of user-visible text. */
export const REASONS = Object.freeze({
  ready: 'ready',
  sessionNotLive: 'session-not-live',
  turnOpen: 'turn-open',
  noUserMessage: 'no-user-message',
  targetMissing: 'target-missing',
  targetNotUserPrompt: 'target-not-user-prompt',
  noForkBoundary: 'no-fork-boundary',
  fileRestoreIncomplete: 'file-restore-incomplete',
  partialSnapshot: 'partial-snapshot',
  rolledBack: 'rolled-back',
})

/**
 * Current surface node sequences, copied so callers cannot mutate the fold.
 * @param {object} session live Session
 * @returns {number[]}
 */
export function surfaceNodes(session) {
  const nodes = session?.surface?.nodes
  return Array.isArray(nodes) ? [...nodes] : []
}

/**
 * One committed event by sequence, or undefined when it cannot be read.
 * @param {object} session live Session
 * @param {number} seq event sequence
 * @returns {object | undefined}
 */
export function eventAt(session, seq) {
  try {
    if (typeof session.eventAt === 'function') return session.eventAt(seq)
  } catch {
    // fall through
  }
  try {
    if (typeof session.snapshotEvents === 'function') {
      const window = session.snapshotEvents(seq, seq + 1)
      if (Array.isArray(window) && window.length === 1) return window[0]
    }
  } catch {
    // fall through
  }
  return undefined
}

/**
 * Split one message's content into the text the composer takes back and the
 * count of parts that cannot be expressed as text.
 * @param {object | undefined} message
 * @returns {{ text: string, nonTextParts: number }}
 */
export function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  const texts = []
  let nonTextParts = 0
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else nonTextParts += 1
  }
  return { text: texts.join('\n\n'), nonTextParts }
}

/**
 * Every user prompt in current surface order.
 *
 * Only `user/message` nodes whose source kind is `user` are prompts a person
 * typed; the same event type also carries injected context (workspace
 * instructions, runtime context, the skill catalog, the time snapshot), which
 * the conversation view does not show as user messages. `ordinal` is 1-based and
 * `index` 0-based over this exact list, so a caller that received the list from
 * `state` can send either one back unchanged.
 *
 * @param {object} session live Session
 * @param {object} recorder turn recorder
 * @returns {{ seq: number, index: number, ordinal: number, turn: number | undefined, preview: string, text: string, nonTextParts: number }[]}
 */
export function listUserMessages(session, recorder) {
  const rows = []
  for (const seq of surfaceNodes(session)) {
    const event = eventAt(session, seq)
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    const { text, nonTextParts } = textOf(event.data)
    rows.push({
      seq,
      index: rows.length,
      ordinal: rows.length + 1,
      turn: recorder.turnForSeq(session, seq),
      preview: text.replace(/\s+/g, ' ').trim().slice(0, 120),
      text,
      nonTextParts,
    })
  }
  return rows
}

/**
 * Locate the clicked user message in the current surface.
 * @param {object} session live Session
 * @param {object} recorder turn recorder
 * @param {{ seq?: unknown, index?: unknown, ordinal?: unknown }} request
 * @returns {{ ok: true, target: object } | { ok: false, reason: string, detail: string }}
 */
export function resolveTarget(session, recorder, request) {
  const rows = listUserMessages(session, recorder)
  if (typeof request?.seq === 'number' && Number.isSafeInteger(request.seq)) {
    const found = rows.find((row) => row.seq === request.seq)
    if (found !== undefined) return { ok: true, target: found }
    const event = eventAt(session, request.seq)
    if (event !== undefined) {
      if (event.type === 'user/message') {
        if (event.data?.source?.kind === 'user') {
          return {
            ok: false,
            reason: REASONS.targetMissing,
            detail: `the user message at seq ${request.seq} is no longer part of the surface`,
          }
        }
        return {
          ok: false,
          reason: REASONS.targetNotUserPrompt,
          detail: `seq ${request.seq} holds injected context, not a user prompt`,
        }
      }
      return {
        ok: false,
        reason: REASONS.targetNotUserPrompt,
        detail: `seq ${request.seq} holds a ${event.type} event, not a user prompt`,
      }
    }
    return { ok: false, reason: REASONS.targetMissing, detail: `no event at seq ${request.seq} in this session` }
  }
  const ordinal = typeof request?.ordinal === 'number' && Number.isSafeInteger(request.ordinal) ? request.ordinal : undefined
  const index = typeof request?.index === 'number' && Number.isSafeInteger(request.index) ? request.index : undefined
  if (ordinal === undefined && index === undefined) {
    return { ok: false, reason: REASONS.targetMissing, detail: 'rollback needs seq, ordinal or index of the user message' }
  }
  const position = ordinal !== undefined ? ordinal - 1 : index
  const found = position >= 0 ? rows[position] : undefined
  if (found === undefined) {
    return {
      ok: false,
      reason: REASONS.targetMissing,
      detail: `the session has ${rows.length} user message(s); ${ordinal !== undefined ? `ordinal ${ordinal}` : `index ${index}`} is out of range`,
    }
  }
  return { ok: true, target: found }
}

/**
 * The event sequence a rollback forks from: the last event before the clicked
 * message's turn.
 *
 * A fork copies an inclusive event prefix, so the cut is the previous turn's
 * `turn/end`. That keeps the target turn's opening records (`turn/start`, inbox
 * splices, `step/start`) out of the child, which would otherwise claim a message
 * the child does not hold. A first turn has no earlier `turn/end`; the cut then
 * falls back to the event before the inbox splice that queues its prompt, so the
 * clicked message is not inherited as pending input.
 *
 * @param {object} session live Session
 * @param {number} targetSeq sequence of the clicked user message
 * @returns {{ boundary: number, turnStartSeq: number } | undefined}
 */
export function forkBoundary(session, targetSeq) {
  if (typeof targetSeq !== 'number' || !Number.isSafeInteger(targetSeq) || targetSeq < 0) return undefined
  let events
  try {
    events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
  } catch {
    return undefined
  }
  if (!Array.isArray(events) || events.length === 0) return undefined
  /** @type {Map<number, object>} */
  const bySeq = new Map()
  for (const event of events) {
    if (Number.isSafeInteger(event?.seq)) bySeq.set(event.seq, event)
  }
  let turnStart
  for (const event of bySeq.values()) {
    if (event.seq >= targetSeq) continue
    if (event.type === 'turn/start') turnStart = event
  }
  if (turnStart === undefined) return undefined
  let boundary
  for (const event of bySeq.values()) {
    if (event.seq >= turnStart.seq) continue
    if (event.type === 'turn/end') boundary = event.seq
  }
  if (boundary === undefined) boundary = firstTurnCut(bySeq, turnStart)
  if (!Number.isSafeInteger(boundary) || boundary < 0) return undefined
  if (!bySeq.has(boundary)) return undefined
  return { boundary, turnStartSeq: turnStart.seq }
}

/**
 * Where to cut when the target turn is the Session's first.
 *
 * A prompt reaches the agent through an `agent/inbox/spliced` insert before the
 * turn that consumes it, so `turnStart - 1` is that insert and the child would
 * inherit the clicked message as pending input. Cut before the inserts instead,
 * keeping the session setup the prefix already holds.
 *
 * @param {Map<number, object>} bySeq events by sequence
 * @param {{ seq: number }} turnStart first `turn/start`
 * @returns {number} an existing sequence, or `turnStart - 1` when nothing precedes them
 */
function firstTurnCut(bySeq, turnStart) {
  let queued
  for (const event of bySeq.values()) {
    if (event.seq >= turnStart.seq) continue
    if (event.type === 'agent/inbox/spliced' && queued === undefined) queued = event.seq
  }
  const before = (queued ?? turnStart.seq) - 1
  return bySeq.has(before) ? before : turnStart.seq - 1
}

/**
 * Whether this session can be rolled back right now, and why not.
 * The gate is the log itself: an open turn means the agent is still running the
 * turn a fork would cut away.
 * @param {object} ctx Cordis context carrying `agents`
 * @param {object} session live Session
 * @returns {{ available: boolean, reason: string, detail?: string }}
 */
export function availability(ctx, session) {
  if (session === undefined) return { available: false, reason: REASONS.sessionNotLive }
  try {
    const boundary = ctx.agents.turnBoundaryOf(session)
    if (boundary !== undefined && boundary !== null && typeof boundary.openTurnStartSeq === 'number') {
      return { available: false, reason: REASONS.turnOpen, detail: 'the agent is still inside a turn' }
    }
  } catch (error) {
    return { available: false, reason: REASONS.turnOpen, detail: `the turn position could not be read: ${messageOf(error)}` }
  }
  return { available: true, reason: REASONS.ready }
}

/**
 * Restore every path the given turn and every later turn changed, newest turn
 * first. A failed path is reported and the remaining paths still run: file
 * restoration never undoes a conversation rollback that already committed.
 * @param {object} options
 * @param {object} options.ctx Cordis context carrying `fs`
 * @param {object} options.store snapshot store
 * @param {object} options.recorder turn recorder
 * @param {string} options.sessionId
 * @param {number} options.fromTurn first turn whose changes are undone
 * @returns {Promise<{ turns: number[], restored: object[], deleted: object[], skipped: object[], failed: object[], untracked: boolean }>}
 */
export async function restoreFiles({ ctx, store, recorder, sessionId, fromTurn }) {
  const restored = []
  const deleted = []
  const failed = []
  const skipped = []
  const turns = []
  let plan
  try {
    plan = await store.plan(sessionId, fromTurn)
  } catch (error) {
    failed.push({ path: '', turn: fromTurn, reason: `the snapshot index is unreadable: ${messageOf(error)}` })
    return { turns, restored, deleted, skipped, failed, untracked: true }
  }
  const untracked = plan.length === 0
  // The restore writes through the same filesystem service, so its own writes
  // must not become new pre-mutation captures.
  await recorder.withCaptureSuspended(async () => {
    for (const record of plan) {
      turns.push(record.turn)
      for (const entry of record.entries) {
        let target = entry.target
        if (target === undefined) {
          try {
            target = await ctx.fs.resolve(entry.path)
          } catch (error) {
            failed.push({ path: entry.path, turn: record.turn, reason: `the path cannot be resolved: ${messageOf(error)}` })
            continue
          }
        }
        if (entry.hash === null) {
          try {
            const info = await ctx.fs.stat(target)
            if (info === undefined) {
              skipped.push({ path: entry.path, turn: record.turn, reason: 'already absent' })
              continue
            }
            await ctx.fs.deleteFile(target)
            deleted.push({ path: entry.path, turn: record.turn })
          } catch (error) {
            failed.push({ path: entry.path, turn: record.turn, reason: `the file this turn created cannot be removed: ${messageOf(error)}` })
          }
          continue
        }
        let content
        try {
          content = await store.readBlob(sessionId, entry.hash)
        } catch (error) {
          failed.push({ path: entry.path, turn: record.turn, reason: `the stored content is unreadable: ${messageOf(error)}` })
          continue
        }
        try {
          await ctx.fs.writeText(target, content)
          restored.push({ path: entry.path, turn: record.turn })
        } catch (error) {
          failed.push({ path: entry.path, turn: record.turn, reason: `the stored content cannot be written: ${messageOf(error)}` })
        }
      }
    }
  })
  return { turns, restored, deleted, skipped, failed, untracked }
}

/**
 * Resolve the clicked message and the fork cut that removes its whole turn.
 *
 * This is the first half of a rollback: the browser half creates the child
 * Session from `forkAtSeq`, then calls `restore` for the files. Nothing in the
 * log changes here, so a failed fork leaves the session exactly as it was.
 *
 * @param {object} options
 * @param {object} options.ctx Cordis context
 * @param {object} options.session live Session
 * @param {object} options.store snapshot store
 * @param {object} options.recorder turn recorder
 * @param {object} options.request `{ seq?, ordinal?, index? }`
 * @param {{ warn?: Function }} [options.logger]
 * @returns {Promise<object>} the prepare report
 */
export async function prepareRollback({ ctx, session, store, recorder, request, logger = console }) {
  const report = (fields) => ({
    ok: false,
    stage: 'precheck',
    reason: REASONS.targetMissing,
    detail: null,
    target: null,
    forkAtSeq: null,
    writeBack: null,
    incompleteTurns: [],
    complete: false,
    ...fields,
  })

  const gate = availability(ctx, session)
  if (!gate.available) {
    return report({ reason: gate.reason, detail: gate.detail ?? null })
  }
  const resolved = resolveTarget(session, recorder, request)
  if (!resolved.ok) {
    return report({ reason: resolved.reason, detail: resolved.detail })
  }
  const target = resolved.target
  const cut = forkBoundary(session, target.seq)
  if (cut === undefined) {
    return report({
      reason: REASONS.noForkBoundary,
      detail: 'there is no earlier conversation to keep, so the turn cannot be forked away',
      target: summarizeTarget(target),
    })
  }

  let inspected = { complete: true, turns: [] }
  if (target.turn !== undefined) {
    try {
      inspected = await store.inspect(session.id, target.turn)
    } catch (error) {
      logger.warn?.(`session-rollback: snapshots of session "${session.id}" are unreadable: ${messageOf(error)}`)
      inspected = { complete: false, turns: [] }
    }
  }

  return {
    ok: true,
    stage: 'ready',
    reason: REASONS.ready,
    detail: null,
    target: summarizeTarget(target),
    forkAtSeq: cut.boundary,
    writeBack: { text: target.text, nonTextParts: target.nonTextParts },
    incompleteTurns: inspected.turns.filter((turn) => turn.complete !== true),
    complete: inspected.complete === true,
  }
}

/**
 * Restore the files the target turn and later turns changed, after the browser
 * half created the child Session from `prepareRollback`'s cut.
 *
 * The child inherits the parent's turn records from before the target turn first,
 * so the continued session can restore those files again later. It also drops the
 * input the cut left pending: those messages were queued for a removed turn.
 *
 * @param {object} options
 * @param {object} options.ctx Cordis context
 * @param {object} options.store snapshot store
 * @param {object} options.recorder turn recorder
 * @param {object} options.request `{ sessionId, childSessionId?, turn? }`
 * @param {{ warn?: Function }} [options.logger]
 * @returns {Promise<object>} the restore report
 */
export async function restoreRollback({ ctx, store, recorder, request, logger = console }) {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  const childSessionId = typeof request?.childSessionId === 'string' ? request.childSessionId : ''
  const turn = typeof request?.turn === 'number' && Number.isSafeInteger(request.turn) && request.turn >= 0
    ? request.turn
    : undefined

  if (childSessionId !== '' && turn !== undefined) {
    try {
      await store.inherit(sessionId, childSessionId, turn)
    } catch (error) {
      logger.warn?.(`session-rollback: the child session could not inherit the snapshots of "${sessionId}": ${messageOf(error)}`)
    }
  }
  if (childSessionId !== '') dropInheritedInput(ctx, childSessionId, logger)

  const files = turn === undefined
    ? { turns: [], restored: [], deleted: [], skipped: [], failed: [], untracked: true }
    : await restoreFiles({ ctx, store, recorder, sessionId, fromTurn: turn })

  let inspected = { complete: true, turns: [] }
  if (turn !== undefined) {
    try {
      inspected = await store.inspect(sessionId, turn)
    } catch (error) {
      logger.warn?.(`session-rollback: snapshots of session "${sessionId}" are unreadable: ${messageOf(error)}`)
      inspected = { complete: false, turns: [] }
    }
  }

  const filesFailed = files.failed.length > 0
  const complete = !filesFailed && inspected.complete === true
  return {
    ok: !filesFailed,
    stage: filesFailed ? 'files' : 'done',
    reason: filesFailed
      ? REASONS.fileRestoreIncomplete
      : (complete ? REASONS.rolledBack : REASONS.partialSnapshot),
    detail: filesFailed
      ? `${files.failed.length} file(s) could not be restored`
      : (complete ? null : 'some captured turns are incomplete, so those files may not be fully restored'),
    files,
    incompleteTurns: inspected.turns.filter((entry) => entry.complete !== true),
    complete,
    conversation: null,
    writeBack: null,
  }
}

/**
 * Drop pending input the child inherited through the fork prefix.
 *
 * A user message is queued by an `agent/inbox/spliced` insert that the consuming
 * turn claims afterwards; a cut between the two would leave that message pending
 * in the child, where the next turn would claim and run it again.
 *
 * @param {object} ctx Cordis context carrying `agents`
 * @param {string} childSessionId forked Session that inherited the prefix
 * @param {{ warn?: Function }} logger
 * @returns {void}
 */
function dropInheritedInput(ctx, childSessionId, logger) {
  try {
    const inbox = ctx?.agents?.get?.(childSessionId)?.inbox
    if (inbox === undefined || inbox === null) return
    if (inbox.nextTurn.length === 0 && inbox.nextStep.length === 0) return
    inbox.clear()
  } catch (error) {
    logger.warn?.(
      `session-rollback: the child session "${childSessionId}" could not drop inherited input: ${messageOf(error)}`,
    )
  }
}

/**
 * The wire form of the clicked message, without its body (the body travels in
 * `writeBack`).
 * @param {object} target resolved user message
 * @returns {object}
 */
function summarizeTarget(target) {
  return {
    seq: target.seq,
    index: target.index,
    ordinal: target.ordinal,
    turn: target.turn ?? null,
    preview: target.preview,
    nonTextParts: target.nonTextParts,
  }
}
