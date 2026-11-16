/*
 * The artifacts area of the run-detail pane.
 *
 * An artifact's body is not part of the run snapshot: the snapshot carries the declaration
 * (`spec`, `versions`, `itemCount`) and the bytes/rows live behind `/artifact/data` (report
 * items, paged by `afterSequence`) and `/artifact/read` (bytes, paged by `offset`). Each kind is
 * drawn from the data that actually describes it — table rows, chart points, metric tiles, board
 * columns, text lines, an image — and every kind keeps one honest fallback when the bytes or the
 * rows cannot be read.
 *
 * The area has two seats: the primary card inside the pane, and the preview sheet a tile or an
 * index row opens.
 */

/** Rows are read in pages of this size; the ledger caps one page at 500. */
const WF_ARTIFACT_PAGE = 200;
/** At most this many item pages, so a runaway artifact cannot hold the pane. */
const WF_ARTIFACT_MAX_PAGES = 20;
/** Bytes are read in the largest chunk the read route accepts. */
const WF_ARTIFACT_CHUNK = 512 * 1024;
/** Text and image previews stop reading past this many bytes. */
const WF_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
/** Lines one text preview keeps. */
const WF_ARTIFACT_MAX_LINES = 400;

/* --------------------------------- readers --------------------------------- */

/** One value from a report item by dot path. */
function wfFieldValue(item, path) {
  if (typeof path !== 'string' || path === '') return undefined;
  let value = item;
  for (const part of path.split('.')) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

/** Report items of one artifact, paged by `afterSequence` and de-duplicated by sequence. */
function useWfArtifactItems(scope, artifact, version, enabled) {
  const [state, setState] = React.useState({ items: [], loading: false, error: undefined, hasMore: false });
  const artifactId = artifact?.id;
  const key = [scope?.sessionId ?? '', scope?.runId ?? '', artifactId ?? '', version ?? '', enabled ? '1' : '0'].join('\u0000');
  React.useEffect(() => {
    if (enabled !== true || typeof artifactId !== 'string' || typeof scope?.runId !== 'string' || typeof scope?.sessionId !== 'string') {
      setState({ items: [], loading: false, error: undefined, hasMore: false });
      return undefined;
    }
    let cancelled = false;
    setState({ items: [], loading: true, error: undefined, hasMore: false });
    const read = async () => {
      const items = [];
      const seen = new Set();
      let afterSequence;
      for (let page = 0; page < WF_ARTIFACT_MAX_PAGES; page += 1) {
        const payload = await WF_API.artifactData({
          sessionId: scope.sessionId,
          runId: scope.runId,
          artifactId,
          afterSequence,
          limit: WF_ARTIFACT_PAGE,
        });
        if (cancelled) return;
        const rows = Array.isArray(payload?.items) ? payload.items : [];
        for (const row of rows) {
          const sequence = wfNum(row?.sequence) ?? 0;
          if (seen.has(sequence)) continue;
          seen.add(sequence);
          items.push({ sequence, value: row?.item ?? row?.fields ?? row });
        }
        if (payload?.hasMore !== true || rows.length === 0) {
          setState({ items, loading: false, error: undefined, hasMore: false });
          return;
        }
        afterSequence = wfNum(rows[rows.length - 1]?.sequence) ?? afterSequence;
      }
      setState({ items, loading: false, error: undefined, hasMore: true });
    };
    read().catch((error) => {
      if (!cancelled) setState({ items: [], loading: false, error, hasMore: false });
    });
    return () => { cancelled = true; };
  }, [key, enabled, artifactId, version, scope?.sessionId, scope?.runId]);
  return state;
}

/** Decode one UTF-8 chunk without assuming a whole character sits inside it. */
function wfDecodeBytes(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

/**
 * The bytes of one artifact version, read in chunks.
 * `url` is an object URL for image/html previews and is revoked when the version changes.
 */
function useWfArtifactBytes(scope, artifact, version, enabled) {
  const [state, setState] = React.useState({ bytes: undefined, total: undefined, truncated: false, loading: false, error: undefined, url: undefined });
  const artifactId = artifact?.id;
  const mediaType = artifact?.contentType;
  const key = [scope?.sessionId ?? '', scope?.runId ?? '', artifactId ?? '', version ?? '', enabled ? '1' : '0'].join('\u0000');
  React.useEffect(() => {
    if (enabled !== true || typeof artifactId !== 'string' || typeof scope?.runId !== 'string' || typeof scope?.sessionId !== 'string') {
      setState({ bytes: undefined, total: undefined, truncated: false, loading: false, error: undefined, url: undefined });
      return undefined;
    }
    let cancelled = false;
    let url;
    setState({ bytes: undefined, total: undefined, truncated: false, loading: true, error: undefined, url: undefined });
    const read = async () => {
      const chunks = [];
      let offset = 0;
      let total;
      let truncated = false;
      let type = mediaType;
      for (let page = 0; page < 64; page += 1) {
        const payload = await WF_API.artifactRead({
          sessionId: scope.sessionId,
          runId: scope.runId,
          artifactId,
          version,
          offset,
          limit: WF_ARTIFACT_CHUNK,
        });
        if (cancelled) return;
        if (type === undefined && typeof payload?.mediaType === 'string') type = payload.mediaType;
        const base64 = typeof payload?.dataBase64 === 'string' ? payload.dataBase64 : '';
        let bytes;
        try {
          const binary = atob(base64);
          bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        } catch {
          bytes = new Uint8Array(0);
        }
        chunks.push(bytes);
        offset += bytes.byteLength;
        total = wfNum(payload?.totalBytes) ?? total;
        if (offset >= WF_ARTIFACT_MAX_BYTES) {
          truncated = true;
          break;
        }
        const next = wfNum(payload?.nextOffset);
        if (next === undefined || next === null || bytes.byteLength === 0) break;
        offset = next;
      }
      const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      const textual = typeof type === 'string' && (/^text\//u.test(type) || type === 'application/json');
      const renderable = textual || (typeof type === 'string' && /^(?:image\/|text\/html)/u.test(type));
      if (renderable) {
        try {
          url = URL.createObjectURL(new Blob([bytes], { type: type ?? 'application/octet-stream' }));
        } catch {
          url = undefined;
        }
      }
      if (cancelled) {
        if (url !== undefined) URL.revokeObjectURL(url);
        return;
      }
      setState({ bytes, total: total ?? size, truncated, loading: false, error: undefined, url, mediaType: type });
    };
    read().catch((error) => {
      if (!cancelled) setState({ bytes: undefined, total: undefined, truncated: false, loading: false, error, url: undefined });
    });
    return () => {
      cancelled = true;
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [key, enabled, artifactId, version, mediaType, scope?.sessionId, scope?.runId]);
  return state;
}

/* -------------------------------- formatting ------------------------------- */

/** The kind label shown next to a title. */
function wfArtifactKindLabel(t, kind) {
  const known = ['file', 'markdown', 'chart', 'table', 'metrics', 'board', 'image', 'html'];
  const key = known.includes(kind) ? kind : 'file';
  return WF_UI.say(t, UI_EN, `run.artifacts.kind.${key}`);
}

/** Title, falling back to the id so a row is never nameless. */
function wfArtifactTitle(artifact) {
  return artifact.title ?? artifact.id;
}

/** Kinds drawn from a structured definition rather than from their bytes. */
const WF_ARTIFACT_PRESET_KINDS = ['table', 'chart', 'metrics', 'board'];

/**
 * Whether one structured artifact can be drawn at all.
 * The three states are the ones the pane distinguishes: no definition at all (`missing`), a
 * definition its kind cannot read (`invalid`), and a definition that renders even when it carries
 * no rows yet (`ok`). A missing or unreadable definition must never read as "no data".
 * @param {string} kind
 * @param {unknown} spec
 * @returns {'ok' | 'missing' | 'invalid'}
 */
function wfArtifactSpecState(kind, spec) {
  if (spec === undefined || spec === null) return 'missing';
  if (typeof spec !== 'object' || Array.isArray(spec)) return 'invalid';
  if (kind === 'chart') {
    const series = Array.isArray(spec.y) ? spec.y : [spec.y];
    const usable = series.filter((entry) => (typeof entry === 'string'
      ? entry !== ''
      : entry !== null && typeof entry === 'object' && typeof entry.field === 'string'));
    return usable.length === 0 ? 'invalid' : 'ok';
  }
  if (kind === 'metrics') {
    const declared = Array.isArray(spec.metrics) ? spec.metrics : [];
    const usable = declared.filter((entry) => (typeof entry === 'string'
      ? entry !== ''
      : entry !== null && typeof entry === 'object' && typeof entry.field === 'string'));
    return usable.length === 0 ? 'invalid' : 'ok';
  }
  if (kind === 'board') {
    return Array.isArray(spec.columns) && spec.columns.length > 0 ? 'ok' : 'invalid';
  }
  return 'ok';
}

/**
 * The version mark of an artifact: shown from the second version on, silent for the first one
 * because "v1" is what an unversioned artifact already means.
 * @param {{artifact: object, version?: number, t?: Function}} props
 */
function WfArtifactVersionMark(props) {
  const version = wfNum(props.version) ?? wfNum(props.artifact?.version) ?? 1;
  if (version < 2) return null;
  return WF_H('span', {
    className: 'zwf-artifact-chip-version zwf-mono',
    'data-testid': 'workflow-run-artifact-version',
    'data-version': String(version),
    title: WF_UI.say(props.t, UI_EN, 'run.artifacts.version', { version: String(version) }),
  }, WF_UI.say(props.t, UI_EN, 'run.artifacts.versionTail', { version: String(version) }));
}

/** One table cell: primitives as-is, everything else compact JSON. */
function wfArtifactCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return WF_UI.json(value).replace(/\s+/gu, ' ').slice(0, 200);
}

/** Declared columns of a table-like artifact, or the first row's keys. */
function wfArtifactFields(artifact, rows) {
  const declared = Array.isArray(artifact?.spec?.columns) ? artifact.spec.columns : [];
  const fields = declared
    .map((column) => (typeof column === 'string'
      ? { field: column }
      : column !== null && typeof column === 'object' && typeof column.field === 'string' ? column : undefined))
    .filter(Boolean);
  if (fields.length > 0) return fields;
  const found = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) if (!found.some((entry) => entry.field === key)) found.push({ field: key });
  }
  return found;
}

/* --------------------------------- pieces ---------------------------------- */

/** Version stepper: previous / `v n of m` / next. */
function WfArtifactStepper(props) {
  const { artifact, t, version, onVersion } = props;
  const versions = artifact.versions ?? [];
  if (versions.length <= 1) {
    return WF_H('span', { className: 'zwf-artifact-version zwf-mono', 'data-testid': 'workflow-artifact-version' },
      WF_UI.say(t, UI_EN, 'run.artifacts.versionTail', { version }));
  }
  const index = versions.findIndex((entry) => entry.version === version);
  const previous = versions[index - 1];
  const next = versions[index + 1];
  return WF_H('span', { className: 'zwf-artifact-stepper', 'data-testid': 'workflow-artifact-version-stepper' },
    WF_H('button', {
      type: 'button',
      className: 'zwf-artifact-chip',
      'data-testid': 'workflow-artifact-version-previous',
      disabled: previous === undefined,
      title: WF_UI.say(t, UI_EN, 'run.artifacts.previousVersion'),
      onClick: () => previous !== undefined && onVersion?.(previous.version),
    }, WF_H(WF_UI.icons.chevronRight, { size: 11, className: 'zwf-flip' })),
    WF_H('span', { className: 'zwf-artifact-version zwf-mono', 'data-testid': 'workflow-artifact-version' },
      WF_UI.say(t, UI_EN, 'run.artifacts.versionOf', { version, total: versions.length })),
    WF_H('button', {
      type: 'button',
      className: 'zwf-artifact-chip',
      'data-testid': 'workflow-artifact-version-next',
      disabled: next === undefined,
      title: WF_UI.say(t, UI_EN, 'run.artifacts.nextVersion'),
      onClick: () => next !== undefined && onVersion?.(next.version),
    }, WF_H(WF_UI.icons.chevronRight, { size: 11 })));
}

/** Download the bytes the preview already read. */
function wfDownloadBytes(bytes, fileName, mediaType) {
  if (bytes === undefined || bytes.byteLength === 0) return false;
  try {
    const url = URL.createObjectURL(new Blob([bytes], { type: mediaType ?? 'application/octet-stream' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch {
    return false;
  }
}

/**
 * The action row every preview carries: copy, save-as, open in a browser tab, open as a file and
 * the reveal affordance. Reveal needs a workspace route this client does not have, so it is
 * disabled with the reason instead of pretending.
 */
function WfArtifactActions(props) {
  const { artifact, t, bytes, text, url, now } = props;
  const say = (key, params) => WF_UI.say(t, UI_EN, key, params);
  const [copied, setCopied] = React.useState(false);
  const [failed, setFailed] = React.useState(undefined);
  const copy = () => {
    const value = text !== undefined ? text : `${artifact.sourcePath ?? artifact.id}`;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    try {
      void navigator.clipboard?.writeText(value).then(done).catch(done);
    } catch {
      done();
    }
  };
  const saveAs = () => {
    const name = artifact.sourcePath?.split('/').pop() ?? artifact.id;
    if (!wfDownloadBytes(bytes, name, artifact.mediaType ?? artifact.contentType)) setFailed(say('run.artifacts.openAsFileFailed'));
  };
  const openInBrowser = () => {
    if (url === undefined) {
      setFailed(say('run.artifacts.openAsFileFailed'));
      return;
    }
    try {
      window.open(url, '_blank', 'noopener');
    } catch {
      setFailed(say('run.artifacts.openAsFileFailed'));
    }
  };
  return WF_H('div', { className: 'zwf-artifact-actions' },
    WF_H('button', { type: 'button', className: 'zwf-link', 'data-testid': 'workflow-artifact-copy', onClick: copy },
      copied ? say('run.artifacts.copied') : say('run.artifacts.copy')),
    WF_H('button', { type: 'button', className: 'zwf-link', 'data-testid': 'workflow-artifact-save-as', onClick: saveAs },
      say('run.artifacts.saveAs')),
    WF_H('button', { type: 'button', className: 'zwf-link', 'data-testid': 'workflow-artifact-open-in-browser', disabled: url === undefined, onClick: openInBrowser },
      say('run.artifacts.openInBrowser')),
    WF_H('button', { type: 'button', className: 'zwf-link', 'data-testid': 'workflow-artifact-open-as-file', onClick: saveAs },
      say('run.artifacts.openAsFile')),
    WF_H('span', { className: 'zwf-artifact-menu', 'data-testid': 'workflow-artifact-open-as-file-menu' },
      WF_H('span', {
        className: 'zwf-artifact-menu-note',
        'data-testid': 'workflow-artifact-reveal',
        title: say('run.artifacts.revealUnsupported'),
      }, say('run.artifacts.reveal')),
      WF_H('span', {
        className: 'zwf-artifact-menu-note',
        'data-testid': 'workflow-artifact-open-as-file-reveal',
        title: say('run.artifacts.revealUnsupported'),
      }, say('run.artifacts.reveal'))),
    failed === undefined ? null : WF_H('span', { className: 'zwf-artifact-action-error' }, failed));
}

/** Table body from report items (or the declared inline items as a fallback). */
function WfArtifactTable(props) {
  const { artifact, t, items } = props;
  const rows = items.length > 0 ? items.map((entry) => entry.value) : wfArtifactRows(artifact);
  if (rows.length === 0) {
    return WF_H('div', { className: 'zwf-artifact-empty', 'data-testid': 'workflow-run-artifact-items' },
      WF_H('span', { className: 'zwf-artifact-empty-text' }, WF_UI.say(t, UI_EN, 'run.artifacts.preset.empty')));
  }
  const fields = wfArtifactFields(artifact, rows).slice(0, 8);
  const body = rows.slice(0, 200).map((row, index) => WF_H('tr', { key: String(index) },
    fields.map((field) => WF_H('td', { key: field.field },
      wfArtifactCell(field.field === undefined ? row : wfFieldValue(row, field.field))))));
  return WF_H('div', { className: 'zwf-artifact-table', 'data-testid': 'workflow-run-artifact-items' },
    WF_H('table', null,
      WF_H('thead', null, WF_H('tr', null, fields.map((field) => WF_H('th', { key: field.field }, field.label ?? field.field)))),
      WF_H('tbody', null, body)));
}

/** Line/bar chart drawn from report items and the declared x/y fields. */
function WfArtifactChart(props) {
  const { artifact, t, items } = props;
  const spec = artifact.spec ?? {};
  const xField = typeof spec.x === 'string' ? spec.x : spec.x?.field;
  const series = (Array.isArray(spec.y) ? spec.y : [spec.y])
    .map((entry) => (typeof entry === 'string' ? { field: entry } : entry))
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.field === 'string');
  const points = items
    .map((entry) => ({
      label: xField === undefined ? String(entry.sequence) : String(wfFieldValue(entry.value, xField) ?? entry.sequence),
      values: series.map((line) => wfNum(wfFieldValue(entry.value, line.field))),
    }))
    .filter((point) => point.values.some((value) => value !== undefined));
  if (series.length === 0) return null;
  if (points.length === 0) {
    return WF_H('div', { className: 'zwf-artifact-empty', 'data-testid': 'workflow-run-artifact-items' },
      WF_H('span', { className: 'zwf-artifact-empty-text' }, WF_UI.say(t, UI_EN, 'run.artifacts.preset.empty')));
  }
  const width = 320;
  const height = 120;
  const values = points.flatMap((point) => point.values.filter((value) => value !== undefined));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min === 0 ? 1 : max - min;
  const x = (index) => (points.length === 1 ? width / 2 : (index / (points.length - 1)) * (width - 8) + 4);
  const y = (value) => height - 6 - ((value - min) / span) * (height - 16);
  const colors = ['var(--dsw-alias-brand-primary)', 'var(--dsw-alias-state-success-primary)', 'var(--dsw-alias-state-warn-primary)'];
  const barMode = spec.type === 'bar';
  return WF_H('div', { className: 'zwf-artifact-chart', 'data-testid': 'workflow-artifact-chart' },
    WF_H('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': wfArtifactTitle(artifact) },
      series.map((line, lineIndex) => (barMode
        ? points.map((point, index) => {
          const value = point.values[lineIndex];
          if (value === undefined) return null;
          const barWidth = Math.max(2, (width - 8) / Math.max(1, points.length) - 2);
          return WF_H('rect', {
            key: `${line.field}-${index}`,
            x: x(index) - barWidth / 2,
            y: y(value),
            width: barWidth,
            height: Math.max(1, height - 6 - y(value)),
            rx: 1.5,
            fill: colors[lineIndex % colors.length],
            opacity: 0.85,
          });
        })
        : WF_H('path', {
          key: line.field,
          d: points.map((point, index) => {
            const value = point.values[lineIndex];
            if (value === undefined) return '';
            return `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)} ${y(value).toFixed(1)}`;
          }).join(' '),
          fill: 'none',
          stroke: colors[lineIndex % colors.length],
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
        }))),
      WF_H('path', { d: `M4 ${height - 6}H${width - 4}`, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1, fill: 'none' })),
    WF_H('div', { className: 'zwf-artifact-chart-legend' },
      series.map((line, index) => WF_H('span', { key: line.field, className: 'zwf-artifact-chart-key' },
        WF_H('span', { className: 'zwf-artifact-chart-dot', style: { background: colors[index % colors.length] } }),
        line.label ?? line.field))),
    WF_H('span', { className: 'zwf-artifact-chart-range zwf-mono' }, `${min} … ${max}`));
}

/** Metric tiles: the newest value each declared field carries. */
function WfArtifactMetrics(props) {
  const { artifact, t, items } = props;
  const declared = Array.isArray(artifact.spec?.metrics) ? artifact.spec.metrics : [];
  const metrics = declared
    .map((entry) => (typeof entry === 'string' ? { field: entry } : entry))
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.field === 'string');
  const latest = {};
  for (const entry of items) {
    for (const metric of metrics) {
      const value = wfFieldValue(entry.value, metric.field);
      if (value !== undefined && value !== null) latest[metric.field] = value;
    }
  }
  if (metrics.length === 0) return null;
  return WF_H('div', { className: 'zwf-artifact-metrics', 'data-testid': 'workflow-run-artifact-items' },
    metrics.map((metric) => WF_H('div', { key: metric.field, className: 'zwf-artifact-metric' },
      WF_H('span', { className: 'zwf-artifact-metric-label' }, metric.label ?? metric.field),
      WF_H('span', { className: 'zwf-artifact-metric-value zwf-mono' },
        latest[metric.field] === undefined ? '—' : String(latest[metric.field]),
        metric.unit === undefined ? null : WF_H('span', { className: 'zwf-artifact-metric-unit' }, metric.unit)))));
}

/** Board: one column per declared status, one card per report item. */
function WfArtifactBoard(props) {
  const { artifact, t, items } = props;
  const spec = artifact.spec ?? {};
  const columns = Array.isArray(spec.columns) ? spec.columns.map(String) : [];
  const statusField = typeof spec.status === 'string' ? spec.status : 'status';
  const titleField = typeof spec.cardTitle === 'string' ? spec.cardTitle : spec.key;
  const groups = new Map(columns.map((column) => [column, []]));
  const other = [];
  for (const entry of items) {
    const status = String(wfFieldValue(entry.value, statusField) ?? '');
    const card = {
      key: String(wfFieldValue(entry.value, typeof spec.key === 'string' ? spec.key : 'id') ?? entry.sequence),
      title: titleField === undefined ? undefined : wfFieldValue(entry.value, titleField),
      item: entry.value,
    };
    if (groups.has(status)) groups.get(status).push(card);
    else other.push(card);
  }
  const otherLabel = WF_UI.say(t, UI_EN, 'run.artifacts.preset.otherColumn');
  if (columns.length === 0) return null;
  const renderCard = (card) => WF_H('div', { key: card.key, className: 'zwf-artifact-card' },
    WF_H('span', { className: 'zwf-artifact-card-title' },
      card.title === undefined ? card.key : String(card.title)));
  const renderColumn = (label, cards) => WF_H('div', { key: label, className: 'zwf-artifact-column' },
    WF_H('div', { className: 'zwf-artifact-column-head' },
      WF_H('span', { className: 'zwf-artifact-column-name' }, label),
      WF_H('span', { className: 'zwf-artifact-column-count zwf-mono' }, String(cards.length))),
    cards.map(renderCard));
  if (items.length === 0) {
    return WF_H('div', { className: 'zwf-artifact-empty', 'data-testid': 'workflow-run-artifact-items' },
      WF_H('span', { className: 'zwf-artifact-empty-text' }, WF_UI.say(t, UI_EN, 'run.artifacts.preset.empty')));
  }
  return WF_H('div', { className: 'zwf-artifact-board', 'data-testid': 'workflow-run-artifact-items' },
    columns.map((column) => renderColumn(column, groups.get(column) ?? [])),
    other.length > 0 ? renderColumn(otherLabel, other) : null);
}

/** Text preview with line numbers; long bodies are cut with a note. */
function WfArtifactText(props) {
  const { t, text, truncated } = props;
  const lines = text.split('\n');
  const shown = lines.slice(0, WF_ARTIFACT_MAX_LINES);
  return WF_H(WF_FRAGMENT, null,
    WF_H('ol', { className: 'zwf-artifact-lines', 'data-testid': 'workflow-artifact-preview-body' },
      shown.map((line, index) => WF_H('li', { key: String(index), className: 'zwf-artifact-line', 'data-testid': 'workflow-artifact-line' },
        WF_H('span', { className: 'zwf-artifact-line-no zwf-mono' }, String(index + 1)),
        WF_H('span', { className: 'zwf-artifact-line-text', 'data-testid': 'workflow-artifact-line-detail' }, line)))),
    lines.length > shown.length || truncated === true
      ? WF_H('p', { className: 'zwf-artifact-more', 'data-testid': 'workflow-artifact-more-line' },
        WF_UI.say(t, UI_EN, 'run.artifacts.truncated', { shown: shown.length, total: lines.length }))
      : null);
}

/**
 * The preview body for one artifact version.
 * @param {{ artifact: object, t: Function, scope: object, version: number, enabled: boolean }} props
 */
function WfArtifactPreview(props) {
  const { artifact, t, scope, version, enabled } = props;
  const kind = artifact.kind;
  const wantsItems = WF_ARTIFACT_PRESET_KINDS.includes(kind);
  const wantsBytes = ['file', 'markdown', 'image', 'html'].includes(kind);
  const specState = wantsItems ? wfArtifactSpecState(kind, artifact.spec) : 'ok';
  const items = useWfArtifactItems(scope, artifact, version, enabled === true && wantsItems && specState === 'ok');
  const bytes = useWfArtifactBytes(scope, artifact, version, enabled === true && wantsBytes);
  const say = (key, params) => WF_UI.say(t, UI_EN, key, params);
  const mediaType = bytes.mediaType ?? artifact.contentType;
  const textual = typeof mediaType === 'string' && (/^text\//u.test(mediaType) || mediaType === 'application/json');
  const text = wantsBytes && textual && bytes.bytes !== undefined ? wfDecodeBytes(bytes.bytes) : undefined;
  let body;
  if (wantsItems) {
    if (specState === 'missing') {
      body = WF_H('p', {
        className: 'zwf-artifact-empty-text',
        'data-testid': 'workflow-run-artifact-preset-missing',
      }, say('run.artifacts.unavailable'));
    } else if (specState === 'invalid') {
      body = WF_H('p', {
        className: 'zwf-artifact-empty-text',
        'data-testid': 'workflow-run-artifact-preset-invalid',
      }, say('run.artifacts.presetInvalid'));
    } else if (items.loading && items.items.length === 0) {
      body = WF_H('div', { className: 'zwf-artifact-empty', 'data-testid': 'workflow-artifact-loading' },
        WF_H(WF_UI.Spinner, { inline: true }),
        WF_H('span', { className: 'zwf-artifact-empty-text', 'data-testid': 'workflow-artifact-preview-pending' }, say('run.artifacts.loading')));
    } else if (items.error !== undefined) {
      body = WF_H('div', { className: 'zwf-artifact-empty zwf-artifact-empty-error', 'data-testid': 'workflow-artifact-error' },
        WF_H('span', { className: 'zwf-artifact-empty-text' }, say('run.artifacts.loadError')),
        WF_H('pre', { className: 'zwf-artifact-error-detail' }, wfText(items.error.message) ?? ''));
    } else if (kind === 'chart') {
      body = WF_H(WfArtifactChart, { artifact, t, items: items.items });
    } else if (kind === 'metrics') {
      body = WF_H(WfArtifactMetrics, { artifact, t, items: items.items });
    } else if (kind === 'board') {
      body = WF_H(WfArtifactBoard, { artifact, t, items: items.items });
    } else {
      body = WF_H(WfArtifactTable, { artifact, t, items: items.items });
    }
  } else if (bytes.loading) {
    body = WF_H('div', { className: 'zwf-artifact-empty', 'data-testid': 'workflow-artifact-loading' },
      WF_H(WF_UI.Spinner, { inline: true }),
      WF_H('span', { className: 'zwf-artifact-empty-text', 'data-testid': 'workflow-artifact-preview-pending' }, say('run.artifacts.loading')));
  } else if (bytes.error !== undefined) {
    body = WF_H('div', { className: 'zwf-artifact-empty zwf-artifact-empty-error', 'data-testid': 'workflow-artifact-error' },
      WF_H('span', { className: 'zwf-artifact-empty-text' }, say('run.artifacts.missing')),
      WF_H('pre', { className: 'zwf-artifact-error-detail' }, wfText(bytes.error.message) ?? ''));
  } else if (kind === 'image') {
    body = bytes.url === undefined
      ? WF_H('div', { className: 'zwf-artifact-empty', 'data-testid': 'workflow-artifact-unsupported' },
        WF_H('span', { className: 'zwf-artifact-empty-text' }, say('run.artifacts.unsupported')))
      : WF_H('img', {
        className: 'zwf-artifact-image',
        'data-testid': 'workflow-artifact-image',
        src: bytes.url,
        alt: wfArtifactTitle(artifact),
      });
  } else if (kind === 'html') {
    body = WF_H('div', { className: 'zwf-artifact-html', 'data-testid': 'workflow-artifact-html-card' },
      WF_H('span', { className: 'zwf-artifact-html-glyph' }, WF_H(WF_UI.icons.globe, { size: 15 })),
      WF_H('p', { className: 'zwf-artifact-html-note' }, say('run.artifacts.htmlPaused')),
      WF_H('button', {
        type: 'button',
        className: 'zwf-btn zwf-btn-subtle zwf-btn-sm',
        'data-testid': 'workflow-artifact-html-reveal',
        disabled: bytes.url === undefined,
        onClick: () => {
          try {
            window.open(bytes.url, '_blank', 'noopener');
          } catch {
            // The action is best effort; the pane stays readable when a popup is blocked.
          }
        },
      }, say('run.artifacts.openInBrowser')));
  } else if (text !== undefined) {
    body = WF_H(WfArtifactText, { t, text, truncated: bytes.truncated });
  } else {
    body = WF_H('div', { className: 'zwf-artifact-empty', 'data-testid': 'workflow-artifact-unsupported' },
      WF_H('span', { className: 'zwf-artifact-empty-text' }, say('run.artifacts.unsupported')),
      WF_H('span', { className: 'zwf-artifact-placeholder', 'data-testid': 'workflow-artifact-placeholder' }, say('run.artifacts.localOnly')),
      WF_H('span', { className: 'zwf-artifact-reveal-note', 'data-testid': 'workflow-artifact-unsupported-reveal' }, say('run.artifacts.revealUnsupported')));
  }
  return WF_H('div', { className: 'zwf-artifact-preview', 'data-testid': 'workflow-artifact-preview-body' },
    body,
    WF_H(WfArtifactActions, { artifact, t, bytes: bytes.bytes, text, url: bytes.url }),
    wantsItems && items.items.length > 0
      ? WF_H('span', { className: 'zwf-artifact-rows zwf-mono', 'data-testid': 'workflow-artifact-note' },
        WF_UI.say(t, UI_EN, 'run.artifacts.preset.items', { count: items.items.length }))
      : null);
}

/** One gallery tile: kind glyph, title, version and the open affordance. */
function WfArtifactTile(props) {
  const { artifact, t, version, onOpen } = props;
  return WF_H('div', { className: 'zwf-artifact-tile', 'data-testid': 'workflow-artifact-tile', 'data-artifact-id': artifact.id },
    WF_H('span', { className: 'zwf-artifact-tile-frame', 'data-testid': 'workflow-artifact-tile-frame' },
      WF_H('span', { className: 'zwf-artifact-tile-glyph' }, WF_H(WF_UI.artifactIcon(artifact.kind), { size: 15 })),
      WF_H('button', {
        type: 'button',
        className: 'zwf-artifact-tile-title',
        'data-testid': 'workflow-artifact-tile-open',
        title: wfArtifactTitle(artifact),
        onClick: () => onOpen?.(artifact),
      }, wfArtifactTitle(artifact)),
      WF_H('span', { className: 'zwf-artifact-tile-detail', 'data-testid': 'workflow-artifact-tile-detail' },
        wfArtifactKindLabel(t, artifact.kind),
        artifact.itemCount > 0 ? ` · ${WF_UI.say(t, UI_EN, 'run.artifacts.preset.items', { count: artifact.itemCount })}` : ''),
      WF_H('span', { className: 'zwf-artifact-tile-version zwf-mono', 'data-testid': 'workflow-artifact-tile-version' },
        WF_UI.say(t, UI_EN, 'run.artifacts.versionTail', { version }))));
}

/** One index row of the artifacts a run published beside its primary one. */
function WfArtifactRow(props) {
  const { artifact, t, version, onOpen } = props;
  const size = wfArtifactSize(artifact.bytes);
  return WF_H('button', {
    type: 'button',
    className: 'zwf-artifact-row',
    'data-testid': 'workflow-artifact-row',
    'data-artifact-id': artifact.id,
    title: `${wfArtifactKindLabel(t, artifact.kind)}${size === undefined ? '' : ` · ${size}`}\n${artifact.sourcePath ?? artifact.id}`,
    onClick: () => onOpen?.(artifact),
  },
  WF_H('span', { className: 'zwf-artifact-row-frame', 'data-testid': 'workflow-artifact-row-frame' },
    WF_H('span', { className: 'zwf-artifact-row-glyph' }, WF_H(WF_UI.artifactIcon(artifact.kind), { size: 13 })),
    WF_H('span', { className: 'zwf-artifact-row-title', 'data-testid': 'workflow-artifact-row-title' }, wfArtifactTitle(artifact)),
    WF_H('span', { className: 'zwf-artifact-row-meta zwf-mono', 'data-testid': 'workflow-artifact-row-detail' },
      wfArtifactKindLabel(t, artifact.kind),
      artifact.itemCount > 0 ? ` · ${WF_UI.say(t, UI_EN, 'run.artifacts.preset.items', { count: artifact.itemCount })}` : '',
      size === undefined ? '' : ` · ${size}`),
    WF_H('span', { className: 'zwf-artifact-row-version zwf-mono' }, WF_UI.say(t, UI_EN, 'run.artifacts.versionTail', { version }))));
}

/** The preview sheet: a tile or an index row opened in full. */
function WfArtifactSheet(props) {
  const { artifact, t, scope, version, onVersion, onClose } = props;
  const say = (key, params) => WF_UI.say(t, UI_EN, key, params);
  const related = (props.related ?? []).length === 0
    ? null
    : WF_H('div', { className: 'zwf-artifact-index', 'data-testid': 'workflow-artifact-index' },
      props.related.map((entry) => WF_H('span', {
        key: entry.id,
        className: 'zwf-artifact-pill',
        'data-testid': 'workflow-artifact-pill',
      },
      WF_H('button', {
        type: 'button',
        className: 'zwf-link',
        'data-testid': 'workflow-artifact-pill-open',
        onClick: () => props.onOpenRelated?.(entry),
      }, wfArtifactTitle(entry)))));
  return WF_H(WF_UI.Modal, {
    open: true,
    wide: true,
    title: wfArtifactTitle(artifact),
    closeLabel: say('ui.close'),
    onClose,
  },
  WF_H('div', { className: 'zwf-artifact-sheet', 'data-testid': 'workflow-artifact-sheet' },
    WF_H('div', { className: 'zwf-artifact-sheet-head' },
      WF_H('span', { className: 'zwf-artifact-sheet-badge', 'data-testid': 'workflow-artifact-sheet-badge' }, wfArtifactKindLabel(t, artifact.kind)),
      WF_H('span', { className: 'zwf-artifact-sheet-title', 'data-testid': 'workflow-artifact-title' }, wfArtifactTitle(artifact)),
      WF_H('span', { className: 'zwf-artifact-sheet-id zwf-mono', 'data-testid': 'workflow-artifact-id' }, artifact.id),
      WF_H(WfArtifactStepper, { artifact, t, version, onVersion })),
    artifact.description === undefined
      ? null
      : WF_H('p', { className: 'zwf-artifact-desc', 'data-testid': 'workflow-artifact-row-description' }, artifact.description),
    WF_H(WfArtifactPreview, { artifact, t, scope, version, enabled: true }),
    related));
}

/** The primary artifact card, with its stepper, preview and actions. */
function WfArtifactPrimary(props) {
  const { artifact, t, scope, version, onVersion } = props;
  const size = wfArtifactSize(artifact.bytes);
  return WF_H('div', { className: 'zwf-artifact-primary', 'data-testid': 'workflow-artifact' },
    WF_H('div', { className: 'zwf-artifact-head' },
      WF_H('span', { className: 'zwf-artifact-glyph' }, WF_H(WF_UI.artifactIcon(artifact.kind), { size: 15 })),
      WF_H('span', { className: 'zwf-artifact-title', 'data-testid': 'workflow-artifact-title', title: wfArtifactTitle(artifact) }, wfArtifactTitle(artifact)),
      WF_H('span', { className: 'zwf-artifact-badge', 'data-testid': 'workflow-run-artifact-badge' }, wfArtifactKindLabel(t, artifact.kind)),
      size === undefined ? null : WF_H('span', { className: 'zwf-artifact-bytes zwf-mono', 'data-testid': 'workflow-run-artifact-bytes' }, size),
      WF_H(WfArtifactVersionMark, { artifact, version, t }),
      WF_H('span', { className: 'zwf-artifact-chips', 'data-testid': 'workflow-run-artifact-chips' },
        WF_H(WfArtifactStepper, { artifact, t, version, onVersion }))),
    artifact.description === undefined
      ? null
      : WF_H('p', { className: 'zwf-artifact-desc' }, artifact.description),
    WF_H(WfArtifactPreview, { artifact, t, scope, version, enabled: true }));
}

/**
 * The artifacts area: a collapsing section that keeps the run's deliverables one click away.
 *
 * @param {{ artifacts: object[], t: Function, scope: object, open: boolean, onToggle: Function }} props
 */
function WfArtifactsSection(props) {
  const { artifacts, t, scope, open } = props;
  const [versions, setVersions] = React.useState({});
  const [selected, setSelected] = React.useState(undefined);
  const primary = wfPrimaryArtifact(artifacts);
  const versionOf = React.useCallback((artifact) => versions[artifact.id] ?? artifact.version ?? 1, [versions]);
  const setVersion = React.useCallback((artifact, version) => {
    setVersions((current) => ({ ...current, [artifact.id]: version }));
  }, []);
  if (artifacts.length === 0) return null;
  const shown = selected ?? primary;
  const rest = artifacts.filter((artifact) => artifact !== shown);
  let body;
  if (shown === undefined) {
    body = WF_H('div', { className: 'zwf-artifact-gallery', 'data-testid': 'workflow-run-artifact-gallery' },
      artifacts.map((artifact) => WF_H(WfArtifactTile, {
        key: artifact.id,
        artifact,
        t,
        version: versionOf(artifact),
        onOpen: (target) => setSelected(target),
      })));
  } else {
    body = WF_H(WF_FRAGMENT, null,
      WF_H('div', { className: 'zwf-artifact-primary-body', 'data-testid': 'workflow-run-artifact-primary-body' },
        WF_H(WfArtifactPrimary, {
          artifact: shown,
          t,
          scope,
          version: versionOf(shown),
          onVersion: (version) => setVersion(shown, version),
        })),
      rest.length === 0
        ? null
        : WF_H('div', { className: 'zwf-artifact-index', 'data-testid': 'workflow-run-artifact-index' },
          rest.map((artifact) => WF_H(WfArtifactRow, {
            key: artifact.id,
            artifact,
            t,
            version: versionOf(artifact),
            onOpen: (target) => setSelected(target),
          }))));
  }
  return WF_H('section', {
    className: 'zwf-artifacts',
    'data-testid': 'workflow-artifacts',
    'data-artifacts-open': open ? 'true' : 'false',
  },
  WF_H('button', {
    type: 'button',
    className: 'zwf-artifacts-toggle',
    'aria-expanded': open,
    'aria-label': WF_UI.say(t, UI_EN, open ? 'run.artifacts.collapse' : 'run.artifacts.expand'),
    onClick: () => props.onToggle?.(),
  },
  WF_H('span', { className: 'zwf-artifacts-title' }, WF_UI.say(t, UI_EN, 'run.artifacts.title')),
  WF_H('span', { className: 'zwf-artifacts-count zwf-mono', 'data-testid': 'workflow-run-artifacts-count' }, wfGroup(artifacts.length)),
  open || primary === undefined
    ? null
    : WF_H('span', { className: 'zwf-artifacts-primary-title', 'data-testid': 'workflow-run-artifacts-primary-title' },
      `· ${wfArtifactTitle(primary)}`),
  WF_H('span', { className: `zwf-chevron${open ? ' zwf-chevron-open' : ''}`, 'aria-hidden': 'true' }, WF_H(WF_UI.icons.chevronRight, { size: 13 }))),
  open && body !== null
    ? WF_H('div', { className: 'zwf-artifacts-body' }, body)
    : null,
  open && selected !== undefined
    ? WF_H(WfArtifactSheet, {
      artifact: selected,
      t,
      scope,
      version: versionOf(selected),
      related: artifacts.filter((artifact) => artifact !== selected),
      onOpenRelated: (artifact) => setSelected(artifact),
      onVersion: (version) => setVersion(selected, version),
      onClose: () => setSelected(undefined),
    })
    : null);
}
