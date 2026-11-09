/**
 * Unit tests for host/store.js — run lifecycle, artifacts, drafts, saved workflows, YAML format.
 * Fixtures live in os.tmpdir() and are removed after each test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createStore,
  parseSavedWorkflowFile,
  serializeSavedWorkflowFile,
  validateSavedWorkflowName,
  INVALID_SAVED_NAME_MESSAGE,
  MAX_SAVED_NAME_LENGTH,
  SAVED_EXTENSION,
  DEFAULT_IGNORE,
} from '../host/store.js';

/**
 * @returns {Promise<{ base: string, project: string, home: string, store: ReturnType<typeof createStore>, cleanup: () => Promise<void> }>}
 */
async function fixture() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dwf-store-'));
  const project = path.join(base, 'project');
  const home = path.join(base, 'home');
  await fsp.mkdir(project, { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  const store = createStore({ homeDir: home, getProjectRoot: () => project });
  return {
    base,
    project,
    home,
    store,
    cleanup: async () => {
      await fsp.rm(base, { recursive: true, force: true });
    },
  };
}

const SCRIPT = 'phase("preflight");\nreturn { answer: 42 };\n';

test('serialize and parse round-trip metadata', () => {
  const meta = {
    description: 'Deploy the app: end to end.',
    whenToUse: 'When the user asks to ship.',
    args: {
      target: { type: 'string', description: 'Deployment target', required: true, default: 'staging' },
      retries: { type: 'number', default: 3 },
      dry: { type: 'boolean', default: false },
      extra: { type: 'json', description: 'Arbitrary payload', default: { a: [1, 2] } },
    },
  };
  const text = serializeSavedWorkflowFile(meta, SCRIPT);
  assert.ok(text.startsWith('/* zcode-workflow\n'));
  assert.ok(text.includes('*/'));
  assert.ok(text.endsWith(SCRIPT));

  const parsed = parseSavedWorkflowFile(text);
  assert.deepEqual(parsed.ok, true);
  assert.deepEqual(parsed.meta.description, meta.description);
  assert.deepEqual(parsed.meta.whenToUse, meta.whenToUse);
  assert.deepEqual(parsed.meta.args, meta.args);
  assert.equal(parsed.body.includes(SCRIPT), true);
  assert.equal(parsed.script, parsed.body);
  assert.ok(parsed.bodyLineOffset > 0);

  // Diagnostics line math: body line N is file line N + bodyLineOffset.
  const fileLines = text.split('\n');
  const bodyLines = parsed.body.split('\n');
  const scriptIndex = bodyLines.findIndex((line) => line.includes(SCRIPT.split('\n')[0]));
  const fileIndex = fileLines.findIndex((line) => line === SCRIPT.split('\n')[0]);
  assert.equal(fileIndex + 1, parsed.bodyLineOffset + scriptIndex + 1);
});

test('parse reports the four failure reasons', () => {
  const missing = parseSavedWorkflowFile('export default 1;\n');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing_frontmatter');

  const unterminated = parseSavedWorkflowFile('/* zcode-workflow\ndescription: X\n');
  assert.equal(unterminated.reason, 'unterminated_frontmatter');
  assert.match(unterminated.detail, /never closed/u);

  const badYaml = parseSavedWorkflowFile('/* zcode-workflow\ndescription: [unclosed\n*/\nreturn 1;\n');
  assert.equal(badYaml.reason, 'invalid_yaml');

  const badMeta = parseSavedWorkflowFile('/* zcode-workflow\ndescription: ""\n*/\nreturn 1;\n');
  assert.equal(badMeta.reason, 'invalid_metadata');
  assert.match(badMeta.detail, /description/u);

  const unknownKey = parseSavedWorkflowFile('/* zcode-workflow\ndescription: Fine.\nbogus: 1\n*/\nreturn 1;\n');
  assert.equal(unknownKey.reason, 'invalid_metadata');
  assert.match(unknownKey.detail, /bogus: unrecognized key/u);

  const badArgType = parseSavedWorkflowFile(`/* zcode-workflow
description: Fine.
args:
  n:
    type: integer
*/\nreturn 1;\n`);
  assert.equal(badArgType.reason, 'invalid_metadata');
  assert.match(badArgType.detail, /args\.n\.type/u);
});

test('saved workflow names are validated', () => {
  assert.equal(validateSavedWorkflowName('ok-name_1.2').ok, true);
  assert.deepEqual(validateSavedWorkflowName(''), { ok: false, message: INVALID_SAVED_NAME_MESSAGE });
  assert.deepEqual(validateSavedWorkflowName('bad name'), { ok: false, message: INVALID_SAVED_NAME_MESSAGE });
  assert.deepEqual(validateSavedWorkflowName('x'.repeat(MAX_SAVED_NAME_LENGTH + 1)), { ok: false, message: INVALID_SAVED_NAME_MESSAGE });
  assert.equal(validateSavedWorkflowName('x'.repeat(MAX_SAVED_NAME_LENGTH)).ok, true);
});

test('run lifecycle: create, get, update, journal, settle', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  const created = await f.store.createRun({
    id: 'run-1',
    name: 'demo',
    status: 'running',
    code: SCRIPT,
    args: { target: 'prod' },
    maxConcurrency: 4,
    origin: 'workflow',
  });
  assert.equal(created.id, 'run-1');
  assert.equal(created.cwd, f.project);
  assert.equal(typeof created.createdAt, 'number');
  assert.equal(typeof created.updatedAt, 'number');

  const runDir = path.join(f.project, '.dsh', 'workflow-runs', 'run-1');
  const meta = JSON.parse(await fsp.readFile(path.join(runDir, 'meta.json'), 'utf8'));
  assert.equal(meta.code, undefined, 'code must be dropped from meta.json');
  assert.equal(await fsp.readFile(path.join(runDir, 'script.ts'), 'utf8'), SCRIPT);

  const loaded = await f.store.getRun('run-1');
  assert.equal(loaded.name, 'demo');
  assert.deepEqual(loaded.args, { target: 'prod' });

  const updated = await f.store.updateRun('run-1', { maxConcurrency: 8, supersededBy: 'run-2' });
  assert.equal(updated.maxConcurrency, 8);
  assert.equal(updated.supersededBy, 'run-2');
  assert.equal((await f.store.getRun('run-1')).maxConcurrency, 8);

  await f.store.appendEvent('run-1', { type: 'phase/started', name: 'preflight' });
  await f.store.appendEvent('run-1', { type: 'agent/settled', name: 'reader', tokens: 12 });
  const events = await f.store.readEvents('run-1');
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'phase/started');
  assert.equal(typeof events[0].at, 'number');

  // A torn journal line after a crash is skipped, not fatal.
  await fsp.appendFile(path.join(runDir, 'journal.jsonl'), 'not json\n');
  assert.equal((await f.store.readEvents('run-1')).length, 2);

  const settled = await f.store.settleRun('run-1', {
    status: 'completed',
    stopReason: 'completed',
    result: { answer: 42 },
    finishedAt: 1_700_000_000_000,
  });
  assert.equal(settled.status, 'completed');
  assert.equal(settled.finishedAt, 1_700_000_000_000);
  assert.deepEqual(settled.result, { answer: 42 });
  const resultFile = JSON.parse(await fsp.readFile(path.join(runDir, 'result.json'), 'utf8'));
  assert.deepEqual(resultFile, { answer: 42 });

  assert.equal(await f.store.updateRun('missing-run', { status: 'stopped' }), undefined);
  assert.equal(await f.store.getRun('missing-run'), undefined);
  assert.deepEqual(await f.store.readEvents('missing-run'), []);
});

