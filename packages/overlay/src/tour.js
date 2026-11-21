import { inViewport, scanLayers } from './layers.js';
import { clamp, easeOutCubic } from './physics.js';
import { createStyleVault } from './style-vault.js';
import { MAX_WORKERS } from './swarm.js';

const CLAIM_WINDOW = 48;
const INITIAL_AGENTS = 5;
const MAX_CARET_SAMPLES = 48;

const boxOf = (rect, scale = 1) => ({ left: rect.left, top: rect.top, width: rect.width * scale, height: rect.height * scale });

/** Samples caret positions (relative to the element border box) across an element's text. */
function sampleCarets(doc, el) {
  const range = doc.createRange?.();
  if (typeof range?.getBoundingClientRect !== 'function' || typeof doc.createTreeWalker !== 'function') return [];
  const walker = doc.createTreeWalker(el, 4);
  const positions = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (let i = 0; i < node.nodeValue.length; i += 1) {
      if (node.nodeValue[i].trim()) positions.push([node, i]);
    }
  }
  const step = Math.max(1, Math.ceil(positions.length / MAX_CARET_SAMPLES));
  const origin = el.getBoundingClientRect();
  const samples = [];
  for (let i = step - 1; i < positions.length; i += step) {
    const [node, offset] = positions[i];
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) samples.push({ x: r.right - origin.left, top: r.top - origin.top, bottom: r.bottom - origin.top });
  }
  return samples;
}

/** Clip polygon revealing every line above the caret plus the current line up to the caret. */
function typedClip(sample, width, height) {
  const pad = 8;
  const x = sample.x + 1;
  const top = Math.max(-pad, sample.top - 1);
  const bottom = Math.min(height + pad, sample.bottom + 2);
  return `polygon(${-pad}px ${-pad}px, ${width + pad}px ${-pad}px, ${width + pad}px ${top}px, ${x}px ${top}px, ${x}px ${bottom}px, ${-pad}px ${bottom}px)`;
}

/**
 * "Rebuild" tour: hides every painted layer of the page (via reversible inline styles), then lets
 * the swarm rebuild it live — agents fly to each layer, drag out a selection box, type text in
 * and drop media placeholders — while the page auto-scrolls to follow the work. Fully restorable.
 */
