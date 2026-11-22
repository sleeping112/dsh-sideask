/**
 * All plugin CSS, injected INSIDE the shadow root.
 *
 * Rules:
 * - every class is prefixed `sa-` so nothing leaks if the shadow mount has to
 *   fall back to light DOM;
 * - colours come from `--dsw-*` theme tokens with literal fallbacks, so the
 *   window looks native in both light and dark themes and still renders if the
 *   tokens are missing;
 * - no `@import`, no external fonts, no `url()`: the bundle must stay self
 *   contained and CSP-friendly.
 */

export const PANEL_CSS = `
:host, .sa-root { all: initial; }
.sa-root {
  position: fixed;
  /* Above the app frame's chat/composer stacking. The window is body-mounted for
     this reason; staying below the chat composer makes the input unclickable. */
  z-index: 60;
  font: 13px/1.55 var(--dsw-font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  color: var(--dsw-alias-label-primary, #e9edf5);
  --sa-bg: var(--dsw-alias-bg-base, #16181d);
  --sa-bg-layer: var(--dsw-alias-bg-layer-1, #1e2128);
  --sa-fg: var(--dsw-alias-label-primary, #e9edf5);
  --sa-fg-weak: var(--dsw-alias-label-secondary, #a3acbd);
  --sa-border: var(--dsw-alias-border-l3, rgba(255,255,255,.12));
  --sa-accent: var(--dsw-alias-button-primary-fill, #4d7ef0);
  --sa-danger: var(--dsw-alias-label-danger, #ff6b6b);
  --sa-ok: var(--dsw-alias-label-success, #3fbf87);
  --sa-radius: 14px;
  --sa-shadow: var(--dsw-shadow-lv3, 0 18px 48px rgba(0,0,0,.42));
}
.sa-window {
  position: absolute;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--sa-radius);
  border: 1px solid var(--sa-border);
  background: var(--sa-bg);
  color: var(--sa-fg);
  box-shadow: var(--sa-shadow);
  backdrop-filter: blur(18px);
  box-sizing: border-box;
  min-width: 300px;
  min-height: 320px;
}
.sa-window[data-collapsed="true"] { height: auto !important; min-height: 0; }
.sa-window[data-collapsed="true"] .sa-body,
.sa-window[data-collapsed="true"] .sa-resize { display: none; }

.sa-head {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--sa-border);
  background: var(--sa-bg-layer);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.sa-head[data-dragging="true"] { cursor: grabbing; }
.sa-title { font-weight: 600; font-size: 13px; letter-spacing: .01em; white-space: nowrap; }
.sa-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--sa-accent); flex: none; }
.sa-dot[data-busy="true"] { animation: sa-pulse 1s ease-in-out infinite; }
@keyframes sa-pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
.sa-session {
  flex: 1 1 auto; min-width: 0;
  font-size: 11px; color: var(--sa-fg-weak);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sa-iconbtn {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 6px;
  border: 1px solid transparent; background: transparent; color: var(--sa-fg-weak);
  cursor: pointer; font-size: 13px; line-height: 1; padding: 0;
}
.sa-iconbtn:hover { background: rgba(127,127,127,.16); color: var(--sa-fg); }
.sa-iconbtn[aria-pressed="true"] { color: var(--sa-accent); }

.sa-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.sa-thread {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 10px 10px 4px; display: flex; flex-direction: column; gap: 9px;
  scrollbar-width: thin;
}
.sa-thread::-webkit-scrollbar { width: 8px; }
.sa-thread::-webkit-scrollbar-thumb { background: rgba(127,127,127,.28); border-radius: 4px; }

.sa-msg { display: flex; flex-direction: column; gap: 4px; }
.sa-msg-user { align-items: flex-end; }
.sa-bubble {
  max-width: 92%; border-radius: 10px; padding: 7px 9px;
  border: 1px solid var(--sa-border); background: var(--sa-bg-layer);
  white-space: pre-wrap; word-break: break-word;
}
.sa-msg-user .sa-bubble { background: color-mix(in srgb, var(--sa-accent) 26%, var(--sa-bg-layer)); border-color: transparent; }
.sa-msg-assistant .sa-bubble { max-width: 100%; }
.sa-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.sa-chip {
  border: 1px solid var(--sa-border); background: transparent; color: var(--sa-fg-weak);
  border-radius: 999px; padding: 1px 7px; font-size: 11px; cursor: pointer; line-height: 1.6;
}
.sa-chip:hover { color: var(--sa-fg); background: rgba(127,127,127,.14); }
.sa-cite {
  display: inline-flex; align-items: center; gap: 2px;
  border-radius: 5px; padding: 0 4px; margin: 0 1px;
  background: color-mix(in srgb, var(--sa-accent) 22%, transparent);
  color: var(--sa-accent); font-size: 11px; cursor: pointer; border: none;
  font-family: inherit;
}
.sa-cite:hover { background: color-mix(in srgb, var(--sa-accent) 34%, transparent); }
.sa-cite-num { font-weight: 600; }

.sa-empty { color: var(--sa-fg-weak); font-size: 12px; padding: 6px 2px; }
.sa-suggest { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
.sa-suggest button {
  text-align: left; border: 1px dashed var(--sa-border); background: transparent;
  color: var(--sa-fg-weak); border-radius: 8px; padding: 6px 8px; cursor: pointer; font-size: 12px;
  font-family: inherit;
}
.sa-suggest button:hover { color: var(--sa-fg); border-style: solid; }

.sa-error {
  border: 1px solid color-mix(in srgb, var(--sa-danger) 45%, transparent);
  background: color-mix(in srgb, var(--sa-danger) 12%, transparent);
  border-radius: 9px; padding: 8px 9px; display: flex; flex-direction: column; gap: 6px;
}
.sa-error-code { font-size: 11px; color: var(--sa-danger); font-weight: 600; letter-spacing: .02em; }
.sa-error-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.sa-btn {
  border: 1px solid var(--sa-border); background: var(--sa-bg-layer); color: var(--sa-fg);
  border-radius: 7px; padding: 4px 9px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.sa-btn:hover { background: rgba(127,127,127,.18); }
.sa-btn-primary { background: var(--sa-accent); border-color: var(--sa-accent); color: #fff; }
.sa-btn-primary:disabled { opacity: .5; cursor: default; }

.sa-composer { border-top: 1px solid var(--sa-border); padding: 8px 9px 9px; display: flex; flex-direction: column; gap: 6px; }
.sa-toolbar { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--sa-fg-weak); }
.sa-toggle { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
.sa-toggle input { margin: 0; accent-color: var(--sa-accent); }
.sa-token { margin-left: auto; font-variant-numeric: tabular-nums; cursor: pointer; }
.sa-token[data-over="true"] { color: var(--sa-danger); }
.sa-inputrow { display: flex; align-items: flex-end; gap: 6px; }
.sa-input {
  flex: 1 1 auto; resize: none; min-height: 34px; max-height: 132px;
  border-radius: 9px; border: 1px solid var(--sa-border); background: var(--sa-bg-layer);
  color: var(--sa-fg); padding: 7px 9px; font: inherit; outline: none;
  box-sizing: border-box;
}
.sa-input:focus { border-color: var(--sa-accent); }
.sa-send { flex: none; height: 34px; padding: 0 12px; border-radius: 9px; }
.sa-hint { font-size: 10px; color: var(--sa-fg-weak); opacity: .8; }
.sa-resize {
  position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 45%, var(--sa-border) 45%, var(--sa-border) 60%, transparent 60%);
  border-bottom-right-radius: var(--sa-radius);
}

.sa-pill {
  position: fixed; z-index: 60; display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 11px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--sa-border); background: var(--sa-bg); color: var(--sa-fg);
  box-shadow: var(--sa-shadow); font-family: inherit; font-size: 12px; user-select: none;
}
.sa-pill:hover { border-color: var(--sa-accent); }

.sa-panel-detail {
  position: absolute; right: 8px; top: 40px; z-index: 3;
  width: min(300px, calc(100% - 16px)); max-height: 60%;
  overflow: auto; border-radius: 10px; border: 1px solid var(--sa-border);
  background: var(--sa-bg); box-shadow: var(--sa-shadow); padding: 9px 10px; font-size: 11.5px;
}
.sa-menu {
  position: absolute; right: 8px; top: 40px; z-index: 4;
  width: min(300px, calc(100% - 16px)); max-height: 62%;
  display: flex; flex-direction: column;
  border-radius: 10px; border: 1px solid var(--sa-border);
  background: var(--sa-bg); box-shadow: var(--sa-shadow); padding: 8px 9px; font-size: 11.5px;
}
.sa-menu-head { display: flex; align-items: center; justify-content: space-between; font-weight: 600; color: var(--sa-fg); margin-bottom: 6px; }
.sa-menu-count { color: var(--sa-fg-weak); font-variant-numeric: tabular-nums; font-weight: 400; }
.sa-menu-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.sa-menu-empty { color: var(--sa-fg-weak); padding: 6px 2px; }
.sa-menu-item {
  display: flex; flex-direction: column; gap: 1px; text-align: left;
  border: 1px solid transparent; border-radius: 7px; padding: 5px 7px;
  background: transparent; color: var(--sa-fg); cursor: pointer; font: inherit;
}
.sa-menu-item:hover { background: rgba(127,127,127,.14); }
.sa-menu-item[data-active="true"] { border-color: var(--sa-accent); background: color-mix(in srgb, var(--sa-accent) 16%, transparent); }
.sa-menu-title { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-menu-meta { font-size: 10.5px; color: var(--sa-fg-weak); }
.sa-menu-actions { display: flex; gap: 5px; margin-top: 7px; padding-top: 6px; border-top: 1px solid var(--sa-border); }
.sa-menu-actions .sa-chip:disabled { opacity: .45; cursor: default; }

/* Pins + model rows under the composer toolbar. */
.sa-pins { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 8px 0; }
.sa-pins .sa-chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-pins .sa-chip[data-kind="pin"] { border-color: var(--sa-accent); }
.sa-ctxline { display: flex; gap: 4px; padding: 4px 8px 0; }
.sa-ctxline .sa-chip { font-size: 10.5px; }

/* Context items with exclusion checkboxes. */
.sa-detail-sub { margin-top: 6px; color: var(--sa-fg-weak); }
.sa-ctx-items { margin-top: 4px; display: flex; flex-direction: column; gap: 3px; }
.sa-ctx-item {
  display: flex; align-items: flex-start; gap: 5px; padding: 3px 4px;
  border-radius: 6px; border: 1px solid transparent; cursor: pointer;
}
.sa-ctx-item:hover { background: rgba(127,127,127,.12); }
.sa-ctx-item[data-excluded="true"] { opacity: .5; text-decoration: line-through; }
.sa-ctx-item input { margin-top: 2px; }
.sa-ctx-ref { color: var(--sa-accent); font-variant-numeric: tabular-nums; }
.sa-ctx-src { color: var(--sa-fg-weak); flex: 0 0 auto; }
.sa-ctx-text { color: var(--sa-fg); word-break: break-all; }
.sa-ctx-items .sa-chip { align-self: flex-start; margin-top: 2px; }
.sa-kv { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; color: var(--sa-fg-weak); }
.sa-kv b { color: var(--sa-fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.sa-degr { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; }
.sa-degr span { color: var(--sa-danger); }
.sa-detail-title { font-weight: 600; margin-bottom: 4px; color: var(--sa-fg); }
.sa-cite-pop {
  position: absolute; z-index: 4; max-width: min(320px, 88%);
  border: 1px solid var(--sa-border); background: var(--sa-bg); color: var(--sa-fg);
  border-radius: 9px; padding: 8px 9px; font-size: 11.5px; box-shadow: var(--sa-shadow);
  white-space: pre-wrap;
}
.sa-cite-pop .sa-cite-meta { color: var(--sa-fg-weak); font-size: 10.5px; margin-bottom: 3px; }

.sa-toast {
  position: absolute; left: 50%; bottom: 62px; transform: translateX(-50%);
  padding: 6px 10px; border-radius: 8px; font-size: 11.5px; max-width: 88%;
  background: var(--sa-bg-layer); border: 1px solid var(--sa-border); color: var(--sa-fg);
  box-shadow: var(--sa-shadow); z-index: 5;
}
.sa-toast[data-kind="error"] { border-color: color-mix(in srgb, var(--sa-danger) 50%, transparent); color: var(--sa-danger); }
.sa-toast[data-kind="ok"] { border-color: color-mix(in srgb, var(--sa-ok) 50%, transparent); color: var(--sa-ok); }

.sa-md-p { margin: 0 0 5px; }
.sa-md-p:last-child { margin-bottom: 0; }
.sa-md-h { font-weight: 600; margin: 4px 0 5px; }
.sa-md-list { margin: 0 0 5px; padding-left: 16px; }
.sa-md-code {
  display: block; overflow-x: auto; margin: 5px 0; padding: 7px 8px; border-radius: 8px;
  background: var(--dsw-alias-markdown-code-block, rgba(0,0,0,.28)); font-size: 11.5px;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: pre;
}
.sa-md-inline {
  padding: 0 3px; border-radius: 4px; font-size: 11.5px;
  background: var(--dsw-alias-markdown-code-block, rgba(0,0,0,.24));
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.sa-md-quote { margin: 4px 0; padding-left: 8px; border-left: 2px solid var(--sa-border); color: var(--sa-fg-weak); }
.sa-caret { display: inline-block; width: 6px; height: 13px; background: var(--sa-accent); vertical-align: text-bottom; animation: sa-blink 1s steps(1) infinite; margin-left: 1px; }
@keyframes sa-blink { 50% { opacity: 0 } }

/* Selection affordance: floats next to the current text selection. */
.sa-selbtn {
  position: fixed; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 4px;
  height: 28px; padding: 0 10px; border-radius: 999px;
  border: 1px solid var(--sa-border); background: var(--sa-bg); color: var(--sa-fg);
  box-shadow: var(--sa-shadow); font: 12px/1 inherit; cursor: pointer; user-select: none;
}
.sa-selbtn:hover { border-color: var(--sa-accent); color: var(--sa-accent); }

@media (prefers-color-scheme: light) {
  .sa-root {
    --sa-bg: var(--dsw-alias-bg-base, #ffffff);
    --sa-bg-layer: var(--dsw-alias-bg-layer-1, #f6f7f9);
    --sa-fg: var(--dsw-alias-label-primary, #1c1f26);
    --sa-fg-weak: var(--dsw-alias-label-secondary, #5d6673);
    --sa-border: var(--dsw-alias-border-l3, rgba(0,0,0,.12));
  }
}
@media (prefers-reduced-motion: reduce) {
  .sa-dot, .sa-caret, .sa-window { animation: none !important; transition: none !important; }
}
`
