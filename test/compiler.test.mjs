/**
 * 编译器单测：facade 声明、lowering（`__host.*` + 站点 id）、诊断码/文案、typed ask 的 schema、
 * 以及保存工作流的元数据块。
 *
 * 诊断文案按 ZCode Desktop 3.17.2 的脚本编译契约逐字（9001/9003–9012），所以断言用文案里
 * 的稳定片段——那正是模型与用户会看到的东西。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPILER_DIAGNOSTIC_CODES, FACADE_DTS, SNIPPET_FACADE_DTS, compileWorkflowScript,
  extractMetadataHeader, serializeMetadataHeader,
} from '../host/compiler.js';

/** 诊断里的 code 列表。 */
const codes = (result) => result.diagnostics.map((diagnostic) => diagnostic.code);
/** 诊断文案拼一起，便于断言片段。 */
const text = (result) => result.diagnostics.map((diagnostic) => diagnostic.message).join('\n');

test('facade 声明是现行版本：有 agent/ask/hole/channel，没有旧版 parallel/pipeline/budget', () => {
  for (const fragment of [
    'declare function agent(name?: string, persona?: string | AgentPersona): Agent;',
    'ask<T = string>(instructions: string): Node<T>;',
    'declare function phase(name: string): void;',
    'declare function report(item: unknown, artifactId?: string): void;',
    'declare function hole<T>(name: string, prompt?: string): Promise<T>;',
    'declare function channel<T>(name?: string): Channel<T>;',
    'declare const artifact: {',
    'declare const world: {',
    'declare const args: Readonly<Record<string, unknown>>;',
  ]) {
    assert.equal(FACADE_DTS.includes(fragment), true, `facade 缺少：${fragment}`);
  }
  for (const absent of ['declare function parallel', 'declare function pipeline', 'declare const budget', 'declare function workflow']) {
    assert.equal(FACADE_DTS.includes(absent), false, `facade 不应包含：${absent}`);
  }
  // snippet 版没有编排面
  assert.equal(SNIPPET_FACADE_DTS.includes('declare function agent'), false);
  assert.equal(SNIPPET_FACADE_DTS.includes('declare function report'), false);
  assert.equal(SNIPPET_FACADE_DTS.includes('declare function phase'), false);
  assert.equal(SNIPPET_FACADE_DTS.includes('declare const world'), true);
});

