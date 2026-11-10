/*
 * Subagent presentation: the avatar face, the agent pill, the roster meter and its tallies.
 *
 * One pill implementation serves the phase rows, the rail columns and the expanded roster; the
 * only difference between the three seats is the pill size and where its trailing control sits.
 */

/** Nine avatar colours; a stable hash picks one when no index is recorded. */
const WF_AVATAR_COLORS = [
  '#54B9A6', '#F19D38', '#6464EF', '#885CF5', '#3C82F6', '#ED712E', '#EB4699', '#5BC67A', '#EA4045',
];

/** Status → expression, so a face reads as busy, finished or worried without a legend. */
const WF_FACE_EXPRESSION = {
  running: 'pill',
  done: 'happy',
  failed: 'sad',
  pending: 'dots',
};

/** Stable colour index from the actor name (same hash the product uses: `t = t * 31 + cp`). */
function wfAvatarIndex(name) {
  let hash = 0;
  const text = typeof name === 'string' ? name : '';
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.codePointAt(index)) % 360;
  return hash;
}

function wfAvatarColor(entry) {
  const index = wfNum(entry?.ordinal) ?? wfAvatarIndex(entry?.name);
  return WF_AVATAR_COLORS[Math.abs(index) % WF_AVATAR_COLORS.length];
}

/**
 * One 20×20 rounded face. Eyes only: the shape carries the colour, the eyes carry the state.
 * @param {{ name?: string, ordinal?: number, status?: string, size?: number, className?: string }} props
 */
