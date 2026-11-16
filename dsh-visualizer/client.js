/**
 * Browser half of dsh-visualizer: the inline card shown where a show_visual
 * call appears.
 *
 * Host contract this file depends on:
 *  - window.__ModuleLoader__.load({ id, factory }); id equals the package name.
 *  - ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(...))
 *    with key: 'show_visual' replaces the generic row for that wire tool name.
 *  - Owner props: phase, block.time, block.isError, block.args.text(key),
 *    block.args.value(key), block.args.complete(key), block.args.stringLength(key).
 *  - ctx.locale.register / bind, ctx.effect.
 *
 * The SVG is parsed and re-validated here, not trusted from the Host: the tool
 * arguments are persisted with the conversation, so a Host bug or an old
 * payload must not be able to reach innerHTML. Every node becomes a React
 * element; no dangerouslySetInnerHTML and no DOMParser anywhere in this file.
 */
window.__ModuleLoader__.load({
  id: 'dsh-visualizer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * Strict SVG subset parser and whitelist normalizer for dsh-visualizer.
     *
     * Pure JavaScript: no DOM, no React, no network. The Host imports it to reject
     * a bad payload before it reaches a conversation; the Client build inlines the
     * same source before it turns the tree into React elements. Keeping one source
     * of truth matters because the Client must not trust the Host's verdict alone.
     */

    const LIMITS = Object.freeze({
      maxBytes: 24 * 1024,
      maxNodes: 1500,
      maxDepth: 32,
      maxText: 200,
      maxPath: 8192,
      maxPoints: 4096,
      maxAttr: 2048,
    });

    /** Style attributes shared by the drawable shapes. */
    const PAINT = [
      'fill',
      'fill-opacity',
      'fill-rule',
      'stroke',
      'stroke-width',
      'stroke-opacity',
      'stroke-linecap',
      'stroke-linejoin',
      'opacity',
      'transform',
    ];

    /** Every element that may appear in a card, with its complete attribute set. */
    const ELEMENTS = {
      svg: ['viewBox', 'width', 'height', 'xmlns'],
      g: PAINT,
      path: ['d', ...PAINT],
      rect: ['x', 'y', 'width', 'height', 'rx', 'ry', ...PAINT],
      circle: ['cx', 'cy', 'r', ...PAINT],
      ellipse: ['cx', 'cy', 'rx', 'ry', ...PAINT],
      line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap'],
      polyline: ['points', ...PAINT],
      polygon: ['points', ...PAINT],
      text: [
        'x',
        'y',
        'dx',
        'dy',
        'font-size',
        'font-weight',
        'text-anchor',
        'dominant-baseline',
        'fill',
        'fill-opacity',
        'opacity',
        'transform',
      ],
      tspan: ['x', 'y', 'dx', 'dy', 'font-size', 'font-weight', 'fill', 'fill-opacity'],
      defs: [],
      linearGradient: ['x1', 'y1', 'x2', 'y2', 'gradientUnits'],
      radialGradient: ['cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits'],
      stop: ['offset', 'stop-color', 'stop-opacity'],
    };

    const ALLOWED = new Map(Object.entries(ELEMENTS).map(([name, attrs]) => [name, new Set(attrs)]));

    const FORBIDDEN_ATTRIBUTES = new Set(['href', 'xlink:href', 'style', 'class']);

    const TEXT_PARENTS = new Set(['text', 'tspan']);
    const WHITESPACE_PARENTS = new Set(['svg', 'g', 'defs', 'linearGradient', 'radialGradient']);

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
    const UUID_LIKE = /[^A-Za-z0-9_-]/g;

    const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
    const LENGTH = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:px|%)?$/;
    const NUMBER_LIST = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:px|%)?(?:[\s,]+[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:px|%)?)*$/;
    const TRANSFORM = /^\s*(?:(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([^()]*\)\s*)+$/;
    const PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]+$/;
    const POINT_DATA = /^[0-9eE.,+\-\s]+$/;
    const COLOR_FUNCTION = /^(?:rgb|rgba|hsl|hsla)\(\s*[-+0-9.%\s,/]+\s*\)$/i;
    const COLOR_HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
    const COLOR_NAME = /^[a-zA-Z]{3,24}$/;
    const URL_PAINT = /^url\(\s*#([a-z][a-z0-9-]{0,31})\s*\)$/;

    class SvgError extends Error {
      constructor(message) {
        super(message);
        this.name = 'SvgError';
      }
    }

    /**
     * Validate and canonicalize an SVG string.
     * @param {unknown} source raw SVG text supplied by the model
     * @param {string} [prefix] per-render id namespace (the Client passes React's useId)
     * @returns {{ root: object, nodeCount: number, elementCount: number }}
     * @throws {SvgError} on any malformed, unsupported, or unsafe construct
     */
    function normalizeSvg(source, prefix = 'v') {
      if (typeof source !== 'string') throw new SvgError('svg must be a string');
      const bytes = utf8Bytes(source);
      if (bytes > LIMITS.maxBytes) {
        throw new SvgError(
          'svg is ' + bytes + ' bytes; the limit is ' + LIMITS.maxBytes + ' bytes (24 KB). Remove nodes or shorten path data.',
        );
      }
      const namespace = sanitizePrefix(prefix);
      const parsed = parseDocument(source);
      validateRoot(parsed);
      validateTree(parsed);
      const ids = collectIds(parsed);
      const root = rewriteTree(parsed, namespace, ids);
      return { root, nodeCount: parsed.nodeCount, elementCount: parsed.elementCount };
    }

    function utf8Bytes(value) {
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
      let bytes = 0;
      for (let index = 0; index < value.length; index += 1) {
        const code = value.codePointAt(index);
        if (code > 0xffff) index += 1;
        if (code <= 0x7f) bytes += 1;
        else if (code <= 0x7ff) bytes += 2;
        else if (code <= 0xffff) bytes += 3;
        else bytes += 4;
      }
      return bytes;
    }

    function sanitizePrefix(value) {
      const cleaned = String(value === undefined || value === null ? '' : value)
        .replace(UUID_LIKE, '')
        .slice(0, 32);
      return cleaned === '' ? 'v' : cleaned;
    }

    function fail(message) {
      throw new SvgError(message);
    }

    function parseDocument(source) {
      let cursor = 0;
      const length = source.length;
      const root = { type: 'root', name: '#root', children: [], depth: 0 };
      const stack = [root];
      let nodeCount = 0;
      let elementCount = 0;

      const top = () => stack[stack.length - 1];

      const addNode = (node) => {
        const parent = top();
        if (parent === root) {
          if (root.children.length > 0) fail('svg must contain exactly one root element');
          if (node.type !== 'element' || node.name !== 'svg') fail('the root element must be <svg>');
          node.depth = 1;
        } else {
          node.depth = parent.depth + 1;
          if (node.depth > LIMITS.maxDepth) fail('svg nesting exceeds ' + LIMITS.maxDepth + ' levels');
          if (node.type === 'element' && !allowedParent(node.name, parent.name)) {
            fail('<' + node.name + '> is not allowed inside <' + parent.name + '>');
          }
        }
        nodeCount += 1;
        if (nodeCount > LIMITS.maxNodes) fail('svg has more than ' + LIMITS.maxNodes + ' nodes');
        if (node.type === 'element') elementCount += 1;
        parent.children.push(node);
        return node;
      };

      const addText = (raw) => {
        const parent = top();
        if (parent === root || parent.name === 'svg') {
          if (raw.trim() !== '') fail('text is not allowed directly inside <svg>');
          return;
        }
        if (!TEXT_PARENTS.has(parent.name)) {
          if (raw.trim() !== '') fail('text is not allowed inside <' + parent.name + '>');
          if (!WHITESPACE_PARENTS.has(parent.name)) fail('whitespace text is not allowed inside <' + parent.name + '>');
          return;
        }
        if (raw === '') return;
        if (raw.length > LIMITS.maxText) fail('a text node exceeds ' + LIMITS.maxText + ' characters');
        addNode({ type: 'text', value: raw });
      };

      while (cursor < length) {
        const nextTag = source.indexOf('<', cursor);
        const textEnd = nextTag === -1 ? length : nextTag;
        if (textEnd > cursor) {
          const raw = decodeEntities(source.slice(cursor, textEnd), 'text');
          checkCharacters(raw, 'text');
          addText(raw);
        }
        if (nextTag === -1) break;
        cursor = nextTag;

        if (source.startsWith('<!--', cursor)) fail('XML comments are not allowed');
        if (source.startsWith('<![CDATA[', cursor)) fail('CDATA sections are not allowed');
        if (source.startsWith('<!', cursor)) fail('DOCTYPE and entity declarations are not allowed');
        if (source.startsWith('<?', cursor)) fail('processing instructions are not allowed');

        if (source.startsWith('</', cursor)) {
          cursor += 2;
          const name = readName(source, cursor);
          if (name === '') fail('a closing tag has no element name');
          cursor = skipWhitespace(source, cursor + name.length);
          if (source[cursor] !== '>') fail('malformed closing tag </' + name + '>');
          cursor += 1;
          if (stack.length === 1) fail('unexpected closing tag </' + name + '>');
          const open = stack.pop();
          if (open.name !== name) fail('closing tag </' + name + '> does not match <' + open.name + '>');
          continue;
        }

        cursor += 1;
        const name = readName(source, cursor);
        if (name === '') fail('a start tag has no element name');
        cursor += name.length;
        if (!ALLOWED.has(name)) fail('unsupported element <' + name + '>');
        if (stack.length === 1 && root.children.length > 0) fail('svg must contain exactly one root element');

        const attrs = Object.create(null);
        let selfClosing = false;
        for (;;) {
          cursor = skipWhitespace(source, cursor);
          if (cursor >= length) fail('unclosed start tag <' + name + '>');
          const char = source[cursor];
          if (char === '>') {
            cursor += 1;
            break;
          }
          if (char === '/' && source[cursor + 1] === '>') {
            cursor += 2;
            selfClosing = true;
            break;
          }
          const start = cursor;
          while (cursor < length && !/[\s=/>]/.test(source[cursor])) cursor += 1;
          const attribute = source.slice(start, cursor);
          if (attribute === '') fail('malformed attribute in <' + name + '>');
          if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(attribute)) {
            fail('invalid attribute name "' + attribute + '" in <' + name + '>');
          }
          if (Object.prototype.hasOwnProperty.call(attrs, attribute)) {
            fail('duplicate attribute "' + attribute + '" in <' + name + '>');
          }
          cursor = skipWhitespace(source, cursor);
          if (source[cursor] !== '=') fail('attribute "' + attribute + '" in <' + name + '> has no value');
          cursor += 1;
          cursor = skipWhitespace(source, cursor);
          const quote = source[cursor];
          if (quote !== '"' && quote !== "'") fail('attribute "' + attribute + '" in <' + name + '> must be quoted');
          cursor += 1;
          const end = source.indexOf(quote, cursor);
          if (end === -1) fail('unterminated attribute "' + attribute + '" in <' + name + '>');
          const raw = source.slice(cursor, end);
          cursor = end + 1;
          if (raw.includes('<') || raw.includes('>')) fail('attribute "' + attribute + '" contains an angle bracket');
          const value = decodeEntities(raw, 'attribute ' + attribute);
          if (value.includes('<') || value.includes('>')) fail('attribute "' + attribute + '" contains an angle bracket');
          checkCharacters(value, 'attribute ' + attribute);
          if (value.length > LIMITS.maxAttr && attribute !== 'd' && attribute !== 'points') {
            fail('attribute "' + attribute + '" is longer than ' + LIMITS.maxAttr + ' characters');
          }
          attrs[attribute] = value;
        }

        const node = addNode({ type: 'element', name, attrs, children: [] });
        if (!selfClosing) stack.push(node);
      }

      if (stack.length !== 1) fail('unclosed element <' + top().name + '>');
      if (root.children.length !== 1) fail('svg must contain exactly one root element');
      const documentRoot = root.children[0];
      documentRoot.nodeCount = nodeCount;
      documentRoot.elementCount = elementCount;
      return documentRoot;
    }

    function readName(source, start) {
      let cursor = start;
      if (cursor >= source.length || !/[A-Za-z_]/.test(source[cursor])) return '';
      while (cursor < source.length && /[A-Za-z0-9_.:-]/.test(source[cursor])) cursor += 1;
      return source.slice(start, cursor);
    }

    function skipWhitespace(source, start) {
      let cursor = start;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      return cursor;
    }

    function decodeEntities(value, where) {
      let result = '';
      for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char !== '&') {
          result += char;
          continue;
        }
        const semicolon = value.indexOf(';', index + 1);
        if (semicolon === -1) fail('unterminated entity in ' + where);
        const body = value.slice(index + 1, semicolon);
        if (body === '') fail('empty entity in ' + where);
        if (body.length > 12) fail('unknown entity &' + body + '; in ' + where);
        if (body[0] === '#') {
          const hex = body[1] === 'x' || body[1] === 'X';
          const digits = body.slice(hex ? 2 : 1);
          if (digits === '' || !(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) {
            fail('invalid numeric entity &' + body + '; in ' + where);
          }
          const codePoint = Number.parseInt(digits, hex ? 16 : 10);
          if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
            fail('invalid code point in entity &' + body + '; in ' + where);
          }
          result += String.fromCodePoint(codePoint);
        } else if (body === 'amp') result += '&';
        else if (body === 'lt') result += '<';
        else if (body === 'gt') result += '>';
        else if (body === 'quot') result += '"';
        else if (body === 'apos') result += "'";
        else fail('unknown entity &' + body + '; in ' + where);
        index = semicolon;
      }
      return result;
    }

    function checkCharacters(value, where) {
      for (const char of value) {
        const code = char.codePointAt(0);
        if (code === 0 || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
          fail('control character in ' + where);
        }
      }
    }

    function allowedParent(name, parent) {
      if (parent === 'svg') {
        return ['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'defs'].includes(name);
      }
      if (parent === 'g') {
        return ['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text'].includes(name);
      }
      if (parent === 'text') return name === 'tspan';
      if (parent === 'tspan') return name === 'tspan';
      if (parent === 'defs') return name === 'linearGradient' || name === 'radialGradient';
      if (parent === 'linearGradient' || parent === 'radialGradient') return name === 'stop';
      return false;
    }

    function validateRoot(node) {
      if (node.name !== 'svg') fail('the root element must be <svg>');
      if (!Object.prototype.hasOwnProperty.call(node.attrs, 'viewBox')) {
        fail('<svg> must have a viewBox attribute, for example viewBox="0 0 720 320"');
      }
    }

    function validateTree(node) {
      if (node.type === 'text') return;
      const allowed = ALLOWED.get(node.name);
      for (const key of Object.keys(node.attrs)) {
        if (/^on/i.test(key)) fail('event handler attribute "' + key + '" is not allowed');
        if (FORBIDDEN_ATTRIBUTES.has(key)) fail('attribute "' + key + '" is not allowed');
        if (key === 'id') {
          validateAttribute(node.name, key, node.attrs[key], node);
          continue;
        }
        if (!allowed.has(key)) {
          delete node.attrs[key];
          continue;
        }
        if (key === 'xmlns' && node.name !== 'svg') {
          delete node.attrs[key];
          continue;
        }
        const value = node.attrs[key];
        validateAttribute(node.name, key, value, node);
      }
      for (const child of node.children) validateTree(child);
    }

    function validateAttribute(element, key, value, node) {
      const trimmed = value.trim();
      if (trimmed === '') fail('attribute "' + key + '" on <' + element + '> is empty');
      if (key === 'id') {
        if (!ID_PATTERN.test(trimmed)) {
          fail('id "' + trimmed + '" must match [a-z][a-z0-9-]{0,31}');
        }
        return;
      }
      if (key === 'viewBox') {
        const parts = trimmed.split(/[\s,]+/);
        if (parts.length !== 4 || !parts.every((part) => NUMBER.test(part))) {
          fail('viewBox must contain four numbers');
        }
        const values = parts.map(Number);
        if (!values.every(Number.isFinite) || Math.abs(values[0]) > 1e6 || Math.abs(values[1]) > 1e6) {
          fail('viewBox numbers are out of range');
        }
        if (values[2] <= 0 || values[3] <= 0) fail('viewBox width and height must be positive');
        return;
      }
      if (key === 'xmlns') {
        if (trimmed !== SVG_NS) fail('xmlns must be ' + SVG_NS);
        return;
      }
      if (key === 'd') {
        if (trimmed.length > LIMITS.maxPath) fail('path data exceeds ' + LIMITS.maxPath + ' characters');
        if (!PATH_DATA.test(trimmed)) fail('path data contains unsupported characters');
        return;
      }
      if (key === 'points') {
        if (trimmed.length > LIMITS.maxPoints) fail('points exceed ' + LIMITS.maxPoints + ' characters');
        if (!POINT_DATA.test(trimmed)) fail('points contain unsupported characters');
        if (trimmed.split(/[\s,]+/).filter(Boolean).length < 2) fail('points must contain at least one coordinate pair');
        return;
      }
      if (key === 'transform') {
        if (trimmed.length > 512 || !TRANSFORM.test(trimmed)) fail('transform contains an unsupported function');
        return;
      }
      if (key === 'fill' || key === 'stroke' || key === 'stop-color') {
        validatePaint(element, key, trimmed);
        return;
      }
      if (key === 'fill-opacity' || key === 'stroke-opacity' || key === 'opacity' || key === 'stop-opacity') {
        const percentage = /^([0-9]+(?:\.[0-9]+)?)%$/.exec(trimmed);
        const numeric = NUMBER.test(trimmed) ? Number(trimmed) : undefined;
        const valueNumber = percentage ? Number(percentage[1]) / 100 : numeric;
        if (valueNumber === undefined || !Number.isFinite(valueNumber) || valueNumber < 0 || valueNumber > 1) {
          fail('attribute "' + key + '" on <' + element + '> must be between 0 and 1');
        }
        return;
      }
      if (key === 'font-size') {
        const match = /^([0-9]+(?:\.[0-9]+)?)(?:px)?$/.exec(trimmed);
        if (!match || Number(match[1]) < 6 || Number(match[1]) > 200) {
          fail('font-size on <' + element + '> must be a number between 6 and 200');
        }
        return;
      }
      if (key === 'font-weight') {
        if (!/^(?:normal|bold|[1-9]00)$/.test(trimmed)) fail('font-weight on <' + element + '> must be normal, bold, or 100-900');
        return;
      }
      if (key === 'text-anchor') {
        if (!/^(?:start|middle|end)$/.test(trimmed)) fail('text-anchor must be start, middle, or end');
        return;
      }
      if (key === 'dominant-baseline') {
        if (!/^(?:auto|middle|central|hanging|text-before-edge|alphabetic|ideographic|mathematical)$/.test(trimmed)) {
          fail('dominant-baseline has an unsupported value');
        }
        return;
      }
      if (key === 'stroke-linecap') {
        if (!/^(?:butt|round|square)$/.test(trimmed)) fail('stroke-linecap must be butt, round, or square');
        return;
      }
      if (key === 'stroke-linejoin') {
        if (!/^(?:miter|round|bevel)$/.test(trimmed)) fail('stroke-linejoin must be miter, round, or bevel');
        return;
      }
      if (key === 'fill-rule') {
        if (!/^(?:nonzero|evenodd)$/.test(trimmed)) fail('fill-rule must be nonzero or evenodd');
        return;
      }
      if (key === 'gradientUnits') {
        if (!/^(?:objectBoundingBox|userSpaceOnUse)$/.test(trimmed)) fail('gradientUnits has an unsupported value');
        return;
      }
      if (key === 'offset') {
        if (/^[0-9]+(?:\.[0-9]+)?%$/.test(trimmed)) {
          if (Number(trimmed.slice(0, -1)) > 100) fail('gradient stop offset must be between 0% and 100%');
          return;
        }
        if (NUMBER.test(trimmed) && Number(trimmed) >= 0 && Number(trimmed) <= 1) return;
        fail('gradient stop offset must be between 0 and 1 or 0% and 100%');
      }
      if (key === 'width' || key === 'height' || key === 'rx' || key === 'ry' || key === 'r') {
        if (!LENGTH.test(trimmed)) fail('attribute "' + key + '" on <' + element + '> must be a length');
        return;
      }
      if (key === 'x' || key === 'y' || key === 'x1' || key === 'y1' || key === 'x2' || key === 'y2' || key === 'cx' || key === 'cy' || key === 'fx' || key === 'fy' || key === 'dx' || key === 'dy') {
        if (!NUMBER_LIST.test(trimmed) || trimmed.length > 128) {
          fail('attribute "' + key + '" on <' + element + '> must be a coordinate or coordinate list');
        }
        return;
      }
      if (key === 'stroke-width') {
        if (!LENGTH.test(trimmed)) fail('stroke-width must be a length');
        return;
      }
      fail('attribute "' + key + '" is not supported');
    }

    function validatePaint(element, key, value) {
      const reference = URL_PAINT.exec(value);
      if (reference !== null) {
        // Existence is checked after every id has been collected.
        return;
      }
      if (/^url\(/i.test(value)) fail('paint url() on <' + element + '> must be a local fragment: url(#id)');
      if (COLOR_HEX.test(value) || COLOR_FUNCTION.test(value)) return;
      if (COLOR_NAME.test(value)) {
        if (/^(?:url|expression|javascript)$/i.test(value)) fail('paint value "' + value + '" is not allowed');
        return;
      }
      fail('paint value "' + value + '" on <' + element + '> is not a color or url(#id)');
    }

    function collectIds(node) {
      const ids = new Set();
      if (node.type === 'text') return ids;
      if (Object.prototype.hasOwnProperty.call(node.attrs, 'id')) {
        const id = node.attrs.id.trim();
        if (ids.has(id)) fail('duplicate id "' + id + '"');
        ids.add(id);
      }
      for (const child of node.children) {
        for (const id of collectIds(child)) {
          if (ids.has(id)) fail('duplicate id "' + id + '"');
          ids.add(id);
        }
      }
      return ids;
    }

    function rewriteTree(node, prefix, ids) {
      if (node.type === 'text') return { type: 'text', value: node.value };
      const attrs = Object.create(null);
      for (const key of Object.keys(node.attrs)) {
        const value = node.attrs[key];
        if (key === 'id') attrs.id = prefix + '-' + value.trim();
        else if (key === 'fill' || key === 'stroke' || key === 'stop-color') attrs[key] = rewritePaint(value, prefix, ids, node.name);
        else attrs[key] = value;
      }
      const children = node.children.map((child) => rewriteTree(child, prefix, ids));
      return { type: 'element', name: node.name, attrs, children };
    }

    function rewritePaint(value, prefix, ids, element) {
      const reference = URL_PAINT.exec(value);
      if (reference === null) return value;
      const id = reference[1];
      if (!ids.has(id)) fail('<' + element + '> references undefined id #' + id);
      return 'url(#' + prefix + '-' + id + ')';
    }


    const NS = 'dsh-visualizer';
    const SLOT = 'tool.call.toolview';
    const TOOL = 'show_visual';
    const TAGS = {
      svg: 'svg',
      g: 'g',
      path: 'path',
      rect: 'rect',
      circle: 'circle',
      ellipse: 'ellipse',
      line: 'line',
      polyline: 'polyline',
      polygon: 'polygon',
      text: 'text',
      tspan: 'tspan',
      defs: 'defs',
      linearGradient: 'linearGradient',
      radialGradient: 'radialGradient',
      stop: 'stop',
    };

    const zh = {
      untitled: '可视化',
      badge: 'SVG',
      drawing: '正在绘图…',
      progress: '已接收',
      failed: '这张图没有渲染',
      failedHint: '模型可以修改 SVG 后重试。',
      noPayload: '没有收到 SVG 内容。',
      notRendered: '这张图未被接受，因此没有显示。',
      boundary: '这张图无法显示。',
    };
    const en = {
      untitled: 'Visual',
      badge: 'SVG',
      drawing: 'Drawing…',
      progress: 'Received',
      failed: 'This visual did not render',
      failedHint: 'The model can fix the SVG and try again.',
      noPayload: 'No SVG payload was received.',
      notRendered: 'This visual was rejected, so it was not shown.',
      boundary: 'This visual could not be displayed.',
    };

    const CSS = [
      '.dsv-card{display:flex;flex-direction:column;margin:6px 0;border:.5px solid var(--dsw-alias-border-l1);',
      'border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}',
      '.dsv-head{display:flex;align-items:center;gap:8px;padding:10px 12px 0;color:var(--dsw-alias-label-primary);',
      'font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px}',
      '.dsv-mark{flex:none;display:inline-flex;color:var(--dsw-alias-label-caption)}',
      '.dsv-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}',
      '.dsv-kind{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;',
      'letter-spacing:.02em}',
      '.dsv-canvas{margin:8px 12px 0;padding:8px;background:#fff;border:.5px solid var(--dsw-alias-border-l1);',
      'border-radius:var(--dsw-radius-md,8px);overflow:hidden}',
      '.dsv-svg{display:block;width:100%;height:auto;font-family:inherit}',
      '.dsv-caption{padding:8px 12px 10px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;',
      'overflow-wrap:anywhere}',
      '.dsv-skeleton{position:relative;display:flex;flex-direction:column;justify-content:flex-end;gap:8px;',
      'min-height:180px;padding:16px;background:#fff;border-radius:inherit;overflow:hidden}',
      '.dsv-skeleton::before{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 20%,',
      'rgba(31,35,40,.055) 45%,transparent 70%);animation:dsv-sweep 1.5s ease-in-out infinite}',
      '.dsv-skel-line{height:10px;border-radius:5px;background:#eef1f4}',
      '.dsv-skel-line[data-w="80"]{width:80%}.dsv-skel-line[data-w="55"]{width:55%}.dsv-skel-line[data-w="35"]{width:35%}',
      '.dsv-loading{position:relative;color:#57606a;font-size:12px;line-height:18px}',
      '.dsv-progress{position:relative;color:#8b949e;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}',
      '@keyframes dsv-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}',
      '@media (prefers-reduced-motion:reduce){.dsv-skeleton::before{animation:none}}',
      '.dsv-error{display:flex;flex-direction:column;gap:2px;margin:8px 12px 10px;padding:10px 12px;',
      'border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md,8px);',
      'background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 7%,transparent)}',
      '.dsv-error-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-weight:600}',
      '.dsv-error-body{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.dsv-error-hint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}',
    ].join('');

    /** Read one string argument; a streaming view answers a prefix and never throws. */
    function readText(args, key) {
      try {
        const value = args && typeof args.text === 'function' ? args.text(key) : undefined;
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
      } catch (error) {
        return null;
      }
    }

    /** Read a closed array argument; open arguments are not available by contract. */
    function readArray(args, key) {
      try {
        if (args && typeof args.complete === 'function' && !args.complete(key)) return null;
        const value = args && typeof args.value === 'function' ? args.value(key) : undefined;
        return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '') : null;
      } catch (error) {
        return null;
      }
    }

    /** Report the lazy-reader surface once per page, and expose it for a DOM probe. */
    let probed = false;
    let probeInfo = '';
    function probeArgs(args) {
      if (probed) return probeInfo;
      probed = true;
      try {
        const keys = args ? Object.keys(args).join(',') : '';
        probeInfo = 'keys:' + keys + ' text:' + typeof (args && args.text) +
          ' value:' + typeof (args && args.value) + ' complete:' + typeof (args && args.complete) +
          ' stringLength:' + typeof (args && args.stringLength);
        console.info('[dsh-visualizer] toolview args', probeInfo);
      } catch (error) {
        probeInfo = 'keys:unreadable';
      }
      return probeInfo;
    }

    /** Byte progress in the preparing phase, when the reader exposes a length. */
    function readProgress(args) {
      try {
        const length = args && typeof args.stringLength === 'function' ? args.stringLength('svg') : undefined;
        return typeof length === 'number' && length > 0 ? Math.ceil(length / 1024) : null;
      } catch (error) {
        return null;
      }
    }

    let fallbackIds = 0;
    function useFallbackId() {
      return React.useMemo(function () {
        fallbackIds += 1;
        return 'v' + fallbackIds;
      }, []);
    }
    const useId = typeof React.useId === 'function' ? React.useId : useFallbackId;

    function renderNode(node, key) {
      if (node.type === 'text') return node.value;
      const props = { key: key };
      for (const name of Object.keys(node.attrs)) props[name] = node.attrs[name];
      const children = node.children.map((child, index) => renderNode(child, key + '-' + index));
      return children.length === 0 ? h(TAGS[node.name], props) : h(TAGS[node.name], props, children);
    }

    function renderSvg(root, title, ratio) {
      const props = {
        viewBox: root.attrs.viewBox,
        role: 'img',
        'aria-label': title,
        preserveAspectRatio: 'xMidYMid meet',
        className: 'dsv-svg',
        style: { display: 'block', width: '100%', height: 'auto', aspectRatio: ratio },
      };
      for (const name of Object.keys(root.attrs)) {
        if (name === 'viewBox' || name === 'width' || name === 'height' || name === 'xmlns') continue;
        props[name] = root.attrs[name];
      }
      const children = root.children.map((child, index) => renderNode(child, 'r' + index));
      return children.length === 0 ? h('svg', props) : h('svg', props, children);
    }

    function viewBoxRatio(viewBox) {
      const parts = String(viewBox).trim().split(/[\s,]+/).map(Number);
      if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2] <= 0 || parts[3] <= 0) return '16 / 9';
      return parts[2] + ' / ' + parts[3];
    }

    function VisualCard(props) {
      const t = props.fallbackT;
      const args = props.block && props.block.args;
      const phase = props.phase;
      const title = (readText(args, 'title') || t('untitled')).slice(0, 80);
      const caption = readText(args, 'caption');
      const namespace = String(useId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'v';
      const probe = probeArgs(args);
      const failed = phase === 'result' && Boolean(props.block && props.block.isError);

      let body;
      let state;
      if (phase !== 'result') {
        state = 'loading';
        const lines = readArray(args, 'loading');
        const loading = lines && lines.length > 0 ? lines[0].slice(0, 80) : t('drawing');
        const progress = readProgress(args);
        body = h(
          'div',
          { className: 'dsv-skeleton', 'aria-busy': 'true' },
          h('div', { className: 'dsv-skel-line', 'data-w': '80' }),
          h('div', { className: 'dsv-skel-line', 'data-w': '55' }),
          h('div', { className: 'dsv-skel-line', 'data-w': '35' }),
          h('div', { className: 'dsv-loading' }, loading),
          progress === null ? null : h('div', { className: 'dsv-progress' }, t('progress') + ' ' + progress + ' KB'),
        );
      } else if (failed) {
        state = 'error';
        const svg = readText(args, 'svg');
        let reason = t('notRendered');
        if (svg !== null) {
          try {
            normalizeSvg(svg, namespace);
          } catch (error) {
            reason = error && error.message ? error.message : String(error);
          }
        }
        body = errorBlock(t, reason);
      } else {
        const svg = readText(args, 'svg');
        if (svg === null) {
          state = 'error';
          body = errorBlock(t, t('noPayload'));
        } else {
          try {
            const normalized = normalizeSvg(svg, namespace);
            state = 'ready';
            body = renderSvg(normalized.root, title, viewBoxRatio(normalized.root.attrs.viewBox));
          } catch (error) {
            state = 'error';
            body = errorBlock(t, error && error.message ? error.message : String(error));
          }
        }
      }

      return h(
        'figure',
        {
          className: 'dsv-card',
          'data-tool': TOOL,
          'data-state': state,
          'data-phase': phase,
          'data-dsv-args': probe,
          style: { margin: '6px 0' },
        },
        h(
          'div',
          { className: 'dsv-head' },
          h(
            'span',
            { className: 'dsv-mark', 'aria-hidden': true },
            h(
              'svg',
              { viewBox: '0 0 16 16', width: 14, height: 14, focusable: 'false' },
              h('rect', { x: 1.5, y: 1.5, width: 13, height: 13, rx: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2 }),
              h('path', { d: 'M4.5 9.5 7 6.8l2.1 1.9L11.8 5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
            ),
          ),
          h('span', { className: 'dsv-title', title: title }, title),
          h('span', { className: 'dsv-kind' }, t('badge')),
        ),
        h('div', { className: 'dsv-canvas' }, body),
        caption === null ? null : h('figcaption', { className: 'dsv-caption' }, caption.slice(0, 200)),
      );
    }

    function errorBlock(t, reason) {
      return h(
        'div',
        { className: 'dsv-error', role: 'alert' },
        h('div', { className: 'dsv-error-title' }, t('failed')),
        h('div', { className: 'dsv-error-body' }, String(reason).slice(0, 300)),
        h('div', { className: 'dsv-error-hint' }, t('failedHint')),
      );
    }

    /** Keeps one broken card from blanking the whole slot entry. */
    class VisualBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.error('[dsh-visualizer] visual card failed:', error);
      }

      render() {
        if (this.state.failed) {
          return h('div', { className: 'dsv-card', 'data-tool': TOOL, 'data-state': 'error' },
            h('div', { className: 'dsv-error', role: 'alert' },
              h('div', { className: 'dsv-error-title' }, this.props.fallback),
              h('div', { className: 'dsv-error-body' }, this.props.fallbackHint)));
        }
        return this.props.children;
      }
    }

    /** Install the card stylesheet once and drop it again on teardown. */
    function installStyles() {
      const tagId = 'dsh-visualizer/card';
      if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css="' + tagId + '"]')) {
        return function () {};
      }
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-visualizer';
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.append(tag);
      return function () {
        tag.remove();
      };
    }

    return {
      name: 'visualizer',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        }, 'dsh-visualizer: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.effect(installStyles, 'dsh-visualizer: card styles');

        const VisualRow = function VisualRow(props) {
          return h(
            VisualBoundary,
            { fallback: t('boundary'), fallbackHint: t('failedHint') },
            h(VisualCard, Object.assign({}, props, { fallbackT: t })),
          );
        };

        ctx.effect(function () {
          return ctx.slots.inject(SLOT, function () {
            return ctx.slots.register(
              { name: SLOT, key: TOOL, locale: NS },
              VisualRow,
            );
          });
        }, 'dsh-visualizer: visual row');
      },
    };
  },
});
