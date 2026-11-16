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

    /*__NORMALIZE__*/

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
