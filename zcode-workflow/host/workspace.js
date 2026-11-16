/**
 * zcode-workflow: read-only workspace views + command runner used by workflow scripts.
 *
 * The facade exposed to a running workflow script is deliberately small and safe:
 *
 *   files.glob(pattern)            workspace-relative paths, sorted, capped
 *   files.read(path)               UTF-8 text of one workspace file
 *   files.grep(pattern, glob?)     [{ path, line, text }] matches
 *   git.*                          read-only git views (reject outside a repository)
 *   world.run(cmd, args, opts)     child process execution, no shell
 *
 * Every path is resolved under the workspace root and rejected when it escapes (including
 * through `..`, an absolute path, or a symlink). Machine-owned state directories are never
 * walked. Commands always run with `shell: false`.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Directories never walked by glob/grep. */
export const SKIP_NAMES = new Set(['.git', 'node_modules']);
/** Workspace-relative directories never walked by glob/grep. */
export const SKIP_PATHS = new Set(['.dsh/workflow-runs', '.dsh/workflow-drafts', '.zcode/workflow-drafts']);
/** Maximum glob matches before the call rejects. */
export const MAX_GLOB_MATCHES = 2000;
/** Maximum bytes `files.read` returns. */
export const MAX_READ_BYTES = 512 * 1024;
/** Maximum grep matches before the call rejects. */
export const MAX_GREP_MATCHES = 2000;
/** Maximum grep result bytes before the call rejects. */
export const MAX_GREP_BYTES = 256 * 1024;
/** Maximum directory entries walked by one glob/grep call. */
export const MAX_WALK_ENTRIES = 50_000;
/** Maximum command output bytes retained in `full` mode. */
export const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Default command timeout. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
/** Large git diffs are truncated to this many characters. */
export const MAX_GIT_DIFF_BYTES = 1024 * 1024;

/**
 * @typedef {object} WorldRunResult
 * @property {number} exitCode
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Create the workspace facade bound to one project root.
 *
 * @param {object} options
 * @param {string} options.cwd workspace root
 * @param {any} [options.subprocess] optional DSH subprocess host service
 */
