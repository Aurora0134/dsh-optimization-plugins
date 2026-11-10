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
  MAX_RUNS_PER_SNAPSHOT,
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

  // `description` may be the empty string (upstream's `Ow` allows it); a non-string is not.
  const emptyDescription = parseSavedWorkflowFile('/* zcode-workflow\ndescription: ""\n*/\nreturn 1;\n');
  assert.equal(emptyDescription.ok, true);

  const badMeta = parseSavedWorkflowFile('/* zcode-workflow\ndescription: 5\n*/\nreturn 1;\n');
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

  // label: 显式 name → 脚本首个非空行 → runId；resumable 跟随停止原因。
  const unnamedDir = path.join(f.project, '.dsh', 'workflow-runs', 'r-script');
  await fsp.mkdir(unnamedDir, { recursive: true });
  await fsp.writeFile(path.join(unnamedDir, 'meta.json'), JSON.stringify({ id: 'r-script', status: 'stopped', stopReason: 'user', createdAt: 4000, cwd: f.project, script_path: 'script.ts' }), 'utf8');
  await fsp.writeFile(path.join(unnamedDir, 'script.ts'), '\n// A workflow that reviews changes\nphase("review");\n', 'utf8');
  await f.store.createRun({ id: 'r-superseded', status: 'stopped', createdAt: 5000, cwd: f.project });
  await f.store.updateRunStatus('r-superseded', 'stopped', { stopReason: 'superseded', supersededBy: 'r-new' });
  const rows = await f.store.listRuns({ cwd: f.project });
  const scriptLabeled = rows.find((row) => row.id === 'r-script');
  assert.equal(scriptLabeled.label, '// A workflow that reviews changes');
  const resumed = rows.find((row) => row.id === 'r-script');
  assert.equal(resumed.resumable, true);
  const superseded = rows.find((row) => row.id === 'r-superseded');
  assert.equal(superseded.resumable, false);

  // A settled run exposes the failure code recorded in meta.json.
  await f.store.createRun({ id: 'r-failed', name: 'failed', status: 'errored', createdAt: 6000, cwd: f.project, error: { code: 'SCRIPT_ERROR', message: 'boom' } });
  const failed = (await f.store.listRuns({ cwd: f.project })).find((row) => row.id === 'r-failed');
  assert.equal(failed.failureCode, 'SCRIPT_ERROR');
  assert.equal(failed.failureMessage, 'boom');
  // labelSource 只有 "name" | "script"（cli.md:205）：显式 name 才算 name，脚本行/runId 回退算 script。
  assert.equal(failed.labelSource, 'name');
  assert.equal(scriptLabeled.labelSource, 'script');
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
  // The metadata block ends with a single newline before the body: `workflows/get.script` returns
  // the script text itself, not one with a leading blank line.
  assert.equal(resolved.code, 'return "project";\n');
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
  // `overwrite` defaults to false: a second save of an existing name is refused, not silent.
  const second = await f.store.saveSavedWorkflow({ cwd: f.project, name: 'same', code: 'return 2;', meta: { description: 'Two.' } });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'target_exists');
  const overwritten = await f.store.saveSavedWorkflow({
    cwd: f.project,
    name: 'same',
    code: 'return 2;',
    meta: { description: 'Two.' },
    overwrite: true,
  });
  assert.equal(overwritten.overwritten, true);
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
  // 契约 workflows/move 不带方向（engine.md:260）：同一份工作流再调一次就搬回全局。
  const back = await f.store.moveSavedWorkflow('mover', { cwd: f.project });
  assert.equal(back.ok, true);
  assert.equal(back.from, 'project');
  assert.equal(back.to, 'global');
  assert.equal(back.path, path.join(f.home, 'workflows', `mover${SAVED_EXTENSION}`));
  assert.equal((await f.store.getSavedWorkflow('mover', { cwd: f.project })).scope, 'global');
  assert.equal((await f.store.moveSavedWorkflow('nobody-here', { cwd: f.project })).reason, 'not_found');

  await f.store.saveSavedWorkflow({ cwd: f.home, name: 'collide', scope: 'global', code: 'return 5;' });
  await f.store.saveSavedWorkflow({ cwd: f.project, name: 'collide', scope: 'project', code: 'return 6;' });
  const collision = await f.store.moveSavedWorkflow('collide', { cwd: f.project });
  assert.equal(collision.ok, false);
  assert.equal(collision.reason, 'target_exists');

  assert.equal(await f.store.deleteSavedWorkflow('collide', { scope: 'global', cwd: f.project }), true);
  assert.equal(await f.store.deleteSavedWorkflow('collide', { scope: 'global', cwd: f.project }), false);
  assert.equal(await f.store.deleteSavedWorkflow('same', { cwd: f.project }), true);
  assert.equal(await f.store.getSavedWorkflow('same', { cwd: f.project }), undefined);
});

