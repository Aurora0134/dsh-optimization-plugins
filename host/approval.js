/**
 * Launch-confirmation broker.
 *
 * ZCode asks the user before a workflow script runs: the tool call blocks on a permission dialog
 * that shows the phases, the script and the two adjustable settings, and the answer decides whether
 * the run starts. The Harness has no per-tool confirmation channel for plugin tools, so this port
 * splits that one blocking question into a broker: the tool registers a request, the browser answers
 * it through the plugin's own route, and the tool resumes with the same vocabulary the dialog uses
 * (`allow_once` / `allow_session` / `deny` / `workflowRefine`).
 *
 * The broker holds no run state — it only hands one answer to one waiting call — so a run that is
 * never confirmed leaves nothing behind once the request settles or times out. What it does hold is
 * the question itself (`payload`), because the run catalogue serves pending launches from here: a
 * launch awaiting confirmation has no journal, and a surface that only reads the journal could not
 * show it.
 */

/** Answers the dialog can produce, mirroring ZCode's option ids. */
export const APPROVAL_OPTIONS = ['allow_once', 'allow_session', 'deny', 'workflowRefine'];

/** Default wait: long enough for a user to read the script, short enough to free a tool call. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * @typedef {object} ApprovalDecision
 * @property {'allow' | 'deny'} decision resolved outcome the tool acts on
 * @property {string} optionId the dialog option the user picked
 * @property {string} [reason] rejection reason, or the revision text for `workflowRefine`
 * @property {string} [reasonSource] `workflow_refine_feedback` when the user asked for changes
 * @property {{ subagentModel?: string, maxConcurrency?: number }} [adjustments] edited settings
 */

/**
 * Create one broker.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs] how long one request waits before it settles as a rejection
 * @param {{ warn?: Function, info?: Function }} [options.logger]
 */
