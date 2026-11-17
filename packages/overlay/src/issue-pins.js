const CTRL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const sevOf = (s) => (/^(P1|critical)$/i.test(s) ? ['P1', '#F24822', '#ffffff'] : /^(P2|high)$/i.test(s) ? ['P2', '#FFC700', '#0a0b0f'] : ['P3', '#0D99FF', '#ffffff']);
const STATUS = {
  open: ['●', '#f4f4f5', 'Abierto'], claimed: ['◐', '#a78bfa', 'En curso'],
  awaiting_reverify: ['↻', '#38bdf8', 'Por verificar'], verified: ['✓', '#22c55e', 'Verificado'],
  reopened: ['↺', '#fb923c', 'Reabierto'], escalated: ['!', '#ef4444', 'Escalado']
};
const STYLES = `.swarm-pins-layer{pointer-events:none;position:fixed;inset:0;z-index:3;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}
.swarm-pin{pointer-events:auto;position:fixed;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:999px;border:2px solid #0a0b0f;font:700 11px/1 Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.45);transition:transform 180ms cubic-bezier(0.16,1,0.3,1);user-select:none}
.swarm-pin:hover{transform:translateY(-2px) scale(1.04)}.swarm-pin[data-selected="true"]{outline:2px solid #fff;outline-offset:2px}
.swarm-pin-st{font-size:10px;line-height:1;padding:1px 4px;border-radius:999px;background:rgba(10,11,15,0.65)}
.swarm-pop{pointer-events:auto;position:fixed;width:292px;max-width:calc(100vw - 24px);padding:12px;border-radius:12px;background:rgba(10,11,15,0.94);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,0.1);box-shadow:0 16px 40px rgba(0,0,0,0.55);color:#f4f4f5;z-index:5}
.swarm-pop-hd,.swarm-hud,.swarm-hud-stats,.swarm-hud-btns{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.swarm-pop-hd{justify-content:space-between;margin-bottom:8px}
.swarm-pop-title{font-size:12px;font-weight:600;line-height:1.35;margin:0 0 6px;word-break:break-word}
.swarm-pop-meta{font-size:11px;color:#94a3b8;line-height:1.4;margin:0;word-break:break-word}
.swarm-badge{font-size:10px;font-weight:600;padding:2px 6px;border-radius:999px;background:rgba(255,255,255,0.08)}
.swarm-hud{pointer-events:auto;position:fixed;left:50%;bottom:16px;transform:translateX(-50%);max-width:calc(100vw - 24px);padding:8px 12px;border-radius:14px;background:rgba(10,11,15,0.88);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,0.08);box-shadow:0 12px 32px rgba(0,0,0,0.5);color:#f4f4f5;font-size:12px;z-index:4;justify-content:space-between}
.swarm-btn{background:rgba(255,255,255,0.08);color:#f4f4f5;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer}.swarm-btn:hover{background:rgba(255,255,255,0.16)}
.swarm-hud.is-collapsed .swarm-hud-stats,.swarm-hud.is-collapsed [data-action="reaudit"],.swarm-hud.is-collapsed [data-action="clear"]{display:none}`;
const txt = (v, max = 280) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(CTRL_RE, '').slice(0, max);
const clamp = (n, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
const addAll = (parent, nodes) => nodes.forEach((n) => parent.appendChild(n));

/**
 * Mounts pathname-filtered severity pins and the Refero AAA collapsible Swarm HUD bar.
 */
export function createIssuePins(shadowRoot, callbacks = {}) {
  const doc = shadowRoot?.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const win = doc?.defaultView || (typeof window !== 'undefined' ? window : null);
  if (!shadowRoot || !doc) throw new Error('createIssuePins requires a valid ShadowRoot');

  const mk = (tag, cls, text, attrs) => {
    const el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = txt(text);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  };
  const style = mk('style', '', STYLES);
  const layer = mk('div', 'swarm-pins-layer');
  const hud = mk('div', 'swarm-hud');
  const statsWrap = mk('div', 'swarm-hud-stats');
  const btnsWrap = mk('div', 'swarm-hud-btns');
  const pills = ['Agentes: 0', 'Abiertos: 0', 'Verificar: 0', 'Verificados: 0'].map((t) => mk('span', 'swarm-badge', t));
  const [agentsPill, openPill, awaitPill, verPill] = pills;
  const pauseBtn = mk('button', 'swarm-btn', 'Pausar', { type: 'button', 'data-action': 'toggle-pause' });
  const reauditBtn = mk('button', 'swarm-btn', 'Re-auditar', { type: 'button', 'data-action': 'reaudit' });
  const clearBtn = mk('button', 'swarm-btn', 'Limpiar', { type: 'button', 'data-action': 'clear' });
  const collapseBtn = mk('button', 'swarm-btn', '▾', { type: 'button', 'data-action': 'collapse', 'aria-label': 'Colapsar HUD' });

  addAll(statsWrap, pills);
  addAll(btnsWrap, [pauseBtn, reauditBtn, clearBtn, collapseBtn]);
  addAll(hud, [statsWrap, btnsWrap]);
  addAll(shadowRoot, [style, layer, hud]);

  let paused = false, selectedKey = null, popEl = null;
  const closePop = () => { if (popEl) { popEl.remove(); popEl = null; } };
  const vp = () => ({ vw: win?.innerWidth || 1280, vh: win?.innerHeight || 800 });

  function resolvePos(ticket, idx, placed) {
    const { vw, vh } = vp();
    let rect = null;
    if (ticket.selector) {
      try { rect = doc.querySelector(ticket.selector)?.getBoundingClientRect() || null; } catch {}
    }
    if (!rect && ticket.rect) rect = ticket.rect;
    let x = rect ? Number(rect.left ?? rect.x ?? 16) : 16 + (idx % 4) * 72;
    let y = rect ? Number(rect.top ?? rect.y ?? 16) : 16 + Math.floor(idx / 4) * 32;
    while (placed.some((p) => Math.abs(p.x - x) < 18 && Math.abs(p.y - y) < 18)) x += 26;
    const pos = { x: clamp(x, 8, Math.max(8, vw - 76)), y: clamp(y, 8, Math.max(8, vh - 88)) };
    placed.push(pos);
    return pos;
  }

  function showPopover(ticket, pos) {
    closePop();
    const { vw, vh } = vp();
    const [sevCode, sevBg, sevFg] = sevOf(ticket.severity);
    const [mark, stColor, stLabel] = STATUS[ticket.status] || STATUS.open;
    const pop = mk('div', 'swarm-pop');
    const hd = mk('div', 'swarm-pop-hd');
    const badges = mk('div', 'swarm-hud-stats');
    const sevB = mk('span', 'swarm-badge', sevCode);
    Object.assign(sevB.style, { background: sevBg, color: sevFg });
    const stB = mk('span', 'swarm-badge', `${mark} ${stLabel}`);
    stB.style.color = stColor;
    const closeB = mk('button', 'swarm-btn', '×', { type: 'button', 'aria-label': 'Cerrar detalle' });
    closeB.addEventListener('click', closePop);
    addAll(badges, [sevB, stB, mk('span', 'swarm-badge', `R${Number(ticket.round) || 1}/3`)]);
    addAll(hd, [badges, closeB]);
    const meta = [ticket.detail || ticket.description, ticket.selector].filter(Boolean).join(' · ') || ticket.pathname || '';
    addAll(pop, [hd, mk('p', 'swarm-pop-title', ticket.title || ticket.message || ticket.summary || 'Hallazgo QA'), mk('p', 'swarm-pop-meta', meta)]);
    Object.assign(pop.style, {
      left: `${clamp(pos.x, 12, Math.max(12, vw - 304))}px`,
      top: `${clamp(pos.y + 30 > vh - 190 ? pos.y - 140 : pos.y + 30, 12, Math.max(12, vh - 190))}px`
    });
    layer.appendChild(pop);
    popEl = pop;
  }

  function setTickets(tickets = [], currentPathname) {
    if (layer.replaceChildren) layer.replaceChildren(); else while (layer.firstChild) layer.removeChild(layer.firstChild);
    popEl = null;
    const hasPath = typeof currentPathname === 'string' && currentPathname.length > 0;
    const visible = (Array.isArray(tickets) ? tickets : []).filter((t) => !hasPath || !t?.pathname || t.pathname === currentPathname);
    const placed = [], pinEls = [];
    visible.forEach((ticket, i) => {
      const tid = txt(ticket.id ?? `idx-${i}`, 48);
      const [sevCode, sevBg, sevFg] = sevOf(ticket.severity);
      const [mark, stColor] = STATUS[ticket.status] || STATUS.open;
      const pos = resolvePos(ticket, i, placed);
      const pin = mk('button', 'swarm-pin', undefined, { type: 'button', 'data-ticket-id': tid, 'data-selected': String(selectedKey === tid) });
      Object.assign(pin.style, { left: `${pos.x}px`, top: `${pos.y}px`, background: sevBg, color: sevFg });
      const stEl = mk('span', 'swarm-pin-st', mark);
      stEl.style.color = stColor;
      addAll(pin, [mk('span', '', `${sevCode}·${i + 1}`), stEl]);
      pinEls.push(pin);
      pin.addEventListener('click', () => {
        selectedKey = tid;
        pinEls.forEach((p) => { p.dataset.selected = String(p === pin); });
        showPopover(ticket, pos);
        callbacks.onSelectTicket?.(ticket);
      });
      layer.appendChild(pin);
    });
  }

  function updateSummary(stats = {}) {
    if (typeof stats.paused === 'boolean') { paused = stats.paused; pauseBtn.textContent = paused ? 'Reanudar' : 'Pausar'; }
    agentsPill.textContent = `Agentes: ${Number(stats.activeAgents ?? stats.agents ?? 0)}`;
    openPill.textContent = `Abiertos: ${Number(stats.open ?? 0)}`;
    awaitPill.textContent = `Verificar: ${Number(stats.awaiting_reverify ?? stats.awaiting ?? 0)}`;
    verPill.textContent = `Verificados: ${Number(stats.verified ?? 0)}`;
  }

  pauseBtn.addEventListener('click', () => { paused = !paused; pauseBtn.textContent = paused ? 'Reanudar' : 'Pausar'; callbacks.onTogglePause?.(paused); });
  reauditBtn.addEventListener('click', () => callbacks.onReaudit?.());
  clearBtn.addEventListener('click', () => { setTickets([], undefined); callbacks.onClear?.(); });
  collapseBtn.addEventListener('click', () => { collapseBtn.textContent = hud.classList.toggle('is-collapsed') ? '▴' : '▾'; });

  return { setTickets, updateSummary, destroy: () => { closePop(); style.remove(); layer.remove(); hud.remove(); } };
}
