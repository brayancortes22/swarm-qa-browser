const SVG_NS = 'http://www.w3.org/2000/svg';
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)$/;
const CTRL_RE = /[\u0000-\u001F\u007F-\u009F]/g;

const STYLES = `
.swarm-cursor-layer{pointer-events:none;position:fixed;inset:0;z-index:2;overflow:hidden}
.swarm-cursor{position:fixed;left:0;top:0;pointer-events:none;will-change:transform;transition:transform 220ms cubic-bezier(0.16,1,0.3,1),opacity 180ms ease}
.swarm-cursor-svg{display:block;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.45))}
.swarm-cursor-pill{display:inline-flex;align-items:center;gap:6px;margin:2px 0 0 14px;padding:3px 8px;border-radius:999px;background:rgba(10,11,15,0.88);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,0.14);box-shadow:0 6px 20px rgba(0,0,0,0.35);color:#f4f4f5;font:600 11px/1.2 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;white-space:nowrap}
.swarm-cursor-dot{width:6px;height:6px;border-radius:999px;flex:0 0 auto}
.swarm-cursor-status{padding:1px 6px;border-radius:999px;background:rgba(255,255,255,0.08);color:#cbd5e1;font-size:10px;font-weight:500}
.swarm-cursor-box{position:fixed;pointer-events:none;border-radius:4px;border:1.5px dashed;box-sizing:border-box;background:rgba(255,255,255,0.03);transition:left 220ms cubic-bezier(0.16,1,0.3,1),top 220ms cubic-bezier(0.16,1,0.3,1),width 220ms cubic-bezier(0.16,1,0.3,1),height 220ms cubic-bezier(0.16,1,0.3,1)}
.swarm-cursor-dims{position:absolute;padding:2px 6px;border-radius:4px;color:#fff;font:600 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.4)}
`;

const clean = (v, max = 64) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(CTRL_RE, '').trim().slice(0, max);
const safeColor = (c) => (COLOR_RE.test(String(c || '').trim()) ? String(c).trim() : '#0D99FF');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function makeSvg(doc) {
  const mkNs = (tag) => (doc.createElementNS ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag));
  const svg = mkNs('svg');
  svg.setAttribute('class', 'swarm-cursor-svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 20 20');
  const path = mkNs('path');
  path.setAttribute('d', 'M2 2 L7.5 17.5 L10.3 11.4 L16.5 8.6 Z');
  path.setAttribute('stroke', '#ffffff');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return { svg, path };
}

/**
 * Mounts the clean-room multiplayer cursor overlay into an isolated ShadowRoot.
 */
export function createCursorLayer(shadowRoot) {
  const doc = shadowRoot?.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!shadowRoot || !doc) throw new Error('createCursorLayer requires a valid ShadowRoot');

  const mk = (tag, cls) => {
    const el = doc.createElement(tag);
    if (cls) el.className = cls;
    return el;
  };
  const style = mk('style');
  style.textContent = STYLES;
  const layer = mk('div', 'swarm-cursor-layer');
  shadowRoot.appendChild(style);
  shadowRoot.appendChild(layer);

  const cursors = new Map();

  function createEntry(id) {
    const el = mk('div', 'swarm-cursor');
    el.dataset.cursorId = clean(id, 48);
    const { svg, path } = makeSvg(doc);
    const pill = mk('div', 'swarm-cursor-pill');
    const dot = mk('span', 'swarm-cursor-dot');
    const labelEl = mk('span', 'swarm-cursor-label');
    const statusEl = mk('span', 'swarm-cursor-status');
    [dot, labelEl, statusEl].forEach((n) => pill.appendChild(n));
    el.appendChild(svg);
    el.appendChild(pill);
    layer.appendChild(el);
    return { el, path, dot, labelEl, statusEl, boxEl: null, dimsEl: null };
  }

  function syncBox(entry, box, color) {
    const valid = box && Number.isFinite(Number(box.width)) && Number.isFinite(Number(box.height));
    if (!valid) {
      if (entry.boxEl) { entry.boxEl.remove(); entry.boxEl = entry.dimsEl = null; }
      return;
    }
    if (!entry.boxEl) {
      entry.boxEl = mk('div', 'swarm-cursor-box');
      entry.dimsEl = mk('span', 'swarm-cursor-dims');
      entry.boxEl.appendChild(entry.dimsEl);
      layer.appendChild(entry.boxEl);
    }
    const left = Math.round(num(box.left));
    const top = Math.round(num(box.top));
    const w = Math.max(0, Math.round(num(box.width)));
    const h = Math.max(0, Math.round(num(box.height)));
    Object.assign(entry.boxEl.style, {
      left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px`, borderColor: color
    });
    Object.assign(entry.dimsEl.style, {
      background: color, top: top < 24 ? '4px' : '-20px', left: top < 24 ? '4px' : '-1px'
    });
    entry.dimsEl.textContent = `${w} × ${h}`;
  }

  function upsertCursor({ id, label, color, x, y, status, box } = {}) {
    const key = clean(id, 48);
    if (!key) return;
    let entry = cursors.get(key);
    if (!entry) { entry = createEntry(key); cursors.set(key, entry); }
    const col = safeColor(color);
    entry.path.setAttribute('fill', col);
    entry.dot.style.background = col;
    entry.labelEl.textContent = clean(label || key, 48);
    const st = clean(status, 40);
    entry.statusEl.textContent = st;
    entry.statusEl.style.display = st ? 'inline-block' : 'none';
    entry.el.style.transform = `translate3d(${num(x)}px, ${num(y)}px, 0)`;
    syncBox(entry, box, col);
  }

  function removeCursor(id) {
    const key = clean(id, 48);
    const entry = cursors.get(key);
    if (!entry) return;
    entry.el.remove();
    if (entry.boxEl) entry.boxEl.remove();
    cursors.delete(key);
  }

  function clearAll() {
    for (const entry of cursors.values()) {
      entry.el.remove();
      if (entry.boxEl) entry.boxEl.remove();
    }
    cursors.clear();
  }

  return { upsertCursor, removeCursor, clearAll };
}
