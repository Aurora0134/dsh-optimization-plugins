/* Launch confirmation for a workflow script: the compact block inside the tool card, and the
 * full-size dialog it opens.
 *
 * ZCode asks before a `CreateWorkflow` / `AmendWorkflow` / `FillWorkflowHole` script runs. The
 * question carries the phase graph, the script, the saved-workflow provenance and the two settings
 * the user may still change (subagent model, concurrency ceiling); the answer is one of four
 * decisions — allow once, allow for this session, deny, or "refine" with free text, which the
 * workflow facade records as a rejection carrying the user's words.
 *
 * Data comes from the run the host publishes for the pending call: the run row (`runId`) plus the
 * tool input (`input`) and its prepared display (`display.causalityGraph`). Field names are read
 * tolerantly in both spellings, because a run arrives either as the host's camelCase projection or
 * as the tool's snake_case input.
 *
 * The two surfaces never show the same run at once: while a tool card renders the block, the launch
 * watcher leaves the question to that card and only puts the dialog up once no card is on it. A click
 * from the status panel opens the dialog regardless — there the user asked for it.
 */

const WF_PERMISSION = {};

/** The four answers the host accepts, in the order the dialog lists them. */
const WF_PERM_OPTION_IDS = ['allow_once', 'allow_session', 'deny', 'workflowRefine'];

/** Column pitch of the phase graph, in pixels. */
const WF_PERM_PITCH = 192;
/** Width of one station head, in pixels. */
const WF_PERM_STATION = 168;
/** Height of one station head row, in pixels. */
const WF_PERM_ROW = 24;
/** Vertical distance between two connector lanes, in pixels. */
const WF_PERM_LANE = 14;
/** Top padding of the connector field, in pixels. */
const WF_PERM_LANE_TOP = 10;
/** Connectors drawn above the stations before the lanes are reused. */
const WF_PERM_LANES = 6;
/** Pills drawn per station before the rest collapse into a counter. */
const WF_PERM_PIN = 5;

/** Copy of this surface; the `shell.overlay` registration binds the live translator. */
var WF_PERMISSION_UI = undefined;

/**
 * One string of the workspace dictionary, with the compiled English text as fallback.
 * @param {((key: string, params?: Record<string, unknown>) => string) | undefined} t
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 */
function wfPermSay(t, key, params) {
  const translate = typeof t === 'function' ? t : WF_PERMISSION_UI;
  return WF_UI.say(translate, UI_EN, key, params);
}

/** Count copy: the `…One` variant is used only when the fragment carries one. */
function wfPermCountSay(t, key, count, params) {
  const oneKey = `${key}One`;
  const useOne = count === 1 && Object.prototype.hasOwnProperty.call(UI_EN, oneKey);
  return wfPermSay(t, useOne ? oneKey : key, { ...(params ?? {}), count });
}

/* ---------------------------------- readers --------------------------------- */

