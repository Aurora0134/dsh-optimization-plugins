/*
 * The artifacts area of the run-detail pane.
 *
 * A published artifact is shown through the newest version the ledger records: table-like kinds
 * render from their published spec, text kinds read one chunk of the stored bytes, everything else
 * keeps a placeholder that still names the file. The remaining artifacts sit behind an index (a
 * primary artifact exists) or a gallery (none does).
 */

/** Read one chunk of an artifact's bytes and decode it as text. */
function useWfArtifactText(scope, artifact, version) {
  const enabled = artifact !== undefined
    && ['markdown', 'file'].includes(artifact.kind)
    && scope !== undefined
    && typeof scope.runId === 'string';
  const [state, setState] = React.useState({ kind: enabled ? 'loading' : 'idle' });
  const key = [scope?.sessionId ?? '', scope?.runId ?? '', artifact?.id ?? '', version ?? '', enabled ? '1' : '0'].join('\u0000');
  React.useEffect(() => {
    if (!enabled) {
      setState({ kind: 'idle' });
      return undefined;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    WF_API.artifactRead({
      sessionId: scope.sessionId,
      runId: scope.runId,
      artifactId: artifact.id,
      version,
      offset: 0,
      limit: 256 * 1024,
    }).then((payload) => {
      if (cancelled) return;
      const base64 = typeof payload?.dataBase64 === 'string' ? payload.dataBase64 : '';
      let text = '';
      try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        text = new TextDecoder().decode(bytes);
      } catch {
        text = '';
      }
      setState({
        kind: 'text',
        text,
        truncated: payload?.nextOffset !== null && payload?.nextOffset !== undefined,
        mediaType: typeof payload?.mediaType === 'string' ? payload.mediaType : undefined,
      });
    }).catch((error) => {
      if (!cancelled) setState({ kind: 'error', error });
    });
    return () => { cancelled = true; };
  }, [key, enabled, scope?.sessionId, scope?.runId, artifact?.id, version]);
  return state;
}

/** The kind label shown next to a title. */
function wfArtifactKindLabel(t, kind) {
  const known = ['file', 'markdown', 'chart', 'table', 'metrics', 'board'];
  return WF_UI.say(t, UI_EN, `run.artifacts.kind.${known.includes(kind) ? kind : 'file'}`);
}

/** Title, falling back to the id so a row is never nameless. */
function wfArtifactTitle(artifact) {
  return artifact.title ?? artifact.id;
}

/** Table-like artifacts share one renderer. */
function WfArtifactTable(props) {
  const { artifact, t } = props;
  const rows = wfArtifactRows(artifact);
  if (rows.length === 0) {
    return WF_H('div', { className: 'zwf-artifact-empty', 'data-testid': 'workflow-run-artifact-items' },
      WF_H('span', { className: 'zwf-artifact-empty-text' }, WF_UI.say(t, UI_EN, 'run.artifacts.preset.empty')));
  }
  const columns = wfArtifactColumns(artifact, rows).slice(0, 6);
  return WF_H('div', { className: 'zwf-artifact-table', 'data-testid': 'workflow-run-artifact-items' },
    WF_H('table', null,
      WF_H('thead', null, WF_H('tr', null, columns.map((column) => WF_H('th', { key: column }, column)))),
      WF_H('tbody', null, rows.slice(0, 40).map((row, index) => WF_H('tr', { key: String(index) },
        columns.map((column) => WF_H('td', { key: column }, wfArtifactCell(row[column]))))))));
}

/** One table cell: primitives as-is, everything else compact JSON. */
function wfArtifactCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return WF_UI.json(value).replace(/\s+/gu, ' ').slice(0, 200);
}

