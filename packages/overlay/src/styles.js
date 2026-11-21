/** All overlay CSS. Scoped to the closed shadow root, so nothing leaks into or from the page. */
export const OVERLAY_CSS = `
.sw-root{position:fixed;inset:0;pointer-events:none;overflow:hidden;font:500 12px/1.3 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#f4f4f5;--accent:#0D99FF;--ink:#0b0c10;--ease:cubic-bezier(.22,1,.36,1);-webkit-font-smoothing:antialiased}
.sw-root *{box-sizing:border-box}

/* Rulers */
.sw-ruler,.sw-ruler-corner{position:fixed;left:0;top:0;opacity:0;transition:opacity .3s ease;z-index:1}
.sw-ruler[data-on],.sw-ruler-corner[data-on]{opacity:1}
.sw-ruler-corner{width:18px;height:18px;background:#fafafb;border-right:1px solid rgba(17,24,39,.14);border-bottom:1px solid rgba(17,24,39,.14);z-index:2}

/* Selections */
.sw-selections{position:fixed;inset:0;z-index:3}
.sw-sel{position:fixed;left:0;top:0;border:1.5px solid var(--sel,var(--accent));border-radius:1px;transition:opacity .24s ease;will-change:transform,width,height}
.sw-sel-thin{border-width:1px;opacity:.75}
.sw-sel[data-out]{opacity:0}
.sw-handle{position:absolute;width:7px;height:7px;background:#fff;border:1.5px solid var(--sel,var(--accent));border-radius:1px}
.sw-sel-thin .sw-handle{display:none}
.sw-handle-nw{left:-4px;top:-4px}.sw-handle-ne{right:-4px;top:-4px}.sw-handle-sw{left:-4px;bottom:-4px}.sw-handle-se{right:-4px;bottom:-4px}
.sw-sel-badge{position:absolute;left:50%;top:calc(100% + 6px);transform:translateX(-50%);padding:2px 6px;border-radius:4px;background:var(--sel,var(--accent));color:#fff;font:600 10px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
.sw-sel-badge-inside{top:auto;bottom:6px}
.sw-sel-thin .sw-sel-badge{display:none}
.sw-ghost{position:fixed;left:0;top:0;display:grid;place-items:center;background:#d9dbe0;color:#8b90a0;border-radius:2px;transition:opacity .2s ease;overflow:hidden}
.sw-ghost svg{width:22px;height:22px;max-width:60%;max-height:60%}
.sw-ghost[data-out]{opacity:0}
.sw-flash{position:fixed;left:0;top:0;background:var(--sel,var(--accent));opacity:.22;border-radius:2px;animation:sw-flash .46s ease-out forwards}
@keyframes sw-flash{to{opacity:0}}
.sw-guide{position:fixed;left:0;top:0;background:rgba(255,59,48,.75);opacity:0;transition:opacity .2s ease}
.sw-guide-x{width:1px;height:100%}.sw-guide-y{height:1px;width:100%}

/* Pins */
.sw-pins{position:fixed;inset:0;z-index:4}
.sw-pin{pointer-events:auto;position:fixed;left:0;top:0;display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 7px;border:2px solid #fff;border-radius:999px 999px 999px 4px;font:700 10px/1 ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.32);animation:sw-pin-in .36s var(--ease) both;transition:opacity .2s ease}
.sw-pin:hover{filter:brightness(1.08)}
.sw-pin:focus-visible{outline:2px solid #fff;outline-offset:2px}
.sw-pin[data-selected="true"]{box-shadow:0 0 0 2px var(--ink),0 6px 18px rgba(0,0,0,.4)}
.sw-pin[data-off]{opacity:0;pointer-events:none}
.sw-pin[data-status="verified"]{opacity:.55}
.sw-pin-mark{font-size:10px}
@keyframes sw-pin-in{from{opacity:0;scale:.4}}
.sw-pop{pointer-events:auto;position:fixed;width:304px;max-width:calc(100vw - 24px);padding:12px;border-radius:12px;background:rgba(11,12,16,.96);border:1px solid rgba(255,255,255,.1);box-shadow:0 18px 44px rgba(0,0,0,.5);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);animation:sw-pop-in .2s var(--ease) both}
@keyframes sw-pop-in{from{opacity:0;translate:0 6px}}
.sw-pop-head{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.sw-pop-head .sw-btn{margin-left:auto}
.sw-pop-title{margin:0 0 6px;font-size:12.5px;font-weight:600;line-height:1.4;word-break:break-word}
.sw-pop-meta{margin:0 0 4px;font-size:11px;line-height:1.45;color:#a1a1aa;word-break:break-word}
.sw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px}

/* Cursors */
.sw-cursors{position:fixed;inset:0;z-index:5}
.sw-cursor{position:fixed;left:0;top:0;will-change:transform;transition:opacity .28s ease}
.sw-cursor[data-enter]{opacity:0}
.sw-arrow,.sw-caret{display:block;width:20px;height:20px;margin:-2px 0 0 -2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));transform-origin:2px 2px;transition:transform .12s ease}
.sw-caret{display:none;margin:0}
.sw-cursor[data-mode="caret"] .sw-arrow{display:none}
.sw-cursor[data-mode="caret"] .sw-caret{display:block}
.sw-cursor[data-press] .sw-arrow{transform:scale(.8)}
.sw-tag{position:absolute;left:14px;top:16px;display:none;align-items:center;gap:6px;padding:3px 8px;border-radius:3px 10px 10px 10px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.25)}
.sw-cursor[data-tag] .sw-tag{display:inline-flex}
.sw-tag-status{padding:1px 6px;border-radius:999px;background:rgba(0,0,0,.22);font-size:10px;font-weight:500}
.sw-ripple{position:absolute;left:-12px;top:-12px;width:28px;height:28px;border:2px solid;border-radius:999px;animation:sw-ripple .6s cubic-bezier(0,0,.2,1) forwards}
@keyframes sw-ripple{from{transform:scale(.2);opacity:1}to{transform:scale(2.4);opacity:0}}

/* Mission log */
.sw-feed{pointer-events:auto;position:fixed;right:14px;top:74px;z-index:6;display:none;flex-direction:column;width:300px;max-width:calc(100vw - 28px);max-height:min(62vh,520px);border-radius:12px;background:rgba(17,18,23,.94);border:1px solid rgba(255,255,255,.09);box-shadow:0 14px 36px rgba(0,0,0,.42);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);overflow:hidden}
.sw-feed[data-on]{display:flex;animation:sw-pop-in .24s var(--ease) both}
.sw-feed-head{display:flex;align-items:center;justify-content:space-between;padding:6px 6px 6px 12px;border-bottom:1px solid rgba(255,255,255,.08);font-size:11.5px;font-weight:600;color:#e4e4e7}
.sw-feed-list{display:flex;flex-direction:column;gap:10px;margin:0;padding:10px 12px 12px;list-style:none;overflow-y:auto;scrollbar-width:thin}
.sw-feed[data-collapsed] .sw-feed-list{display:none}
.sw-feed-item{display:flex;gap:8px;animation:sw-pop-in .26s var(--ease) both}
.sw-feed-avatar{flex:0 0 auto;display:grid;place-items:center;width:20px;height:20px;border-radius:999px;font-size:10px;font-weight:700}
.sw-feed-body{min-width:0}
.sw-feed-meta{display:flex;align-items:center;gap:6px;margin-bottom:2px}
.sw-feed-from{font-size:11px;font-weight:600;color:#f4f4f5}
.sw-feed-kind{padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.08);font-size:9.5px;font-weight:600;color:#a1a1aa}
.sw-feed-item[data-kind="instruction"] .sw-feed-kind{background:rgba(13,153,255,.2);color:#7cc8ff}
.sw-feed-item[data-kind="decision"] .sw-feed-kind{background:rgba(255,180,0,.2);color:#ffd166}
.sw-feed-item[data-kind="done"] .sw-feed-kind{background:rgba(34,197,94,.2);color:#86efac}
.sw-feed-text{margin:0;font-size:11.5px;line-height:1.45;color:#d4d4d8;word-break:break-word}

/* HUD */
.sw-hud{pointer-events:auto;position:fixed;left:50%;bottom:16px;z-index:6;display:flex;align-items:center;gap:8px;max-width:calc(100vw - 24px);padding:6px 8px 6px 10px;border-radius:12px;background:rgba(17,18,23,.94);border:1px solid rgba(255,255,255,.09);box-shadow:0 12px 34px rgba(0,0,0,.42);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);font-variant-numeric:tabular-nums;white-space:nowrap;transform:translateX(-50%);transition:transform .32s var(--ease),opacity .2s ease}
.sw-hud[data-min]{transform:translate(-50%,160%);opacity:0;pointer-events:none}
.sw-avatars{display:flex;padding-left:4px}
.sw-avatar{display:grid;place-items:center;width:18px;height:18px;margin-left:-4px;border:1.5px solid #111217;border-radius:999px;font-size:9px;font-weight:700}
.sw-avatar-more{background:#2a2c36;color:#d4d4d8;width:auto;min-width:18px;padding:0 4px}
.sw-hud-count{font-size:11.5px;color:#e4e4e7}
.sw-hud-sep{width:1px;height:16px;background:rgba(255,255,255,.12)}
.sw-progress{display:none;align-items:center;gap:8px}
.sw-progress[data-on]{display:flex}
.sw-progress-track{width:72px;height:3px;border-radius:999px;background:rgba(255,255,255,.14);overflow:hidden}
.sw-progress-fill{display:block;width:100%;height:100%;background:var(--accent);transform-origin:left;transform:scaleX(0);transition:transform .2s ease}
.sw-hud-stats{display:none;gap:4px}
.sw-hud-stats[data-on]{display:flex}
.sw-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:999px;background:rgba(255,255,255,.08);font-size:10.5px;font-weight:600;color:#e4e4e7}
.sw-hud-stats .sw-chip::before{content:"";width:6px;height:6px;border-radius:999px;background:var(--chip,#fff)}
.sw-chip-solid{background:var(--chip)}
.sw-btn{display:inline-grid;place-items:center;height:24px;padding:0 9px;border:0;border-radius:7px;background:rgba(255,255,255,.1);color:#f4f4f5;font:600 11px/1 inherit;font-family:inherit;cursor:pointer;transition:background .15s ease,transform .1s ease}
.sw-btn:hover{background:rgba(255,255,255,.18)}
.sw-btn:active{transform:scale(.96)}
.sw-btn:focus-visible,.sw-dock:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sw-btn-primary{background:var(--accent);color:#fff}
.sw-btn-primary:hover{background:#2aa7ff}
.sw-btn-primary[data-active]{background:rgba(13,153,255,.22);color:#7cc8ff}
.sw-btn-ghost{background:transparent;color:#d4d4d8}
.sw-btn-icon{width:24px;padding:0;font-size:14px}
.sw-icon{width:15px;height:15px}
.sw-dock{pointer-events:auto;position:fixed;right:16px;bottom:16px;z-index:6;display:none;place-items:center;width:36px;height:36px;border:1px solid rgba(255,255,255,.1);border-radius:999px;background:rgba(17,18,23,.94);color:var(--accent);box-shadow:0 10px 26px rgba(0,0,0,.4);cursor:pointer}
.sw-dock[data-on]{display:grid;animation:sw-pin-in .3s var(--ease) both}
.sw-dock .sw-icon{width:18px;height:18px}
@media (max-width:560px){.sw-hud-count,.sw-progress-track,.sw-hud-sep{display:none}.sw-progress[data-on] .sw-hud-count{display:inline}}
@media (prefers-reduced-motion:reduce){.sw-pin,.sw-pop,.sw-dock,.sw-flash,.sw-ripple{animation:none}.sw-hud,.sw-btn,.sw-sel{transition:none}}
`;
