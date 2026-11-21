import { cleanText, h, isFiniteNumber, queryOne } from './dom-utils.js';
import { SEVERITY_COLORS, severityCode } from './inspector.js';
import { inkFor } from './physics.js';

const STATUS = {
  open: ['●', 'Abierto'],
  claimed: ['◐', 'En curso'],
  awaiting_reverify: ['↻', 'Por verificar'],
  verified: ['✓', 'Verificado'],
  reopened: ['↺', 'Reabierto'],
  escalated: ['!', 'Escalado']
};
const isMobileWidth = (width) => width <= 480;

/**
 * Severity pins anchored to the DOM element of each ticket. Pins follow their element while the
 * page scrolls or reflows and open a detail popover on click.
 */
export function createIssuePins(doc, win, container, callbacks = {}) {
  const layer = h(doc, 'div', 'sw-pins');
  container.appendChild(layer);
  let pins = [];
  let popover = null;
  let selectedId = null;

  function closePopover() {
    popover?.remove();
    popover = null;
  }

  function openPopover(pin) {
    closePopover();
    const { ticket } = pin;
    const code = severityCode(ticket.severity);
    const [mark, label] = STATUS[ticket.status] || STATUS.open;
    const pop = h(doc, 'div', 'sw-pop', undefined, { role: 'dialog', 'aria-label': 'Detalle del hallazgo' });
    const head = h(doc, 'div', 'sw-pop-head');
    const sev = h(doc, 'span', 'sw-chip sw-chip-solid', code);
    sev.style.setProperty('--chip', SEVERITY_COLORS[code]);
    sev.style.color = inkFor(SEVERITY_COLORS[code]);
    const close = h(doc, 'button', 'sw-btn sw-btn-ghost sw-btn-icon', '×', { type: 'button', 'aria-label': 'Cerrar detalle' });
    close.addEventListener('click', closePopover);
    head.append(
      sev,
      h(doc, 'span', 'sw-chip', `${mark} ${label}`),
      h(doc, 'span', 'sw-chip', `Ronda ${Number(ticket.round) || 1}/3`),
      close
    );
    const meta = [ticket.ruleId, ticket.selector].filter(Boolean).join(' · ');
    pop.append(head, h(doc, 'p', 'sw-pop-title', ticket.title || ticket.description || ticket.message || 'Hallazgo QA'));
    if (ticket.actual) pop.appendChild(h(doc, 'p', 'sw-pop-meta', `Actual: ${ticket.actual}`));
    if (ticket.expected) pop.appendChild(h(doc, 'p', 'sw-pop-meta', `Esperado: ${ticket.expected}`));
    if (meta) pop.appendChild(h(doc, 'p', 'sw-pop-meta sw-mono', meta));
    const width = win?.innerWidth || 1280;
    const height = win?.innerHeight || 800;
    pop.style.left = `${Math.max(12, Math.min(pin.x, width - 316))}px`;
    pop.style.top = `${pin.y + 30 > height - 200 ? Math.max(12, pin.y - 170) : pin.y + 30}px`;
    layer.appendChild(pop);
    popover = pop;
  }

  /** Moves every pin to its element's current position; hides pins scrolled out of view. */
  function reposition() {
    const width = win?.innerWidth || 1280;
    const height = win?.innerHeight || 800;
    const placed = [];
    pins.forEach((pin, index) => {
      if (pin.target && !pin.target.isConnected) pin.target = queryOne(doc, pin.ticket.selector);
      const rect = pin.target?.getBoundingClientRect?.();
      let x = rect ? rect.left - 6 : pin.fallback ? pin.fallback.left : 28 + (index % 6) * 60;
      let y = rect ? rect.top - 10 : pin.fallback ? pin.fallback.top : 28 + Math.floor(index / 6) * 30;
      const offscreen = rect ? rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width : false;
      x = Math.max(22, Math.min(x, width - 64));
      y = Math.max(22, Math.min(y, height - 96));
      while (placed.some((p) => Math.abs(p.x - x) < 44 && Math.abs(p.y - y) < 20)) x += 48;
      placed.push({ x, y });
      if (pin.x === x && pin.y === y && pin.offscreen === offscreen) return;
      Object.assign(pin, { x, y, offscreen });
      pin.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      pin.el.toggleAttribute('data-off', offscreen);
    });
  }

  /** Renders pins for tickets matching the current pathname and viewport class. */
  function setTickets(tickets = [], currentPathname, currentViewportWidth) {
    closePopover();
    layer.replaceChildren();
    const hasPath = typeof currentPathname === 'string' && currentPathname.length > 0;
    const hasWidth = isFiniteNumber(currentViewportWidth) && Number(currentViewportWidth) > 0;
    const width = Number(currentViewportWidth);
    const visible = (Array.isArray(tickets) ? tickets : []).filter((ticket) => {
      if (!ticket || typeof ticket !== 'object') return false;
      if (hasPath && ticket.pathname && ticket.pathname !== currentPathname) return false;
      const ticketWidth = Number(ticket.viewport?.width);
      if (hasWidth && ticketWidth > 0) return isMobileWidth(ticketWidth) === isMobileWidth(width) || Math.abs(ticketWidth - width) <= 160;
      return true;
    });
    pins = visible.map((ticket, index) => {
      const id = cleanText(ticket.id ?? `idx-${index}`, 48);
      const code = severityCode(ticket.severity);
      const [mark] = STATUS[ticket.status] || STATUS.open;
      const el = h(doc, 'button', 'sw-pin', undefined, {
        type: 'button',
        'data-ticket-id': id,
        'data-status': cleanText(ticket.status || 'open', 24),
        'data-selected': String(selectedId === id)
      });
      el.style.background = SEVERITY_COLORS[code];
      el.style.color = inkFor(SEVERITY_COLORS[code]);
      el.append(h(doc, 'span', 'sw-pin-code', `${code}·${index + 1}`), h(doc, 'span', 'sw-pin-mark', mark));
      const fallback =
        ticket.rect && isFiniteNumber(ticket.rect.x ?? ticket.rect.left)
          ? { left: Number(ticket.rect.x ?? ticket.rect.left), top: Number(ticket.rect.y ?? ticket.rect.top) }
          : null;
      const pin = { ticket, el, target: queryOne(doc, ticket.selector), fallback, x: null, y: null, offscreen: null };
      el.addEventListener('click', () => {
        selectedId = id;
        for (const other of pins) other.el.dataset.selected = String(other === pin);
        openPopover(pin);
        callbacks.onSelectTicket?.(ticket);
      });
      layer.appendChild(el);
      return pin;
    });
    reposition();
    return pins.length;
  }

  return {
    setTickets,
    reposition,
    count: () => pins.length,
    destroy() {
      closePopover();
      layer.remove();
    }
  };
}