/** Version stepper shared by the primary card and the gallery tiles. */
function WfArtifactVersionChips(props) {
  const { artifact, t, version, onVersion } = props;
  const versions = artifact.versions ?? [];
  if (versions.length <= 1) {
    return WF_H('span', { className: 'zwf-artifact-version zwf-mono', 'data-testid': 'workflow-run-artifact-version' },
      WF_UI.say(t, UI_EN, 'run.artifacts.versionTail', { version }));
  }
  const index = versions.findIndex((entry) => entry.version === version);
  const previous = versions[index - 1];
  const next = versions[index + 1];
  return WF_H('span', { className: 'zwf-artifact-chips', 'data-testid': 'workflow-run-artifact-chips' },
    WF_H('button', {
      type: 'button',
      className: 'zwf-artifact-chip',
      disabled: previous === undefined,
      title: WF_UI.say(t, UI_EN, 'run.artifacts.previousVersion'),
      onClick: () => previous !== undefined && onVersion?.(previous.version),
    }, WF_H(WF_UI.icons.chevronRight, { size: 11, className: 'zwf-flip' })),
    WF_H('span', { className: 'zwf-artifact-version zwf-mono', 'data-testid': 'workflow-run-artifact-version' },
      WF_UI.say(t, UI_EN, 'run.artifacts.versionOf', { version, total: versions.length })),
    WF_H('button', {
      type: 'button',
      className: 'zwf-artifact-chip',
      disabled: next === undefined,
      title: WF_UI.say(t, UI_EN, 'run.artifacts.nextVersion'),
      onClick: () => next !== undefined && onVersion?.(next.version),
    }, WF_H(WF_UI.icons.chevronRight, { size: 11 })),
    versions.length > 3
      ? WF_H('span', { className: 'zwf-artifact-chips-more zwf-mono', 'data-testid': 'workflow-run-artifact-chips-more' }, `+${versions.length - 2}`)
      : null);
}

/** The primary artifact: title row, metadata, version control and the preview body. */
function WfArtifactPrimary(props) {
  const { artifact, t, scope, version, onVersion } = props;
  const text = useWfArtifactText(scope, artifact, version);
  const size = wfArtifactSize(artifact.bytes);
  const tableLike = ['chart', 'table', 'metrics', 'board'].includes(artifact.kind);
  const rows = wfArtifactRows(artifact);
  let body;
  if (tableLike) {
    body = artifact.spec !== undefined && rows.length === 0 && artifact.spec !== null && typeof artifact.spec === 'object' && artifact.spec.items !== undefined && Array.isArray(artifact.spec.items) === false
      ? WF_H('div', { className: 'zwf-artifact-empty', 'data-testid': 'workflow-run-artifact-preset-invalid' },
        WF_H('span', { className: 'zwf-artifact-empty-text' }, WF_UI.say(t, UI_EN, 'run.artifacts.presetInvalid')))
      : WF_H(WfArtifactTable, { artifact, t });
  } else if (text.kind === 'text') {
    body = WF_H('pre', { className: 'zwf-artifact-text' }, text.text === '' ? WF_UI.say(t, UI_EN, 'run.artifacts.preset.empty') : text.text);
  } else if (text.kind === 'loading') {
    body = WF_H('div', { className: 'zwf-artifact-empty' }, WF_H('span', { className: 'zwf-artifact-empty-text' }, WF_UI.say(t, UI_EN, 'run.artifacts.loading')));
  } else if (text.kind === 'error') {
    body = WF_H('div', { className: 'zwf-artifact-empty', 'data-testid': 'workflow-run-artifact-preset-missing' },
      WF_H('span', { className: 'zwf-artifact-empty-text' }, WF_UI.say(t, UI_EN, 'run.artifacts.missing')));
  } else {
    body = WF_H('div', { className: 'zwf-artifact-empty' },
      WF_H('span', { className: 'zwf-artifact-empty-text' }, WF_UI.say(t, UI_EN, 'run.artifacts.unsupported')));
  }
  return WF_H('div', { className: 'zwf-artifact-primary' },
    WF_H('div', { className: 'zwf-artifact-head' },
      WF_H('span', { className: 'zwf-artifact-glyph' }, WF_H(WF_UI.artifactIcon(artifact.kind), { size: 15 })),
      WF_H('span', { className: 'zwf-artifact-title', title: wfArtifactTitle(artifact) }, wfArtifactTitle(artifact)),
      WF_H('span', { className: 'zwf-artifact-badge', 'data-testid': 'workflow-run-artifact-badge' }, wfArtifactKindLabel(t, artifact.kind)),
      size === undefined ? null : WF_H('span', { className: 'zwf-artifact-bytes zwf-mono', 'data-testid': 'workflow-run-artifact-bytes' }, size),
      WF_H(WfArtifactVersionChips, { artifact, t, version, onVersion })),
    artifact.description === undefined
      ? null
      : WF_H('p', { className: 'zwf-artifact-desc' }, artifact.description),
    body);
}

