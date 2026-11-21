import { h } from './dom-utils.js';

export const RULER_SIZE = 18;
const FONT = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * Canvas rulers along the top and left edges showing page coordinates (viewport + scroll) and the
 * extents of the active selections, like a design tool. Redraws only when its inputs change.
 */
export function createRulers(doc, win, container) {
  const top = h(doc, 'canvas', 'sw-ruler sw-ruler-top');
  const left = h(doc, 'canvas', 'sw-ruler sw-ruler-left');
  const corner = h(doc, 'div', 'sw-ruler-corner');
  container.append(top, left, corner);
  let lastKey = '';
  let visible = false;

  const context = (canvas) => {
    try {
      return canvas.getContext?.('2d') ?? null;
    } catch {
      return null;
    }
  };
  const ctxTop = context(top);
  const ctxLeft = context(left);

  function prepare(canvas, ctx, width, height, dpr) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(250, 250, 251, 0.94)';
    ctx.fillRect(0, 0, width, height);
    ctx.font = FONT;
    ctx.textBaseline = 'top';
  }

  function drawAxis(ctx, length, scroll, horizontal, marks) {
    for (const mark of marks) {
      ctx.fillStyle = 'rgba(13, 153, 255, 0.22)';
      if (horizontal) ctx.fillRect(mark.start, 0, mark.size, RULER_SIZE);
      else ctx.fillRect(0, mark.start, RULER_SIZE, mark.size);
    }
    ctx.fillStyle = '#9ca3af';
    const first = Math.floor(scroll / 10) * 10;
    for (let page = first; page < scroll + length; page += 10) {
      const pos = Math.round(page - scroll) + 0.5;
      if (pos < RULER_SIZE) continue;
      const major = page % 100 === 0;
      const size = major ? RULER_SIZE : page % 50 === 0 ? 7 : 4;
      if (horizontal) ctx.fillRect(pos, RULER_SIZE - size, 1, size);
      else ctx.fillRect(RULER_SIZE - size, pos, size, 1);
      if (!major) continue;
      ctx.fillStyle = '#6b7280';
      if (horizontal) {
        ctx.fillText(String(page), pos + 3, 2);
      } else {
        ctx.save();
        ctx.translate(2, pos + 3);
        ctx.rotate(Math.PI / 2);
        ctx.fillText(String(page), 0, -8);
        ctx.restore();
      }
      ctx.fillStyle = '#9ca3af';
    }
    ctx.fillStyle = 'rgba(17, 24, 39, 0.14)';
    if (horizontal) ctx.fillRect(0, RULER_SIZE - 1, length, 1);
    else ctx.fillRect(RULER_SIZE - 1, 0, 1, length);
  }

  function update(boxes = []) {
    if (!visible || !ctxTop || !ctxLeft) return;
    const width = win.innerWidth || 1280;
    const height = win.innerHeight || 800;
    const scrollX = Math.round(win.scrollX || 0);
    const scrollY = Math.round(win.scrollY || 0);
    const key = `${width}|${height}|${scrollX}|${scrollY}|${boxes.map((b) => `${b.left | 0},${b.top | 0},${b.width | 0},${b.height | 0}`).join(';')}`;
    if (key === lastKey) return;
    lastKey = key;
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    prepare(top, ctxTop, width, RULER_SIZE, dpr);
    prepare(left, ctxLeft, RULER_SIZE, height, dpr);
    drawAxis(
      ctxTop,
      width,
      scrollX,
      true,
      boxes.map((b) => ({ start: b.left, size: b.width }))
    );
    drawAxis(
      ctxLeft,
      height,
      scrollY,
      false,
      boxes.map((b) => ({ start: b.top, size: b.height }))
    );
  }

  return {
    update,
    setVisible(next) {
      visible = Boolean(next);
      lastKey = '';
      for (const el of [top, left, corner]) el.toggleAttribute('data-on', visible);
    },
    destroy() {
      for (const el of [top, left, corner]) el.remove();
    }
  };
}