test('编译一个正常脚本：站点、阶段、lowering 都指向 __host', () => {
  const result = compileWorkflowScript({
    code: [
      'phase("look");',
      'const worker = agent("worker");',
      'const answer = await worker.ask("summarise the file");',
      'report({ answer });',
      'return answer;',
    ].join('\n'),
  });
  assert.equal(result.ok, true, text(result));
  assert.deepEqual(result.phases, ['look']);
  assert.equal(result.actors[0].name, 'worker');
  assert.equal(result.actors[0].siteId, 'actor#1');
  assert.match(result.lowered, /__host\.enterPhase\("look"\)/);
  assert.match(result.lowered, /__host\.createActor\("actor#1", "worker"\)/);
  assert.match(result.lowered, /__host\.ask\("ask#1", worker, "summarise the file"\)/);
  // 类型擦除后的打印器会重排对象字面量，所以按结构断言（站点 id + 调用形状），不按空白。
  assert.match(result.lowered, /__host\.report\("report#1",/);
  assert.match(result.lowered, /answer/);
  assert.equal(result.askSpecs.get('ask#1').typed, false);
  assert.equal(result.sitePhases.get('ask#1'), 'look');
});

test('typed ask 从脚本里的 interface 生成 JSON Schema', () => {
  const result = compileWorkflowScript({
    code: [
      'interface Verdict {',
      '  ok: boolean;',
      '  note?: string;',
      '}',
      'const judge = agent("judge");',
      'const verdict = await judge.ask<Verdict>("judge it");',
      'return verdict;',
    ].join('\n'),
  });
  assert.equal(result.ok, true, text(result));
  const spec = result.askSpecs.get('ask#1');
  assert.equal(spec.typed, true);
  assert.equal(spec.schema.type, 'object');
  assert.deepEqual(spec.schema.required, ['ok']);
  assert.equal(spec.schema.properties.ok.type, 'boolean');
  assert.equal(spec.schema.properties.note.type, 'string');
  assert.equal(spec.typeName, 'Verdict');
});

test('模块语法：declare / export / import 用 1184 的契约文案', () => {
  const declared = compileWorkflowScript({ code: 'declare const answer: number;\nreturn 1;' });
  assert.deepEqual(codes(declared), [COMPILER_DIAGNOSTIC_CODES.MODULE_SYNTAX]);
  assert.match(text(declared), /The `declare` modifier is not allowed in a workflow script/);

  const exported = compileWorkflowScript({ code: 'export const x = 1;\nreturn x;' });
  assert.deepEqual(codes(exported), [COMPILER_DIAGNOSTIC_CODES.MODULE_SYNTAX]);
  assert.match(text(exported), /`export` is not allowed in a workflow script/);

  const imported = compileWorkflowScript({ code: 'import fs from "node:fs";\nreturn 1;' });
  assert.deepEqual(codes(imported), [COMPILER_DIAGNOSTIC_CODES.MODULE_SYNTAX]);
  assert.match(text(imported), /`import` is not allowed in a workflow script/);
});

test('phase 三条硬约束：字面量、非空、独立语句（9004）', () => {
  const notLiteral = compileWorkflowScript({ code: 'phase(name);\nreturn 1;' });
  assert.deepEqual(codes(notLiteral), [COMPILER_DIAGNOSTIC_CODES.PHASE]);
  assert.match(text(notLiteral), /phase\(\)'s argument must be a compile-time string literal/);

  const empty = compileWorkflowScript({ code: 'phase("");\nreturn 1;' });
  assert.deepEqual(codes(empty), [COMPILER_DIAGNOSTIC_CODES.PHASE]);
  assert.match(text(empty), /phase\(""\) has no name to show/);

  const notStandalone = compileWorkflowScript({ code: 'const label = phase("gate");\nreturn label;' });
  assert.deepEqual(codes(notStandalone), [COMPILER_DIAGNOSTIC_CODES.PHASE]);
  assert.match(text(notStandalone), /must stand alone as its own statement/);
});

test('world.run 首参必须是字面量（9003）', () => {
  const result = compileWorkflowScript({
    code: 'const command = "echo";\nawait world.run(command, ["hi"]);\nreturn 1;',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), [COMPILER_DIAGNOSTIC_CODES.WORLD_COMMAND]);
  assert.match(text(result), /world\.run's first argument must be a compile-time string literal/);
});

test('同名 actor 是 9005，文案逐字', () => {
  const result = compileWorkflowScript({
    code: 'const one = agent("dup");\nconst two = agent("dup");\nreturn [one, two];',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), [COMPILER_DIAGNOSTIC_CODES.DUPLICATE_ACTOR]);
  assert.match(text(result), /two actors are named "dup" \(the first is on line 1\): an actor name must be unique within a run/);
});

test('hole 的两条硬约束：缺类型参数、未 await（9012）', () => {
  const noType = compileWorkflowScript({ code: 'const v = await hole("decide");\nreturn v;' });
  assert.deepEqual(codes(noType), [COMPILER_DIAGNOSTIC_CODES.HOLE]);
  assert.match(text(noType), /hole\(\) needs an explicit type argument \(hole<Plan>\(\.\.\.\)\)/);

  const notAwaited = compileWorkflowScript({ code: 'const v = hole<{ n: number }>("decide");\nreturn v;' });
  assert.deepEqual(codes(notAwaited), [COMPILER_DIAGNOSTIC_CODES.HOLE]);
  assert.match(text(notAwaited), /hole\(\) must be awaited where it is called/);
});

test('artifact id 校验（9007）与 report tag 指向未声明 preset（9007）', () => {
  const illegal = compileWorkflowScript({ code: 'await artifact.file("bad id", "p.txt");\nreturn 1;' });
  assert.deepEqual(codes(illegal), [COMPILER_DIAGNOSTIC_CODES.ARTIFACT]);
  assert.match(text(illegal), /contains characters outside \[A-Za-z0-9_\.-\]/);

  const missingTag = compileWorkflowScript({ code: 'report({ a: 1 }, "nope");\nreturn 1;' });
  assert.deepEqual(codes(missingTag), [COMPILER_DIAGNOSTIC_CODES.ARTIFACT]);
  assert.match(text(missingTag), /report\(\)'s tag "nope" names no preset artifact declared in this script \(this script declares no preset artifacts at all\)/);

  const valid = compileWorkflowScript({
    code: [
      'artifact.metrics("tiles", { metrics: [{ field: "n" }] });',
      'report({ n: 1 }, "tiles");',
      'return 1;',
    ].join('\n'),
  });
  assert.equal(valid.ok, true, text(valid));
  assert.match(valid.lowered, /__host\.declareArtifact\("artifact#1", "metrics", \[/);
  assert.match(valid.lowered, /__host\.report\("report#1",/);
  assert.match(valid.lowered, /"tiles"\)/);
});

test('契约里没有 9002：未声明的名字报 TS 2304 "Cannot find name"', () => {
  // 9002 不在这份契约的码表里（9001、9003–9012），「名字不存在」由 TS 的语义诊断承担。
  assert.equal(Object.values(COMPILER_DIAGNOSTIC_CODES).includes(9002), false);

  const nodeGlobal = compileWorkflowScript({ code: 'const p = process.env.HOME;\nreturn p;' });
  assert.deepEqual(codes(nodeGlobal), [COMPILER_DIAGNOSTIC_CODES.UNKNOWN_NAME]);
  assert.equal(text(nodeGlobal), "Cannot find name 'process'.");

  const legacy = compileWorkflowScript({ code: 'const a = parallel([1, 2]);\nreturn a;' });
  assert.deepEqual(codes(legacy), [COMPILER_DIAGNOSTIC_CODES.UNKNOWN_NAME]);
  assert.equal(text(legacy), "Cannot find name 'parallel'.");

  const typo = compileWorkflowScript({ code: 'const z = frobnicate(1);\nreturn z;' });
  assert.deepEqual(codes(typo), [COMPILER_DIAGNOSTIC_CODES.UNKNOWN_NAME]);
  assert.equal(text(typo), "Cannot find name 'frobnicate'.");

  // Date.now() / Math.random() 是运行期禁令（契约 §2.13，cell 抛错），不是编译期诊断。
  assert.equal(compileWorkflowScript({ code: 'const t = Date.now();\nreturn t;' }).ok, true);
  assert.equal(compileWorkflowScript({ code: 'const r = Math.random();\nreturn r;' }).ok, true);
});

test('snippet 是被裁剪的 facade（9001）', () => {
  const result = compileWorkflowScript({ code: 'const a = agent("x");\nreturn a;', mode: 'snippet' });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), [COMPILER_DIAGNOSTIC_CODES.FACADE_MISUSE]);
  assert.match(text(result), /agent\(\) does not exist in a snippet/);
});

test('facade 取引用是 9001（站点身份依赖直接调用）', () => {
  const result = compileWorkflowScript({ code: 'const f = report;\nreturn 1;' });
  assert.deepEqual(codes(result), [COMPILER_DIAGNOSTIC_CODES.FACADE_MISUSE]);
  assert.match(text(result), /facade function 'report' may only be called directly/);
});

test('空脚本合法（契约没有空脚本诊断）', () => {
  const result = compileWorkflowScript({ code: '' });
  assert.equal(result.ok, true);
  assert.equal(result.lowered, '');
});

test('args / run 被 lowering 到 __host', () => {
  const result = compileWorkflowScript({
    code: 'const target = String(args.target);\nlog(target + run.id);\nreturn target;',
  });
  assert.equal(result.ok, true, text(result));
  assert.match(result.lowered, /String\(__host\.args\.target\)/);
  assert.match(result.lowered, /__host\.log\(target \+ __host\.run\.id\)/);
});

test('保存工作流元数据块可往返，且缺块/未闭合有可判别原因', () => {
  const meta = {
    description: 'Summarise a repository',
    whenToUse: 'When the user wants a survey',
    args: {
      target: { type: 'string', required: true, description: 'What to survey' },
      depth: { type: 'number', default: 2 },
    },
  };
  const body = 'phase("look");\nreturn 1;';
  const file = serializeMetadataHeader(meta, body);
  assert.equal(file.startsWith('/* zcode-workflow\n'), true);
  const parsed = extractMetadataHeader(file);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.deepEqual(parsed.meta, meta);
  assert.equal(parsed.script, body);

  const missing = extractMetadataHeader('phase("look");\nreturn 1;');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing_frontmatter');

  const unterminated = extractMetadataHeader('/* zcode-workflow\ndescription: x\n');
  assert.equal(unterminated.ok, false);
  assert.equal(unterminated.reason, 'unterminated_frontmatter');
});

test('9006：扇出里用固定名字建 actor 非法，匿名与拼接名字合法', () => {
  const fixed = compileWorkflowScript({
    code: [
      'const items = [1, 2];',
      'const all = await Promise.all(items.map(async (item) => {',
      '  const reviewer = agent("reviewer");',
      '  return reviewer.ask("look at " + item);',
      '}));',
      'return all;',
    ].join('\n'),
  });
  assert.deepEqual(codes(fixed), [COMPILER_DIAGNOSTIC_CODES.FIXED_ACTOR_NAME]);
  assert.match(text(fixed), /"reviewer" is a fixed string/);
  // 契约允许的两条出路：不命名，或每元素一个名字。
  for (const legal of [
    'const items = [1, 2];\nconst all = await Promise.all(items.map(async (item) => {\n  const reviewer = agent();\n  return reviewer.ask("look at " + item);\n}));\nreturn all;',
    'const items = [1, 2];\nconst all = await Promise.all(items.map(async (item) => {\n  const reviewer = agent("reviewer-" + item);\n  return reviewer.ask("look at " + item);\n}));\nreturn all;',
  ]) {
    assert.equal(compileWorkflowScript({ code: legal }).ok, true, legal);
  }
});

test('9008：preset 只能在顶层声明；content 产物不受位置限制', () => {
  const cases = [
    ['for (const item of [1, 2]) {\n  artifact.table("tiles", { columns: [] });\n}\nreturn 1;', /declared inside a loop/],
    ['const rows = [1].map((item) => artifact.chart("bars", { x: { field: "a" }, y: { field: "b" } }));\nreturn rows;', /declared inside a callback/],
    ['if (args.deep) {\n  artifact.metrics("stats", { metrics: [] });\n}\nreturn 1;', /declared inside a conditional branch/],
  ];
  for (const [code, expected] of cases) {
    const result = compileWorkflowScript({ code });
    assert.deepEqual(codes(result), [COMPILER_DIAGNOSTIC_CODES.PRESET_PLACEMENT], code);
    assert.match(text(result), expected);
  }
  const fileInLoop = compileWorkflowScript({
    code: 'for (const item of [1, 2]) {\n  artifact.file("out", "a.txt");\n}\nreturn 1;',
  });
  assert.equal(fileInLoop.ok, true, text(fileInLoop));
});

test('9009：一个 run 只有一个 primary，跨 kind 也按首条报', () => {
  const sameKind = compileWorkflowScript({
    code: 'artifact.markdown("a", "one", { primary: true });\nartifact.markdown("b", "two", { primary: true });\nreturn 1;',
  });
  assert.deepEqual(codes(sameKind), [COMPILER_DIAGNOSTIC_CODES.PRIMARY_CONFLICT]);
  assert.match(text(sameKind), /artifact "b" is marked primary, but "a" already is \(artifact\.markdown on line 1\)/);

  // preset 的 spec 自带 ArtifactOptions（primary 在 spec 里），与 content 产物的 opts 等价。
  const crossKind = compileWorkflowScript({
    code: 'artifact.markdown("summary", "text", { primary: true });\nartifact.table("tiles", { columns: [], primary: true });\nreturn 1;',
  });
  assert.deepEqual(codes(crossKind), [COMPILER_DIAGNOSTIC_CODES.PRIMARY_CONFLICT]);
  assert.match(text(crossKind), /artifact "tiles" is marked primary, but "summary" already is \(artifact\.markdown on line 1\)/);

  const single = compileWorkflowScript({
    code: 'artifact.markdown("summary", "text", { primary: true });\nartifact.table("tiles", { columns: [] });\nreturn 1;',
  });
  assert.equal(single.ok, true, text(single));
});

test('9010：model() 要字面量，persona 的 model 接受 ModelRef 与字面量', () => {
  const notLiteral = compileWorkflowScript({ code: 'const chosen = String(args.model);\nconst ref = model(chosen);\nreturn ref.name;' });
  assert.match(text(notLiteral), /model\(\) takes the model name as a non-empty string literal/);
  const empty = compileWorkflowScript({ code: 'const ref = model("");\nreturn 1;' });
  assert.match(text(empty), /model\(\) takes the model name as a non-empty string literal/);

  const dynamic = compileWorkflowScript({
    code: 'const dynamicName = String(args.m);\nconst helper = agent("helper", { model: dynamicName });\nreturn helper.ask("hi");',
  });
  assert.deepEqual(codes(dynamic), [COMPILER_DIAGNOSTIC_CODES.MODEL]);
  assert.match(text(dynamic), /must be known before the run starts/);

  // 契约允许「字面量」与「model() 出来的 ModelRef」，变量持有 ModelRef 也算。
  for (const legal of [
    'const helper = agent("helper", { model: "a/x" });\nreturn helper.ask("hi");',
    'const ref = model("a/x");\nconst helper = agent("helper", { model: ref });\nreturn helper.ask("hi");',
    'const ref: ModelRef = model("a/x");\nconst helper = agent("helper", { model: ref });\nreturn helper.ask("hi");',
  ]) {
    const result = compileWorkflowScript({ code: legal });
    assert.equal(result.ok, true, text(result));
  }
});

test('9011 不在码表里：没有模型目录就不做可用性判定', () => {
  // 契约的 9011 要「这个 run 能用的模型集」，Harness 不向插件暴露，所以 model("…") 只校验字面量。
  assert.equal(Object.values(COMPILER_DIAGNOSTIC_CODES).includes(9011), false);
  assert.equal(compileWorkflowScript({ code: 'const ref = model("any/model");\nreturn 1;' }).ok, true);
});

test('内联链 agent("…").ask(…) 同样建站点：一个 actor 配一个 ask', () => {
  const result = compileWorkflowScript({
    code: 'const out = await agent("scout").ask("find the tests");\nreturn out;',
  });
  assert.equal(result.ok, true, text(result));
  assert.equal(result.actors.length, 1);
  assert.equal(result.actors[0].name, 'scout');
  assert.match(result.lowered, /__host\.ask\("ask#1", __host\.createActor\("actor#1", "scout"\), "find the tests"\)/);
  assert.equal(result.askSpecs.get('ask#1').typed, false);
});