function WfAgentFace(props) {
  const expression = WF_FACE_EXPRESSION[props.status] ?? 'dots';
  const color = wfAvatarColor(props);
  const eye = 'var(--zwf-face-eye)';
  const eyes = expression === 'pill'
    ? [
      WF_H('rect', { key: 'l', x: 6.2, y: 7.4, width: 2.1, height: 5.2, rx: 1.05, fill: eye }),
      WF_H('rect', { key: 'r', x: 11.7, y: 7.4, width: 2.1, height: 5.2, rx: 1.05, fill: eye }),
    ]
    : expression === 'happy'
      ? [
        WF_H('path', { key: 'l', d: 'M5.6 9.2c.7.9 2.1.9 2.8 0', stroke: eye, strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round' }),
        WF_H('path', { key: 'r', d: 'M11.6 9.2c.7.9 2.1.9 2.8 0', stroke: eye, strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round' }),
      ]
      : expression === 'sad'
        ? [
          WF_H('path', { key: 'l', d: 'M5.8 10.4 8.2 9', stroke: eye, strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round' }),
          WF_H('path', { key: 'r', d: 'M11.8 9 14.2 10.4', stroke: eye, strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round' }),
        ]
        : [
          WF_H('circle', { key: 'l', cx: 7, cy: 9.6, r: 1.05, fill: eye }),
          WF_H('circle', { key: 'm', cx: 12.9, cy: 9.6, r: 1.05, fill: eye }),
        ];
  return WF_H('svg', {
    className: props.className,
    width: props.size ?? 20,
    height: props.size ?? 20,
    viewBox: '0 0 20 20',
    'aria-hidden': 'true',
    focusable: 'false',
    'data-expression': expression,
    'data-avatar': color,
  },
  WF_H('rect', { key: 'body', width: 20, height: 20, rx: 7, fill: color }),
  ...eyes);
}

/** Status glyph inside a pill tail: spinner, check, cross or hollow ring. */
function WfPillStatus(props) {
  const status = props.status ?? 'pending';
  const tone = status === 'done' ? 'success' : status === 'failed' ? 'error' : status === 'running' ? 'brand' : 'idle';
  const glyph = status === 'running'
    ? WF_H(WF_UI.Spinner, { size: 12 })
    : status === 'done'
      ? WF_H(WF_UI.icons.check, { size: 12 })
      : status === 'failed'
        ? WF_H(WF_UI.icons.close, { size: 12 })
        : WF_H('span', { className: 'zwf-pill-ring' });
  return WF_H('span', {
    className: `zwf-pill-status zwf-pill-status-${tone}`,
    'data-testid': 'workflow-pill-status',
    'data-status': status,
    role: 'img',
    'aria-label': WF_UI.say(props.t, UI_EN, `graph.status.${status}`, undefined),
  }, glyph);
}

/**
 * The agent pill. `open` turns it into a button that reveals the actor's steps; without it the
 * pill is inert (a roster line that carries no destination).
 *
 * @param {{
 *   entry?: object, name?: string, status?: string, model?: string, asks?: number, reads?: number,
 *   asking?: boolean, size?: 'row' | 'full', trailing?: any, open?: { testId?: string, onOpen?: Function },
 *   t?: Function, className?: string,
 * }} props
 */
function WfAgentPill(props) {
  const entry = props.entry ?? {};
  const name = props.name ?? entry.name ?? WF_UI.say(props.t, UI_EN, 'graph.lane.anonymous');
  const status = props.status ?? entry.status ?? 'pending';
  const asks = props.asks ?? entry.asks;
  const reads = props.reads ?? entry.reads;
  const model = props.model ?? entry.model;
  const asking = props.asking ?? entry.asking === true;
  const size = props.size ?? 'row';
  const open = props.open;
  const extras = [];
  if (typeof props.reads === 'number' || typeof props.asks === 'number' || reads !== undefined || asks !== undefined) {
    const parts = [];
    if (asks !== undefined && asks > 0) {
      parts.push(WF_UI.say(props.t, UI_EN, 'graph.card.tasks', { count: asks }));
    }
    if (reads !== undefined && reads > 0) {
      parts.push(WF_UI.say(props.t, UI_EN, 'graph.card.reads', { count: reads }));
    }
    if (parts.length > 0) extras.push(WF_H('span', { key: 'cards', className: 'zwf-pill-note' }, parts.join(' · ')));
  }
  if (model !== undefined) {
    extras.push(WF_H('span', {
      key: 'model',
      className: 'zwf-pill-model zwf-mono',
      'data-testid': 'workflow-run-agent-model',
      title: model,
    }, model));
  }
  if (asking) {
    extras.push(WF_H('span', {
      key: 'asking',
      className: 'zwf-pill-asking',
      'data-testid': 'workflow-roll-asking',
      'aria-label': WF_UI.say(props.t, UI_EN, 'run.questions.title'),
    }, WF_H(WF_UI.icons.alert, { size: 12 })));
  }
  const showTail = status !== 'pending' || open !== undefined;
  const tail = showTail
    ? WF_H('span', {
      key: 'tail',
      className: 'zwf-pill-tail',
      'data-testid': 'workflow-pill-tail',
    },
    WF_H(WfPillStatus, { status, t: props.t }),
    open === undefined
      ? null
      : WF_H('span', {
        key: 'go',
        className: 'zwf-pill-go',
        'data-testid': open.testId ?? 'workflow-pill-open',
        role: 'img',
        'aria-label': WF_UI.say(props.t, UI_EN, 'timeline.openAgent', { name }),
        onClick: (event) => {
          event.stopPropagation();
          open.onOpen?.();
        },
      }, WF_H(WF_UI.icons.external, { size: 11 })))
    : null;
  const className = [
    'zwf-pill',
    'zwf-agent-pill',
    size === 'row' ? 'zwf-pill-row' : 'zwf-pill-full',
    open === undefined ? '' : 'zwf-pill-open',
    props.className ?? '',
  ].filter(Boolean).join(' ');
  const glyph = WF_H(WfAgentFace, { name: name ?? entry.name, ordinal: entry.ordinal, status, size: size === 'row' ? 14 : 16 });
  const body = [
    glyph,
    WF_H('span', { key: 'name', className: `zwf-pill-name${status === 'pending' ? ' zwf-pill-name-idle' : ''}` }, name),
    ...extras,
    tail,
    props.trailing === undefined ? null : WF_H('span', { key: 'trailing', className: 'zwf-pill-trailing' }, props.trailing),
  ];
  if (open === undefined) {
    return WF_H('span', {
      className,
      'data-testid': 'workflow-agent-pill',
      'data-agent-status': status,
      'data-pill-size': size,
      title: name,
    }, body);
  }
  return WF_H('button', {
    type: 'button',
    className,
    'data-testid': 'workflow-agent-pill',
    'data-agent-status': status,
    'data-pill-size': size,
    'data-agent-open': '',
    'data-agent-key': entry.key,
    'data-agent-session-id': entry.sessionId,
    title: name,
    'aria-label': name,
    onClick: () => open.onOpen?.(),
  }, body);
}

/** Up to three avatars plus `+n`, the collapsed phase cluster. */
function WfAvatarStack(props) {
  const entries = props.entries ?? [];
  const shown = entries.slice(0, props.max ?? 3);
  const rest = entries.length - shown.length;
  return WF_H('span', { className: 'zwf-avatar-stack' },
    shown.map((entry) => WF_H(WfAgentFace, {
      key: entry.key ?? `${entry.name}-${entry.ordinal}`,
      name: entry.name,
      ordinal: entry.ordinal,
      status: entry.status,
      size: 14,
      className: 'zwf-avatar-stacked',
    })),
    rest > 0 ? WF_H('span', { className: 'zwf-avatar-more zwf-mono' }, `+${rest}`) : null);
}

/**
 * The four-segment roster bar: done / failed / running / pending by width.
 * @param {{ counts: { done: number, failed: number, running: number, pending: number }, mini?: boolean }} props
 */
function WfRosterMeter(props) {
  const counts = props.counts ?? { done: 0, failed: 0, running: 0, pending: 0 };
  const order = ['done', 'failed', 'running', 'pending'];
  const total = order.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  return WF_H('span', {
    className: `zwf-meter4${props.mini === true ? ' zwf-meter4-mini' : ''}`,
    'data-testid': props.mini === true ? 'workflow-roster-meter-mini' : 'workflow-roster-meter',
    'aria-hidden': 'true',
  }, total === 0
    ? WF_H('span', { className: 'zwf-meter4-seg zwf-meter4-pending', style: { flexGrow: 1 } })
    : order
      .filter((key) => (counts[key] ?? 0) > 0)
      .map((key) => WF_H('span', {
        key,
        className: `zwf-meter4-seg zwf-meter4-${key}`,
        style: { flexGrow: counts[key] },
      })));
}

/** Per-status tallies shown to the right of the roster door. */
function WfRosterTally(props) {
  const counts = props.counts ?? { done: 0, failed: 0, running: 0, pending: 0 };
  const order = ['failed', 'running', 'pending', 'done'];
  return WF_H('span', { className: 'zwf-tally', 'data-testid': 'workflow-roster-tally' },
    order
      .filter((key) => (counts[key] ?? 0) > 0)
      .map((key) => WF_H('span', { key, className: `zwf-tally-item zwf-tally-${key}` },
        WF_H('span', { className: `zwf-dot zwf-dot-${key === 'done' ? 'success' : key === 'failed' ? 'error' : key === 'running' ? 'warn' : 'idle'}` }),
        WF_H('span', { className: 'zwf-mono' }, String(counts[key])))));
}

/** The roster door: the collapsed line that expands the rest of a phase's subagents. */
function WfRosterDoor(props) {
  const open = props.open === true;
  const total = props.total ?? 0;
  const label = WF_UI.say(props.t, UI_EN, open ? 'timeline.roster.door.fold' : 'timeline.roster.door.list', { count: total });
  return WF_H('button', {
    type: 'button',
    className: 'zwf-door',
    'data-testid': 'workflow-roster-more-row',
    'data-door': open ? 'open' : 'closed',
    'aria-expanded': open,
    onClick: () => props.onToggle?.(),
  },
  WF_H('span', { className: 'zwf-door-avatars' }, WF_H(WfAvatarStack, { entries: props.entries ?? [], max: 3 })),
  WF_H('span', { className: 'zwf-door-label' }, label),
  WF_H(WfRosterTally, { counts: props.counts ?? {} }),
  WF_H('span', { className: `zwf-door-chevron${open ? ' zwf-door-chevron-open' : ''}` }, WF_H(WF_UI.icons.chevronDown, { size: 13 })));
}

/**
 * The expanded roster: one heading per status group, then that group's pills.
 * @param {{ groups: { status: string, entries: object[] }[], t: Function, unlisted: number, onOpenEntry: Function }} props
 */
function WfRosterRoll(props) {
  const order = ['failed', 'running', 'pending', 'done'];
  const groups = order
    .map((status) => ({ status, entries: (props.groups ?? []).filter((group) => group.status === status).flatMap((group) => group.entries) }))
    .filter((group) => group.entries.length > 0);
  const heading = (status, count) => WF_H('div', {
    key: `head-${status}`,
    className: 'zwf-roll-heading',
    'data-testid': 'workflow-roll-heading',
    role: 'heading',
    'aria-level': 4,
  },
  WF_H('span', { className: `zwf-dot zwf-dot-${status === 'done' ? 'success' : status === 'failed' ? 'error' : status === 'running' ? 'warn' : 'idle'}` }),
  WF_H('span', { className: 'zwf-roll-count zwf-mono' }, String(count)),
  WF_H('span', { className: 'zwf-roll-label' }, WF_UI.say(props.t, UI_EN, `timeline.roster.${status}`, { count })),
  WF_H('span', { className: 'zwf-roll-rule' }));
  return WF_H('div', { className: 'zwf-roll', 'data-testid': 'workflow-roster-roll' },
    groups.map((group) => WF_H(WF_FRAGMENT, { key: group.status },
      heading(group.status, group.entries.length),
      group.entries.map((entry) => WF_H(WfAgentPill, {
        key: entry.key,
        entry,
        t: props.t,
        size: 'row',
        open: { testId: 'workflow-run-agent-open', onOpen: () => props.onOpenEntry?.(entry) },
      })))),
    (props.unlisted ?? 0) > 0
      ? WF_H('p', { className: 'zwf-roll-unlisted', 'data-testid': 'workflow-roll-unlisted' },
        WF_UI.say(props.t, UI_EN, props.unlisted === 1 ? 'timeline.roster.unlisted.one' : 'timeline.roster.unlisted.many', { count: props.unlisted }))
      : null);
}
