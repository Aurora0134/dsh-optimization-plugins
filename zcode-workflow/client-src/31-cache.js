/* Shared run channel for the tool cards.
 *
 * Every workflow card needs the run it launched, and a transcript can hold many of them. Polling
 * per card would multiply requests by the number of visible cards, so this part owns the only
 * timers in the card layer:
 *
 *   one tick    every `WF_CARDS_POLL_MS` (never faster), coalescing every subscriber into
 *               one `/runs` request per Session and one `/run` request per live run;
 *   one cache   a snapshot object per (Session, run) that a card re-renders from; an unchanged
 *               payload keeps the previous snapshot, so a quiet run does not re-render a card;
 *   one pause   a hidden page issues no requests at all and refreshes right after it returns.
 *
 * The run shapes of the four data sources differ (ZCode run snapshot, Host run snapshot, Host run
 * summary, resume/stop reply), so the readers below accept all of them and never invent a field.
 */

/** Minimum poll interval; the cards never ask faster than this. */
const WF_CARDS_POLL_MS = 1500;
/** How many runs one Session listing asks for; one card never needs more. */
const WF_CARD_RUN_LIMIT = 20;
/** A settled run is fetched once, then only on demand. */
const WF_CARD_TERMINAL = new Set(['completed', 'errored', 'stopped', 'superseded', 'cancelled']);

/** Subscribers, cache and the single timer of the run channel. */
const WF_RUN_CHANNEL = {
  /** @type {Map<string, Set<(snapshot: object) => void>>} key -> listeners */
  listeners: new Map(),
  /** @type {Map<string, object>} key -> snapshot */
  snapshots: new Map(),
  /** @type {Map<string, object>} Session id -> last listing */
  sessions: new Map(),
  /** @type {Map<string, object>} run key -> last run fetch bookkeeping */
  runs: new Map(),
  timer: 0,
  busy: false,
  wanted: false,
};

/** The cache key of one run, or of a Session when no run is known yet. */
function wfRunKey(sessionId, runId) {
  return `${sessionId ?? ''}\u0000${runId ?? ''}`;
}

/** A snapshot the subscribers can compare by identity. */
function wfRunSnapshot(sessionId, runId, patch) {
  const key = wfRunKey(sessionId, runId);
  const previous = WF_RUN_CHANNEL.snapshots.get(key) ?? {
    sessionId,
    runId,
    run: undefined,
    summary: undefined,
    runs: [],
    truncated: false,
    error: undefined,
  };
  const next = { ...previous, ...patch };
  WF_RUN_CHANNEL.snapshots.set(key, next);
  return next;
}

/** Tell every subscriber of one key what the channel now holds. */
function wfRunNotify(sessionId, runId) {
  const exact = WF_RUN_CHANNEL.listeners.get(wfRunKey(sessionId, runId));
  const snapshot = WF_RUN_CHANNEL.snapshots.get(wfRunKey(sessionId, runId));
  if (exact !== undefined && snapshot !== undefined) {
    for (const listener of exact) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('zcode-workflow: card subscriber failed', error);
      }
    }
  }
  const session = WF_RUN_CHANNEL.listeners.get(wfRunKey(sessionId, undefined));
  const sessionSnapshot = WF_RUN_CHANNEL.snapshots.get(wfRunKey(sessionId, undefined));
  if (session !== undefined && sessionSnapshot !== undefined) {
    for (const listener of session) {
      try {
        listener(sessionSnapshot);
      } catch (error) {
        console.warn('zcode-workflow: card subscriber failed', error);
      }
    }
  }
}

