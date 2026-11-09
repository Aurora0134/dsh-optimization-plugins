/* Host data channel: same-origin JSON routes registered by host/ui-api.js. */

const WF_API = (() => {
  const BASE = '/zcode-workflow';

  function query(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const text = search.toString();
    return text === '' ? '' : `?${text}`;
  }

  async function readJson(response) {
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) return undefined;
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

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

  /** One run list scoped to a session (or one validated project root). */
  function runs(scope) {
    return get('/runs', { sessionId: scope.sessionId, projectRoot: scope.projectRoot, limit: scope.limit });
  }

  /** One run snapshot. */
  function run(scope) {
    return get('/run', { sessionId: scope.sessionId, projectRoot: scope.projectRoot, runId: scope.runId });
  }

  function stopRun(scope) {
    return post('/run/stop', scope);
  }

  function fillHole(scope) {
    return post('/run/fill', scope);
  }

  function startRun(scope) {
    return post('/run/start', scope);
  }

  function workflows(scope) {
    return get('/workflows', { projectRoot: scope.projectRoot });
  }

  function deleteWorkflow(scope) {
    return post('/workflows/delete', scope);
  }

  function moveWorkflow(scope) {
    return post('/workflows/move', scope);
  }

  function mode() {
    return get('/mode');
  }

  function setMode(mode) {
    return post('/mode', { mode });
  }

  /** Absolute same-origin URL for one artifact payload. */
  function artifactUrl(scope) {
    return BASE + '/artifact' + query({
      sessionId: scope.sessionId,
      projectRoot: scope.projectRoot,
      runId: scope.runId,
      artifactId: scope.artifactId,
      version: scope.version,
    });
  }

  /** Text artifacts answer JSON; binary artifacts are served as bytes for `artifactUrl`. */
  function artifact(scope) {
    return get('/artifact', {
      sessionId: scope.sessionId,
      projectRoot: scope.projectRoot,
      runId: scope.runId,
      artifactId: scope.artifactId,
      version: scope.version,
    });
  }

  return {
    get,
    post,
    runs,
    run,
    stopRun,
    fillHole,
    startRun,
    workflows,
    deleteWorkflow,
    moveWorkflow,
    mode,
    setMode,
    artifactUrl,
    artifact,
  };
})();