test('meta.json uses the §4 dwf_run field names and maps the two status enums', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  const created = await f.store.createRun({
    id: 'run-canon',
    name: 'canonical',
    code: 'return 1;\\n',
    args: { target: 'prod' },
    maxConcurrency: 3,
    parentSessionId: 'session-1',
    toolCallId: 'tool-1',
  });
  assert.equal(created.status, 'running');
  const dir = path.join(f.project, '.dsh', 'workflow-runs', 'run-canon');
  const raw = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(raw.parent_session_id, 'session-1');
  assert.equal(raw.tool_call_id, 'tool-1');
  assert.equal(raw.caps_max_concurrency, 3);
  assert.equal(raw.args_json, JSON.stringify({ target: 'prod' }));
  assert.equal(raw.status, 'running');
  assert.equal(typeof raw.script_hash, 'string');
  assert.equal(raw.code, undefined);
  assert.equal(typeof raw.time_created, 'number');
  assert.equal(typeof raw.time_updated, 'number');

  const errored = await f.store.settleRun('run-canon', { status: 'errored', error: 'boom', result: null });
  assert.equal(errored.status, 'errored');
  assert.equal(errored.error, 'boom');
  assert.equal(errored.result, null);
  const stored = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
  // DB 侧 failed/cancelled ↔ 事件侧 errored/stopped（§4.2）。
  assert.equal(stored.status, 'failed');
  assert.equal(stored.workflow_state, 'errored');
  assert.equal(stored.failure_json.message, 'boom');
});

test('appendEvent assigns sequence, updates the watermark and projectRun folds the events', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  await f.store.createRun({ id: 'run-proj', name: 'projection', status: 'running', code: 'return 1;\\n' });
  const first = await f.store.appendEvent('run-proj', { type: 'run-started', caps: { maxConcurrency: 2 } });
  await f.store.appendEvent('run-proj', { type: 'run-launched', phaseNames: ['prep', 'ship'], holes: [1] });
  await f.store.appendEvent('run-proj', {
    type: 'actor-created',
    actor: { siteId: 'actor-a', ordinal: 0 },
    name: 'reviewer',
    phaseName: 'prep',
  });
  await f.store.appendEvent('run-proj', {
    type: 'node-queued',
    instance: { siteId: 'node-a', ordinal: 0 },
    kind: 'ask',
    phaseName: 'prep',
  });
  await f.store.appendEvent('run-proj', {
    type: 'node-dispatched',
    instance: { siteId: 'node-a', ordinal: 0 },
    actor: { siteId: 'actor-a', ordinal: 0 },
  });
  assert.equal(first.sequence, 0);

  const page = await f.store.readEventPage('run-proj', { afterSequence: 1, limit: 2 });
  assert.deepEqual(page.events.map((event) => event.sequence), [2, 3]);
  assert.equal(page.hasMore, true);
  assert.equal(page.lastEventSequence, 4);

  const snapshot = await f.store.projectRun('run-proj');
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.actors.length, 1);
  assert.equal(snapshot.actors[0].status, 'waiting');
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.nodes[0].phase, 'dispatched');
  assert.equal(snapshot.lastEventSequence, 4);
  assert.deepEqual(snapshot.phaseNames, ['prep', 'ship']);
  assert.deepEqual(snapshot.phaseHoles, [1]);

  const events = await f.store.readEvents('run-proj');
  assert.equal(events[0].type, 'run-started');
  assert.equal(events[0].caps.maxConcurrency, 2);
  assert.equal(typeof events[0].at, 'number');
});