/** @returns {Record<string, any> | undefined} */
function wfPermRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/** @returns {string | undefined} a non-empty trimmed string */
function wfPermText(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

/** @returns {number | undefined} */
function wfPermNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** @returns {number | undefined} a positive whole number */
function wfPermLimit(value) {
  const number = wfPermNumber(value);
  return number !== undefined && number > 0 ? Math.floor(number) : undefined;
}

const WF_PERM_KEYS = ['approval', 'permission', 'pendingApproval', 'pendingPermission', 'launch', 'confirmation'];

/** Run states that mean "still live": an amend of such a run stops it first. */
const WF_PERM_LIVE = ['running', 'pending'];

/**
 * Split one run into the run row and the permission envelope, whichever shape it arrived in.
 * @param {unknown} run
 * @returns {{ run: Record<string, any> | undefined, envelope: Record<string, any> }}
 */
function wfPermSource(run) {
  const record = wfPermRecord(run);
  if (record === undefined) return { run: undefined, envelope: {} };
  for (const key of WF_PERM_KEYS) {
    const nested = wfPermRecord(record[key]);
    if (nested !== undefined) return { run: record, envelope: nested };
  }
  return { run: record, envelope: record };
}

/** The run identity, in either spelling. */
function wfPermRunId(run) {
  const record = wfPermRecord(run);
  if (record === undefined) return '';
  return wfPermText(record.runId) ?? wfPermText(record.id) ?? '';
}

/** The run's display name: the workflow label the host projected, else the script name. */
function wfPermRunName(run) {
  const record = wfPermRecord(run);
  if (record === undefined) return '';
  return wfPermText(record.label) ?? wfPermText(record.name) ?? wfPermText(record.title) ?? '';
}

/** Display value of one argument, the way the dialog prints saved arguments. */
function wfPermArgText(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Flatten one run into the fields the confirmation shows.
 * @param {unknown} run
 */
function wfPermView(run) {
  const source = wfPermSource(run);
  const envelope = source.envelope;
  const outer = source.run ?? {};
  const input = wfPermRecord(envelope.input)
    ?? wfPermRecord(envelope.toolInput)
    ?? wfPermRecord(envelope.detail)
    ?? wfPermRecord(outer.input)
    ?? {};
  const display = wfPermRecord(envelope.display) ?? wfPermRecord(outer.display) ?? {};
  const toolName = (wfPermText(envelope.toolName) ?? wfPermText(outer.toolName) ?? '').toLowerCase();
  const holeRecord = wfPermRecord(input.hole);
  const fill = wfPermRecord(display.fill);
  const saved = wfPermRecord(input.saved);
  const predecessor = wfPermRecord(input.predecessor);
  const adjustable = wfPermRecord(input.adjustable_settings)
    ?? wfPermRecord(input.adjustableSettings)
    ?? wfPermRecord(input.adjustable)
    ?? {};
  const graph = wfPermRecord(display.causalityGraph)
    ?? wfPermRecord(input.causalityGraph)
    ?? wfPermRecord(outer.causalityGraph);
  const holeId = wfPermText(input.hole_id) ?? wfPermText(input.holeId) ?? wfPermText(holeRecord?.siteId) ?? wfPermText(fill?.siteId);
  const holeName = wfPermText(input.hole_name)
    ?? wfPermText(holeRecord?.name)
    ?? wfPermText(fill?.name)
    ?? wfPermText(display.name);
  const amendRunId = wfPermText(input.run_id) ?? wfPermText(input.runId);
  const script = wfPermText(input.script) ?? wfPermText(envelope.script) ?? '';
  const scriptName = wfPermText(input.name) ?? wfPermText(input.script_name) ?? wfPermText(envelope.name);
  const kind = holeId !== undefined || toolName === 'fillworkflowhole'
    ? 'hole'
    : toolName === 'amendworkflow' || amendRunId !== undefined || predecessor !== undefined
      ? 'amend'
      : 'create';
  const catalog = wfPermCatalog(envelope, outer, input);
  return {
    kind,
    sessionId: wfPermText(envelope.sessionId) ?? wfPermText(outer.sessionId) ?? '',
    runId: wfPermRunId(run),
    name: scriptName ?? holeName ?? '',
    scriptName,
    script,
    holeId,
    holeName,
    amendRunId,
    graph,
    graphTruncated: graph !== undefined && (graph.truncated === true || display.truncated === true),
    savedName: wfPermText(saved?.name),
    savedScope: wfPermText(saved?.scope) === 'global' ? 'global' : 'project',
    savedPath: wfPermText(saved?.path),
    savedArgs: wfPermRecord(saved?.args) ?? {},
    subagentModel: wfPermText(input.subagent_model) ?? wfPermText(input.subagentModel) ?? '',
    modelDefault: wfPermBool(input.subagent_model_default) ?? wfPermBool(input.subagentModelDefault) ?? false,
    maxConcurrency: wfPermLimit(input.max_concurrency) ?? wfPermLimit(input.maxConcurrency),
    ceiling: wfPermLimit(adjustable.concurrency_ceiling) ?? wfPermLimit(adjustable.concurrencyCeiling),
    modelEditable: wfPermBool(adjustable.subagent_model) === true || wfPermBool(adjustable.subagentModel) === true,
    predecessorStatus: wfPermText(predecessor?.status) ?? '',
    predecessorName: wfPermText(predecessor?.name) ?? '',
    predecessorLive: WF_PERM_LIVE.includes(wfPermText(predecessor?.status) ?? ''),
    scriptInherited: wfPermBool(predecessor?.script_inherited) === true
      || wfPermBool(predecessor?.scriptInherited) === true
      || (predecessor !== undefined && script === ''),
    catalog,
    status: wfPermText(outer.status) ?? '',
    currentPhase: wfPermText(outer.currentPhase) ?? '',
    phases: Array.isArray(outer.phases) ? outer.phases : [],
  };
}

function wfPermBool(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * The model list the dialog may offer, when the host published one.
 * @returns {{ id: string, label: string, efforts?: { id: string, label: string }[] }[]}
 */
function wfPermCatalog(envelope, outer, input) {
  const raw = envelope.models
    ?? envelope.modelCatalog
    ?? outer.models
    ?? outer.modelCatalog
    ?? input.models
    ?? input.model_catalog;
  if (!Array.isArray(raw)) return [];
  const rows = [];
  for (const entry of raw) {
    const record = wfPermRecord(entry);
    if (record === undefined) {
      const id = wfPermText(entry);
      if (id !== undefined) rows.push({ id, label: id });
      continue;
    }
    const id = wfPermText(record.id) ?? wfPermText(record.model) ?? wfPermText(record.value);
    if (id === undefined) continue;
    const label = wfPermText(record.label) ?? wfPermText(record.name) ?? id;
    const effortsRaw = Array.isArray(record.efforts) ? record.efforts : Array.isArray(record.levels) ? record.levels : [];
    const efforts = [];
    for (const effort of effortsRaw) {
      const effortRecord = wfPermRecord(effort);
      const effortId = effortRecord === undefined ? wfPermText(effort) : wfPermText(effortRecord.id) ?? wfPermText(effortRecord.value);
      if (effortId === undefined) continue;
      const effortLabel = effortRecord === undefined ? effortId : wfPermText(effortRecord.label) ?? effortId;
      efforts.push({ id: effortId, label: effortLabel });
    }
    rows.push({ id, label, ...(efforts.length === 0 ? {} : { efforts }) });
  }
  return rows;
}

/* ---------------------------------- graph ---------------------------------- */

const WF_PERM_LAMP_TONE = {
  done: 'done',
  running: 'running',
  failed: 'failed',
  pending: 'pending',
  ahead: 'ahead',
};

/**
 * Stations of the phase graph, with the steps each one owns.
 * @param {Record<string, any> | undefined} graph `display.causalityGraph`
 * @param {{ currentPhase: string, phases: any[] }} view
 */
function wfPermStations(graph, view) {
  const record = wfPermRecord(graph);
  const phases = record !== undefined && Array.isArray(record.phases) ? record.phases : [];
  const steps = record !== undefined && Array.isArray(record.steps) ? record.steps : [];
  const holes = record !== undefined && Array.isArray(record.holes) ? record.holes : [];
  const rows = [];
  const byphase = new Map();
  for (const phase of phases) {
    const phaseRecord = wfPermRecord(phase);
    if (phaseRecord === undefined) continue;
    const id = wfPermText(phaseRecord.id) ?? wfPermText(phaseRecord.name);
    if (id === undefined) continue;
    const name = wfPermText(phaseRecord.name) ?? id;
    const holeIds = [];
    if (Array.isArray(phaseRecord.alongside)) {
      for (const entry of phaseRecord.alongside) {
        const text = wfPermText(entry);
        if (text !== undefined) holeIds.push(text);
      }
    }
    const fillSite = wfPermText(phaseRecord.fill);
    const row = { id, name, holes: holeIds, fillSite, steps: [] };
    byphase.set(id, row);
    rows.push(row);
  }
  for (const step of steps) {
    const stepRecord = wfPermRecord(step);
    if (stepRecord === undefined) continue;
    const phaseId = wfPermText(stepRecord.phase);
    const target = phaseId === undefined ? undefined : byphase.get(phaseId);
    if (target === undefined) continue;
    target.steps.push({
      id: wfPermText(stepRecord.id) ?? '',
      kind: wfPermText(stepRecord.kind) ?? 'ask',
      label: wfPermText(stepRecord.label) ?? '',
      fill: wfPermText(stepRecord.fill),
    });
  }
  const index = rows.findIndex((row) => row.name === view.currentPhase || row.id === view.currentPhase);
  for (let position = 0; position < rows.length; position += 1) {
    const row = rows[position];
    const holeNames = [];
    for (const hole of holes) {
      const holeRecord = wfPermRecord(hole);
      if (holeRecord === undefined) continue;
      const phaseId = wfPermText(holeRecord.phase);
      if (phaseId !== row.id) continue;
      holeNames.push(wfPermText(holeRecord.name) ?? wfPermText(holeRecord.siteId) ?? '');
    }
    row.holeNames = holeNames;
    row.status = index === -1 ? 'ahead' : position < index ? 'done' : position === index ? 'running' : 'ahead';
  }
  return rows;
}

/**
 * Connectors of the graph: one arrow per phase edge, drawn in its own lane so nested jumps stay
 * readable. A stream between adjacent phases is a chevron in the gap instead of an arc.
 * @returns {{ from: number, to: number, back: boolean }[]}
 */
function wfPermEdges(graph) {
  const record = wfPermRecord(graph);
  if (record === undefined) return [];
  const phases = Array.isArray(record.phases) ? record.phases : [];
  const position = new Map();
  phases.forEach((phase, index) => {
    const phaseRecord = wfPermRecord(phase);
    const id = wfPermText(phaseRecord?.id) ?? wfPermText(phaseRecord?.name);
    if (id !== undefined) position.set(id, index);
  });
  const edges = [];
  const seen = new Set();
  const push = (fromRaw, toRaw, back) => {
    const from = wfPermText(fromRaw);
    const to = wfPermText(toRaw);
    if (from === undefined || to === undefined) return;
    const left = position.get(from);
    const right = position.get(to);
    if (left === undefined || right === undefined || left === right) return;
    const key = `${left}:${right}:${back === true ? 'back' : 'on'}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: Math.min(left, right), to: Math.max(left, right), back: back === true || right < left });
  };
  const phaseEdges = Array.isArray(record.phaseEdges) ? record.phaseEdges : [];
  for (const edge of phaseEdges) {
    const edgeRecord = wfPermRecord(edge);
    if (edgeRecord === undefined) continue;
    push(edgeRecord.from, edgeRecord.to, edgeRecord.back === true);
  }
  const streams = Array.isArray(record.phaseStreams) ? record.phaseStreams : [];
  for (const stream of streams) {
    const streamRecord = wfPermRecord(stream);
    if (streamRecord === undefined) continue;
    push(streamRecord.from, streamRecord.to, false);
  }
  return edges;
}

/** One chevron group: the stream marker drawn between two adjacent stations. */
function WfPermissionChevrons() {
  return WF_H('svg', {
    className: 'zwf-perm-chevrons',
    width: 16,
    height: 12,
    viewBox: '0 0 16 12',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
  WF_H('path', { d: 'M3 2.5 6.5 6 3 9.5', key: 'a' }),
  WF_H('path', { d: 'M7.5 2.5 11 6 7.5 9.5', key: 'b' }),
  WF_H('path', { d: 'M11.5 2.5 15 6 11.5 9.5', key: 'c' }));
}

/**
 * The phase graph: connectors above, one station head per phase, the phase's steps below.
 * @param {{ graph: Record<string, any> | undefined, view: object, variant: string, t: Function | undefined }} props
 */
function WfPermissionGraph(props) {
  const stations = React.useMemo(() => wfPermStations(props.graph, props.view), [props.graph, props.view]);
  const edges = React.useMemo(() => wfPermEdges(props.graph), [props.graph]);
  const compact = props.variant === 'block';
  if (stations.length === 0) return null;
  const lanes = edges.length === 0 ? 0 : Math.min(WF_PERM_LANES, edges.length);
  const arcHeight = lanes === 0 ? 0 : lanes * WF_PERM_LANE + WF_PERM_LANE_TOP;
  const width = stations.length * WF_PERM_PITCH - (WF_PERM_PITCH - WF_PERM_STATION);
  const arcs = [];
  if (arcHeight > 0) {
    edges.forEach((edge, index) => {
      if (edge.to - edge.from === 1 && edge.back !== true) return;
      const lane = index % lanes;
      const y = arcHeight - WF_PERM_LANE_TOP - lane * WF_PERM_LANE;
      const x1 = edge.from * WF_PERM_PITCH + 5;
      const x2 = edge.to * WF_PERM_PITCH + 5;
      const top = arcHeight;
      arcs.push(WF_H('path', {
        key: `arc-${edge.from}-${edge.to}-${String(index)}`,
        className: 'zwf-perm-arc',
        d: `M${x1} ${top} V${y + 3} Q${x1} ${y} ${x1 + 3} ${y} H${x2 - 3} Q${x2} ${y} ${x2} ${y + 3} V${top}`,
      }));
      arcs.push(WF_H('path', {
        key: `head-${edge.from}-${edge.to}-${String(index)}`,
        className: 'zwf-perm-arc-head',
        d: `M${x2 - 3} ${top - 5} L${x2} ${top} L${x2 + 3} ${top - 5}`,
      }));
    });
  }
  const columns = stations.map((station) => {
    const hole = station.holeNames !== undefined && station.holeNames.length > 0;
    const chips = station.steps.slice(0, compact ? 2 : WF_PERM_PIN);
    const rest = station.steps.length - chips.length;
    return WF_H('div', { className: 'zwf-perm-station', key: station.id, style: { width: `${WF_PERM_STATION}px` } },
      WF_H('div', { className: 'zwf-perm-station-head', style: { height: `${WF_PERM_ROW}px` } },
        WF_H('span', {
          className: `zwf-perm-lamp zwf-perm-lamp-${hole ? 'hole' : WF_PERM_LAMP_TONE[station.status] ?? 'ahead'}`,
          'data-testid': 'workflow-timeline-station-head',
        }),
        WF_H('span', { className: 'zwf-perm-station-name', title: station.name }, station.name)),
      chips.length === 0 && rest <= 0
        ? null
        : WF_H('div', { className: 'zwf-perm-pills' },
          chips.map((chip, chipIndex) => WF_H('span', {
            className: 'zwf-perm-pill',
            key: `${chip.id === '' ? String(chipIndex) : chip.id}`,
            title: chip.label,
          },
          WF_H('span', { className: 'zwf-perm-pill-glyph' }, chip.kind === 'ask' ? WF_H(WF_ICON.agent, { size: 12 }) : WF_H(WF_ICON.log, { size: 12 })),
          WF_H('span', { className: 'zwf-perm-pill-text' }, chip.kind === 'ask' && chip.label !== '' ? chip.label : wfPermSay(props.t, 'chat.permission.workflow.script')))),
          rest > 0
            ? WF_H('span', { className: 'zwf-perm-pill zwf-perm-pill-more', key: 'more' }, `+${String(rest)}`)
            : null));
  });
  return WF_H('div', { className: 'zwf-perm-graph' },
    WF_H('div', { className: 'zwf-perm-graph-scroll' },
      WF_H('div', { className: 'zwf-perm-graph-inner', style: { width: `${width}px` } },
        arcHeight === 0
          ? null
          : WF_H('svg', {
            className: 'zwf-perm-arcs',
            width: width,
            height: arcHeight,
            viewBox: `0 0 ${width} ${arcHeight}`,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1,
            strokeLinecap: 'round',
            'aria-hidden': 'true',
          }, arcs),
        WF_H('div', { className: 'zwf-perm-stations' },
          columns.map((column, index) => {
            const next = stations[index + 1];
            const stream = next !== undefined && edges.some((edge) => edge.from === index && edge.to === index + 1 && edge.back !== true);
            return WF_H(WF_FRAGMENT, { key: `cell-${stations[index].id}` },
              column,
              stream ? WF_H('span', { className: 'zwf-perm-gap' }, WF_H(WfPermissionChevrons)) : WF_H('span', { className: 'zwf-perm-gap' }));
          })))));
}

/* --------------------------------- settings -------------------------------- */

/**
 * The two settings the dialog may still change, or the two lines it only reports.
 * The draft lives in the surface so the submit control reads the same values these rows show.
 * @param {{ view: object, t: Function | undefined, initial: { model: string, bound: number | undefined }, draft: { model: string, bound: string }, onChange: Function }} props
 */
function WfPermissionSettings(props) {
  const view = props.view;
  const say = (key, params) => wfPermSay(props.t, key, params);
  const initial = props.initial;
  const model = props.draft.model;
  const bound = props.draft.bound;
  const setModel = (next) => props.onChange({ ...props.draft, model: next });
  const setBound = (next) => props.onChange({ ...props.draft, bound: next });
  const settingsRef = React.useRef(null);

  React.useEffect(() => {
    const root = settingsRef.current;
    if (root === null || typeof root.querySelectorAll !== 'function') return;
    const focusable = root.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)');
    const last = focusable[focusable.length - 1];
    if (last !== undefined && typeof last.focus === 'function') last.focus();
  }, []);

  const boundValue = wfPermLimit(bound);
  const boundChanged = boundValue !== initial.bound && !(boundValue === undefined && initial.bound === undefined);
  const modelChanged = model !== initial.model;
  const concurrency = boundValue;
  const modelRow = view.modelEditable === true && view.catalog.length > 0
    ? WF_H('p', { className: 'zwf-perm-settings-row', 'data-testid': 'workflow-permission-settings-model' },
      WF_H('span', { className: 'zwf-perm-settings-lead' }, say(view.modelDefault ? 'chat.permission.workflow.settings.model.leadDefault' : 'chat.permission.workflow.settings.model.lead')),
      WF_H('select', {
        className: 'zwf-perm-select',
        'data-testid': 'workflow-permission-settings-model-trigger',
        value: model,
        onChange: (event) => setModel(event.target.value),
      },
      // 首项永远是「沿用会话模型」：空值就是不给本次 run 指定模型（ZCode 的 session 项）。
      WF_H('option', { value: '', key: 'session' }, say('chat.permission.workflow.settings.model.noCatalog')),
      view.catalog.map((entry) => WF_H('option', { key: entry.id, value: entry.id }, entry.label))),
      model === '' || view.catalog.some((entry) => entry.id === model)
        ? null
        : WF_H('span', { className: 'zwf-perm-badge', 'data-testid': 'workflow-permission-settings-model-unavailable' }, say('chat.permission.workflow.settings.model.unavailable')))
    : WF_H('p', { className: 'zwf-perm-settings-row', 'data-testid': 'workflow-permission-subagent-model', title: say('chat.permission.workflow.settings.model.noCatalogReason') },
      view.modelEditable === true
        ? say(view.modelDefault ? 'chat.permission.workflow.settings.model.noCatalogDefault' : 'chat.permission.workflow.settings.model.noCatalog')
        : view.subagentModel === ''
          ? say('chat.permission.workflow.settings.model.noCatalog')
          : say(view.modelDefault ? 'chat.permission.workflow.subagentModelDefault' : 'chat.permission.workflow.subagentModel', { model: view.subagentModel }));

  const tail = view.ceiling === undefined
    ? say('chat.permission.workflow.settings.limit.none')
    : concurrency === view.ceiling
      ? say('chat.permission.workflow.settings.limit.atDefault')
      : say('chat.permission.workflow.settings.limit.default', { n: view.ceiling });
  const boundRow = view.ceiling === undefined && view.maxConcurrency === undefined
    ? WF_H('p', { className: 'zwf-perm-settings-row', 'data-testid': 'workflow-permission-max-concurrency' },
      say('chat.permission.workflow.settings.limit.none'))
    : WF_H('div', { className: 'zwf-perm-settings-row', 'data-testid': 'workflow-permission-settings-bound' },
      WF_H('span', { className: 'zwf-perm-settings-lead' }, say('chat.permission.workflow.settings.limit.lead')),
      WF_H('div', { className: 'zwf-perm-stepper' },
        WF_H('button', {
          type: 'button',
          className: 'zwf-perm-step',
          'data-testid': 'workflow-permission-settings-bound-decrease',
          'aria-label': say('chat.permission.workflow.settings.limit.decrease'),
          disabled: concurrency === undefined || concurrency <= 1,
          onClick: () => setBound(String(Math.max(1, (concurrency ?? 1) - 1))),
        }, '\u2212'),
        WF_H('input', {
          className: 'zwf-perm-bound',
          'data-testid': 'workflow-permission-settings-bound-value',
          type: 'text',
          inputMode: 'numeric',
          value: bound,
          placeholder: '\u2014',
          'aria-label': say('chat.permission.workflow.maxConcurrency', { count: concurrency ?? 0 }),
          onChange: (event) => {
            const next = event.target.value.replace(/[^0-9]/gu, '');
            setBound(next);
          },
          onKeyDown: (event) => {
            event.stopPropagation();
          },
        }),
        WF_H('button', {
          type: 'button',
          className: 'zwf-perm-step',
          'data-testid': 'workflow-permission-settings-bound-increase',
          'aria-label': say('chat.permission.workflow.settings.limit.increase'),
          // ceiling 是默认值而不是硬上限（ZCode 的加号只在无值时禁用）；真正的接纳上限由引擎钳制。
          disabled: concurrency === undefined,
          onClick: () => setBound(String((concurrency ?? 0) + 1)),
        }, '+')),
      WF_H('span', { className: 'zwf-perm-settings-trail' }, say('chat.permission.workflow.settings.limit.trail')),
      WF_H('span', { className: 'zwf-perm-settings-tail', 'data-testid': 'workflow-permission-settings-bound-tail' }, `\u00b7 ${tail}`),
      boundChanged
        ? WF_H('span', { className: 'zwf-perm-was' },
          `\u00b7 ${say('chat.permission.workflow.settings.was', { value: initial.bound === undefined ? say('chat.permission.workflow.settings.limit.none') : String(initial.bound) })}`,
          WF_H('button', {
            type: 'button',
            className: 'zwf-perm-reset',
            title: say('chat.permission.workflow.settings.reset'),
            'aria-label': say('chat.permission.workflow.settings.reset'),
            onClick: () => setBound(initial.bound === undefined ? '' : String(initial.bound)),
          }, WF_H(WF_ICON.refresh, { size: 12 })))
        : null);

  return WF_H('div', {
    className: 'zwf-perm-settings',
    'data-testid': 'workflow-permission-settings',
    ref: settingsRef,
  },
  modelRow,
  boundRow,
  modelChanged
    ? WF_H('p', { className: 'zwf-perm-was-row' },
      `\u00b7 ${say('chat.permission.workflow.settings.was', { value: initial.model === '' ? say('chat.permission.workflow.settings.model.noCatalog') : initial.model })}`,
      WF_H('button', {
        type: 'button',
        className: 'zwf-perm-reset',
        title: say('chat.permission.workflow.settings.reset'),
        'aria-label': say('chat.permission.workflow.settings.reset'),
        onClick: () => setModel(initial.model),
      }, WF_H(WF_ICON.refresh, { size: 12 })))
    : null);
}

/* --------------------------------- bodies ---------------------------------- */

/** Hole chips: every hole the script leaves for the agent to fill. */
function WfPermissionHoles(props) {
  const holes = Array.isArray(props.holes) ? props.holes : [];
  if (holes.length === 0) return null;
  return WF_H('div', { className: 'zwf-perm-holes', 'data-testid': 'workflow-permission-holes' },
    WF_H('span', { className: 'zwf-perm-holes-label' }, wfPermSay(props.t, 'chat.permission.workflow.holes.label')),
    holes.map((hole, index) => WF_H('span', {
      className: 'zwf-perm-hole',
      key: hole.id === undefined || hole.id === '' ? `hole-${String(index)}` : hole.id,
      'data-testid': 'workflow-permission-hole',
      'data-hole-id': hole.id,
      title: hole.name,
    },
    WF_H('span', { className: 'zwf-perm-hole-glyph' }, WF_H(WF_ICON.spark, { size: 14 })),
    WF_H('span', { className: 'zwf-perm-hole-name' }, hole.name === '' ? hole.id : hole.name))),
    WF_H('span', { className: 'zwf-perm-holes-note' }, wfPermSay(props.t, 'chat.permission.workflow.holes.note')));
}

/** The saved workflow the run was started from: name, path and the arguments it was given. */
function WfPermissionSaved(props) {
  const view = props.view;
  if (view.savedName === undefined) return null;
  const args = Object.entries(view.savedArgs);
  return WF_H('div', { className: 'zwf-perm-saved', 'data-testid': 'workflow-saved-source', 'data-workflow-saved-source': 'true' },
    WF_H('div', { className: 'zwf-perm-saved-head' },
      WF_H('span', { className: 'zwf-perm-saved-badge' }, wfPermSay(props.t, 'chat.permission.workflow.saved.badge')),
      WF_H('span', { className: 'zwf-perm-saved-scope' }, `\u00b7 ${wfPermSay(props.t, `chat.permission.workflow.saved.scope.${view.savedScope}`)}`),
      WF_H('span', { className: 'zwf-perm-saved-name', 'data-testid': 'workflow-saved-name', 'data-workflow-saved-name': 'true', title: view.savedName }, view.savedName)),
    view.savedPath === undefined
      ? null
      : WF_H('p', { className: 'zwf-perm-saved-path', 'data-testid': 'workflow-saved-path', 'data-workflow-saved-path': 'true', title: view.savedPath }, view.savedPath),
    args.length === 0
      ? null
      : WF_H('dl', { className: 'zwf-perm-saved-args', 'data-testid': 'workflow-saved-args', 'data-workflow-saved-args': 'true' },
        WF_H('dt', { key: 'label' }, wfPermSay(props.t, 'chat.permission.workflow.saved.args')),
        WF_H('dd', { key: 'values' }, args.map(([name, value]) => WF_H('code', { key: name, title: `${name} = ${wfPermArgText(value)}` },
          `${name}: ${wfPermArgText(value)}`)).reduce((left, right) => (left === null ? right : [left, WF_H('span', { key: `sep-${String(right.key)}`, className: 'zwf-perm-sep' }, '\u00b7'), right]), null))));
}

/** The amend notice: which run is replaced, whether it is live, and whether the script changed. */
function WfPermissionAmends(props) {
  const view = props.view;
  if (view.kind !== 'amend') return null;
  const id = view.amendRunId ?? view.predecessorName ?? '';
  return WF_H('div', { className: 'zwf-perm-amends', 'data-testid': 'workflow-amends', 'data-workflow-amends': 'true' },
    WF_H('span', { className: 'zwf-perm-amends-label' }, wfPermSay(props.t, 'chat.permission.workflow.amends')),
    id === '' ? null : WF_H('code', { className: 'zwf-perm-amends-id', title: id }, id),
    view.scriptInherited
      ? WF_H('span', { className: 'zwf-perm-amends-note', 'data-testid': 'workflow-amends-script-inherited', 'data-workflow-amends-script-inherited': 'true' },
        `\u00b7 ${wfPermSay(props.t, 'chat.permission.workflow.amends.scriptUnchanged')}`)
      : null,
    view.predecessorLive
      ? WF_H('span', { className: 'zwf-perm-amends-live', 'data-testid': 'workflow-amends-live', 'data-workflow-amends-live': 'true' },
        `\u00b7 ${wfPermSay(props.t, 'chat.permission.workflow.amends.running')}`)
      : null);
}

/** The folded script body. */
function WfPermissionScript(props) {
  const open = props.open;
  if (props.script === '') return null;
  const say = (key) => wfPermSay(props.t, key);
  return WF_H('div', { className: 'zwf-perm-script-wrap' },
    WF_H('button', {
      type: 'button',
      className: 'zwf-perm-script-toggle',
      'data-testid': 'workflow-script-toggle',
      'aria-expanded': open ? 'true' : 'false',
      onClick: () => props.onToggle(),
      onKeyDown: (event) => {
        event.stopPropagation();
      },
    },
    WF_H('span', { className: `zwf-perm-caret${open ? ' zwf-perm-caret-open' : ''}` }, WF_H(WF_ICON.chevronRight, { size: 13 })),
    WF_H('span', null, open ? say('chat.permission.workflow.hideScript') : say('chat.permission.workflow.showScript'))),
    open
      ? WF_H('div', { className: 'zwf-perm-script-body', 'data-testid': 'workflow-script-scroll' },
        WF_H('pre', { className: 'zwf-perm-script-code', 'data-testid': 'workflow-script-codeblock' }, props.script))
      : null);
}

/* -------------------------------- decisions -------------------------------- */

/**
 * Send one decision for a waiting run.
 * @param {{ sessionId: string, runId: string, optionId: string, freeText?: string, adjustments?: object }} answer
 */
async function wfPermissionAnswer(answer) {
  const body = {
    sessionId: answer.sessionId,
    runId: answer.runId,
    optionId: answer.optionId,
  };
  if (typeof answer.freeText === 'string' && answer.freeText !== '') body.freeText = answer.freeText;
  if (answer.adjustments !== undefined) body.adjustments = answer.adjustments;
  return WF_API.approveRun(body);
}

/** Failure copy for one rejected answer. */
function wfPermissionFailure(error) {
  const message = wfPermRecord(error) !== undefined && typeof error.message === 'string' && error.message !== ''
    ? error.message
    : typeof error === 'string' ? error : '';
  return message;
}

/* -------------------------------- the sheet -------------------------------- */

/**
 * One confirmation surface: the compact block inside a tool card, and the dialog it expands into.
 * @param {{ variant: 'block' | 'overlay', run: unknown, sessionId: string, t: Function | undefined, onClose?: Function, onDecided?: Function }} props
 */
function WfPermissionSheet(props) {
  const t = props.t;
  const say = (key, params) => wfPermSay(t, key, params);
  const view = React.useMemo(() => wfPermView(props.run), [props.run]);
  const stations = React.useMemo(() => wfPermStations(view.graph, view), [view]);
  const scriptOpenDefault = view.graph === undefined;
  const [scriptOpen, setScriptOpen] = React.useState(scriptOpenDefault);
  const [selected, setSelected] = React.useState(WF_PERM_OPTION_IDS[0]);
  const [refine, setRefine] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState(null);
  const [answered, setAnswered] = React.useState(undefined);
  const initial = React.useMemo(() => ({
    model: view.subagentModel,
    bound: view.maxConcurrency ?? view.ceiling,
  }), [view.subagentModel, view.maxConcurrency, view.ceiling]);
  const [draft, setDraft] = React.useState(() => ({
    model: initial.model,
    bound: initial.bound === undefined ? '' : String(initial.bound),
  }));
  React.useEffect(() => {
    setDraft({
      model: initial.model,
      bound: initial.bound === undefined ? '' : String(initial.bound),
    });
  }, [initial.model, initial.bound]);
  const listRef = React.useRef(null);
  const overlay = props.variant === 'overlay';

  const holes = React.useMemo(() => {
    const rows = [];
    for (const station of stations) {
      if (station.holeNames === undefined) continue;
      station.holeNames.forEach((name, index) => rows.push({ id: `${station.id}-${String(index)}`, name }));
    }
    return rows;
  }, [stations]);

  const sessionId = props.sessionId !== '' ? props.sessionId : view.sessionId;
  const runId = view.runId;
  const canSubmit = runId !== '' && sessionId !== '' && busy !== true && (selected !== 'workflowRefine' || refine.trim() !== '');

  const boundDraft = wfPermLimit(draft.bound);
  const modelChanged = draft.model !== initial.model;
  const boundChanged = boundDraft !== initial.bound && !(boundDraft === undefined && initial.bound === undefined);
  const changed = modelChanged || boundChanged;
  const adjustments = (() => {
    if (!changed) return undefined;
    const payload = {};
    // 选「沿用会话模型」时带 null：宿主据此清掉本次 run 的 subagent_model（ZCode 的 session 项同理）。
    if (view.modelEditable === true && modelChanged) payload.subagentModel = draft.model === '' ? null : draft.model;
    if (boundChanged && boundDraft !== undefined) payload.maxConcurrency = boundDraft;
    return Object.keys(payload).length === 0 ? undefined : payload;
  })();

  const submit = async (optionId) => {
    if (!canSubmit) return;
    setBusy(true);
    setFailure(null);
    try {
      await wfPermissionAnswer({
        sessionId,
        runId,
        optionId: optionId ?? selected,
        ...(selected === 'workflowRefine' ? { freeText: refine.trim() } : {}),
        ...(adjustments === undefined ? {} : { adjustments }),
      });
    } catch (error) {
      console.warn('zcode-workflow: answering the launch confirmation failed', error);
      setFailure(say('chat.permission.submitFailed', { reason: wfPermissionFailure(error) }));
      setBusy(false);
      return;
    }
    setBusy(false);
    setAnswered(optionId ?? selected);
    if (typeof props.onDecided === 'function') props.onDecided(optionId ?? selected);
  };

  const onListKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const index = WF_PERM_OPTION_IDS.indexOf(selected);
      const next = WF_PERM_OPTION_IDS[(index + step + WF_PERM_OPTION_IDS.length) % WF_PERM_OPTION_IDS.length];
      setSelected(next);
      const row = listRef.current?.querySelector(`[data-option-id="${next}"]`);
      if (row !== undefined && row !== null && typeof row.focus === 'function') row.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      void submit(selected);
    }
  };

  if (view.script === '' && stations.length === 0 && view.savedName === undefined && view.holeId === undefined && runId === '') {
    return null;
  }

  const titleKey = view.kind === 'hole'
    ? 'chat.permission.workflow.hole.title'
    : view.kind === 'amend'
      ? 'chat.permission.workflow.amend.title'
      : 'chat.permission.workflow.title';
  const displayName = view.kind === 'hole'
    ? view.holeName ?? view.name
    : view.name !== '' ? view.name : wfPermRunName(props.run);

  const header = WF_H('div', { className: 'zwf-perm-head' },
    WF_H('div', { className: 'zwf-perm-headline' },
      WF_H('span', { className: 'zwf-perm-glyph' }, WF_H(WF_ICON.workflow, { size: overlay ? 16 : 15 })),
      WF_H('span', { className: 'zwf-perm-title' }, say(titleKey)),
      displayName === undefined || displayName === ''
        ? null
        : WF_H('span', { className: 'zwf-perm-name', title: displayName }, displayName),
      WF_H('span', { className: 'zwf-perm-count' },
        say('chat.permission.workflow.stagesCount', { count: stations.length }),
        holes.length === 0 ? '' : ` \u00b7 ${say('chat.permission.workflow.holesCount', { count: holes.length })}`)),
    view.kind === 'hole' && view.holeName !== undefined
      ? WF_H('p', { className: 'zwf-perm-hole-target', 'data-testid': 'workflow-fill-hole-name' }, view.holeName)
      : null);

  if (answered !== undefined) {
    const answerKey = answered === 'allow_once'
      ? 'chat.permission.approve'
      : answered === 'allow_session'
        ? 'chat.permission.workflow.allowForSession'
        : answered === 'workflowRefine'
          ? 'chat.permission.workflow.refine'
          : 'chat.permission.deny';
    return WF_H('div', { className: `zwf-perm-sheet zwf-perm-sheet-${props.variant}` },
      header,
      WF_H('p', { className: 'zwf-perm-answered', role: 'status' },
        WF_H('span', { className: 'zwf-perm-lamp zwf-perm-lamp-running' }),
        WF_H('span', null, say(answerKey))));
  }

  const options = [
    {
      id: 'allow_once',
      label: say('chat.permission.approve'),
      description: say(changed ? 'chat.permission.workflow.allowOnce.adjusted' : 'chat.permission.allowOnce.description'),
    },
    {
      id: 'allow_session',
      label: say('chat.permission.workflow.allowForSession'),
      description: say(changed ? 'chat.permission.workflow.allowForSession.adjusted' : 'chat.permission.workflow.allowForSession.description'),
    },
    {
      id: 'deny',
      label: say('chat.permission.deny'),
      description: say('chat.permission.deny.description'),
    },
  ];

  const optionRows = options.map((option, index) => WF_H('button', {
    type: 'button',
    key: option.id,
    className: `zwf-perm-option${selected === option.id ? ' zwf-perm-option-active' : ''}`,
    role: 'radio',
    'aria-checked': selected === option.id,
    'data-option-id': option.id,
    tabIndex: selected === option.id ? 0 : -1,
    onClick: () => setSelected(option.id),
    onDoubleClick: () => {
      void submit(option.id);
    },
  },
  WF_H('span', { className: 'zwf-perm-option-index' }, String(index + 1)),
  WF_H('span', { className: 'zwf-perm-option-label' }, option.label),
  WF_H('span', { className: 'zwf-perm-option-desc' }, option.description)));

  optionRows.push(WF_H('div', {
    key: 'workflowRefine',
    className: `zwf-perm-option zwf-perm-option-refine${selected === 'workflowRefine' ? ' zwf-perm-option-active' : ''}`,
    role: 'radio',
    'aria-checked': selected === 'workflowRefine',
    'data-option-id': 'workflowRefine',
    tabIndex: selected === 'workflowRefine' ? 0 : -1,
    onClick: () => setSelected('workflowRefine'),
    onKeyDown: (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      setSelected('workflowRefine');
    },
  },
  WF_H('span', { className: 'zwf-perm-option-index' }, '4'),
  WF_H('span', { className: 'zwf-perm-option-label' }, say('chat.permission.workflow.refine')),
  WF_H('input', {
    className: 'zwf-perm-refine',
    type: 'text',
    value: refine,
    placeholder: say('chat.permission.workflow.refine.placeholder'),
    'aria-label': say('chat.permission.workflow.refine'),
    onChange: (event) => {
      setRefine(event.target.value);
      setSelected('workflowRefine');
    },
    onKeyDown: (event) => {
      event.stopPropagation();
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void submit('workflowRefine');
    },
  })));

  const body = WF_H('div', { className: `zwf-perm-body zwf-perm-body-${props.variant}` },
    WF_H(WfPermissionHoles, { holes, t }),
    WF_H(WfPermissionAmends, { view, t }),
    WF_H(WfPermissionSettings, { view, t, initial, draft, onChange: setDraft }),
    WF_H(WfPermissionSaved, { view, t }),
    WF_H(WfPermissionGraph, { graph: view.graph, view, variant: props.variant, t }),
    view.graphTruncated
      ? WF_H('p', { className: 'zwf-perm-truncated' }, say('chat.permission.workflow.graph.truncated'))
      : null,
    WF_H(WfPermissionScript, {
      script: view.script,
      open: scriptOpen,
      t,
      onToggle: () => setScriptOpen((value) => value !== true),
    }),
    WF_H('div', {
      className: 'zwf-perm-options',
      role: 'radiogroup',
      'aria-label': say(titleKey),
      ref: listRef,
      onKeyDown: onListKeyDown,
    }, optionRows),
    WF_H('div', { className: 'zwf-perm-foot' },
      WF_H('span', { className: 'zwf-perm-hint' },
        WF_H('span', { className: 'zwf-perm-hint-glyph' }, WF_H(WF_ICON.alert, { size: 13 })),
        WF_H('span', null, say('chat.permission.keyboardHint'))),
      failure === null ? null : WF_H('span', { className: 'zwf-perm-failure', role: 'alert' }, failure),
      WF_H(WF_UI.Button, {
        variant: 'primary',
        size: overlay ? 'md' : 'sm',
        disabled: !canSubmit,
        onClick: () => {
          void submit(selected);
        },
      }, say('chat.permission.confirm'))));

  return WF_H('div', { className: `zwf-perm-sheet zwf-perm-sheet-${props.variant}` }, header, body);
}

/* ------------------------------ card presence ------------------------------ */

/**
 * Runs whose confirmation block is mounted in a tool card right now.
 *
 * The block is the confirmation the user already has in front of them, so the launch watcher must
 * not ask the same question a second time as the dialog. Presence is ref-counted, because one run
 * can be rendered by more than one card; the dialog takes over only once the last of them is gone,
 * which is what keeps the question visible when the transcript drops or collapses the card.
 */
const WF_PERMISSION_BLOCKS = (() => {
  /** @type {Map<string, number>} runId -> number of mounted blocks */
  const counts = new Map();
  const listeners = new Set();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    onPage: (runId) => counts.has(runId),
    show(runId) {
      if (runId === '') return;
      const next = (counts.get(runId) ?? 0) + 1;
      counts.set(runId, next);
      if (next === 1) publish();
    },
    hide(runId) {
      const count = counts.get(runId) ?? 0;
      if (count === 0) return;
      if (count > 1) {
        counts.set(runId, count - 1);
        return;
      }
      counts.delete(runId);
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
})();

/**
 * Re-render a watcher whenever a card appears or disappears, so a run that is still pending when its
 * card goes away gets the dialog without waiting for the next poll.
 * @returns {number} a version that changes with every block transition
 */
function useWfPermissionBlockVersion() {
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => WF_PERMISSION_BLOCKS.subscribe(() => setVersion((value) => value + 1)), []);
  return version;
}

/**
 * The compact confirmation inside a workflow tool card.
 * @param {{ sessionId?: string, run?: unknown, t?: Function, onDecided?: Function }} props
 */
function WfPermissionBlock(props) {
  const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
  const runId = wfRunId(props?.run);
  React.useLayoutEffect(() => {
    if (runId === '') return undefined;
    WF_PERMISSION_BLOCKS.show(runId);
    return () => WF_PERMISSION_BLOCKS.hide(runId);
  }, [runId]);
  return WF_H('div', { className: 'zwf-perm-block', 'data-testid': 'workflow-permission-block', 'data-workflow-permission-block': 'true' },
    WF_H('div', { className: 'zwf-perm-block-label' },
      WF_H('span', { className: 'zwf-perm-block-glyph' }, WF_H(WF_ICON.alert, { size: 14 })),
      WF_H('span', null, wfPermSay(props?.t, 'chat.permission.title')),
      WF_H('span', { className: 'zwf-perm-block-status' }, wfPermSay(props?.t, 'chat.permission.awaitingApproval'))),
    WF_H(WfPermissionSheet, {
      variant: 'block',
      run: props?.run,
      sessionId,
      t: props?.t,
      onDecided: props?.onDecided,
    }));
}

/* --------------------------------- overlay --------------------------------- */

/** Which run, in which Session, the dialog is showing. */
const WF_PERMISSION_OVERLAY = (() => {
  let current;
  const listeners = new Set();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    read: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open(params) {
      current = params;
      publish();
    },
    close() {
      if (current === undefined) return;
      current = undefined;
      publish();
    },
  };
})();

function useWfPermissionTarget() {
  const [value, setValue] = React.useState(WF_PERMISSION_OVERLAY.read);
  React.useEffect(() => WF_PERMISSION_OVERLAY.subscribe(() => setValue(WF_PERMISSION_OVERLAY.read())), []);
  return value;
}

/**
 * The full-size dialog: the same confirmation, enlarged, over the whole shell.
 * @param {{ t?: Function }} props
 */
function WfPermissionOverlay(props) {
  const target = useWfPermissionTarget();
  const sessionId = wfPermText(target?.sessionId) ?? '';
  const runId = wfPermText(target?.runId) ?? '';
  const given = target?.run;
  const [state, setState] = React.useState({ phase: 'idle', run: undefined });
  const say = (key, params) => wfPermSay(props?.t, key, params);

  React.useEffect(() => {
    if (target === undefined) {
      setState({ phase: 'idle', run: undefined });
      return undefined;
    }
    if (given !== undefined) {
      setState({ phase: 'ready', run: given });
      return undefined;
    }
    let active = true;
    setState({ phase: 'loading', run: undefined });
    WF_API.runs({ sessionId, limit: 60 })
      .then((payload) => {
        if (!active) return;
        const rows = wfPermRecord(payload) !== undefined && Array.isArray(payload.runs) ? payload.runs : [];
        const found = rows.find((row) => wfPermRunId(row) === runId);
        setState(found === undefined ? { phase: 'missing', run: undefined } : { phase: 'ready', run: found });
      })
      .catch((error) => {
        console.warn('zcode-workflow: reading the pending confirmation failed', error);
        if (active) setState({ phase: 'missing', run: undefined });
      });
    return () => {
      active = false;
    };
  }, [target, given, sessionId, runId]);

  React.useEffect(() => {
    if (target === undefined) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      WF_PERMISSION_OVERLAY.close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [target]);

  if (target === undefined) return null;
  const close = () => WF_PERMISSION_OVERLAY.close();

  let content;
  if (state.phase === 'loading') {
    content = WF_H('div', { className: 'zwf-perm-overlay-note' }, WF_H(WF_UI.Spinner), WF_H('span', null, say('chat.permission.loading')));
  } else if (state.phase === 'ready') {
    content = WF_H(WfPermissionSheet, {
      variant: 'overlay',
      run: state.run,
      sessionId,
      t: props?.t,
      onDecided: () => close(),
    });
  } else if (state.phase === 'missing') {
    content = WF_H('div', { className: 'zwf-perm-overlay-note' }, say('chat.permission.notFound'));
  } else {
    content = null;
  }

  return WF_H('div', {
    className: 'zwf-perm-layer',
    onPointerDown: (event) => {
      if (event.target === event.currentTarget) close();
    },
  },
  WF_H('div', {
    className: 'zwf-perm-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': say('chat.permission.title'),
  },
  WF_H('div', { className: 'zwf-perm-dialog-head' },
    WF_H('span', { className: 'zwf-perm-dialog-title' }, say('chat.permission.title')),
    WF_H('span', { className: 'zwf-perm-dialog-badge' }, say('chat.permission.awaitingApproval')),
    WF_H(WF_UI.IconButton, {
      icon: WF_H(WF_ICON.close, { size: 15 }),
      label: say('chat.permission.close'),
      title: say('chat.permission.close'),
      onClick: close,
    })),
  WF_H('div', { className: 'zwf-perm-dialog-body' }, content)));
}

/* ------------------------------ registration ------------------------------- */

/**
 * Open the confirmation dialog for one run.
 * @param {{ sessionId: string, runId: string, run?: unknown }} params
 * @returns {boolean} false when the call lacks the identity the dialog needs
 */
WF_PERMISSION.open = function open(params) {
  const record = wfPermRecord(params);
  if (record === undefined) return false;
  const sessionId = wfPermText(record.sessionId) ?? '';
  const runId = wfPermText(record.runId) ?? wfPermRunId(record.run);
  if (sessionId === '' || runId === '') return false;
  WF_PERMISSION_OVERLAY.open({ sessionId, runId, run: record.run });
  return true;
};

/** Close the dialog without answering; the run keeps waiting for a decision. */
WF_PERMISSION.close = function close() {
  WF_PERMISSION_OVERLAY.close();
};

/** The compact block a tool card renders while a run waits for its confirmation. */
WF_PERMISSION.Block = WfPermissionBlock;

/* ------------------------------ launch watcher ---------------------------- */

/**
 * Launches this browser already put in front of the user. A launch stays pending until its tool call
 * settles, so without this the dialog would reopen on the next poll after the user closed it.
 * @type {Set<string>}
 */
const WF_PERMISSION_SHOWN = new Set();

/**
 * Put a launch that is waiting for the user in front of them.
 *
 * A launch is confirmed before it exists, so the only catalogue that carries it is the pending run
 * list; watching it means the dialog arrives even when the transcript is scrolled away from the tool
 * call that asked — which is what a blocking confirmation has to do.
 *
 * A card that renders the block already asks the question, so that run is left to its card and is
 * not marked as shown: when the card goes away the dialog still arrives for it.
 *
 * @param {{ sessionId?: string }} props slot props
 */
function WfLaunchWatcher(props) {
  const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
  const live = useWfCardRunById(sessionId, undefined);
  const runs = Array.isArray(live?.runs) ? live.runs : [];
  // A card leaving the page changes no run data, so its transitions drive this check too.
  const blockVersion = useWfPermissionBlockVersion();
  React.useEffect(() => {
    if (sessionId === '') return;
    const waiting = runs.filter((row) => wfRunStatus(row) === 'pending' && wfRunId(row) !== '');
    const current = WF_PERMISSION_OVERLAY.read();
    if (current !== undefined) {
      if (!waiting.some((row) => wfRunId(row) === current.runId)) WF_PERMISSION_OVERLAY.close();
      return;
    }
    for (const row of waiting) {
      const runId = wfRunId(row);
      if (WF_PERMISSION_BLOCKS.onPage(runId)) continue;
      if (WF_PERMISSION_SHOWN.has(runId)) continue;
      WF_PERMISSION_SHOWN.add(runId);
      WF_PERMISSION.open({ sessionId, runId, run: row });
      return;
    }
  }, [sessionId, runs, blockVersion]);
  return null;
}

/* ------------------------------ registration ------------------------------- */

/**
 * Register the dialog seat and bind the workspace dictionary.
 * @param {object} ctx client plugin context
 * @param {(callback: Function, label?: string) => unknown} effect effect registrar
 */
WF_PERMISSION.register = function register(ctx, effect) {
  if (ctx === null || typeof ctx !== 'object') return;
  if (ctx.locale !== undefined && ctx.locale !== null && typeof ctx.locale.bind === 'function') {
    try {
      WF_PERMISSION_UI = ctx.locale.bind(UI_NS);
    } catch (error) {
      console.warn('zcode-workflow: permission dictionary bind failed', error);
    }
  }
  if (typeof effect === 'function') {
    effect(() => () => WF_PERMISSION_OVERLAY.close(), 'zcode-workflow: launch confirmation');
  }
  const slots = ctx.slots;
  if (slots === undefined || slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;
  slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: 'zcode-workflow-permission',
    locale: UI_NS,
  }, WfPermissionOverlay));
  // The watcher renders nothing; it rides the session header so it is mounted for every conversation
  // and sees both the session id and the run catalogue the cards poll.
  slots.inject('conversation.session.header.utilities', () => slots.register({
    name: 'conversation.session.header.utilities',
    id: 'zcode-workflow-launch-watch',
    order: -5,
    locale: UI_NS,
  }, WfLaunchWatcher));
};

/* ---------------------------------- styles --------------------------------- */

const WF_PERMISSION_CSS = `
.zwf-perm-block{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1)}
.zwf-perm-block-label{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-perm-block-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-state-warn-primary)}
.zwf-perm-block-status{margin-left:auto;padding:0 7px;height:18px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:18px}
.zwf-perm-sheet{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;min-width:0}
.zwf-perm-head{display:flex;flex-direction:column;gap:4px;min-width:0}
.zwf-perm-headline{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.zwf-perm-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.zwf-perm-title{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap}
.zwf-perm-name{min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-perm-count{margin-left:auto;flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.zwf-perm-hole-target{margin:0;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.zwf-perm-body{display:flex;flex-direction:column;gap:10px;min-width:0}
.zwf-perm-holes{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;min-width:0}
.zwf-perm-holes-label{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-perm-hole{display:inline-flex;align-items:center;gap:6px;height:24px;max-width:100%;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.zwf-perm-hole-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.zwf-perm-hole-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-perm-holes-note{flex:1 1 100%;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-perm-amends{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-perm-amends-label{flex:none}
.zwf-perm-amends-id{min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;color:var(--dsw-alias-label-primary)}
.zwf-perm-amends-live{color:var(--dsw-alias-state-warn-primary)}
.zwf-perm-settings{display:flex;flex-direction:column;gap:5px;min-width:0}
.zwf-perm-settings-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:0;min-width:0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-primary)}
.zwf-perm-settings-lead{flex:none;color:var(--dsw-alias-label-secondary)}
.zwf-perm-settings-trail{flex:none;color:var(--dsw-alias-label-secondary)}
.zwf-perm-settings-tail{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.zwf-perm-select{box-sizing:border-box;max-width:260px;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.zwf-perm-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.zwf-perm-badge{flex:none;height:18px;padding:0 6px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:18px}
.zwf-perm-stepper{display:inline-flex;align-items:center;gap:2px;flex:none}
.zwf-perm-step{box-sizing:border-box;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.zwf-perm-step:hover:not(:disabled){background:color-mix(in oklab,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.zwf-perm-step:disabled{opacity:.4;cursor:default}
.zwf-perm-step:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-perm-bound{box-sizing:border-box;width:30px;height:24px;padding:0;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:20px;text-align:center;font-variant-numeric:tabular-nums}
.zwf-perm-bound:hover{border-color:var(--dsw-alias-border-l1)}
.zwf-perm-bound:focus{border-color:transparent;outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;background:var(--dsw-alias-bg-base)}
.zwf-perm-was,.zwf-perm-was-row{display:inline-flex;align-items:center;gap:4px;flex:none;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-perm-reset{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.zwf-perm-reset:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.zwf-perm-reset:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-perm-saved{display:flex;flex-direction:column;gap:4px;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2)}
.zwf-perm-saved-head{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:12px;line-height:18px}
.zwf-perm-saved-badge{flex:none;font-weight:500;color:var(--dsw-alias-label-secondary)}
.zwf-perm-saved-scope{flex:none;color:var(--dsw-alias-label-secondary)}
.zwf-perm-saved-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-primary)}
.zwf-perm-saved-path{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.zwf-perm-saved-args{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin:0;font-size:12px;line-height:18px;min-width:0}
.zwf-perm-saved-args dt{color:var(--dsw-alias-label-secondary)}
.zwf-perm-saved-args dd{display:flex;flex-wrap:wrap;gap:4px 6px;margin:0;min-width:0}
.zwf-perm-saved-args code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.zwf-perm-sep{color:var(--dsw-alias-label-secondary)}
.zwf-perm-graph{display:flex;flex-direction:column;min-width:0;padding:2px 0}
.zwf-perm-graph-scroll{overflow-x:auto;overflow-y:hidden;min-width:0}
.zwf-perm-graph-inner{display:flex;flex-direction:column;min-width:0}
.zwf-perm-arcs{display:block;color:var(--dsw-alias-border-l2)}
.zwf-perm-arc{stroke:currentColor;fill:none}
.zwf-perm-arc-head{stroke:currentColor;fill:none}
.zwf-perm-stations{display:flex;align-items:flex-start;min-width:0}
.zwf-perm-station{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;min-width:0;flex:none}
.zwf-perm-gap{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;color:var(--dsw-alias-label-secondary);opacity:.6}
.zwf-perm-chevrons{display:block}
.zwf-perm-station-head{display:flex;align-items:center;gap:7px;min-width:0}
.zwf-perm-station-name{min-width:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-perm-lamp{display:inline-block;flex:none;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.zwf-perm-lamp-running{background:var(--dsw-alias-state-warn-primary);animation:zwf-perm-pulse 1.6s ease-in-out infinite}
.zwf-perm-lamp-pending,.zwf-perm-lamp-ahead{background:transparent;border:1.5px solid var(--dsw-alias-border-l2)}
.zwf-perm-lamp-failed{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 2px color-mix(in oklab,var(--dsw-alias-state-error-primary) 28%,transparent)}
.zwf-perm-lamp-hole{background:transparent;border:1.5px dashed var(--dsw-alias-state-warn-primary)}
@keyframes zwf-perm-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.zwf-perm-pills{display:flex;flex-direction:column;gap:6px;min-width:0}
.zwf-perm-pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:26px;max-width:100%;padding:0 8px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-width:0}
.zwf-perm-pill-glyph{display:inline-flex;flex:none}
.zwf-perm-pill-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-perm-pill-more{justify-content:center;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);background:transparent}
.zwf-perm-truncated{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-perm-answered{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.zwf-perm-script-wrap{display:flex;flex-direction:column;gap:6px;min-width:0}
.zwf-perm-script-toggle{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;max-width:100%;padding:2px 0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;font-weight:500;cursor:pointer}
.zwf-perm-script-toggle:hover{color:var(--dsw-alias-label-primary)}
.zwf-perm-script-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:5px}
.zwf-perm-caret{display:inline-flex;flex:none;transition:transform .12s}
.zwf-perm-caret-open{transform:rotate(90deg)}
.zwf-perm-script-body{box-sizing:border-box;max-height:288px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:color-mix(in oklab,var(--dsw-alias-label-primary) 4%,transparent)}
.zwf-perm-script-code{margin:0;padding:9px 11px;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;white-space:pre;tab-size:2}
.zwf-perm-options{display:flex;flex-direction:column;gap:2px;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);padding:4px;background:var(--dsw-alias-bg-layer-1)}
.zwf-perm-option{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;min-width:0;min-height:34px;padding:6px 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.zwf-perm-option:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,transparent)}
.zwf-perm-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.zwf-perm-option-active{background:var(--dsw-alias-bg-layer-2)}
.zwf-perm-option-index{flex:none;width:16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.zwf-perm-option-label{flex:none;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap}
.zwf-perm-option-desc{min-width:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-perm-option-refine{flex-wrap:wrap;cursor:default}
.zwf-perm-option-refine:hover{background:transparent}
.zwf-perm-option-refine.zwf-perm-option-active{background:var(--dsw-alias-bg-layer-2)}
.zwf-perm-refine{box-sizing:border-box;flex:1 1 auto;min-width:120px;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:18px}
.zwf-perm-refine:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;border-color:transparent}
.zwf-perm-refine::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.zwf-perm-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.zwf-perm-hint{display:inline-flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-perm-hint-glyph{display:inline-flex;flex:none}
.zwf-perm-failure{flex:1 1 100%;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.zwf-perm-foot .zwf-btn:last-child{margin-left:auto}
.zwf-perm-layer{position:fixed;z-index:90;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1)}
.zwf-perm-dialog{box-sizing:border-box;display:flex;flex-direction:column;width:min(880px,100%);max-height:min(88vh,900px);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,14px);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent);overflow:hidden}
.zwf-perm-dialog-head{display:flex;align-items:center;gap:8px;flex:none;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.zwf-perm-dialog-title{flex:none;font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}
.zwf-perm-dialog-badge{flex:none;height:20px;padding:0 8px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:20px}
.zwf-perm-dialog-head .zwf-btn{margin-left:auto}
.zwf-perm-dialog-body{display:flex;flex-direction:column;gap:12px;min-height:0;overflow-y:auto;padding:14px 16px 18px}
.zwf-perm-overlay-note{display:flex;align-items:center;gap:8px;padding:12px 2px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
@media (prefers-reduced-motion:reduce){.zwf-perm-caret{transition:none}.zwf-perm-lamp-running{animation:none}}
@media (max-width:560px){.zwf-perm-option{flex-wrap:wrap}.zwf-perm-option-desc{flex:1 1 100%;white-space:normal}.zwf-perm-dialog{width:100%;max-height:92vh}}
`;

WF_STYLE_PARTS.push(WF_PERMISSION_CSS);