test('listRuns merges scopes, sorts newest first, skips corrupt metadata', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  await f.store.createRun({ id: 'r-old', name: 'old', status: 'completed', createdAt: 1000 });
  await f.store.createRun({ id: 'r-new', name: 'new', status: 'running', createdAt: 2000 });
  await f.store.createRun({ id: 'r-lim', name: 'lim', status: 'completed', createdAt: 1500 });

  // A corrupt meta.json must be skipped, not thrown on.
  const corruptDir = path.join(f.project, '.dsh', 'workflow-runs', 'r-corrupt');
  await fsp.mkdir(corruptDir, { recursive: true });
  await fsp.writeFile(path.join(corruptDir, 'meta.json'), '{ not json');

  // A global run appears only in the all-runs view.
  const globalDir = path.join(f.home, 'workflow-runs', 'g-1');
  await fsp.mkdir(globalDir, { recursive: true });
  await fsp.writeFile(
    path.join(globalDir, 'meta.json'),
    JSON.stringify({ id: 'g-1', name: 'global', status: 'stopped', createdAt: 3000, cwd: f.project }),
  );

  const projectRows = await f.store.listRuns({ cwd: f.project });
  assert.deepEqual(projectRows.map((row) => row.id), ['r-new', 'r-lim', 'r-old']);

  const allRows = await f.store.listRuns({ project: false, cwd: f.project });
  assert.deepEqual(allRows.map((row) => row.id), ['g-1', 'r-new', 'r-lim', 'r-old']);

  const limited = await f.store.listRuns({ cwd: f.project, limit: 2 });
  assert.deepEqual(limited.map((row) => row.id), ['r-new', 'r-lim']);

  // getRun falls through to the global runs dir.
  assert.equal((await f.store.getRun('g-1')).name, 'global');

  // A running run owned by a dead process reports a possible interruption.
  await f.store.createRun({ id: 'r-stale', name: 'stale', status: 'running', createdAt: 500, pid: 2_147_483_646 });
  const stale = (await f.store.listRuns({ cwd: f.project })).find((row) => row.id === 'r-stale');
  assert.equal(stale.possibleInterruption, true);
  const live = (await f.store.listRuns({ cwd: f.project })).find((row) => row.id === 'r-new');
  assert.equal(live.possibleInterruption, false);
});