export function createTour({ doc, win, clock, swarm, selections, sound, onProgress, onDone }) {
  const vault = createStyleVault();
  let state = null;

  const snapshot = () => ({
    running: Boolean(state),
    done: state?.done ?? 0,
    total: state?.total ?? 0,
    agents: swarm.workers().length
  });
  const emitProgress = () => onProgress?.(snapshot());

  function complete(s, layer) {
    if (layer.status === 'done') return;
    vault.set(layer.el, 'visibility', 'visible');
    layer.status = 'done';
    s.done += 1;
    emitProgress();
  }

  async function typeText(s, agent, layer, alive) {
    const el = layer.el;
    const samples = layer.inline ? [] : sampleCarets(doc, el);
    if (samples.length < 2) {
      vault.set(el, 'visibility', 'visible');
      return;
    }
    agent.view.setMode('caret');
    vault.set(el, 'clip-path', 'inset(0 100% 100% 0)');
    vault.set(el, 'visibility', 'visible');
    await clock.tween(clamp(layer.chars * 16, 260, 1400), (p) => {
      if (!alive()) return;
      const sample = samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
      const rect = el.getBoundingClientRect();
      vault.set(el, 'clip-path', typedClip(sample, rect.width, rect.height));
      swarm.setPosition(agent, rect.left + sample.x - 10, rect.top + (sample.top + sample.bottom) / 2 - 10);
    });
    agent.view.setMode('arrow');
    if (alive()) vault.restore(el, 'clip-path');
  }

  async function runJob(s, agent, layer) {
    const el = layer.el;
    const live = () => el.getBoundingClientRect();
    const alive = () => state === s;
    layer.status = 'active';
    s.active += 1;
    agent.busy = true;
    let selection = null;
    let ghost = null;
    let track = null;
    try {
      await swarm.flyTo(agent, () => {
        const r = live();
        return { x: r.left, y: r.top };
      });
      if (!alive()) return;
      selection = selections.create();
      if (layer.kind === 'media') ghost = selections.createGhost(boxOf(live(), 0));
      s.lead = selection;
      const start = live();
      await clock.tween(clamp(140 + Math.hypot(start.width, start.height) * 0.45, 180, 520), (p) => {
        if (!alive()) return;
        const box = boxOf(live(), easeOutCubic(p));
        selection.setRect(box);
        ghost?.setRect(box);
        swarm.setPosition(agent, box.left + box.width, box.top + box.height);
      });
      if (!alive()) return;
      track = { selection, el };
      s.tracking.add(track);
      if (layer.kind === 'text') {
        await typeText(s, agent, layer, alive);
      } else {
        if (ghost) await clock.wait(220);
        if (!alive()) return;
        if (layer.kind === 'control') agent.view.press();
        vault.set(el, 'visibility', 'visible');
        selections.flash(boxOf(live()), agent.color);
      }
      if (!alive()) return;
      sound?.tick();
      layer.status = 'done';
      s.done += 1;
      emitProgress();
      await clock.wait(260);
    } finally {
      ghost?.remove();
      if (track) s.tracking.delete(track);
      if (selection) alive() ? selection.release() : selection.remove();
      if (s.lead === selection) s.lead = null;
      s.active -= 1;
      agent.busy = false;
      agent.idleUntil = clock.time + 60;
    }
  }

  /** Returns up to `count` pending layers currently on screen, instantly completing dead ones. */
  function collectClaimable(s, count) {
    while (s.frontier < s.layers.length && s.layers[s.frontier].status !== 'pending') s.frontier += 1;
    const found = [];
    let seen = 0;
    for (let i = s.frontier; i < s.layers.length && found.length < count && seen < CLAIM_WINDOW; i += 1) {
      const layer = s.layers[i];
      if (layer.status !== 'pending') continue;
      seen += 1;
      const rect = layer.el.isConnected ? layer.el.getBoundingClientRect() : null;
      if (!rect || rect.width < 1 || rect.height < 1) complete(s, layer);
      else if (inViewport(rect, win, -24)) found.push(layer);
    }
    return found;
  }

  /** Scrolls the next pending layer into view, or completes it if it cannot be reached. */
  function advanceFrontier(s) {
    const layer = s.layers[s.frontier];
    if (!layer) return;
    const rect = layer.el.getBoundingClientRect();
    const viewHeight = win.innerHeight || 800;
    const maxScroll = Math.max(0, (doc.documentElement?.scrollHeight || 0) - viewHeight);
    const target = clamp((win.scrollY || 0) + rect.top - viewHeight * 0.22, 0, maxScroll);
    if (s.tried.has(layer) || Math.abs(target - (win.scrollY || 0)) < 4 || typeof win.scrollTo !== 'function') {
      complete(s, layer);
      return;
    }
    s.tried.add(layer);
    win.scrollTo({ top: target, behavior: s.reducedMotion ? 'auto' : 'smooth' });
    s.scroll = { elapsed: 0, still: 0, lastY: win.scrollY || 0 };
  }

  function finish(s) {
    state = null;
    vault.restoreAll();
    selections.setGuides(null);
    if (s.startY !== (win.scrollY || 0)) win.scrollTo?.({ top: s.startY, behavior: s.reducedMotion ? 'auto' : 'smooth' });
    sound?.done();
    onDone?.({ done: s.done, total: s.total, cancelled: false });
  }

  function tick(now, _dt, realDt) {
    const s = state;
    if (!s) return;
    if (now >= s.rampAt && swarm.workers().length < s.targetAgents) {
      swarm.setWorkerCount(swarm.workers().length + 1);
      s.rampAt = now + 360;
      emitProgress();
    }
    for (const { selection, el } of s.tracking) selection.setRect(boxOf(el.getBoundingClientRect()));
    selections.setGuides(s.lead?.box ?? null);
    if (s.scroll) {
      const y = win.scrollY || 0;
      s.scroll.elapsed += realDt;
      s.scroll.still = Math.abs(y - s.scroll.lastY) < 0.5 ? s.scroll.still + realDt : 0;
      s.scroll.lastY = y;
      if (s.scroll.still < 140 && s.scroll.elapsed < 1600) return;
      s.scroll = null;
    }
    const free = swarm.freeWorkers();
    const claimable = free.length ? collectClaimable(s, free.length) : [];
    claimable.forEach((layer, i) => runJob(s, free[i], layer));
    if (s.done >= s.total) {
      if (s.active === 0) finish(s);
    } else if (s.active === 0 && claimable.length === 0 && free.length > 0) {
      advanceFrontier(s);
    }
  }

  const offTick = clock.onTick(tick);

  function start({ agents = 14, maxLayers = 400 } = {}) {
    if (state) return snapshot();
    const layers = scanLayers({ doc, win, max: clamp(Number(maxLayers) || 400, 1, 1200) }).map((layer) => ({
      ...layer,
      status: 'pending'
    }));
    if (!layers.length) return snapshot();
    const startY = win.scrollY || 0;
    for (const layer of layers) vault.set(layer.el, 'visibility', 'hidden');
    if (startY > 0) win.scrollTo?.({ top: 0, behavior: 'auto' });
    const targetAgents = clamp(Math.round(Number(agents) || 14), 1, MAX_WORKERS);
    state = {
      layers,
      total: layers.length,
      done: 0,
      active: 0,
      frontier: 0,
      targetAgents,
      rampAt: clock.time + 500,
      scroll: null,
      lead: null,
      tried: new Set(),
      tracking: new Set(),
      startY,
      reducedMotion: Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
    };
    swarm.setWorkerCount(Math.max(swarm.workers().length, Math.min(INITIAL_AGENTS, targetAgents)));
    emitProgress();
    return snapshot();
  }

  function stop() {
    const s = state;
    if (!s) return false;
    state = null;
    vault.restoreAll();
    selections.clear();
    for (const agent of swarm.list()) agent.view.setMode('arrow');
    clock.flush();
    onDone?.({ done: s.done, total: s.total, cancelled: true });
    return true;
  }

  return {
    start,
    stop,
    snapshot,
    destroy() {
      stop();
      offTick();
    }
  };
}
