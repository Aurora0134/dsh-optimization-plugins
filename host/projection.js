/**
 * 事件 → 运行快照投影（ZCode 3.17.2 的 `Im` reducer）。
 *
 * 契约来源：notes/engine.md §2.1（26 种事件与是否消费）、§3（Im 字段、派生 actor 状态、
 * 并发窗口、阶段与留白、unlistedByPhase 口径）。实现逐条对照 `applyWorkflowRunEvent`
 * （zcode-cli.js:55964-56179）及其 helper，目的不是"大致相似"，而是让同一份事件流在
 * Node 侧折叠出的快照与桌面端一致：节点上限、淘汰计数、actor 状态派生、阶段矩阵都按原分支。
 *
 * 纯函数：不读写文件、不依赖时间。事件由 `host/journal.js` 提供，字段名与 payload 对齐 §2.2。
 */

/** 快照列表与文本上限（validation.js:8353-8378 的 `B`）。 */
import { isResumable } from './resumability.js';

export const PROJECTION_LIMITS = Object.freeze({
  maxRuns: 8,
  maxActors: 1024,
  maxNodes: 1024,
  maxTotalEntries: 6144,
  maxReports: 64,
  maxReportPreviewLength: 2048,
  maxResultPreviewLength: 2048,
  maxErrorLength: 2048,
  maxPendingQuestions: 32,
  maxQuestionLength: 2048,
  maxConcurrencyKeyLength: 256,
  maxSubagentModelLength: 256,
  maxSessionIdLength: 256,
  maxConcurrencyCeiling: 1024,
  maxActorNameLength: 128,
  maxArtifacts: 32,
  maxPhases: 32,
  maxPhaseNameLength: 128,
  maxHoles: 32,
  maxHoleTypeLength: 128,
  maxHolePromptLength: 500,
  maxInstructionsHeadLength: 240,
  maxLastToolNameLength: 64,
  maxLastToolTargetLength: 120,
});

/** 投影消费的事件类型集合；其余类型（run-stalled/log/import-cache-closed）按契约忽略。 */
export const CONSUMED_EVENT_TYPES = Object.freeze(new Set([
  'run-started',
  'run-launched',
  'actor-created',
  'node-queued',
  'node-dispatched',
  'node-executing',
  'node-waiting',
  'node-repairing',
  'node-nudged',
  'node-settled',
  'node-progress',
  'report',
  'artifact-published',
  'artifact-failed',
  'usage-updated',
  'escalation-raised',
  'escalation-resolved',
  'concurrency-changed',
  'run-caps-changed',
  'phase-entered',
  'hole-reached',
  'hole-filled',
  'run-settled',
]));

const ARTIFACT_KINDS = new Set(['file', 'markdown', 'chart', 'table', 'metrics', 'board']);
const STOP_REASONS = new Set(['user', 'model', 'provider', 'interrupted', 'superseded']);
const NODE_PHASE_BY_EVENT = Object.freeze({
  'node-queued': 'queued',
  'node-dispatched': 'dispatched',
  'node-executing': 'executing',
  'node-waiting': 'waiting',
  'node-repairing': 'repairing',
  'node-nudged': 'nudged',
  'node-settled': 'settled',
});
/** Im 的规范字段顺序（validation.js:8465-8509），保证快照 diff 稳定。 */
const RUN_FIELDS = Object.freeze([
  'runId',
  'toolCallId',
  'status',
  'stopReason',
  'resumedFrom',
  'supersededBy',
  'usage',
  'error',
  'resumable',
  'resultPreview',
  'actors',
  'nodes',
  'reports',
  'pendingQuestions',
  'concurrency',
  'concurrencyCeiling',
  'subagentModel',
  'artifacts',
  'phases',
  'currentPhase',
  'phaseNames',
  'phaseAlongside',
  'phaseHoles',
  'holes',
  'unlistedByPhase',
  'truncated',
  'lastEventSequence',
]);

/* ---------------------------------------------------------------------------------------------- */
/* 基础工具                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** @param {unknown} value */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {string | undefined} */
function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** @param {unknown} value @param {number} max @returns {string | undefined} */
function boundedText(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.slice(0, max);
  return text.length > 0 ? text : undefined;
}

/** @param {unknown} value @returns {{ siteId: string, ordinal: number } | null} */
function instanceRef(value) {
  if (!isPlainRecord(value)) return null;
  const siteId = nonEmptyString(value.siteId);
  const ordinal = value.ordinal;
  if (siteId === undefined || typeof ordinal !== 'number') return null;
  return { siteId, ordinal };
}

/** @param {{ siteId: string, ordinal: number }} left @param {{ siteId: string, ordinal: number }} right */
function sameInstance(left, right) {
  return left.siteId === right.siteId && left.ordinal === right.ordinal;
}

/** @param {{ siteId: string, ordinal: number }} ref */
function instanceKey(ref) {
  return `${ref.siteId}\0${ref.ordinal}`;
}