test('the session snapshot keeps the last 8 runs in arrival order and bumps revision', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  for (let index = 0; index < 10; index += 1) {
    await f.store.createRun({ id: `snap-${index}`, name: `snap-${index}`, status: 'running' });
  }
  const snapshot = await f.store.listRunSnapshots({ cwd: f.project });
  assert.equal(snapshot.runs.length, MAX_RUNS_PER_SNAPSHOT);
  assert.deepEqual(snapshot.runs.map((run) => run.runId), [
    'snap-2', 'snap-3', 'snap-4', 'snap-5', 'snap-6', 'snap-7', 'snap-8', 'snap-9',
  ]);
  assert.equal(snapshot.revision, 10);

  await f.store.appendEvent('snap-3', { type: 'usage-updated', spentTokens: 7 });
  const after = await f.store.listRunSnapshots({ cwd: f.project });
  assert.equal(after.revision, 11);
  assert.equal(after.runs[after.runs.length - 1].runId, 'snap-3');
});

test('listRunsForSession orders by updatedAt and defaults to 16 rows', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  for (let index = 0; index < 20; index += 1) {
    await f.store.createRun({
      id: `page-${String(index).padStart(2, '0')}`,
      name: `page-${index}`,
      status: 'completed',
      createdAt: 1,
      updatedAt: index,
    });
  }
  const rows = await f.store.listRunsForSession({ cwd: f.project });
  assert.equal(rows.length, 16);
  assert.equal(rows[0].id, 'page-19');
  assert.equal(rows[15].id, 'page-04');

  await f.store.updateRun('page-00', { parentSessionId: 'session-x' });
  const attributed = await f.store.listRunsForSession({ cwd: f.project, parentSessionId: 'session-x' });
  assert.deepEqual(attributed.map((row) => row.id), ['page-00']);

  // 旧运行没有 parent_session_id 时退回项目全部 run，避免升级后页面空白。
  const fallback = await f.store.listRunsForSession({ cwd: f.project, parentSessionId: 'missing-session' });
  assert.equal(fallback.length, 16);
});

test('actor/node persistence backs workspace and node-result reads', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  await f.store.createRun({ id: 'run-world', name: 'world', status: 'running' });
  await f.store.recordActor('run-world', {
    siteId: 'actor-a',
    ordinal: 0,
    name: 'runner',
    persona: { tone: 'terse' },
    model: 'model-a',
    sessionId: 'session-child',
  });
  const actors = await f.store.listActors('run-world');
  assert.equal(actors[0].site_id, 'actor-a');
  assert.equal(actors[0].resolved_model, 'model-a');

  // Over the 4 KiB whole-input budget the recorded call keeps eight args, each clipped at 400
  // characters with an ellipsis — the contract's `boundWorldReadInput` behaviour.
  // A call whose whole `{op,args}` fits in the 4 KiB budget is recorded untouched.
  await f.store.recordNode('run-world', {
    siteId: 'site-small',
    ordinal: 0,
    kind: 'world-run',
    input: { op: 'git', args: ['status', '--short'] },
    status: 'completed',
    result: { exitCode: 0, stdout: 'ok', stderr: '' },
  });
  const small = await f.store.getNode('run-world', 'site-small', 0);
  assert.deepEqual(small.input, { op: 'git', args: ['status', '--short'] });

  const args = Array.from({ length: 20 }, (_, index) => (index === 0 ? 'x'.repeat(900) : 'y'.repeat(900)));
  await f.store.recordNode('run-world', {
    siteId: 'site-a',
    ordinal: 0,
    kind: 'world-run',
    input: { op: 'git', args },
    status: 'completed',
    result: { exitCode: 0, stdout: 'ok', stderr: 'noise' },
  });
  const node = await f.store.getNode('run-world', 'site-a', 0);
  assert.equal(node.kind, 'world-run');
  assert.equal(node.input.args.length, 8);
  assert.equal(node.input.truncated, true);
  assert.equal(node.input.args[0].at(-1), '…');

  const workspace = await f.store.listWorldNodes('run-world');
  assert.equal(workspace.truncated, false);
  const truncatedNode = workspace.nodes.find((candidate) => candidate.siteId === 'site-a');
  assert.equal(truncatedNode.op, 'git');
  assert.equal(truncatedNode.args.length, 8);
  assert.equal(truncatedNode.inputTruncated, true);
  assert.equal(truncatedNode.summary.exitCode, 0);
  assert.equal(truncatedNode.summary.stdoutBytes, 2);
  assert.equal(truncatedNode.summary.stderrBytes, 5);
});

