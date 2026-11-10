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
 * never confirmed leaves nothing behind once the request settles or times out.
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
   * @type {Map<string, { promise: Promise<ApprovalDecision>, resolve: (decision: ApprovalDecision) => void, timer: ReturnType<typeof setTimeout>, sessionId: string, createdAt: number }>}
   */
  const waiting = new Map();

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
   * @param {{ runId: string, sessionId: string }} request
   * @returns {Promise<ApprovalDecision>} settles exactly once
   */
  function request({ runId, sessionId }) {
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
      resolveDecision(decision);
    };
    const timer = setTimeout(() => {
      const entry = waiting.get(runId);
      if (entry === undefined) return;
      waiting.delete(runId);
      logger.warn?.(`zcode-workflow: run ${runId} was not confirmed in time and counts as rejected`);
      resolveDecision({ decision: 'deny', optionId: 'deny', reason: notConfirmed() });
    }, timeoutMs);
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref();
    waiting.set(runId, {
      promise,
      resolve: settle,
      timer,
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      createdAt: Date.now(),
    });
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
    entry.resolve(decision);
    return decision;
  }

  /**
   * Runs currently waiting for an answer, scoped to one Session when given.
   * @param {string} [sessionId]
   * @returns {{ runId: string, createdAt: number }[]}
   */
  function list(sessionId) {
    const rows = [];
    for (const [runId, entry] of waiting) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      rows.push({ runId, createdAt: entry.createdAt });
    }
    return rows;
  }

  /**
   * Abandon one request (the run was stopped or superseded before the user answered).
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
  }

  return { request, settle, list, cancel, dispose };
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
