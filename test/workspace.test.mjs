/**
 * Unit tests for host/workspace.js — path safety, glob/grep caps, git views, command runner.
 * Fixtures live in os.tmpdir() and are removed after each test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  createWorkspace,
  MAX_GLOB_MATCHES,
  MAX_GREP_MATCHES,
  MAX_READ_BYTES,
} from '../host/workspace.js';

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/** @param {string} dir @param {string} rel @param {string|Buffer} content */
async function writeFile(dir, rel, content) {
  const file = path.join(dir, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
  return file;
}

/** @returns {Promise<{ base: string, ws: string, cleanup: () => Promise<void> }>} */
async function fixture() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dwf-workspace-'));
  const ws = path.join(base, 'ws');
  await fsp.mkdir(ws, { recursive: true });
  await writeFile(base, 'outside.txt', 'outside\n');
  await writeFile(ws, 'basic/a.txt', 'alpha\nneedle one\n');
  await writeFile(ws, 'basic/sub/b.md', 'needle two\n');
  await writeFile(ws, 'skip/node_modules/dep.js', 'needle dependency\n');
  await writeFile(ws, 'skip/.git/HEAD', 'needle ref\n');
  await writeFile(ws, 'skip/.dsh/workflow-runs/run-1/meta.json', '{"needle": true}\n');
  await writeFile(ws, '.zcode/workflow-drafts/draft.dwf.ts', 'needle draft\n');
  await writeFile(ws, 'big.txt', 'x'.repeat(MAX_READ_BYTES + 1024));
  return { base, ws, cleanup: async () => fsp.rm(base, { recursive: true, force: true }) };
}

test('relativeAllowed rejects traversal and absolute escapes', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const workspace = createWorkspace({ cwd: f.ws });

  assert.equal(workspace.relativeAllowed('basic/a.txt'), true);
  assert.equal(workspace.relativeAllowed('basic/../basic/a.txt'), true);
  assert.equal(workspace.relativeAllowed('../outside.txt'), false);
  assert.equal(workspace.relativeAllowed(path.join(f.base, 'outside.txt')), false);
  assert.equal(workspace.relativeAllowed(''), false);

  assert.equal(await workspace.files.read('basic/a.txt'), 'alpha\nneedle one\n');
  assert.equal(await workspace.files.readFileText(path.join(f.ws, 'basic/a.txt')), 'alpha\nneedle one\n');
  await assert.rejects(() => workspace.files.read('../outside.txt'), /escapes the workspace/u);
  await assert.rejects(() => workspace.files.read(path.join(f.base, 'outside.txt')), /escapes the workspace/u);
  await assert.rejects(() => workspace.files.read('missing.txt'), /no such file/u);
});

test('glob lists workspace files, sorts them and skips machine-owned directories', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const workspace = createWorkspace({ cwd: f.ws });

  assert.deepEqual(await workspace.files.glob('basic/*.txt'), ['basic/a.txt']);
  assert.deepEqual(await workspace.files.glob('basic/**/*'), ['basic/a.txt', 'basic/sub/b.md']);
  assert.deepEqual(await workspace.files.glob('*.txt'), ['basic/a.txt', 'big.txt'], 'a bare pattern matches basenames at any depth (ripgrep-style)');
  assert.deepEqual(await workspace.files.glob('**/*.md'), ['basic/sub/b.md'], 'path patterns match the workspace-relative path');

  // .git, node_modules, .dsh/workflow-runs and .zcode/workflow-drafts are never walked.
  assert.deepEqual(await workspace.files.glob('**/*.js'), []);
  assert.deepEqual(await workspace.files.glob('**/*.json'), []);
  assert.deepEqual(await workspace.files.glob('**/*.dwf.ts'), []);
});

test('files.read enforces the size limit', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const workspace = createWorkspace({ cwd: f.ws });

  await assert.rejects(() => workspace.files.read('big.txt'), /limit/u);
});

test('grep returns matches, honours a glob filter and skips ignored directories', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const workspace = createWorkspace({ cwd: f.ws });

  const matches = await workspace.files.grep('needle');
  assert.deepEqual(matches, [
    { path: 'basic/a.txt', line: 2, text: 'needle one' },
    { path: 'basic/sub/b.md', line: 1, text: 'needle two' },
  ]);

  assert.deepEqual(await workspace.files.grep('needle', '**/*.md'), [{ path: 'basic/sub/b.md', line: 1, text: 'needle two' }]);
  assert.deepEqual(await workspace.files.grep('^alpha$'), [{ path: 'basic/a.txt', line: 1, text: 'alpha' }]);
  await assert.rejects(() => workspace.files.grep('('), /invalid grep pattern/u);
});

test('runCommand resolves on any exit code and supports output modes', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const workspace = createWorkspace({ cwd: f.ws });
  const node = process.execPath;

  const nonzero = await workspace.runCommand(node, ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)']);
  assert.deepEqual(nonzero, { exitCode: 3, stdout: 'out', stderr: 'err' });

  const discard = await workspace.runCommand(node, ['-e', 'process.stdout.write("discarded")'], { output: 'discard' });
  assert.deepEqual(discard, { exitCode: 0, stdout: '', stderr: '' });

  const tail = await workspace.runCommand(node, ['-e', 'process.stdout.write("abcdefghij")'], { output: { tail: 4 } });
  assert.equal(tail.stdout, 'ghij');

  const cwdRun = await workspace.runCommand(node, ['-e', 'process.stdout.write(process.cwd())']);
  assert.equal(cwdRun.stdout, f.ws);

  const empty = await workspace.runCommand(node, ['-e', 'process.exit(0)']);
  assert.deepEqual(empty, { exitCode: 0, stdout: '', stderr: '' });
});