/** Stable comparison for a fetched payload; a quiet run must not re-render its card. */
function wfRunSame(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/* --------------------------------- the tick -------------------------------- */

/** Ask the Host for one Session's run catalog. */
async function wfRunFetchList(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return;
  const state = WF_RUN_CHANNEL.sessions.get(sessionId) ?? { at: 0, busy: false };
  if (state.busy === true) return;
  WF_RUN_CHANNEL.sessions.set(sessionId, { ...state, busy: true });
  try {
    const payload = await WF_API.runs({ sessionId, limit: WF_CARD_RUN_LIMIT });
    const runs = Array.isArray(payload?.runs) ? payload.runs : Array.isArray(payload) ? payload : [];
    const truncated = payload?.truncated === true;
    WF_RUN_CHANNEL.sessions.set(sessionId, { at: Date.now(), busy: false, runs });
    const before = WF_RUN_CHANNEL.snapshots.get(wfRunKey(sessionId, undefined));
    if (before === undefined || !wfRunSame(runs, before.runs) || before.truncated !== truncated || before.error !== undefined) {
      wfRunSnapshot(sessionId, undefined, { runs, truncated, error: undefined });
      wfRunNotify(sessionId, undefined);
    }
    // Every run-keyed subscriber of this Session also sees the listing.
    for (const [key, entry] of WF_RUN_CHANNEL.runs) {
      if (entry.sessionId !== sessionId) continue;
      const summary = runs.find((row) => wfRunId(row) === entry.runId);
      if (summary === undefined) continue;
      const before = WF_RUN_CHANNEL.snapshots.get(key);
      if (before === undefined || !wfRunSame(summary, before.summary)) {
        wfRunSnapshot(sessionId, entry.runId, { summary });
        wfRunNotify(sessionId, entry.runId);
      }
    }
  } catch (error) {
    WF_RUN_CHANNEL.sessions.set(sessionId, { at: Date.now(), busy: false, runs: state.runs });
    wfRunSnapshot(sessionId, undefined, { error: wfRunErrorText(error) });
    wfRunNotify(sessionId, undefined);
  }
}

/** Ask the Host for one run snapshot. */
async function wfRunFetchRun(sessionId, runId) {
  const key = wfRunKey(sessionId, runId);
  const entry = WF_RUN_CHANNEL.runs.get(key) ?? { sessionId, runId, at: 0, busy: false };
  if (entry.busy === true) return;
  WF_RUN_CHANNEL.runs.set(key, { ...entry, busy: true });
  try {
    const run = await wfRunRequest(sessionId, runId);
    WF_RUN_CHANNEL.runs.set(key, { sessionId, runId, at: Date.now(), busy: false, terminal: WF_CARD_TERMINAL.has(wfRunStatus(run)) });
    const before = WF_RUN_CHANNEL.snapshots.get(key);
    if (before === undefined || !wfRunSame(run, before.run)) {
      wfRunSnapshot(sessionId, runId, { run, error: undefined });
      wfRunNotify(sessionId, runId);
    } else if (before.error !== undefined) {
      wfRunSnapshot(sessionId, runId, { error: undefined });
      wfRunNotify(sessionId, runId);
    }
  } catch (error) {
    WF_RUN_CHANNEL.runs.set(key, { sessionId, runId, at: Date.now(), busy: false });
    const before = WF_RUN_CHANNEL.snapshots.get(key);
    // A 404 before the run is registered is normal for a card that is still streaming.
    const message = wfRunErrorText(error);
    if (before === undefined || before.error !== message) {
      wfRunSnapshot(sessionId, runId, { error: message });
      wfRunNotify(sessionId, runId);
    }
  }
}

/** One run snapshot request, tolerant of the route set the Host currently registers. */
async function wfRunRequest(sessionId, runId) {
  if (typeof WF_API !== 'object' || WF_API === null) throw new Error('workflow data channel unavailable');
  if (typeof WF_API.run === 'function') {
    const payload = await WF_API.run({ sessionId, runId });
    return payload?.run ?? payload;
  }
  if (typeof WF_API.get === 'function') {
    const payload = await WF_API.get('/run', { sessionId, runId });
    return payload?.run ?? payload;
  }
  throw new Error('workflow data channel unavailable');
}

/** One console-safe failure line; the card shows nothing for a transient miss. */
function wfRunErrorText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') {
    return error.message;
  }
  return String(error);
}

/* ------------------------------ scheduling --------------------------------- */

/** The page is hidden: polling pauses and resumes on return. */
function wfRunVisible() {
  if (typeof document === 'undefined') return true;
  return document.hidden !== true && document.visibilityState !== 'hidden';
}

