/* Workflow tool cards: moved verbatim from the pre-scaffold client.js. */

    /** Longest text pinned into one body block, and how many result rows a list card shows. */
    const MAX_SECTION_CHARS = 120000;
    const MAX_LIST_ROWS = 8;
    /** Longest text a single row slot carries; the full text stays in the expandable body. */
    const MAX_ROW_CHARS = 300;

    /** Scoped stylesheet: host theme tokens only, one class per row element. */
    const CSS = [
      '.zwf-root{flex-direction:column;display:flex;min-width:0}',
      '.zwf-row{box-sizing:border-box;align-items:center;display:flex;min-width:0;min-height:calc(24px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm,6px);padding:0 2px}',
      '.zwf-row[data-expandable=true]{cursor:pointer}',
      '.zwf-row[data-expandable=true]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}',
      '.zwf-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '.zwf-icon{color:var(--dsw-alias-state-business-primary);flex:none;width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));align-items:center;justify-content:center;display:inline-flex;margin-right:6px}',
      '.zwf-title{color:var(--dsw-alias-state-business-primary);flex:none;font-size:var(--dsh-content-font-size-secondary,13px);font-weight:500;line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap}',
      '.zwf-sep{background:var(--dsw-alias-label-caption);border-radius:50%;flex:none;width:2px;height:2px;margin:0 8px}',
      '.zwf-summary{min-width:0;flex:1;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}',
      '.zwf-detail{min-width:0;flex:none;max-width:38%;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;color:var(--dsw-alias-label-caption);font-size:12px;line-height:calc(24px + var(--dsh-content-font-delta,0px));margin-left:8px}',
      '.zwf-status{flex:none;max-width:40%;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;color:var(--dsw-alias-label-caption);font-size:12px;line-height:calc(24px + var(--dsh-content-font-delta,0px));margin-left:8px}',
      '.zwf-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}',
      '.zwf-root[data-state=running] .zwf-status{color:var(--dsw-alias-state-success-primary)}',
      '.zwf-root[data-state=error] .zwf-summary,.zwf-root[data-state=error] .zwf-detail,.zwf-root[data-state=error] .zwf-status{color:var(--dsw-alias-state-error-primary)}',
      '.zwf-chevron{color:var(--dsw-alias-label-tertiary);flex:none;width:16px;height:16px;align-items:center;justify-content:center;display:inline-flex;margin-left:4px;transition:transform .12s}',
      '.zwf-chevron[data-open=true]{transform:rotate(90deg)}',
      '.zwf-detail-action{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:calc(20px + var(--dsh-content-font-delta,0px));height:calc(20px + var(--dsh-content-font-delta,0px));margin-left:4px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-caption);cursor:pointer}',
      '.zwf-detail-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary)}',
      '.zwf-detail-action:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '.zwf-body{flex-direction:column;gap:8px;display:flex;min-width:0;padding:2px 0 4px 22px}',
      '.zwf-section{flex-direction:column;gap:4px;display:flex;min-width:0}',
      '.zwf-label{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}',
      '.zwf-card-code,.zwf-output{margin:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);max-height:260px;overflow:auto;padding:8px 12px;font:var(--dsw-font-markdown-code-block-small,12px/18px ui-monospace,SFMono-Regular,Menlo,monospace);white-space:pre-wrap;word-break:break-word}',
      '.zwf-rows{flex-direction:column;gap:2px;display:flex;min-width:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-markdown-code-block);padding:8px 12px}',
      '.zwf-rowitem{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}',
    ].join('');

    /** Class names used by the markup above. */
    const CLASS = {
      root: 'zwf-root',
      row: 'zwf-row',
      icon: 'zwf-icon',
      title: 'zwf-title',
      sep: 'zwf-sep',
      summary: 'zwf-summary',
      detail: 'zwf-detail',
      status: 'zwf-status',
      mono: 'zwf-mono',
      chevron: 'zwf-chevron',
      detailAction: 'zwf-detail-action',
      body: 'zwf-body',
      section: 'zwf-section',
      label: 'zwf-label',
      code: 'zwf-card-code',
      output: 'zwf-output',
      rows: 'zwf-rows',
      rowItem: 'zwf-rowitem',
    };

    /* --------------------------------- readers -------------------------------- */

    function isObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    function asText(value) {
      return typeof value === 'string' ? value : '';
    }

    function linesOf(text) {
      const value = asText(text);
      return value === '' ? [] : value.split('\n');
    }

    function firstLine(text) {
      const value = asText(text);
      const index = value.indexOf('\n');
      return (index === -1 ? value : value.slice(0, index)).trim();
    }

    function parseText(text, pattern) {
      const match = pattern.exec(asText(text));
      if (match === null || typeof match[1] !== 'string' || match[1] === '') return undefined;
      return match[1];
    }

    /** The call slice of a preparing/start/result block, whichever shape carries it. */
    function callOf(block) {
      if (!isObject(block)) return undefined;
      return isObject(block.call) ? block.call : block;
    }

    const PARSED_ARGS = new WeakMap();

    /** Parse one call's raw argument JSON once; a still-streaming payload parses to `{}`. */
    function parsedArgs(block) {
      const call = callOf(block);
      if (!isObject(call)) return {};
      const cached = PARSED_ARGS.get(call);
      if (cached !== undefined) return cached;
      let parsed = {};
      const raw = typeof call.argsRaw === 'string' ? call.argsRaw : '';
      if (raw !== '') {
        try {
          const value = JSON.parse(raw);
          if (isObject(value)) parsed = value;
        } catch {
          // Still streaming: the lazy view below serves the fields that already arrived.
        }
      }
      PARSED_ARGS.set(call, parsed);
      return parsed;
    }

    /**
     * Read one field from a block's lazy argument view.
     * The shipped view exposes `text`/`complete`/`value`; a partial or foreign shape may expose a
     * getter (`read`, `get`, `value`) or be the arguments object itself.
     * @param {unknown} view candidate argument view
     * @param {string} key argument name
     * @returns {unknown} the field value, or undefined when this shape cannot answer
     */
    function viewField(view, key) {
      if (view === undefined || view === null) return undefined;
      try {
        if (typeof view.text === 'function') {
          const value = view.text(key);
          if (value !== undefined) return value;
        }
      } catch {
        // fall through
      }
      try {
        if (typeof view.complete === 'function' && view.complete(key) && typeof view.value === 'function') {
          const value = view.value(key);
          if (value !== undefined) return value;
        }
      } catch {
        // fall through
      }
      try {
        if (typeof view === 'function') {
          const all = view();
          return isObject(all) ? all[key] : undefined;
        }
      } catch {
        // fall through
      }
      try {
        if (typeof view.read === 'function') {
          const all = view.read();
          return isObject(all) ? all[key] : undefined;
        }
      } catch {
        // fall through
      }
      try {
        if (typeof view.get === 'function') {
          const value = view.get(key);
          if (value !== undefined) return value;
        }
      } catch {
        // fall through
      }
      return isObject(view) && Object.prototype.hasOwnProperty.call(view, key) ? view[key] : undefined;
    }

    /**
     * Read one call argument at any lifecycle stage.
     * @param {unknown} block preparing, started, or settled block
     * @param {string} key argument name
     * @returns {unknown} the value, or undefined
     */
    function argValue(block, key) {
      if (!isObject(block)) return undefined;
      const direct = viewField(block.args, key);
      if (direct !== undefined) return direct;
      const call = callOf(block);
      if (call !== undefined && call !== block) {
        const nested = viewField(call.args, key);
        if (nested !== undefined) return nested;
      }
      const parsed = parsedArgs(block);
      return Object.prototype.hasOwnProperty.call(parsed, key) ? parsed[key] : undefined;
    }

    /**
     * Read one string argument.
     * @param {unknown} block preparing, started, or settled block
     * @param {string} key argument name
     * @returns {string | undefined} the non-empty string value
     */
    function argText(block, key) {
      const value = argValue(block, key);
      return typeof value === 'string' && value !== '' ? value : undefined;
    }

    /** The `saved` object of a CreateWorkflow call, when it is an object. */
    function savedArg(block) {
      const value = argValue(block, 'saved');
      return isObject(value) ? value : undefined;
    }

    /**
     * Flatten a settled block's content to display text, falling back to its structured error.
     * @param {unknown} block settled result block
     * @returns {string} the result text, or ''
     */
    function resultText(block) {
      if (!isObject(block)) return '';
      const sources = [
        block.content,
        isObject(block.result) ? block.result.content : undefined,
        isObject(block.call) ? block.call.content : undefined,
        isObject(block.call) && isObject(block.call.result) ? block.call.result.content : undefined,
        isObject(block.output) ? block.output.content : undefined,
      ];
      for (const content of sources) {
        if (!Array.isArray(content) || content.length === 0) continue;
        const parts = [];
        for (const item of content) {
          if (typeof item === 'string') {
            if (item !== '') parts.push(item);
            continue;
          }
          if (isObject(item) && item.type === 'text' && typeof item.text === 'string') {
            if (item.text !== '') parts.push(item.text);
            continue;
          }
          if (item === undefined || item === null) continue;
          try {
            parts.push(JSON.stringify(item, null, 2));
          } catch {
            // unprintable block: keep the rest
          }
        }
        if (parts.length > 0) return parts.join('\n');
      }
      const error = [block.error, isObject(block.call) ? block.call.error : undefined].find(isObject);
      if (error === undefined) return '';
      const name = typeof error.name === 'string' && error.name !== '' ? error.name : 'Error';
      const code = typeof error.code === 'string' && error.code !== '' ? error.code : '';
      return code === '' ? name : `${name}: ${code}`;
    }

    /** A tool-owned structured value, when the block records one beside its text. */
    function structuredValue(block) {
      if (!isObject(block)) return undefined;
      const candidates = [block.meta, block.value, isObject(block.output) ? block.output.value : undefined, isObject(block.result) ? block.result.value : undefined];
      for (const candidate of candidates) if (isObject(candidate)) return candidate;
      return undefined;
    }

    /**
     * Read the phases a run declares: the structured value first, then the result headline.
     * @param {unknown} block settled result block
     * @param {string} text its result text
     * @returns {string[]} phase names
     */
    function phasesOf(block, text) {
      const value = structuredValue(block);
      if (value !== undefined && Array.isArray(value.phases)) {
        const phases = value.phases.filter((phase) => typeof phase === 'string' && phase !== '');
        if (phases.length > 0) return phases;
      }
      const line = parseText(text, /^Phases:\s*(.+)$/m);
      if (line === undefined) return [];
      return line.split(/\s*(?:→|->)\s*/).map((part) => part.trim()).filter((part) => part !== '');
    }

    /** Compiler diagnostics rendered as `path:Lline:Ccolumn message` lines. */
    function diagnosticLines(text) {
      const rows = [];
      for (const line of linesOf(text)) {
        const trimmed = line.trim();
        if (trimmed !== '' && /:[LC]\d+:[LC]\d+\b/.test(trimmed)) rows.push(trimmed);
      }
      return rows;
    }

    /** The first two meaningful lines of a block of text. */
    function secondMeaningfulLine(text) {
      const rows = linesOf(text).map((line) => line.trim()).filter((line) => line !== '');
      if (rows.length > 1) return rows[1];
      return rows.length === 1 ? rows[0] : '';
    }

    /** The `- ` rows of a result list, capped. */
    function bulletRows(text, limit) {
      const rows = [];
      for (const line of linesOf(text)) {
        if (!line.startsWith('- ')) continue;
        const row = line.slice(2).trim();
        if (row === '') continue;
        rows.push(row);
        if (rows.length >= limit) break;
      }
      return rows;
    }

    /** The leading number of a result headline (`3 runs`, `2 saved workflows`). */
    function leadingCount(text) {
      const match = /^(\d+)\b/.exec(firstLine(text));
      return match === null ? undefined : Number(match[1]);
    }

    /** The localized status word of a `Run <id> "<name>" — <status>` headline. */
    function runStatusWord(text, say) {
      const match = /\b(pending|running|completed|errored|stopped|superseded)\b/.exec(firstLine(text));
      return match === null ? '' : say(`run.status.${match[1]}`);
    }

    /** The lifecycle phase a card renders: preparing, start (running), or result. */
    function phaseOf(props) {
      const phase = isObject(props) ? props.phase : undefined;
      if (phase === 'preparing' || phase === 'start' || phase === 'result') return phase;
      const block = isObject(props) ? props.block : undefined;
      if (isObject(block)) {
        if ('kind' in block) return 'result';
        if (block.phase === 'preparing') return 'preparing';
        if (block.phase === 'start') return 'start';
      }
      return 'preparing';
    }

    /** Run id named by a settled result, when the tool reports one there. */
    function cardResultRunId(toolName, text) {
      switch (toolName) {
        case 'CreateWorkflow':
          return parseText(text, /^Run ID:\s*(\S+)/m);
        case 'AmendWorkflow':
          return parseText(text, /^Started revised run\s+(\S+)/m);
        case 'GetWorkflowRun':
        case 'TaskOutput':
          return parseText(text, /^Run\s+(\S+)\s/m);
        case 'StopWorkflowRun':
          return parseText(text, /^Stopped run\s+(\S+?)\./m);
        case 'ResumeWorkflowRun':
          return parseText(text, /^Resumed run\s+\S+\s+as\s+([^\s(]+)/m);
        case 'FillWorkflowHole':
          return parseText(text, /on run\s+(\S+?);/m);
        default:
          return undefined;
      }
    }

    /**
     * The run one settled tool call acted on, for the card's detail entry.
     * Every successful workflow tool result names its run in the result text, so a call that only
     * carries `run_id` in its arguments (a failure or a draft) is left without an entry.
     * @param {string} toolName wire tool name
     * @param {unknown} block settled block
     * @param {string} phase lifecycle phase
     * @param {boolean} failed structured failure
     * @returns {string | undefined} run id
     */
    function cardRunIdOf(toolName, block, phase, failed) {
      if (phase !== 'result' || failed === true) return undefined;
      return cardResultRunId(toolName, resultText(block));
    }

    /** The session a card renders in, taken from the slot's standard props. */
    function cardSessionId(props) {
      if (!isObject(props)) return undefined;
      if (typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId;
      if (isObject(props.session) && typeof props.session.id === 'string' && props.session.id !== '') return props.session.id;
      return undefined;
    }

    /** Open one run's detail from a card; the detail surface may not be composed yet. */
    function cardOpenDetail(runId, sessionId) {
      if (typeof WF_DETAIL !== 'object' || WF_DETAIL === null || typeof WF_DETAIL.open !== 'function') return;
      try {
        WF_DETAIL.open({ runId, sessionId });
      } catch (error) {
        console.warn('zcode-workflow: run detail failed to open', error);
      }
    }

    /* -------------------------------- wording -------------------------------- */

    function interpolate(text, params) {
      if (!isObject(params)) return text;
      return text.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match));
    }

    /**
     * Build the translate function a card uses.
     * A namespace lookup that misses (returns the key, an empty string, or throws) falls back to
     * the English string, so a missing dictionary never shows a raw key.
     * @param {unknown} translate slot-injected `t`
     * @returns {(key: string, params?: Record<string, unknown>) => string} translator
     */
    function makeSay(translate) {
      return function say(key, params) {
        let text;
        if (typeof translate === 'function') {
          try {
            text = translate(key, params);
          } catch {
            text = undefined;
          }
        }
        const resolved = typeof text === 'string' && text !== '' && text !== key ? text : (EN[key] ?? key);
        return interpolate(resolved, params);
      };
    }

    /* ------------------------------- card models ------------------------------ */

    function sourceOf(block) {
      if (argText(block, 'script') !== undefined) return 'inline';
      if (argText(block, 'path') !== undefined) return 'path';
      if (savedArg(block) !== undefined) return 'saved';
      return undefined;
    }

    function sourceSection(block, say) {
      const script = argText(block, 'script');
      if (script !== undefined) return { kind: 'code', label: say('body.script'), text: script };
      const filePath = argText(block, 'path');
      if (filePath !== undefined) return { kind: 'text', label: say('body.script'), text: filePath };
      const saved = savedArg(block);
      if (saved !== undefined && typeof saved.name === 'string' && saved.name !== '') {
        return { kind: 'text', label: say('create.source.saved'), text: saved.name };
      }
      return undefined;
    }

    function createModel({ block, phase, say, failed }) {
      const saved = savedArg(block);
      const name = argText(block, 'name') ?? (saved !== undefined && typeof saved.name === 'string' ? saved.name : '');
      const text = resultText(block);
      const runId = phase === 'result' ? parseText(text, /^Run ID:\s*(\S+)/m) : undefined;
      const isDraft = phase === 'result' && (failed || (text !== '' && runId === undefined));
      const phases = phasesOf(block, text);
      const diagnostics = diagnosticLines(text);
      const source = sourceOf(block);

      let title = say('create.title');
      let summary = name;
      let detail = '';
      let status = '';
      let tone = phase === 'preparing' ? 'preparing' : phase === 'start' ? 'running' : 'ok';
      let statusSuffix = '';

      if (phase === 'preparing') {
        status = say('create.writing');
      } else if (phase === 'start') {
        status = say('create.validating');
      } else if (isDraft) {
        status = say('create.draft');
        detail = diagnostics.length > 0 ? diagnostics[0] : secondMeaningfulLine(text);
        tone = 'error';
      } else {
        status = say('create.ran');
        statusSuffix = runId ?? '';
        detail = phases.length > 0 ? say('card.phases', { count: phases.length }) : '';
      }
      if (detail === '' && source !== undefined) detail = say(`create.source.${source}`);
      if (detail === '' && diagnostics.length > 0 && phase === 'result') detail = diagnostics[0];

      const sections = [];
      const scriptSection = sourceSection(block, say);
      if (scriptSection !== undefined) sections.push(scriptSection);
      sections.push({ kind: 'text', label: say('body.output'), text });

      return { title, summary, detail, status, statusSuffix, tone, sections };
    }

    function amendModel({ block, phase, say, failed }) {
      const text = resultText(block);
      const started = parseText(text, /^Started revised run\s+(\S+)/m);
      const runId = argText(block, 'run_id') ?? '';
      const pending = phase !== 'result';
      const bad = phase === 'result' && (failed || (text !== '' && started === undefined));
      const sections = [];
      const scriptSection = sourceSection(block, say);
      if (scriptSection !== undefined) sections.push(scriptSection);
      sections.push({ kind: 'text', label: say('body.output'), text });
      return {
        title: started !== undefined ? say('amend.amended') : say('amend.title'),
        summary: started ?? runId,
        monoSummary: true,
        detail: started !== undefined && runId !== '' ? runId : (argText(block, 'name') ?? ''),
        status: pending ? say(phase === 'preparing' ? 'amend.writing' : 'amend.validating') : bad ? say('amend.draft') : '',
        tone: bad ? 'error' : pending ? 'running' : 'ok',
        sections,
      };
    }

    function runStatusModel({ block, phase, say, failed }) {
      const text = resultText(block);
      const notFound = /^run_not_found\b/m.test(text);
      const bad = failed || notFound;
      const runId = argText(block, 'run_id') ?? parseText(text, /^Run\s+(\S+)\s/m) ?? '';
      return {
        title: say('getRun.title'),
        summary: runId,
        monoSummary: true,
        detail: '',
        status: phase === 'result' ? (bad ? say('status.failed') : runStatusWord(text, say)) : say('getRun.fetching'),
        tone: bad ? 'error' : phase === 'result' ? 'ok' : 'running',
        sections: [{ kind: 'text', label: say('body.output'), text }],
      };
    }

    function runListModel({ block, phase, say, failed }, keys) {
      const text = resultText(block);
      const rows = bulletRows(text, MAX_LIST_ROWS);
      const count = leadingCount(text);
      const total = count ?? rows.length;
      const empty = rows.length === 0 && new RegExp(`^${keys.emptyPattern}`, 'm').test(text);
      const settled = phase === 'result';
      let summary = '';
      if (settled) {
        if (empty) summary = say(keys.empty);
        else if (total !== undefined) summary = say(total === 1 ? keys.countOne : keys.count, { count: total });
      }
      const truncated = settled && !failed && rows.length > 0 && (total === undefined || total > rows.length);
      return {
        title: say(keys.title),
        summary,
        detail: truncated ? say(keys.truncated) : '',
        status: settled ? (failed ? say('status.failed') : '') : say(keys.listing),
        tone: failed ? 'error' : settled ? 'ok' : 'running',
        sections: failed ? [{ kind: 'text', label: say('body.output'), text }] : [{ kind: 'rows', rows }],
      };
    }

    function saveModel({ block, phase, say, failed }) {
      const text = resultText(block);
      const bad = failed || /Nothing was saved|^The workflow script has errors/m.test(text);
      const scope = argText(block, 'scope');
      return {
        title: phase === 'result' && !bad ? say('save.saved') : say('save.saving'),
        summary: argText(block, 'name') ?? '',
        monoSummary: true,
        detail: scope === 'global' || scope === 'project' ? say(`save.scope.${scope}`) : '',
        status: phase === 'result' && bad ? say('status.failed') : '',
        tone: bad ? 'error' : phase === 'result' ? 'ok' : 'running',
        sections: [{ kind: 'text', label: say('body.output'), text }],
      };
    }

    function holeModel({ block, phase, say, failed }) {
      const text = resultText(block);
      const bad = failed || /^hole_not_waiting\b/m.test(text);
      return {
        title: say('hole.title'),
        summary: argText(block, 'hole_id') ?? '',
        monoSummary: true,
        detail: argText(block, 'run_id') ?? '',
        status: phase === 'result' ? (bad ? say('status.failed') : '') : say('hole.running'),
        tone: bad ? 'error' : phase === 'result' ? 'ok' : 'running',
        sections: [{ kind: 'text', label: say('body.output'), text }],
      };
    }

    function stopModel({ block, phase, say, failed }) {
      const text = resultText(block);
      const bad = failed || /^run_not_found\b/m.test(text);
      const runId = argText(block, 'run_id') ?? parseText(text, /^Stopped run\s+(\S+?)\./m) ?? '';
      return {
        title: phase === 'result' && !bad ? say('stop.stopped') : phase === 'result' ? say('stop.title') : say('stop.running'),
        summary: runId,
        monoSummary: true,
        detail: '',
        status: phase === 'result' && bad ? say('status.failed') : '',
        tone: bad ? 'error' : phase === 'result' ? 'ok' : 'running',
        sections: [{ kind: 'text', label: say('body.output'), text }],
      };
    }

    function resumeModel({ block, phase, say, failed }) {
      const text = resultText(block);
      const bad = failed || /^run_not_found\b|Nothing was resumed|only a stopped run can be resumed|no longer compiles/m.test(text);
      const resumed = parseText(text, /^Resumed run\s+\S+\s+as\s+([^\s(]+)/m);
      const previous = argText(block, 'run_id') ?? '';
      return {
        title: phase === 'result' && !bad ? say('resume.title') : phase === 'result' ? say('resume.action') : say('resume.running'),
        summary: resumed ?? previous,
        monoSummary: true,
        detail: resumed !== undefined && previous !== '' ? previous : '',
        status: phase === 'result' && bad ? say('status.failed') : '',
        tone: bad ? 'error' : phase === 'result' ? 'ok' : 'running',
        sections: [{ kind: 'text', label: say('body.output'), text }],
      };
    }

    function snippetModel({ block, phase, say, failed }) {
      const text = resultText(block);
      const code = argText(block, 'code');
      const filePath = argText(block, 'path');
      const bad = failed || /^The snippet (?:has errors|failed)\b/m.test(text);
      const snippetSection = code !== undefined
        ? { kind: 'code', label: say('body.script'), text: code }
        : filePath !== undefined
          ? { kind: 'text', label: say('body.script'), text: filePath }
          : undefined;
      const sections = [];
      if (snippetSection !== undefined) sections.push(snippetSection);
      sections.push({ kind: 'text', label: say('body.output'), text });
      return {
        title: phase === 'result' ? say('snippet.title') : say('snippet.running'),
        summary: phase === 'result' ? firstLine(text) : (code !== undefined ? firstLine(code) : (filePath ?? '')),
        detail: '',
        status: phase === 'result' && bad ? say('status.failed') : '',
        tone: bad ? 'error' : phase === 'result' ? 'ok' : 'running',
        sections,
      };
    }

    /** Dispatch one tool name to its card model. */
    function buildModel(toolName, phase, block, say) {
      const shared = { block, phase, say, failed: isObject(block) && block.isError === true };
      switch (toolName) {
        case 'CreateWorkflow':
          return createModel(shared);
        case 'AmendWorkflow':
          return amendModel(shared);
        case 'GetWorkflowRun':
        case 'TaskOutput':
          return runStatusModel(shared);
        case 'ListWorkflowRuns':
          return runListModel(shared, {
            title: 'listRuns.title',
            listing: 'listRuns.listing',
            count: 'listRuns.count',
            countOne: 'listRuns.countOne',
            empty: 'listRuns.empty',
            truncated: 'listRuns.truncated',
            emptyPattern: 'No workflow runs\\b',
          });
        case 'ListSavedWorkflows':
          return runListModel(shared, {
            title: 'list.title',
            listing: 'list.listing',
            count: 'list.count',
            countOne: 'list.countOne',
            empty: 'list.empty',
            truncated: 'list.truncated',
            emptyPattern: 'No saved workflows\\b',
          });
        case 'SaveWorkflow':
          return saveModel(shared);
        case 'FillWorkflowHole':
          return holeModel(shared);
        case 'StopWorkflowRun':
          return stopModel(shared);
        case 'ResumeWorkflowRun':
          return resumeModel(shared);
        case 'EvalWorkflowSnippet':
          return snippetModel(shared);
        default:
          return {
            title: say('card.title'),
            status: phase === 'result' ? '' : say('getRun.fetching'),
            tone: phase === 'result' ? 'ok' : 'running',
            sections: [{ kind: 'text', label: say('body.output'), text: resultText(block) }],
          };
      }
    }

    /** Keep one row slot short enough to render and to expose as a tooltip. */
    function clipRow(value) {
      const text = typeof value === 'string' ? value : '';
      if (text.length <= MAX_ROW_CHARS) return text;
      return `${text.slice(0, MAX_ROW_CHARS - 1)}…`;
    }

    /**
     * Normalize a model to the exact shape the renderer consumes.
     * Empty sections drop out, labels disappear when a body holds a single section, and every
     * field lands as a string so one malformed model cannot throw during render.
     * @param {object} model raw card model
     * @param {(key: string, params?: Record<string, unknown>) => string} say translator
     * @returns {object} render-ready model
     */
    function totalize(model, say) {
      const sections = [];
      for (const section of Array.isArray(model.sections) ? model.sections : []) {
        if (!isObject(section)) continue;
        const label = typeof section.label === 'string' ? section.label : '';
        if (section.kind === 'rows') {
          const rows = Array.isArray(section.rows) ? section.rows.filter((row) => typeof row === 'string' && row !== '') : [];
          if (rows.length === 0) continue;
          sections.push({ kind: 'rows', label, rows });
          continue;
        }
        const text = typeof section.text === 'string' ? section.text : '';
        if (text.trim() === '') continue;
        const clipped = text.length > MAX_SECTION_CHARS ? `${text.slice(0, MAX_SECTION_CHARS)}\n…` : text;
        sections.push({ kind: section.kind === 'code' ? 'code' : 'text', label, text: clipped });
      }
      if (sections.length < 2) for (const section of sections) section.label = '';
      const tone = model.tone === 'error' || model.tone === 'running' || model.tone === 'preparing' ? model.tone : 'ok';
      return {
        title: clipRow(model.title) || say('card.title'),
        summary: clipRow(model.summary),
        detail: clipRow(model.detail),
        status: clipRow(model.status),
        statusSuffix: clipRow(model.statusSuffix),
        monoSummary: model.monoSummary === true,
        tone,
        sections,
      };
    }

    /* -------------------------------- rendering ------------------------------- */

    /** The workflow glyph: three stations joined by two lanes. */
    function WorkflowIcon() {
      return React.createElement('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
      }, React.createElement('circle', { cx: 3.2, cy: 3.6, r: 1.5, key: 'a' }),
      React.createElement('circle', { cx: 3.2, cy: 12.4, r: 1.5, key: 'b' }),
      React.createElement('circle', { cx: 12.8, cy: 8, r: 1.5, key: 'c' }),
      React.createElement('path', { d: 'M4.7 3.6h2.6a2 2 0 0 1 2 2v.9M4.7 12.4h2.6a2 2 0 0 0 2-2v-.9', key: 'd' }));
    }

    function Chevron({ open }) {
      return React.createElement('span', { className: CLASS.chevron, 'data-open': open ? 'true' : 'false', 'aria-hidden': true },
        React.createElement('svg', {
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }, React.createElement('path', { d: 'M6 3.5 10.5 8 6 12.5' })));
    }

    /** The expanded body: one labeled block per section. */
    function CardBody({ sections }) {
      return React.createElement('div', { className: CLASS.body },
        sections.map((section, index) => React.createElement('div', { className: CLASS.section, key: `section-${index}` },
          section.label === '' ? null : React.createElement('div', { className: CLASS.label }, section.label),
          section.kind === 'rows'
            ? React.createElement('div', { className: CLASS.rows },
              (Array.isArray(section.rows) ? section.rows : []).map((row, rowIndex) => React.createElement('div', { className: CLASS.rowItem, key: `row-${rowIndex}` }, row)))
            : React.createElement('pre', { className: section.kind === 'code' ? CLASS.code : CLASS.output }, section.text))));
    }

    /**
     * Expansion state owned by this card.
     * Chat forwards a stable `useDisclosure`; without one the card keeps its own state, so the
     * body still opens in a host that does not provide the hook.
     */
    function useExpansion(useDisclosure) {
      const local = React.useState(false);
      let expanded = local[0] === true;
      let toggle = () => local[1]((previous) => previous !== true);
      if (typeof useDisclosure === 'function') {
        let state;
        try {
          state = useDisclosure();
        } catch {
          state = undefined;
        }
        if (isObject(state)) {
          expanded = state.expanded === true;
          if (typeof state.toggle === 'function') toggle = state.toggle;
        }
      }
      return { expanded, toggle };
    }

    /**
     * One workflow tool card.
     * @param {object} props slot owner payload: `toolName`, `phase`, `block`, `useDisclosure`, `t`
     */
    function WorkflowCard(props) {
      const translate = isObject(props) ? props.t : undefined;
      const say = React.useMemo(() => makeSay(translate), [translate]);
      const { expanded, toggle } = useExpansion(isObject(props) ? props.useDisclosure : undefined);
      const toolName = isObject(props) && typeof props.toolName === 'string' ? props.toolName : '';
      const phase = phaseOf(props);
      const block = isObject(props) ? props.block : undefined;
      const failed = isObject(block) && block.isError === true;
      const sessionId = cardSessionId(props);
      const detailRunId = React.useMemo(
        () => (typeof WF_DETAIL === 'object' && WF_DETAIL !== null && typeof WF_DETAIL.open === 'function'
          ? cardRunIdOf(toolName, block, phase, failed)
          : undefined),
        [toolName, block, phase, failed],
      );
      const detailLabel = wfUiCopy('card.detailAction');
      const model = React.useMemo(
        () => totalize(buildModel(toolName, phase, block, say), say),
        [toolName, phase, block, say],
      );

      const expandable = model.sections.length > 0;
      const open = expandable && expanded;
      const onToggle = () => {
        if (typeof toggle === 'function') toggle();
      };
      const onRowKeyDown = (event) => {
        if (!isObject(event)) return;
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        onToggle();
      };

      const row = [];
      row.push(React.createElement('span', { className: CLASS.icon, key: 'icon' }, React.createElement(WorkflowIcon)));
      row.push(React.createElement('span', { className: CLASS.title, key: 'title' }, model.title));
      if (model.summary !== '') {
        row.push(React.createElement('span', { className: CLASS.sep, 'aria-hidden': true, key: 'sep' }));
        row.push(React.createElement('span', {
          className: model.monoSummary ? `${CLASS.summary} ${CLASS.mono}` : CLASS.summary,
          title: model.summary,
          key: 'summary',
        }, model.summary));
      }
      if (model.detail !== '') {
        row.push(React.createElement('span', { className: CLASS.detail, title: model.detail, key: 'detail' }, model.detail));
      }
      if (model.status !== '') {
        row.push(React.createElement('span', { className: CLASS.status, key: 'status' }, model.status));
      }
      if (model.statusSuffix !== '') {
        row.push(React.createElement('span', { className: `${CLASS.status} ${CLASS.mono}`, title: model.statusSuffix, key: 'suffix' }, model.statusSuffix));
      }
      if (detailRunId !== undefined) {
        row.push(React.createElement('button', {
          type: 'button',
          className: CLASS.detailAction,
          title: detailLabel,
          'aria-label': detailLabel,
          'data-workflow-run-id': detailRunId,
          key: 'detail-action',
          onClick: (event) => {
            if (isObject(event) && typeof event.stopPropagation === 'function') event.stopPropagation();
            cardOpenDetail(detailRunId, sessionId);
          },
          onKeyDown: (event) => {
            if (isObject(event) && typeof event.stopPropagation === 'function') event.stopPropagation();
          },
        }, React.createElement(WF_UI.icons.external, { size: 14 })));
      }
      if (expandable) row.push(React.createElement(Chevron, { open, key: 'chevron' }));

      const rowProps = { className: CLASS.row, 'data-expandable': expandable ? 'true' : 'false', key: 'row' };
      if (expandable) {
        rowProps.role = 'button';
        rowProps.tabIndex = 0;
        rowProps['aria-expanded'] = open ? 'true' : 'false';
        rowProps.title = say(open ? 'row.collapse' : 'row.expand');
        rowProps.onClick = onToggle;
        rowProps.onKeyDown = onRowKeyDown;
      }

      const children = [React.createElement('div', rowProps, row)];
      if (open) children.push(React.createElement(CardBody, { sections: model.sections, key: 'body' }));

      return React.createElement('div', {
        className: CLASS.root,
        'data-tool': toolName,
        'data-state': model.tone,
      }, children);
    }