export function createApprovalBroker({ timeoutMs = DEFAULT_TIMEOUT_MS, logger = console } = {}) {
  /**
   * One waiting question per run id: a run is confirmed at most once, and a second submit for the
   * same run (a double click, two open surfaces) must not queue a second answer.
   * @type {Map<string, { promise: Promise<ApprovalDecision>, resolve: (decision: ApprovalDecision) => void, timer: ReturnType<typeof setTimeout>, sessionId: string, toolName: string, toolCallId: string, payload: unknown, createdAt: number, detach: () => void }>}
   */
  const waiting = new Map();

  /**
   * Session-wide grants: a Session that chose "allow for this session" answers for its own later
   * launches of the same tool, which is what the dialog promises. Nothing here outlives the
   * plugin process — the durable choice in ZCode is a session permission rule, and the port has no
   * per-session rule store to write to.
   * @type {Map<string, Set<string>>}
   */
  const sessionGrants = new Map();

  /**
   * @param {string} sessionId
   * @param {string} toolName
   * @returns {boolean} whether this Session already answered "allow for this session"
   */
  function allowsSession(sessionId, toolName) {
    const granted = sessionGrants.get(sessionId);
    return granted !== undefined && granted.has(toolName);
  }

  /**
   * @param {string} sessionId
   * @param {string} toolName
   */
  function grantSession(sessionId, toolName) {
    const granted = sessionGrants.get(sessionId);
    if (granted === undefined) sessionGrants.set(sessionId, new Set([toolName]));
    else granted.add(toolName);
  }

  /**
   * Drop one Session's grants (its launch policy changed or the Session ended).
   * @param {string} sessionId
   */
  function revokeSession(sessionId) {
    sessionGrants.delete(sessionId);
  }

  /**
   * Turn one dialog answer into the decision the tool consumes.
   * A revision request is a rejection carrying the user's text, exactly as ZCode records it.
   * @param {string} optionId
   * @param {{ reason?: unknown, adjustments?: unknown }} [payload]
   * @returns {ApprovalDecision}
   */
  function toDecision(optionId, payload = {}) {
    const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
    const adjustments = readAdjustments(payload.adjustments);
    if (optionId === 'workflowRefine') {
      return {
        decision: 'deny',
        optionId,
        reason,
        reasonSource: 'workflow_refine_feedback',
        ...(adjustments === undefined ? {} : { adjustments }),
      };
    }
    if (optionId === 'deny') {
      return {
        decision: 'deny',
        optionId,
        reason: reason.length > 0 ? reason : deniedByUser(),
        ...(adjustments === undefined ? {} : { adjustments }),
      };
    }
    return {
      decision: 'allow',
      optionId,
      ...(reason.length === 0 ? {} : { reason }),
      ...(adjustments === undefined ? {} : { adjustments }),
    };
  }

  /**
   * Ask the user to confirm one run launch.
   *
   * `signal` is the tool call's own cancellation: when the call stops waiting — the user aborts the
   * turn, the program that dispatched it hits its deadline — the question stops waiting with it, so
   * no surface keeps offering an answer the caller will never read. `payload` is the question as the
   * dialog shows it; the broker never reads inside it.
   *
   * @param {object} request
   * @param {string} request.runId
   * @param {string} request.sessionId
   * @param {string} [request.toolName]
   * @param {string} [request.toolCallId] the tool call that asked, so a card can match its own run
   * @param {unknown} [request.payload] the launch as the confirmation dialog renders it
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<ApprovalDecision>} settles exactly once
   */
  function request({ runId, sessionId, toolName, toolCallId, payload, signal }) {
    if (typeof runId !== 'string' || runId.length === 0) {
      return Promise.reject(new Error('zcode-workflow: an approval request needs a run id'));
    }
    const existing = waiting.get(runId);
    if (existing !== undefined) return existing.promise;
    let resolveDecision;
    const promise = new Promise((resolve) => {
      resolveDecision = resolve;
    });
    const settle = (decision) => {
      const entry = waiting.get(runId);
      if (entry === undefined) return;
      waiting.delete(runId);
      clearTimeout(entry.timer);
      entry.detach();
      resolveDecision(decision);
    };
    const timer = setTimeout(() => {
      const entry = waiting.get(runId);
      if (entry === undefined) return;
      waiting.delete(runId);
      entry.detach();
      logger.warn?.(`zcode-workflow: run ${runId} was not confirmed in time and counts as rejected`);
      resolveDecision({ decision: 'deny', optionId: 'deny', reason: notConfirmed() });
    }, timeoutMs);
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref();

    /** @type {() => void} */
    let detach = () => {};
    if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
      const onAbort = () => cancel(runId, cancelledByCaller());
      signal.addEventListener('abort', onAbort, { once: true });
      detach = () => signal.removeEventListener('abort', onAbort);
    }
    waiting.set(runId, {
      promise,
      resolve: settle,
      timer,
      detach,
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      toolName: typeof toolName === 'string' ? toolName : '',
      toolCallId: typeof toolCallId === 'string' ? toolCallId : '',
      payload,
      createdAt: Date.now(),
    });
    if (signal?.aborted === true) cancel(runId, cancelledByCaller());
    return promise;
  }

  /**
   * Answer one waiting request.
   * @param {{ runId: string, optionId: string, reason?: unknown, adjustments?: unknown }} answer
   * @returns {ApprovalDecision | undefined} the decision applied, or undefined when nothing waited
   */
  function settle({ runId, optionId, reason, adjustments }) {
    const entry = typeof runId === 'string' ? waiting.get(runId) : undefined;
    if (entry === undefined) return undefined;
    if (!APPROVAL_OPTIONS.includes(optionId)) {
      throw new Error(`zcode-workflow: unknown confirmation option "${String(optionId)}"`);
    }
    const decision = toDecision(optionId, { reason, adjustments });
    if (optionId === 'allow_session' && entry.toolName.length > 0) {
      grantSession(entry.sessionId, entry.toolName);
    }
    entry.resolve(decision);
    return decision;
  }

  /**
   * Launches currently waiting for an answer, scoped to one Session when given. The payload comes
   * back untouched so the caller decides what a pending launch looks like on its own surface.
   * @param {string} [sessionId]
   * @returns {{ runId: string, sessionId: string, toolName: string, toolCallId: string, createdAt: number, payload: unknown }[]}
   */
  function list(sessionId) {
    const rows = [];
    for (const [runId, entry] of waiting) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      rows.push({
        runId,
        sessionId: entry.sessionId,
        toolName: entry.toolName,
        toolCallId: entry.toolCallId,
        createdAt: entry.createdAt,
        payload: entry.payload,
      });
    }
    rows.sort((left, right) => left.createdAt - right.createdAt);
    return rows;
  }

  /**
   * Abandon one request (the run was stopped, superseded or its tool call cancelled before the user
   * answered).
   * @param {string} runId
   * @param {string} [reason]
   */
  function cancel(runId, reason) {
    const entry = waiting.get(runId);
    if (entry === undefined) return;
    entry.resolve({ decision: 'deny', optionId: 'deny', reason: reason ?? notConfirmed() });
  }

  /** Drop every waiter — plugin teardown must not leave tool calls hanging. */
  function dispose() {
    for (const runId of [...waiting.keys()]) cancel(runId);
    sessionGrants.clear();
  }

  return { request, settle, list, cancel, dispose, allowsSession, grantSession, revokeSession };
}

/**
 * Accept only the two adjustable settings the dialog can edit.
 * @param {unknown} raw
 * @returns {{ subagentModel?: string, maxConcurrency?: number } | undefined}
 */
function readAdjustments(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = /** @type {Record<string, unknown>} */ (raw);
  const model = typeof record.subagentModel === 'string' ? record.subagentModel.trim() : '';
  const limit = record.maxConcurrency;
  const maxConcurrency = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;
  if (model.length === 0 && maxConcurrency === undefined) return undefined;
  return {
    ...(model.length === 0 ? {} : { subagentModel: model }),
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
  };
}

/** Rejection text used when the user closes the dialog without choosing anything. */
function notConfirmed() {
  return 'The workflow was not confirmed, so it did not run. Ask the user whether to run it, and with what changes.';
}

/** Rejection text used when the user explicitly declines. */
function deniedByUser() {
  return "The user doesn't want to run this workflow. Do not start it again unless they ask for it; wait for them to say how to proceed.";
}

/** Rejection text used when the answering surface went away before the user answered. */
function cancelledByCaller() {
  return 'The workflow was not confirmed in this turn, so it did not run. Ask the user whether to run it; a new confirmation follows the next launch.';
}
