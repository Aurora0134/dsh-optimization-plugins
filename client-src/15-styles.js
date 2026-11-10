/* CSS for the workflow workspace surfaces. Host theme tokens only. */
const WF_STYLE_PARTS = [];

const WF_UI_CSS = `
.zwf-page{box-sizing:border-box;display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.zwf-page-scroll{box-sizing:border-box;width:100%;overflow-y:auto;flex:1}
.zwf-page-inner{box-sizing:border-box;max-width:920px;margin:0 auto;padding:28px 24px 48px}
.zwf-page-head{display:flex;align-items:flex-start;gap:16px;margin-bottom:6px}
.zwf-page-titles{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.zwf-page-title{margin:0;font-size:20px;line-height:28px;font-weight:600;color:var(--dsw-alias-label-primary)}
.zwf-page-sub{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.zwf-page-actions{display:flex;align-items:center;gap:8px}
.zwf-page-toolbar{display:flex;align-items:center;gap:8px;margin:18px 0 14px}
.zwf-page-toolbar .zwf-tabs{flex:1}
.zwf-grow{flex:1;min-width:0}
.zwf-muted{color:var(--dsw-alias-label-secondary)}
.zwf-caption{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.zwf-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}
.zwf-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .12s,border-color .12s,color .12s}
.zwf-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.zwf-btn:disabled{opacity:.5;cursor:default}
.zwf-btn-sm{height:28px;padding:0 10px;font-size:13px}
.zwf-btn-md{height:34px;padding:0 14px;font-size:13px}
.zwf-btn-icon{width:28px;height:28px;padding:0;border-radius:var(--dsw-radius-sm,8px)}
.zwf-btn-iconic{padding-left:9px;padding-right:11px}
.zwf-btn-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none}
.zwf-btn-label{display:inline-block;min-width:0;overflow:hidden;text-overflow:ellipsis}
.zwf-btn-ghost:hover:not(:disabled){background:color-mix(in oklab,var(--dsw-alias-label-primary) 7%,transparent)}
.zwf-btn-subtle{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.zwf-btn-subtle:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2)}
.zwf-btn-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.zwf-btn-primary:hover:not(:disabled){filter:brightness(1.06)}
.zwf-btn-danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
.zwf-spinner{box-sizing:border-box;display:inline-block;width:16px;height:16px;border:1.5px solid color-mix(in oklab,var(--dsw-alias-label-secondary) 30%,transparent);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:zwf-spin .8s linear infinite;vertical-align:-3px}
.zwf-spinner-inline{margin-right:6px}
@keyframes zwf-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.zwf-spinner{animation-duration:2s}.zwf-btn{transition:none}}
.zwf-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:44px 24px;text-align:center}
.zwf-empty-glyph{display:flex;color:var(--dsw-alias-label-secondary);opacity:.7;margin-bottom:2px}
.zwf-empty-title{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.zwf-empty-body{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);max-width:420px}
.zwf-empty-action{margin-top:10px}
.zwf-error{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid color-mix(in oklab,var(--dsw-alias-state-error-primary) 35%,transparent);border-radius:var(--dsw-radius-sm,8px);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 8%,transparent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.zwf-error-glyph{display:flex;color:var(--dsw-alias-state-error-primary);flex:none}
.zwf-error-text{flex:1;min-width:0;overflow-wrap:anywhere}
.zwf-dot{display:inline-block;flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.zwf-dot-success{background:var(--dsw-alias-state-success-primary)}
.zwf-dot-error{background:var(--dsw-alias-state-error-primary)}
.zwf-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.zwf-dot-idle{background:var(--dsw-alias-state-idle-primary);opacity:.6}
.zwf-status-word{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.zwf-status-word-success{color:var(--dsw-alias-state-success-primary)}
.zwf-status-word-error{color:var(--dsw-alias-state-error-primary)}
.zwf-status-word-warn{color:var(--dsw-alias-state-warn-primary)}
.zwf-section-head{display:flex;align-items:center;gap:8px;min-width:0;margin:22px 0 10px}
.zwf-section-title{margin:0;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);flex:none}
.zwf-section-count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);flex:none}
.zwf-section-line{flex:1;height:1px;background:var(--dsw-alias-border-l1);min-width:8px}
.zwf-card{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);transition:border-color .12s,background-color .12s}
.zwf-card:hover{border-color:var(--dsw-alias-border-l2)}
.zwf-card-head{display:flex;align-items:flex-start;gap:10px;min-width:0}
.zwf-card-glyph{display:flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.zwf-card-titles{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.zwf-card-name{margin:0;font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-card-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-card-meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}
.zwf-card-meta code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px}
.zwf-card-actions{display:flex;align-items:center;gap:6px;flex:none}
.zwf-badge{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:20px;font-weight:500}
.zwf-badge-brand{background:color-mix(in oklab,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}
.zwf-rowlist{display:flex;flex-direction:column;gap:2px}
.zwf-rowmain{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.zwf-rowtitle{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-rowsub{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}
.zwf-rowtime{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);opacity:.8}
.zwf-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2)}
.zwf-tab{box-sizing:border-box;height:26px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;font-weight:500;cursor:pointer;white-space:nowrap}
.zwf-tab:hover{color:var(--dsw-alias-label-primary)}
.zwf-tab-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1)}
.zwf-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.zwf-menu{position:absolute;z-index:60;top:calc(100% + 4px);right:0;min-width:180px;padding:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-shadow-lv3)}
.zwf-menu-item{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.zwf-menu-item:hover:not(:disabled){background:color-mix(in oklab,var(--dsw-alias-label-primary) 7%,transparent)}
.zwf-menu-item:disabled{opacity:.45;cursor:default}
.zwf-menu-item-danger{color:var(--dsw-alias-state-error-primary)}
.zwf-menu-glyph{display:inline-flex;color:var(--dsw-alias-label-secondary)}
.zwf-menu-item-danger .zwf-menu-glyph{color:inherit}
.zwf-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1)}
.zwf-anchor{position:relative}
.zwf-modal-layer{position:fixed;z-index:80;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1)}
.zwf-modal{box-sizing:border-box;display:flex;flex-direction:column;width:min(460px,100%);max-height:min(760px,90vh);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,14px);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent);overflow:hidden}
.zwf-modal-wide{width:min(680px,100%)}
.zwf-modal-head{display:flex;align-items:center;gap:12px;padding:16px 18px 10px}
.zwf-modal-title{margin:0;flex:1;font-size:15px;line-height:22px;font-weight:600}
.zwf-modal-body{display:flex;flex-direction:column;gap:14px;padding:6px 18px 18px;overflow-y:auto;min-height:0}
.zwf-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1)}
.zwf-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.zwf-field-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.zwf-field-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-input,.zwf-textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:6px 9px}
.zwf-input{height:30px}
.zwf-textarea{resize:vertical;min-height:72px}
.zwf-input:focus,.zwf-textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;border-color:transparent}
.zwf-input::placeholder,.zwf-textarea::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7}
.zwf-check{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.zwf-detail-head{display:flex;flex-direction:column;gap:8px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.zwf-detail-headline{display:flex;align-items:flex-start;gap:10px;min-width:0}
.zwf-detail-title{margin:0;font-size:15px;line-height:22px;font-weight:600;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-detail-sub{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-detail-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.zwf-detail-body{flex:1;min-height:0;overflow-y:auto;padding:14px 16px 28px;display:flex;flex-direction:column;gap:16px}
.zwf-detail-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.zwf-detail-section-title{margin:0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.zwf-kv{display:grid;grid-template-columns:minmax(84px,auto) 1fr;gap:6px 12px;font-size:12px;line-height:18px}
.zwf-kv-key{color:var(--dsw-alias-label-secondary)}
.zwf-kv-val{color:var(--dsw-alias-label-primary);min-width:0;overflow-wrap:anywhere}
.zwf-code{margin:0;padding:9px 11px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:color-mix(in oklab,var(--dsw-alias-label-primary) 4%,transparent);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
.zwf-log{display:flex;flex-direction:column;gap:3px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.zwf-log-row{display:flex;gap:8px;min-width:0}
.zwf-log-phase{flex:none;color:var(--dsw-alias-brand-primary)}
.zwf-log-text{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.zwf-empty-inline{padding:18px 12px;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.zwf-progress{display:flex;flex-direction:column;gap:6px}
.zwf-progress-row{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px}
.zwf-progress-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zwf-progress-count{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.zwf-meter{flex:none;width:64px;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.zwf-meter-fill{height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary)}
.zwf-meter-fill-error{background:var(--dsw-alias-state-error-primary)}
.zwf-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}
.zwf-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.zwf-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.zwf-chip-live .zwf-dot{box-shadow:0 0 0 3px color-mix(in oklab,var(--dsw-alias-state-success-primary) 16%,transparent)}
.zwf-stack{display:flex;flex-direction:column;gap:10px}
.zwf-inline{display:flex;align-items:center;gap:8px;min-width:0}
.zwf-wrap{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.zwf-link{border:0;background:transparent;padding:0;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;text-align:left}
.zwf-link:hover{text-decoration:underline}
.zwf-quote{margin:0;padding:8px 10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;max-height:160px;overflow:auto}
`;

WF_STYLE_PARTS.push(WF_UI_CSS);
