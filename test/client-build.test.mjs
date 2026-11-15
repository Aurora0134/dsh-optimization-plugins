/**
 * The served `client.js` is generated: every part under `client-src/` and every locale section
 * must be reflected in it. This test rebuilds and fails when the committed artifact is stale.
 *
 * The behavior tests below render the built artifact instead of reading it: a launch card must
 * claim the run of the tool call that launched it, and nothing else on the wire (arguments, result
 * text) may stand in when that claim has not arrived.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const clientPath = path.join(root, 'client.js');

test('client.js is built from client-src and locale files', () => {
  const before = readFileSync(clientPath, 'utf8');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-client.mjs')], { cwd: root });
  const after = readFileSync(clientPath, 'utf8');
  // Git may check the committed artifact out with CRLF on Windows; the generator always writes LF.
  const normalize = (text) => text.replace(/\r\n/g, '\n');
  assert.equal(normalize(after), normalize(before), 'client.js is stale; run node scripts/build-client.mjs');
  execFileSync(process.execPath, ['--check', clientPath]);
});

test('client.js carries both dictionaries and every tool card key', () => {
  const client = readFileSync(clientPath, 'utf8');
  const en = JSON.parse(readFileSync(path.join(root, 'locale', 'en.json'), 'utf8'));
  const zh = JSON.parse(readFileSync(path.join(root, 'locale', 'zh.json'), 'utf8'));
  for (const key of Object.keys(en.tool)) {
    assert.ok(client.includes(JSON.stringify(key)), `missing tool key ${key} in client.js`);
  }
  for (const [key, value] of Object.entries(zh.tool)) {
    assert.ok(client.includes(JSON.stringify(value)), `missing Chinese tool copy for ${key}`);
  }
});

/* --------------------------------- harness --------------------------------- */

/** One run row as the Host's catalogue publishes it. */
function runRow(values) {
  return {
    status: 'running',
    label: 'run',
    createdAt: Date.now() - 5_000,
    phases: [],
    agentsWorking: 0,
    spentTokens: 0,
    ...values,
  };
}

/** Let the card's first fetch land: one macrotask covers the 0ms subscribe timer. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/** Render a node tree to plain data, expanding every function component once per pass. */
function createElementTree() {
  const hookStores = new Map();
  const cleanups = [];
  let store;

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const next = { ...(props ?? {}) };
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      return { type, props: next };
    },
    cloneElement(element, props) {
      return { ...element, props: { ...element.props, ...props } };
    },
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef(initial) {
      const index = store.index++;
      if (!(index in store.cells)) store.cells[index] = { current: initial };
      return store.cells[index];
    },
    useState(initial) {
      // The setter outlives the render that created it (a subscription calls it later), so it
      // binds this instance's store instead of reading whichever component renders next.
      const target = store;
      const index = target.index++;
      if (!(index in target.cells)) target.cells[index] = typeof initial === 'function' ? initial() : initial;
      return [target.cells[index], (value) => {
        target.cells[index] = typeof value === 'function' ? value(target.cells[index]) : value;
      }];
    },
    useEffect(effect) {
      store.effects.push(effect);
    },
  };

  function render(element) {
    const effects = [];
    const walk = (node, pathKey) => {
      if (node === null || node === undefined || typeof node === 'boolean') return null;
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map((child, index) => walk(child, `${pathKey}/${index}`));
      if (typeof node !== 'object') return null;
      if (node.type === React.Fragment) return walk(node.props.children, pathKey);
      if (typeof node.type !== 'function') {
        // A host element is kept as data, but its children still need expanding.
        return { ...node, props: { ...node.props, children: walk(node.props.children, `${pathKey}>`) } };
      }
      const key = `${pathKey}:${node.type.name || 'Anonymous'}`;
      const current = hookStores.get(key) ?? { index: 0, cells: [], effects: [] };
      hookStores.set(key, current);
      current.index = 0;
      current.effects = [];
      const previous = store;
      store = current;
      let rendered;
      try {
        rendered = node.type(node.props);
      } finally {
        store = previous;
      }
      effects.push(...current.effects);
      return walk(rendered, key);
    };
    const tree = walk(element, 'root');
    for (const effect of effects) {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
    return tree;
  }

  function dispose() {
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // a failing cleanup must not hide the assertion that follows
      }
    }
  }

  return { React, render, dispose };
}

