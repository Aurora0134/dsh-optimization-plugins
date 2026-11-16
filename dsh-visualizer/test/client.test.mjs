import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { TextEncoder } from 'node:util';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function loadPlugin() {
  let registration;
  const sandbox = {
    window: { __ModuleLoader__: { load(options) { registration = options; } } },
    console: { info() {}, error() {}, warn() {} },
    TextEncoder,
  };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  assert.equal(registration.id, 'dsh-visualizer');
  let captured;
  const React = {
    createElement(type, props, ...children) {
      return { type, props: Object.assign({}, props, { children: children.flat() }) };
    },
    Component: class Component {
      constructor(props) { this.props = props; this.state = {}; }
      setState(next) { Object.assign(this.state, next); }
    },
    useId() { return ':r0:'; },
    useMemo(fn) { return fn(); },
  };
  React.Component.prototype.isReactComponent = {};
  const plugin = registration.factory((name) => {
    if (name === 'react') return React;
    throw new Error('unexpected module ' + name);
  });
  const ctx = {
    effect(fn) { return fn(); },
    locale: {
      register() { return function () {}; },
      bind() { return (key) => key; },
    },
    slots: {
      inject(_key, callback) { return callback(); },
      register(_options, component) { captured = component; return function () {}; },
    },
  };
  plugin.apply(ctx);
  assert.equal(typeof captured, 'function');
  return { component: captured, React };
}

function render(node) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map(render);
  if (typeof node.type === 'function') {
    const props = Object.assign({}, node.props);
    if (node.type.prototype && node.type.prototype.isReactComponent) {
      const instance = new node.type(props);
      return render(instance.render());
    }
    return render(node.type(props));
  }
  const props = Object.assign({}, node.props);
  delete props.children;
  const children = (node.props.children || []).map(render);
  return { type: node.type, props, children };
}

function findAll(node, predicate, found = []) {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) findAll(child, predicate, found);
  return found;
}

const svg = '<svg viewBox="0 0 720 320"><rect x="40" y="40" width="200" height="80" rx="8" fill="#eef4ff" stroke="#2563eb"/><text x="60" y="86" font-size="13" fill="#1f2328">Hello</text></svg>';

function argsFor(values) {
  return {
    text(key) { return values[key]; },
    value(key) { return values[key]; },
    complete() { return true; },
    stringLength(key) { return typeof values[key] === 'string' ? values[key].length : undefined; },
  };
}

test('renders a ready card with the SVG tree and caption', () => {
  const { component, React } = loadPlugin();
  const tree = render(React.createElement(component, {
    phase: 'result',
    block: { isError: false, args: argsFor({ svg, title: '架构图', caption: '一条说明' }) },
  }));
  const cards = findAll(tree, (n) => n.props && n.props.className === 'dsv-card');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].props['data-state'], 'ready');
  const svgs = findAll(tree, (n) => n.type === 'svg' && n.props.viewBox === '0 0 720 320');
  assert.equal(svgs.length, 1);
  const drawingRect = svgs[0].children.find((n) => n.type === 'rect');
  assert.equal(drawingRect.props.fill, '#eef4ff');
  const drawingText = svgs[0].children.find((n) => n.type === 'text');
  assert.equal(drawingText.children[0], 'Hello');
  const captions = findAll(tree, (n) => n.props && n.props.className === 'dsv-caption');
  assert.equal(captions[0].children[0], '一条说明');
});

test('renders the loading skeleton before the result', () => {
  const { component, React } = loadPlugin();
  const tree = render(React.createElement(component, {
    phase: 'preparing',
    block: { args: argsFor({ title: '架构图', loading: ['正在画'] }) },
  }));
  const skeletons = findAll(tree, (n) => n.props && n.props.className === 'dsv-skeleton');
  assert.equal(skeletons.length, 1);
  assert.equal(findAll(tree, (n) => n.props && n.props.className === 'dsv-loading')[0].children[0], '正在画');
});

test('rejects an unsafe SVG as a whole and shows the reason', () => {
  const { component, React } = loadPlugin();
  const bad = '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>';
  const tree = render(React.createElement(component, {
    phase: 'result',
    block: { isError: false, args: argsFor({ svg: bad, title: 'bad' }) },
  }));
  const cards = findAll(tree, (n) => n.props && n.props['data-state'] === 'error');
  assert.equal(cards.length, 1);
  const body = findAll(tree, (n) => n.props && n.props.className === 'dsv-error-body');
  assert.match(body[0].children[0], /unsupported element <script>/);
  assert.equal(findAll(tree, (n) => n.type === 'script').length, 0);
});

test('does not render a payload the Host rejected', () => {
  const { component, React } = loadPlugin();
  const tree = render(React.createElement(component, {
    phase: 'result',
    block: { isError: true, args: argsFor({ svg, title: '架构图' }) },
  }));
  const cards = findAll(tree, (n) => n.props && n.props['data-state'] === 'error');
  assert.equal(cards.length, 1);
  assert.equal(findAll(tree, (n) => n.type === 'svg' && n.props.viewBox === '0 0 720 320').length, 0);
});
