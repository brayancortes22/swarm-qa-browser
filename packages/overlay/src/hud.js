import { h, svgIcon } from './dom-utils.js';
import { inkFor } from './physics.js';

const SPEEDS = [1, 2, 4];
const ICONS = {
  soundOn: ['M3 8 H6 L10 4.5 V15.5 L6 12 H3 Z', 'M12.8 7.2 Q14.6 10 12.8 12.8 M14.8 5.2 Q18 10 14.8 14.8'],
  soundOff: ['M3 8 H6 L10 4.5 V15.5 L6 12 H3 Z', 'M13 7.8 L17 12.2 M17 7.8 L13 12.2'],
  close: ['M5.5 5.5 L14.5 14.5 M14.5 5.5 L5.5 14.5'],
  swarm: ['M3 2.5 L8 16.5 L10.4 10.6 L16.4 8.2 Z']
};
const MAX_AVATARS = 5;

const icon = (doc, name) =>
  svgIcon(doc, {
    className: 'sw-icon',
    paths: ICONS[name].map((d) => ({
      d,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    }))
  });

/**
 * Bottom control bar: live agent avatars, layer/progress counter, ticket chips and the
 * Tour / Audit / speed / sound / minimize controls. The only interactive part of the overlay.
 */
export function createHud(doc, container, callbacks = {}) {
  const bar = h(doc, 'div', 'sw-hud', undefined, { role: 'toolbar', 'aria-label': 'Swarm QA' });
  const avatars = h(doc, 'div', 'sw-avatars');
  const agentsLabel = h(doc, 'span', 'sw-hud-count', '0 agentes');
  const progress = h(doc, 'div', 'sw-progress');
  const layersLabel = h(doc, 'span', 'sw-hud-count');
  const track = h(doc, 'span', 'sw-progress-track');
  const fill = h(doc, 'span', 'sw-progress-fill');
  track.appendChild(fill);
  progress.append(layersLabel, track);
  const stats = h(doc, 'div', 'sw-hud-stats', undefined, { role: 'status', 'aria-live': 'polite' });
  const tourBtn = h(doc, 'button', 'sw-btn sw-btn-primary', 'Tour', { type: 'button', 'data-action': 'tour' });
  const auditBtn = h(doc, 'button', 'sw-btn', 'Auditar', { type: 'button', 'data-action': 'audit' });
  const speedBtn = h(doc, 'button', 'sw-btn sw-btn-ghost', '1×', { type: 'button', 'data-action': 'speed', 'aria-label': 'Velocidad' });
  const soundBtn = h(doc, 'button', 'sw-btn sw-btn-ghost sw-btn-icon', undefined, {
    type: 'button',
    'data-action': 'sound',
    'aria-label': 'Sonido',
    'aria-pressed': 'false'
  });
  const closeBtn = h(doc, 'button', 'sw-btn sw-btn-ghost sw-btn-icon', undefined, {
    type: 'button',
    'data-action': 'minimize',
    'aria-label': 'Minimizar Swarm QA'
  });
  const dock = h(doc, 'button', 'sw-dock', undefined, { type: 'button', 'aria-label': 'Abrir Swarm QA' });
  soundBtn.appendChild(icon(doc, 'soundOff'));
  closeBtn.appendChild(icon(doc, 'close'));
  dock.appendChild(icon(doc, 'swarm'));
  const sep = () => h(doc, 'span', 'sw-hud-sep');
  bar.append(avatars, agentsLabel, sep(), progress, stats, tourBtn, auditBtn, sep(), speedBtn, soundBtn, closeBtn);
  container.append(bar, dock);

  let speedIndex = 0;
  let soundOn = false;
  let touring = false;

  function setAgents(agents = []) {
    avatars.replaceChildren();
    agents.slice(0, MAX_AVATARS).forEach((agent) => {
      const dot = h(doc, 'span', 'sw-avatar', (agent.name || '?').slice(0, 1).toUpperCase());
      dot.style.background = agent.color;
      dot.style.color = inkFor(agent.color);
      avatars.appendChild(dot);
    });
    if (agents.length > MAX_AVATARS) avatars.appendChild(h(doc, 'span', 'sw-avatar sw-avatar-more', `+${agents.length - MAX_AVATARS}`));
    agentsLabel.textContent = `${agents.length} ${agents.length === 1 ? 'agente' : 'agentes'}`;
  }

  function setTour({ running = false, done = 0, total = 0 } = {}) {
    touring = Boolean(running);
    tourBtn.textContent = touring ? 'Detener' : 'Tour';
    tourBtn.toggleAttribute('data-active', touring);
    progress.toggleAttribute('data-on', total > 0);
    layersLabel.textContent = `${done} / ${total} capas`;
    fill.style.transform = `scaleX(${total > 0 ? Math.min(1, done / total) : 0})`;
  }

  /** Ticket counters: `{ open, awaiting_reverify, verified }` (legacy aliases accepted). */
  function setSummary(summary = {}) {
    const items = [
      ['Abiertos', Number(summary.open ?? 0), '#F24822'],
      ['Por verificar', Number(summary.awaiting_reverify ?? summary.awaiting ?? 0), '#38BDF8'],
      ['Verificados', Number(summary.verified ?? 0), '#22C55E']
    ].filter(([, count]) => count > 0);
    stats.replaceChildren();
    for (const [label, count, color] of items) {
      const chip = h(doc, 'span', 'sw-chip', `${label} ${count}`);
      chip.style.setProperty('--chip', color);
      stats.appendChild(chip);
    }
    stats.toggleAttribute('data-on', items.length > 0);
  }

  function setSound(on) {
    soundOn = Boolean(on);
    soundBtn.replaceChildren(icon(doc, soundOn ? 'soundOn' : 'soundOff'));
    soundBtn.setAttribute('aria-pressed', String(soundOn));
  }

  function setSpeed(speed) {
    const index = SPEEDS.indexOf(Number(speed));
    speedIndex = index === -1 ? 0 : index;
    speedBtn.textContent = `${SPEEDS[speedIndex]}×`;
  }

  function setMinimized(minimized) {
    bar.toggleAttribute('data-min', Boolean(minimized));
    dock.toggleAttribute('data-on', Boolean(minimized));
  }

  tourBtn.addEventListener('click', () => callbacks.onTour?.(!touring));
  auditBtn.addEventListener('click', () => callbacks.onAudit?.());
  speedBtn.addEventListener('click', () => {
    setSpeed(SPEEDS[(speedIndex + 1) % SPEEDS.length]);
    callbacks.onSpeed?.(SPEEDS[speedIndex]);
  });
  soundBtn.addEventListener('click', () => {
    setSound(!soundOn);
    callbacks.onSound?.(soundOn);
  });
  closeBtn.addEventListener('click', () => {
    setMinimized(true);
    callbacks.onMinimize?.(true);
  });
  dock.addEventListener('click', () => {
    setMinimized(false);
    callbacks.onMinimize?.(false);
  });

  setTour();
  setSummary();
  return {
    setAgents,
    setTour,
    setSummary,
    setSound,
    setSpeed,
    setMinimized,
    destroy() {
      bar.remove();
      dock.remove();
    }
  };
}
