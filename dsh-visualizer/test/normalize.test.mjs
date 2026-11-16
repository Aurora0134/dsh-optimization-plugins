import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSvg, LIMITS } from '../src/normalize.js';

const wrap = (inner, attrs = 'viewBox="0 0 720 320"') => '<svg ' + attrs + '>' + inner + '</svg>';

const good = `<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#247bbf"/>
      <stop offset="1" stop-color="#7cc4ff" stop-opacity="0.9"/>
    </linearGradient>
  </defs>
  <rect x="40" y="40" width="200" height="80" rx="8" fill="url(#g1)" stroke="#1f2328" stroke-width="1"/>
  <text x="60" y="90" font-size="13" fill="#1f2328">A &amp; B &lt; C</text>
</svg>`;

test('normalizes a valid diagram and rewrites ids', () => {
  const out = normalizeSvg(good, 'p');
  assert.equal(out.root.name, 'svg');
  assert.equal(out.elementCount, 7);
  const defs = out.root.children.find((node) => node.name === 'defs');
  assert.equal(defs.children[0].attrs.id, 'p-g1');
  const rect = out.root.children.find((node) => node.name === 'rect');
  assert.equal(rect.attrs.fill, 'url(#p-g1)');
  const text = out.root.children.find((node) => node.name === 'text');
  assert.equal(text.children[0].value, 'A & B < C');
});

test('drops unknown attributes instead of rejecting', () => {
  const out = normalizeSvg(wrap('<rect x="1" y="1" width="2" height="2" data-x="1" filter="url(#f)"/>'), 'p');
  assert.equal(out.root.children[0].attrs['data-x'], undefined);
  assert.equal(out.root.children[0].attrs.filter, undefined);
});

test('accepts self-closing root and numeric entities', () => {
  assert.equal(normalizeSvg('<svg viewBox="0 0 10 10"/>', 'p').root.name, 'svg');
  const out = normalizeSvg(wrap('<text x="1" y="2">&#65;&#x42;</text>'), 'p');
  assert.equal(out.root.children[0].children[0].value, 'AB');
});

test('rejects every malformed or unsafe construct as a whole', () => {
  const cases = {
    doctype: '<!DOCTYPE svg><svg viewBox="0 0 10 10"/>',
    comment: '<svg viewBox="0 0 10 10"><!-- x --><rect width="1" height="1"/></svg>',
    cdata: '<svg viewBox="0 0 10 10"><text><![CDATA[x]]></text></svg>',
    processing: '<?xml version="1.0"?><svg viewBox="0 0 10 10"/>',
    script: '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>',
    styleElement: '<svg viewBox="0 0 10 10"><style>*{}</style></svg>',
    use: '<svg viewBox="0 0 10 10"><use href="#x"/></svg>',
    image: '<svg viewBox="0 0 10 10"><image href="x"/></svg>',
    foreignObject: '<svg viewBox="0 0 10 10"><foreignObject/></svg>',
    animate: '<svg viewBox="0 0 10 10"><animate attributeName="x"/></svg>',
    iframe: '<svg viewBox="0 0 10 10"><iframe/></svg>',
    link: '<svg viewBox="0 0 10 10"><link/></svg>',
    onload: wrap('<rect width="1" height="1" onload="x"/>'),
    href: wrap('<rect width="1" height="1" href="x"/>'),
    xlinkHref: wrap('<rect width="1" height="1" xlink:href="x"/>'),
    styleAttr: wrap('<rect width="1" height="1" style="fill:red"/>'),
    classAttr: wrap('<rect width="1" height="1" class="x"/>'),
    externalUrl: wrap('<rect width="1" height="1" fill="url(http://x)"/>'),
    danglingUrl: wrap('<rect width="1" height="1" fill="url(#missing)"/>'),
    varPaint: wrap('<rect width="1" height="1" fill="var(--x)"/>'),
    expressionPaint: wrap('<rect width="1" height="1" fill="expression(alert(1))"/>'),
    noViewBox: '<svg><rect width="1" height="1"/></svg>',
    zeroViewBox: '<svg viewBox="0 0 0 10"/>',
    multiRoot: '<svg viewBox="0 0 10 10"/><svg viewBox="0 0 10 10"/>',
    unquoted: '<svg viewBox=0><rect width="1" height="1"/></svg>',
    duplicateAttr: '<svg viewBox="0 0 10 10" viewBox="0 0 10 10"/>',
    uppercase: '<SVG viewBox="0 0 10 10"/>',
    entity: wrap('<text x="1" y="2">&foo;</text>'),
    zeroEntity: wrap('<text x="1" y="2">&#0;</text>'),
    nestedMarkup: wrap('<text x="1" y="2"><b>x</b></text>'),
    textInG: wrap('<g>hello</g>'),
    depth: '<svg viewBox="0 0 10 10">' + '<g>'.repeat(32) + '</g>'.repeat(32) + '</svg>',
    nodes: '<svg viewBox="0 0 10 10">' + '<rect width="1" height="1"/>'.repeat(1500) + '</svg>',
    badId: wrap('<linearGradient id="G1"><stop offset="0" stop-color="red"/></linearGradient>'),
    duplicateId: wrap('<g id="a"/><g id="a"/>'),
    rectChild: wrap('<rect width="1" height="1"><path d="M0 0"/></rect>'),
    trailing: '<svg viewBox="0 0 10 10"/>junk',
    unclosed: '<svg viewBox="0 0 10 10"><g>',
    mismatched: '<svg viewBox="0 0 10 10"><g></svg>',
    wrongRoot: '<g viewBox="0 0 10 10"/>',
    evilNamespace: '<svg viewBox="0 0 10 10" xmlns="http://evil"/>',
    angleAttr: wrap('<rect width="1" height="1" fill="<x"/>'),
    badTransform: wrap('<rect width="1" height="1" transform="url(#x)"/>'),
    badOffset: wrap('<defs><linearGradient id="g"><stop offset="2" stop-color="red"/></linearGradient></defs>'),
    badFontSize: wrap('<text x="1" y="1" font-size="500">x</text>'),
    badOpacity: wrap('<rect width="1" height="1" opacity="2"/>'),
    badPath: wrap('<path d="M0 0 Q x"/>'),
    shortPoints: wrap('<polygon points="1"/>'),
    textChild: wrap('<text x="1" y="1"><rect width="1" height="1"/></text>'),
  };
  for (const [name, svg] of Object.entries(cases)) {
    assert.throws(() => normalizeSvg(svg, 'p'), Error, name);
  }
});

test('failure is deterministic, never a partial tree', () => {
  const input = wrap('<rect width="1" height="1" onload="x"/>');
  assert.throws(() => normalizeSvg(input, 'p'));
  assert.throws(() => normalizeSvg(input, 'p'));
});

test('enforces the byte limit before parsing', () => {
  const huge = '<svg viewBox="0 0 10 10">' + '<text x="1" y="1">' + 'a'.repeat(30000) + '</text></svg>';
  assert.throws(() => normalizeSvg(huge, 'p'), new RegExp(String(LIMITS.maxBytes)));
});