/** A compact row in the index of the remaining artifacts. */
function WfArtifactIndex(props) {
  const { artifacts, t, versionOf, onSelect } = props;
  if (artifacts.length === 0) return null;
  return WF_H('div', { className: 'zwf-artifact-index', 'data-testid': 'workflow-run-artifact-index' },
    artifacts.map((artifact) => {
      const version = versionOf(artifact);
      const size = wfArtifactSize(artifact.bytes);
      return WF_H('button', {
        key: artifact.id,
        type: 'button',
        className: 'zwf-artifact-row',
        'data-artifact-id': artifact.id,
        title: `${wfArtifactKindLabel(t, artifact.kind)}${size === undefined ? '' : ` · ${size}`}\n${artifact.sourcePath ?? artifact.id}`,
        onClick: () => onSelect?.(artifact),
      },
      WF_H('span', { className: 'zwf-artifact-row-glyph' }, WF_H(WF_UI.artifactIcon(artifact.kind), { size: 13 })),
      WF_H('span', { className: 'zwf-artifact-row-title' }, wfArtifactTitle(artifact)),
      WF_H('span', { className: 'zwf-artifact-row-meta zwf-mono' },
        wfArtifactKindLabel(t, artifact.kind),
        artifact.itemCount > 0 ? ` · ${WF_UI.say(t, UI_EN, 'run.artifacts.preset.items', { count: artifact.itemCount })}` : ''),
      WF_H('span', { className: 'zwf-artifact-row-version zwf-mono' }, WF_UI.say(t, UI_EN, 'run.artifacts.versionTail', { version })));
    }));
}

/** The gallery shown when the ledger marks no artifact as primary. */
function WfArtifactGallery(props) {
  const { artifacts, t, versionOf, onSelect } = props;
  return WF_H('div', { className: 'zwf-artifact-gallery', 'data-testid': 'workflow-run-artifact-gallery' },
    artifacts.map((artifact) => {
      const version = versionOf(artifact);
      return WF_H('button', {
        key: artifact.id,
        type: 'button',
        className: 'zwf-artifact-tile',
        'data-artifact-id': artifact.id,
        onClick: () => onSelect?.(artifact),
      },
      WF_H('span', { className: 'zwf-artifact-tile-glyph' }, WF_H(WF_UI.artifactIcon(artifact.kind), { size: 15 })),
      WF_H('span', { className: 'zwf-artifact-tile-title' }, wfArtifactTitle(artifact)),
      WF_H('span', { className: 'zwf-artifact-tile-meta' },
        wfArtifactKindLabel(t, artifact.kind),
        artifact.itemCount > 0 ? ` · ${WF_UI.say(t, UI_EN, 'run.artifacts.preset.items', { count: artifact.itemCount })}` : ''),
      WF_H('span', { className: 'zwf-artifact-tile-version zwf-mono' }, WF_UI.say(t, UI_EN, 'run.artifacts.versionTail', { version })));
    }));
}

/**
 * The artifacts area: a collapsing section that keeps drawing attention to itself while the run
 * is producing new artifacts.
 *
 * @param {{ artifacts: object[], t: Function, scope: object, open: boolean, onToggle: Function }} props
 */
function WfArtifactsSection(props) {
  const { artifacts, t, scope, open } = props;
  const [versions, setVersions] = React.useState({});
  const [selected, setSelected] = React.useState(undefined);
  const primary = wfPrimaryArtifact(artifacts);
  const rest = artifacts.filter((artifact) => artifact !== (selected ?? primary));
  const versionOf = React.useCallback((artifact) => versions[artifact.id] ?? artifact.version ?? 1, [versions]);
  const setVersion = React.useCallback((artifact, version) => {
    setVersions((current) => ({ ...current, [artifact.id]: version }));
  }, []);
  if (artifacts.length === 0) return null;
  const shown = selected ?? primary;
  const body = shown === undefined
    ? WF_H(WfArtifactGallery, { artifacts, t, versionOf, onSelect: setSelected })
    : WF_H(WF_FRAGMENT, null,
      WF_H('div', { className: 'zwf-artifact-primary-body', 'data-testid': 'workflow-run-artifact-primary-body' },
        WF_H(WfArtifactPrimary, {
          artifact: shown,
          t,
          scope,
          version: versionOf(shown),
          onVersion: (version) => setVersion(shown, version),
        })),
      WF_H(WfArtifactIndex, {
        artifacts: rest,
        t,
        versionOf,
        onSelect: (artifact) => {
          setSelected(artifact);
        },
      }));
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
    : null);
}