/** One scheduling pass over every subscriber; at most one request per target. */
function wfRunChannelPass() {
  if (WF_RUN_CHANNEL.wanted !== true || WF_RUN_CHANNEL.busy === true) return;
  if (!wfRunVisible()) return;
  const now = Date.now();
  const sessions = new Set();
  const runs = new Map();
  for (const key of WF_RUN_CHANNEL.listeners.keys()) {
    const snapshot = WF_RUN_CHANNEL.snapshots.get(key);
    const sessionId = snapshot?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') continue;
    sessions.add(sessionId);
    if (typeof snapshot.runId === 'string' && snapshot.runId !== '') runs.set(key, snapshot);
  }
  for (const sessionId of sessions) {
    const state = WF_RUN_CHANNEL.sessions.get(sessionId);
    if (state !== undefined && state.busy === true) continue;
    if (state === undefined || now - (state.at ?? 0) >= WF_CARDS_POLL_MS) wfRunFetchList(sessionId);
  }
  for (const [key, snapshot] of runs) {
    const entry = WF_RUN_CHANNEL.runs.get(key);
    if (entry !== undefined && entry.busy === true) continue;
    const terminal = entry?.terminal === true && snapshot.run !== undefined;
    if (terminal) continue;
    if (entry === undefined || now - (entry.at ?? 0) >= WF_CARDS_POLL_MS) wfRunFetchRun(snapshot.sessionId, snapshot.runId);
  }
}

/** Start the timer; the client entry disposes it with the registration. */
function wfRunChannelStart() {
  if (WF_RUN_CHANNEL.timer !== 0) return () => {};
  const tick = () => {
    wfRunChannelPass();
    WF_RUN_CHANNEL.timer = setTimeout(tick, WF_CARDS_POLL_MS);
  };
  WF_RUN_CHANNEL.timer = setTimeout(tick, WF_CARDS_POLL_MS);
  if (typeof document !== 'undefined') {
    const onVisible = () => {
      if (!wfRunVisible()) return;
      for (const entry of WF_RUN_CHANNEL.sessions.values()) entry.at = 0;
      for (const entry of WF_RUN_CHANNEL.runs.values()) entry.at = 0;
      wfRunChannelPass();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (WF_RUN_CHANNEL.timer !== 0) clearTimeout(WF_RUN_CHANNEL.timer);
      WF_RUN_CHANNEL.timer = 0;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }
  return () => {
    if (WF_RUN_CHANNEL.timer !== 0) clearTimeout(WF_RUN_CHANNEL.timer);
    WF_RUN_CHANNEL.timer = 0;
  };
}

/** Look one snapshot up without subscribing. */
function wfRunChannelSnapshot(sessionId, runId) {
  const key = wfRunKey(sessionId, runId);
  const existing = WF_RUN_CHANNEL.snapshots.get(key);
  if (existing !== undefined) return existing;
  return wfRunSnapshot(sessionId, runId, {});
}

/**
 * Subscribe one card to its run (or to its Session when the card has no run yet).
 * @returns {() => void} unsubscribe
 */
function wfRunChannelSubscribe(sessionId, runId, listener) {
  if (typeof sessionId !== 'string' || sessionId === '') return () => {};
  const key = wfRunKey(sessionId, runId);
  wfRunChannelSnapshot(sessionId, runId);
  const set = WF_RUN_CHANNEL.listeners.get(key) ?? new Set();
  set.add(listener);
  WF_RUN_CHANNEL.listeners.set(key, set);
  WF_RUN_CHANNEL.wanted = true;
  // The first tick of a fresh subscriber is immediate, and independent of the poll interval.
  setTimeout(() => {
    if (!wfRunVisible()) return;
    if (typeof runId === 'string' && runId !== '') wfRunFetchRun(sessionId, runId);
    else wfRunFetchList(sessionId);
  }, 0);
  return () => {
    const current = WF_RUN_CHANNEL.listeners.get(key);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) WF_RUN_CHANNEL.listeners.delete(key);
  };
}

/** Re-render a card when its run snapshot changes. */
function useWfCardRun(model) {
  return useWfCardRunById(model?.sessionId, React.useMemo(() => wfCardResultRunId(model), [model]));
}

/** Subscribe one specific run (or Session) without knowing the card model. */
function useWfCardRunById(sessionId, runId) {
  const [snapshot, setSnapshot] = React.useState(() => wfRunChannelSnapshot(sessionId, runId));
  React.useEffect(() => {
    setSnapshot(wfRunChannelSnapshot(sessionId, runId));
    return wfRunChannelSubscribe(sessionId, runId, setSnapshot);
  }, [sessionId, runId]);
  return snapshot;
}

