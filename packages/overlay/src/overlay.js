import { createClock } from './clock.js';
import { runDomAudit } from './dom-auditor.js';
import { cleanText, h, isFiniteNumber, queryOne, safeColor, toBox } from './dom-utils.js';
import { createFeed } from './feed.js';
import { createHud } from './hud.js';
import { createInspector } from './inspector.js';
import { createIssuePins } from './issue-pins.js';
import { MAIN_WORLD_PROBE_SOURCE, createConsoleCollector } from './network-console.js';
import { queryElement, scrollPage, snapshotPage } from './page-reader.js';
import { createPatchManager } from './patches.js';
import { createRulers } from './rulers.js';
import { createSelectionLayer } from './selection.js';
import { createSound } from './sound.js';
import { OVERLAY_CSS } from './styles.js';
import { createSwarm, MAX_WORKERS } from './swarm.js';
import { createTour } from './tour.js';

const HOST_ID = '__swarm_qa_overlay';
const HOST_STYLE = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
const ROUTE_POLL_MS = 400;
const PROGRESS_EVENT_MS = 400;
const DEFAULT_SWARM = { agents: 8, speed: 1, sound: false, rulers: true };

/** Commands the overlay accepts through `controller.exec(action, command)`. */
export const OVERLAY_ACTIONS = Object.freeze([
  'spawn_cursors',
  'move_cursor',
  'trigger_click',
  'remove_cursor',
  'set_tickets',
  'update_summary',
  'apply_patch',
  'revert_patch',
  'start_tour',
  'stop_tour',
  'inspect_findings',
  'configure_swarm',
  'get_swarm_state',
  'snapshot',
  'query',
  'scroll',
  'post_message',
  'clear_messages'
]);

const boxOf = (rect) => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });

/**
 * Mounts the Swarm QA overlay into a closed ShadowRoot and returns its controller.
 * The overlay animates locally at display refresh rate; transports (extension, CDP bridge or a
 * standalone page) only send it high-level commands, so motion stays smooth and real-time.
 */
