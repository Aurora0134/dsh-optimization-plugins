import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

function harness(config = {}) {
  const tools = [];
  const sections = [];
  let turn = 1;
  const ctx = {
    tools: {
      register(definition, options) {
        tools.push({ definition, options });
      },
      get(name) {
        return tools.find((entry) => entry.definition.name === name)?.definition;
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
      },
    },
    on() {},
    get(name) {
      if (name === 'agents') return { turnBoundaryOf: () => ({ lastTurn: turn }) };
      return undefined;
    },
  };
  apply(ctx, config);
  const byName = (name) => tools.find((entry) => entry.definition.name === name).definition;
  return {
    tools,
    sections,
    byName,
    setTurn(value) {
      turn = value;
    },
  };
}

const SVG = '<svg viewBox="0 0 720 320"><rect x="40" y="40" width="200" height="80" rx="8" fill="#eef4ff" stroke="#2563eb"/><text x="60" y="86" font-size="13" fill="#1f2328">Hello</text></svg>';

test('registers both tools and the prompt section', () => {
  const h = harness();
  assert.deepEqual(h.tools.map((entry) => entry.definition.name), ['show_visual', 'visual_guide']);
  assert.equal(h.sections.length, 1);
  assert.equal(h.sections[0].text({ scope: undefined, toolSet: undefined }).includes('visual_guide'), true);
});

test('valid call returns a one-line summary without the SVG', () => {
  const h = harness();
  const result = h.byName('show_visual').execute({ svg: SVG, title: '架构', caption: '一行说明' }, { agent: { session: {} } });
  assert.match(result, /^\[visual\] 架构 - 2 shapes, 0\.[0-9] KB - 一行说明$/);
  assert.equal(result.includes('<svg'), false);
});

test('invalid payloads fail with a readable reason', () => {
  const h = harness();
  assert.throws(() => h.byName('show_visual').execute({ svg: '<svg viewBox="0 0 10 10"><script/></svg>', title: 'x' }, {}), /script|unsupported/i);
  assert.throws(() => h.byName('show_visual').execute({ svg: SVG, title: 'a\nb' }, {}), /single line/);
  assert.throws(() => h.byName('show_visual').execute({ svg: SVG, title: 'x', caption: 'a'.repeat(201) }, {}), /caption/);
  assert.throws(() => h.byName('show_visual').execute({ svg: SVG, title: 'x', loading: [] }, {}), /loading/);
});

test('quota is per turn and resets on the next turn', () => {
  const h = harness();
  const exec = { agent: { session: {} } };
  const call = () => h.byName('show_visual').execute({ svg: SVG, title: 't' }, exec);
  call();
  call();
  call();
  assert.throws(call, /already rendered 3 visuals/);
  h.setTurn(2);
  assert.match(call(), /^\[visual\]/);
});

test('config can disable both tools', () => {
  const h = harness({ enabled: false });
  assert.equal(h.tools[0].options.when(), false);
  assert.equal(h.tools[1].options.when(), false);
});

test('guide returns the six sections', () => {
  const h = harness();
  const guide = h.byName('visual_guide').execute({}, {});
  for (const heading of ['## Canvas', '## Color', '## Typography', '## Spacing and strokes', '## Scenarios', '## Hard limits']) {
    assert.equal(guide.includes(heading), true, heading);
  }
});