export function createWorkspace(options = {}) {
  const root = path.resolve(typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd());
  const service = typeof options.subprocess?.spawn === 'function' ? options.subprocess : undefined;
  /** @type {Promise<string> | undefined} */
  let realRootPromise;

  const realRoot = () => {
    if (realRootPromise === undefined) realRootPromise = fsp.realpath(root).catch(() => root);
    return realRootPromise;
  };

  /**
   * Resolve a workspace-relative path, rejecting anything outside the root.
   *
   * @param {string} target
   * @param {string} [label]
   * @returns {string} absolute path
   */
  const resolveInside = (target, label = 'path') => {
    if (typeof target !== 'string' || target === '' || target.includes('\u0000')) {
      throw new Error(`${label} is not a usable workspace path: ${JSON.stringify(target)}`);
    }
    const resolved = path.resolve(root, target);
    const relative = path.relative(root, resolved);
    if (relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
      throw new Error(`${label} escapes the workspace: ${target}`);
    }
    return resolved;
  };

  /**
   * Resolve a workspace-relative path and also reject symlink escapes.
   *
   * @param {string} target
   * @param {string} [label]
   * @returns {Promise<string>}
   */
  const resolveRealInside = async (target, label = 'path') => {
    const resolved = resolveInside(target, label);
    const [realFile, base] = await Promise.all([fsp.realpath(resolved).catch(() => resolved), realRoot()]);
    const relative = path.relative(base, realFile);
    if (relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
      throw new Error(`${label} escapes the workspace: ${target}`);
    }
    return resolved;
  };

  /** @param {string} target */
  const relativeAllowed = (target) => {
    try {
      resolveInside(target);
      return true;
    } catch {
      return false;
    }
  };

  /* ------------------------------- walking --------------------------------------------------- */

  /**
   * Walk the workspace, yielding workspace-relative file paths (posix separators).
   * Symlinks are not followed: the walk cannot leave the workspace or loop.
   *
   * @param {{ skip?: Set<string> }} [walkOptions]
   * @returns {AsyncGenerator<string>}
   */
  async function* walkFiles(walkOptions = {}) {
    const skip = walkOptions.skip ?? SKIP_PATHS;
    /** @param {string} rel */
    const skipped = (rel) => [...skip].some((entry) => rel === entry || rel.endsWith(`/${entry}`));
    /** @type {{ rel: string }[]} */
    const stack = [{ rel: '' }];
    let seen = 0;
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const absolute = current.rel === '' ? root : path.join(root, current.rel);
      /** @type {import('node:fs').Dirent[]} */
      let dirents;
      try {
        dirents = await fsp.readdir(absolute, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        seen += 1;
        if (seen > MAX_WALK_ENTRIES) return;
        const childRel = current.rel === '' ? dirent.name : `${current.rel}/${dirent.name}`;
        if (dirent.isDirectory()) {
          if (SKIP_NAMES.has(dirent.name) || skipped(childRel)) continue;
          stack.push({ rel: childRel });
          continue;
        }
        if (dirent.isFile()) yield childRel;
      }
    }
  }

  /* ------------------------------- files ----------------------------------------------------- */

  /**
   * List workspace files matching a glob pattern.
   *
   * Supports `*` (one path segment), `**` (any depth), `?`, character classes and `{a,b}`.
   * A pattern without a `/` is matched against the file's basename at any depth.
   *
   * @param {string} pattern
   * @returns {Promise<string[]>} sorted workspace-relative posix paths
   */
  const glob = async (pattern) => {
    const source = typeof pattern === 'string' && pattern.trim() !== '' ? pattern.trim() : '**/*';
    const matcher = compileGlob(source);
    /** @type {string[]} */
    const matches = [];
    for await (const rel of walkFiles()) {
      const candidate = source.includes('/') ? rel : path.posix.basename(rel);
      if (!matcher.test(candidate)) continue;
      matches.push(rel);
      if (matches.length > MAX_GLOB_MATCHES) {
        throw new Error(`glob matched more than ${MAX_GLOB_MATCHES} files; narrow the pattern`);
      }
    }
    matches.sort();
    return matches;
  };

  /**
   * Read one workspace file as UTF-8 text.
   *
   * @param {string} target workspace-relative or absolute path inside the workspace
   * @returns {Promise<string>}
   */
  const read = async (target) => {
    const resolved = await resolveRealInside(target, 'path');
    const stat = await fsp.stat(resolved).catch(() => undefined);
    if (stat === undefined) throw new Error(`cannot read "${target}": no such file`);
    if (!stat.isFile()) throw new Error(`cannot read "${target}": not a regular file`);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`cannot read "${target}": file is ${stat.size} bytes (limit ${MAX_READ_BYTES})`);
    }
    const buffer = await fsp.readFile(resolved);
    if (buffer.includes(0)) throw new Error(`cannot read "${target}": file looks binary`);
    return buffer.toString('utf8').replace(/^\uFEFF/u, '');
  };

  /**
   * Search workspace files for a regular expression.
   *
   * @param {string} pattern regular expression source
   * @param {string} [globPattern] optional glob filter
   * @returns {Promise<{ path: string, line: number, text: string }[]>}
   */
  const grep = async (pattern, globPattern) => {
    /** @type {RegExp} */
    let matcher;
    try {
      matcher = new RegExp(String(pattern ?? ''), 'u');
    } catch (error) {
      throw new Error(`invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`);
    }
    const fileMatcher = typeof globPattern === 'string' && globPattern !== '' ? compileGlob(globPattern) : undefined;
    /** @type {{ path: string, line: number, text: string }[]} */
    const matches = [];
    let bytes = 0;
    for await (const rel of walkFiles()) {
      if (fileMatcher !== undefined) {
        const candidate = globPattern.includes('/') ? rel : path.posix.basename(rel);
        if (!fileMatcher.test(candidate)) continue;
      }
      const absolute = path.join(root, rel);
      const stat = await fsp.stat(absolute).catch(() => undefined);
      if (stat === undefined || !stat.isFile() || stat.size > MAX_READ_BYTES) continue;
      const buffer = await fsp.readFile(absolute).catch(() => undefined);
      if (buffer === undefined || buffer.includes(0)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index];
        if (!matcher.test(text)) continue;
        matches.push({ path: rel, line: index + 1, text });
        bytes += Buffer.byteLength(rel, 'utf8') + Buffer.byteLength(text, 'utf8');
        if (matches.length > MAX_GREP_MATCHES) throw new Error(`grep matched more than ${MAX_GREP_MATCHES} lines; narrow the pattern`);
        if (bytes > MAX_GREP_BYTES) throw new Error(`grep result exceeded ${MAX_GREP_BYTES} bytes; narrow the pattern`);
      }
    }
    matches.sort((left, right) => (left.path === right.path ? left.line - right.line : left.path.localeCompare(right.path)));
    return matches;
  };

  /* ------------------------------- git ------------------------------------------------------- */

  /**
   * Run git and return stdout, throwing a readable error when git is unavailable or the command
   * fails.
   *
   * @param {string[]} args
   * @returns {Promise<string>}
   */
  const gitRun = async (args) => {
    let result;
    try {
      result = await runCommand('git', args, { timeoutMs: 60_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(/ENOENT|failed to spawn|not found/iu.test(message) ? `git is not available: ${message}` : message);
    }
    if (result.exitCode !== 0) {
      const detail = firstLine(result.stderr) || firstLine(result.stdout) || `exit code ${result.exitCode}`;
      throw new Error(`git ${args[0]} failed: ${detail}`);
    }
    return result.stdout;
  };

  /** @returns {Promise<string>} repository top level */
  const gitToplevel = async () => {
    const stdout = await gitRun(['rev-parse', '--show-toplevel']).catch((error) => {
      throw new Error(`not a git repository: ${error instanceof Error ? error.message : String(error)}`);
    });
    return stdout.trim();
  };

  /**
   * Files changed against `base` (working tree vs base, plus untracked files).
   *
   * @param {string} [base] git revision; defaults to `HEAD`
   * @returns {Promise<string[]>} workspace-relative paths
   */
  const changedFiles = async (base) => {
    await gitToplevel();
    const requested = typeof base === 'string' && base !== '' ? base : undefined;
    /** @type {string[]} */
    const files = [];
    let commit;
    try {
      const revision = requested ?? 'HEAD';
      commit = (await gitRun(['rev-parse', '--verify', `${revision}^{commit}`])).trim();
    } catch (error) {
      if (requested !== undefined) throw new Error(`unknown git revision "${requested}"`);
    }
    if (commit !== undefined && commit !== '') {
      const tracked = await gitRun(['diff', '--name-only', commit, '--']);
      files.push(...tracked.split(/\r?\n/u).filter((line) => line !== ''));
    }
    const untracked = await gitRun(['ls-files', '--others', '--exclude-standard']);
    files.push(...untracked.split(/\r?\n/u).filter((line) => line !== ''));
    return [...new Set(files)].sort();
  };

  /**
   * Unified diff text against `base`, optionally restricted to one path.
   *
   * @param {string} [base] git revision; omit for the working-tree diff
   * @param {string} [filePath] workspace-relative path
   * @returns {Promise<string>}
   */
  const diff = async (base, filePath) => {
    await gitToplevel();
    /** @type {string[]} */
    const args = ['diff'];
    if (typeof base === 'string' && base !== '') args.push(base);
    if (typeof filePath === 'string' && filePath !== '') {
      const absolute = resolveInside(filePath, 'path');
      args.push('--', path.relative(root, absolute).split(path.sep).join('/'));
    }
    const stdout = await gitRun(args);
    if (stdout.length > MAX_GIT_DIFF_BYTES) {
      return `${stdout.slice(0, MAX_GIT_DIFF_BYTES)}\n… diff truncated at ${MAX_GIT_DIFF_BYTES} bytes …\n`;
    }
    return stdout;
  };

  /**
   * Working-tree status.
   *
   * @returns {Promise<{ branch?: string, clean: boolean, staged: string[], unstaged: string[], untracked: string[] }>}
   */
  const status = async () => {
    await gitToplevel();
    let branch;
    try {
      const head = (await gitRun(['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
      if (head !== '') branch = head;
    } catch {
      // Detached HEAD: report the short hash instead of a branch name.
      try {
        const head = (await gitRun(['rev-parse', '--short', 'HEAD'])).trim();
        if (head !== '') branch = head;
      } catch {
        branch = undefined;
      }
    }
    const porcelain = await gitRun(['status', '--porcelain', '-z']);
    /** @type {string[]} */
    const staged = [];
    /** @type {string[]} */
    const unstaged = [];
    /** @type {string[]} */
    const untracked = [];
    const tokens = porcelain.split('\u0000');
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === '') continue;
      const x = token[0];
      const y = token[1];
      const file = token.slice(3);
      if (x === '?' || y === '?') {
        untracked.push(file);
        continue;
      }
      if (x === 'R' || x === 'C') index += 1; // the rename record carries the original path next
      if (x !== ' ') staged.push(file);
      if (y !== ' ') unstaged.push(file);
    }
    staged.sort();
    unstaged.sort();
    untracked.sort();
    return {
      ...(branch === undefined ? {} : { branch }),
      clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
      staged,
      unstaged,
      untracked,
    };
  };

  /**
   * Recent commits, newest first.
   *
   * @param {number} [count]
   * @returns {Promise<{ hash: string, subject: string, author: string, date: string }[]>}
   */
  const log = async (count = 20) => {
    await gitToplevel();
    const limit = Number.isFinite(count) && count > 0 ? Math.min(Math.floor(count), 1000) : 20;
    let stdout;
    try {
      stdout = await gitRun(['log', `-n${limit}`, '--pretty=format:%H%x09%an%x09%aI%x09%s']);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/does not have any commits|does not have any commit|unknown revision|bad revision|no commits yet/iu.test(message)) return [];
      throw error;
    }
    /** @type {{ hash: string, subject: string, author: string, date: string }[]} */
    const commits = [];
    for (const line of stdout.split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      const [hash = '', author = '', date = '', ...rest] = line.split('\t');
      commits.push({ hash, subject: rest.join('\t'), author, date });
    }
    return commits;
  };

  /* ------------------------------- world.run ------------------------------------------------- */

  /**
   * Run a command in the workspace root. Resolves for any exit code; rejects only when the process
   * cannot be spawned or the timeout / output cap is hit.
   *
   * @param {string} cmd
   * @param {string[]} [args]
   * @param {{ timeoutMs?: number, output?: 'full'|'discard'|{ tail: number }, stdin?: string, env?: Record<string, string|undefined> }} [runOptions]
   * @returns {Promise<WorldRunResult>}
   */
  const runCommand = async (cmd, args = [], runOptions = {}) => {
    const command = typeof cmd === 'string' ? cmd.trim() : '';
    if (command === '') throw new Error('runCommand requires a command name');
    const argv = Array.isArray(args) ? args.map((value) => String(value)) : [];
    const timeoutMs = Number.isFinite(runOptions.timeoutMs) && runOptions.timeoutMs > 0
      ? Math.floor(runOptions.timeoutMs)
      : DEFAULT_COMMAND_TIMEOUT_MS;
    const output = runOptions.output ?? 'full';
    const mode = output === 'discard'
      ? 'discard'
      : output !== null && typeof output === 'object' && Number.isFinite(output.tail)
        ? { tail: Math.max(0, Math.floor(output.tail)) }
        : 'full';
    const env = runOptions.env === undefined ? process.env : { ...process.env, ...runOptions.env };

    const spec = {
      command,
      args: argv,
      cwd: root,
      timeoutMs,
      env,
      shell: false,
      ...(runOptions.stdin === undefined ? {} : { stdin: runOptions.stdin }),
    };
    return service === undefined
      ? spawnWithNode(command, argv, { timeoutMs, mode, env, stdin: runOptions.stdin })
      : spawnWithService(spec, { timeoutMs, mode });
  };

  /**
   * @param {string} command
   * @param {string[]} argv
   * @param {{ timeoutMs: number, mode: 'full'|'discard'|{tail:number}, env: NodeJS.ProcessEnv, stdin?: string }} spawnOptions
   * @returns {Promise<WorldRunResult>}
   */
  const spawnWithNode = (command, argv, spawnOptions) => new Promise((resolve, reject) => {
    const { timeoutMs, mode, env, stdin } = spawnOptions;
    /** @type {import('node:child_process').ChildProcessByStdio<any, any, any>} */
    let child;
    try {
      child = spawn(command, argv, {
        cwd: root,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error(`failed to spawn "${command}": ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    let settled = false;
    let timedOut = false;
    let outputBytes = 0;
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let stdoutTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);
    const tailLimit = mode !== null && typeof mode === 'object' ? Math.min(mode.tail, MAX_COMMAND_OUTPUT_BYTES) : 0;

    /** @param {string} reason @param {any} error */
    const fail = (reason, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      const failure = error instanceof Error ? error : new Error(reason);
      if (reason !== undefined && failure.message === '') failure.message = reason;
      reject(failure);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      fail(`command timed out after ${timeoutMs} ms: ${command}`, new Error(`command timed out after ${timeoutMs} ms: ${command}`));
    }, timeoutMs);
    timer.unref?.();

    /**
     * @param {Buffer} chunk
     * @param {'stdout'|'stderr'} stream
     */
    const collect = (chunk, stream) => {
      if (settled) return;
      if (mode === 'discard') return;
      outputBytes += chunk.length;
      if (mode === 'full' && outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        fail(`command output exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`, new Error(`command output exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`));
        return;
      }
      if (mode === 'full') {
        (stream === 'stdout' ? stdoutChunks : stderrChunks).push(chunk);
        return;
      }
      const merged = Buffer.concat([stream === 'stdout' ? stdoutTail : stderrTail, chunk]);
      const kept = merged.length > tailLimit ? merged.subarray(merged.length - tailLimit) : merged;
      if (stream === 'stdout') stdoutTail = Buffer.from(kept);
      else stderrTail = Buffer.from(kept);
    };

    child.stdout?.on('data', (chunk) => collect(Buffer.from(chunk), 'stdout'));
    child.stderr?.on('data', (chunk) => collect(Buffer.from(chunk), 'stderr'));
    child.on('error', (error) => {
      if (timedOut) return;
      const failure = new Error(`failed to spawn "${command}": ${error.message}`);
      // @ts-ignore - carry the errno code for callers that care
      failure.code = error.code;
      fail(failure.message, failure);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = typeof code === 'number' ? code : signal === 'SIGTERM' ? 143 : signal === 'SIGKILL' ? 137 : 1;
      if (mode === 'discard') {
        resolve({ exitCode, stdout: '', stderr: '' });
        return;
      }
      if (mode === 'full') {
        resolve({
          exitCode,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
        return;
      }
      resolve({ exitCode, stdout: stdoutTail.toString('utf8'), stderr: stderrTail.toString('utf8') });
    });

    if (child.stdin !== null) {
      child.stdin.on('error', () => {});
      if (typeof stdin === 'string') child.stdin.end(stdin);
      else child.stdin.end();
    }
  });

  /**
   * Run through the DSH subprocess service when one was supplied. The adapter accepts the common
   * shapes (a promise, or a handle with `result()` / `wait()`) and never falls back to node spawn:
   * a failed service call must not execute the command twice.
   *
   * @param {object} spec
   * @param {{ timeoutMs: number, mode: 'full'|'discard'|{tail:number} }} runOptions
   * @returns {Promise<WorldRunResult>}
   */
  const spawnWithService = async (spec, runOptions) => {
    if (service === undefined) throw new Error('no subprocess service is configured');
    /** @type {any} */
    let handle;
    try {
      handle = await service.spawn(spec);
    } catch (error) {
      const failure = new Error(`failed to spawn "${spec.command}": ${error instanceof Error ? error.message : String(error)}`);
      // @ts-ignore - carry the errno code for callers that care
      failure.code = error?.code;
      throw failure;
    }

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          handle?.kill?.();
        } catch {
          // ignore
        }
        reject(new Error(`command timed out after ${runOptions.timeoutMs} ms: ${spec.command}`));
      }, runOptions.timeoutMs);
      timer.unref?.();
    });

    const complete = (async () => {
      if (typeof handle?.result === 'function') return await handle.result();
      if (typeof handle?.wait === 'function') return await handle.wait();
      return handle;
    })();

    let result;
    try {
      result = await Promise.race([complete, timeout]);
    } finally {
      clearTimeout(timer);
    }

    const exitCode = result?.exitCode ?? result?.code ?? result?.status;
    if (typeof exitCode !== 'number') throw new Error('subprocess service returned no exit code');
    const stdout = typeof result?.stdout === 'string' ? result.stdout : String(result?.stdout ?? '');
    const stderr = typeof result?.stderr === 'string' ? result.stderr : String(result?.stderr ?? '');
    if (runOptions.mode === 'discard') return { exitCode, stdout: '', stderr: '' };
    if (runOptions.mode !== 'full' && typeof runOptions.mode === 'object') {
      const tail = runOptions.mode.tail;
      return {
        exitCode,
        stdout: tail <= 0 ? '' : Buffer.from(stdout).subarray(-tail).toString('utf8'),
        stderr: tail <= 0 ? '' : Buffer.from(stderr).subarray(-tail).toString('utf8'),
      };
    }
    return { exitCode, stdout, stderr };
  };

  return {
    root,
    relativeAllowed,
    files: { glob, read, readFileText: read, grep },
    git: {
      changedFiles,
      diff,
      status,
      log,
    },
    runCommand,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* helpers                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** @param {string} text */
function firstLine(text) {
  return String(text ?? '').split(/\r?\n/u).find((line) => line.trim() !== '') ?? '';
}

/** @param {string} character */
function escapeRegExp(character) {
  return /[.*+?^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
}

/**
 * Compile a glob pattern into a RegExp matching workspace-relative posix paths.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function compileGlob(pattern) {
  const source = String(pattern ?? '').replace(/\\/gu, '/');
  let output = '^';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '*') {
      if (source[index + 1] === '*') {
        index += 1;
        if (source[index + 1] === '/') {
          index += 1;
          output += '(?:.*/)?';
        } else {
          output += '.*';
        }
      } else {
        output += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      output += '[^/]';
      continue;
    }
    if (character === '{') {
      const end = source.indexOf('}', index);
      if (end < 0) {
        output += '\\{';
        continue;
      }
      const options = source.slice(index + 1, end).split(',');
      output += `(?:${options.map((option) => option.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`;
      index = end;
      continue;
    }
    output += escapeRegExp(character);
  }
  return new RegExp(`${output}$`, 'u');
}
