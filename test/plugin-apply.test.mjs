import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * A minimal Host context: enough surface for `apply` to register everything, and nothing that
 * reaches the file system beyond the plugin's own settings file.
 * @param {object} registry collected registrations
 */
function stubContext(registry) {
  const disposers = [];
  const effect = (callback, label) => {
    const dispose = callback();
    if (typeof dispose === 'function') disposers.push([label, dispose]);
    return dispose;
  };
  const ctx = {
    effect,
    on: () => () => {},
    get: (key) => {
      if (key === 'webServer') {
        return {
          register: (route) => {
            registry.routes.push(String(route.path ?? route));
            return () => {};
          },
          getOrigin: () => 'http://127.0.0.1:0',
        };
      }
      if (key === 'connection') return { requestRejection: () => undefined };
      if (key === 'commands') {
        return {
          register: (command) => {
            registry.commands.push(command.name);
            return () => {};
          },
        };
      }
      if (key === 'skills') {
        return {
          register: (skill) => {
            registry.skills.push(skill.name);
            return () => {};
          },
        };
      }
      if (key === 'workspaceRegistry') return { list: () => [] };
      return undefined;
    },
    inject: (_names, run) => run(ctx),
    tools: {
      register: (definition) => {
        registry.tools.push(definition.name);
        return () => {};
      },
    },
    systemPrompt: {
      section: (section) => {
        registry.sections.push(section.name);
        return () => {};
      },
    },
  };
  return { ctx, disposers };
}

/**
 * Register the plugin in one temporary HOME so a stale settings file cannot decide the mode.
 * @param {string} mode
 */
async function applyOnce(mode) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'zcode-workflow-apply-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const registry = { tools: [], commands: [], sections: [], skills: [], routes: [] };
  const { ctx, disposers } = stubContext(registry);
  try {
    const plugin = await import('../index.js');
    plugin.apply(ctx, { mode });
    // The skill files are read asynchronously; the apply pass schedules them through `effect`.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { registry, home, disposers };
  } finally {
    process.env.DSH_HOME = previous;
  }
}

test('alwaysOn registers the full tool surface, both commands, the prompt section and every route', async () => {
  const { registry, home, disposers } = await applyOnce('alwaysOn');
  try {
    assert.deepEqual(registry.tools, [
      'CreateWorkflow',
      'AmendWorkflow',
      'ResumeWorkflowRun',
      'GetWorkflowRun',
      'ListWorkflowRuns',
      'FillWorkflowHole',
      'EvalWorkflowSnippet',
      'SaveWorkflow',
      'ListSavedWorkflows',
      'ResolveWorkflowQuestion',
      'TaskOutput',
      'StopWorkflowRun',
    ]);
    assert.deepEqual(registry.commands, ['workflow', 'dwf']);
    assert.deepEqual(registry.sections, ['zcode-workflow']);
    assert.deepEqual(registry.skills, [
      'dynamic-workflows',
      'dynamic-workflows-examples',
      'dynamic-workflows-patterns',
    ]);
    // The data channel is the browser half's only source: every surface route must be registered.
    for (const route of [
      '/zcode-workflow/runs',
      '/zcode-workflow/run',
      '/zcode-workflow/run/events',
      '/zcode-workflow/run/artifacts',
      '/zcode-workflow/run/workspace',
      '/zcode-workflow/run/node',
      '/zcode-workflow/artifact/data',
      '/zcode-workflow/artifact/read',
      '/zcode-workflow/run/approve',
      '/zcode-workflow/run/stop',
      '/zcode-workflow/run/resume',
      '/zcode-workflow/run/fill',
      '/zcode-workflow/run/answer',
      '/zcode-workflow/workflows/list',
      '/zcode-workflow/workflows/get',
      '/zcode-workflow/workflows/save',
      '/zcode-workflow/workflows/delete',
      '/zcode-workflow/workflows/move',
      '/zcode-workflow/workflows/updateMeta',
      '/zcode-workflow/workflows/runs',
      '/zcode-workflow/workflows/forRun',
      '/zcode-workflow/policy',
    ]) {
      assert.ok(registry.routes.includes(route), `missing route ${route}`);
    }
    assert.equal(registry.routes.length, 26, `unexpected route count: ${registry.routes.join(', ')}`);
  } finally {
    for (const [, dispose] of disposers) {
      try {
        dispose();
      } catch {
        // best effort
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test('onDemand keeps the model-facing surface off until a command activates it', async () => {
  const { registry, home, disposers } = await applyOnce('onDemand');
  try {
    assert.deepEqual(registry.tools, []);
    assert.deepEqual(registry.commands, ['workflow', 'dwf']);
    // The browser data channel stays on in every mode so the settings row can switch modes.
    assert.ok(registry.routes.includes('/zcode-workflow/policy'));
  } finally {
    for (const [, dispose] of disposers) {
      try {
        dispose();
      } catch {
        // best effort
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
});