test('artifacts: file copy, markdown versions, spec/items, manifest', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  await f.store.createRun({ id: 'run-art', name: 'art', status: 'running' });
  const source = path.join(f.base, 'report.csv');
  await fsp.writeFile(source, 'a,b\n1,2\n');

  const fileRecord = await f.store.publishArtifact('run-art', {
    id: 'report',
    kind: 'file',
    version: 1,
    title: 'Report',
    primary: true,
    sourcePath: source,
    contentType: 'text/csv',
  });
  assert.equal(fileRecord.bytes, 8);
  const copied = await f.store.artifactFilePath('run-art', 'report', 1);
  assert.ok(copied !== undefined);
  assert.equal(await fsp.readFile(copied, 'utf8'), 'a,b\n1,2\n');

  await f.store.publishArtifact('run-art', { id: 'summary', kind: 'markdown', version: 1, title: 'Summary', text: '# One\n' });
  await f.store.publishArtifact('run-art', { id: 'summary', kind: 'markdown', version: 2, title: 'Summary', text: '# Two\n' });

  const versionTwo = await f.store.artifactFilePath('run-art', 'summary', 2);
  assert.ok(versionTwo !== undefined);
  assert.equal(await fsp.readFile(versionTwo, 'utf8'), '# Two\n');
  assert.equal(await f.store.artifactFilePath('run-art', 'summary', 3), undefined);

  await f.store.publishArtifact('run-art', {
    id: 'chart',
    kind: 'chart',
    version: 1,
    title: 'Chart',
    spec: { type: 'bar', series: [1, 2] },
    items: [{ label: 'a', value: 1 }],
  });

  const manifest = await f.store.readArtifactManifest('run-art');
  assert.equal(manifest.length, 4);
  assert.deepEqual(manifest.map((row) => `${row.id}@${row.version}`), ['chart@1', 'report@1', 'summary@1', 'summary@2']);
  assert.deepEqual(manifest.find((row) => row.id === 'chart').spec, { type: 'bar', series: [1, 2] });
  assert.equal(manifest.find((row) => row.id === 'chart').itemCount, 1);
  assert.equal(manifest.find((row) => row.id === 'summary' && row.version === 2).text, '# Two\n');

  const manifestPath = path.join(f.project, '.dsh', 'workflow-runs', 'run-art', 'artifacts', 'manifest.json');
  const onDisk = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  assert.ok(Array.isArray(onDisk.artifacts));

  await assert.rejects(
    () => f.store.publishArtifact('no-such-run', { id: 'x', kind: 'file' }),
    /unknown run/u,
  );
});

test('drafts: gitignore, .dwf.ts extension, uniquified names', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  const first = await f.store.writeDraft('My Workflow!', 'return 1;\n');
  assert.equal(first, path.join(f.project, '.dsh', 'workflow-drafts', `My Workflow${SAVED_EXTENSION}`));
  assert.equal(await fsp.readFile(first, 'utf8'), 'return 1;\n');

  const gitignore = await fsp.readFile(path.join(f.project, '.dsh', 'workflow-drafts', '.gitignore'), 'utf8');
  assert.equal(gitignore.trim(), '*');
  assert.ok(DEFAULT_IGNORE.includes('.dsh/workflow-drafts/'));

  const second = await f.store.writeDraft('My Workflow!', 'return 2;\n');
  assert.equal(second, path.join(f.project, '.dsh', 'workflow-drafts', `My Workflow-2${SAVED_EXTENSION}`));
  const third = await f.store.writeDraft('My Workflow!', 'return 3;\n');
  assert.equal(third, path.join(f.project, '.dsh', 'workflow-drafts', `My Workflow-3${SAVED_EXTENSION}`));

  const empty = await f.store.writeDraft('', 'return 0;\n');
  assert.equal(path.basename(empty), `workflow${SAVED_EXTENSION}`);
});

