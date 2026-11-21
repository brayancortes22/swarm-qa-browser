import { cleanText, h, svgIcon } from './dom-utils.js';
import { inkFor } from './physics.js';

const ARROW_PATH = 'M2.2 1.8 L8.1 18.6 L10.9 11.5 L18 8.7 Z';
const CARET_PATH = 'M6 2 H8.4 Q10 2 10 3.6 Q10 2 11.6 2 H14 M10 3.6 V16.4 M6 18 H8.4 Q10 18 10 16.4 Q10 18 11.6 18 H14';

/** DOM view for a single agent cursor: arrow / I-beam glyph, name tag and click ripple. */
export function createCursorView(doc, container, { id, color, name }) {
  const root = h(doc, 'div', 'sw-cursor', undefined, { 'data-cursor-id': cleanText(id, 48), 'data-enter': '' });
  const arrow = svgIcon(doc, {
    className: 'sw-arrow',
    paths: [{ d: ARROW_PATH, fill: color, stroke: '#ffffff', 'stroke-width': '1.5', 'stroke-linejoin': 'round' }]
  });
  const caret = svgIcon(doc, {
    className: 'sw-caret',
    paths: [
      { d: CARET_PATH, fill: 'none', stroke: '#ffffff', 'stroke-width': '4', 'stroke-linecap': 'round' },
      { d: CARET_PATH, fill: 'none', stroke: color, 'stroke-width': '1.8', 'stroke-linecap': 'round' }
    ]
  });
  const tag = h(doc, 'div', 'sw-tag');
  const nameEl = h(doc, 'span', 'sw-tag-name', name);
  const statusEl = h(doc, 'span', 'sw-tag-status');
  tag.append(nameEl, statusEl);
  root.append(arrow, caret, tag);
  container.appendChild(root);

  let enterCleared = false;
  const view = {
    el: root,
    setPosition(x, y) {
      root.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      if (!enterCleared) {
        enterCleared = true;
        root.removeAttribute('data-enter');
      }
    },
    setColor(next) {
      arrow.firstChild?.setAttribute('fill', next);
      caret.lastChild?.setAttribute('stroke', next);
      tag.style.background = next;
      tag.style.color = inkFor(next);
    },
    setName(next) {
      nameEl.textContent = cleanText(next, 48);
    },
    setStatus(next) {
      const text = cleanText(next, 48);
      statusEl.textContent = text;
      statusEl.style.display = text ? 'inline-block' : 'none';
    },
    setTagVisible(visible) {
      root.toggleAttribute('data-tag', Boolean(visible));
    },
    setMode(mode) {
      root.setAttribute('data-mode', mode === 'caret' ? 'caret' : 'arrow');
    },
    press() {
      root.setAttribute('data-press', '');
      const ripple = h(doc, 'span', 'sw-ripple');
      ripple.style.borderColor = arrow.firstChild?.getAttribute('fill') || color;
      root.appendChild(ripple);
      setTimeout(() => {
        root.removeAttribute('data-press');
        ripple.remove();
      }, 620);
    },
    remove() {
      root.remove();
    }
  };
  view.setColor(color);
  view.setStatus('');
  view.setMode('arrow');
  return view;
}
