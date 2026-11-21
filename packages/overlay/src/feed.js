import { cleanText, h, safeColor } from './dom-utils.js';
import { inkFor } from './physics.js';

const KINDS = { instruction: 'Instrucción', report: 'Informe', decision: 'Decisión', done: 'Hecho', note: 'Nota' };
const MAX_ENTRIES = 40;

/**
 * Mission log: a compact panel showing the conversation between the orchestrator and the swarm —
 * instructions sent to the agents, what they report back, and the decisions taken.
 */
export function createFeed(doc, container) {
  const panel = h(doc, 'section', 'sw-feed', undefined, { 'aria-label': 'Bitácora del enjambre' });
  const head = h(doc, 'header', 'sw-feed-head');
  const title = h(doc, 'span', 'sw-feed-title', 'Bitácora');
  const toggle = h(doc, 'button', 'sw-btn sw-btn-ghost sw-btn-icon', '–', {
    type: 'button',
    'aria-label': 'Plegar bitácora',
    'aria-expanded': 'true'
  });
  const list = h(doc, 'ol', 'sw-feed-list', undefined, { role: 'log', 'aria-live': 'polite' });
  head.append(title, toggle);
  panel.append(head, list);
  container.appendChild(panel);
  let count = 0;

  toggle.addEventListener('click', () => {
    const collapsed = panel.toggleAttribute('data-collapsed');
    toggle.textContent = collapsed ? '+' : '–';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });

  /** Appends an entry; `kind` is one of instruction | report | decision | done | note. */
  function post({ from, text, kind = 'note', color } = {}) {
    const body = cleanText(text, 320);
    if (!body) return false;
    const author = cleanText(from || 'Agente', 32);
    const tone = safeColor(color, '#64748b');
    const item = h(doc, 'li', 'sw-feed-item', undefined, { 'data-kind': Object.hasOwn(KINDS, kind) ? kind : 'note' });
    const avatar = h(doc, 'span', 'sw-feed-avatar', author.slice(0, 1).toUpperCase());
    avatar.style.background = tone;
    avatar.style.color = inkFor(tone);
    const meta = h(doc, 'div', 'sw-feed-meta');
    meta.append(h(doc, 'strong', 'sw-feed-from', author), h(doc, 'span', 'sw-feed-kind', KINDS[kind] || KINDS.note));
    const content = h(doc, 'div', 'sw-feed-body');
    content.append(meta, h(doc, 'p', 'sw-feed-text', body));
    item.append(avatar, content);
    list.appendChild(item);
    while (list.children.length > MAX_ENTRIES) list.firstChild.remove();
    list.scrollTop = list.scrollHeight;
    count += 1;
    panel.setAttribute('data-on', '');
    title.textContent = `Bitácora · ${count}`;
    return true;
  }

  return {
    post,
    clear() {
      list.replaceChildren();
      count = 0;
      panel.removeAttribute('data-on');
    },
    destroy: () => panel.remove()
  };
}