test('saved workflows: round-trip, scopes, shadowing, ZCode compatibility', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  const project = await f.store.saveSavedWorkflow({
    cwd: f.project,
    name: 'deploy',
    scope: 'project',
    code: 'return "project";\n',
    meta: { description: 'Project deploy.', whenToUse: 'Project when.', args: { target: { type: 'string', required: true } } },
  });
  assert.equal(project.ok, true);
  assert.equal(project.scope, 'project');
  assert.equal(project.overwritten, false);
  assert.equal(project.path, path.join(f.project, '.dsh', 'workflows', `deploy${SAVED_EXTENSION}`));
  const fileText = await fsp.readFile(project.path, 'utf8');
  assert.ok(fileText.startsWith('/* zcode-workflow\n'));
  assert.ok(fileText.includes('description: Project deploy.'));
  assert.ok(fileText.includes('whenToUse: Project when.'));
  assert.ok(fileText.endsWith('return "project";\n'));

  const global = await f.store.saveSavedWorkflow({
    cwd: f.project,
    name: 'deploy',
    scope: 'global',
    code: 'return "global";\n',
    meta: { description: 'Global deploy.' },
  });
  assert.equal(global.ok, true);
  assert.equal(global.path, path.join(f.home, 'workflows', `deploy${SAVED_EXTENSION}`));

  const list = await f.store.listSavedWorkflows({ cwd: f.project });
  assert.ok(Array.isArray(list), 'list must be usable as an array');
  assert.equal(list.length, 1);
  assert.equal(list.entries, list);
  assert.deepEqual(list.invalid, []);
  assert.equal(list[0].name, 'deploy');
  assert.equal(list[0].scope, 'project');
  assert.equal(list[0].meta.description, 'Project deploy.');
  assert.equal(list[0].description, 'Project deploy.');

  const resolved = await f.store.getSavedWorkflow('deploy', { cwd: f.project });
  assert.equal(resolved.scope, 'project');
  assert.equal(resolved.code, '\nreturn "project";\n');
  assert.equal(resolved.meta.args.target.type, 'string');
  assert.equal(resolved.meta.args.target.required, true);

  const globalOnly = await f.store.getSavedWorkflow('deploy', { scope: 'global', cwd: f.project });
  assert.equal(globalOnly.scope, 'global');
  assert.equal(globalOnly.meta.description, 'Global deploy.');

  // A global-only workflow is visible from the project listing with global scope.
  await f.store.saveSavedWorkflow({ cwd: f.home, name: 'ship', scope: 'global', code: 'return 1;\n', meta: { description: 'Ship it.' } });
  const withGlobal = await f.store.listSavedWorkflows({ cwd: f.project });
  const ship = withGlobal.find((entry) => entry.name === 'ship');
  assert.equal(ship.scope, 'global');
  // Without a scope the lookup falls through project → global (ZCode's resolve order).
  assert.equal((await f.store.getSavedWorkflow('ship', { cwd: f.project })).scope, 'global');
  assert.equal(await f.store.getSavedWorkflow('ship', { scope: 'project', cwd: f.project }), undefined);

  // `.zcode` archives stay readable (project .zcode file, global .zcode file).
  const zcodeProject = path.join(f.project, '.zcode', 'workflows');
  await fsp.mkdir(zcodeProject, { recursive: true });
  await fsp.writeFile(
    path.join(zcodeProject, `legacy${SAVED_EXTENSION}`),
    serializeSavedWorkflowFile({ description: 'Legacy project.' }, 'return "legacy";\n'),
  );
  const zcodeGlobal = path.join(f.home, '.zcode', 'workflows');
  await fsp.mkdir(zcodeGlobal, { recursive: true });
  await fsp.writeFile(
    path.join(zcodeGlobal, `ancient${SAVED_EXTENSION}`),
    serializeSavedWorkflowFile({ description: 'Ancient global.' }, 'return "ancient";\n'),
  );

  const compatList = await f.store.listSavedWorkflows({ cwd: f.project });
  assert.equal(compatList.find((entry) => entry.name === 'legacy').scope, 'project');
  assert.equal(compatList.find((entry) => entry.name === 'ancient').scope, 'global');
  assert.equal((await f.store.getSavedWorkflow('legacy', { cwd: f.project })).meta.description, 'Legacy project.');

  // `.dsh` shadows `.zcode` within the same scope.
  await fsp.writeFile(
    path.join(zcodeProject, `shadow${SAVED_EXTENSION}`),
    serializeSavedWorkflowFile({ description: 'ZCode shadow.' }, 'return "z";\n'),
  );
  await f.store.saveSavedWorkflow({ cwd: f.project, name: 'shadow', scope: 'project', code: 'return "dsh";\n', meta: { description: 'DSH shadow.' } });
  const shadowList = await f.store.listSavedWorkflows({ cwd: f.project });
  assert.equal(shadowList.filter((entry) => entry.name === 'shadow').length, 1);
  assert.equal((await f.store.getSavedWorkflow('shadow', { cwd: f.project })).meta.description, 'DSH shadow.');

  // Invalid files are reported, not thrown; valid entries still list.
  const validDir = path.join(f.project, '.dsh', 'workflows');
  await fsp.writeFile(path.join(validDir, 'bad name.dwf.ts'), '/* zcode-workflow\ndescription: X\n*/\n');
  await fsp.writeFile(path.join(validDir, 'broken.dwf.ts'), 'not a workflow');
  const mixed = await f.store.listSavedWorkflows({ cwd: f.project });
  assert.equal(mixed.invalid.length, 2);
  assert.ok(mixed.invalid.some((row) => row.path.endsWith('bad name.dwf.ts') && /usable workflow name/u.test(row.reason)));
  assert.ok(mixed.invalid.some((row) => row.path.endsWith('broken.dwf.ts') && row.reason.startsWith('missing_frontmatter:')));
  assert.ok(mixed.some((entry) => entry.name === 'deploy'));
});