/** Drop the throttle of one run so the next pass re-reads it right away. */
function wfRunChannelRefresh(sessionId, runId) {
  if (typeof sessionId !== 'string' || sessionId === '') return;
  if (typeof runId === 'string' && runId !== '') {
    const key = wfRunKey(sessionId, runId);
    const entry = WF_RUN_CHANNEL.runs.get(key);
    if (entry !== undefined) WF_RUN_CHANNEL.runs.set(key, { ...entry, at: 0, terminal: false });
    wfRunFetchRun(sessionId, runId);
    return;
  }
  wfRunFetchList(sessionId);
}

/* ------------------------------- run readers ------------------------------- */

/** First present field of a run-shaped record. */
function wfRunField(run, ...names) {
  if (!wfCardRecord(run)) return undefined;
  for (const name of names) {
    if (run[name] !== undefined && run[name] !== null) return run[name];
  }
  return undefined;
}

/** Run id of any run shape. */
function wfRunId(run) {
  const value = wfRunField(run, 'id', 'runId', 'run_id');
  return typeof value === 'string' ? value : '';
}

/** Tool call that launched this run, when the Host exposes it. */
function wfRunToolCallId(run) {
  const value = wfRunField(run, 'toolCallId', 'tool_call_id', 'toolId');
  return typeof value === 'string' ? value : '';
}

/** Lifecycle status, with a superseded run reported as such. */
function wfRunStatus(run) {
  const status = wfRunField(run, 'status');
  if (typeof status === 'string' && status !== '') {
    if (status === 'stopped' && typeof wfRunField(run, 'stopReason', 'stop_reason') === 'string'
      && wfRunField(run, 'stopReason', 'stop_reason') === 'superseded') return 'superseded';
    return status;
  }
  return 'unknown';
}

/** Whether the run can still produce work. */
function wfRunIsActive(run) {
  const status = wfRunStatus(run);
  return status === 'pending' || status === 'running';
}

/** Display name; the run id is the last resort so a card never shows an empty name. */
function wfRunName(run) {
  const name = wfCardFirstText(wfRunField(run, 'name', 'label'), wfRunId(run));
  return name;
}

/** The subagent model the run reports. */
function wfRunSubagentModel(run) {
  const value = wfRunField(run, 'subagentModel', 'subagent_model', 'model');
  return typeof value === 'string' ? value : '';
}