test('artifacts group versions, count tagged reports and read payload bytes', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  await f.store.createRun({ id: 'run-new-art', name: 'art', status: 'running' });
  await f.store.publishArtifact('run-new-art', {
    id: 'summary',
    kind: 'markdown',
    version: 1,
    title: 'Summary',
    text: '# One\\n',
  });
  await f.store.publishArtifact('run-new-art', {
    id: 'summary',
    kind: 'markdown',
    version: 2,
    title: 'Summary',
    primary: true,
    text: '# Two\\n',
  });
  await f.store.appendEvent('run-new-art', {
    type: 'report',
    instance: { siteId: 'site-a', ordinal: 0 },
    item: { ok: true },
    artifactId: 'summary',
  });

  const artifacts = await f.store.listArtifacts('run-new-art');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].id, 'summary');
  assert.equal(artifacts[0].version, 2);
  assert.equal(artifacts[0].versions.length, 2);
  assert.equal(artifacts[0].versions[1].uri, 'artifacts/summary/v2/Summary.md');
  assert.equal(artifacts[0].itemCount, 1);
  assert.equal(artifacts[0].primary, true);

  const payload = await f.store.readArtifactPayload('run-new-art', 'summary', 2);
  assert.equal(payload.bytes.toString('utf8'), '# Two\\n');
  assert.equal(payload.mediaType, 'text/markdown');
  assert.equal(payload.totalBytes, payload.bytes.byteLength);

  assert.equal(await f.store.readArtifactPayload('run-new-art', 'summary', 9), undefined);
});

test('artifact versions are capped at 16 per id', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  await f.store.createRun({ id: 'run-cap', name: 'cap', status: 'running' });
  for (let version = 1; version <= 16; version += 1) {
    await f.store.publishArtifact('run-cap', { id: 'many', kind: 'markdown', version, text: `# ${version}\\n` });
  }
  await assert.rejects(
    () => f.store.publishArtifact('run-cap', { id: 'many', kind: 'markdown', version: 17, text: '# 17\\n' }),
    (error) => error?.name === 'ArtifactVersionCapExceeded',
  );
});

test('workflows save/list runs/forRun/updateMeta/remove use the contract methods', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  await f.store.createRun({
    id: 'run-saved',
    name: 'saved-one',
    status: 'completed',
    code: 'return 42;\\n',
    args: { target: 'prod' },
    spentTokens: 9,
  });
  const saved = await f.store.saveWorkflow({
    cwd: f.project,
    runId: 'run-saved',
    name: 'saved-one',
    meta: { description: 'Saved from a run.' },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.name, 'saved-one');
  assert.equal(saved.scope, 'project');
  assert.equal(saved.overwritten, false);
  assert.equal(saved.path, path.join(f.project, '.dsh', 'workflows', `saved-one${SAVED_EXTENSION}`));

  const runs = await f.store.listSavedWorkflowRuns('saved-one', { cwd: f.project, limit: 10 });
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0].runId, 'run-saved');
  assert.equal(runs.runs[0].spentTokens, 9);

  const forRun = await f.store.resolveSavedWorkflowForRun({ cwd: f.project, runId: 'run-saved' });
  assert.equal(forRun.match, 'script');
  assert.equal(forRun.entry.name, 'saved-one');
  assert.deepEqual(forRun.runArgs, { target: 'prod' });

  const updated = await f.store.updateSavedWorkflowMeta('saved-one', { description: 'Updated.' }, { cwd: f.project });
  assert.equal(updated.ok, true);
  assert.equal((await f.store.getSavedWorkflow('saved-one', { cwd: f.project })).meta.description, 'Updated.');

  const refused = await f.store.saveWorkflow({
    cwd: f.project,
    runId: 'run-saved',
    name: 'saved-one',
    meta: { description: 'Again.' },
    overwrite: false,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'target_exists');

  const missingRun = await f.store.saveWorkflow({
    cwd: f.project,
    runId: 'no-run',
    name: 'ghost',
    meta: { description: 'Ghost.' },
  });
  assert.deepEqual(missingRun, { ok: false, reason: 'run_not_found' });

  const removed = await f.store.removeSavedWorkflow('saved-one', { cwd: f.project });
  assert.equal(removed.ok, true);
  assert.equal(removed.path, saved.path);
});

