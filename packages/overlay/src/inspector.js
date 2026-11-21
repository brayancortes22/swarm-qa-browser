import { queryOne } from './dom-utils.js';
import { inViewport, scanLayers } from './layers.js';

export const SEVERITY_COLORS = { P1: '#F24822', P2: '#FFB400', P3: '#0D99FF' };
const MAX_ANIMATED_FINDINGS = 24;
const MIN_INSPECTORS = 6;
const MAX_SCROLL_STOPS = 6;

export const severityCode = (severity) =>
  /^(P1|critical|crit)$/i.test(severity) ? 'P1' : /^(P2|high|warn)$/i.test(severity) ? 'P2' : 'P3';
const boxOf = (rect) => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });

/**
 * Audit choreography: agents sweep the visible layers with quick selection boxes, then converge
 * on each finding, outline it in its severity color and "click" it. Purely visual — the audit
 * itself is computed synchronously by dom-auditor.js.
 */
export function createInspector({ doc, win, clock, swarm, selections, sound, rng = Math.random }) {
  const tracking = new Set();
  let runId = 0;

  const offTick = clock.onTick(() => {
    for (const { selection, el } of tracking) selection.setRect(boxOf(el.getBoundingClientRect()));
  });

  async function visit(agent, el, alive, { color, label, hold, thin = false, press = false }) {
    const arrived = await swarm.flyTo(agent, () => {
      const r = el.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 24), y: r.top + Math.min(r.height / 2, 16) };
    });
    if (!arrived || !alive()) return;
    const selection = selections.create({ color, label, thin });
    const track = { selection, el };
    selection.setRect(boxOf(el.getBoundingClientRect()));
    tracking.add(track);
    if (press) {
      agent.view.press();
      sound?.click();
    }
    await clock.wait(hold);
    tracking.delete(track);
    if (alive()) selection.release();
    else selection.remove();
  }

  /** Smooth-scrolls the page and waits (in real time) until the scroll position settles. */
  async function scrollTo(top) {
    if (typeof win.scrollTo !== 'function') return;
    const reduced = Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    win.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' });
    let lastY = NaN;
    for (let i = 0; i < 16; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (Math.abs((win.scrollY || 0) - lastY) < 0.5) return;
      lastY = win.scrollY || 0;
    }
  }

  async function withAgent(agent, alive, work) {
    agent.busy = true;
    try {
      await work();
    } finally {
      agent.busy = false;
      agent.idleUntil = clock.time + 200 + rng() * 600;
      if (!alive()) agent.view.setMode('arrow');
    }
  }

  /** Plays the sweep + findings choreography; resolves when it ends or is superseded. */
  async function inspect(findings = [], { sweep = true, follow = false } = {}) {
    const id = ++runId;
    const alive = () => id === runId;
    swarm.setWorkerCount(Math.max(swarm.workers().length, MIN_INSPECTORS));
    const agents = swarm.freeWorkers();
    if (!agents.length) return { animated: 0 };

    if (sweep) {
      const visible = scanLayers({ doc, win, max: 300 }).filter((layer) => inViewport(layer.el.getBoundingClientRect(), win));
      const stops = visible.sort(() => rng() - 0.5).slice(0, agents.length * 2);
      await Promise.all(
        agents.map((agent, i) =>
          withAgent(agent, alive, async () => {
            for (const stop of [stops[i * 2], stops[i * 2 + 1]]) {
              if (stop && alive()) await visit(agent, stop.el, alive, { hold: 150 + rng() * 160, thin: true });
            }
          })
        )
      );
      if (!alive()) return { animated: 0 };
    }

    const targets = [];
    for (const finding of Array.isArray(findings) ? findings : []) {
      const el = queryOne(doc, finding?.selector);
      if (!el || el === doc.documentElement || el === doc.body) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) targets.push({ finding, el });
      if (targets.length >= MAX_ANIMATED_FINDINGS) break;
    }
    const startY = win.scrollY || 0;
    let animated = 0;
    for (let stop = 0; stop < MAX_SCROLL_STOPS && targets.length && alive(); stop += 1) {
      let queue = targets.filter(({ el }) => inViewport(el.getBoundingClientRect(), win, -40));
      if (!queue.length) {
        if (!follow) break;
        await scrollTo((win.scrollY || 0) + targets[0].el.getBoundingClientRect().top - (win.innerHeight || 800) * 0.3);
        queue = targets.filter(({ el }) => inViewport(el.getBoundingClientRect(), win, -40));
        if (!queue.length) queue = [targets[0]];
      }
      for (const item of queue) targets.splice(targets.indexOf(item), 1);
      animated += queue.length;
      await Promise.all(
        swarm.freeWorkers().map((agent) =>
          withAgent(agent, alive, async () => {
            while (queue.length && alive()) {
              const { finding, el } = queue.shift();
              const code = severityCode(finding.severity);
              await visit(agent, el, alive, {
                color: SEVERITY_COLORS[code],
                label: `${code} · ${finding.ruleId || 'hallazgo'}`,
                hold: 1100,
                press: true
              });
            }
          })
        )
      );
    }
    if (follow && alive() && Math.abs((win.scrollY || 0) - startY) > 4) await scrollTo(startY);
    return { animated };
  }

  return {
    inspect,
    cancel() {
      runId += 1;
      for (const { selection } of tracking) selection.remove();
      tracking.clear();
    },
    destroy() {
      this.cancel();
      offTick();
    }
  };
}
