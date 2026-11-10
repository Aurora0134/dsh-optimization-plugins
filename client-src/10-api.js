/*
 * Browser data channel: the same-origin JSON routes registered by host/ui-api.js.
 *
 * The route names mirror ZCode 3.17.2's workflow RPC surface one-for-one (run list, run events,
 * run artifacts, artifact data chunks, artifact byte reads, world-operation workspace, node
 * results, saved-workflow catalogue and the dynamic-workflow policy), so a reader who knows the
 * desktop contract can find the same call here. Every read is scoped by the Session the surface is
 * mounted in; nothing takes a project path from the caller.
 */

const WF_API = (() => {
  const BASE = '/zcode-workflow';

  /**
   * Encode one query object, dropping absent values so optional parameters stay absent.
   * @param {Record<string, unknown>} params
   * @returns {string} the `?a=b` suffix, or an empty string.
   */
  function query(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const text = search.toString();
    return text === '' ? '' : `?${text}`;
  }

  /**
   * @param {Response} response
   * @returns {Promise<unknown>} parsed JSON body, or undefined for a non-JSON body.
   */
  async function readJson(response) {
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) return undefined;
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  /**
   * @param {string} path
   * @param {RequestInit} [options]
   * @returns {Promise<any>}
   */
  async function request(path, options) {
    const response = await fetch(BASE + path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
    });
    const payload = await readJson(response);
    if (!response.ok) {
      const message = payload && typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.code = payload && typeof payload.code === 'string' ? payload.code : undefined;
      throw error;
    }
    return payload;
  }

  function get(path, params) {
    return request(path + query(params), { method: 'GET' });
  }

  function post(path, body) {
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  /* ------------------------------ run data plane ----------------------------- */

  /** Session run list, newest first (`conversationWorkflowRuns`). */
  function runs(scope) {
    return get('/runs', { sessionId: scope.sessionId, limit: scope.limit });
  }

  /** Append-only run events after one sequence (`conversationWorkflowRunEvents`). */
  function runEvents(scope) {
    return get('/run/events', {
      sessionId: scope.sessionId,
      runId: scope.runId,
      afterSequence: scope.afterSequence,
      limit: scope.limit,
    });
  }

  /** Artifact ledger of one run (`conversationWorkflowRunArtifacts`). */
  function runArtifacts(scope) {
    return get('/run/artifacts', { sessionId: scope.sessionId, runId: scope.runId });
  }

  /** Artifact board entries after one sequence (`conversationWorkflowRunArtifactData`). */
  function artifactData(scope) {
    return get('/artifact/data', {
      sessionId: scope.sessionId,
      runId: scope.runId,
      artifactId: scope.artifactId,
      afterSequence: scope.afterSequence,
      limit: scope.limit,
      fields: scope.fields === undefined ? undefined : scope.fields.join(','),
    });
  }

  /** One base64 chunk of artifact bytes (`conversationWorkflowRunArtifactRead`). */
  function artifactRead(scope) {
    return get('/artifact/read', {
      sessionId: scope.sessionId,
      runId: scope.runId,
      artifactId: scope.artifactId,
      version: scope.version,
      offset: scope.offset,
      limit: scope.limit,
    });
  }

  /** World-operation ledger of one run (`conversationWorkflowRunWorkspace`). */
  function runWorkspace(scope) {
    return get('/run/workspace', { sessionId: scope.sessionId, runId: scope.runId });
  }

  /** One node's recorded result (`conversationWorkflowRunNodeResult`). */
  function runNode(scope) {
    return get('/run/node', {
      sessionId: scope.sessionId,
      runId: scope.runId,
      siteId: scope.siteId,
      ordinal: scope.ordinal,
      maxBytes: scope.maxBytes,
    });
  }

  /* ----------------------------- run interaction ---------------------------- */

  /** Answer the launch confirmation of one pending run. */
  function approveRun(scope) {
    return post('/run/approve', scope);
  }

  function stopRun(scope) {
    return post('/run/stop', scope);
  }

  function resumeRun(scope) {
    return post('/run/resume', scope);
  }

  function fillHole(scope) {
    return post('/run/fill', scope);
  }

  function answerQuestion(scope) {
    return post('/run/answer', scope);
  }

  /* --------------------------- saved workflow catalogue -------------------------- */

  function workflows(scope) {
    return get('/workflows/list', { projectRoot: scope.projectRoot, scope: scope.scope });
  }

  function workflow(scope) {
    return get('/workflows/get', {
      projectRoot: scope.projectRoot,
      name: scope.name,
      scope: scope.scope,
    });
  }

  function saveWorkflow(scope) {
    return post('/workflows/save', scope);
  }

  function deleteWorkflow(scope) {
    return post('/workflows/delete', scope);
  }

  function moveWorkflow(scope) {
    return post('/workflows/move', scope);
  }

  function updateWorkflowMeta(scope) {
    return post('/workflows/updateMeta', scope);
  }

  function workflowRuns(scope) {
    return get('/workflows/runs', {
      projectRoot: scope.projectRoot,
      name: scope.name,
      scope: scope.scope,
      limit: scope.limit,
    });
  }

  function workflowForRun(scope) {
    return get('/workflows/forRun', {
      projectRoot: scope.projectRoot,
      runId: scope.runId,
      candidates: scope.candidates === undefined ? undefined : scope.candidates.join(','),
    });
  }

  /* --------------------------------- policy ---------------------------------- */

  function policy(scope) {
    return get('/policy', { projectRoot: scope.projectRoot });
  }

  function setPolicy(scope) {
    return post('/policy', { projectRoot: scope.projectRoot, enabled: scope.enabled, mode: scope.mode });
  }

  return {
    get,
    post,
    runs,
    runEvents,
    runArtifacts,
    artifactData,
    artifactRead,
    runWorkspace,
    runNode,
    approveRun,
    stopRun,
    resumeRun,
    fillHole,
    answerQuestion,
    workflows,
    workflow,
    saveWorkflow,
    deleteWorkflow,
    moveWorkflow,
    updateWorkflowMeta,
    workflowRuns,
    workflowForRun,
    policy,
    setPolicy,
  };
})();