/** @param {unknown} value @returns {number | undefined} */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** @param {unknown} value @returns {number | undefined} */
function nonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** @param {unknown} value @returns {number | undefined} */
function epoch(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** 与 ZCode `serializeWorkflowArtifact` 一致：字符串原样，其余 JSON 美化。 */
function serializeArtifact(item) {
  if (item === undefined) return '';
  if (typeof item === 'string') return item;
  try {
    const text = JSON.stringify(item, null, 2);
    return text === undefined ? String(item) : text;
  } catch {
    return String(item);
  }
}

/** report 预览：序列化后截到 2048，超出以省略号收尾（§3.1 `Nm`）。 */
function reportPreview(item, limits = PROJECTION_LIMITS) {
  const text = serializeArtifact(item);
  const max = limits.maxReportPreviewLength;
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/** 问题文本按 2048 截断。 */
function boundedQuestion(text, limits = PROJECTION_LIMITS) {
  const max = limits.maxQuestionLength;
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/** 把 run 快照按 Im 字段顺序归一化；未知字段丢弃，undefined 丢弃。 */
function canonicalRun(state) {
  /** @type {Record<string, any>} */
  const output = {};
  for (const field of RUN_FIELDS) {
    if (state[field] !== undefined) output[field] = state[field];
  }
  // 必填字段兜底，避免调用方拿到不完整快照。
  output.runId = output.runId ?? '';
  output.status = output.status ?? 'pending';
  output.usage = output.usage ?? { spentTokens: 0, nodesUsed: 0 };
  output.actors = output.actors ?? [];
  output.nodes = output.nodes ?? [];
  output.lastEventSequence = output.lastEventSequence ?? 0;
  return output;
}

/* ---------------------------------------------------------------------------------------------- */
/* 有界 upsert 与淘汰（unlistedByPhase 口径）                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * @param {Record<string, any>[]} list
 * @param {Record<string, any>} entry
 * @param {number} max
 * @param {{ admitNew?: boolean, keyOf: (entry: any) => string }} options
 */
function upsertBounded(list, entry, max, { admitNew = true, keyOf }) {
  const index = list.findIndex((candidate) => keyOf(candidate) === keyOf(entry));
  if (index >= 0) {
    const copy = [...list];
    copy[index] = entry;
    return { list: copy, truncated: false };
  }
  if (admitNew === false || list.length >= max) return { list: [...list], truncated: true };
  return { list: [...list, entry], truncated: false };
}

/** 快照已标记截断后，只有水位推进才允许继续扩容（`Xit`）。 */
function admitsNew(state, advancesWaterMark) {
  return state.truncated !== true || advancesWaterMark;
}

/** 节点是否属于失败结算（`Yit`）。 */
function isFailedNode(node) {
  return node?.outcome === 'failed' || node?.outcome === 'cancelled';
}

/**
 * 阶段未列出计数器（`ioe`）：同一阶段累加，降到全 0 时移除；阶段条目最多 maxPhases+1。
 *
 * @param {{ phaseName?: string, actors: number, actorsSettled?: number, actorsFailed?: number, settled: number }[] | undefined} existing
 * @param {string | undefined} phaseName
 * @param {Partial<{ actors: number, actorsSettled: number, actorsFailed: number, settled: number }>} delta
 * @param {number} maxPhases
 */
function addToUnlistedBucket(existing, phaseName, delta, maxPhases) {
  const list = existing ?? [];
  const index = list.findIndex((entry) => entry.phaseName === phaseName);
  if (index < 0 && list.length >= maxPhases + 1) return existing === undefined ? undefined : [...list];
  const current = index < 0 ? undefined : list[index];
  const atLeastZero = (value) => (value > 0 ? value : 0);
  const actors = atLeastZero((current?.actors ?? 0) + (delta.actors ?? 0));
  const actorsSettled = Math.min(atLeastZero((current?.actorsSettled ?? 0) + (delta.actorsSettled ?? 0)), actors);
  const actorsFailed = Math.min(atLeastZero((current?.actorsFailed ?? 0) + (delta.actorsFailed ?? 0)), actorsSettled);
  const settled = atLeastZero((current?.settled ?? 0) + (delta.settled ?? 0));
  if (actors === 0 && actorsSettled === 0 && actorsFailed === 0 && settled === 0) {
    if (index < 0) return existing === undefined ? undefined : [...list];
    const remaining = list.filter((_entry, position) => position !== index);
    return remaining.length > 0 ? remaining : undefined;
  }
  const next = {
    ...(phaseName === undefined ? {} : { phaseName }),
    actors,
    ...(actorsSettled > 0 ? { actorsSettled } : {}),
    ...(actorsFailed > 0 ? { actorsFailed } : {}),
    settled,
  };
  if (index < 0) return [...list, next];
  const copy = [...list];
  copy[index] = next;
  return copy;
}

/** @param {Record<string, any>} state @param {any[] | undefined} list */
function withUnlistedBuckets(state, list) {
  if (list === state.unlistedByPhase) return state;
  if (list === undefined || list.length === 0) {
    if (state.unlistedByPhase === undefined) return state;
    const { unlistedByPhase: _removed, ...rest } = state;
    return rest;
  }
  return { ...state, unlistedByPhase: [...list] };
}

/** 被挤出的节点/actor 计数（`mRr`）。 */
function withUnlistedEvictions(state, nodes, bucket, limits) {
  let unlisted = state.unlistedByPhase;
  if (bucket !== undefined) {
    const { phaseName, ...counts } = bucket;
    unlisted = addToUnlistedBucket(unlisted, phaseName, counts, limits.maxPhases);
  }
  let settledCount = 0;
  for (const node of nodes) {
    if (node.phase === 'settled') {
      settledCount += 1;
      unlisted = addToUnlistedBucket(unlisted, node.phaseName, { settled: 1 }, limits.maxPhases);
    }
  }
  const totalSettled = (state.usage.nodesUnlistedSettled ?? 0) + settledCount;
  return withUnlistedBuckets(
    {
      ...state,
      usage: {
        ...state.usage,
        nodesUnlisted: (state.usage.nodesUnlisted ?? 0) + nodes.length,
        ...(totalSettled > 0 ? { nodesUnlistedSettled: totalSettled } : {}),
      },
    },
    unlisted,
  );
}

/** 列出 actor 分组：只有"没有存活节点"的 actor 才可能被淘汰（`pRr`）。 */
function listedGroups(state) {
  /** @type {Map<string, { nodeIndexes: number[], live: boolean, queued: boolean, failed: boolean }>} */
  const byActor = new Map();
  state.nodes.forEach((node, index) => {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) return;
    const key = instanceKey({ siteId: node.actorSiteId, ordinal: node.actorOrdinal });
    const group = byActor.get(key) ?? { nodeIndexes: [], live: false, queued: false, failed: false };
    group.nodeIndexes.push(index);
    if (node.phase === 'queued') group.queued = true;
    else if (node.phase !== 'settled') group.live = true;
    if (isFailedNode(node)) group.failed = true;
    byActor.set(key, group);
  });
  const groups = [];
  state.actors.forEach((actor, index) => {
    const group = byActor.get(instanceKey(actor));
    if (group?.live === true) return;
    groups.push({
      index,
      phaseName: actor.phaseName,
      failed: group?.failed ?? false,
      nodeIndexes: group?.nodeIndexes ?? [],
      finished: group !== undefined && !group.queued,
      idle: group?.queued === true,
      zeroNode: group === undefined,
    });
  });
  return groups;
}

/** 没有绑定 actor 且已 settled 的节点（`fRr`）。 */
function looseSettledNodes(state) {
  const groups = [];
  state.nodes.forEach((node, index) => {
    if (node.actorSiteId === undefined && node.phase === 'settled') {
      groups.push({ index, phaseName: node.phaseName, failed: isFailedNode(node) });
    }
  });
  return groups;
}

/** 绑定给指定 actor 的已 settled 节点（`mbs`）。 */
function ownSettledNodes(state, ref) {
  const groups = [];
  state.nodes.forEach((node, index) => {
    if (node.actorSiteId !== ref.siteId || node.actorOrdinal !== ref.ordinal) return;
    if (node.phase === 'settled') groups.push({ index, phaseName: node.phaseName, failed: isFailedNode(node) });
  });
  return groups;
}

/** actor 是否仍有节点列在快照里（`hbs`）。 */
function ownsListedNode(state, actor) {
  return state.nodes.some(
    (node) => node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal,
  );
}

/** 淘汰策略：失败最少、同阶段数量最多的组（`VMe`）。 */
function pickVictim(groups) {
  if (groups.length === 0) return undefined;
  const healthy = groups.filter((group) => !group.failed);
  const pool = healthy.length > 0 ? healthy : groups;
  const counts = new Map();
  for (const group of pool) {
    const phase = group.phaseName ?? '';
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  let chosen = pool[0];
  let chosenCount = counts.get(chosen.phaseName ?? '') ?? 0;
  for (const group of pool) {
    const count = counts.get(group.phaseName ?? '') ?? 0;
    if (count > chosenCount) {
      chosen = group;
      chosenCount = count;
    }
  }
  return chosen;
}

/** 排除指定 actor 的分组（`dRr`）。 */
function spareGroups(state, ref) {
  const groups = listedGroups(state);
  return ref === null ? groups : groups.filter((group) => !sameInstance(state.actors[group.index], ref));
}

/** 选择可淘汰的 actor 分组（`oRr`）。 */
function pickActorVictim(state, ref, allowZeroNode) {
  const groups = spareGroups(state, ref);
  return pickVictim(groups.filter((group) => group.finished))
    ?? groups.filter((group) => group.idle).at(-1)
    ?? (allowZeroNode ? groups.filter((group) => group.zeroNode).at(-1) : undefined);
}

/** 整组淘汰 actor 及其节点（`Zit`）。 */
function evictGroup(state, group, limits) {
  const actor = state.actors[group.index];
  const nodeIndexes = new Set(group.nodeIndexes);
  const nodes = group.nodeIndexes.map((index) => state.nodes[index]);
  return {
    ...withUnlistedEvictions(
      state,
      nodes,
      {
        phaseName: actor.phaseName,
        actors: 1,
        ...(group.finished ? { actorsSettled: 1, actorsFailed: group.failed ? 1 : 0 } : {}),
      },
      limits,
    ),
    actors: state.actors.filter((_actor, index) => index !== group.index),
    nodes: state.nodes.filter((_node, index) => !nodeIndexes.has(index)),
    truncated: true,
  };
}

/** 淘汰单个节点（`pcn`）。 */
function evictSingleNode(state, group, limits) {
  const node = state.nodes[group.index];
  return {
    ...withUnlistedEvictions(state, [node], undefined, limits),
    nodes: state.nodes.filter((_node, index) => index !== group.index),
    truncated: true,
  };
}

/** actor 达到上限时腾一个位置（`sRr`）。 */
function withRoomForActor(state, ref, limits) {
  if (state.actors.length < limits.maxActors || state.actors.some((actor) => sameInstance(actor, ref))) {
    return state;
  }
  const victim = pickVictim(listedGroups(state).filter((group) => group.finished));
  return victim === undefined ? state : evictGroup(state, victim, limits);
}

/** node 达到上限时腾一个位置（`pbs`）。 */
function withRoomForNode(state, ref, actorRef, limits) {
  if (state.nodes.length < limits.maxNodes || state.nodes.some((node) => sameInstance(node, ref))) {
    return state;
  }
  const loose = pickVictim(looseSettledNodes(state));
  if (loose !== undefined) return evictSingleNode(state, loose, limits);
  const group = pickVictim(spareGroups(state, actorRef).filter((candidate) => candidate.finished));
  return group === undefined ? state : evictGroup(state, group, limits);
}

/**
 * 为新节点腾位（`fbs`）：节点与 actor 都已存在时无需腾位；否则先淘汰节点，再淘汰 actor。
 * 返回值里的 `activated` 表示这次是否首次激活了某个 instance（用于扣减 nodesUnlisted）。
 */
function activateInstance(state, ref, actor, limits) {
  const nodeExists = state.nodes.some((node) => sameInstance(node, ref));
  const actorExists = state.actors.some((candidate) => sameInstance(candidate, actor));
  if (nodeExists && actorExists) return { run: state, admitNew: true, activated: false };

  let next = state;
  if (!actorExists && next.actors.length >= limits.maxActors) {
    const victim = pickActorVictim(next, null, true);
    if (victim === undefined) return { run: state, admitNew: false, activated: false };
    next = evictGroup(next, victim, limits);
  }
  if (!nodeExists && next.nodes.length >= limits.maxNodes) {
    const own = ownSettledNodes(next, actor)[0];
    if (own !== undefined) {
      next = evictSingleNode(next, own, limits);
    } else {
      const loose = pickVictim(looseSettledNodes(next));
      if (loose !== undefined) {
        next = evictSingleNode(next, loose, limits);
      } else {
        const victim = pickActorVictim(next, actor, false);
        if (victim === undefined) return { run: state, admitNew: false, activated: false };
        next = evictGroup(next, victim, limits);
      }
    }
  }
  if (!actorExists) {
    next = withUnlistedBuckets(
      { ...next, actors: [...next.actors, actor] },
      addToUnlistedBucket(next.unlistedByPhase, actor.phaseName, { actors: -1 }, limits.maxPhases),
    );
  }
  return { run: next, admitNew: true, activated: !nodeExists };
}

/** 新 actor 被拒时记账（`cRr`）。 */
function absorbRefusedActor(state, phaseName, limits) {
  return withUnlistedBuckets(
    state,
    addToUnlistedBucket(state.unlistedByPhase, phaseName, { actors: 1 }, limits.maxPhases),
  );
}

/** 新 settled 节点被拒时记账（`lRr`）。 */
function absorbRefusedSettledNode(state, node, limits) {
  let unlisted = addToUnlistedBucket(state.unlistedByPhase, node.phaseName, { settled: 1 }, limits.maxPhases);
  const ref = node.actorSiteId === undefined || node.actorOrdinal === undefined
    ? null
    : { siteId: node.actorSiteId, ordinal: node.actorOrdinal };
  const actorIndex = ref === null ? -1 : state.actors.findIndex((actor) => sameInstance(actor, ref));
  const actor = actorIndex < 0 ? undefined : state.actors[actorIndex];
  const removable = actor !== undefined && !ownsListedNode(state, actor);
  if (removable) {
    unlisted = addToUnlistedBucket(
      unlisted,
      actor.phaseName,
      { actors: 1, actorsSettled: 1, actorsFailed: isFailedNode(node) ? 1 : 0 },
      limits.maxPhases,
    );
  }
  return withUnlistedBuckets(
    removable
      ? { ...state, actors: state.actors.filter((_candidate, index) => index !== actorIndex) }
      : state,
    unlisted,
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* 节点座位与 actor 状态                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** 把节点放到快照里（`aRr`）。 */
function seatWorkflowNode(state, { eventType, ref, actorRef, actor, born, advancesWaterMark }, limits) {
  const canAdmit = admitsNew(state, born && advancesWaterMark);
  if (!advancesWaterMark) return { run: state, admitNew: canAdmit, activated: false };
  if (eventType === 'node-dispatched' && actor !== null && state.truncated === true) {
    return activateInstance(state, ref, actor, limits);
  }
  if (
    born
    && state.truncated === true
    && actorRef !== null
    && !state.actors.some((candidate) => sameInstance(candidate, actorRef))
  ) {
    return { run: state, admitNew: false, activated: false };
  }
  if (eventType !== 'node-queued') return { run: state, admitNew: canAdmit, activated: false };
  return {
    run: withRoomForNode(state, ref, actorRef, limits),
    admitNew: canAdmit,
    activated: false,
  };
}

/** 首次派发计数（`eRr`）。 */
function countUnlistedInstance(usage, { rejected, advancesWaterMark, eventType, cached }) {
  if (!rejected || !advancesWaterMark) return usage;
  const settled = eventType === 'node-settled';
  const queuedBorn = eventType === 'node-queued' || (settled && cached);
  if (!queuedBorn && !settled) return usage;
  const nodesUnlisted = (usage.nodesUnlisted ?? 0) + (queuedBorn ? 1 : 0);
  const nodesUnlistedSettled = (usage.nodesUnlistedSettled ?? 0) + (settled ? 1 : 0);
  return {
    ...usage,
    ...(nodesUnlisted > 0 ? { nodesUnlisted } : {}),
    ...(nodesUnlistedSettled > 0 ? { nodesUnlistedSettled } : {}),
  };
}

/** instance 被激活时把之前记的未列出数扣掉（`tRr`）。 */
function discountUnlistedInstance(usage) {
  const count = usage.nodesUnlisted ?? 0;
  if (count === 0) return usage;
  const { nodesUnlisted: _unlisted, nodesUnlistedSettled, ...rest } = usage;
  return {
    ...rest,
    ...(count > 1 ? { nodesUnlisted: count - 1 } : {}),
    ...(nodesUnlistedSettled === undefined ? {} : { nodesUnlistedSettled }),
  };
}

/** actor 状态是派生的，不是事件给的（`Git`）。 */
function withDerivedActorStatuses(state) {
  /** @type {Set<string>} */
  const running = new Set();
  /** @type {Set<string>} */
  const waiting = new Set();
  /** @type {Set<string>} */
  const referenced = new Set();
  for (const node of state.nodes) {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
    const key = instanceKey({ siteId: node.actorSiteId, ordinal: node.actorOrdinal });
    referenced.add(key);
    if (node.phase === 'executing' || node.phase === 'repairing' || node.phase === 'nudged') running.add(key);
    else if (node.phase === 'queued' || node.phase === 'dispatched' || node.phase === 'waiting') waiting.add(key);
  }
  const active = state.status === 'pending' || state.status === 'running';
  const actors = state.actors.map((actor) => {
    const key = instanceKey(actor);
    const status = active
      ? running.has(key) ? 'running' : (waiting.has(key) || !referenced.has(key)) ? 'waiting' : 'completed'
      : 'completed';
    return actor.status === status ? actor : { ...actor, status };
  });
  return { ...state, actors };
}

/** 把 node-dispatched 的会话 id 补到 actor 上（`HPr`）。 */
function actorsWithTranscriptSession(actors, eventType, payload, actorRef, actorSessionId) {
  if (actorRef === null) return actors;
  const sessionId = eventType === 'node-settled' && payload.cached === true
    ? (boundedText(payload.sourceSessionId, PROJECTION_LIMITS.maxSessionIdLength)
      ?? boundedText(actorSessionId, PROJECTION_LIMITS.maxSessionIdLength))
    : eventType === 'node-dispatched'
      ? boundedText(actorSessionId, PROJECTION_LIMITS.maxSessionIdLength)
      : undefined;
  if (sessionId === undefined) return actors;
  const index = actors.findIndex((actor) => sameInstance(actor, actorRef));
  if (index < 0 || actors[index].sessionId === sessionId) return actors;
  const copy = [...actors];
  copy[index] = { ...actors[index], sessionId };
  return copy;
}

/** 构造 actor 条目（`lcn`）。 */
function actorEntry(ref, name, phaseName, sessionId, model) {
  const actorName = boundedText(name, PROJECTION_LIMITS.maxActorNameLength);
  const actorModel = boundedText(model, PROJECTION_LIMITS.maxSubagentModelLength);
  const actorSessionId = boundedText(sessionId, PROJECTION_LIMITS.maxSessionIdLength);
  const boundedPhase = boundedText(phaseName, PROJECTION_LIMITS.maxPhaseNameLength);
  return {
    siteId: ref.siteId,
    ordinal: ref.ordinal,
    ...(actorName === undefined ? {} : { name: actorName }),
    ...(actorSessionId === undefined ? {} : { sessionId: actorSessionId }),
    ...(boundedPhase === undefined ? {} : { phaseName: boundedPhase }),
    ...(actorModel === undefined ? {} : { model: actorModel }),
    status: 'waiting',
  };
}

/** node 进度字段（`ARr`）。 */
function carryNodeProgress(eventType, payload, existing) {
  const queued = eventType === 'node-queued';
  const carry = queued || (eventType === 'node-settled' && payload.cached === true) ? undefined : existing;
  const head = boundedText(payload.instructionsHead, PROJECTION_LIMITS.maxInstructionsHeadLength);
  const instructionsHead = queued ? head : (head ?? existing?.instructionsHead);
  return {
    ...(instructionsHead === undefined ? {} : { instructionsHead }),
    ...(carry?.turn === undefined ? {} : { turn: carry.turn }),
    ...(carry?.toolCalls === undefined ? {} : { toolCalls: carry.toolCalls }),
    ...(carry?.lastTool === undefined ? {} : { lastTool: carry.lastTool }),
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* 各事件 reducer                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

/** 移除仍在等待的 hole，只保留已完成记录（`tst`）。 */
function withoutWaitingHoles(state) {
  if (state.holes === undefined) return state;
  const filled = state.holes.filter((hole) => hole.state === 'filled');
  if (filled.length === state.holes.length) return state;
  const { holes: _holes, ...rest } = state;
  return filled.length === 0 ? rest : { ...rest, holes: filled };
}

/** `run-started`：重置一次生命期，保留可恢复的 actor/node 表（`FRr`）。 */
function reduceRunStarted(state, payload) {
  const {
    error: _error,
    resultPreview: _preview,
    pendingQuestions: _questions,
    resumable: _resumable,
    stopReason: _stopReason,
    unlistedByPhase: _unlisted,
    ...rest
  } = withoutWaitingHoles(state);
  const resumedFrom = boundedText(payload.resumedFrom, 128) ?? rest.resumedFrom;
  const subagentModel = boundedText(payload.subagentModel, PROJECTION_LIMITS.maxSubagentModelLength) ?? rest.subagentModel;
  const tables = state.truncated === true ? { actors: [], nodes: [] } : { actors: state.actors, nodes: state.nodes };
  const next = {
    ...rest,
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(subagentModel === undefined ? {} : { subagentModel }),
    status: 'running',
    usage: { spentTokens: 0, nodesUsed: 0 },
    ...tables,
  };
  return reduceRunStartedConcurrency(next, payload);
}

/** `run-started` 携带的并发上限（`gRr`）。 */
function reduceRunStartedConcurrency(state, payload) {
  const caps = isPlainRecord(payload.caps) ? payload.caps : undefined;
  const nextCap = positiveInteger(caps?.maxConcurrency);
  const ceilingLimit = positiveInteger(payload.concurrencyCeiling);
  const ceiling = ceilingLimit !== undefined && ceilingLimit <= PROJECTION_LIMITS.maxConcurrencyCeiling
    ? ceilingLimit
    : undefined;
  const withCeiling = ceiling === undefined || state.concurrencyCeiling === ceiling
    ? state
    : { ...state, concurrencyCeiling: ceiling };
  if (nextCap === undefined || ceiling === undefined || nextCap === ceiling) return withCeiling;
  return {
    ...withCeiling,
    concurrency: { ...(withCeiling.concurrency ?? { cap: ceiling }), ceiling, limit: nextCap },
  };
}

/** `run-launched`：阶段顺序、并行矩阵、留白下标（`MRr`）。 */
function reduceRunLaunched(state, payload) {
  if (!Array.isArray(payload.phaseNames)) return state;
  const phaseNames = [];
  for (const raw of payload.phaseNames) {
    if (typeof raw !== 'string') continue;
    const name = raw.slice(0, PROJECTION_LIMITS.maxPhaseNameLength);
    if (name.length === 0) continue;
    phaseNames.push(name);
    if (phaseNames.length >= PROJECTION_LIMITS.maxPhases) break;
  }
  if (phaseNames.length === 0) return state;
  const alongside = readPhaseAlongside(payload.phaseAlongside, phaseNames.length);
  const holes = readPhaseHoles(payload.holes, phaseNames.length);
  return {
    ...state,
    phaseNames,
    ...(alongside === undefined ? {} : { phaseAlongside: alongside }),
    ...(holes === undefined ? {} : { phaseHoles: holes }),
  };
}

/** 阶段并行矩阵校验（`Dbs`）。 */
function readPhaseAlongside(raw, count) {
  if (!Array.isArray(raw)) return undefined;
  const matrix = [];
  let any = false;
  for (let index = 0; index < count; index += 1) {
    const entry = raw[index];
    const row = [];
    if (Array.isArray(entry)) {
      for (const value of entry) {
        if (
          typeof value !== 'number'
          || !Number.isInteger(value)
          || value < 0
          || value >= count
          || value === index
          || row.includes(value)
        ) continue;
        row.push(value);
        if (row.length >= PROJECTION_LIMITS.maxPhases) break;
      }
    }
    if (row.length > 0) any = true;
    matrix.push(row);
  }
  return any ? matrix : undefined;
}

/** 留白阶段下标校验（`wcn`）：返回 `number[]`，不是计数数组。 */
function readPhaseHoles(raw, count) {
  if (!Array.isArray(raw)) return undefined;
  const holes = [];
  for (const value of raw) {
    if (
      typeof value !== 'number'
      || !Number.isInteger(value)
      || value < 0
      || value >= count
      || holes.includes(value)
    ) continue;
    holes.push(value);
    if (holes.length >= PROJECTION_LIMITS.maxPhases) break;
  }
  return holes.length === 0 ? undefined : holes;
}

/** 阶段进入（`NRr`）：补 phases[{name,rounds}] 与 currentPhase。 */
function reducePhaseEntered(state, payload) {
  const name = boundedText(payload.name, PROJECTION_LIMITS.maxPhaseNameLength);
  if (name === undefined) return state;
  const ordinal = positiveInteger(payload.ordinal) ?? 1;
  const phases = state.phases ?? [];
  const index = phases.findIndex((phase) => phase.name === name);
  let nextPhases;
  let truncated = state.truncated === true;
  if (index >= 0) {
    nextPhases = phases[index].rounds >= ordinal
      ? phases
      : phases.map((phase, position) => (position === index ? { ...phase, rounds: ordinal } : phase));
  } else if (phases.length >= PROJECTION_LIMITS.maxPhases) {
    nextPhases = phases;
    truncated = true;
  } else {
    nextPhases = [...phases, { name, rounds: ordinal }];
  }
  return { ...state, phases: nextPhases, currentPhase: name, ...(truncated ? { truncated: true } : {}) };
}

/** 留白到达（`DRr`）。 */
function reduceHoleReached(state, payload) {
  const ref = instanceRef(payload.instance);
  if (ref === null) return state;
  const name = boundedText(payload.name, PROJECTION_LIMITS.maxPhaseNameLength);
  if (name === undefined) return state;
  const type = boundedText(payload.type, PROJECTION_LIMITS.maxHoleTypeLength);
  const promptRaw = nonEmptyString(payload.prompt);
  const prompt = promptRaw === undefined
    ? undefined
    : (promptRaw.length <= PROJECTION_LIMITS.maxHolePromptLength
      ? promptRaw
      : `${promptRaw.slice(0, PROJECTION_LIMITS.maxHolePromptLength - 1)}\u2026`);
  const since = epoch(payload.reachedAt) ?? epoch(payload.since);
  const hole = {
    siteId: ref.siteId,
    ordinal: Number.isInteger(ref.ordinal) ? ref.ordinal : 0,
    name,
    ...(type === undefined ? {} : { type }),
    ...(prompt === undefined ? {} : { prompt }),
    state: 'waiting',
    ...(since === undefined ? {} : { since }),
  };
  const holes = state.holes ?? [];
  const index = holes.findIndex((candidate) => candidate.siteId === ref.siteId);
  if (index >= 0) {
    const previous = holes[index];
    const merged = {
      ...hole,
      ...(hole.type === undefined && previous.type !== undefined ? { type: previous.type } : {}),
      ...(hole.prompt === undefined && previous.prompt !== undefined ? { prompt: previous.prompt } : {}),
    };
    return { ...state, holes: holes.map((candidate, position) => (position === index ? merged : candidate)) };
  }
  if (holes.length >= PROJECTION_LIMITS.maxHoles) return { ...state, truncated: true };
  return { ...state, holes: [...holes, hole] };
}

/** 留白已填（`ORr`）：除标记 filled 外，还会更新阶段清单。 */
function reduceHoleFilled(state, payload) {
  const siteId = nonEmptyString(payload.siteId);
  if (siteId === undefined) return state;
  const filledAt = epoch(payload.filledAt);
  const filledBy = boundedText(payload.filledBy, 128);
  let next = state;
  const holes = state.holes ?? [];
  const index = holes.findIndex((hole) => hole.siteId === siteId);
  if (index >= 0) {
    const { prompt: _prompt, ...rest } = holes[index];
    next = {
      ...next,
      holes: holes.map((hole, position) => (position === index
        ? {
          ...rest,
          state: 'filled',
          ...(filledAt === undefined ? {} : { filledAt }),
          ...(filledBy === undefined ? {} : { filledBy }),
        }
        : hole)),
    };
  }
  const phaseNames = readPhaseNames(payload.phaseNames);
  if (phaseNames === undefined) return next;
  const phaseHoles = readPhaseHoles(payload.holes, phaseNames.length);
  const alongside = shiftPhaseAlongside(state, phaseNames);
  const { phaseAlongside: _oldAlongside, phaseHoles: _oldHoles, ...rest } = next;
  return {
    ...rest,
    phaseNames,
    ...(alongside === undefined ? {} : { phaseAlongside: alongside }),
    ...(phaseHoles === undefined ? {} : { phaseHoles }),
  };
}

/** 阶段名读取（`Abs`）。 */
function readPhaseNames(raw) {
  if (!Array.isArray(raw)) return undefined;
  const names = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const name = value.slice(0, PROJECTION_LIMITS.maxPhaseNameLength);
    if (name.length === 0) continue;
    names.push(name);
    if (names.length >= PROJECTION_LIMITS.maxPhases) break;
  }
  return names.length === 0 ? undefined : names;
}

/**
 * 阶段前缀前后追加时平移 alongside 下标（`Rbs`）。
 * 只在"旧名是 newNames 的子序列、且中间只插入一段"时成立，否则丢弃矩阵。
 */
function shiftPhaseAlongside(state, newNames) {
  const oldNames = state.phaseNames;
  const oldAlongside = state.phaseAlongside;
  if (oldNames === undefined || oldAlongside === undefined) return undefined;
  const shift = newNames.length - oldNames.length;
  if (shift < 0) return undefined;
  let anchor = -1;
  for (let index = 0; index < oldNames.length && oldNames[index] === newNames[index]; index += 1) anchor = index;
  if (anchor < 0) return undefined;
  for (let index = anchor + 1; index < oldNames.length; index += 1) {
    if (oldNames[index] !== newNames[index + shift]) return undefined;
  }
  const move = (value) => (value <= anchor ? value : value + shift);
  const matrix = [];
  for (let index = 0; index < newNames.length; index += 1) {
    const source = index <= anchor ? index : index - shift;
    const row = index > anchor && index <= anchor + shift ? [] : (oldAlongside[source] ?? []);
    matrix.push(row.map(move));
  }
  return matrix.some((row) => row.length > 0) ? matrix : undefined;
}

/** 并发窗口变化（`hRr`），`idle_reset` 清冷却。 */
function reduceConcurrencyChanged(state, payload) {
  const next = positiveInteger(payload.next);
  if (next === undefined) return state;
  const previous = positiveInteger(payload.previous) ?? next;
  const ceiling = state.concurrencyCeiling
    ?? Math.max(state.concurrency?.ceiling ?? 0, previous, next);
  const key = nonEmptyString(payload.key);
  const limit = state.concurrency?.limit;
  const cooldownMs = payload.reason === 'idle_reset' ? undefined : nonNegativeInteger(payload.cooldownMs);
  return {
    ...state,
    concurrency: {
      ...(key === undefined || key.length > PROJECTION_LIMITS.maxConcurrencyKeyLength ? {} : { key }),
      cap: next,
      ceiling,
      ...(limit === undefined ? {} : { limit }),
      ...(cooldownMs === undefined ? {} : { cooldownMs }),
    },
  };
}

/** 运行上限调整（`_Rr`）。 */
function reduceRunCapsChanged(state, payload) {
  const caps = isPlainRecord(payload.caps) ? payload.caps : undefined;
  const nextCap = positiveInteger(caps?.maxConcurrency);
  const claimedCeiling = positiveInteger(payload.concurrencyCeiling);
  const ceiling = claimedCeiling !== undefined && claimedCeiling <= PROJECTION_LIMITS.maxConcurrencyCeiling
    ? claimedCeiling
    : undefined;
  const withCeiling = ceiling === undefined || state.concurrencyCeiling === ceiling
    ? state
    : { ...state, concurrencyCeiling: ceiling };
  const effectiveCeiling = ceiling ?? withCeiling.concurrencyCeiling;
  if (nextCap === undefined || effectiveCeiling === undefined) return withCeiling;
  const concurrency = withCeiling.concurrency;
  if (nextCap !== effectiveCeiling) {
    return {
      ...withCeiling,
      concurrency: { ...(concurrency ?? { cap: effectiveCeiling }), ceiling: effectiveCeiling, limit: nextCap },
    };
  }
  if (concurrency?.limit === undefined) return withCeiling;
  const { limit: _limit, ...rest } = concurrency;
  const window = { ...rest, ceiling: effectiveCeiling };
  if (window.cooldownMs === undefined && window.cap >= window.ceiling) {
    const { concurrency: _removed, ...withoutConcurrency } = withCeiling;
    return withoutConcurrency;
  }
  return { ...withCeiling, concurrency: window };
}

/** 结算（`run-settled`）：清等待中的 hole，落终态与错误摘要。 */
function reduceRunSettled(state, payload) {
  const status = payload.status;
  const errorRecord = isPlainRecord(payload.error) ? payload.error : undefined;
  const message = typeof errorRecord?.message === 'string' ? errorRecord.message : undefined;
  const cleaned = withoutWaitingHoles(state);
  const stopReason = status === 'stopped' && STOP_REASONS.has(payload.stopReason) ? payload.stopReason : undefined;
  const supersededBy = stopReason === 'superseded' ? nonEmptyString(payload.supersededBy) : undefined;
  const recognized = status === 'completed' || status === 'errored' || status === 'stopped';
  const boundedMessage = recognized ? message : (message ?? `run settled with an unrecognized status: ${String(status)}`);
  return {
    ...cleaned,
    status: recognized ? status : 'errored',
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
    ...(boundedMessage === undefined
      ? {}
      : { error: boundedMessage.slice(0, PROJECTION_LIMITS.maxErrorLength) }),
    ...(payload.resumable === true ? { resumable: true } : {}),
  };
}

/** 节点进度（`PRr`）：只补 turn/toolCalls/lastTool。 */
function reduceNodeProgress(state, payload) {
  const ref = instanceRef(payload.instance);
  if (ref === null) return state;
  const index = state.nodes.findIndex((node) => sameInstance(node, ref));
  if (index < 0) return state;
  const node = state.nodes[index];
  const turn = positiveInteger(payload.turn) ?? node.turn;
  const toolCalls = nonNegativeInteger(payload.toolCalls) ?? node.toolCalls;
  const lastTool = readLastTool(payload.lastTool) ?? node.lastTool;
  const nodes = [...state.nodes];
  nodes[index] = {
    ...node,
    ...(turn === undefined ? {} : { turn }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(lastTool === undefined ? {} : { lastTool }),
  };
  return { ...state, nodes };
}

/** @param {unknown} raw */
function readLastTool(raw) {
  if (!isPlainRecord(raw)) return undefined;
  const name = boundedText(raw.name, PROJECTION_LIMITS.maxLastToolNameLength);
  if (name === undefined) return undefined;
  const target = boundedText(raw.target, PROJECTION_LIMITS.maxLastToolTargetLength);
  return { name, ...(target === undefined ? {} : { target }) };
}

/* ---------------------------------------------------------------------------------------------- */
/* 主 reducer                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * 折叠一条事件，返回新快照（不修改入参）。
 *
 * @param {Record<string, any>} state 当前 `Im` 快照
 * @param {Record<string, any>} event `{sequence, type, payload, actorSessionId?, toolCallId?}` 或扁平常量
 * @param {typeof PROJECTION_LIMITS} [limits]
 * @returns {Record<string, any>}
 */
export function applyWorkflowRunEvent(state, event, limits = PROJECTION_LIMITS) {
  const payload = isPlainRecord(event?.payload) ? /** @type {Record<string, any>} */ (event.payload) : (event ?? {});
  const type = typeof event?.type === 'string' ? event.type : (typeof payload.type === 'string' ? payload.type : '');
  const sequence = Number.isInteger(event?.sequence) && event.sequence >= 0 ? event.sequence : 0;
  const previousWatermark = Number.isInteger(state?.lastEventSequence) ? state.lastEventSequence : 0;
  const advancesWaterMark = sequence > previousWatermark;
  const actorSessionId = event?.actorSessionId ?? payload.actorSessionId;
  const toolCallId = event?.toolCallId ?? payload.toolCallId;

  let next = canonicalRun({
    ...state,
    lastEventSequence: Math.max(previousWatermark, sequence),
    ...(state?.toolCallId === undefined && toolCallId !== undefined && toolCallId !== ''
      ? { toolCallId }
      : {}),
  });

  switch (type) {
    case 'run-started':
      return canonicalRun(reduceRunStarted(next, payload));

    case 'actor-created': {
      const ref = instanceRef(payload.actor);
      if (ref === null) return canonicalRun(next);
      const phaseName = boundedText(payload.phaseName, limits.maxPhaseNameLength);
      const actor = actorEntry(ref, payload.name, phaseName, actorSessionId, payload.model);
      let base = advancesWaterMark ? withRoomForActor(next, ref, limits) : next;
      const seated = upsertBounded(base.actors, actor, limits.maxActors, {
        admitNew: admitsNew(next, advancesWaterMark),
        keyOf: (candidate) => instanceKey(candidate),
      });
      let result = { ...base, actors: seated.list };
      if (seated.truncated && advancesWaterMark) result = absorbRefusedActor(base, phaseName, limits);
      if (seated.truncated || base.truncated) result = { ...result, truncated: true };
      return canonicalRun(withDerivedActorStatuses(result));
    }

    case 'node-queued':
    case 'node-dispatched':
    case 'node-executing':
    case 'node-waiting':
    case 'node-repairing':
    case 'node-nudged':
    case 'node-settled': {
      const ref = instanceRef(payload.instance);
      if (ref === null) return canonicalRun(next);
      const phase = NODE_PHASE_BY_EVENT[type];
      const born = type === 'node-queued' || (type === 'node-settled' && payload.cached === true);
      const actorRef = instanceRef(payload.actor);
      const actor = type === 'node-dispatched' && actorRef !== null
        ? actorEntry(actorRef, payload.actorName, payload.actorPhaseName, actorSessionId, payload.actorModel)
        : null;
      const seated = seatWorkflowNode(next, {
        eventType: type,
        ref,
        actorRef,
        actor,
        born,
        advancesWaterMark,
      }, limits);
      const current = seated.run;
      const previousNode = current.nodes.find((node) => sameInstance(node, ref));
      const kind = payload.kind === 'ask' || payload.kind === 'world-read' ? payload.kind : previousNode?.kind;
      const phaseName = boundedText(payload.phaseName, limits.maxPhaseNameLength) ?? previousNode?.phaseName;
      const outcome = payload.outcome === 'ok' || payload.outcome === 'failed' || payload.outcome === 'cancelled'
        ? payload.outcome
        : undefined;
      const nodeEntry = {
        siteId: ref.siteId,
        ordinal: ref.ordinal,
        ...(kind === undefined ? {} : { kind }),
        phase,
        ...(outcome === undefined ? {} : { outcome }),
        ...(payload.cached === true ? { cached: true } : {}),
        ...(actorRef === null
          ? (previousNode?.actorSiteId === undefined
            ? {}
            : { actorSiteId: previousNode.actorSiteId, actorOrdinal: previousNode.actorOrdinal })
          : { actorSiteId: actorRef.siteId, actorOrdinal: actorRef.ordinal }),
        ...(phaseName === undefined ? {} : { phaseName }),
        ...carryNodeProgress(type, payload, previousNode),
      };
      const seatedNodes = upsertBounded(current.nodes, nodeEntry, limits.maxNodes, {
        admitNew: seated.admitNew,
        keyOf: (candidate) => instanceKey(candidate),
      });
      const firstDispatch = type === 'node-dispatched'
        && admitsNew(next, advancesWaterMark)
        && (previousNode === undefined || previousNode.phase === 'queued');
      const usageBase = seated.activated ? discountUnlistedInstance(current.usage) : current.usage;
      const usage = countUnlistedInstance(
        firstDispatch ? { ...usageBase, nodesUsed: usageBase.nodesUsed + 1 } : usageBase,
        { rejected: seatedNodes.truncated, advancesWaterMark, eventType: type, cached: payload.cached === true },
      );
      const evicted = seatedNodes.truncated && advancesWaterMark && born && phase === 'settled'
        ? absorbRefusedSettledNode(current, nodeEntry, limits)
        : current;
      return canonicalRun(withDerivedActorStatuses({
        ...evicted,
        actors: actorsWithTranscriptSession(evicted.actors, type, payload, actorRef, actorSessionId),
        ...(usage === current.usage ? {} : { usage }),
        nodes: seatedNodes.list,
        ...(seatedNodes.truncated || current.truncated ? { truncated: true } : {}),
      }));
    }

    case 'node-progress':
      return canonicalRun(reduceNodeProgress(next, payload));

    case 'report': {
      const ref = instanceRef(payload.instance);
      if (ref === null) return canonicalRun(next);
      const artifactId = boundedText(payload.artifactId, 64);
      const report = {
        siteId: ref.siteId,
        ordinal: ref.ordinal,
        preview: reportPreview(payload.item, limits),
        ...(artifactId === undefined ? {} : { artifactId }),
      };
      const reports = next.reports ?? [];
      const isNewInstance = !reports.some((candidate) => sameInstance(candidate, ref));
      const seated = upsertBounded(reports, report, limits.maxReports, {
        keyOf: (candidate) => instanceKey(candidate),
      });
      const artifactList = artifactId !== undefined && isNewInstance
        ? countTaggedReport(next.artifacts, artifactId)
        : next.artifacts;
      return canonicalRun({
        ...next,
        reports: seated.list,
        ...(artifactList === undefined ? {} : { artifacts: artifactList }),
        ...(seated.truncated || next.truncated ? { truncated: true } : {}),
      });
    }

    case 'artifact-published': {
      const artifact = artifactSummary(payload.artifact);
      if (artifact === undefined) return canonicalRun(next);
      const list = next.artifacts ?? [];
      const seated = upsertBoundedByArtifactId(list, artifact, limits.maxArtifacts);
      return canonicalRun({
        ...next,
        artifacts: seated.list,
        ...(seated.truncated || next.truncated ? { truncated: true } : {}),
      });
    }

    case 'artifact-failed':
      return canonicalRun(next);

    case 'usage-updated':
      return typeof payload.spentTokens !== 'number'
        ? canonicalRun(next)
        : canonicalRun({ ...next, usage: { ...next.usage, spentTokens: payload.spentTokens } });

    case 'escalation-raised': {
      const qid = boundedText(payload.qid, 128);
      const question = boundedText(payload.question, limits.maxQuestionLength);
      if (qid === undefined || question === undefined) return canonicalRun(next);
      const ref = instanceRef(payload.actor);
      const actorName = boundedText(payload.actorName, limits.maxActorNameLength);
      const context = boundedText(payload.context, limits.maxQuestionLength);
      const askedAt = nonNegativeInteger(payload.askedAt);
      const pending = {
        qid,
        ...(ref === null ? {} : { actorSiteId: ref.siteId, actorOrdinal: ref.ordinal }),
        ...(actorName === undefined ? {} : { actorName }),
        question: boundedQuestion(question, limits),
        ...(context === undefined ? {} : { context: boundedQuestion(context, limits) }),
        ...(askedAt === undefined ? {} : { askedAt }),
      };
      const questions = next.pendingQuestions ?? [];
      const index = questions.findIndex((candidate) => candidate.qid === qid);
      let list;
      let truncated = false;
      if (index >= 0) {
        list = questions.map((candidate, position) => (position === index ? pending : candidate));
      } else if (questions.length >= limits.maxPendingQuestions) {
        list = [...questions];
        truncated = true;
      } else {
        list = [...questions, pending];
      }
      return canonicalRun({
        ...next,
        pendingQuestions: list,
        ...(truncated || next.truncated ? { truncated: true } : {}),
      });
    }

    case 'escalation-resolved': {
      const qid = boundedText(payload.qid, 128);
      if (qid === undefined || next.pendingQuestions === undefined) return canonicalRun(next);
      const remaining = next.pendingQuestions.filter((question) => question.qid !== qid);
      if (remaining.length === next.pendingQuestions.length) return canonicalRun(next);
      if (remaining.length > 0) return canonicalRun({ ...next, pendingQuestions: remaining });
      const { pendingQuestions: _questions, ...rest } = next;
      return canonicalRun(rest);
    }

    case 'concurrency-changed':
      return canonicalRun(reduceConcurrencyChanged(next, payload));

    case 'run-caps-changed':
      return canonicalRun(reduceRunCapsChanged(next, payload));

    case 'phase-entered':
      return canonicalRun(reducePhaseEntered(next, payload));

    case 'run-launched':
      return canonicalRun(reduceRunLaunched(next, payload));

    case 'hole-reached':
      return canonicalRun(reduceHoleReached(next, payload));

    case 'hole-filled':
      return canonicalRun(reduceHoleFilled(next, payload));

    case 'run-settled':
      return canonicalRun(reduceRunSettled(next, payload));

    default:
      // run-stalled / log / import-cache-closed 不参与快照（§2.1 投影列标注为 ✘）。
      return canonicalRun(next);
  }
}

/** 构造初始快照。 */
export function createRunState(seed = {}) {
  return canonicalRun({
    status: 'pending',
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    ...seed,
  });
}

/**
 * 从事件流折叠出一个 run 快照，等价于桌面的 `replay`。
 *
 * @param {Record<string, any>[]} events
 * @param {{ runId: string, toolCallId?: string, status?: string, subagentModel?: string, resumedFrom?: string, supersededBy?: string, resultPreview?: string, lastEventSequence?: number, lastEventSequenceUnknown?: boolean }} [seed]
 * @returns {Record<string, any>}
 */
export function projectRunEvents(events, seed = {}) {
  const ordered = [...(events ?? [])]
    .filter((event) => event !== null && typeof event === 'object')
    .sort((left, right) => {
      const leftSequence = Number.isInteger(left.sequence) ? left.sequence : 0;
      const rightSequence = Number.isInteger(right.sequence) ? right.sequence : 0;
      return leftSequence - rightSequence;
    });
  const firstSequence = ordered.length > 0 && Number.isInteger(ordered[0].sequence) ? ordered[0].sequence : 0;
  let state = createRunState({
    ...seed,
    // 首条事件不构成"水位推进"：与 ZCode 新 run 的 `lastEventSequence = i` 一致。
    lastEventSequence: seed.lastEventSequence ?? firstSequence,
  });
  for (const event of ordered) state = applyWorkflowRunEvent(state, event);
  return state;
}

/** 工件摘要（`ZPr`/`wm`）。 */
function artifactSummary(raw) {
  if (!isPlainRecord(raw)) return undefined;
  const id = boundedText(raw.id, 64);
  const kind = nonEmptyString(raw.kind);
  const version = positiveInteger(raw.version);
  if (id === undefined || kind === undefined || !ARTIFACT_KINDS.has(kind) || version === undefined) return undefined;
  const title = boundedText(raw.title, 120);
  const contentType = boundedText(raw.contentType, 128);
  const bytes = nonNegativeInteger(raw.bytes);
  return {
    id,
    kind,
    ...(title === undefined ? {} : { title }),
    version: Math.min(version, 16),
    ...(contentType === undefined ? {} : { contentType }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(raw.primary === true ? { primary: true } : {}),
  };
}

/** 工件按 id upsert（`YPr`），保留旧 itemCount。 */
function upsertBoundedByArtifactId(list, artifact, max) {
  const index = list.findIndex((candidate) => candidate.id === artifact.id);
  if (index >= 0) {
    const previous = list[index];
    const copy = [...list];
    copy[index] = {
      ...artifact,
      ...(previous.itemCount === undefined ? {} : { itemCount: previous.itemCount }),
    };
    return { list: copy, truncated: false };
  }
  if (list.length >= max) return { list: [...list], truncated: true };
  return { list: [...list, artifact], truncated: false };
}

/** 给 artifact 计一条 report（`XPr`）。 */
function countTaggedReport(artifacts, artifactId) {
  if (artifacts === undefined) return undefined;
  const index = artifacts.findIndex((artifact) => artifact.id === artifactId);
  if (index < 0) return undefined;
  const copy = [...artifacts];
  copy[index] = { ...artifacts[index], itemCount: (artifacts[index].itemCount ?? 0) + 1 };
  return copy;
}

/**
 * 运行摘要（`dSs`，§1.1(1)）：`workflowRuns` 返回的是摘要而不是快照，字段必须同名。
 *
 * @param {Record<string, any>} run `Im` 快照
 * @param {{ updatedAt?: number, label?: string }} [meta]
 */
export function workflowRunSummary(run, meta = {}) {
  return {
    runId: run.runId,
    ...(run.toolCallId === undefined ? {} : { toolCallId: run.toolCallId }),
    ...(meta.label === undefined ? {} : { label: meta.label }),
    ...(meta.updatedAt === undefined ? {} : { updatedAt: meta.updatedAt }),
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    ...(run.resumedFrom === undefined ? {} : { resumedFrom: run.resumedFrom }),
    ...(run.supersededBy === undefined ? {} : { supersededBy: run.supersededBy }),
    ...(run.error === undefined ? {} : { failureMessage: run.error }),
    ...(run.failureCode === undefined ? {} : { failureCode: run.failureCode }),
    resumable: isResumable(run.status, run.stopReason),
  };
}
