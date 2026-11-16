/**
 * Browser half of `dsh-session-rollback`.
 *
 * Three jobs, all owned by `apply`:
 *  - one action button inside every user message's icon row, added through a
 *    MutationObserver over the conversation flow (`[data-slot="conversation.chat.flow"]`);
 *  - one invisible `conversation.input.dock` entry that carries the Session's
 *    `inputActions` to the button logic, so the composer is never guessed from the DOM;
 *  - the same-origin calls the Host half registers, plus the confirm, the native
 *    Session fork, the switch to the child Session, the write-back and the
 *    failure report.
 *
 * Every listener, timer, observer, style and open dialog is released by the
 * disposer `apply` returns, so unloading the plugin leaves nothing behind.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-rollback',
  factory(require) {
    const React = require('react');

    const PLUGIN_ID = 'dsh-session-rollback';
    /**
     * Session-scoped dock both composer forms render.
     *
     * The composer dock (`conversation.composer.dock`) is rendered only by the
     * composer form a Session with conversation content shows. Rolling back a
     * Session's first message forks a child with no content, whose empty-Session
     * composer renders `conversation.input.dock` alone; a bridge mounted on the
     * composer dock would never publish that child's `inputActions`, and the
     * clicked message's text would have nowhere to go.
     */
    const DOCK_SLOT = 'conversation.input.dock';

    /** Flow outlet the Chat target renders every transcript row through. */
    const FLOW_SELECTOR = '[data-slot="conversation.chat.flow"]';
    /** Rows that hold a human message: a ready user message and an admitted steering message. */
    const ROW_QUERY = `${FLOW_SELECTOR} [data-chat-flow-kind="user"], ${FLOW_SELECTOR} [data-chat-flow-kind="steering"]`;
    /** The click target's own row. */
    const ROW_CLOSEST = '[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]';
    /** Icon row every message chrome renders (copy / branch / clock). */
    const ACTIONS_QUERY = '[data-clock]';
    /** Copy target the icon row carries its message text on. */
    const BUBBLE_QUERY = '[data-message-bubble]';
    /** Region attribute that names the Session a rendered conversation belongs to. */
    const SESSION_ATTRIBUTE = 'data-conversation-session';
    /** Marker on the injected control, also the duplicate guard. */
    const ACTION_ATTRIBUTE = 'data-session-rollback-action';
    /** Marker while one rollback of this page is in flight. */
    const BUSY_ATTRIBUTE = 'data-session-rollback-busy';

    const STATE_ROUTE = '/session-rollback/state';
    const PREPARE_ROUTE = '/session-rollback/prepare';
    const RESTORE_ROUTE = '/session-rollback/restore';
    const RELEASE_ROUTE = '/session-rollback/release';
    const LABEL = '回退到此消息';

    const CSS = `
[${ACTION_ATTRIBUTE}] {
  box-sizing: border-box;
  display: inline-flex;
  flex: none;
  order: 1;
  align-items: center;
  justify-content: center;
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: none;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
[${ACTION_ATTRIBUTE}] svg {
  display: block;
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
}
@media (hover: hover) {
  [${ACTION_ATTRIBUTE}]:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
  }
}
[${ACTION_ATTRIBUTE}]:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
[${ACTION_ATTRIBUTE}][${BUSY_ATTRIBUTE}] {
  cursor: default;
  opacity: 0.5;
}
.dsr-scrim {
  box-sizing: border-box;
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--dsw-alias-bg-mask-1);
}
.dsr-dialog {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(460px, 100%);
  max-height: min(560px, 80vh);
  overflow-y: auto;
  padding: 20px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-panel);
  color: var(--dsw-alias-label-primary);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: 22px;
}
.dsr-dialog-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 24px;
}
.dsr-dialog-text {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
}
.dsr-dialog-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding-left: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsr-dialog-list li {
  word-break: break-word;
}
.dsr-dialog-note {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
}
.dsr-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.dsr-button {
  box-sizing: border-box;
  height: 32px;
  padding: 0 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover-solid);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}
@media (hover: hover) {
  .dsr-button:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.dsr-button-primary {
  border-color: var(--dsw-alias-button-primary-fill);
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
@media (hover: hover) {
  .dsr-button-primary:hover {
    background: var(--dsw-alias-button-primary-fill);
  }
}
.dsr-button:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
`;

    /* ------------------------------ composer handle ----------------------------- */

    /** Session id to the composer handle its dock entry published. */
    const composerHandles = new Map();

    /**
     * Publish one Session's composer face for the injected button.
     * @param {string} sessionId live Session id
     * @param {{ inputActions: object, read: () => { draft: string, attachments: number } }} handle
     * @returns {() => void} withdrawal
     */
    function publishComposerHandle(sessionId, handle) {
      composerHandles.set(sessionId, handle);
      return () => {
        if (composerHandles.get(sessionId) === handle) composerHandles.delete(sessionId);
      };
    }

    /**
     * @param {string} sessionId
     * @returns {{ inputActions: object, read: () => { draft: string, attachments: number } } | undefined}
     */
    function composerHandleOf(sessionId) {
      return composerHandles.get(sessionId);
    }

    /**
     * Wait for a Session's dock entry: the composer of the session the rollback
     * switched to mounts after the fork, so the write-back cannot happen at once.
     * @param {string} sessionId
     * @param {number} timeoutMs
     * @returns {Promise<{ inputActions: object, read: () => { draft: string, attachments: number } } | undefined>}
     */
    async function waitForComposerHandle(sessionId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const handle = composerHandleOf(sessionId);
        if (handle !== undefined) return handle;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return composerHandleOf(sessionId);
    }

    /**
     * One client service by name, without assuming the property exists.
     * @param {object} ctx plugin Context
     * @param {string} name service name
     * @returns {object | undefined}
     */
    function serviceOf(ctx, name) {
      try {
        const direct = ctx?.[name];
        if (direct !== undefined && direct !== null) return direct;
      } catch {
        // fall through to the registry lookup
      }
      try {
        return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
      } catch {
        return undefined;
      }
    }

    const selectDraft = (state) => state.draft;
    const selectAttachmentIds = (state) => state.attachmentIds;

    /**
     * Invisible session-scoped entry: hands this Session's input actions to the
     * button logic and keeps the live draft readable, so a write-back never
     * silently replaces text the user already typed.
     * @param {object} props standard Session props of the dock slot
     * @returns {null}
     */
    function ComposerBridge(props) {
      if (props === null || props === undefined) return null;
      if (typeof props.useInput !== 'function' || typeof props.inputActions !== 'object' || props.inputActions === null) return null;
      return React.createElement(ComposerBridgeBody, props);
    }

    /**
     * The hook body of {@link ComposerBridge}; always calls the same hooks.
     * @param {object} props standard Session props of the dock slot
     * @returns {null}
     */
    function ComposerBridgeBody(props) {
      const sessionId = props.sessionId;
      const inputActions = props.inputActions;
      const draft = props.useInput(selectDraft);
      const attachmentIds = props.useInput(selectAttachmentIds);
      const latest = React.useRef({ draft: '', attachments: 0 });
      latest.current = {
        draft: typeof draft === 'string' ? draft : '',
        attachments: Array.isArray(attachmentIds) ? attachmentIds.length : 0,
      };
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
        return publishComposerHandle(sessionId, {
          inputActions,
          read: () => latest.current,
        });
      }, [sessionId, inputActions]);
      return null;
    }

    /* ---------------------------------- dialogs --------------------------------- */

    /** Handler that closes an open dialog with a settled action id. */
    const openDialogs = new Set();
    let dialogSeq = 0;

    /**
     * Show one modal and resolve with the chosen action id.
     * @param {object} options
     * @param {string} options.title
     * @param {string[]} [options.paragraphs]
     * @param {string[]} [options.items]
     * @param {string[]} [options.notes]
     * @param {{ id: string, label: string, tone?: 'primary' }[]} options.actions
     * @param {boolean} [options.alert]
     * @returns {Promise<string>} the chosen action id, `'cancel'` when dismissed
     */
    function openDialog(options) {
      return new Promise((resolve) => {
        const titleId = `dsr-dialog-title-${++dialogSeq}`;
        const previousFocus = document.activeElement;

        const scrim = document.createElement('div');
        scrim.className = 'dsr-scrim';

        const card = document.createElement('div');
        card.className = 'dsr-dialog';
        card.setAttribute('role', options.alert === true ? 'alertdialog' : 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-labelledby', titleId);

        const title = document.createElement('h2');
        title.className = 'dsr-dialog-title';
        title.id = titleId;
        title.textContent = options.title;
        card.append(title);

        for (const paragraph of options.paragraphs ?? []) {
          const text = document.createElement('p');
          text.className = 'dsr-dialog-text';
          text.textContent = paragraph;
          card.append(text);
        }

        if (Array.isArray(options.items) && options.items.length > 0) {
          const list = document.createElement('ul');
          list.className = 'dsr-dialog-list';
          for (const item of options.items) {
            const entry = document.createElement('li');
            entry.textContent = item;
            list.append(entry);
          }
          card.append(list);
        }

        for (const note of options.notes ?? []) {
          const line = document.createElement('p');
          line.className = 'dsr-dialog-note';
          line.textContent = note;
          card.append(line);
        }

        const row = document.createElement('div');
        row.className = 'dsr-dialog-actions';
        const buttons = [];
        for (const action of options.actions) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = action.tone === 'primary' ? 'dsr-button dsr-button-primary' : 'dsr-button';
          button.textContent = action.label;
          button.addEventListener('click', () => settle(action.id));
          row.append(button);
          buttons.push(button);
        }
        card.append(row);
        scrim.append(card);

        /**
         * Tear the dialog down once and answer its caller.
         * @param {string} answer chosen action id
         */
        const settle = (answer) => {
          if (!openDialogs.has(settle)) return;
          openDialogs.delete(settle);
          document.removeEventListener('keydown', onKeyDown, true);
          scrim.remove();
          if (previousFocus !== null && typeof previousFocus.focus === 'function' && previousFocus.isConnected) {
            try {
              previousFocus.focus();
            } catch {
              /* the previous control is gone */
            }
          }
          resolve(answer);
        };

        /**
         * Escape dismisses, Tab stays inside the dialog.
         * @param {KeyboardEvent} event
         */
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            settle('cancel');
            return;
          }
          if (event.key !== 'Tab' || buttons.length === 0) return;
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
            return;
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        };

        scrim.addEventListener('mousedown', (event) => {
          if (event.target === scrim) settle('cancel');
        });
        document.addEventListener('keydown', onKeyDown, true);
        openDialogs.add(settle);
        document.body.append(scrim);
        (buttons[0] ?? card).focus();
      });
    }

    /** Dismiss every open dialog; used by the disposer. */
    function closeDialogs() {
      for (const settle of Array.from(openDialogs)) settle('cancel');
    }

    /* ----------------------------------- host api -------------------------------- */

    /** One refused or unreachable Host call, carrying only what the UI needs. */
    class RollbackFailure extends Error {
      /**
       * @param {string} code Host refusal code, or `network` / `unreadable`
       * @param {number} status HTTP status, 0 when the request never completed
       */
      constructor(code, status) {
        super(code);
        this.name = 'RollbackFailure';
        this.code = code;
        this.status = status;
      }
    }

    /** Refusal codes the two routes can answer with, in user-facing words. */
    const HTTP_TEXT = Object.freeze({
      forbidden: '当前页面没有权限调用回退，请重新打开 Harness 页面后再试。',
      unauthorized: '当前页面没有通过身份校验，请重新打开 Harness 页面后再试。',
      'unsupported-media-type': '请求没有被接受，请重试一次。',
      'bad-request': '请求没有被接受，请重试一次。',
      'payload-too-large': '请求内容过大，请重试一次。',
      'method-not-allowed': '请求没有被接受，请重试一次。',
      'internal-error': '服务没有完成这次操作，请稍后再试。',
    });

    /**
     * Parse a response body without trusting its shape.
     * @param {Response} response
     * @returns {Promise<object | undefined>}
     */
    async function readJson(response) {
      let text;
      try {
        text = await response.text();
      } catch {
        return undefined;
      }
      if (text.length === 0) return undefined;
      try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * POST one JSON request to a route this plugin's Host half owns.
     * @param {string} route
     * @param {object} body
     * @returns {Promise<object>}
     */
    async function postJson(route, body) {
      let response;
      try {
        response = await fetch(route, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
      } catch {
        throw new RollbackFailure('network', 0);
      }
      const payload = await readJson(response);
      if (!response.ok) {
        const code = typeof payload?.code === 'string' ? payload.code : `http-${response.status}`;
        throw new RollbackFailure(code, response.status);
      }
      if (payload === undefined) throw new RollbackFailure('unreadable', response.status);
      return payload;
    }

    /* ----------------------------------- copy ----------------------------------- */

    const STATE_TEXT = Object.freeze({
      'session-not-live': '这个会话已经不在运行中的 Harness 里，无法回退。',
      'turn-open': '当前回合还在进行中，等它结束后再回退。',
      'agent-busy': '当前回合还在进行中，等它结束后再回退。',
      'no-user-message': '这个会话里没有可以回退的用户消息。',
    });

    const ROLLBACK_TEXT = Object.freeze({
      'missing-session': '没有找到要回退的会话，回退没有执行。',
      'session-not-live': '这个会话已经不在运行中的 Harness 里，回退没有执行。',
      'rollback-in-progress': '这个会话已经有一次回退正在进行，等它结束后再试。',
      'turn-open': '当前回合还在进行中，回退没有执行，等它结束后再试。',
      'agent-busy': '当前回合还在进行中，回退没有执行，等它结束后再试。',
      'target-missing': '在会话里找不到这条消息，页面可能已经变化，请刷新后再试。',
      'internal-error': '服务没有完成这次操作，回退没有执行。',
      'file-restore-incomplete': '文件没有全部恢复。',
      'partial-snapshot': '这几轮的文件记录不完整，恢复结果可能不完整。',
    });

    /** The Host's per-file failure sentences, stated in the composer's own words. */
    const FILE_REASON_TEXT = Object.freeze([
      ['cannot resolve the path', '找不到这个路径'],
      ['cannot remove the file this turn created', '无法删除这几轮新建的该文件'],
      ['stored content is unreadable', '保存的内容读不出来'],
      ['cannot write the stored content', '无法写入恢复的内容'],
      ['snapshot index unreadable', '文件记录读不出来'],
    ]);

    /**
     * Turn one Host failure code into a sentence a user can act on.
     * @param {string} code
     * @returns {string}
     */
    function httpText(code) {
      return HTTP_TEXT[code] ?? '回退没有执行，服务没有完成这次操作。';
    }

    /**
     * @param {unknown} error
     * @returns {string}
     */
    function failureText(error) {
      if (error instanceof RollbackFailure) {
        return error.code === 'network'
          ? '回退没有执行：连不上本地 Harness 服务，请确认页面仍然连接。'
          : httpText(error.code);
      }
      return '回退没有执行，请稍后再试。';
    }

    /**
     * A per-file failure line: the path, then why it did not come back.
     * @param {{ path?: unknown, reason?: unknown }} entry
     * @returns {string}
     */
    function fileFailureLine(entry) {
      const raw = typeof entry?.reason === 'string' ? entry.reason : '';
      const known = FILE_REASON_TEXT.find(([prefix]) => raw.startsWith(prefix));
      const reason = known === undefined ? '恢复失败' : known[1];
      const path = typeof entry?.path === 'string' ? entry.path : '';
      return path === '' ? reason : `${path} —— ${reason}`;
    }

    /**
     * @param {object} result rollback report
     * @returns {string[]} one line per turn whose snapshot is incomplete
     */
    function incompleteTurnLines(result) {
      const turns = Array.isArray(result.incompleteTurns) ? result.incompleteTurns : [];
      const numbers = [];
      for (const entry of turns) {
        const turn = entry !== null && typeof entry === 'object' ? entry.turn : undefined;
        if (typeof turn === 'number' && Number.isSafeInteger(turn) && !numbers.includes(turn)) numbers.push(turn);
      }
      if (numbers.length === 0) return [];
      return [`第 ${numbers.join('、')} 轮的文件没有完整记录，这些轮次里的文件可能没有恢复。`];
    }

    /* ------------------------------- target resolution --------------------------- */

    /**
     * Collapse whitespace the way the Host preview does.
     * @param {unknown} value
     * @returns {string}
     */
    function normalizeText(value) {
      return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    }

    /**
     * @param {Element} row one message row
     * @returns {string} its bubble text, normalized
     */
    function bubbleTextOf(row) {
      const bubble = row.querySelector(BUBBLE_QUERY);
      return normalizeText(bubble === null ? '' : bubble.textContent);
    }

    /**
     * The Host lists every `user/message` on the surface; the flow renders the
     * human ones as ready or steering rows, in the same order.
     * @param {object} state `/session-rollback/state` answer
     * @returns {object[]}
     */
    function humanMessagesOf(state) {
      const rows = Array.isArray(state.userMessages) ? state.userMessages : [];
      // The Host already lists only the surface's human prompts.
      return rows.filter((row) => row !== null && typeof row === 'object');
    }

    /**
     * @param {string} text normalized bubble text
     * @param {unknown} preview Host preview
     * @returns {boolean}
     */
    function previewMatches(text, preview) {
      const candidate = normalizeText(preview);
      if (text.length === 0 || candidate.length === 0) return false;
      return candidate === text || candidate.startsWith(text) || text.startsWith(candidate);
    }

    /**
     * Map the clicked row to one entry of the Host's user-message list.
     *
     * The flow renders exactly the surface the Host folds, in the same order, so
     * equal lengths make the row index the answer. A paged or still-settling
     * transcript can hold fewer rows, and then only one unambiguous text match
     * is accepted — never a guess, because the click removes conversation.
     * @param {object} state `/session-rollback/state` answer
     * @param {Element[]} rows human rows currently rendered, in order
     * @param {Element} row the clicked row
     * @returns {object | null}
     */
    function resolveTargetMessage(state, rows, row) {
      const messages = humanMessagesOf(state);
      if (messages.length === 0) return null;
      const index = rows.indexOf(row);
      if (messages.length === rows.length && index >= 0) return messages[index];
      const text = bubbleTextOf(row);
      if (text.length === 0) return null;
      const matches = messages.filter((candidate) => previewMatches(text, candidate.preview));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        const turn = row.getAttribute('data-chat-turn');
        const narrowed = matches.filter((candidate) => (
          typeof candidate.turn !== 'number' || turn === null || String(candidate.turn) === turn
        ));
        if (narrowed.length === 1) return narrowed[0];
      }
      return null;
    }

    /* ----------------------------------- flow ----------------------------------- */

    /** One rollback owns the page's buttons at a time. */
    let rollbackInFlight = false;

    /**
     * @param {Element} element
     * @returns {string} the Session whose conversation holds this element
     */
    function sessionIdOf(element) {
      const host = element.closest(`[${SESSION_ATTRIBUTE}]`);
      if (host === null) return '';
      const value = host.getAttribute(SESSION_ATTRIBUTE);
      return typeof value === 'string' ? value : '';
    }

    /**
     * @param {Element} row one human message row
     * @returns {Element[]} the rendered human rows before and including it
     */
    function humanRowsAround(row) {
      const flow = row.closest(FLOW_SELECTOR);
      const scope = flow === null ? document : flow;
      return Array.from(scope.querySelectorAll('[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]'));
    }

    /**
     * @param {Element} row
     * @returns {Element | null} the icon row the copy control sits in
     */
    function actionsRowOf(row) {
      const clock = row.querySelector(ACTIONS_QUERY);
      if (clock !== null) return clock;
      const button = row.querySelector('button[aria-label]');
      return button === null ? null : button.parentElement;
    }

    /**
     * Build the rewind glyph; stroke and sizing follow the native icon rows.
     * @returns {SVGElement}
     */
    function createGlyph() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      arc.setAttribute('d', 'M3.6 6.6h5.1a3.1 3.1 0 0 1 0 6.2H5.4');
      arc.setAttribute('stroke', 'currentColor');
      arc.setAttribute('stroke-width', '1.4');
      arc.setAttribute('stroke-linecap', 'round');
      const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      head.setAttribute('d', 'M5.7 3.9 3.3 6.3l2.4 2.4');
      head.setAttribute('stroke', 'currentColor');
      head.setAttribute('stroke-width', '1.4');
      head.setAttribute('stroke-linecap', 'round');
      head.setAttribute('stroke-linejoin', 'round');
      svg.append(arc, head);
      return svg;
    }

    /**
     * Build one action button for a message row.
     * @param {Element} row
     * @param {object} ctx plugin Context
     * @returns {HTMLButtonElement}
     */
    function createActionButton(row, ctx) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute(ACTION_ATTRIBUTE, '');
      button.setAttribute('aria-label', LABEL);
      button.title = LABEL;
      button.append(createGlyph());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void beginRollback(row, button, ctx);
      });
      return button;
    }

    /* --------------------------------- write-back -------------------------------- */

    /**
     * Put the clicked message's text back into the composer.
     * A draft the user already holds is never replaced without asking.
     * @param {{ inputActions: object, read: () => { draft: string, attachments: number } }} handle
     * @param {string} text
     * @returns {Promise<'written' | 'kept' | 'empty' | 'failed'>}
     */
    async function writeBack(handle, text) {
      if (typeof text !== 'string' || text.length === 0) return 'empty';
      const current = handle.read();
      const occupied = normalizeText(current.draft).length > 0 || current.attachments > 0;
      if (occupied && current.draft !== text) {
        const answer = await openDialog({
          title: '输入框里已有草稿',
          paragraphs: [
            '这条消息的正文还没有写入输入框：输入框里已有草稿，草稿没有被覆盖。',
            '要把输入框换成这条消息的正文吗？现在的草稿会丢失。',
          ],
          actions: [
            { id: 'keep', label: '保留草稿' },
            { id: 'replace', label: '换成消息正文', tone: 'primary' },
          ],
        });
        if (answer !== 'replace') return 'kept';
      }
      try {
        handle.inputActions.setDraft(text);
        return 'written';
      } catch {
        return 'failed';
      }
    }

    /* --------------------------------- reporting --------------------------------- */

    /**
     * Report one rollback report: what came back, what did not, what is left.
     * @param {object} result rollback report
     * @param {'written' | 'kept' | 'empty' | 'failed'} writeBackState
     * @returns {Promise<void>}
     */
    async function reportOutcome(result, writeBackState) {
      const stage = typeof result.stage === 'string' ? result.stage : '';
      if (result.ok !== true && stage !== 'files' && stage !== 'done') {
        const reason = typeof result.reason === 'string' ? result.reason : '';
        await openDialog({
          alert: true,
          title: '回退没有执行',
          paragraphs: [ROLLBACK_TEXT[reason] ?? '服务没有完成这次操作，回退没有执行。'],
          actions: [{ id: 'close', label: '知道了', tone: 'primary' }],
        });
        return;
      }

      const files = result.files !== null && typeof result.files === 'object' ? result.files : null;
      const restored = Array.isArray(files?.restored) ? files.restored : [];
      const deleted = Array.isArray(files?.deleted) ? files.deleted : [];
      const failed = Array.isArray(files?.failed) ? files.failed : [];
      const incomplete = incompleteTurnLines(result);
      const flushed = result.conversation !== null && typeof result.conversation === 'object'
        ? result.conversation.flushed !== false
        : true;
      const writeBackReport = result.writeBack !== null && typeof result.writeBack === 'object' ? result.writeBack : null;
      const nonTextParts = typeof writeBackReport?.nonTextParts === 'number' ? writeBackReport.nonTextParts : 0;

      const paragraphs = ['这条消息和它之后的对话已经从会话里移除。'];
      if (files === null) {
        paragraphs.push('文件状态没有返回，无法确认这些轮次改过的文件是否恢复。');
      } else if (files.untracked === true) {
        paragraphs.push('这条消息没有对应的文件记录，这次只回退了会话。');
      } else if (restored.length > 0 || deleted.length > 0) {
        const parts = [];
        if (restored.length > 0) parts.push(`恢复到当时的内容：${restored.length} 个文件`);
        if (deleted.length > 0) parts.push(`删除这几轮新建的：${deleted.length} 个文件`);
        paragraphs.push(`文件已恢复（${parts.join('；')}）。`);
      } else {
        paragraphs.push('这几轮没有改过文件，不需要恢复。');
      }

      if (writeBackState === 'written') {
        paragraphs.push('这条消息的正文已经放回输入框，可以直接修改后重新发送。');
      } else if (writeBackState === 'kept') {
        paragraphs.push('这条消息的正文没有写入输入框，输入框里还是你原来的草稿。');
      } else if (writeBackState === 'failed') {
        paragraphs.push('这条消息的正文没能写入输入框，需要你手动重新输入。');
      } else if (writeBackState === 'empty') {
        paragraphs.push('这条消息没有文字正文，输入框没有变化。');
      }
      if (nonTextParts > 0) {
        paragraphs.push(`这条消息里有 ${nonTextParts} 个非文本部分（图片、文件等），没有写回输入框。`);
      }

      const notes = [];
      if (!flushed) notes.push('会话记录没能写入磁盘，重启后可能看不到这次回退。');
      if (typeof result.reason === 'string' && result.reason === 'partial-snapshot') {
        notes.push('这几轮的文件记录不完整，恢复结果可能不完整。');
      }

      await openDialog({
        alert: failed.length > 0 || incomplete.length > 0,
        title: failed.length > 0 ? '会话已回退，文件没有全部恢复' : '已回退到此消息',
        paragraphs: failed.length > 0 ? [...paragraphs, '下面这些文件没能恢复：'] : paragraphs,
        items: failed.map(fileFailureLine),
        notes: [...incomplete, ...notes],
        actions: [{ id: 'close', label: '知道了', tone: 'primary' }],
      });
    }

    /* ---------------------------------- the flow --------------------------------- */

    /**
     * One click: confirm, resolve the message, prepare the fork cut, fork into a
     * child Session, restore the files, then report.
     * @param {Element} row the message row the button belongs to
     * @param {HTMLButtonElement} button the clicked control
     * @param {object} ctx plugin Context
     * @returns {Promise<void>}
     */
    async function beginRollback(row, button, ctx) {
      if (rollbackInFlight) return;
      const confirmed = await openDialog({
        title: LABEL,
        paragraphs: [
          '这条消息以及它之后的全部对话都会从会话里移除。',
          '这一轮以及之后几轮改过的文件，会恢复到这一轮开始时的内容：这几轮新建的文件会被删除，删掉的文件会重建，改过的文件回到旧内容。',
          '原始会话记录不会被删除。',
        ],
        actions: [
          { id: 'cancel', label: '取消' },
          { id: 'confirm', label: '回退', tone: 'primary' },
        ],
      });
      if (confirmed !== 'confirm') return;

      const sessionId = sessionIdOf(row);
      if (sessionId === '') {
        await openDialog({
          alert: true,
          title: '回退没有执行',
          paragraphs: ['没有找到这条消息所属的会话，请刷新页面后再试。'],
          actions: [{ id: 'close', label: '知道了', tone: 'primary' }],
        });
        return;
      }
      rollbackInFlight = true;
      button.setAttribute(BUSY_ATTRIBUTE, '');
      /** Whether this attempt still holds the Host-side claim `prepare` took. */
      let leaseHeld = false;
      try {
        const state = await postJson(STATE_ROUTE, { sessionId });
        if (state.available !== true) {
          const reason = typeof state.reason === 'string' ? state.reason : '';
          await openDialog({
            alert: true,
            title: '现在不能回退',
            paragraphs: [STATE_TEXT[reason] ?? '这个会话现在不能回退。'],
            actions: [{ id: 'close', label: '知道了', tone: 'primary' }],
          });
          return;
        }
        const rows = humanRowsAround(row);
        const target = resolveTargetMessage(state, rows, row);
        if (target === null) {
          await openDialog({
            alert: true,
            title: '回退没有执行',
            paragraphs: ['没能把这条消息和会话里的记录对上，回退已停止，避免动到别的消息。请刷新页面后再试。'],
            actions: [{ id: 'close', label: '知道了', tone: 'primary' }],
          });
          return;
        }
        const request = { sessionId };
        if (typeof target.seq === 'number' && Number.isSafeInteger(target.seq)) request.seq = target.seq;
        else request.ordinal = target.ordinal;
        const prepared = await postJson(PREPARE_ROUTE, request);
        leaseHeld = prepared.ok === true;
        if (prepared.ok !== true) {
          const reason = typeof prepared.reason === 'string' ? prepared.reason : '';
          await openDialog({
            alert: true,
            title: '回退没有执行',
            paragraphs: [ROLLBACK_TEXT[reason] ?? '服务没有完成这次操作，回退没有执行。'],
            actions: [{ id: 'close', label: '知道了', tone: 'primary' }],
          });
          return;
        }

        const sessions = serviceOf(ctx, 'sessions');
        if (sessions === undefined || typeof sessions.fork !== 'function') {
          await openDialog({
            alert: true,
            title: '回退没有执行',
            paragraphs: ['服务没有完成这次操作，回退没有执行。'],
            actions: [{ id: 'close', label: '知道了', tone: 'primary' }],
          });
          return;
        }
        let childId;
        try {
          childId = await sessions.fork({ sessionId, atSeq: prepared.forkAtSeq, increaseTitle: false });
        } catch (error) {
          await openDialog({
            alert: true,
            title: '回退没有执行',
            paragraphs: [failureText(error)],
            actions: [{ id: 'close', label: '知道了', tone: 'primary' }],
          });
          return;
        }
        if (typeof childId !== 'string' || childId.length === 0) {
          await openDialog({
            alert: true,
            title: '回退没有执行',
            paragraphs: ['服务没有完成这次操作，回退没有执行。'],
            actions: [{ id: 'close', label: '知道了', tone: 'primary' }],
          });
          return;
        }

        const workspace = serviceOf(ctx, 'uiWorkspace');
        try {
          const opened = workspace?.openSession?.(childId);
          if (opened !== undefined && opened !== null && typeof opened.then === 'function') await opened.catch(() => {});
        } catch {
          // The child exists; leaving the current view only costs a manual open.
        }

        const turn = prepared.target !== null && typeof prepared.target === 'object'
          && typeof prepared.target.turn === 'number' && Number.isSafeInteger(prepared.target.turn)
          ? prepared.target.turn
          : undefined;
        const restoreRequest = { sessionId, childSessionId: childId };
        if (turn !== undefined) restoreRequest.turn = turn;
        // The conversation is already rolled back here: a failed restore must not
        // be reported as "回退没有执行". `files: null` makes the report say the
        // file state is unknown instead.
        let restored;
        try {
          restored = await postJson(RESTORE_ROUTE, restoreRequest);
          // The Host drops the claim while restoring; a request that never arrived
          // still needs the release below.
          leaseHeld = false;
        } catch {
          restored = { ok: false, stage: 'files', reason: 'file-restore-incomplete', files: null, incompleteTurns: [], complete: false };
        }
        if (restored.ok !== true && restored.stage === 'precheck') {
          restored = { ...restored, stage: 'files', files: null };
        }

        // Archive only after the files are restored: archiving may release the
        // parent while the restore still needs it.
        const workspaces = serviceOf(ctx, 'workspaces');
        try {
          await workspaces?.archiveSession?.(sessionId);
        } catch {
          // The parent stays listed; the rollback itself already succeeded.
        }

        const handle = await waitForComposerHandle(childId, 8000);
        const writeBackText = prepared.writeBack !== null && typeof prepared.writeBack === 'object' ? prepared.writeBack.text : '';
        const writeBackState = handle === undefined ? 'failed' : await writeBack(handle, writeBackText);
        await reportOutcome({ ...restored, writeBack: prepared.writeBack }, writeBackState);
      } catch (error) {
        await openDialog({
          alert: true,
          title: '回退没有执行',
          paragraphs: [failureText(error)],
          actions: [{ id: 'close', label: '知道了', tone: 'primary' }],
        });
      } finally {
        rollbackInFlight = false;
        button.removeAttribute(BUSY_ATTRIBUTE);
        if (leaseHeld) {
          // The fork step failed, so nothing else will free the claim: release it
          // instead of leaving the session unreachable for the next attempt.
          try {
            await postJson(RELEASE_ROUTE, { sessionId });
          } catch {
            // The claim expires on its own; the attempt already reported its failure.
          }
        }
      }
    }

    /**
     * Keep one button in every user message's icon row, and only one.
     * Re-rendered rows lose the foreign node; the observer puts it back.
     * @param {object} ctx plugin Context
     * @returns {() => void} teardown
     */
    function installActionButtons(ctx) {
      /** Buttons this installer owns, so teardown can remove them. */
      const inserted = new Set();
      let observer = null;
      let frame = 0;
      let scheduled = false;
      let disposed = false;

      /**
       * Add the missing buttons and forget detached ones.
       * @returns {void}
       */
      const scan = () => {
        scheduled = false;
        if (disposed) return;
        for (const row of document.querySelectorAll(ROW_QUERY)) {
          const actions = actionsRowOf(row);
          if (actions === null) continue;
          if (actions.querySelector(`[${ACTION_ATTRIBUTE}]`) !== null) continue;
          const button = createActionButton(row, ctx);
          actions.append(button);
          inserted.add(button);
        }
        for (const button of Array.from(inserted)) {
          if (!button.isConnected) inserted.delete(button);
        }
      };

      /**
       * Coalesce mutations into one frame.
       * @returns {void}
       */
      const schedule = () => {
        if (disposed || scheduled) return;
        scheduled = true;
        frame = requestAnimationFrame(scan);
      };

      observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'childList' && record.addedNodes.length > 0) {
            schedule();
            return;
          }
        }
      });
      observer.observe(document.body, { subtree: true, childList: true });
      scan();

      return () => {
        disposed = true;
        if (observer !== null) observer.disconnect();
        if (frame !== 0) cancelAnimationFrame(frame);
        for (const button of inserted) button.remove();
        inserted.clear();
      };
    }

    return {
      name: PLUGIN_ID,
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = PLUGIN_ID;
          style.textContent = CSS;
          document.head.append(style);
          return () => style.remove();
        }, `${PLUGIN_ID}: styles`);

        ctx.effect(() => installActionButtons(ctx), `${PLUGIN_ID}: message actions`);

        ctx.effect(() => closeDialogs, `${PLUGIN_ID}: dialogs`);

        ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({
          name: DOCK_SLOT,
          id: 'session-rollback-composer',
          order: 40,
        }, ComposerBridge));
      },
    };
  },
});
