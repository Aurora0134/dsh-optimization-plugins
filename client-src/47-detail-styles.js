/* Styles for the run-detail pane, the timeline, the roster, the artifacts area and the script steps. */
const WF_DETAIL_CSS = `
/* ---------------------------------- pane ---------------------------------- */
.zwf-run{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.zwf-run-head{display:flex;flex-direction:column;gap:6px;padding:14px 16px 10px;flex:none}
.zwf-run-headline{display:flex;align-items:center;gap:10px;min-width:0}
.zwf-run-title{margin:0;flex:1;min-width:0;font-size:16px;line-height:24px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-run-actions{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.zwf-run-stop:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.zwf-run-idline{display:flex;align-items:center;gap:8px;min-width:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.zwf-run-id{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
.zwf-run-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:0 16px 24px}
.zwf-run-tab-title{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}
.zwf-run-tab-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-brand-primary)}
.zwf-run-tab-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-run-overlay{display:flex;flex-direction:column;min-height:0;height:min(72vh,680px)}
.zwf-run-overlay .zwf-run,.zwf-run-overlay .zwf-ws{height:100%}
/* status row */
.zwf-status-row{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-run-status{display:inline-flex;align-items:center;gap:6px;flex:none;font-weight:500;color:var(--dsw-alias-label-primary)}
.zwf-run-status-success .zwf-run-status-word{color:var(--dsw-alias-state-success-primary)}
.zwf-run-status-error .zwf-run-status-word{color:var(--dsw-alias-state-error-primary)}
.zwf-run-status-warn .zwf-run-status-word{color:var(--dsw-alias-state-warn-primary)}
.zwf-run-status-reason{color:var(--dsw-alias-label-secondary)}
.zwf-status-sep{opacity:.5}
.zwf-chip-inline{display:inline-flex;align-items:center;gap:5px;flex:none;max-width:100%;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;min-width:0}
.zwf-chip-inline-glyph{display:inline-flex;flex:none;opacity:.8}
.zwf-chip-inline-warn{color:var(--dsw-alias-state-warn-primary)}
.zwf-chip-inline-link{cursor:pointer;color:var(--dsw-alias-brand-primary)}
.zwf-chip-inline-link:hover{text-decoration:underline}
.zwf-status-rejection{display:flex;flex-direction:column;gap:2px;width:100%;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
.zwf-status-rejection-detail{margin:0;max-height:96px;overflow:auto;padding:4px 6px;border-radius:6px;background:color-mix(in oklab,var(--dsw-alias-label-primary) 5%,transparent);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.zwf-health{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.zwf-health-sep{opacity:.45}
.zwf-leftover{margin:2px 0 0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-warn-primary)}
/* provenance */
.zwf-provenance{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;padding:6px 16px 0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.zwf-provenance-args{display:grid;grid-template-columns:minmax(64px,auto) 1fr;gap:2px 10px;width:100%;margin:2px 0 0;font-size:11px;line-height:16px}
.zwf-provenance-args dt{color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis}
.zwf-provenance-args dd{margin:0;min-width:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-provenance-settings{opacity:.9}
.zwf-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:10.5px;line-height:18px}
/* result states */
.zwf-result-block{display:flex;flex-direction:column;gap:4px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1)}
.zwf-result-title{margin:0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary)}
.zwf-result-body{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-result-warn{color:var(--dsw-alias-state-warn-primary)}
.zwf-result-error{border-color:color-mix(in oklab,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 7%,transparent)}
.zwf-result-message{margin:0;max-height:220px;overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere}
.zwf-result-preview{margin:0;max-height:180px;overflow:auto;padding:6px 8px;border-radius:6px;background:color-mix(in oklab,var(--dsw-alias-label-primary) 5%,transparent);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;white-space:pre-wrap}
.zwf-result-untracked{border-style:dashed;background:color-mix(in oklab,var(--dsw-alias-label-primary) 4%,transparent)}
.zwf-questions-unknown{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}
/* settings popover */
.zwf-settings-popover{display:flex;flex-direction:column;gap:10px;margin:8px 16px 0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px rgb(0 0 0 / .2)}
.zwf-settings-head{display:flex;align-items:center;gap:8px}
.zwf-settings-title{flex:1;font-size:13px;line-height:20px;font-weight:600}
.zwf-settings-row{display:flex;flex-direction:column;gap:4px;min-width:0}
.zwf-settings-label{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.zwf-settings-model{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.zwf-settings-trigger{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.zwf-settings-model-badge{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.zwf-settings-note{margin:0;flex-basis:100%;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-settings-bound{display:flex;align-items:center;gap:6px}
.zwf-settings-step{box-sizing:border-box;width:24px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1;cursor:pointer}
.zwf-settings-step:disabled{opacity:.4;cursor:default}
.zwf-settings-bound-value{min-width:24px;text-align:center;font-size:12px;font-variant-numeric:tabular-nums}
.zwf-settings-default{font-size:11px;color:var(--dsw-alias-label-secondary)}
.zwf-settings-consequence{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.zwf-settings-rejection{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-warn-primary)}
.zwf-settings-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px}
/* --------------------------------- timeline -------------------------------- */
.zwf-timeline{display:flex;flex-direction:column;min-width:0;flex:none}
.zwf-timeline-frame{position:relative;min-width:0}
.zwf-timeline-scroller{overflow-x:auto;overflow-y:hidden;padding-bottom:2px;scrollbar-width:none}
.zwf-timeline-scroller::-webkit-scrollbar{display:none}
.zwf-timeline-scroller[data-timeline-fade="both"],.zwf-timeline-scroller[data-timeline-fade="left"],.zwf-timeline-scroller[data-timeline-fade="right"]{mask-image:linear-gradient(90deg,transparent 0,#000 18px,#000 calc(100% - 18px),transparent 100%)}
.zwf-timeline-scroller[data-timeline-fade="left"]{mask-image:linear-gradient(90deg,transparent 0,#000 18px,#000 100%)}
.zwf-timeline-scroller[data-timeline-fade="right"]{mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 18px),transparent 100%)}
.zwf-timeline-canvas{position:relative}
.zwf-timeline-svg{position:absolute;top:0;left:0;pointer-events:none;overflow:visible}
.zwf-rail{stroke:color-mix(in oklab,var(--dsw-alias-label-primary) 22%,transparent);stroke-width:1;fill:none}
.zwf-rail-chevron{stroke:color-mix(in oklab,var(--dsw-alias-label-primary) 32%,transparent);stroke-width:1;fill:none}
.zwf-arc{stroke:color-mix(in oklab,var(--dsw-alias-brand-primary) 45%,transparent);stroke-width:1;fill:none}
.zwf-fills{position:absolute;top:0;left:0;height:100%;pointer-events:none}
.zwf-fill-frame{position:absolute;top:0;height:100%;border-radius:8px;background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 8%,transparent)}
.zwf-fill-heads{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none}
.zwf-fill-head{position:absolute;top:2px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:14px;color:var(--dsw-alias-state-warn-primary);opacity:.9}
.zwf-station{position:absolute;top:0;display:flex;flex-direction:column;min-width:0}
.zwf-station-button{display:block;width:100%;height:24px;padding:0 4px 0 0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.zwf-station-head{display:flex;align-items:center;gap:5px;height:24px;min-width:0}
.zwf-station-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;font-weight:500}
.zwf-station-stats{display:inline-flex;align-items:center;gap:6px;flex:none;margin-left:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-station-fraction{font-variant-numeric:tabular-nums;opacity:.85}
.zwf-station-rounds{opacity:.65}
.zwf-station-caret{flex:none;width:0;height:0;border-left:3px solid transparent;border-right:3px solid transparent;border-top:3px solid color-mix(in oklab,var(--dsw-alias-label-primary) 40%,transparent)}
.zwf-station-hole{flex:none;font-size:10.5px;line-height:16px;color:var(--dsw-alias-state-warn-primary);white-space:nowrap}
.zwf-station-script{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;cursor:pointer}
.zwf-station-pills{position:absolute;left:6px;display:flex;flex-direction:column}
.zwf-timeline-tail{position:absolute;top:6px;width:8px;height:1px;background:color-mix(in oklab,var(--dsw-alias-label-primary) 22%,transparent)}
.zwf-timeline-leader{display:none}
.zwf-ledge{position:absolute;top:0;display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 4px;border:0;border-radius:6px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;cursor:pointer;z-index:2;box-shadow:0 0 0 6px var(--dsw-alias-bg-base)}
.zwf-ledge-left{left:0}
.zwf-ledge-right{right:0}
.zwf-ledge-more{font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.zwf-ledge-lamp{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);opacity:.7}
.zwf-timeline-bar{position:relative;height:3px;margin:4px 2px 0;border-radius:999px;background:var(--dsw-alias-bg-layer-2)}
.zwf-timeline-thumb{position:absolute;top:0;height:3px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-label-primary) 30%,transparent)}
/* --------------------------------- roster ---------------------------------- */
.zwf-pill{box-sizing:border-box;display:inline-flex;align-items:center;min-width:0;max-width:100%;border-radius:999px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left}
.zwf-pill-row{height:24px;gap:6px;padding:0 6px 0 4px;font-size:12px;line-height:18px}
.zwf-pill-full{height:32px;gap:8px;padding:0 10px 0 8px;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px}
.zwf-pill-open{cursor:pointer;border:1px solid transparent;background:transparent}
.zwf-pill-open:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,transparent);border-color:var(--dsw-alias-border-l1)}
.zwf-pill-open:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-pill-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-pill-name-idle{color:var(--dsw-alias-label-secondary)}
.zwf-pill-note{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-pill-model{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary);opacity:.85}
.zwf-pill-asking{display:inline-flex;flex:none;color:var(--dsw-alias-state-warn-primary)}
.zwf-pill-tail{display:inline-grid;flex:none;place-items:center;width:14px;height:14px}
.zwf-pill-tail>*{grid-area:1/1}
.zwf-pill-go{display:grid;place-items:center;width:14px;height:14px;border-radius:4px;color:var(--dsw-alias-label-secondary);opacity:0}
.zwf-agent-pill:hover .zwf-pill-go{opacity:1}
.zwf-pill-status{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.zwf-pill-status-success{color:var(--dsw-alias-state-success-primary)}
.zwf-pill-status-error{color:var(--dsw-alias-state-error-primary)}
.zwf-pill-ring{display:inline-block;width:9px;height:9px;border:1.5px solid color-mix(in oklab,var(--dsw-alias-label-primary) 35%,transparent);border-radius:50%}
.zwf-avatar-stack{display:inline-flex;align-items:center;gap:2px}
.zwf-avatar-stacked{border-radius:5px;box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base)}
.zwf-avatar-more{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.zwf-meter4{display:inline-flex;align-items:center;gap:1px;width:44px;height:3px;border-radius:999px;overflow:hidden;flex:none}
.zwf-meter4-mini{width:28px}
.zwf-meter4-seg{height:3px;border-radius:999px}
.zwf-meter4-done{background:var(--dsw-alias-state-success-primary)}
.zwf-meter4-failed{background:var(--dsw-alias-state-error-primary)}
.zwf-meter4-running{background:var(--dsw-alias-state-warn-primary)}
.zwf-meter4-pending{background:color-mix(in oklab,var(--dsw-alias-label-primary) 18%,transparent)}
.zwf-tally{display:inline-flex;align-items:center;gap:8px;flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-tally-item{display:inline-flex;align-items:center;gap:3px}
.zwf-door{display:flex;align-items:center;gap:8px;width:100%;height:28px;margin-top:2px;padding:0 6px;border:0;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}
.zwf-door:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 7%,transparent)}
.zwf-door[data-door="open"]{background:color-mix(in oklab,var(--dsw-alias-label-primary) 7%,transparent)}
.zwf-door-avatars{display:inline-flex;flex:none}
.zwf-door-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-door-chevron{display:inline-flex;flex:none;transition:transform .12s}
.zwf-door-chevron-open{transform:rotate(180deg)}
.zwf-roll{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 8px;margin-top:4px;min-width:0}
.zwf-roll-heading{grid-column:1/-1;display:flex;align-items:center;gap:5px;height:22px;margin-top:4px;padding-left:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-roll-count{font-weight:600;opacity:.9}
.zwf-roll-rule{flex:1;height:1px;background:var(--dsw-alias-border-l1)}
.zwf-roll-unlisted{grid-column:1/-1;margin:2px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);opacity:.85}
.zwf-lamp{display:inline-block;flex:none;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.zwf-lamp-running{background:var(--dsw-alias-state-warn-primary);animation:zwf-lamp-pulse 1.6s ease-in-out infinite}
.zwf-lamp-done{background:var(--dsw-alias-state-success-primary)}
.zwf-lamp-failed{background:var(--dsw-alias-state-error-primary)}
.zwf-lamp-pending{background:var(--dsw-alias-bg-base);box-shadow:inset 0 0 0 1.5px color-mix(in oklab,var(--dsw-alias-label-primary) 35%,transparent)}
.zwf-lamp-hole-waiting{box-shadow:inset 0 0 0 1.5px var(--dsw-alias-state-warn-primary)}
.zwf-lamp-hole-open{box-shadow:inset 0 0 0 1.5px color-mix(in oklab,var(--dsw-alias-label-primary) 25%,transparent)}
@keyframes zwf-lamp-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.zwf-lamp-running{animation:none}}
/* ------------------------------- phase list -------------------------------- */
.zwf-phases{display:flex;flex-direction:column;min-width:0;position:relative}
.zwf-phases::before{content:"";position:absolute;left:18px;top:8px;bottom:10px;width:1px;background:color-mix(in oklab,var(--dsw-alias-label-primary) 16%,transparent)}
.zwf-fill-frames{display:none}
.zwf-spine{position:absolute;left:18px;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.zwf-fill-heading{display:flex;align-items:center;gap:6px;height:22px;padding-left:14px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px}
.zwf-fill-heading-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-state-warn-primary)}
.zwf-fill-heading-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-phase{display:flex;flex-direction:column;min-width:0;border-radius:8px}
.zwf-phase[data-phase-open="true"]{background:color-mix(in oklab,var(--dsw-alias-label-primary) 3%,transparent)}
.zwf-phase-landed{animation:zwf-landed 1.4s ease-out}
@keyframes zwf-landed{from{background:color-mix(in oklab,var(--dsw-alias-brand-primary) 16%,transparent)}to{background:transparent}}
.zwf-phase-toggle{display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 10px 0 14px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:8px}
.zwf-phase-toggle:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 5%,transparent)}
.zwf-phase-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.zwf-phase-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;font-weight:500}
.zwf-phase-name-idle{color:var(--dsw-alias-label-secondary);font-weight:400}
.zwf-phase-fillmark{display:inline-flex;align-items:center;justify-content:center;flex:none;height:16px;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.zwf-phase-holew{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary);white-space:nowrap}
.zwf-phase-right{display:inline-flex;align-items:center;gap:8px;flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-phase-fraction{font-variant-numeric:tabular-nums;opacity:.85}
.zwf-phase-rounds{opacity:.65}
.zwf-phase-cluster{display:inline-flex;align-items:center;gap:2px}
.zwf-chevron{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary);transition:transform .12s}
.zwf-chevron-open{transform:rotate(90deg)}
.zwf-phase-body{display:flex;flex-direction:column;gap:4px;padding:0 10px 8px 22px;min-width:0}
.zwf-roster-pins{display:flex;flex-direction:column;gap:3px;min-width:0}
.zwf-roster-pin{display:flex;flex-direction:column;gap:2px;min-width:0}
.zwf-hole-waiting{display:flex;flex-direction:column;gap:2px;padding:4px 0 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-hole-waiting-text{color:var(--dsw-alias-state-warn-primary)}
.zwf-hole-prompt{margin:0;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow:auto}
.zwf-question{display:flex;align-items:flex-start;gap:6px;margin-left:2px;padding:5px 8px;border-radius:8px;background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 10%,transparent);font-size:12px;line-height:18px;min-width:0}
.zwf-question-glyph{display:inline-flex;flex:none;margin-top:2px;color:var(--dsw-alias-state-warn-primary)}
.zwf-question-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.zwf-question-asker{font-size:10.5px;line-height:16px;font-weight:500}
.zwf-question-text{white-space:pre-wrap;overflow-wrap:anywhere}
.zwf-question-context{margin:0;font-size:11px;line-height:16px;opacity:.8;white-space:pre-wrap;overflow-wrap:anywhere}
.zwf-question-meta{display:inline-flex;flex-direction:column;align-items:flex-end;gap:2px;flex:none;font-size:10.5px;line-height:16px;opacity:.8}
.zwf-question-qid{opacity:.7;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-orphan-questions{display:flex;flex-direction:column;gap:4px;margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1)}
.zwf-orphan-title{margin:0;font-size:11.5px;line-height:17px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.zwf-graph-unavailable{margin:0;padding:8px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
/* ---------------------------------- actor ---------------------------------- */
.zwf-actor-wrap{padding:0 0 4px}
.zwf-actor{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.zwf-actor-glyph{display:inline-flex;color:var(--dsw-alias-label-secondary)}
.zwf-actor-title{margin:0;font-size:13px;line-height:19px;font-weight:500}
.zwf-actor-body{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-actor-row{display:flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;line-height:17px}
.zwf-actor-phase{flex:none;color:var(--dsw-alias-label-secondary)}
.zwf-actor-brief{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-actor-meta{flex:none;color:var(--dsw-alias-label-secondary);opacity:.85}
/* -------------------------------- artifacts -------------------------------- */
.zwf-artifacts{display:flex;flex-direction:column;min-width:0;border-top:1px solid color-mix(in oklab,var(--dsw-alias-border-l1) 70%,transparent);margin-top:4px}
.zwf-artifacts-toggle{display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 2px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.zwf-artifacts-toggle:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 5%,transparent)}
.zwf-artifacts-title{font-size:13px;line-height:20px;font-weight:500}
.zwf-artifacts-count{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.zwf-artifacts-primary-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.zwf-artifacts-body{display:flex;flex-direction:column;gap:6px;padding-bottom:10px;min-width:0}
.zwf-artifact-primary-body{display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow:auto;min-width:0}
.zwf-artifact-primary{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.zwf-artifact-head{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap}
.zwf-artifact-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-brand-primary)}
.zwf-artifact-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:19px;font-weight:500}
.zwf-artifact-badge{flex:none;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-artifact-bytes{flex:none;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-artifact-chips{display:inline-flex;align-items:center;gap:4px;flex:none}
.zwf-artifact-chip{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer}
.zwf-artifact-chip:disabled{opacity:.35;cursor:default}
.zwf-flip{transform:rotate(180deg)}
.zwf-artifact-version{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.zwf-artifact-chips-more{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.zwf-artifact-desc{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.zwf-artifact-text{margin:0;max-height:320px;overflow:auto;padding:6px 8px;border-radius:6px;background:color-mix(in oklab,var(--dsw-alias-label-primary) 4%,transparent);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.zwf-artifact-empty{display:flex;align-items:center;justify-content:center;min-height:72px;padding:8px;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.zwf-artifact-table{overflow:auto;max-height:320px;min-width:0}
.zwf-artifact-table table{border-collapse:collapse;width:100%;font-size:11.5px;line-height:17px}
.zwf-artifact-table th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary);padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.zwf-artifact-table td{padding:3px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-artifact-index{display:flex;flex-direction:column;gap:2px;min-width:0}
.zwf-artifact-row{display:flex;align-items:center;gap:7px;width:100%;min-width:0;height:30px;padding:0 8px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.zwf-artifact-row:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 5%,transparent);border-color:var(--dsw-alias-border-l1)}
.zwf-artifact-row-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.zwf-artifact-row-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}
.zwf-artifact-row-meta{flex:none;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-artifact-row-version{flex:none;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary);opacity:.75}
.zwf-artifact-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,180px));gap:8px;max-height:50vh;overflow:auto;padding-bottom:4px}
.zwf-artifact-tile{display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0}
.zwf-artifact-tile:hover{border-color:var(--dsw-alias-border-l2)}
.zwf-artifact-tile-glyph{display:inline-flex;color:var(--dsw-alias-brand-primary)}
.zwf-artifact-tile-title{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;font-weight:500}
.zwf-artifact-tile-meta{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-artifact-tile-version{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary);opacity:.75}
/* ------------------------------ script steps ------------------------------- */
.zwf-ws{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.zwf-ws-pane{display:flex;flex-direction:column;height:100%;min-height:0}
.zwf-ws-head-block{display:flex;flex-direction:column;gap:6px;flex:none;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.zwf-ws-headline{display:flex;align-items:center;gap:10px;min-width:0}
.zwf-ws-brand{display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.zwf-ws-titles{display:flex;flex-direction:column;min-width:0;flex:1}
.zwf-ws-eyebrow{font-size:10px;line-height:14px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.zwf-ws-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;font-weight:500}
.zwf-ws-run-status{flex:none;font-weight:500}
.zwf-ws-summary{display:flex;align-items:center;gap:6px;padding-left:40px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.zwf-ws-dot{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.6}
.zwf-ws-state{padding:8px 0}
.zwf-ws-list{display:flex;flex-direction:column;min-height:0;flex:1;overflow-y:auto;padding:4px 8px 28px}
.zwf-ws-chapter{display:flex;flex-direction:column;gap:2px;min-width:0}
.zwf-ws-chapter-head{display:flex;align-items:center;gap:6px;margin:18px 8px 6px;min-width:0}
.zwf-ws-chapter-head:first-child{margin-top:8px}
.zwf-ws-chapter-name{white-space:nowrap;font-size:13px;line-height:19px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis}
.zwf-ws-round{display:inline-flex;align-items:center;gap:3px;height:16px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px}
.zwf-ws-rule{flex:1;height:1px;background:var(--dsw-alias-border-l1);min-width:8px}
.zwf-ws-chapter-meta{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.zwf-ws-card{display:grid;grid-template-columns:26px minmax(0,1fr) auto;column-gap:10px;align-items:start;padding:6px 8px 8px;border-radius:9px;min-width:0;animation:zwf-ws-entry .18s ease-out both}
@keyframes zwf-ws-entry{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.zwf-ws-card{animation:none}}
.zwf-ws-card:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 4%,transparent)}
.zwf-ws-glyph{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.zwf-ws-card-failed .zwf-ws-glyph{background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
.zwf-ws-card-running .zwf-ws-glyph{background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}
.zwf-ws-main{display:flex;flex-direction:column;gap:2px;min-width:0;outline:none}
.zwf-ws-main:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}
.zwf-ws-head{display:flex;align-items:center;gap:6px;min-width:0}
.zwf-ws-verb{flex:none;font-size:12.5px;line-height:18px;font-weight:500}
.zwf-ws-subject{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-ws-result{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);min-width:0}
.zwf-ws-status{display:inline-flex;align-items:center;gap:3px;flex:none}
.zwf-ws-status-failed{color:var(--dsw-alias-state-error-primary)}
.zwf-ws-status-running{color:var(--dsw-alias-state-warn-primary)}
.zwf-ws-status-completed{color:var(--dsw-alias-state-success-primary)}
.zwf-ws-part{flex:none;opacity:.9}
.zwf-ws-part-error{color:var(--dsw-alias-state-error-primary)}
.zwf-ws-peek{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);opacity:.8}
.zwf-ws-body{display:flex;flex-direction:column;gap:6px;margin-top:6px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.zwf-ws-command{display:flex;align-items:flex-start;gap:6px;min-width:0}
.zwf-ws-prompt{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.zwf-ws-command-text{margin:0;min-width:0;flex:1;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.zwf-ws-args-truncated{flex:none;font-size:10.5px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}
.zwf-ws-result-line{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-ws-result-error{margin:0;padding:6px 8px;border-radius:6px;background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}
.zwf-ws-lines{list-style:none;margin:0;padding:4px 0;max-height:300px;overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:18px}
.zwf-ws-lines li{display:flex;gap:10px;min-width:0;padding:0 4px}
.zwf-ws-line-no{flex:none;width:22px;text-align:right;color:var(--dsw-alias-label-secondary);opacity:.7}
.zwf-ws-line-text{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.zwf-ws-line-more{color:var(--dsw-alias-label-secondary);opacity:.8}
.zwf-ws-pre{margin:0;max-height:300px;overflow:auto;padding:6px 8px;border-radius:6px;background:color-mix(in oklab,var(--dsw-alias-label-primary) 4%,transparent);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere}
.zwf-ws-stderr{margin:0;max-height:200px;overflow:auto;padding:6px 8px;border-radius:6px;background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere}
.zwf-ws-stderr-label{display:block;font-size:10px;line-height:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-state-error-primary)}
.zwf-ws-note{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-ws-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.zwf-ws-parts{flex:1;min-width:0}
.zwf-ws-replayed{flex:none;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:10.5px}
.zwf-ws-when{display:inline-flex;align-items:center;gap:4px;flex:none;justify-self:end;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.zwf-ws-truncated{margin:6px 0 0;text-align:center;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
`;

WF_STYLE_PARTS.push(WF_DETAIL_CSS);
