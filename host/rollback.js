/**
 * Conversation truncation and file restoration for `dsh-session-rollback`.
 *
 * Truncating is one surface replacement: an empty `developer/message` whose
 * `surfaceOp` replaces the clicked user message and every surface node after it.
 * Shadowed nodes disappear from future model input and from the conversation
 * view; their raw log records stay. Empty developer content projects to no
 * message, so the replacement node itself leaves no visible row.
 *
 * Files are restored newest turn first: a turn record holds the content each path
 * had when that turn began, so replaying the records newest to oldest ends at the
 * content the target turn started from.
 *
 * @module dsh-session-rollback/host/rollback
 */

import { randomUUID } from 'node:crypto'

import { messageOf } from './snapshots.js'

/** Stable reason codes; the browser half owns every piece of user-visible text. */
export const REASONS = Object.freeze({
  ready: 'ready',
  sessionNotLive: 'session-not-live',
  turnOpen: 'turn-open',
  noUserMessage: 'no-user-message',
  targetMissing: 'target-missing',
  targetNotUserPrompt: 'target-not-user-prompt',
  protectedHead: 'protected-system-head',
  surfaceRejected: 'surface-rejected',
  surfaceNoEffect: 'surface-no-effect',
  fileRestoreIncomplete: 'file-restore-incomplete',
  partialSnapshot: 'partial-snapshot',
  rolledBack: 'rolled-back',
})

/**
 * One invisible developer message: the replacement payload the replace event
 * carries.
 *
 * The session contract identifies every persisted message (`id`, `source`), and
 * a stored log is revalidated on load; a marker without those fields would make
 * the rolled-back session unreadable. Empty content still projects to no visible
 * row and no model message, which is what makes the node itself invisible. The
 * fresh identity keeps two rollbacks of the same session from sharing a message
 * id.
 * @returns {object} the replacement message
 */
function replacementMessage() {
  return {
    id: randomUUID(),
    role: 'developer',
    content: [],
    // The source kind the framework itself uses for developer messages; an empty
    // content list means it adds or removes no tool.
    source: { kind: 'tool-registry' },
  }
}

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
 * Whether this session can be rolled back right now, and why not.
 * The gate is the log itself: an open turn means the agent is still running the
 * turn a replacement would truncate.
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
 * restoration never undoes a conversation truncation that already committed.
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
 * Truncate the conversation at one user message and restore the files that turn
 * and the following turns changed.
 * @param {object} options
 * @param {object} options.ctx Cordis context
 * @param {object} options.session live Session
 * @param {object} options.store snapshot store
 * @param {object} options.recorder turn recorder
 * @param {object} options.request `{ sessionId, seq?, ordinal?, index? }`
 * @param {{ warn?: Function }} [options.logger]
 * @returns {Promise<object>} the rollback report
 */
export async function performRollback({ ctx, session, store, recorder, request, logger = console }) {
  const report = (fields) => ({
    conversation: null,
    target: null,
    files: null,
    incompleteTurns: [],
    complete: false,
    writeBack: null,
    ...fields,
  })

  const gate = availability(ctx, session)
  if (!gate.available) {
    return report({ ok: false, stage: 'precheck', reason: gate.reason, detail: gate.detail ?? null })
  }
  const resolved = resolveTarget(session, recorder, request)
  if (!resolved.ok) {
    return report({ ok: false, stage: 'precheck', reason: resolved.reason, detail: resolved.detail })
  }
  const target = resolved.target
  const nodes = surfaceNodes(session)
  const startIdx = nodes.indexOf(target.seq)
  const endSeq = nodes[nodes.length - 1]
  if (startIdx === -1 || endSeq === undefined) {
    return report({
      ok: false,
      stage: 'precheck',
      reason: REASONS.targetMissing,
      detail: 'the clicked message is no longer part of the surface',
    })
  }
  const shadowed = nodes.slice(startIdx)
  // The framework protects a system/message at node 0 and would reject the append.
  if (startIdx === 0 && eventAt(session, nodes[0])?.type === 'system/message') {
    return report({
      ok: false,
      stage: 'precheck',
      reason: REASONS.protectedHead,
      detail: 'the first surface node holds the system prompt and cannot be replaced',
    })
  }

  const targetTurn = target.turn
  let inspected = { complete: true, turns: [] }
  if (targetTurn !== undefined) {
    try {
      inspected = await store.inspect(session.id, targetTurn)
    } catch (error) {
      logger.warn?.(`session-rollback: snapshots of session "${session.id}" are unreadable: ${messageOf(error)}`)
      inspected = { complete: false, turns: [] }
    }
  }

  let replacement
  try {
    replacement = session.append(
      'developer/message',
      {
        // The node projects to no message, so its turn/step only carry the
        // position it closed; the target turn is the closest truthful value.
        turn: target.turn ?? 0,
        step: 1,
        message: replacementMessage(),
      },
      {
        surfaceOp: { op: 'replace', startSeq: target.seq, endSeq },
        sourceEventSeqs: shadowed,
      },
    )
  } catch (error) {
    return report({
      ok: false,
      stage: 'surface',
      reason: REASONS.surfaceRejected,
      detail: messageOf(error),
      conversation: { startSeq: target.seq, endSeq, shadowedNodes: shadowed.length, replacementSeq: null, flushed: false },
      target: summarizeTarget(target),
    })
  }

  const after = surfaceNodes(session)
  const effective = after.length > 0
    && after[after.length - 1] === replacement.seq
    && !after.includes(target.seq)
  let flushed = true
  try {
    await ctx.sessions.flush(session)
  } catch (error) {
    flushed = false
    logger.warn?.(`session-rollback: the replacement is committed but the checkpoint failed: ${messageOf(error)}`)
  }
  const conversation = {
    startSeq: target.seq,
    endSeq,
    shadowedNodes: shadowed.length,
    replacementSeq: replacement.seq,
    flushed,
  }
  if (!effective) {
    // The event was accepted by the log but did not shadow the range; restoring
    // files now would leave the conversation intact and the workspace reverted.
    return report({
      ok: false,
      stage: 'surface',
      reason: REASONS.surfaceNoEffect,
      detail: 'the appended replacement did not change the visible surface',
      conversation,
      target: summarizeTarget(target),
    })
  }

  const files = targetTurn === undefined
    ? { turns: [], restored: [], deleted: [], skipped: [], failed: [], untracked: true }
    : await restoreFiles({ ctx, store, recorder, sessionId: session.id, fromTurn: targetTurn })

  const filesFailed = files.failed.length > 0
  const incompleteTurns = inspected.turns.filter((turn) => turn.complete !== true)
  const complete = !filesFailed && inspected.complete === true
  return report({
    ok: !filesFailed,
    stage: filesFailed ? 'files' : 'done',
    reason: filesFailed
      ? REASONS.fileRestoreIncomplete
      : (complete ? REASONS.rolledBack : REASONS.partialSnapshot),
    detail: filesFailed
      ? `${files.failed.length} file(s) could not be restored`
      : (complete ? null : 'some captured turns are incomplete, so those files may not be fully restored'),
    conversation,
    target: summarizeTarget(target),
    files,
    incompleteTurns,
    complete,
    writeBack: { text: target.text, nonTextParts: target.nonTextParts },
  })
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
