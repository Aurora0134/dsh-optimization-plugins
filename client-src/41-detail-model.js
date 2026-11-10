/*
 * View model for the run-detail surface: one run record (the Host's derived run summary) into the
 * shapes the panel, the timeline and the roster render.
 *
 * The Host owns derivation: station status comes from the run record the Host returns, and this
 * module only falls back to the documented derivation when that record carries bare phase data.
 */

/* --------------------------------- readers --------------------------------- */

/** One non-empty string, or undefined. */
function wfText(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** One finite number, or undefined. */
function wfNum(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Object entries of an array, dropping holes. */
function wfObjects(value) {
  return Array.isArray(value) ? value.filter((entry) => entry !== null && typeof entry === 'object') : [];
}

/** A compact age label (`5s`, `4m 12s`) between one past timestamp and now. */
function wfAge(timestamp, now) {
  const from = wfNum(timestamp);
  if (from === undefined) return '';
  return WF_UI.duration(from, wfNum(now) ?? Date.now());
}

/** Locale-aware thousands grouping with a stable fallback. */
function wfGroup(value) {
  const number = wfNum(value);
  if (number === undefined) return '0';
  try {
    return number.toLocaleString();
  } catch {
    return String(number);
  }
}

/* --------------------------------- identity -------------------------------- */

/** The run id, under either wire name the Host may use. */
function wfDetailRunId(run) {
  return wfText(run?.runId) ?? wfText(run?.id);
}

/** The run's display name; the panel falls back to its own title. */
function wfDetailRunName(run, params) {
  return wfText(run?.name) ?? wfText(run?.label) ?? wfText(params?.workflowName) ?? wfText(params?.name);
}

function wfDetailRunStatus(run) {
  const status = wfText(run?.status);
  return ['pending', 'running', 'completed', 'errored', 'stopped', 'superseded'].includes(status) ? status : 'unknown';
}

function wfDetailActive(run) {
  const status = wfDetailRunStatus(run);
  return status === 'pending' || status === 'running';
}

function wfRunIsTerminal(run) {
  return ['completed', 'errored', 'stopped', 'superseded'].includes(wfDetailRunStatus(run));
}

/** Phase names match exactly, unless the recorded name was truncated at the wire limit. */
function wfPhaseMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  return a === b || (a.length >= 128 && b.startsWith(a));
}

/* -------------------------------- stations --------------------------------- */

/**
 * Station statuses from the run record.
 *
 * The Host returns `stations` (already derived). When it only carries `phaseNames`/`phases`/
 * `currentPhase`, apply the documented derivation so the panel degrades instead of guessing.
 *
 * @param {Record<string, any>} run
 * @returns {{ name: string, status: string, alongside?: number[], hole?: string }[]}
 */
function wfDetailStations(run) {
  const derived = wfObjects(run?.stations ?? run?.phaseSummary);
  if (derived.length > 0) {
    return derived.map((station) => ({
      name: wfText(station.name) ?? '',
      status: ['pending', 'running', 'done', 'failed'].includes(station.status) ? station.status : 'pending',
      alongside: Array.isArray(station.alongside) ? station.alongside.filter((value) => Number.isInteger(value)) : undefined,
      hole: station.hole === 'waiting' || station.hole === 'open' ? station.hole : undefined,
    })).filter((station) => station.name !== '');
  }
  return wfDeriveStations(run);
}

/** Documented derivation, used only when the Host record carries no station list. */
function wfDeriveStations(run) {
  const declaredNames = new Set(wfObjects(run?.phases).map((phase) => wfText(phase.name)).filter(Boolean));
  const current = wfText(run?.currentPhase);
  const names = Array.isArray(run?.phaseNames) && run.phaseNames.length > 0
    ? run.phaseNames.filter((name) => typeof name === 'string' && name !== '')
    : wfObjects(run?.phases).map((phase) => wfText(phase.name)).filter(Boolean);
  if (Array.isArray(run?.phaseNames) !== true && current !== undefined && !declaredNames.has(current)) {
    names.push(current);
  }
  const active = wfDetailActive(run);
  const liveNames = active
    ? wfObjects(run?.nodes)
      .filter((node) => ['executing', 'repairing', 'nudged'].includes(node.phase))
      .map((node) => wfText(node.phaseName))
      .filter(Boolean)
    : [];
  const alongsides = Array.isArray(run?.phaseAlongside) ? run.phaseAlongside : [];
  const holedIndexes = new Set((Array.isArray(run?.phaseHoles) ? run.phaseHoles : []).filter((value) => Number.isInteger(value)));
  const waitingHoles = new Set(
    wfObjects(run?.holes).filter((hole) => hole.state === 'waiting').map((hole) => wfText(hole.name)).filter(Boolean),
  );
  const limit = Math.min(names.length, 32);
  return names.slice(0, 32).map((name, index) => {
    const isCurrent = name === current;
    const isDeclared = declaredNames.has(name) || isCurrent;
    const isLive = liveNames.some((live) => wfPhaseMatches(name, live));
    let status;
    if (active) status = isCurrent || isLive ? 'running' : isDeclared ? 'done' : 'pending';
    else if (wfDetailRunStatus(run) === 'completed') status = isDeclared ? 'done' : 'pending';
    else if (wfDetailRunStatus(run) === 'errored') status = isCurrent ? 'failed' : isDeclared ? 'done' : 'pending';
    else status = isCurrent ? 'pending' : isDeclared ? 'done' : 'pending';
    const alongside = (Array.isArray(alongsides[index]) ? alongsides[index] : [])
      .filter((value) => Number.isInteger(value) && value >= 0 && value < limit && value !== index);
    const hole = waitingHoles.has(name) ? 'waiting' : holedIndexes.has(index) ? 'open' : undefined;
    return { name, status, ...(alongside.length === 0 ? {} : { alongside }), ...(hole === undefined ? {} : { hole }) };
  });
}

/** How many times one phase was entered (`phase-entered` ordinal), when the Host reports it. */
function wfPhaseRounds(run, name) {
  const phase = wfObjects(run?.phases).find((entry) => wfPhaseMatches(name, wfText(entry.name)));
  return wfNum(phase?.rounds);
}

/* ------------------------------- aggregates -------------------------------- */

/** `{settled, total}`: settled nodes over every node the run ever dispatched. */
function wfDetailSteps(run) {
  const nodes = wfObjects(run?.nodes);
  const unlisted = wfNum(run?.usage?.nodesUnlisted) ?? 0;
  let settled = nodes.filter((node) => node.phase === 'settled').length + Math.max(0, wfNum(run?.usage?.nodesUnlistedSettled) ?? 0);
  let total = nodes.length + unlisted;
  const steps = run?.steps;
  if (steps !== null && typeof steps === 'object') {
    const started = wfNum(steps.started);
    const done = wfNum(steps.settled);
    if (started !== undefined) total = started;
    if (done !== undefined) settled = done;
  }
  return { settled, total };
}

function wfDetailTokens(run) {
  return wfNum(run?.usage?.spentTokens) ?? wfNum(run?.spentTokens) ?? 0;
}

/** Highest phase round count; the status row shows it only at two or more. */
function wfRunRounds(run, stations) {
  let rounds = 0;
  for (const phase of wfObjects(run?.phases)) {
    rounds = Math.max(rounds, wfNum(phase.rounds) ?? 0);
  }
  for (const station of stations ?? []) {
    const value = wfPhaseRounds(run, station.name);
    if (value !== undefined) rounds = Math.max(rounds, value);
  }
  return rounds;
}

function wfRunConcurrency(run) {
  const concurrency = run?.concurrency;
  if (concurrency === null || typeof concurrency !== 'object') return undefined;
  const cap = wfNum(concurrency.cap);
  if (cap === undefined) return undefined;
  return {
    cap,
    limit: wfNum(concurrency.limit),
    cooldownUntil: (wfNum(concurrency.cooldownMs) ?? 0) > 0 ? Date.now() + (wfNum(concurrency.cooldownMs)) : undefined,
    key: wfText(concurrency.key),
  };
}

/** Pending answers the run is parked on. */
function wfRunQuestions(run) {
  return wfObjects(run?.pendingQuestions).map((question) => ({
    qid: wfText(question.qid) ?? '',
    actorSiteId: wfText(question.actorSiteId),
    actorOrdinal: wfNum(question.actorOrdinal),
    actorName: wfText(question.actorName),
    question: wfText(question.question) ?? '',
    context: wfText(question.context),
    askedAt: wfNum(question.askedAt),
  })).filter((question) => question.question !== '');
}

/** Holes: waiting ones need the agent, filled ones only mark where work was inserted. */
function wfDetailHoles(run) {
  return wfObjects(run?.holes).map((hole) => ({
    id: wfText(hole.id) ?? wfText(hole.name) ?? '',
    name: wfText(hole.name) ?? '',
    state: hole.state === 'filled' ? 'filled' : 'waiting',
    prompt: wfText(hole.prompt),
    since: wfNum(hole.since),
    filledAt: wfNum(hole.filledAt),
    filledBy: wfText(hole.filledBy),
  })).filter((hole) => hole.name !== '');
}

/** Artifacts, newest version first, with the fields the panel needs flattened. */
function wfDetailArtifacts(run) {
  return wfObjects(run?.artifacts).map((artifact) => {
    const versions = wfObjects(artifact.versions).map((version) => ({
      version: wfNum(version.version) ?? 1,
      title: wfText(version.title),
      contentType: wfText(version.contentType),
      bytes: wfNum(version.bytes),
      uri: wfText(version.uri),
      sourcePath: wfText(version.sourcePath),
      publishedAt: wfNum(version.publishedAt),
      primary: version.primary === true,
      spec: version.spec,
    }));
    const version = wfNum(artifact.version) ?? versions.reduce((max, entry) => Math.max(max, entry.version), 1);
    const current = versions.find((entry) => entry.version === version);
    return {
      id: wfText(artifact.id) ?? '',
      kind: wfText(artifact.kind) ?? 'file',
      title: wfText(artifact.title),
      description: wfText(artifact.description),
      contentType: wfText(artifact.contentType) ?? current?.contentType,
      sourcePath: wfText(artifact.sourcePath) ?? current?.sourcePath,
      spec: artifact.spec ?? current?.spec,
      version,
      versions,
      itemCount: wfNum(artifact.itemCount) ?? 0,
      primary: artifact.primary === true,
      bytes: wfNum(artifact.bytes) ?? current?.bytes,
      at: wfNum(artifact.publishedAt) ?? current?.publishedAt,
    };
  }).filter((artifact) => artifact.id !== '');
}

/** The artifact the ledger marks primary; without one the panel shows its gallery instead. */
function wfPrimaryArtifact(artifacts) {
  return artifacts.find((artifact) => artifact.primary === true);
}

/** Table-like artifacts ship their rows in the published spec. */
function wfArtifactRows(artifact) {
  const spec = artifact?.spec;
  const items = Array.isArray(spec?.items) ? spec.items : Array.isArray(spec?.rows) ? spec.rows : undefined;
  return Array.isArray(items) ? items.filter((item) => item !== null && typeof item === 'object') : [];
}

/** Column names of a table-like artifact, in first-row order plus declared columns. */
function wfArtifactColumns(artifact, rows) {
  const declared = Array.isArray(artifact?.spec?.columns)
    ? artifact.spec.columns.map((column) => (typeof column === 'string' ? column : wfText(column?.key))).filter(Boolean)
    : [];
  const found = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!found.includes(key)) found.push(key);
  }
  for (const key of declared) if (!found.includes(key)) found.push(key);
  return found;
}

