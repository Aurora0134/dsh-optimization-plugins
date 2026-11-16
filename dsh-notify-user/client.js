/**
 * Browser half of `dsh-notify-user`: the progress update row shown in the
 * conversation where a `notify_user` call appears.
 *
 * Host contract this file depends on (all read from the installed Harness):
 *  - `window.__ModuleLoader__.load({ id, factory })`; `id` must equal the
 *    package name so the boot row and this factory line up. The factory's
 *    `require` only reaches the frozen baseline module table; `react` is the
 *    single module used here.
 *  - `ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(...))`
 *    with `key: 'notify_user'` replaces the generic row for that wire tool
 *    name (owner contract: client-ui-tool `ToolCallOwnerProps`).
 *  - Owner props read here: `phase` ('preparing' | 'start' | 'result'),
 *    `block` (`block.time`, `block.isError`, and the lazy argument reader
 *    `block.args.text(key)`), `useDisclosure()`, plus the session-scope
 *    standard props `sessionId` and `useSessions` used for the source badge.
 *  - `ctx.locale.register(ns, { zh, en })` / `ctx.locale.bind(ns)`; the
 *    registration's `locale` option supplies the re-rendering `t` seat.
 *
 * No Harness Client package is imported: primitives change without notice and
 * a throwing component blanks the whole slot entry, so the row, its Markdown
 * subset and its styles are self-contained. Every piece of text is a React
 * child (never HTML), so model-supplied content cannot inject markup.
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify-user',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROW_NAME = 'notify-user';
    const SLOT = 'tool.call.toolview';
    const TOOL_NAME = 'notify_user';
    const NS = 'dsh-notify-user';
    /** Body lines before the row folds; matches the six-row reading column. */
    const FOLD_AFTER_LINES = 6;
    /** Approximate characters per rendered line in the narrow conversation column. */
    const COLUMN_CHARS = 38;

    const zh = {
      title: '进度更新',
      'status.posting': '发布中',
      'badge.subagent': '子 agent',
      'action.expand': '展开全文',
      'action.collapse': '收起'
    };
    const en = {
      title: 'Progress update',
      'status.posting': 'Posting',
      'badge.subagent': 'Subagent',
      'action.expand': 'Show more',
      'action.collapse': 'Show less'
    };

    const CSS = [
      '.dnu-card{display:flex;flex-direction:column;gap:2px;margin:2px 0}',
      '.dnu-head{display:flex;align-items:center;gap:8px;min-height:calc(24px + var(--dsh-content-font-delta,0px));',
      'font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary);',
      'line-height:calc(24px + var(--dsh-content-font-delta,0px))}',
      '.dnu-led{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-business-primary);',
      'box-shadow:0 0 0 3px color-mix(in oklab,var(--dsw-alias-state-business-primary) 22%,transparent)}',
      '.dnu-led[data-state="running"]{animation:dnu-breathe 1.6s ease-in-out infinite}',
      '.dnu-led[data-state="error"]{background:var(--dsw-alias-state-error-primary);',
      'box-shadow:0 0 0 3px color-mix(in oklab,var(--dsw-alias-state-error-primary) 22%,transparent)}',
      '@keyframes dnu-breathe{0%,100%{opacity:1}50%{opacity:.45}}',
      '@media (prefers-reduced-motion:reduce){.dnu-led[data-state="running"]{animation:none}}',
      '.dnu-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.dnu-note{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}',
      '.dnu-badge{flex:none;padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.dnu-time{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;',
      'font-variant-numeric:tabular-nums}',
      '.dnu-body{margin:2px 0 4px 15px;color:var(--dsw-alias-label-secondary);',
      'font-size:var(--dsh-content-font-size-secondary,13px);',
      'line-height:calc(20px + var(--dsh-content-font-delta,0px));overflow-wrap:anywhere}',
      '.dnu-p{margin:0 0 6px}.dnu-p:last-child{margin-bottom:0}',
      '.dnu-list{margin:0 0 6px;padding-left:18px}.dnu-list>li{margin:2px 0}',
      '.dnu-body strong{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dnu-code{padding:1px 4px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-markdown-inline-code);',
      'color:var(--dsw-alias-label-primary)}',
      '.dnu-pre{margin:6px 0;padding:8px 10px;border-radius:var(--dsw-radius-md);',
      'border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);',
      'font:var(--dsw-font-markdown-code-block-small);white-space:pre;overflow-x:auto}',
      '.dnu-more{align-self:flex-start;margin-left:15px;padding:0;border:0;background:none;',
      'color:var(--dsw-alias-link);font:inherit;font-size:12px;line-height:20px;cursor:pointer}',
      '@media (hover:hover){.dnu-more:hover{text-decoration:underline}}',
      '.dnu-more:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;',
      'border-radius:var(--dsw-radius-xs)}'
    ].join('');

    /** Read one string argument; streaming views answer a prefix and never throw. */
    function readText(block, key) {
      try {
        const args = block ? block.args : undefined;
        const value = args && typeof args.text === 'function' ? args.text(key) : undefined;
        return typeof value === 'string' && value.trim() !== '' ? value : null;
      } catch (error) {
        return null;
      }
    }

    /**
     * One-line headline: the title's first line with a leading heading or
     * emphasis marker removed. Interior characters stay as written, so a title
     * such as "C# build is green" survives; the caller supplies the fallback.
     */
    function readTitle(block) {
      const raw = readText(block, 'title');
      if (raw === null) return null;
      let line = raw.replace(/\r\n?/g, '\n').split('\n')[0].trim();
      line = line.replace(/^#{1,6}\s+/, '').replace(/^>\s*/, '');
      if (/^\*\*[\s\S]+\*\*$/.test(line)) line = line.slice(2, -2).trim();
      if (/^`[\s\S]+`$/.test(line)) line = line.slice(1, -1).trim();
      return line === '' ? null : line;
    }

    /** The message body; the host field is `message`, `body` is accepted as an alias. */
    function readBody(block) {
      const raw = readText(block, 'message') || readText(block, 'body');
      if (raw === null) return null;
      const body = raw.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
      return body === '' ? null : body;
    }

    /** Local `HH:MM` of the block's timestamp, or null when the block carries none. */
    function readTime(block) {
      if (!block) return null;
      const at = typeof block.time === 'number' ? block.time : block.callTime;
      if (typeof at !== 'number' || !Number.isFinite(at)) return null;
      const date = new Date(at);
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    }

    /** Rendered line count estimate used only to decide the initial fold. */
    function estimateLines(text) {
      return text.split('\n').reduce(function (total, line) {
        return total + Math.max(1, Math.ceil(line.length / COLUMN_CHARS));
      }, 0);
    }

    /** Inline subset: `code` and **bold**; every other character stays literal text. */
    function inlineNodes(text) {
      const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
      const nodes = [];
      let cursor = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
        const token = match[0];
        const key = 'n' + nodes.length;
        if (token.charCodeAt(0) === 96) nodes.push(h('code', { className: 'dnu-code', key: key }, token.slice(1, -1)));
        else nodes.push(h('strong', { key: key }, token.slice(2, -2)));
        cursor = match.index + token.length;
      }
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes;
    }

    /** Block subset: fenced code, unordered lists and paragraphs. */
    function blockNodes(text) {
      const lines = text.split('\n');
      const nodes = [];
      let index = 0;
      while (index < lines.length) {
        const key = 'b' + index;
        if (/^\s*```/.test(lines[index])) {
          const code = [];
          index += 1;
          while (index < lines.length && !/^\s*```/.test(lines[index])) {
            code.push(lines[index]);
            index += 1;
          }
          index += 1;
          nodes.push(h('pre', { className: 'dnu-pre', key: key }, h('code', null, code.join('\n'))));
          continue;
        }
        if (/^\s*[-*+]\s+/.test(lines[index])) {
          const items = [];
          while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
            const itemKey = 'i' + index;
            items.push(h('li', { key: itemKey }, inlineNodes(lines[index].replace(/^\s*[-*+]\s+/, ''))));
            index += 1;
          }
          nodes.push(h('ul', { className: 'dnu-list', key: key }, items));
          continue;
        }
        if (lines[index].trim() === '') {
          index += 1;
          continue;
        }
        const paragraph = [];
        while (
          index < lines.length &&
          lines[index].trim() !== '' &&
          !/^\s*```/.test(lines[index]) &&
          !/^\s*[-*+]\s+/.test(lines[index])
        ) {
          paragraph.push(lines[index]);
          index += 1;
        }
        nodes.push(h('p', { className: 'dnu-p', key: key }, inlineNodes(paragraph.join('\n'))));
      }
      return nodes;
    }

    /** Selector used when a composition offers no session catalog; it never reads. */
    function useNoCatalog() {
      return false;
    }

    /**
     * Source badge: the bound session's catalog row says `origin === 'subagent'`.
     * Absent or unknown data omits the badge rather than guessing. The hook
     * identity is picked from the props, which are fixed for a registration.
     */
    function useSubagentOrigin(props) {
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : useNoCatalog;
      const sessionId = props.sessionId;
      return Boolean(
        useSessions(function (list) {
          if (typeof sessionId !== 'string' || !list || !list.byId) return false;
          const row = list.byId[sessionId];
          return row !== undefined && row.origin === 'subagent';
        })
      );
    }

    /** Keeps a broken row from taking the slot entry down with it. */
    class NotifyBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.error('[dsh-notify-user] progress row failed:', error);
      }

      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    /** One progress update: dot, headline, time, and the message behind it. */
    function NotifyCard(props) {
      const t = typeof props.t === 'function' ? props.t : typeof props.fallbackT === 'function' ? props.fallbackT : function (key) { return key; };
      const block = props.block;
      const disclosure = props.useDisclosure();
      const expanded = Boolean(disclosure && disclosure.expanded);
      const toggle = disclosure && typeof disclosure.toggle === 'function' ? disclosure.toggle : function () {};

      const title = readTitle(block) || t('title');
      const body = readBody(block);
      const time = readTime(block);
      const running = props.phase === 'preparing' || props.phase === 'start';
      const failed = props.phase === 'result' && Boolean(block && block.isError);
      const state = failed ? 'error' : running ? 'running' : 'ok';
      const folded = body !== null && estimateLines(body) > FOLD_AFTER_LINES;
      const showBody = body !== null && (!folded || expanded);
      const subagent = useSubagentOrigin(props);

      return h(
        'div',
        { className: 'dnu-card', 'data-tool': TOOL_NAME, 'data-state': state, 'data-phase': props.phase },
        h(
          'div',
          { className: 'dnu-head' },
          h('span', { className: 'dnu-led', 'data-state': state, 'aria-hidden': true }),
          h('span', { className: 'dnu-title', title: title }, title),
          running ? h('span', { className: 'dnu-note' }, t('status.posting')) : null,
          subagent ? h('span', { className: 'dnu-badge' }, t('badge.subagent')) : null,
          time === null ? null : h('span', { className: 'dnu-time' }, time)
        ),
        showBody ? h('div', { className: 'dnu-body' }, blockNodes(body)) : null,
        folded
          ? h(
              'button',
              {
                type: 'button',
                className: 'dnu-more',
                'aria-expanded': expanded,
                onClick: toggle
              },
              t(expanded ? 'action.collapse' : 'action.expand')
            )
          : null
      );
    }

    /** Install the row stylesheet once and drop it again on teardown. */
    function installStyles() {
      const tagId = 'dsh-notify-user/progress-row';
      if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css="' + tagId + '"]')) {
        return function () {};
      }
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-notify-user';
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.append(tag);
      return function () {
        tag.remove();
      };
    }

    return {
      name: ROW_NAME,
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        }, 'dsh-notify-user: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.effect(installStyles, 'dsh-notify-user: progress row styles');

        const NotifyProgressRow = function NotifyProgressRow(props) {
          return h(
            NotifyBoundary,
            null,
            h(NotifyCard, Object.assign({}, props, { fallbackT: t }))
          );
        };

        ctx.effect(function () {
          return ctx.slots.inject(SLOT, function () {
            return ctx.slots.register(
              { name: SLOT, key: TOOL_NAME, locale: NS },
              NotifyProgressRow
            );
          });
        }, 'dsh-notify-user: progress row');
      }
    };
  }
});
