import { createCursorView } from './cursor-view.js';
import { cleanText, safeColor } from './dom-utils.js';
import { arcPoint, clamp, distance, easeInOutCubic, flightDuration } from './physics.js';

export const SWARM_COLORS = ['#F24822', '#FF8A00', '#FFC700', '#14AE5C', '#00B5AD', '#0D99FF', '#4F6BFF', '#9747FF', '#E84BA5', '#00C2FF'];
const NAMES = [
  'Ada',
  'Kai',
  'Noa',
  'Zoe',
  'Leo',
  'Mia',
  'Teo',
  'Uma',
  'Ian',
  'Eva',
  'Max',
  'Lia',
  'Hugo',
  'Iris',
  'Otto',
  'Nora',
  'Axel',
  'Vera',
  'Milo',
  'Cleo',
  'Dana',
  'Enzo',
  'Gala',
  'Jano',
  'Kira',
  'Luca',
  'Maya',
  'Nico',
  'Olga',
  'Paco',
  'Rita',
  'Saul'
];
export const MAX_WORKERS = 32;

/**
 * The swarm: a roster of animated agent cursors.
 *  - "worker" agents are autonomous (tour, audit sweeps, idle wandering).
 *  - "role" agents are driven remotely through the bus (`move_cursor`) and always show a name tag.
 * Every agent glides along a curved path towards a (possibly moving) target each frame.
 */
export function createSwarm({ doc, win, container, clock, rng = Math.random }) {
  const agents = new Map();
  const viewport = () => ({ width: win?.innerWidth || 1280, height: win?.innerHeight || 800 });
  let wanderEnabled = true;
  let workerSeq = 0;

  function add({ id, name, color, kind = 'worker', x, y, status = '' }) {
    const key = cleanText(id, 48);
    if (!key) return null;
    const existing = agents.get(key);
    if (existing) return existing;
    const vp = viewport();
    const agent = {
      id: key,
      kind,
      name: cleanText(name || key, 48),
      color: safeColor(color, SWARM_COLORS[agents.size % SWARM_COLORS.length]),
      x: Number.isFinite(x) ? x : vp.width * (0.2 + rng() * 0.6),
      y: Number.isFinite(y) ? y : vp.height * (0.2 + rng() * 0.6),
      busy: false,
      motion: null,
      idleUntil: clock.time + rng() * 900,
      view: null
    };
    agent.view = createCursorView(doc, container, agent);
    agent.view.setTagVisible(kind === 'role');
    agent.view.setStatus(status);
    agent.view.setPosition(agent.x, agent.y);
    agents.set(key, agent);
    return agent;
  }

  function remove(id) {
    const agent = agents.get(cleanText(id, 48));
    if (!agent) return false;
    agent.motion?.resolve(false);
    agent.view.remove();
    agents.delete(agent.id);
    return true;
  }

  /**
   * Flies an agent to `target` (a point or a function returning the live point, so targets that move
   * while the page scrolls are tracked). Resolves `true` on arrival, `false` if pre-empted.
   */
  function flyTo(agent, target, { duration, bend } = {}) {
    agent.motion?.resolve(false);
    const getTarget = typeof target === 'function' ? target : () => target;
    const from = { x: agent.x, y: agent.y };
    const first = getTarget() || from;
    return new Promise((resolve) => {
      agent.motion = {
        from,
        getTarget,
        last: first,
        bend: bend ?? (rng() - 0.5) * 0.36,
        start: clock.time,
        duration: duration ?? flightDuration(distance(from, first)),
        resolve
      };
    });
  }

  function wander(agent) {
    const vp = viewport();
    const target = {
      x: clamp(agent.x + (rng() - 0.5) * 520, 24, vp.width - 40),
      y: clamp(agent.y + (rng() - 0.5) * 380, 28, vp.height - 80)
    };
    agent.idleUntil = Infinity;
    flyTo(agent, target, { duration: 900 + rng() * 1100 }).then(() => {
      agent.idleUntil = clock.time + 500 + rng() * 2400;
    });
  }

  function update(now) {
    for (const agent of agents.values()) {
      const motion = agent.motion;
      if (motion) {
        const p = clamp((now - motion.start) / motion.duration, 0, 1);
        motion.last = motion.getTarget() || motion.last;
        const point = arcPoint(motion.from, motion.last, motion.bend, easeInOutCubic(p));
        agent.x = point.x;
        agent.y = point.y;
        agent.view.setPosition(agent.x, agent.y);
        if (p >= 1) {
          agent.motion = null;
          motion.resolve(true);
        }
      } else if (wanderEnabled && agent.kind === 'worker' && !agent.busy && now >= agent.idleUntil) {
        wander(agent);
      }
    }
  }

  /** Grows or shrinks the autonomous worker pool to exactly `count` agents. */
  function setWorkerCount(count) {
    const target = clamp(Math.round(Number(count) || 0), 0, MAX_WORKERS);
    const workers = [...agents.values()].filter((a) => a.kind === 'worker');
    for (let i = workers.length; i < target; i += 1) {
      const n = workerSeq++;
      add({ id: `swarm-${n + 1}`, name: NAMES[n % NAMES.length], color: SWARM_COLORS[n % SWARM_COLORS.length] });
    }
    for (const extra of workers.slice(target).reverse()) if (!extra.busy) remove(extra.id);
    return [...agents.values()].filter((a) => a.kind === 'worker').length;
  }

  function clear() {
    for (const agent of [...agents.values()]) remove(agent.id);
    workerSeq = 0;
  }

  return {
    add,
    remove,
    flyTo,
    update,
    setWorkerCount,
    clear,
    get: (id) => agents.get(cleanText(id, 48)) ?? null,
    list: () => [...agents.values()],
    workers: () => [...agents.values()].filter((a) => a.kind === 'worker'),
    freeWorkers: () => [...agents.values()].filter((a) => a.kind === 'worker' && !a.busy),
    setWander(enabled) {
      wanderEnabled = Boolean(enabled);
    },
    setPosition(agent, x, y) {
      agent.motion?.resolve(false);
      agent.motion = null;
      agent.x = x;
      agent.y = y;
      agent.view.setPosition(x, y);
    }
  };
}