export function mountSwarmOverlay({
  doc = globalThis.document,
  win = globalThis.window,
  nonce = '',
  onEvent,
  onAction,
  swarm: swarmOptions = {},
  clearConsoleOnRouteChange = false
} = {}) {
  if (!doc) throw new Error('mountSwarmOverlay requires a document');
  doc.getElementById?.(HOST_ID)?.remove?.();

  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = HOST_STYLE;
  (doc.documentElement || doc.body).appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = h(doc, 'style');
  style.textContent = OVERLAY_CSS;
  const root = h(doc, 'div', 'sw-root');
  shadow.append(style, root);

  const config = { ...DEFAULT_SWARM, ...swarmOptions };
  const clock = createClock({ win });
  const sound = createSound(win);
  const rulers = createRulers(doc, win, root);
  const selections = createSelectionLayer(doc, root);
  const pins = createIssuePins(doc, win, root, { onSelectTicket: (ticket) => onEvent?.({ type: 'ticket_selected', ticket }) });
  const cursorLayer = h(doc, 'div', 'sw-cursors');
  root.appendChild(cursorLayer);
  const swarm = createSwarm({ doc, win, container: cursorLayer, clock });
  const patches = createPatchManager(doc);
  const consoleCollector = createConsoleCollector({ targetWindow: win, nonce, maxEntries: 100 });
  const roleSelections = new Map();
  const feed = createFeed(doc, root);

  let destroyed = false;
  let cachedTickets = [];
  let currentRoute = win?.location?.pathname || '/';
  let lastProgressEvent = 0;
  let inspecting = 0;

  const getRoute = () => win?.location?.pathname || currentRoute || '/';
  const viewportNow = () => ({
    width: win?.innerWidth || doc.documentElement?.clientWidth || 1440,
    height: win?.innerHeight || doc.documentElement?.clientHeight || 900
  });

  const hud = createHud(doc, root, {
    onTour: (wantsStart) => (wantsStart ? startTour() : stopTour()),
    onAudit: () => auditFromHud(),
    onSpeed: (speed) => configure({ speed }),
    onSound: (enabled) => configure({ sound: enabled }),
    onMinimize: (minimized) => {
      cursorLayer.style.opacity = minimized ? '0' : '1';
      onAction?.({ type: 'hud_minimized', minimized });
    }
  });

  const syncHudAgents = () => hud.setAgents(swarm.list());
  const syncRulers = () => rulers.setVisible(config.rulers && (tour.snapshot().running || inspecting > 0));

  const tour = createTour({
    doc,
    win,
    clock,
    swarm,
    selections,
    sound,
    onProgress(progress) {
      hud.setTour(progress);
      syncHudAgents();
      if (clock.time - lastProgressEvent < PROGRESS_EVENT_MS * clock.scale) return;
      lastProgressEvent = clock.time;
      onEvent?.({ type: 'tour_progress', ...progress });
    },
    onDone(result) {
      hud.setTour(result.cancelled ? {} : { running: false, done: result.done, total: result.total });
      syncRulers();
      onEvent?.({ type: 'tour_done', ...result });
    }
  });
  const inspector = createInspector({ doc, win, clock, swarm, selections, sound });

  // --- Remote-controlled role cursors ---------------------------------------------------------

  function releaseRoleSelection(id) {
    roleSelections.get(id)?.selection.release();
    roleSelections.delete(id);
  }

  function upsertRoleCursor(raw = {}) {
    const id = cleanText(raw.id, 48);
    if (!id) return null;
    let agent = swarm.get(id);
    if (!agent) {
      agent = swarm.add({ id, kind: 'role', name: raw.label || id, color: raw.color, x: Number(raw.x), y: Number(raw.y) });
      syncHudAgents();
    }
    if (raw.color !== undefined) {
      agent.color = safeColor(raw.color, agent.color);
      agent.view.setColor(agent.color);
    }
    if (raw.label !== undefined) {
      agent.name = cleanText(raw.label || id, 48);
      agent.view.setName(agent.name);
    }
    agent.view.setStatus(raw.status ?? '');

    const el = queryOne(doc, raw.selector);
    const staticBox = toBox(raw.box);
    releaseRoleSelection(id);
    if (el || staticBox) {
      const selection = selections.create({ color: agent.color });
      selection.setRect(el ? boxOf(el.getBoundingClientRect()) : staticBox);
      roleSelections.set(id, { selection, el });
    }
    if (el && !isFiniteNumber(raw.x)) {
      swarm.flyTo(agent, () => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
    } else if (isFiniteNumber(raw.x) && isFiniteNumber(raw.y)) {
      swarm.flyTo(agent, { x: Number(raw.x), y: Number(raw.y) });
    }
    return agent;
  }

  function spawnCursors(input = []) {
    const list = Array.isArray(input) ? input : Array.isArray(input?.cursors) ? input.cursors : [];
    if (input?.clear) {
      for (const agent of swarm.list()) {
        if (agent.kind !== 'role') continue;
        releaseRoleSelection(agent.id);
        swarm.remove(agent.id);
      }
    }
    list.forEach(upsertRoleCursor);
    syncHudAgents();
    return list.length;
  }

  function moveCursor(idOrCursor, patch = {}) {
    upsertRoleCursor(typeof idOrCursor === 'string' ? { ...patch, id: idOrCursor } : idOrCursor || {});
  }

  function removeCursor(id) {
    releaseRoleSelection(cleanText(id, 48));
    const removed = swarm.remove(id);
    syncHudAgents();
    return removed;
  }

  function triggerClick(id) {
    const agent = swarm.get(id);
    if (!agent) return false;
    agent.view.press();
    sound.click();
    return true;
  }

  // --- Swarm configuration, tour and audit ----------------------------------------------------

  function getState() {
    const agents = swarm.list();
    return {
      agents: agents.length,
      workers: agents.filter((a) => a.kind === 'worker').length,
      roles: agents.filter((a) => a.kind === 'role').map((a) => a.id),
      tour: tour.snapshot(),
      pins: pins.count(),
      speed: clock.scale,
      sound: sound.enabled,
      rulers: config.rulers
    };
  }

  function configure(next = {}) {
    if (isFiniteNumber(next.agents)) {
      config.agents = Math.max(0, Math.min(MAX_WORKERS, Math.round(Number(next.agents))));
      if (!tour.snapshot().running) swarm.setWorkerCount(config.agents);
    }
    if (isFiniteNumber(next.speed)) {
      clock.setScale(Number(next.speed));
      config.speed = clock.scale;
      hud.setSpeed(config.speed);
    }
    if (typeof next.sound === 'boolean') {
      config.sound = next.sound;
      sound.setEnabled(next.sound);
      hud.setSound(next.sound);
    }
    if (typeof next.rulers === 'boolean') config.rulers = next.rulers;
    if (typeof next.minimized === 'boolean') {
      hud.setMinimized(next.minimized);
      cursorLayer.style.opacity = next.minimized ? '0' : '1';
    }
    syncHudAgents();
    syncRulers();
    return getState();
  }

  function startTour(options = {}) {
    inspector.cancel();
    if (isFiniteNumber(options.speed)) configure({ speed: options.speed });
    const snapshot = tour.start({ agents: options.agents ?? Math.max(config.agents, 14), maxLayers: options.maxLayers });
    hud.setTour(snapshot);
    syncRulers();
    onAction?.({ type: 'tour_started', total: snapshot.total });
    return snapshot;
  }

  function stopTour() {
    const stopped = tour.stop();
    swarm.setWorkerCount(config.agents);
    syncHudAgents();
    syncRulers();
    return stopped;
  }

  function inspectFindings(findings, options) {
    if (tour.snapshot().running) return false;
    inspecting += 1;
    syncRulers();
    inspector
      .inspect(findings, options)
      .catch(() => {})
      .finally(() => {
        inspecting -= 1;
        if (destroyed) return;
        swarm.setWorkerCount(config.agents);
        syncHudAgents();
        syncRulers();
      });
    syncHudAgents();
    return true;
  }

  function runAudit(opts = {}) {
    // A tour hides layers; auditing a half-built page would report false negatives, so end it first.
    if (tour.snapshot().running) stopTour();
    const viewport = opts.viewport || viewportNow();
    const consoleEntries = opts.consoleEntries ?? consoleCollector.getEntries();
    const findings = runDomAudit({ doc, win, checks: opts.checks, viewport, consoleEntries });
    if (opts.clearConsole) consoleCollector.clear();
    if (opts.animate) inspectFindings(findings, { follow: Boolean(opts.follow) });
    return { pathname: getRoute(), viewport, findings };
  }

  function setTickets(tickets = [], pathname, opts = {}) {
    cachedTickets = Array.isArray(tickets) ? tickets : [];
    const width = typeof opts === 'number' ? opts : opts?.viewportWidth;
    if (opts?.clearConsole) consoleCollector.clear();
    return pins.setTickets(cachedTickets, pathname || getRoute(), width ?? win?.innerWidth);
  }

  const summarize = (tickets) => {
    const counts = tickets.reduce((acc, t) => ((acc[t?.status] = (acc[t?.status] || 0) + 1), acc), {});
    return {
      open: (counts.open || 0) + (counts.reopened || 0),
      awaiting_reverify: counts.awaiting_reverify || 0,
      verified: counts.verified || 0
    };
  };

  /** HUD "Auditar": audit locally, show provisional pins and report upstream for ticketing. */
  function auditFromHud() {
    if (tour.snapshot().running) return;
    const result = runAudit({ animate: true, follow: true });
    const local = result.findings.map((finding, i) => ({
      ...finding,
      id: `L-${i + 1}`,
      status: 'open',
      round: 1,
      pathname: result.pathname,
      viewport: result.viewport
    }));
    setTickets(local, result.pathname, result.viewport.width);
    hud.setSummary(summarize(local));
    onAction?.({ type: 'audit_report', pathname: result.pathname, viewport: result.viewport, findings: result.findings });
  }

  // --- Command dispatch -----------------------------------------------------------------------

  const actions = {
    spawn_cursors: (cmd) => ({
      ok: true,
      count: spawnCursors(cmd.cursors ? cmd : Array.isArray(cmd.agents) ? { cursors: cmd.agents, clear: cmd.clear } : cmd)
    }),
    move_cursor: (cmd) => (moveCursor(cmd.cursor ?? cmd), { ok: true }),
    trigger_click: (cmd) => ({ ok: triggerClick(cmd.id) }),
    remove_cursor: (cmd) => ({ ok: removeCursor(cmd.id ?? cmd.cursorId) }),
    set_tickets(cmd) {
      const tickets = Array.isArray(cmd.tickets) ? cmd.tickets : [];
      const count = setTickets(tickets, cmd.pathname, { viewportWidth: cmd.viewportWidth });
      hud.setSummary(cmd.summary && typeof cmd.summary === 'object' ? cmd.summary : summarize(tickets));
      return { ok: true, count: tickets.length, pins: count };
    },
    update_summary: (cmd) => (hud.setSummary(cmd.summary ?? cmd), { ok: true }),
    apply_patch: (cmd) => ({ ok: patches.apply(cmd.patch ?? cmd) }),
    revert_patch: (cmd) => ({ ok: patches.revert(cmd.id ?? cmd.patchId) }),
    start_tour: (cmd) => ({ ok: true, ...startTour(cmd) }),
    stop_tour: () => ({ ok: true, stopped: stopTour() }),
    inspect_findings: (cmd) => ({ ok: inspectFindings(cmd.findings, { sweep: cmd.sweep !== false, follow: Boolean(cmd.follow) }) }),
    configure_swarm: (cmd) => ({ ok: true, ...configure(cmd) }),
    get_swarm_state: () => ({ ok: true, ...getState() }),
    snapshot: (cmd) => ({ ok: true, ...snapshotPage({ doc, win, scope: cmd.scope === 'page' ? 'page' : 'viewport', max: cmd.max }) }),
    query: (cmd) => ({ ok: true, ...queryElement({ doc, win, selector: cmd.selector, text: cmd.text, prefer: cmd.prefer }) }),
    post_message: (cmd) => ({ ok: feed.post({ ...cmd, color: cmd.color ?? swarm.get(cmd.agentId ?? cmd.from)?.color }) }),
    clear_messages: () => (feed.clear(), { ok: true }),
    scroll: (cmd) => scrollPage({ doc, win, selector: cmd.selector, to: cmd.to, by: cmd.by, smooth: cmd.smooth !== false })
  };

  /** Runs an overlay command by name; unknown actions fail closed. */
  function exec(action, command = {}) {
    if (destroyed) return { ok: false, error: 'Overlay destroyed' };
    if (!Object.hasOwn(actions, action)) return { ok: false, error: `Unknown overlay command "${cleanText(action, 40)}"` };
    return actions[action](command && typeof command === 'object' ? command : {});
  }

  // --- Frame loop & route tracking ------------------------------------------------------------

  clock.onTick((now) => {
    if (!host.isConnected) return destroy();
    swarm.update(now);
    for (const { selection, el } of roleSelections.values()) {
      if (el?.isConnected) selection.setRect(boxOf(el.getBoundingClientRect()));
    }
    pins.reposition();
    rulers.update(selections.boxes());
  });

  function syncRoute() {
    if (destroyed) return;
    const next = getRoute();
    if (next === currentRoute) return;
    currentRoute = next;
    if (clearConsoleOnRouteChange) consoleCollector.clear();
    pins.setTickets(cachedTickets, currentRoute, win?.innerWidth);
    onEvent?.({ type: 'route_change', pathname: currentRoute });
  }
  win?.addEventListener?.('popstate', syncRoute);
  win?.addEventListener?.('hashchange', syncRoute);
  const routeTimer = setInterval(syncRoute, ROUTE_POLL_MS);
  routeTimer?.unref?.();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearInterval(routeTimer);
    win?.removeEventListener?.('popstate', syncRoute);
    win?.removeEventListener?.('hashchange', syncRoute);
    tour.destroy();
    inspector.destroy();
    patches.revertAll();
    clock.stop();
    swarm.clear();
    consoleCollector.destroy();
    sound.destroy();
    host.remove?.();
  }

  configure(config);
  clock.start();

  return {
    exec,
    spawnCursors,
    moveCursor,
    triggerClick,
    removeCursor,
    runAudit,
    setTickets,
    applyPatch: (patch) => patches.apply(patch),
    revertPatch: (id) => patches.revert(id),
    startTour,
    stopTour,
    inspectFindings,
    configure,
    getState,
    clearConsole: () => consoleCollector.clear(),
    updateSummary: (summary) => hud.setSummary(summary),
    getRoute,
    probeSource: () => MAIN_WORLD_PROBE_SOURCE(nonce),
    destroy
  };
}