/** `B / KB / MB` byte label, matching the ledger's copy. */
function wfArtifactSize(bytes) {
  const value = wfNum(bytes);
  if (value === undefined || value <= 0) return undefined;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * One compact health line, from whatever the Host reported.
 * Only facts present on the record are rendered; nothing is inferred from a missing clock.
 */
function wfRunHealth(run, stationCount) {
  const items = [];
  const health = run?.health;
  if (health !== null && typeof health === 'object') {
    const lastProgress = wfNum(health.lastProgressAt);
    if (lastProgress !== undefined) items.push({ key: 'getRun.health.lastProgress', params: { age: wfAge(lastProgress, health.now) } });
    const stalled = health.stalled;
    if (stalled === true) {
      const since = wfNum(health.stalledSince);
      items.push(since === undefined
        ? { key: 'getRun.health.stalledNoClock' }
        : { key: 'getRun.health.stalled', params: { age: wfAge(since, health.now) } });
    } else if (stalled === false) {
      items.push({ key: 'getRun.health.notStalled' });
    }
  }
  const concurrency = wfRunConcurrency(run);
  if (concurrency !== undefined) {
    const effective = wfObjects(run?.actors).filter((actor) => actor.status === 'running').length;
    items.push({ key: 'getRun.health.concurrency', params: { effective, cap: concurrency.cap } });
  }
  const nodes = wfObjects(run?.nodes);
  const cached = nodes.filter((node) => node.cached === true).length;
  if (cached > 0) items.push({ key: cached === 1 ? 'getRun.health.cachedStepsOne' : 'getRun.health.cachedSteps', params: { count: cached } });
  const failures = nodes.filter((node) => node.outcome === 'failed').length;
  if (failures > 0) items.push({ key: failures === 1 ? 'getRun.health.failuresOne' : 'getRun.health.failures', params: { count: failures } });
  const leftover = wfRunIsTerminal(run)
    ? nodes.filter((node) => ['executing', 'repairing', 'nudged', 'dispatched'].includes(node.phase)).length
    : 0;
  return {
    items,
    leftover,
    leftoverKey: leftover === 1 ? 'getRun.health.leftoverOne' : 'getRun.health.leftover',
    hasStationList: stationCount > 0,
  };
}

/* --------------------------------- roster ---------------------------------- */

function wfActorKey(actor) {
  return `${wfText(actor.siteId) ?? ''}@${wfNum(actor.ordinal) ?? 0}`;
}

function wfNodeForActor(node, actor) {
  return wfText(node.actorSiteId) === wfText(actor.siteId) && wfNum(node.actorOrdinal) === wfNum(actor.ordinal);
}

/** Nodes an actor owns, newest first. */
function wfActorNodes(run, actor) {
  return wfObjects(run?.nodes).filter((node) => wfNodeForActor(node, actor));
}

/** Actor status: running → running; any failed node → failed; settled work → done; else pending. */
function wfActorStatus(actor, nodes) {
  const declared = wfText(actor.status);
  const failed = nodes.some((node) => node.outcome === 'failed');
  if (declared === 'running') return 'running';
  if (failed) return 'failed';
  if (declared === 'completed') return 'done';
  if (nodes.length > 0 && nodes.every((node) => node.phase === 'settled' || node.outcome === 'ok')) return 'done';
  return declared === 'waiting' ? 'pending' : 'pending';
}

/** One roster entry (agent pill) for an actor. */
function wfRosterEntry(run, actor, questions) {
  const nodes = wfActorNodes(run, actor);
  const status = wfActorStatus(actor, nodes);
  const asks = nodes.filter((node) => node.kind === 'ask').length;
  const reads = nodes.filter((node) => node.kind === 'world-read').length;
  const asking = questions.some((question) => question.actorSiteId === wfText(actor.siteId)
    && wfNum(question.actorOrdinal) === wfNum(actor.ordinal));
  return {
    key: wfActorKey(actor),
    siteId: wfText(actor.siteId),
    ordinal: wfNum(actor.ordinal) ?? 0,
    sessionId: wfText(actor.sessionId),
    name: wfText(actor.name),
    status,
    model: wfText(actor.model),
    phaseName: wfText(actor.phaseName) ?? wfText(nodes[0]?.phaseName),
    asks,
    reads,
    asking,
    nodes,
    questions: questions.filter((question) => question.actorSiteId === wfText(actor.siteId)
      && wfNum(question.actorOrdinal) === wfNum(actor.ordinal)),
  };
}

/** Every actor, in roster order (running first, then failed, pending, done). */
function wfRunRoster(run) {
  const questions = wfRunQuestions(run);
  const entries = wfObjects(run?.actors).map((actor) => wfRosterEntry(run, actor, questions));
  const rank = { running: 0, failed: 1, pending: 2, done: 3 };
  return entries.slice().sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
}

/** Pinned pills, the rest of the roster and its tallies for one station. */
function wfStationRoster(run, station, roster, unlistedByPhase) {
  const own = roster.filter((entry) => wfPhaseMatches(station.name, entry.phaseName));
  const unlisted = wfObjects(unlistedByPhase)
    .filter((entry) => wfPhaseMatches(station.name, wfText(entry.phaseName)))
    .reduce((sum, entry) => sum + Math.max(0, wfNum(entry.actors) ?? 0), 0);
  const counts = { done: 0, failed: 0, running: 0, pending: 0 };
  for (const entry of own) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  const pinned = own.slice(0, 5);
  const rest = own.slice(5);
  const nodes = wfObjects(run?.nodes).filter((node) => wfPhaseMatches(station.name, wfText(node.phaseName)));
  const settled = nodes.filter((node) => node.phase === 'settled').length
    + Math.max(0, (wfNum(run?.usage?.nodesUnlistedSettled) ?? 0));
  const observed = nodes.length + Math.max(0, wfNum(run?.usage?.nodesUnlisted) ?? 0);
  return {
    pins: pinned,
    rest,
    counts,
    unlisted,
    total: own.length + unlisted,
    fraction: { settled, observed },
    rounds: wfPhaseRounds(run, station.name),
  };
}

/* --------------------------------- timeline -------------------------------- */

/** Column geometry of the horizontal rail: one column per station. */
const WF_TIMELINE = {
  column: 168,
  gap: 24,
  head: 24,
  pillsTop: 34,
  pill: 30,
  pillGap: 6,
  maxPills: 6,
  viewport: 4,
  step: 192,
};

/**
 * Layout for the horizontal rail: columns, rails between neighbours, arcs for parallel phases.
 * @param {{ name: string, status: string, alongside?: number[] }[]} stations
 */
function wfTimelineLayout(stations) {
  const pitch = WF_TIMELINE.column + WF_TIMELINE.gap;
  const columns = stations.map((station, index) => ({
    ...station,
    index,
    left: index * pitch,
    pillsLeft: index * pitch + 6,
    pillsWidth: WF_TIMELINE.column - 12,
  }));
  const rails = [];
  for (let index = 0; index + 1 < columns.length; index += 1) {
    const from = columns[index];
    const to = columns[index + 1];
    rails.push({
      key: `rail-${index}`,
      kind: 'stream',
      x1: from.left + WF_TIMELINE.column - 8,
      x2: to.left + 8,
      y: WF_TIMELINE.head - 4,
    });
  }
  const arcs = [];
  for (const column of columns) {
    for (const target of column.alongside ?? []) {
      if (target <= column.index) continue;
      const to = columns[target];
      if (to === undefined) continue;
      arcs.push({
        key: `arc-${column.index}-${target}`,
        kind: 'branch',
        air: 8 + arcs.length * 10,
        x1: column.left + WF_TIMELINE.column / 2,
        x2: to.left + WF_TIMELINE.column / 2,
      });
    }
  }
  const width = Math.max(0, columns.length * pitch - WF_TIMELINE.gap);
  const tallest = columns.reduce((max, column) => Math.max(max, column.pills ?? 0), 0);
  return {
    columns,
    rails,
    arcs,
    width,
    height: WF_TIMELINE.pillsTop + Math.min(tallest, WF_TIMELINE.maxPills) * (WF_TIMELINE.pill + WF_TIMELINE.pillGap) + 8,
  };
}

/** Window of the rail that keeps the focused station visible, with the two ledge counts. */
function wfTimelineWindow(count, focus) {
  const viewport = WF_TIMELINE.viewport;
  if (count <= viewport) return { start: 0, end: count, earlier: 0, later: 0 };
  const anchor = Math.max(0, Math.min(focus ?? count - 1, count - 1));
  let start = anchor - viewport + 2;
  if (start < 0) start = 0;
  if (start + viewport > count) start = count - viewport;
  return { start, end: Math.min(count, start + viewport), earlier: start, later: Math.max(0, count - start - viewport) };
}

/** The first station that is running or waiting on a hole; the rail centres it. */
function wfFocusStation(stations) {
  const running = stations.findIndex((station) => station.status === 'running' || station.hole === 'waiting');
  if (running >= 0) return running;
  for (let index = stations.length - 1; index >= 0; index -= 1) {
    if (stations[index].status !== 'pending') return index;
  }
  return stations.length - 1;
}

/* -------------------------------- questions -------------------------------- */

/**
 * Split pending questions into the ones a roster entry owns and the orphans.
 * @param {{ qid: string }[]} questions
 * @param {{ siteId?: string, ordinal?: number, key: string }[]} roster
 */
function wfQuestionOwners(questions, roster) {
  const byActor = new Map(roster.map((entry) => [`${entry.siteId ?? ''}@${entry.ordinal}`, entry.key]));
  const owned = new Map();
  const orphans = [];
  for (const question of questions) {
    const key = byActor.get(`${question.actorSiteId ?? ''}@${question.actorOrdinal ?? 0}`);
    if (key === undefined) {
      orphans.push(question);
      continue;
    }
    const list = owned.get(key) ?? [];
    list.push(question);
    owned.set(key, list);
  }
  return { owned, orphans };
}
