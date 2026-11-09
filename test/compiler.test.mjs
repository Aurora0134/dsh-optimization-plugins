import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FACADE_DTS,
  compileWorkflowScript,
  extractMetadataHeader,
  formatDiagnostic,
  serializeMetadataHeader,
} from '../host/compiler.js';

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {object} result compiler result
 * @param {number} code
 * @returns {object[]} diagnostics with this code
 */
function withCode(result, code) {
  return result.diagnostics.filter((diagnostic) => diagnostic.code === code);
}

/**
 * @param {object} result compiler result
 * @param {number} code
 * @returns {string} concatenated messages with this code
 */
function messagesFor(result, code) {
  return withCode(result, code).map((diagnostic) => diagnostic.message).join('\n');
}

/**
 * @param {object} result
 * @returns {string} all messages, for `assert.match` on text
 */
function allMessages(result) {
  return result.diagnostics.map((diagnostic) => `[${diagnostic.severity}/${diagnostic.code}] ${diagnostic.message}`).join('\n');
}

/**
 * Evaluate the compiled expression (`js` is `(async () => { … })()`) against stub facade globals.
 * @param {string} js
 * @param {Record<string, unknown>} [globals]
 * @returns {Promise<any>}
 */
async function evaluate(js, globals = {}) {
  const scope = {
    __zcodeSchema: (name) => ({ __zcodeSchema: name }),
    phase: () => {},
    report: () => {},
    log: () => {},
    artifact: {
      chart: () => {},
      table: () => {},
      metrics: () => {},
      board: () => {},
      file: async () => ({ id: 'f', version: 1 }),
      markdown: async () => ({ id: 'm', version: 1 }),
    },
    files: {
      glob: async () => [],
      read: async () => '',
      grep: async () => [],
    },
    git: {
      changedFiles: async () => [],
      diff: async () => '',
      status: async () => ({ clean: true, staged: [], unstaged: [], untracked: [] }),
      log: async () => [],
    },
    world: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    channel: () => ({ send() {}, close() {} }),
    future: (body) => body(),
    model: (id) => ({ id }),
    args: {},
    run: { id: 'run-test' },
    agent: () => ({ ask: async (_instructions) => ({ ok: true }) }),
    ...globals,
  };
  const names = Object.keys(scope);
  const fn = new Function(...names, `return ${js};`);
  return fn(...names.map((name) => scope[name]));
}

const CLEAN_SCRIPT = `interface Finding {
  /** One sentence: what breaks. */
  summary: string;
  severity: "low" | "high";
  file?: string;
  tags: string[];
}
interface Review {
  findings: Finding[];
  /** True when nothing blocks the merge. */
  clean: boolean;
  score: number;
}

artifact.chart("score", { x: { field: "round" }, y: { field: "score" } });
artifact.markdown("report", "# Report", { primary: true, title: "Review" });

const reviewer = agent("评审员");
phase("分析每个文件");
const paths = await files.glob("src/**/*.ts");
const reviews = await Promise.all(
  paths.map((path) => agent(\`reviewer-\${path}\`).ask<Review>(\`Review \${path}\`)),
);
phase("汇总");
const gate = await world.run("npm", ["test"]);
report({ round: 1, score: 9 }, "score");
log(\`exit \${gate.exitCode}\`);
return { reviews: reviews.length, pass: gate.exitCode === 0 };
`;

/* ------------------------------------------------------------------------------------------------
 * Clean compile, facts, and executable output
 * ---------------------------------------------------------------------------------------------- */

test('a clean script compiles, reports its facts, and executes', async () => {
  const result = compileWorkflowScript({ code: CLEAN_SCRIPT, filename: 'clean.ts' });

  assert.equal(result.ok, true, allMessages(result));
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.phases, ['分析每个文件', '汇总']);
  assert.deepEqual(result.agents, ['评审员']);
  assert.deepEqual(result.artifacts, [
    { id: 'score', kind: 'chart', primary: false },
    { id: 'report', kind: 'markdown', primary: true },
  ]);
  assert.deepEqual(result.worldCommands, ['npm']);

  // The result is one runnable expression, wrapper included.
  assert.ok(result.js.startsWith('(async ()=>'));
  assert.ok(result.js.trimEnd().endsWith('})();'));

  const value = await evaluate(result.js, {
    files: { glob: async () => ['a.ts', 'b.ts'], read: async () => '', grep: async () => [] },
    agent: (name) => ({ ask: async () => ({ findings: [], clean: true, score: 9, name }) }),
    world: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  });
  assert.deepEqual(value, { reviews: 2, pass: true });
});

test('a top-level return and top-level await are supported', async () => {
  const result = compileWorkflowScript({
    code: 'phase("setup");\nconst gate = await world.run("true", []);\nawait Promise.resolve();\nreturn 42 + gate.exitCode;\n',
    filename: 'ret.ts',
  });
  assert.equal(result.ok, true, allMessages(result));
  assert.equal(await evaluate(result.js), 42);
});

test('CRLF, a BOM, and non-ASCII identifiers are handled', async () => {
  const source = '\uFEFFinterface 结果 { 通过: boolean }\r\nphase("第一步");\r\nconst 执行者 = agent("助手");\r\nconst 答案 = await 执行者.ask<结果>("做点什么");\r\nreturn 答案.通过;\r\n';
  const result = compileWorkflowScript({ code: source, filename: 'crlf.ts' });
  assert.equal(result.ok, true, allMessages(result));
  assert.deepEqual(result.phases, ['第一步']);
  assert.deepEqual(result.agents, ['助手']);
  assert.ok(result.js.includes('__zcodeSchema("结果")'));
  const value = await evaluate(result.js, {
    agent: () => ({ ask: async () => ({ 通过: true }) }),
  });
  assert.equal(value, true);
});