/** Phase names in declared order, tolerating both the shape families. */
function wfRunPhaseNames(run) {
  const declared = wfRunField(run, 'phaseNames');
  if (Array.isArray(declared) && declared.length > 0) {
    return declared.filter((name) => typeof name === 'string' && name !== '');
  }
  const phases = wfRunField(run, 'phases', 'phasesDetail');
  if (!Array.isArray(phases)) return [];
  const names = [];
  for (const phase of phases) {
    const name = typeof phase === 'string' ? phase : wfCardFirstText(phase?.name, phase?.id);
    if (name !== '' && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Per-phase declared rounds, when the run records them. */
function wfRunPhaseRounds(run) {
  const phases = wfRunField(run, 'phases');
  const table = {};
  if (!Array.isArray(phases)) return table;
  for (const phase of phases) {
    if (!wfCardRecord(phase)) continue;
    const name = wfCardFirstText(phase.name, phase.id);
    const rounds = wfCardNum(phase.rounds ?? phase.visits);
    if (name !== '' && rounds !== undefined) table[name] = rounds;
  }
  return table;
}

/** Waiting holes by phase name. */
function wfRunHoles(run) {
  const holes = wfRunField(run, 'holes');
  if (!Array.isArray(holes)) return [];
  return holes.filter(wfCardRecord);
}

/** The phase the run is currently in. */
function wfRunCurrentPhase(run) {
  const current = wfRunField(run, 'currentPhase', 'current_phase');
  if (typeof current === 'string' && current !== '') return current;
  const active = wfRunField(run, 'phasesDetail');
  if (Array.isArray(active)) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const phase = active[index];
      if (wfCardRecord(phase) && phase.endedAt === undefined && typeof phase.name === 'string') return phase.name;
    }
  }
  return '';
}

/**
 * Station list for the timeline: one entry per declared phase with a derived status.
 * This is the client-side equivalent of the run detail's phase derivation, limited to the fields
 * the card actually receives.
 */
function wfRunStations(run) {
  const names = wfRunPhaseNames(run);
  const entered = new Set();
  const phases = wfRunField(run, 'phases', 'phasesDetail');
  if (Array.isArray(phases)) {
    for (const phase of phases) {
      if (typeof phase === 'string') entered.add(phase);
      else if (wfCardRecord(phase) && typeof phase.name === 'string') entered.add(phase.name);
    }
  }
  const current = wfRunCurrentPhase(run);
  const status = wfRunStatus(run);
  const active = wfRunIsActive(run);
  const waitingHoles = new Set(wfRunHoles(run).filter((hole) => hole.state !== 'filled').map((hole) => wfCardFirstText(hole.phase, hole.phaseName, hole.name)));
  const rounds = wfRunPhaseRounds(run);
  return names.map((name) => {
    const isCurrent = name === current;
    let state;
    if (active) state = isCurrent ? 'running' : entered.has(name) ? 'done' : 'pending';
    else if (status === 'completed') state = entered.has(name) ? 'done' : 'pending';
    else if (status === 'errored') state = isCurrent ? 'failed' : entered.has(name) ? 'done' : 'pending';
    else state = isCurrent ? 'pending' : entered.has(name) ? 'done' : 'pending';
    return {
      name,
      status: state,
      current: isCurrent,
      rounds: rounds[name],
      hole: waitingHoles.has(name) ? 'waiting' : undefined,
    };
  });
}

/**
 * Subagents of a run, unioned from the actor list and the Host agent tally.
 * A run snapshot can carry lanes that never landed as actors (and the reverse), so the card counts
 * and shows both lists; an actor row wins when the two describe the same subagent.
 */
function wfRunAgents(run) {
  const rows = new Map();
  const actors = wfRunField(run, 'actors');
  if (Array.isArray(actors)) {
    for (const [index, actor] of actors.entries()) {
      if (!wfCardRecord(actor)) continue;
      const name = wfCardFirstText(actor.name, actor.actorName, `${wfCardFirstText(actor.siteId)}@${wfCardNum(actor.ordinal) ?? index}`);
      if (name === '' || rows.has(name)) continue;
      rows.set(name, {
        name,
        status: wfCardFirstText(actor.status) || 'waiting',
        phaseName: wfCardFirstText(actor.phaseName),
        model: wfCardFirstText(actor.model),
        ordinal: wfCardNum(actor.ordinal) ?? index,
        siteId: wfCardFirstText(actor.siteId),
        sessionId: wfCardFirstText(actor.sessionId),
      });
    }
  }
  const agents = wfRunField(run, 'agents');
  if (Array.isArray(agents)) {
    for (const [index, agent] of agents.entries()) {
      if (!wfCardRecord(agent)) continue;
      const name = wfCardFirstText(agent.name, `#${index + 1}`);
      if (name === '' || rows.has(name)) continue;
      const asks = wfCardNum(agent.asks) ?? 0;
      const settled = wfCardNum(agent.settled) ?? 0;
      const failed = wfCardNum(agent.failed) ?? 0;
      rows.set(name, {
        name,
        status: asks > settled + failed ? 'running' : 'completed',
        phaseName: wfCardFirstText(agent.phaseName),
        model: wfCardFirstText(agent.model),
        ordinal: index,
        siteId: wfCardFirstText(agent.siteId),
        sessionId: wfCardFirstText(agent.sessionId),
      });
    }
  }
  return [...rows.values()];
}

/** `{age}` of a millisecond span, in the product's own short units. */
function wfCardAge(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 60000) return `${Math.floor(value / 1000)}s`;
  if (value < 3600000) return `${Math.floor(value / 60000)}m`;
  if (value < 86400000) return `${Math.floor(value / 3600000)}h`;
  return `${Math.floor(value / 86400000)}d`;
}

/** Questions a run is waiting on (`run.pendingQuestions`). */
function wfRunQuestions(run) {
  const list = wfRunField(run, 'pendingQuestions', 'pending_questions');
  if (!Array.isArray(list)) return [];
  return list.filter(wfCardRecord).map((entry) => ({
    qid: wfCardFirstText(entry.qid, entry.id, entry.questionId),
    question: wfCardFirstText(entry.question, entry.text),
    context: wfCardFirstText(entry.context),
    actorName: wfCardFirstText(entry.actorName, entry.actor_name),
    askedAt: wfCardNum(wfCardFirst(entry.askedAt, entry.asked_at)),
  }));
}

