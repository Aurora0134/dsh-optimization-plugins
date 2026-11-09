/* Shared React helpers, controls, icons and presentation rules for the workspace surfaces. */

const WF_H = React.createElement;
const WF_FRAGMENT = React.Fragment;

/* ---------------------------------- icons ---------------------------------- */

/**
 * One 16px line icon. The body is a list of SVG child specs so the same helper draws the whole set.
 * @param {Array<[string, Record<string, unknown>]>} body
 * @param {{ size?: number, className?: string, strokeWidth?: number } | undefined} options
 */
function wfIcon(body, options = {}) {
  const size = options.size ?? 16;
  const children = body.map(([tag, attrs], index) => WF_H(tag, { key: String(index), ...attrs }));
  return function WfIcon(props) {
    return WF_H('svg', {
      width: props?.size ?? size,
      height: props?.size ?? size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: props?.strokeWidth ?? options.strokeWidth ?? 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className: props?.className,
      'aria-hidden': 'true',
      focusable: 'false',
    }, children);
  };
}

const WF_ICON = {
  workflow: wfIcon([
    ['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 8.5, y: 14, width: 7, height: 7, rx: 1.5 }],
    ['path', { d: 'M6.5 10v2.5h11V10M12 12.5V14' }],
  ]),
  run: wfIcon([
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M10 8.8v6.4l5-3.2-5-3.2Z', fill: 'currentColor', stroke: 'none' }],
  ]),
  stop: wfIcon([['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2.5, fill: 'currentColor', stroke: 'none' }]]),
  refresh: wfIcon([
    ['path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }],
    ['path', { d: 'M20 4v4h-4' }],
  ]),
  chevronRight: wfIcon([['path', { d: 'm9 5 7 7-7 7' }]]),
  chevronDown: wfIcon([['path', { d: 'm5 9 7 7 7-7' }]]),
  close: wfIcon([['path', { d: 'M6 6l12 12M18 6 6 18' }]]),
  more: wfIcon([
    ['circle', { cx: 5, cy: 12, r: 1.6, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 12, cy: 12, r: 1.6, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 19, cy: 12, r: 1.6, fill: 'currentColor', stroke: 'none' }],
  ]),
  plus: wfIcon([['path', { d: 'M12 5v14M5 12h14' }]]),
  external: wfIcon([
    ['path', { d: 'M14 4h6v6' }],
    ['path', { d: 'M20 4 11 13' }],
    ['path', { d: 'M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4' }],
  ]),
  copy: wfIcon([
    ['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }],
    ['path', { d: 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1' }],
  ]),
  folder: wfIcon([['path', { d: 'M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9.5Z' }]]),
  globe: wfIcon([
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M3.5 12h17M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5s-1.1 6.2-3.3 8.5c-2.2-2.3-3.3-5.1-3.3-8.5S9.8 5.8 12 3.5Z' }],
  ]),
  file: wfIcon([
    ['path', { d: 'M6 3.5h7l5 5v12H6v-17Z' }],
    ['path', { d: 'M13 3.5v5h5' }],
  ]),
  image: wfIcon([
    ['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }],
    ['circle', { cx: 9, cy: 10, r: 1.6 }],
    ['path', { d: 'm4.5 17 4.7-4.5 3.3 3 2.6-2.4 4.4 3.9' }],
  ]),
  chart: wfIcon([
    ['path', { d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' }],
  ]),
  table: wfIcon([
    ['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }],
    ['path', { d: 'M3.5 9.5h17M9.5 9.5v10M15 9.5v10' }],
  ]),
  markdown: wfIcon([
    ['rect', { x: 3, y: 5.5, width: 18, height: 13, rx: 2 }],
    ['path', { d: 'M6.5 15V9l2.4 3 2.4-3v6M15 9v5M15 14l2-2 2 2' }],
  ]),
  check: wfIcon([['path', { d: 'm5 12.5 4.5 4.5L19 7' }]]),
  alert: wfIcon([
    ['path', { d: 'M12 3.5 21 20H3L12 3.5Z' }],
    ['path', { d: 'M12 9v5M12 17.2v.1' }],
  ]),
  clock: wfIcon([
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 7v5.2l3.4 2' }],
  ]),
  spark: wfIcon([
    ['path', { d: 'M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.2l-1.8-5.6L4.5 10.8 10.2 9 12 3.5Z' }],
  ]),
  agent: wfIcon([
    ['circle', { cx: 12, cy: 8, r: 3.5 }],
    ['path', { d: 'M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5' }],
  ]),
  log: wfIcon([
    ['path', { d: 'M5 5h14M5 9.5h14M5 14h9M5 18.5h6' }],
  ]),
  artifact: wfIcon([
    ['path', { d: 'M12 3.5 20 8v8l-8 4.5L4 16V8l8-4.5Z' }],
    ['path', { d: 'M4 8l8 4.5L20 8M12 12.5V20.5' }],
  ]),
};

/* --------------------------------- controls -------------------------------- */

/** Text of one locale key with the English dictionary as the fallback. */
function wfSay(translate, fallback, key, params) {
  let text;
  if (typeof translate === 'function') {
    try {
      text = translate(key, params);
    } catch {
      text = undefined;
    }
  }
  const resolved = typeof text === 'string' && text !== '' && text !== key ? text : (fallback[key] ?? key);
  if (params === undefined) return resolved;
  return resolved.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
}

function WFButton(props) {
  const variant = props.variant ?? 'ghost';
  const size = props.size ?? 'sm';
  const className = [
    'zwf-btn',
    `zwf-btn-${variant}`,
    `zwf-btn-${size}`,
    props.icon !== undefined ? 'zwf-btn-iconic' : '',
    props.className ?? '',
  ].filter(Boolean).join(' ');
  return WF_H('button', {
    type: props.type ?? 'button',
    className,
    disabled: props.disabled === true,
    title: props.title,
    'aria-label': props.ariaLabel,
    'aria-pressed': props.pressed,
    onClick: props.disabled === true ? undefined : props.onClick,
  }, props.icon !== undefined ? WF_H('span', { className: 'zwf-btn-glyph' }, props.icon) : null,
  props.children === undefined ? null : WF_H('span', { className: 'zwf-btn-label' }, props.children));
}

function WFIconButton(props) {
  return WF_H(WFButton, {
    variant: props.variant ?? 'ghost',
    size: 'icon',
    icon: props.icon,
    title: props.title,
    ariaLabel: props.label,
    disabled: props.disabled,
    onClick: props.onClick,
    className: props.className,
  });
}

function WFSpinner(props) {
  return WF_H('span', { className: `zwf-spinner${props?.inline === true ? ' zwf-spinner-inline' : ''}`, 'aria-hidden': 'true' });
}

function WFEmptyState(props) {
  return WF_H('div', { className: 'zwf-empty' },
    props.icon !== undefined ? WF_H('span', { className: 'zwf-empty-glyph' }, props.icon) : null,
    WF_H('p', { className: 'zwf-empty-title' }, props.title),
    props.body === undefined ? null : WF_H('p', { className: 'zwf-empty-body' }, props.body),
    props.action === undefined ? null : WF_H('div', { className: 'zwf-empty-action' }, props.action));
}

function WFErrorNotice(props) {
  return WF_H('div', { className: 'zwf-error', role: 'alert' },
    WF_H('span', { className: 'zwf-error-glyph' }, WF_H(WF_ICON.alert, { size: 15 })),
    WF_H('span', { className: 'zwf-error-text' }, props.message),
    props.onRetry === undefined ? null : WF_H(WFButton, { variant: 'ghost', size: 'sm', onClick: props.onRetry }, props.retryLabel ?? 'Retry'));
}

function WFStatusDot(props) {
  return WF_H('span', {
    className: `zwf-dot zwf-dot-${props.tone ?? 'idle'}`,
    'aria-hidden': 'true',
  });
}

function WFSectionHeader(props) {
  return WF_H('div', { className: 'zwf-section-head' },
    WF_H('h2', { className: 'zwf-section-title' }, props.title),
    props.count === undefined ? null : WF_H('span', { className: 'zwf-section-count' }, props.count),
    WF_H('span', { className: 'zwf-section-line' }),
    props.action === undefined ? null : props.action);
}

function WFModal(props) {
  React.useEffect(() => {
    if (props.open !== true) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && event.defaultPrevented !== true) {
        event.preventDefault();
        props.onClose?.();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [props.open, props.onClose]);
  if (props.open !== true) return null;
  return WF_H('div', { className: 'zwf-modal-layer', onClick: props.onClose },
    WF_H('div', {
      className: `zwf-modal${props.wide === true ? ' zwf-modal-wide' : ''}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': props.title,
      onClick: (event) => event.stopPropagation(),
    },
    WF_H('div', { className: 'zwf-modal-head' },
      WF_H('h2', { className: 'zwf-modal-title' }, props.title),
      WF_H(WFIconButton, { icon: WF_H(WF_ICON.close, { size: 15 }), label: props.closeLabel ?? 'Close', onClick: props.onClose })),
    WF_H('div', { className: 'zwf-modal-body' }, props.children),
    props.footer === undefined ? null : WF_H('div', { className: 'zwf-modal-foot' }, props.footer)));
}

function WFField(props) {
  return WF_H('label', { className: 'zwf-field' },
    WF_H('span', { className: 'zwf-field-label' }, props.label),
    props.hint === undefined ? null : WF_H('span', { className: 'zwf-field-hint' }, props.hint),
    props.children);
}

function WFInput(props) {
  return WF_H('input', {
    className: 'zwf-input',
    type: props.type ?? 'text',
    value: props.value ?? '',
    placeholder: props.placeholder,
    disabled: props.disabled === true,
    onChange: (event) => props.onChange?.(event.target.value),
    onKeyDown: props.onKeyDown,
    spellCheck: false,
  });
}

function WFTextarea(props) {
  return WF_H('textarea', {
    className: 'zwf-textarea',
    rows: props.rows ?? 4,
    value: props.value ?? '',
    placeholder: props.placeholder,
    disabled: props.disabled === true,
    onChange: (event) => props.onChange?.(event.target.value),
  });
}

function WFTabs(props) {
  return WF_H('div', { className: 'zwf-tabs', role: 'tablist' },
    props.tabs.map((tab) => WF_H('button', {
      key: tab.id,
      type: 'button',
      role: 'tab',
      'aria-selected': props.active === tab.id,
      className: `zwf-tab${props.active === tab.id ? ' zwf-tab-active' : ''}`,
      onClick: () => props.onChange?.(tab.id),
    }, tab.label)));
}

function WFMenu(props) {
  React.useEffect(() => {
    if (props.open !== true) return undefined;
    const onPointerDown = (event) => {
      if (props.anchorRef?.current?.contains(event.target) === true) return;
      if (props.menuRef?.current?.contains(event.target) === true) return;
      props.onClose?.();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') props.onClose?.();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [props.open, props.onClose, props.anchorRef, props.menuRef]);
  if (props.open !== true) return null;
  return WF_H('div', { className: 'zwf-menu', role: 'menu', ref: props.menuRef },
    props.items.map((item) => (item === null ? WF_H('div', { key: `sep-${Math.random()}`, className: 'zwf-menu-sep' }) : WF_H('button', {
      key: item.id,
      type: 'button',
      role: 'menuitem',
      className: `zwf-menu-item${item.danger === true ? ' zwf-menu-item-danger' : ''}`,
      disabled: item.disabled === true,
      onClick: () => {
        props.onClose?.();
        item.onSelect?.();
      },
    }, item.icon !== undefined ? WF_H('span', { className: 'zwf-menu-glyph' }, item.icon) : null, item.label))));
}

/* ----------------------------------- hooks --------------------------------- */

/** Poll a loader on an interval; the first result and every later one replace the current value. */
function useWfPolling(loader, deps, intervalMs) {
  const [state, setState] = React.useState({ data: undefined, error: undefined, loading: true });
  const [revision, setRevision] = React.useState(0);
  const loaderRef = React.useRef(loader);
  loaderRef.current = loader;
  React.useEffect(() => {
    let active = true;
    let timer;
    const tick = async () => {
      try {
        const data = await loaderRef.current();
        if (!active) return;
        setState({ data, error: undefined, loading: false });
      } catch (error) {
        if (!active) return;
        setState((current) => ({ data: current.data, error, loading: false }));
      }
      if (active) timer = setTimeout(tick, intervalMs);
    };
    setState((current) => ({ ...current, loading: true }));
    tick();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [...deps, revision, intervalMs]);
  const reload = React.useCallback(() => setRevision((value) => value + 1), []);
  return { ...state, reload };
}

/** Load once and expose a reload function; errors keep the previous value. */
function useWfAsync(loader, deps) {
  const [state, setState] = React.useState({ data: undefined, error: undefined, loading: true });
  const [revision, setRevision] = React.useState(0);
  const loaderRef = React.useRef(loader);
  loaderRef.current = loader;
  React.useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true }));
    Promise.resolve()
      .then(() => loaderRef.current())
      .then((data) => {
        if (active) setState({ data, error: undefined, loading: false });
      })
      .catch((error) => {
        if (active) setState((current) => ({ data: current.data, error, loading: false }));
      });
    return () => { active = false; };
  }, [...deps, revision]);
  const reload = React.useCallback(() => setRevision((value) => value + 1), []);
  return { ...state, reload };
}

/** The relative clock shared by list rows: re-render once a minute. */
function useWfClock() {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/* -------------------------------- formatting ------------------------------- */

const WF_STATUS_TONE = {
  pending: 'idle',
  running: 'success',
  completed: 'idle',
  errored: 'error',
  stopped: 'warn',
  superseded: 'idle',
  unknown: 'idle',
};

const WF_STATUS_KEYS = {
  pending: 'run.status.pending',
  running: 'run.status.running',
  completed: 'run.status.completed',
  errored: 'run.status.errored',
  stopped: 'run.status.stopped',
  superseded: 'run.status.superseded',
  unknown: 'run.status.unknown',
};

function wfStatusText(t, fallback, status) {
  return wfSay(t, fallback, WF_STATUS_KEYS[status] ?? 'run.status.unknown');
}

function wfDuration(from, to) {
  const start = Number(from);
  const end = Number(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function wfRelative(t, fallback, timestamp, now) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const diff = Math.max(0, Number(now ?? Date.now()) - value);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return wfSay(t, fallback, 'ui.justNow');
  if (minutes < 60) return wfSay(t, fallback, 'ui.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return wfSay(t, fallback, 'ui.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return wfSay(t, fallback, 'ui.daysAgo', { count: days });
}

function wfDate(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '';
  }
}

function wfFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function wfArtifactIcon(kind) {
  switch (kind) {
    case 'chart':
      return WF_ICON.chart;
    case 'table':
    case 'board':
      return WF_ICON.table;
    case 'markdown':
      return WF_ICON.markdown;
    case 'image':
      return WF_ICON.image;
    default:
      return WF_ICON.artifact;
  }
}

/** Copy JSON-ish values for display without throwing on cycles. */
function wfJson(value) {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

const WF_UI = {
  icons: WF_ICON,
  Button: WFButton,
  IconButton: WFIconButton,
  Spinner: WFSpinner,
  EmptyState: WFEmptyState,
  ErrorNotice: WFErrorNotice,
  StatusDot: WFStatusDot,
  SectionHeader: WFSectionHeader,
  Modal: WFModal,
  Field: WFField,
  Input: WFInput,
  Textarea: WFTextarea,
  Tabs: WFTabs,
  Menu: WFMenu,
  say: wfSay,
  statusText: wfStatusText,
  statusTone: (status) => WF_STATUS_TONE[status] ?? 'idle',
  duration: wfDuration,
  relative: wfRelative,
  date: wfDate,
  fileSize: wfFileSize,
  artifactIcon: wfArtifactIcon,
  json: wfJson,
};