test('an empty script is diagnosed, not transpiled', () => {
  const result = compileWorkflowScript({ code: '   \n\t\n', filename: 'empty.ts' });
  assert.equal(result.ok, false);
  assert.equal(result.js, null);
  assert.equal(withCode(result, 9012).length, 1);
  assert.match(messagesFor(result, 9012), /empty/u);
});

test('the facade declarations are exported verbatim for the tool description', () => {
  assert.match(FACADE_DTS, /declare function agent/u);
  assert.match(FACADE_DTS, /declare function phase/u);
  assert.match(FACADE_DTS, /declare const world/u);
});

/* ------------------------------------------------------------------------------------------------
 * 9010 — import / export / declare
 * ---------------------------------------------------------------------------------------------- */

test('9010: import statements are refused', () => {
  const result = compileWorkflowScript({
    code: 'import fs from "node:fs";\nphase("a");\nawait agent("x").ask("y");\nreturn 1;\n',
    filename: 'w.ts',
  });
  assert.equal(result.ok, false);
  assert.equal(result.js, null);
  const hit = withCode(result, 9010);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].line, 1);
  assert.match(hit[0].message, /import/u);
});

test('9010: export statements are refused', () => {
  const result = compileWorkflowScript({ code: 'export const x = 1;\n', filename: 'w.ts' });
  assert.equal(withCode(result, 9010).length, 1);
  assert.match(messagesFor(result, 9010), /export/u);
});

test('9010: the declare modifier is refused anywhere', () => {
  const result = compileWorkflowScript({
    code: 'declare const x: number;\ndeclare function f(): void;\nphase("a");\n',
    filename: 'w.ts',
  });
  const hits = withCode(result, 9010);
  assert.equal(hits.length, 2);
  assert.match(hits[0].message, /declare/u);
});

/* ------------------------------------------------------------------------------------------------
 * 9002 — forbidden APIs
 * ---------------------------------------------------------------------------------------------- */

test('9002: process, require, fetch and fs are refused', () => {
  const result = compileWorkflowScript({
    code: 'phase("a");\nconst p = process.pid;\nconst r = require("x");\nawait fetch("http://x");\nconst f = fs.readFileSync;\n',
    filename: 'w.ts',
  });
  const hits = withCode(result, 9002);
  assert.equal(hits.length, 4, allMessages(result));
  for (const diagnostic of hits) assert.match(diagnostic.message, /not available in a workflow script/u);
});

test('9002: Date.now, Math.random, eval, new Function and node: specifiers are refused', () => {
  const result = compileWorkflowScript({
    code: 'phase("a");\nconst a = Date.now();\nconst b = Math.random();\neval("1");\nconst c = new Function("return 1");\nconst d = "node:fs";\n',
    filename: 'w.ts',
  });
  const hits = withCode(result, 9002);
  assert.equal(hits.length, 5, allMessages(result));
  assert.match(messagesFor(result, 9002), /clock/u);
  assert.match(messagesFor(result, 9002), /random/u);
  assert.match(messagesFor(result, 9002), /eval\(\)/u);
  assert.match(messagesFor(result, 9002), /Function constructor/u);
  assert.match(messagesFor(result, 9002), /node:fs/u);
});

test('9002 does not fire inside comments, strings or template literals', () => {
  const code = [
    '// process.env and Date.now() in a comment are fine',
    '/* fetch("x") in a block comment is fine */',
    'phase("a");',
    'const text = "process is just a word here, eval( too";',
    'const template = `Math.random() and node:fs inside a template`;',
    'await agent("x").ask("y");',
    'return text + template;',
  ].join('\n');
  const result = compileWorkflowScript({ code, filename: 'w.ts' });
  assert.equal(result.ok, true, allMessages(result));
  assert.equal(withCode(result, 9002).length, 0);
});

test('9002: a locally declared name shadows the forbidden global', () => {
  const code = 'function process(value) { return value; }\nphase("a");\nawait agent("x").ask("y");\nreturn process(1);\n';
  const result = compileWorkflowScript({ code, filename: 'w.ts' });
  assert.equal(withCode(result, 9002).length, 0, allMessages(result));
});

/* ------------------------------------------------------------------------------------------------
 * 9003 — world.run command literals
 * ---------------------------------------------------------------------------------------------- */