/**
 * Load the built client into a fake browser surface and apply it to a fake Host client.
 *
 * `route` answers every same-origin request; registrations, opened sidebar tabs and the request
 * log are what the tests assert on.
 */
function startClient(route) {
  const requests = [];
  const openedTabs = [];
  const registrations = [];
  const disposers = [];
  const tree = createElementTree();

  const fetchStub = async (url) => {
    requests.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => route(String(url)),
    };
  };

  const slots = {
    inject(key, callback) {
      const produced = callback();
      if (produced !== null && typeof produced === 'object' && typeof produced[Symbol.iterator] === 'function') {
        for (const entry of produced) void entry;
      }
      return { dispose() {} };
    },
    register(spec, component) {
      registrations.push({ spec, component });
      return { dispose() {} };
    },
  };

  const layout = { selectPanel: () => true };
  const ctx = {
    effect(callback) {
      const cleanup = callback();
      if (typeof cleanup === 'function') disposers.push(cleanup);
      return { dispose() {} };
    },
    locale: {
      register: () => () => {},
      bind: () => (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`),
    },
    slots,
    inject(names, callback) {
      callback({
        sidebarRight: { openTab: (kind, options) => openedTabs.push({ kind, params: options?.params }) },
        sidebarRightTabs: { register: () => ({ dispose() {} }) },
      });
      return Promise.resolve(() => {});
    },
    get: (name) => (name === 'layout' ? layout : undefined),
  };

  const window = { __ModuleLoader__: { load: (spec) => { window.__spec = spec; } } };
  const document = {
    hidden: false,
    visibilityState: 'visible',
    head: { append() {} },
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ dataset: {}, style: {}, append() {}, remove() {} }),
  };
  const evaluate = new Function(
    'window', 'fetch', 'document', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'URLSearchParams', 'navigator',
    readFileSync(clientPath, 'utf8'),
  );
  evaluate(window, fetchStub, document, console, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, {});
  const plugin = window.__spec.factory((name) => (name === 'react' ? tree.React : {}));
  plugin.apply(ctx);

  return {
    React: tree.React,
    render: tree.render,
    requests,
    openedTabs,
    registrations,
    cardFor: (key) => registrations.find((entry) => entry.spec.name === 'tool.call.toolview' && entry.spec.key === key),
    dispose() {
      tree.dispose();
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // best effort
        }
      }
    },
  };
}

/** Every host element in a rendered tree, depth first. */
function elements(tree) {
  const found = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    found.push(node);
    walk(node.props?.children);
  };
  walk(tree);
  return found;
}

/** The first host element carrying a test id. */
function byTestId(tree, testId) {
  return elements(tree).find((node) => node.props?.['data-testid'] === testId);
}

/** A launch card's slot payload: standard props plus the owner's call facts. */
function launchProps(values) {
  return {
    sessionId: 'session-1',
    callId: 'call-1',
    toolName: 'CreateWorkflow',
    phase: 'result',
    block: { args: {}, content: [] },
    ...values,
  };
}

/* ---------------------------------- tests ---------------------------------- */

test('a launch card claims the run of its tool call, not the run its arguments or result name', async () => {
  const client = startClient((url) => {
    if (url.startsWith('/zcode-workflow/runs')) {
      return { runs: [runRow({ runId: 'run-claimed', id: 'run-claimed', toolCallId: 'call-1', label: 'claimed-run' })] };
    }
    return { run: runRow({ runId: 'run-claimed', id: 'run-claimed', toolCallId: 'call-1', label: 'claimed-run' }) };
  });
  try {
    const card = client.cardFor('AmendWorkflow');
    assert.ok(card !== undefined, 'the AmendWorkflow card is registered');
    const props = launchProps({
      toolName: 'AmendWorkflow',
      block: { args: { run_id: 'run-old' }, content: [{ type: 'text', text: 'Started revised run run-old' }] },
    });
    client.render(client.React.createElement(card.component, props));
    await settle();
    const rendered = client.render(client.React.createElement(card.component, props));

    const details = byTestId(rendered, 'workflow-card-open-details');
    assert.ok(details !== undefined, 'the claimed run offers a details button');
    details.props.onClick();
    assert.equal(client.openedTabs.length, 1, 'the details button opens one run tab');
    assert.equal(client.openedTabs[0].params.runId, 'run-claimed');
    assert.equal(client.openedTabs[0].params.sessionId, 'session-1');

    await settle();
    assert.ok(
      !client.requests.some((url) => url.includes('run-old')),
      `the card must never read the run its arguments name: ${client.requests.join(', ')}`,
    );
    assert.ok(
      client.requests.some((url) => url.includes('runId=run-claimed')),
      'the card reads the run it claimed',
    );
  } finally {
    client.dispose();
  }
});

test('a claimed run that is still running renders a running card with its details entry', async () => {
  // The Host side of the claim (runtime passing the tool call id through, the projection and /runs
  // carrying it) is covered in runtime.test.mjs and ui-api.test.mjs. This guards the card's own half:
  // once a row carries the launching tool call id, the card must render the live run, not a shell.
  const client = startClient((url) => {
    if (url.startsWith('/zcode-workflow/runs')) {
      return { runs: [runRow({ runId: 'run-live', id: 'run-live', toolCallId: 'call-1', label: 'live-run', status: 'running' })] };
    }
    return { run: runRow({ runId: 'run-live', id: 'run-live', toolCallId: 'call-1', label: 'live-run', status: 'running' }) };
  });
  try {
    const card = client.cardFor('CreateWorkflow');
    assert.ok(card !== undefined, 'the CreateWorkflow card is registered');
    const props = launchProps({ toolName: 'CreateWorkflow' });
    client.render(client.React.createElement(card.component, props));
    await settle();
    const rendered = client.render(client.React.createElement(card.component, props));

    const section = byTestId(rendered, 'workflow-card');
    assert.equal(section.props['data-workflow-run-id'], 'run-live', 'the card shows the run its tool call launched');
    assert.equal(section.props['data-workflow-card-state'], 'running', 'a claimed running run is not a static shell');
    assert.ok(byTestId(rendered, 'workflow-card-open-details') !== undefined, 'the claimed run offers a details entry');
  } finally {
    client.dispose();
  }
});

test('a launch card claims nothing when its tool call has no run row, even though arguments and result name one', async () => {
  const client = startClient((url) => {
    if (url.startsWith('/zcode-workflow/runs')) {
      return { runs: [runRow({ runId: 'run-old', id: 'run-old', toolCallId: 'call-0', label: 'predecessor-run' })] };
    }
    return { run: runRow({ runId: 'run-old', id: 'run-old', toolCallId: 'call-0', label: 'predecessor-run' }) };
  });
  try {
    const card = client.cardFor('AmendWorkflow');
    const props = launchProps({
      toolName: 'AmendWorkflow',
      block: { args: { run_id: 'run-old' }, content: [{ type: 'text', text: 'Started revised run run-old' }] },
    });
    client.render(client.React.createElement(card.component, props));
    await settle();
    const rendered = client.render(client.React.createElement(card.component, props));

    assert.equal(byTestId(rendered, 'workflow-card-open-details'), undefined, 'no claim means no details entry');
    await settle();
    assert.ok(
      !client.requests.some((url) => url.includes('run-old')),
      `an unclaimed card must not fall back to the predecessor run: ${client.requests.join(', ')}`,
    );
  } finally {
    client.dispose();
  }
});

test('a CreateWorkflow result text alone does not tie the card to a run', async () => {
  const client = startClient((url) => {
    if (url.startsWith('/zcode-workflow/runs')) return { runs: [] };
    return { run: runRow({ runId: 'run-ghost', id: 'run-ghost' }) };
  });
  try {
    const card = client.cardFor('CreateWorkflow');
    const props = launchProps({ block: { args: {}, content: [{ type: 'text', text: 'Run ID: run-ghost' }] } });
    client.render(client.React.createElement(card.component, props));
    await settle();
    const rendered = client.render(client.React.createElement(card.component, props));

    assert.equal(byTestId(rendered, 'workflow-card-open-details'), undefined, 'result copy is not a claim');
    await settle();
    assert.ok(!client.requests.some((url) => url.includes('run-ghost')), 'the card never reads a run named by its text');
  } finally {
    client.dispose();
  }
});
test('a Fill card opens the run its run_id argument names, which its own tool call never launched', async () => {
  const client = startClient((url) => {
    if (url.startsWith('/zcode-workflow/runs')) {
      return { runs: [runRow({ runId: 'run-target', id: 'run-target', toolCallId: 'call-create-1', label: 'target-run' })] };
    }
    return { run: runRow({ runId: 'run-target', id: 'run-target', toolCallId: 'call-create-1', label: 'target-run' }) };
  });
  try {
    const card = client.cardFor('FillWorkflowHole');
    assert.ok(card !== undefined, 'the FillWorkflowHole card is registered');
    const props = launchProps({
      toolName: 'FillWorkflowHole',
      callId: 'call-fill-1',
      block: {
        args: { run_id: 'run-target', hole_id: 'hole-1', hole_target: { name: 'reviewer' } },
        content: [{ type: 'text', text: 'Filled hole hole-1 on run run-target.' }],
      },
    });
    client.render(client.React.createElement(card.component, props));
    await settle();
    const rendered = client.render(client.React.createElement(card.component, props));

    assert.equal(
      byTestId(rendered, 'workflow-card').props['data-workflow-run-id'],
      'run-target',
      'the run the argument names is the run the card shows',
    );
    const details = byTestId(rendered, 'workflow-card-open-details');
    assert.ok(details !== undefined, 'the filled run keeps its details entry');
    details.props.onClick();
    assert.equal(client.openedTabs.length, 1, 'the details button opens one run tab');
    assert.equal(client.openedTabs[0].params.runId, 'run-target');
    assert.equal(client.openedTabs[0].params.sessionId, 'session-1');

    await settle();
    assert.ok(
      client.requests.some((url) => url.includes('runId=run-target')),
      `the card reads the run it filled: ${client.requests.join(', ')}`,
    );
  } finally {
    client.dispose();
  }
});

test('Create and Amend still claim by tool call only, even when their run_id argument names a listed run', async () => {
  const client = startClient((url) => {
    if (url.startsWith('/zcode-workflow/runs')) {
      return { runs: [runRow({ runId: 'run-old', id: 'run-old', toolCallId: 'call-0', label: 'predecessor-run' })] };
    }
    return { run: runRow({ runId: 'run-old', id: 'run-old', toolCallId: 'call-0', label: 'predecessor-run' }) };
  });
  try {
    for (const key of ['CreateWorkflow', 'AmendWorkflow']) {
      const card = client.cardFor(key);
      assert.ok(card !== undefined, `the ${key} card is registered`);
      const props = launchProps({
        toolName: key,
        callId: `call-${key}`,
        block: { args: { run_id: 'run-old' }, content: [{ type: 'text', text: 'Started revised run run-old' }] },
      });
      client.render(client.React.createElement(card.component, props));
      await settle();
      const rendered = client.render(client.React.createElement(card.component, props));

      assert.equal(
        byTestId(rendered, 'workflow-card-open-details'),
        undefined,
        `${key} without its own tool call row offers no details entry`,
      );
      assert.equal(
        byTestId(rendered, 'workflow-card').props['data-workflow-run-id'],
        undefined,
        `${key} shows no run without its own tool call row`,
      );
    }
    await settle();
    assert.ok(
      !client.requests.some((url) => url.includes('run-old')),
      `a launch never reads the run its argument names: ${client.requests.join(', ')}`,
    );
  } finally {
    client.dispose();
  }
});

test('the Session-scoped seats hand the Session to the card and the status entry as standard props', async () => {
  const client = startClient((url) => {
    if (url.startsWith('/zcode-workflow/runs')) {
      return { runs: [runRow({ runId: 'run-1', id: 'run-1', toolCallId: 'call-1', label: 'run-one' })] };
    }
    return { run: runRow({ runId: 'run-1', id: 'run-1', toolCallId: 'call-1', label: 'run-one' }) };
  });
  try {
    for (const key of ['CreateWorkflow', 'AmendWorkflow', 'FillWorkflowHole']) {
      const card = client.cardFor(key);
      assert.ok(card !== undefined, `the ${key} card is registered`);
      assert.equal('inject' in card.spec, false, `the ${key} card declares no inject; its seat is Session-scoped`);
    }
    const status = client.registrations.find((entry) => entry.spec.name === 'conversation.session.header.utilities' && entry.spec.id === 'workflow-status');
    assert.ok(status !== undefined, 'the status entry is registered');
    assert.equal('inject' in status.spec, false, 'the status entry declares no inject');

    // A Session-scoped seat renders with the standard props only; the entry still reads its runs.
    const entryProps = { sessionId: 'session-9', t: (key) => key };
    client.render(client.React.createElement(status.component, entryProps));
    await settle();
    client.render(client.React.createElement(status.component, entryProps));
    assert.ok(
      client.requests.some((url) => url.includes('sessionId=session-9')),
      `the status entry read the Session from standard props: ${client.requests.join(', ')}`,
    );
  } finally {
    client.dispose();
  }
});
