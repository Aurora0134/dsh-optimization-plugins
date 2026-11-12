/**
 * The launch confirmation has two surfaces — the block inside the tool card and the full-size
 * dialog — and they must never ask for the same pending run at once.
 *
 * client.js is one concatenated factory body, so the harness below loads the parts that own the
 * confirmation into a single function scope and hands back the internals these tests drive: a card
 * that mounts a block, the header watcher that opens the dialog, and the overlay both share.
 *
 * The hook runtime is deliberately small, but it commits a batch the way React does: every render
 * first, then layout effects, then passive effects. That ordering is what lets a card that mounts in
 * the same commit as the watcher register itself before the watcher looks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => readFileSync(path.join(root, 'client-src', name), 'utf8');

/** Parts that own the confirmation, plus the run channel the watcher reads. */
const PARTS = ['00-core.js', '31-cache.js', '45-permission.js'];

/** The shape the client bundle reads run rows with. */
const wfCardRecord = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined);

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((value, index) => Object.is(value, b[index]));

/** React enough: hooks, batched renders, and layout effects before passive ones. */
function createHooks() {
  let current = null;
  const dirty = new Set();

  const nextSlot = () => {
    const instance = current;
    const index = instance.cursor;
    instance.cursor += 1;
    if (instance.hooks[index] === undefined) instance.hooks[index] = { deps: undefined, cleanup: undefined, value: undefined };
    return instance.hooks[index];
  };

  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children } };
    },
    useState(initial) {
      const owner = current;
      const slot = nextSlot();
      if (slot.state !== true) {
        slot.state = true;
        slot.value = typeof initial === 'function' ? initial() : initial;
      }
      const setValue = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        dirty.add(owner);
      };
      return [slot.value, setValue];
    },
    useRef(initial) {
      const slot = nextSlot();
      if (slot.kind !== 'ref') {
        slot.kind = 'ref';
        slot.value = { current: initial };
      }
      return slot.value;
    },
    useMemo(factory, deps) {
      const slot = nextSlot();
      if (slot.kind !== 'memo' || !sameDeps(slot.deps, deps)) {
        slot.kind = 'memo';
        slot.value = factory();
        slot.deps = deps;
      }
      return slot.value;
    },
    useCallback(callback, deps) {
      const slot = nextSlot();
      if (slot.kind !== 'callback' || !sameDeps(slot.deps, deps)) {
        slot.kind = 'callback';
        slot.value = callback;
        slot.deps = deps;
      }
      return slot.value;
    },
    useEffect(effect, deps) {
      current.pending.push({ slot: nextSlot(), deps, effect, phase: 'passive' });
    },
    useLayoutEffect(effect, deps) {
      current.pending.push({ slot: nextSlot(), deps, effect, phase: 'layout' });
    },
  };

  const render = (instance) => {
    current = instance;
    instance.cursor = 0;
    instance.pending = [];
    try {
      instance.output = instance.component(instance.props);
    } finally {
      current = null;
    }
  };

  const commit = (instance, phase) => {
    for (const entry of instance.pending) {
      if (entry.phase !== phase) continue;
      if (Array.isArray(entry.slot.deps) && sameDeps(entry.slot.deps, entry.deps)) continue;
      if (typeof entry.slot.cleanup === 'function') entry.slot.cleanup();
      const cleanup = entry.effect();
      entry.slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      entry.slot.deps = entry.deps;
    }
    instance.pending = instance.pending.filter((entry) => entry.phase !== phase);
  };

  const flush = () => {
    for (let guard = 0; dirty.size > 0 && guard < 100; guard += 1) {
      const batch = [...dirty];
      dirty.clear();
      for (const instance of batch) render(instance);
      for (const instance of batch) commit(instance, 'layout');
      for (const instance of batch) commit(instance, 'passive');
    }
  };

  /** Mount components as one commit, then return handles that unmount them one by one. */
  const mount = (entries) => {
    const instances = entries.map(({ component, props }) => {
      const instance = { component, props, hooks: [], cursor: 0, pending: [], output: undefined };
      dirty.add(instance);
      return instance;
    });
    flush();
    return instances.map((instance) => ({
      get output() {
        return instance.output;
      },
      unmount() {
        for (let index = instance.hooks.length - 1; index >= 0; index -= 1) {
          const slot = instance.hooks[index];
          if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup();
          if (slot !== undefined) delete slot.cleanup;
        }
        instance.hooks = [];
        instance.pending = [];
        instance.unmounted = true;
      },
    }));
  };

  return { React, mount, flush };
}

/**
 * One isolated copy of the client parts.
 * @param {{ sessionId: string, runs: object[] }} options
 */
function createHarness(options) {
  const { sessionId, runs } = options;
  const hooks = createHooks();
  const list = { runs };
  const WF_API = { runs: async () => ({ runs: list.runs }) };
  const WF_UI = { say: (_translate, _dictionary, key) => key };
  const body = PARTS.map(read).join('\n')
    + '\nreturn { WF_PERMISSION, WF_PERMISSION_OVERLAY, WF_PERMISSION_SHOWN, WF_PERMISSION_BLOCKS, WfLaunchWatcher, WfPermissionBlock, WF_RUN_CHANNEL, wfRunKey };\n';
  const factory = new Function(
    'React', 'WF_API', 'WF_H', 'WF_UI', 'WF_ICON', 'UI_EN', 'WF_STYLE_PARTS', 'wfCardRecord', 'document', 'window',
    body,
  );
  const api = factory(
    hooks.React,
    WF_API,
    hooks.React.createElement,
    WF_UI,
    { alert: 'alert' },
    {},
    [],
    wfCardRecord,
    undefined,
    undefined,
  );
  // The session snapshot the watcher reads on mount; the run channel only republishes on change.
  api.WF_RUN_CHANNEL.snapshots.set(api.wfRunKey(sessionId, undefined), {
    sessionId, runId: undefined, run: undefined, summary: undefined, runs, truncated: false, error: undefined,
  });
  return { ...api, renderer: hooks, sessionId };
}