test('saved workflows: invalid name, overwrite, delete, move', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  const invalid = await f.store.saveSavedWorkflow({ cwd: f.project, name: 'bad name', code: 'return 1;' });
  assert.deepEqual(invalid, { ok: false, message: INVALID_SAVED_NAME_MESSAGE });
  assert.equal(await f.store.getSavedWorkflow('bad name', { cwd: f.project }), undefined);
  assert.equal(await f.store.deleteSavedWorkflow('bad name', { cwd: f.project }), false);

  const first = await f.store.saveSavedWorkflow({ cwd: f.project, name: 'same', code: 'return 1;', meta: { description: 'One.' } });
  assert.equal(first.overwritten, false);
  const second = await f.store.saveSavedWorkflow({ cwd: f.project, name: 'same', code: 'return 2;', meta: { description: 'Two.' } });
  assert.equal(second.overwritten, true);
  assert.equal((await f.store.getSavedWorkflow('same', { cwd: f.project })).meta.description, 'Two.');

  const refused = await f.store.saveSavedWorkflow({ cwd: f.project, name: 'same', code: 'return 3;', meta: { description: 'Three.' }, overwrite: false });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /already exists/u);

  await f.store.saveSavedWorkflow({ cwd: f.home, name: 'mover', scope: 'global', code: 'return 4;', meta: { description: 'Mover.' } });
  const moved = await f.store.moveSavedWorkflow('mover', { cwd: f.project });
  assert.equal(moved.ok, true);
  assert.equal(moved.from, 'global');
  assert.equal(moved.to, 'project');
  assert.equal(moved.path, path.join(f.project, '.dsh', 'workflows', `mover${SAVED_EXTENSION}`));
  assert.equal((await f.store.getSavedWorkflow('mover', { cwd: f.project })).scope, 'project');
  assert.deepEqual(await f.store.moveSavedWorkflow('mover', { cwd: f.project }), {
    ok: false,
    reason: 'not_found',
    message: 'no global workflow named "mover"',
  });

  await f.store.saveSavedWorkflow({ cwd: f.home, name: 'collide', scope: 'global', code: 'return 5;' });
  await f.store.saveSavedWorkflow({ cwd: f.project, name: 'collide', scope: 'project', code: 'return 6;' });
  const collision = await f.store.moveSavedWorkflow('collide', { cwd: f.project });
  assert.equal(collision.ok, false);
  assert.equal(collision.reason, 'target_exists');
  assert.equal((await f.store.moveSavedWorkflow('collide', { from: 'project', to: 'global', cwd: f.project })).reason, 'unsupported');

  assert.equal(await f.store.deleteSavedWorkflow('collide', { scope: 'global', cwd: f.project }), true);
  assert.equal(await f.store.deleteSavedWorkflow('collide', { scope: 'global', cwd: f.project }), false);
  assert.equal(await f.store.deleteSavedWorkflow('same', { cwd: f.project }), true);
  assert.equal(await f.store.getSavedWorkflow('same', { cwd: f.project }), undefined);
});