test('9003: world.run needs a literal command and collects the command set', () => {
  const ok = compileWorkflowScript({
    code: 'phase("a");\nconst r = await world.run("git", ["status"]);\nreturn r.exitCode;\n',
    filename: 'w.ts',
  });
  assert.equal(ok.ok, true, allMessages(ok));
  assert.deepEqual(ok.worldCommands, ['git']);

  const bad = compileWorkflowScript({
    code: 'phase("a");\nconst cmd = "git";\nconst r = await world.run(cmd, ["status"]);\nreturn r.exitCode;\n',
    filename: 'w.ts',
  });
  assert.equal(bad.ok, false);
  const hit = withCode(bad, 9003)[0];
  assert.ok(hit !== undefined, allMessages(bad));
  assert.equal(hit.line, 3);
  assert.match(hit.message, /world\.run's first argument must be a compile-time string literal/u);
});

/* ------------------------------------------------------------------------------------------------
 * 9004 — phase markers and coverage
 * ---------------------------------------------------------------------------------------------- */

test('9004: phase needs a compile-time literal name', () => {
  const result = compileWorkflowScript({
    code: 'const name = "a";\nphase(name);\nawait agent("x").ask("y");\nreturn 1;\n',
    filename: 'w.ts',
  });
  const hit = withCode(result, 9004).find((diagnostic) => /phase\(\)'s argument must be a compile-time string literal/u.test(diagnostic.message));
  assert.ok(hit !== undefined, allMessages(result));
  assert.equal(hit.line, 2);
});

test('9004: an empty phase name is refused', () => {
  const result = compileWorkflowScript({ code: 'phase("  ");\nawait agent("x").ask("y");\nreturn 1;\n', filename: 'w.ts' });
  assert.match(messagesFor(result, 9004), /has no name to show/u);
});

test('9004: a phase marker in expression position is refused', () => {
  const result = compileWorkflowScript({
    code: 'const started = phase("a");\nawait agent("x").ask("y");\nreturn started;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(result, 9004), /must stand alone as its own statement/u);
});

test('9004: a script needs at least one phase', () => {
  const result = compileWorkflowScript({ code: 'await agent("x").ask("y");\nreturn 1;\n', filename: 'w.ts' });
  assert.match(messagesFor(result, 9004), /needs at least one phase/u);
});

test('9004: a phase with no ask or world.run warns but still compiles', () => {
  const result = compileWorkflowScript({
    code: 'phase("work");\nawait agent("x").ask("y");\nif (true) {\n  phase("collect");\n  const x = 1 + 1;\n  return x;\n}\nreturn 0;\n',
    filename: 'w.ts',
  });
  const hit = withCode(result, 9004).find((diagnostic) => /has no ask\(\.\.\.\) or world\.run/u.test(diagnostic.message));
  assert.ok(hit !== undefined, allMessages(result));
  assert.equal(hit.severity, 'warning');
  assert.equal(hit.line, 4);
  assert.equal(result.ok, true);
});

test('9004: a trailing phase that only shapes the return value does not block', () => {
  const code = [
    'interface Verdict { path: string; approved: boolean; reason?: string }',
    'phase("Find the files to audit");',
    'const paths = await files.glob("src/**/*.ts");',
    'phase("Security-audit each file independently");',
    'const verdicts = await Promise.all(',
    '  paths.map((p) => agent(`auditor-${p}`).ask<Verdict>(`Security-review ${p}.`)),',
    ');',
    'phase("Report the files that failed");',
    'return verdicts.filter((v) => !v.approved).map((v) => ({ path: v.path, reason: v.reason }));',
  ].join('\n');
  const result = compileWorkflowScript({ code, filename: 'doc-pattern.ts' });
  assert.equal(result.ok, true, allMessages(result));
  assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), []);
});

test('the SKILL §8 example compiles (regex literal, template strings, loop phases)', () => {
  const code = [
    'interface Attempt {',
    '  /** One sentence: the optimization this round is trying. */',
    '  approach: string;',
    '}',
    '',
    '/** Total nanoseconds the bench reports, or Infinity when it printed none. */',
    'function benchNanos(output: string): number {',
    '  const match = /time:\\s*([\\d.]+) ns/.exec(output);',
    '  return match?.[1] === undefined ? Number.POSITIVE_INFINITY : Number(match[1]);',
    '}',
    '',
    'phase("Measure today\'s baseline");',
    'const baseline = await world.run("cargo", ["bench"], { timeoutMs: 1_800_000 });',
    'const target = benchNanos(baseline.stdout);',
    'const optimizer = agent("optimizer");',
    '',
    'let winner = "none";',
    'for (let round = 1; round <= 3; round++) {',
    '  phase("Make one improvement");',
    '  const plan = await optimizer.ask<Attempt>(`Round ${round}. Make one improvement.`);',
    '',
    '  phase("Check that the tests still pass");',
    '  const check = await world.run("cargo", ["test"]);',
    '  if (check.exitCode !== 0) continue;',
    '',
    '  phase("Measure whether it is actually faster");',
    '  const bench = await world.run("cargo", ["bench"], { timeoutMs: 1_800_000 });',
    '  if (bench.exitCode === 0 && benchNanos(bench.stdout) < target) {',
    '    winner = plan.approach;',
    '    break;',
    '  }',
    '}',
    '',
    'phase("Collect the final numbers");',
    'const head = await world.run("git", ["rev-parse", "HEAD"]);',
    'return { approach: winner, commit: head.stdout.trim() };',
  ].join('\n');
  const result = compileWorkflowScript({ code, filename: 'skill-8.ts' });
  assert.equal(result.ok, true, allMessages(result));
  assert.deepEqual(result.phases, [
    "Measure today's baseline",
    'Make one improvement',
    'Check that the tests still pass',
    'Measure whether it is actually faster',
    'Collect the final numbers',
  ]);
  assert.deepEqual(result.worldCommands, ['cargo', 'git']);
});

test('9004: a phase covered through an inlined helper is accepted', () => {
  const result = compileWorkflowScript({
    code: [
      'async function gather() {',
      '  return agent("helper").ask("y");',
      '}',
      'phase("gather facts");',
      'const facts = await gather();',
      'return facts;',
    ].join('\n'),
    filename: 'w.ts',
  });
  assert.equal(result.ok, true, allMessages(result));
});

/* ------------------------------------------------------------------------------------------------
 * 9005 / 9006 — agent names
 * ---------------------------------------------------------------------------------------------- */

test('9005: literal duplicate agent names are refused with the first line', () => {
  const result = compileWorkflowScript({
    code: 'phase("a");\nconst one = agent("reviewer");\nconst two = agent("reviewer");\nawait one.ask("x");\nreturn 1;\n',
    filename: 'w.ts',
  });
  const hit = withCode(result, 9005)[0];
  assert.ok(hit !== undefined, allMessages(result));
  assert.equal(hit.line, 3);
  assert.match(hit.message, /two actors are named "reviewer" \(the first is on line 2\)/u);
});

test('9005: computed and empty agent names are allowed', () => {
  const result = compileWorkflowScript({
    code: 'phase("a");\nconst paths = ["a", "b"];\nconst all = paths.map((path) => agent(`r-${path}`).ask("x"));\nagent("");\nawait Promise.all(all);\nreturn 1;\n',
    filename: 'w.ts',
  });
  assert.equal(result.ok, true, allMessages(result));
});

test('9006: a fixed agent name inside a fan-out callback is refused', () => {
  const result = compileWorkflowScript({
    code: 'phase("a");\nconst paths = ["a", "b"];\nconst all = paths.map((path) => agent("reviewer").ask("x"));\nawait Promise.all(all);\nreturn 1;\n',
    filename: 'w.ts',
  });
  const hit = withCode(result, 9006)[0];
  assert.ok(hit !== undefined, allMessages(result));
  assert.match(hit.message, /runs once per element of a fan-out but its name "reviewer" is a fixed string/u);
});

/* ------------------------------------------------------------------------------------------------
 * 9007 / 9008 / 9009 — artifacts and report tags
 * ---------------------------------------------------------------------------------------------- */

test('9007: artifact ids must be literals, non-empty, short and character-restricted', () => {
  const nonLiteral = compileWorkflowScript({
    code: 'phase("a");\nconst id = "x";\nartifact.markdown(id, "text");\nawait agent("x").ask("y");\nreturn 1;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(nonLiteral, 9007), /artifact id must be a compile-time string literal/u);

  const empty = compileWorkflowScript({ code: 'phase("a");\nartifact.markdown("", "text");\nawait agent("x").ask("y");\nreturn 1;\n', filename: 'w.ts' });
  assert.match(messagesFor(empty, 9007), /must not be empty/u);

  const badCharacters = compileWorkflowScript({ code: 'phase("a");\nartifact.markdown("a/b", "text");\nawait agent("x").ask("y");\nreturn 1;\n', filename: 'w.ts' });
  assert.match(messagesFor(badCharacters, 9007), /characters outside \[A-Za-z0-9_.-\]/u);

  const tooLong = compileWorkflowScript({ code: `phase("a");\nartifact.markdown("${'x'.repeat(65)}", "text");\nawait agent("x").ask("y");\nreturn 1;\n`, filename: 'w.ts' });
  assert.match(messagesFor(tooLong, 9007), /is 65 characters; the limit is 64/u);
});

test('9007: one id belongs to one kind and a run has one primary artifact', () => {
  const twoKinds = compileWorkflowScript({
    code: 'phase("a");\nartifact.chart("x", { x: { field: "a" }, y: { field: "b" } });\nartifact.markdown("x", "# x");\nawait agent("a").ask("y");\nreturn 1;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(twoKinds, 9007), /is used with two different kinds/u);

  const twoPrimaries = compileWorkflowScript({
    code: 'phase("a");\nartifact.markdown("one", "# 1", { primary: true });\nartifact.markdown("two", "# 2", { primary: true });\nawait agent("a").ask("y");\nreturn 1;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(twoPrimaries, 9007), /is marked primary, but "one" already is/u);
});

test('9007: an unknown artifact kind is named', () => {
  const result = compileWorkflowScript({ code: 'phase("a");\nartifact.spreadsheet("x", {});\nawait agent("a").ask("y");\nreturn 1;\n', filename: 'w.ts' });
  assert.match(messagesFor(result, 9007), /artifact has no member "spreadsheet"/u);
});

test('9008: preset artifacts must be declared at the top level', () => {
  const inLoop = compileWorkflowScript({
    code: 'phase("a");\nfor (let i = 0; i < 2; i += 1) {\n  artifact.chart("inside", { x: { field: "a" }, y: { field: "b" } });\n}\nawait agent("a").ask("y");\nreturn 1;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(inLoop, 9008), /inside a loop/u);

  const inBranch = compileWorkflowScript({
    code: 'phase("a");\nif (true) {\n  artifact.chart("inside", { x: { field: "a" }, y: { field: "b" } });\n}\nawait agent("a").ask("y");\nreturn 1;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(inBranch, 9008), /inside a conditional branch/u);

  const inCallback = compileWorkflowScript({
    code: 'phase("a");\n[1].map(() => {\n  artifact.chart("inside", { x: { field: "a" }, y: { field: "b" } });\n  return 1;\n});\nawait agent("a").ask("y");\nreturn 1;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(inCallback, 9008), /inside a callback/u);
});

test('9009: report tags need literals and preset artifacts; unknown tags are warnings', () => {
  const nonLiteral = compileWorkflowScript({
    code: 'phase("a");\nconst tag = "score";\nreport({ a: 1 }, tag);\nawait agent("a").ask("y");\nreturn 1;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(nonLiteral, 9009), /report\(\)'s artifact tag must be a compile-time string literal/u);

  const contentTag = compileWorkflowScript({
    code: 'phase("a");\nartifact.markdown("doc", "# d");\nreport({ a: 1 }, "doc");\nawait agent("a").ask("y");\nreturn 1;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(contentTag, 9009), /names a file\/markdown artifact/u);

  const unknown = compileWorkflowScript({
    code: 'phase("a");\nreport({ a: 1 }, "score");\nawait agent("a").ask("y");\nreturn 1;\n',
    filename: 'w.ts',
  });
  assert.equal(unknown.ok, true, allMessages(unknown));
  const hit = withCode(unknown, 9009)[0];
  assert.equal(hit.severity, 'warning');
  assert.match(hit.message, /declares no preset artifacts at all/u);
});

/* ------------------------------------------------------------------------------------------------
 * 9012 — holes
 * ---------------------------------------------------------------------------------------------- */

test('9012: hole() needs an explicit type argument', () => {
  const result = compileWorkflowScript({
    code: 'phase("a");\nconst plan = await hole("choose plan");\nreturn plan;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(result, 9012), /needs an explicit type argument/u);
});

test('9012: hole() names are literals, non-empty, short and unique', () => {
  const nonLiteral = compileWorkflowScript({
    code: 'phase("a");\nconst name = "plan";\nconst plan = await hole<string>(name);\nreturn plan;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(nonLiteral, 9012), /name must be a compile-time string literal/u);

  const empty = compileWorkflowScript({ code: 'phase("a");\nconst plan = await hole<string>("");\nreturn plan;\n', filename: 'w.ts' });
  assert.match(messagesFor(empty, 9012), /has no name to show/u);

  const long = compileWorkflowScript({ code: `phase("a");\nconst plan = await hole<string>("${'x'.repeat(129)}");\nreturn plan;\n`, filename: 'w.ts' });
  assert.match(messagesFor(long, 9012), /longer than 128 characters/u);

  const duplicate = compileWorkflowScript({
    code: 'phase("a");\nconst one = await hole<string>("plan");\nconst two = await hole<string>("plan");\nreturn [one, two];\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(duplicate, 9012), /two holes are named "plan"/u);

  const collidesWithPhase = compileWorkflowScript({
    code: 'phase("plan");\nconst one = await hole<string>("plan");\nreturn one;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(collidesWithPhase, 9012), /shares its name with a phase\("plan"\) marker/u);
});

test('9012: hole() must be awaited, outside fan-out callbacks, with an inline body', () => {
  const notAwaited = compileWorkflowScript({
    code: 'phase("a");\nconst pending = hole<string>("plan");\nreturn pending;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(notAwaited, 9012), /must be awaited where it is called/u);

  const inFanOut = compileWorkflowScript({
    code: 'phase("a");\nconst items = [1, 2];\nconst all = items.map(async (item) => hole<string>("plan"));\nawait Promise.all(all);\nreturn 1;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(inFanOut, 9012), /cannot stand inside a fan-out callback/u);

  const heldBody = compileWorkflowScript({
    code: 'phase("a");\nconst body = async () => "x";\nconst plan = await hole<string>("plan", body);\nreturn plan;\n',
    filename: 'w.ts',
  });
  assert.match(messagesFor(heldBody, 9012), /body must be an inline async arrow/u);
});

/* ------------------------------------------------------------------------------------------------
 * 9011 — model() literals and unusable schemas
 * ---------------------------------------------------------------------------------------------- */

test('9011: model() needs a non-empty string literal', () => {
  const result = compileWorkflowScript({
    code: 'phase("a");\nconst ref = model("anthropic/claude");\nconst other = model(String(args.model));\nawait agent("x", { model: ref }).ask("y");\nreturn 1;\n',
    filename: 'w.ts',
  });
  const hits = withCode(result, 9011);
  assert.equal(hits.length, 1, allMessages(result));
  assert.match(hits[0].message, /model\(\) takes the model name as a non-empty string literal/u);
});

test('9011: a type used by ask<T> that cannot become a schema is named', () => {
  const result = compileWorkflowScript({
    code: [
      'interface Bag {',
      '  entries(): string[];',
      '}',
      'phase("a");',
      'const answer = await agent("x").ask<Bag>("y");',
      'return answer;',
    ].join('\n'),
    filename: 'w.ts',
  });
  assert.equal(result.ok, false);
  const hit = withCode(result, 9011)[0];
  assert.ok(hit !== undefined, allMessages(result));
  assert.match(hit.message, /cannot be turned into a JSON schema/u);
});

test('an unused type that cannot become a schema only warns', () => {
  const result = compileWorkflowScript({
    code: [
      'interface Helper<T> { value: T }',
      'phase("a");',
      'await agent("x").ask("y");',
      'return 1;',
    ].join('\n'),
    filename: 'w.ts',
  });
  assert.equal(result.ok, true, allMessages(result));
  const warning = result.diagnostics.find((diagnostic) => diagnostic.severity === 'warning' && diagnostic.code === 9011);
  assert.ok(warning !== undefined, allMessages(result));
  assert.match(warning.message, /Helper/u);
});

/* ------------------------------------------------------------------------------------------------
 * interface -> JSON schema
 * ---------------------------------------------------------------------------------------------- */

test('interfaces map to schemas: primitives, optionality, arrays and JSDoc', () => {
  const result = compileWorkflowScript({
    code: [
      'interface Attempt {',
      '  /** One sentence: the optimization this round is trying. */',
      '  approach: string;',
      '  nanos: number;',
      '  faster: boolean;',
      '  note?: string;',
      '  files: string[];',
      '  nested: { depth: number };',
      '}',
      'phase("a");',
      'const attempt = await agent("optimizer").ask<Attempt>("try");',
      'return attempt;',
    ].join('\n'),
    filename: 'w.ts',
  });
  assert.equal(result.ok, true, allMessages(result));
  const schema = result.interfaces.Attempt;
  assert.deepEqual(schema.required, ['approach', 'faster', 'files', 'nanos', 'nested']);
  assert.deepEqual(schema.properties.approach, { type: 'string', description: 'One sentence: the optimization this round is trying.' });
  assert.deepEqual(schema.properties.note, { type: 'string' });
  assert.deepEqual(schema.properties.files, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(schema.properties.nested, {
    type: 'object',
    properties: { depth: { type: 'number' } },
    required: ['depth'],
    additionalProperties: false,
  });
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
});

test('interfaces map literal unions, nested interfaces and type aliases', () => {
  const result = compileWorkflowScript({
    code: [
      '/** The verdict of one review. */',
      'interface Verdict {',
      '  status: "pass" | "fail" | "skip";',
      '  count: 1 | 2;',
      '  details: Detail[];',
      '}',
      'interface Detail {',
      '  message: string;',
      '}',
      'type Report = {',
      '  verdict: Verdict;',
      '  totals: Record<string, number>;',
      '}',
      'phase("a");',
      'const report = await agent("x").ask<Report>("y");',
      'return report;',
    ].join('\n'),
    filename: 'w.ts',
  });
  assert.equal(result.ok, true, allMessages(result));
  const verdict = result.interfaces.Verdict;
  assert.deepEqual(verdict.properties.status, { enum: ['pass', 'fail', 'skip'] });
  assert.deepEqual(verdict.properties.count, { enum: [1, 2] });
  assert.match(verdict.description, /The verdict of one review/u);
  assert.deepEqual(verdict.properties.details, {
    type: 'array',
    items: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
  });
  const report = result.interfaces.Report;
  assert.deepEqual(report.properties.totals, { type: 'object', additionalProperties: { type: 'number' } });
  assert.equal(report.properties.verdict.type, 'object');
});

test('an interface extending another merges its properties', () => {
  const result = compileWorkflowScript({
    code: [
      'interface Base { id: string }',
      'interface Item extends Base { label?: string }',
      'phase("a");',
      'await agent("x").ask<Item>("y");',
      'return 1;',
    ].join('\n'),
    filename: 'w.ts',
  });
  assert.equal(result.ok, true, allMessages(result));
  const schema = result.interfaces.Item;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['id', 'label']);
  assert.deepEqual(schema.required, ['id']);
});

/* ------------------------------------------------------------------------------------------------
 * ask<T> -> __zcodeSchema(...) rewrite
 * ---------------------------------------------------------------------------------------------- */

test('ask<T> is rewritten to a schema marker and typed by the interface map', () => {
  const result = compileWorkflowScript({
    code: [
      'interface Round { summary: string; score: number }',
      'phase("measure");',
      'const writer = agent("writer");',
      'const round = await writer.ask<Round>("do it");',
      'return round;',
    ].join('\n'),
    filename: 'w.ts',
  });
  assert.equal(result.ok, true, allMessages(result));
  assert.match(result.js, /\.ask\(__zcodeSchema\("Round"\), "do it"\)/u);
  assert.equal(result.interfaces.Round.type, 'object');
});

test('ask<T[]> and ask<Array<T>> become array markers under both keys', () => {
  for (const typeArgument of ['Round[]', 'Array<Round>']) {
    const result = compileWorkflowScript({
      code: [
        'interface Round { summary: string }',
        'phase("measure");',
        `const rounds = await agent("writer").ask<${typeArgument}>("do it");`,
        'return rounds;',
      ].join('\n'),
      filename: 'w.ts',
    });
    assert.equal(result.ok, true, allMessages(result));
    assert.match(result.js, /\.ask\(__zcodeSchema\("Round\[\]"\), "do it"\)/u);
    assert.deepEqual(result.interfaces['Round[]'], {
      type: 'array',
      items: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false,
      },
    });
    assert.equal(result.interfaces.Round.type, 'object');
  }
});

test('ask<T> inside a template literal is not rewritten', () => {
  const code = [
    'interface Round { summary: string }',
    'phase("a");',
    'const text = "call .ask<Round>(...) here";',
    'const template = `also .ask<Round>("x") inside a template`;',
    'await agent("x").ask("y");',
    'return text + template;',
  ].join('\n');
  const result = compileWorkflowScript({ code, filename: 'w.ts' });
  assert.equal(result.ok, true, allMessages(result));
  assert.equal(result.js.includes('__zcodeSchema'), false, result.js);
});

test('ask<T> without a declaration is diagnosed and left alone', () => {
  const result = compileWorkflowScript({
    code: 'phase("a");\nconst answer = await agent("x").ask<Missing>("y");\nreturn answer;\n',
    filename: 'w.ts',
  });
  assert.equal(result.ok, false);
  const hit = withCode(result, 9011)[0];
  assert.ok(hit !== undefined, allMessages(result));
  assert.match(hit.message, /ask<Missing> needs an interface declared in this script/u);
  assert.match(hit.message, /"Missing" is not declared here/u);
});

test('ask<T> accepts a builtin scalar type', () => {
  const result = compileWorkflowScript({
    code: 'phase("a");\nconst answer = await agent("x").ask<number>("y");\nreturn answer;\n',
    filename: 'w.ts',
  });
  assert.equal(result.ok, true, allMessages(result));
  assert.deepEqual(result.interfaces.number, { type: 'number' });
  assert.match(result.js, /__zcodeSchema\("number"\)/u);
});

test('a schemaless ask is left untouched', () => {
  const result = compileWorkflowScript({
    code: 'phase("a");\nconst answer = await agent("x").ask("y");\nreturn answer;\n',
    filename: 'w.ts',
  });
  assert.equal(result.ok, true, allMessages(result));
  assert.equal(result.js.includes('__zcodeSchema'), false);
});

/* ------------------------------------------------------------------------------------------------
 * 9001 — facade misuse
 * ---------------------------------------------------------------------------------------------- */

test('9001: taking a reference to a facade callable is refused', () => {
  const result = compileWorkflowScript({
    code: 'phase("a");\nconst p = phase;\nawait agent("x").ask("y");\nreturn p;\n',
    filename: 'w.ts',
  });
  const hit = withCode(result, 9001)[0];
  assert.ok(hit !== undefined, allMessages(result));
  assert.match(hit.message, /may only be called directly/u);
});

/* ------------------------------------------------------------------------------------------------
 * Snippet mode
 * ---------------------------------------------------------------------------------------------- */

test('snippet mode: orchestration facade calls are refused, plain logic compiles', async () => {
  const absent = compileWorkflowScript({
    code: 'const a = agent("x");\nreturn a;\n',
    filename: 'snippet.ts',
    mode: 'snippet',
  });
  assert.equal(absent.ok, false);
  assert.match(messagesFor(absent, 9002), /agent\(\) does not exist in a snippet/u);

  const clean = compileWorkflowScript({
    code: 'const status = await git.status();\nconst out = await world.run("node", ["-e", "1"]);\nreturn { clean: status.clean, code: out.exitCode };\n',
    filename: 'snippet.ts',
    mode: 'snippet',
  });
  assert.equal(clean.ok, true, allMessages(clean));
  assert.deepEqual(clean.worldCommands, []);
  const value = await evaluate(clean.js, {
    git: { status: async () => ({ clean: true, staged: [], unstaged: [], untracked: [] }) },
    world: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  });
  assert.deepEqual(value, { clean: true, code: 0 });
});

test('snippet mode still allows a top-level return', async () => {
  const result = compileWorkflowScript({ code: 'return 7;\n', filename: 's.ts', mode: 'snippet' });
  assert.equal(result.ok, true, allMessages(result));
  assert.equal(await evaluate(result.js), 7);
});

/* ------------------------------------------------------------------------------------------------
 * Syntax errors: line numbers in the submitted script
 * ---------------------------------------------------------------------------------------------- */

test('a syntax error points at the submitted line, not the wrapper', () => {
  const result = compileWorkflowScript({
    code: 'phase("a");\nawait agent("x").ask("y");\nconst value = ;\nreturn 1;\n',
    filename: 'broken.ts',
  });
  assert.equal(result.ok, false);
  assert.equal(result.js, null);
  const hit = withCode(result, 9012)[0];
  assert.ok(hit !== undefined, allMessages(result));
  assert.equal(hit.line, 3);
  assert.equal(hit.column, 15);
  assert.equal(formatDiagnostic(hit), `broken.ts:L3:C15 ${hit.message}`);
  assert.match(hit.message, /does not parse/u);
});

test('a syntax error on the first line points at line 1', () => {
  const result = compileWorkflowScript({ code: 'const = 1;\n', filename: 'broken.ts' });
  const hit = withCode(result, 9012)[0];
  assert.equal(hit.line, 1);
});

test('a syntax error after an ask rewrite still points at the right line', () => {
  const code = [
    'interface Round { summary: string }',
    'phase("a");',
    'const round = await agent("x").ask<Round>("y");',
    'const broken = ;',
    'return round;',
  ].join('\n');
  const result = compileWorkflowScript({ code, filename: 'broken.ts' });
  const hit = withCode(result, 9012)[0];
  assert.ok(hit !== undefined, allMessages(result));
  assert.equal(hit.line, 4);
});

test('unterminated tokens are reported where they start', () => {
  const result = compileWorkflowScript({ code: 'phase("a");\nconst text = "unterminated;\n', filename: 'broken.ts' });
  const hit = withCode(result, 9012)[0];
  assert.equal(hit.line, 2);
  assert.match(hit.message, /unterminated string/u);
});

/* ------------------------------------------------------------------------------------------------
 * Metadata header
 * ---------------------------------------------------------------------------------------------- */

test('metadata header round-trips through serialize and extract', () => {
  const meta = {
    name: 'pr-review',
    description: 'Review the pull request: correctness, tests, risk.',
    whenToUse: 'When a PR needs an expert review.',
    args: {
      pr: { type: 'string', description: 'The pull request number', required: true, default: '123' },
      depth: { type: 'number', required: false },
      strict: { type: 'boolean', default: true },
      extra: { type: 'json', default: { a: [1, 2] } },
    },
  };
  const body = `${CLEAN_SCRIPT}\n`;
  const file = serializeMetadataHeader(meta, body);

  assert.ok(file.startsWith('/* zcode-workflow\n'));
  assert.match(file, /\n\*\/\n/u);

  const parsed = extractMetadataHeader(file);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.deepEqual(parsed.meta, meta);
  assert.equal(parsed.body, body);
  assert.equal(parsed.bodyLineOffset, file.split('\n').indexOf('*/') + 1);

  // The body offset maps a body line back to the file line.
  const bodyLine = 3;
  const fileLine = bodyLine + parsed.bodyLineOffset;
  assert.equal(file.split('\n')[fileLine - 1], body.split('\n')[bodyLine - 1]);
});

test('metadata: block scalars, quotes and leading blank lines are parsed', () => {
  const file = [
    '',
    '/* zcode-workflow',
    'description: |-',
    '  First line.',
    '  Second line: with a colon.',
    'whenToUse: "When the user asks: review this"',
    'args:',
    '  target:',
    '    type: string',
    '    default: "src/index.ts"',
    '*/',
    'return 1;',
  ].join('\n');
  const parsed = extractMetadataHeader(file);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.meta.description, 'First line.\nSecond line: with a colon.');
  assert.equal(parsed.meta.whenToUse, 'When the user asks: review this');
  assert.deepEqual(parsed.meta.args.target, { type: 'string', default: 'src/index.ts' });
  assert.equal(parsed.body, 'return 1;');
});

test('metadata: a list of argument declarations is accepted', () => {
  const file = [
    '/* zcode-workflow',
    'description: List form',
    'args:',
    '  - name: pr',
    '    type: number',
    '    description: The pull request',
    '    required: true',
    '  - name: mode',
    '    type: string',
    '    default: fast',
    '*/',
    'return 1;',
  ].join('\n');
  const parsed = extractMetadataHeader(file);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.deepEqual(parsed.meta.args, {
    pr: { type: 'number', description: 'The pull request', required: true },
    mode: { type: 'string', default: 'fast' },
  });
});

test('metadata: malformed blocks return reasons instead of throwing', () => {
  const missing = extractMetadataHeader('return 1;\n', { path: 'a.dwf.ts' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing_frontmatter');
  assert.match(missing.detail, /does not start with the `\/\* zcode-workflow` metadata block/u);
  assert.equal(missing.diagnostics[0].path, 'a.dwf.ts');

  const unterminated = extractMetadataHeader('/* zcode-workflow\ndescription: x\n', { path: 'b.dwf.ts' });
  assert.equal(unterminated.ok, false);
  assert.equal(unterminated.reason, 'unterminated_frontmatter');
  assert.match(unterminated.detail, /never closed with `\*\/`/u);

  const badYaml = extractMetadataHeader('/* zcode-workflow\ndescription x\n*/\nreturn 1;\n', { path: 'c.dwf.ts' });
  assert.equal(badYaml.ok, false);
  assert.equal(badYaml.reason, 'invalid_yaml');

  const missingDescription = extractMetadataHeader('/* zcode-workflow\nwhenToUse: x\n*/\nreturn 1;\n', { path: 'd.dwf.ts' });
  assert.equal(missingDescription.ok, false);
  assert.equal(missingDescription.reason, 'invalid_metadata');
  assert.match(missingDescription.detail, /description: Required/u);

  const badArgType = extractMetadataHeader('/* zcode-workflow\ndescription: x\nargs:\n  pr:\n    type: integer\n*/\nreturn 1;\n', { path: 'e.dwf.ts' });
  assert.equal(badArgType.ok, false);
  assert.equal(badArgType.reason, 'invalid_metadata');
  assert.match(badArgType.detail, /args\.pr\.type/u);
});

test('metadata: extract never throws on odd input', () => {
  for (const input of ['', null, undefined, 42, '\uFEFF', '/* zcode-workflow\n*/']) {
    assert.doesNotThrow(() => extractMetadataHeader(input));
  }
});

/* ------------------------------------------------------------------------------------------------
 * Diagnostic shape and helper exports
 * ---------------------------------------------------------------------------------------------- */

test('every diagnostic carries path, line, column, code and severity', () => {
  const result = compileWorkflowScript({
    code: 'import x from "y";\nphase(name);\nconst a = process.pid;\n',
    filename: 'shape.ts',
  });
  assert.ok(result.diagnostics.length >= 3, allMessages(result));
  for (const diagnostic of result.diagnostics) {
    assert.equal(diagnostic.path, 'shape.ts');
    assert.ok(Number.isInteger(diagnostic.line) && diagnostic.line >= 1);
    assert.ok(Number.isInteger(diagnostic.column) && diagnostic.column >= 1);
    assert.ok(diagnostic.code >= 9000 && diagnostic.code < 9100);
    assert.equal(typeof diagnostic.message, 'string');
    assert.ok(diagnostic.severity === 'error' || diagnostic.severity === 'warning');
  }
  const lines = result.diagnostics.map((diagnostic) => diagnostic.line);
  assert.deepEqual(lines, [...lines].sort((left, right) => left - right));
});

test('an unknown mode is refused without throwing', () => {
  const result = compileWorkflowScript({ code: 'return 1;', filename: 'w.ts', mode: 'script' });
  assert.equal(result.ok, false);
  assert.equal(result.js, null);
  assert.match(result.diagnostics[0].message, /unknown compiler mode/u);
});

test('compileWorkflowScript defaults its filename and tolerates missing options', () => {
  const result = compileWorkflowScript({ code: 'phase("a");\nawait agent("x").ask("y");\nreturn 1;\n' });
  assert.equal(result.ok, true, allMessages(result));
  assert.equal(result.diagnostics.length, 0);
  assert.equal(compileWorkflowScript().ok, false);
});

/* ------------------------------------------------------------------------------------------------
 * Regression cases found by exercising the installed plugin
 * ---------------------------------------------------------------------------------------------- */

test('a typed facade call is a direct call, not a stored reference', () => {
  const result = compileWorkflowScript({
    code: [
      'interface Plan { steps: string[] }',
      'phase("choose");',
      'const facts = channel<string>("facts");',
      'const plan = await hole<Plan>("decide next", "How should we continue?");',
      'facts.close();',
      'return plan;',
    ].join('\n'),
    filename: 'typed-calls.ts',
  });
  assert.equal(result.ok, true, allMessages(result));
  assert.equal(withCode(result, 9001).length, 0);
});

test('a phase whose only step is a hole(...) is a step', () => {
  const code = [
    'interface Plan { steps: string[] }',
    'phase("盘点工作区");',
    'const markdown = await files.glob("*.md");',
    'phase("等待决定");',
    'const plan = await hole<Plan>("决定下一步", "How should we continue?");',
    'phase("执行");',
    'const out = await world.run("git", ["status"]);',
    'return { plan, markdown, out };',
  ].join('\n');
  const result = compileWorkflowScript({ code, filename: 'tail-hole.ts' });
  assert.equal(result.ok, true, allMessages(result));
  assert.equal(withCode(result, 9004).length, 0, allMessages(result));
  assert.deepEqual(result.phases, ['盘点工作区', '等待决定', '执行']);
});

test('report(item, undefined) and report(item, null) mean "no tag"', () => {
  for (const tag of ['undefined', 'null', 'void 0']) {
    const result = compileWorkflowScript({
      code: `phase("work");\nreport({ a: 1 }, ${tag});\nawait agent("x").ask("y");\nreturn 1;\n`,
      filename: 'report-no-tag.ts',
    });
    assert.equal(result.ok, true, `${tag}: ${allMessages(result)}`);
    assert.equal(withCode(result, 9009).length, 0, `${tag}: ${allMessages(result)}`);
  }
});

test('a real tail-hole run compiles end to end', () => {
  const code = [
    'interface Plan { steps: string[] }',
    '',
    'phase("盘点工作区");',
    'const markdown = await files.glob("*.md");',
    '',
    'phase("等待决定");',
    'const plan = await hole<Plan>("决定下一步", `Found ${markdown.length} files. How should we continue?`);',
    '',
    'phase("执行");',
    'report({ step: 1 }, "steps");',
    'report({ step: plan.steps.length });',
    'artifact.table("steps", { columns: [{ field: "step" }] });',
    'const out = await world.run("git", ["status"]);',
    'return { plan, markdown, out };',
  ].join('\n');
  const result = compileWorkflowScript({ code, filename: 'tail-hole-full.ts' });
  assert.equal(result.ok, true, allMessages(result));
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.js, /await hole\("决定下一步", /u);
  assert.deepEqual(result.interfaces.Plan.properties.steps, { type: 'array', items: { type: 'string' } });
});

test('model() accepts a string constant declared with as const', () => {
  const result = compileWorkflowScript({
    code: [
      'const MODEL = "anthropic/claude" as const;',
      'const ref = model(MODEL);',
      'phase("work");',
      'await agent("x", { model: ref }).ask("y");',
      'return 1;',
    ].join('\n'),
    filename: 'model-const.ts',
  });
  assert.equal(result.ok, true, allMessages(result));
  assert.equal(withCode(result, 9011).length, 0);
});
