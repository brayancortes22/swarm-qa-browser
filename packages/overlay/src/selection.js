import { cleanText, h, safeColor, svgIcon } from './dom-utils.js';

const IMAGE_ICON = 'M3 4.5 H17 V15.5 H3 Z M3 13 L7.5 9 L11 12 L13.5 10 L17 13 M12.5 7.6 A1 1 0 1 0 12.51 7.6';

/**
 * Design-tool style selection boxes (outline, four corner handles, size badge), wireframe ghosts
 * for media placeholders and alignment guides. Everything lives inside the overlay shadow root.
 */
export function createSelectionLayer(doc, container) {
  const layer = h(doc, 'div', 'sw-selections');
  const guideX = h(doc, 'div', 'sw-guide sw-guide-x');
  const guideY = h(doc, 'div', 'sw-guide sw-guide-y');
  layer.append(guideX, guideY);
  container.appendChild(layer);
  const active = new Set();

  function place(el, box) {
    el.style.transform = `translate3d(${Math.round(box.left)}px, ${Math.round(box.top)}px, 0)`;
    el.style.width = `${Math.max(0, Math.round(box.width))}px`;
    el.style.height = `${Math.max(0, Math.round(box.height))}px`;
  }

  /** Creates a selection box. `label` replaces the default "W × H" badge text. */
  function create({ color, label, thin = false } = {}) {
    const tone = safeColor(color);
    const el = h(doc, 'div', `sw-sel${thin ? ' sw-sel-thin' : ''}`);
    el.style.setProperty('--sel', tone);
    const badge = h(doc, 'span', 'sw-sel-badge');
    for (const corner of ['nw', 'ne', 'sw', 'se']) el.appendChild(h(doc, 'i', `sw-handle sw-handle-${corner}`));
    el.appendChild(badge);
    layer.appendChild(el);
    const selection = {
      box: { left: 0, top: 0, width: 0, height: 0 },
      color: tone,
      setRect(box) {
        selection.box = box;
        place(el, box);
        badge.textContent = label ? cleanText(label, 40) : `${Math.round(box.width)} × ${Math.round(box.height)}`;
        badge.classList.toggle('sw-sel-badge-inside', box.top + box.height > (doc.defaultView?.innerHeight || 800) - 28);
      },
      /** Fades the box out and removes it once the transition ends. */
      release(delay = 0) {
        active.delete(selection);
        setTimeout(() => {
          el.setAttribute('data-out', '');
          setTimeout(() => el.remove(), 260);
        }, delay);
      },
      remove() {
        active.delete(selection);
        el.remove();
      }
    };
    active.add(selection);
    return selection;
  }

  /** Grey wireframe placeholder shown while an agent "places" an image or media layer. */
  function createGhost(box) {
    const el = h(doc, 'div', 'sw-ghost');
    el.appendChild(
      svgIcon(doc, { paths: [{ d: IMAGE_ICON, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-linejoin': 'round' }] })
    );
    place(el, box);
    layer.appendChild(el);
    return {
      setRect: (next) => place(el, next),
      remove() {
        el.setAttribute('data-out', '');
        setTimeout(() => el.remove(), 220);
      }
    };
  }

  /** Brief highlight wash over a freshly revealed layer. */
  function flash(box, color) {
    const el = h(doc, 'div', 'sw-flash');
    el.style.setProperty('--sel', safeColor(color));
    place(el, box);
    layer.appendChild(el);
    setTimeout(() => el.remove(), 480);
  }

  function setGuides(box) {
    const visible = Boolean(box);
    guideX.style.opacity = visible ? '1' : '0';
    guideY.style.opacity = visible ? '1' : '0';
    if (!visible) return;
    guideX.style.transform = `translate3d(${Math.round(box.left)}px, 0, 0)`;
    guideY.style.transform = `translate3d(0, ${Math.round(box.top)}px, 0)`;
  }

  return {
    create,
    createGhost,
    flash,
    setGuides,
    boxes: () => [...active].map((s) => ({ ...s.box, color: s.color })),
    clear() {
      for (const selection of [...active]) selection.remove();
      setGuides(null);
    },
    destroy: () => layer.remove()
  };
}