test('runCommand rejects on spawn failure and timeout', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const workspace = createWorkspace({ cwd: f.ws });

  await assert.rejects(
    () => workspace.runCommand('definitely-not-a-real-command-zcode-workflow', []),
    /failed to spawn|ENOENT/u,
  );

  const started = Date.now();
  await assert.rejects(
    () => workspace.runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 250 }),
    /timed out/u,
  );
  assert.ok(Date.now() - started < 10_000, 'timeout must not wait for the child to finish');
});

test('git views reject outside a repository', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  if (!HAS_GIT) return t.skip('git is not installed');
  const workspace = createWorkspace({ cwd: f.ws });

  await assert.rejects(() => workspace.git.status(), /not a git repository/u);
  await assert.rejects(() => workspace.git.log(), /not a git repository/u);
  await assert.rejects(() => workspace.git.changedFiles(), /not a git repository/u);
  await assert.rejects(() => workspace.git.diff(), /not a git repository/u);
});

test('git status, log, changed files and diff in a fresh repository', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed');
  const f = await fixture();
  t.after(f.cleanup);
  const repo = path.join(f.base, 'repo');
  await fsp.mkdir(repo, { recursive: true });
  /** @param {string[]} args */
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  };
  git(['init']);
  git(['config', 'user.email', 'workflow@example.invalid']);
  git(['config', 'user.name', 'Workflow Test']);
  await fsp.writeFile(path.join(repo, 'a.txt'), 'alpha\n');
  await fsp.writeFile(path.join(repo, 'b.txt'), 'beta\n');
  git(['add', '-A']);
  git(['commit', '-m', 'first commit']);

  const workspace = createWorkspace({ cwd: repo });
  const cleanStatus = await workspace.git.status();
  assert.equal(cleanStatus.clean, true);
  assert.deepEqual(cleanStatus.staged, []);
  assert.deepEqual(cleanStatus.unstaged, []);
  assert.deepEqual(cleanStatus.untracked, []);
  assert.equal(typeof cleanStatus.branch, 'string');
  assert.notEqual(cleanStatus.branch, '');

  const commits = await workspace.git.log(5);
  assert.equal(commits.length, 1);
  assert.match(commits[0].hash, /^[0-9a-f]{40}$/u);
  assert.equal(commits[0].subject, 'first commit');
  assert.equal(commits[0].author, 'Workflow Test');
  assert.ok(Number.isFinite(Date.parse(commits[0].date)));

  await fsp.writeFile(path.join(repo, 'a.txt'), 'alpha\nchanged\n');
  await fsp.writeFile(path.join(repo, 'c.txt'), 'untracked\n');

  const dirtyStatus = await workspace.git.status();
  assert.equal(dirtyStatus.clean, false);
  assert.deepEqual(dirtyStatus.unstaged, ['a.txt']);
  assert.deepEqual(dirtyStatus.untracked, ['c.txt']);

  const changed = await workspace.git.changedFiles();
  assert.ok(changed.includes('a.txt'));
  assert.ok(changed.includes('c.txt'));

  const changedFromHead = await workspace.git.changedFiles('HEAD');
  assert.deepEqual(changed, changedFromHead);

  const diff = await workspace.git.diff();
  assert.match(diff, /alpha/u);
  assert.match(diff, /changed/u);

  const scopedDiff = await workspace.git.diff(undefined, 'a.txt');
  assert.match(scopedDiff, /a\.txt/u);
  await assert.rejects(() => workspace.git.diff(undefined, '../outside.txt'), /escapes the workspace/u);
});

test('git log in an empty repository returns no commits', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed');
  const f = await fixture();
  t.after(f.cleanup);
  const repo = path.join(f.base, 'empty-repo');
  await fsp.mkdir(repo, { recursive: true });
  const init = spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
  if (init.status !== 0) return t.skip(`git init failed: ${init.stderr}`);

  const workspace = createWorkspace({ cwd: repo });
  assert.deepEqual(await workspace.git.log(), []);
  const status = await workspace.git.status();
  assert.equal(status.clean, true);
});

test('glob rejects more than the match cap', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const workspace = createWorkspace({ cwd: f.ws });

  const many = path.join(f.ws, 'many');
  await fsp.mkdir(many, { recursive: true });
  for (let start = 0; start < MAX_GLOB_MATCHES + 5; start += 100) {
    const batch = [];
    for (let index = start; index < Math.min(start + 100, MAX_GLOB_MATCHES + 5); index += 1) {
      batch.push(fsp.writeFile(path.join(many, `f${index}.txt`), 'x\n'));
    }
    await Promise.all(batch);
  }

  await assert.rejects(() => workspace.files.glob('many/*.txt'), /more than 2000 files/u);
});

test('grep rejects more than the match cap', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const workspace = createWorkspace({ cwd: f.ws });

  await writeFile(f.ws, 'lines.txt', `${'needle\n'.repeat(MAX_GREP_MATCHES + 5)}`);
  await assert.rejects(() => workspace.files.grep('needle'), /more than 2000 lines/u);
});