/** Artifact chips of a run. */
function wfRunArtifacts(run) {
  const artifacts = wfRunField(run, 'artifacts');
  if (!Array.isArray(artifacts)) return [];
  return artifacts.filter(wfCardRecord).map((artifact) => {
    const title = wfCardFirstText(artifact.title, artifact.name, artifact.id, artifact.artifactId);
    return {
      id: wfCardFirstText(artifact.id, artifact.artifactId, artifact.artifact_id),
      title,
      kind: wfCardFirstText(artifact.kind, artifact.type) || 'file',
      version: wfCardNum(artifact.version) ?? 1,
    };
  });
}

/** Step tallies for the card footer. */
function wfRunSteps(run) {
  const steps = wfRunField(run, 'steps');
  if (wfCardRecord(steps)) {
    const started = wfCardNum(steps.started) ?? 0;
    const settled = wfCardNum(steps.settled) ?? 0;
    const failed = wfCardNum(steps.failed) ?? 0;
    const running = wfCardNum(steps.running) ?? 0;
    return { total: started, done: settled + failed, failed, running };
  }
  const nodes = wfRunField(run, 'nodes');
  if (!Array.isArray(nodes)) return { total: 0, done: 0, failed: 0, running: 0 };
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const node of nodes) {
    if (!wfCardRecord(node)) continue;
    if (node.phase === 'settled') {
      if (node.outcome === 'failed') failed += 1;
      else done += 1;
    } else {
      running += 1;
    }
  }
  return { total: nodes.length, done: done + failed, failed, running };
}

/** Tokens spent by the run, from the run snapshot or its summary. */
function wfRunTokens(run, summary) {
  const direct = wfCardNum(wfRunField(run, 'spentTokens', 'spent_tokens'));
  if (direct !== undefined) return direct;
  const usage = wfRunField(run, 'usage');
  const nested = wfCardNum(wfCardRecord(usage) ? usage.spentTokens ?? usage.spent_tokens ?? usage.tokens : undefined);
  if (nested !== undefined) return nested;
  const fromSummary = wfCardNum(wfRunField(summary, 'spentTokens', 'spent_tokens'));
  return fromSummary ?? 0;
}

/** Highest phase round the run reached; the card only shows it past the first round. */
function wfRunMaxRound(run) {
  const rounds = wfRunPhaseRounds(run);
  let max = 0;
  for (const value of Object.values(rounds)) if (value > max) max = value;
  const direct = wfCardNum(wfRunField(run, 'rounds', 'round'));
  if (direct !== undefined && direct > max) max = direct;
  return max;
}

/** Run duration in the detail's wording, for the card footer when both clocks exist. */
function wfRunElapsed(run) {
  const from = wfCardNum(wfRunField(run, 'createdAt', 'startedAt', 'created_at'));
  const to = wfCardNum(wfRunField(run, 'finishedAt', 'endedAt', 'finished_at')) ?? Date.now();
  if (from === undefined) return '';
  return WF_UI.duration(from, to);
}

/**
 * The run this card is waiting on a launch decision for, when one exists.
 * A card only offers the inline confirmation while its call is still in flight, and only for the
 * tools that launch a run.
 */
function wfCardPendingRun(model, live) {
  if (model === undefined || live === undefined) return undefined;
  if (model.key !== 'CreateWorkflow' && model.key !== 'AmendWorkflow' && model.key !== 'FillWorkflowHole') return undefined;
  if (model.phase === 'result' && model.failed === true) return undefined;
  const surface = wfCardSurface('permission');
  if (surface === undefined || typeof surface.Block !== 'function') return undefined;
  const sessionId = typeof model.sessionId === 'string' ? model.sessionId : undefined;
  if (sessionId === undefined) return undefined;
  const candidates = [];
  if (wfRunStatus(live.run) === 'pending') candidates.push(live.run);
  if (wfRunStatus(live.summary) === 'pending') candidates.push(live.summary);
  const runs = Array.isArray(live.runs) ? live.runs : [];
  if (model.toolId !== undefined) {
    for (const row of runs) {
      if (wfRunToolCallId(row) === model.toolId && wfRunStatus(row) === 'pending') candidates.push(row);
    }
  }
  if (candidates.length === 0 && model.approval !== undefined && model.approval !== false && model.approval !== null) {
    for (const row of runs) if (wfRunStatus(row) === 'pending') candidates.push(row);
  }
  const found = candidates.find((row) => wfRunId(row) !== '');
  if (found === undefined) return undefined;
  return { sessionId, run: found };
}
