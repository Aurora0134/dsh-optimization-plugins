/**
 * ZCode 3.17.2 的阶段状态推导（`Wm`，validation.js:8545-8600）逐分支移植。
 *
 * 会话快照里的阶段阶梯和运行摘要卡片用的是同一套规则：阶段清单的权威来源是
 * `run-launched.phaseNames`，没有时才退化为"进入过哪些阶段 + currentPhase"；每个阶段的
 * 四态（pending/running/done/failed）由 run 生命周期、当前阶段、活跃节点共同决定，不能
 * 由调用方另行推断。这里保持为纯函数，便于单独测试，也避免 host 与前端各写一份。
 *
 * 为什么单独成文件：store 投影、UI 路由和将来的订阅推送都要在服务端算出同样的阶段状态，
 * 而 `projection.js` 只负责字段折叠；把推导规则独立出来，两边引用同一实现就不会漂移。
 */

/** 阶段数量上限（validation.js:8370 `B.maxPhases`）。 */
export const MAX_PHASES = 32;
/** 阶段名长度上限（validation.js:8371）。 */
export const MAX_PHASE_NAME_LENGTH = 128;

/**
 * run 是否仍然"活着"：只有 pending/running 会驱动阶段 running。
 *
 * @param {unknown} status run 状态
 * @returns {boolean}
 */
export function isRunActive(status) {
  return status === 'pending' || status === 'running';
}

/**
 * 节点是否"真的在跑"：ZCode 只把 executing/repairing/nudged 视为活跃，
 * dispatched/waiting 属于调度中，不能把所在阶段点亮为 running。
 *
 * @param {{ phase?: string }} node
 * @returns {boolean}
 */
export function isNodeActivelyRunning(node) {
  return node?.phase === 'executing' || node?.phase === 'repairing' || node?.phase === 'nudged';
}

/**
 * 阶段名与节点记录里的 phaseName 是否属于同一阶段。
 *
 * 阶段名在上游会被截断到 128 字符，达到上限的名字无法证明是完整名字，此时才退化为前缀
 * 匹配（`validation.js:8542-8543`）；正常长度必须完全相等，否则 "build" 会错误吞掉
 * "build-extra"。
 *
 * @param {string} phaseName 阶段清单里的名字
 * @param {string} nodePhaseName 节点记录的阶段名
 * @returns {boolean}
 */
export function phaseNameMatches(phaseName, nodePhaseName) {
  if (phaseName === nodePhaseName) return true;
  return phaseName.length >= MAX_PHASE_NAME_LENGTH && nodePhaseName.startsWith(phaseName);
}

/**
 * 从 run 快照推导阶段状态列表（`Wm`）。
 *
 * @param {object} run `Im` 形状的 run 快照
 * @param {string} run.status pending|running|completed|errored|stopped
 * @param {string} [run.currentPhase]
 * @param {{ name: string, rounds: number }[]} [run.phases]
 * @param {string[]} [run.phaseNames]
 * @param {number[][]} [run.phaseAlongside]
 * @param {number[]} [run.phaseHoles]
 * @param {{ name: string, state: 'waiting'|'filled' }[]} [run.holes]
 * @param {{ phase?: string, phaseName?: string }[]} [run.nodes]
 * @returns {{ name: string, status: 'pending'|'running'|'done'|'failed', alongside?: number[], hole?: 'open'|'waiting' }[]}
 */
export function derivePhaseStates(run) {
  const enteredNames = new Set((run?.phases ?? []).map((phase) => phase.name));
  const currentPhase = run?.currentPhase;
  /** 有留白的阶段名（等待中的 hole），按名字匹配。 */
  const waitingHoleNames = new Set(
    (run?.holes ?? []).filter((hole) => hole.state === 'waiting').map((hole) => hole.name),
  );

  /** @type {string[]} */
  let names;
  /** @type {number[][] | undefined} */
  let alongside;
  /** @type {Set<number>} */
  let phaseHoles = new Set();
  if (run?.phaseNames !== undefined && run.phaseNames.length > 0) {
    // 权威顺序：脚本声明的阶段即使一次都没进入也要展示为 pending。
    names = run.phaseNames;
    alongside = run.phaseAlongside;
    phaseHoles = new Set(run.phaseHoles ?? []);
  } else {
    names = (run?.phases ?? []).map((phase) => phase.name);
    if (currentPhase !== undefined && !enteredNames.has(currentPhase)) names = [...names, currentPhase];
  }

  const active = isRunActive(run?.status);
  // 只有 run 还活着时才让节点影响阶段状态：结束的 run 里残留的 executing 节点是脏数据。
  const activeNodePhases = active
    ? (run.nodes ?? []).filter(isNodeActivelyRunning).flatMap((node) => node.phaseName ?? [])
    : [];
  const validPhaseCount = Math.min(names.length, MAX_PHASES);

  return names.slice(0, MAX_PHASES).map((name, index) => {
    const isCurrent = name === currentPhase;
    const hasEntered = enteredNames.has(name) || isCurrent;
    const hasActiveNode = activeNodePhases.some((nodePhaseName) => phaseNameMatches(name, nodePhaseName));

    /** @type {'pending'|'running'|'done'|'failed'} */
    let status;
    if (active) {
      status = isCurrent || hasActiveNode ? 'running' : hasEntered ? 'done' : 'pending';
    } else if (run.status === 'completed') {
      status = hasEntered ? 'done' : 'pending';
    } else if (run.status === 'errored') {
      status = isCurrent ? 'failed' : hasEntered ? 'done' : 'pending';
    } else {
      // stopped（以及未知终态）：当前阶段回到 pending，表示"还没做完、可以继续"。
      status = isCurrent ? 'pending' : hasEntered ? 'done' : 'pending';
    }

    const parallel = (alongside?.[index] ?? []).filter(
      (candidate) => Number.isInteger(candidate) && candidate >= 0 && candidate < validPhaseCount && candidate !== index,
    );
    const hole = waitingHoleNames.has(name) ? 'waiting' : phaseHoles.has(index) ? 'open' : undefined;

    return {
      name,
      status,
      ...(parallel.length === 0 ? {} : { alongside: parallel }),
      ...(hole === undefined ? {} : { hole }),
    };
  });
}

// ZCode 源符号别名：规格文档与逆向片段都用短名，保留别名便于对照检查。
/** @see isRunActive */
export const Vm = isRunActive;
/** @see isNodeActivelyRunning */
export const Hm = isNodeActivelyRunning;
/** @see phaseNameMatches */
export const Um = phaseNameMatches;
/** @see derivePhaseStates */
export const Wm = derivePhaseStates;