/** A run row of the pending list the watcher filters. */
const pendingRun = (id) => ({ id, status: 'pending' });

test('a card that carries the block keeps the dialog away for its run', () => {
  const run = pendingRun('run-1');
  const harness = createHarness({ sessionId: 'sess-1', runs: [run] });
  harness.renderer.mount([
    { component: harness.WfLaunchWatcher, props: { sessionId: 'sess-1' } },
    { component: harness.WfPermissionBlock, props: { sessionId: 'sess-1', run } },
  ]);
  assert.equal(harness.WF_PERMISSION_OVERLAY.read(), undefined, 'the card already asks the question');
  assert.equal(harness.WF_PERMISSION_BLOCKS.onPage('run-1'), true);
  // Skipping on the card must not consume the launch: the dialog still owes this run when it is gone.
  assert.equal(harness.WF_PERMISSION_SHOWN.has('run-1'), false);
});

test('the dialog takes over once the card that carried the block unmounts', () => {
  const run = pendingRun('run-1');
  const harness = createHarness({ sessionId: 'sess-1', runs: [run] });
  const [, block] = harness.renderer.mount([
    { component: harness.WfLaunchWatcher, props: { sessionId: 'sess-1' } },
    { component: harness.WfPermissionBlock, props: { sessionId: 'sess-1', run } },
  ]);
  assert.equal(harness.WF_PERMISSION_OVERLAY.read(), undefined);
  block.unmount();
  harness.renderer.flush();
  assert.equal(harness.WF_PERMISSION_OVERLAY.read()?.runId, 'run-1');
  assert.equal(harness.WF_PERMISSION_OVERLAY.read()?.sessionId, 'sess-1');
});

test('the last card of a run to go away is the one that hands it over', () => {
  const run = pendingRun('run-1');
  const harness = createHarness({ sessionId: 'sess-1', runs: [run] });
  const [, first, second] = harness.renderer.mount([
    { component: harness.WfLaunchWatcher, props: { sessionId: 'sess-1' } },
    { component: harness.WfPermissionBlock, props: { sessionId: 'sess-1', run } },
    { component: harness.WfPermissionBlock, props: { sessionId: 'sess-1', run } },
  ]);
  first.unmount();
  harness.renderer.flush();
  assert.equal(harness.WF_PERMISSION_OVERLAY.read(), undefined, 'one card still shows the block');
  assert.equal(harness.WF_PERMISSION_BLOCKS.onPage('run-1'), true);
  second.unmount();
  harness.renderer.flush();
  assert.equal(harness.WF_PERMISSION_OVERLAY.read()?.runId, 'run-1');
});

test('a pending run with no card on the page still gets the dialog', () => {
  const harness = createHarness({ sessionId: 'sess-1', runs: [pendingRun('run-1')] });
  harness.renderer.mount([{ component: harness.WfLaunchWatcher, props: { sessionId: 'sess-1' } }]);
  assert.equal(harness.WF_PERMISSION_OVERLAY.read()?.runId, 'run-1');
  assert.equal(harness.WF_PERMISSION_SHOWN.has('run-1'), true);
});

test('a card for one run does not silence another run waiting for its answer', () => {
  const first = pendingRun('run-1');
  const second = pendingRun('run-2');
  const harness = createHarness({ sessionId: 'sess-1', runs: [first, second] });
  harness.renderer.mount([
    { component: harness.WfLaunchWatcher, props: { sessionId: 'sess-1' } },
    { component: harness.WfPermissionBlock, props: { sessionId: 'sess-1', run: first } },
  ]);
  assert.equal(harness.WF_PERMISSION_OVERLAY.read()?.runId, 'run-2');
});

test('the status panel opens the dialog while the card is still on the page', () => {
  const run = pendingRun('run-1');
  const harness = createHarness({ sessionId: 'sess-1', runs: [run] });
  const [, block] = harness.renderer.mount([
    { component: harness.WfLaunchWatcher, props: { sessionId: 'sess-1' } },
    { component: harness.WfPermissionBlock, props: { sessionId: 'sess-1', run } },
  ]);
  assert.equal(harness.WF_PERMISSION.open({ sessionId: 'sess-1', runId: 'run-1', run }), true);
  assert.equal(harness.WF_PERMISSION_OVERLAY.read()?.runId, 'run-1');
  // Closing what the user opened leaves the question to the card; the watcher must stay quiet.
  harness.WF_PERMISSION.close();
  assert.equal(harness.WF_PERMISSION_OVERLAY.read(), undefined);
  const [other] = harness.renderer.mount([
    { component: harness.WfPermissionBlock, props: { sessionId: 'sess-1', run: pendingRun('run-2') } },
  ]);
  other.unmount();
  harness.renderer.flush();
  assert.equal(harness.WF_PERMISSION_OVERLAY.read(), undefined, 'the card still owns run-1');
  block.unmount();
  harness.renderer.flush();
  assert.equal(harness.WF_PERMISSION_OVERLAY.read()?.runId, 'run-1');
});
