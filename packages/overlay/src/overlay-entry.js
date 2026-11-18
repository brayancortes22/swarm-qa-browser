import { createCursorLayer } from './cursor-layer.js';
import { createIssuePins } from './issue-pins.js';
import { MAIN_WORLD_PROBE_SOURCE, createConsoleCollector } from './network-console.js';
import { runDomAudit } from './dom-auditor.js';

const OVERLAY_STYLE = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';

function normalizeBox(box) {
  if (!box || box.width == null || box.height == null) return undefined;
  return {
    left: box.left ?? box.x ?? 0,
    top: box.top ?? box.y ?? 0,
    width: box.width,
    height: box.height
  };
}

function resolveTarget(doc, data) {
  if (!data?.selector || typeof doc?.querySelector !== 'function') return data;
  try {
    const r = doc.querySelector(data.selector)?.getBoundingClientRect?.();
    if (!r) return data;
    return {
      ...data,
      x: data.x ?? (r.left + r.width / 2),
      y: data.y ?? (r.top + r.height / 2),
      box: data.box || { left: r.left, top: r.top, width: r.width, height: r.height }
    };
  } catch {
    return data;
  }
}

export function mountSwarmOverlay({ doc = globalThis.document, win = globalThis.window, nonce = '', onEvent, onAction, clearConsoleOnRouteChange = false, clearOnRouteChange = false } = {}) {
  if (!doc) throw new Error('mountSwarmOverlay requires a document');
  doc.getElementById?.('__swarm_qa_overlay')?.remove?.();

  const host = doc.createElement('div');
  host.id = '__swarm_qa_overlay';
  host.style.cssText = OVERLAY_STYLE;
  (doc.documentElement || doc.body).appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });
  const cursors = createCursorLayer(shadow);
  const consoleCollector = createConsoleCollector({ targetWindow: win, nonce, maxEntries: 100 });

  let cachedTickets = [];
  let currentRoute = win?.location?.pathname || '/';
  let destroyed = false;

  const getRoute = () => win?.location?.pathname || currentRoute || '/';

  const issuePins = createIssuePins(shadow, {
    onSelectTicket: (ticket) => onEvent?.({ type: 'ticket_selected', ticket }),
    onTogglePause: (paused) => onAction?.({ type: 'toggle_pause', paused }),
    onReaudit: () => onAction?.({ type: 'reaudit', pathname: getRoute() }),
    onClear: () => {
      cachedTickets = [];
      onAction?.({ type: 'clear_pins', pathname: getRoute() });
    }
  });

  const syncRoute = () => {
    if (destroyed) return;
    const next = getRoute();
    if (next === currentRoute) return;
    currentRoute = next;
    if (clearConsoleOnRouteChange || clearOnRouteChange) consoleCollector.clear();
    issuePins.setTickets(cachedTickets, currentRoute, win?.innerWidth);
    onEvent?.({ type: 'route_change', pathname: currentRoute });
  };

  const hist = win?.history;
  const origPush = typeof hist?.pushState === 'function' ? hist.pushState : null;
  const origReplace = typeof hist?.replaceState === 'function' ? hist.replaceState : null;
  if (origPush) {
    hist.pushState = function (...args) {
      const res = origPush.apply(this, args);
      syncRoute();
      return res;
    };
  }
  if (origReplace) {
    hist.replaceState = function (...args) {
      const res = origReplace.apply(this, args);
      syncRoute();
      return res;
    };
  }

  const onRouteEv = () => syncRoute();
  win?.addEventListener?.('popstate', onRouteEv);
  win?.addEventListener?.('hashchange', onRouteEv);
  const routeTimer = typeof setInterval === 'function' ? setInterval(syncRoute, 400) : null;
  routeTimer?.unref?.();

  function upsertOne(raw) {
    const resolved = resolveTarget(doc, raw || {});
    cursors.upsertCursor({ ...resolved, box: normalizeBox(resolved.box) });
  }

  function spawnCursors(input = []) {
    const list = Array.isArray(input) ? input : (Array.isArray(input?.cursors) ? input.cursors : []);
    if (input?.clear) cursors.clearAll();
    list.forEach(upsertOne);
    return list.length;
  }

  function moveCursor(idOrCursor, patch = {}) {
    const data = typeof idOrCursor === 'string' ? { ...patch, id: idOrCursor } : (idOrCursor || {});
    upsertOne(data);
  }

  function runAudit(opts = {}) {
    const vp = opts.viewport || {
      width: win?.innerWidth || doc.documentElement?.clientWidth || 1440,
      height: win?.innerHeight || doc.documentElement?.clientHeight || 900
    };
    const consoleEntries = opts.consoleEntries ?? consoleCollector.getEntries();
    const findings = runDomAudit({ doc, win, checks: opts.checks, viewport: vp, consoleEntries });
    if (opts.clearConsole) consoleCollector.clear();
    return { pathname: getRoute(), viewport: vp, findings };
  }

  function setTickets(tickets = [], pathname, opts = {}) {
    cachedTickets = Array.isArray(tickets) ? tickets : [];
    const vpWidth = typeof opts === 'number' ? opts : opts?.viewportWidth;
    if (opts?.clearConsole) consoleCollector.clear();
    issuePins.setTickets(cachedTickets, pathname || getRoute(), vpWidth ?? win?.innerWidth);
  }

  const appliedPatches = new Map();

  function applyPatch(patch) {
    if (!patch?.id || !doc) return false;
    if (patch.type === 'css' && patch.css) {
      let st = doc.getElementById(`__swarm_patch_${patch.id}`);
      if (!st) {
        st = doc.createElement('style');
        st.id = `__swarm_patch_${patch.id}`;
        (doc.head || doc.documentElement).appendChild(st);
      }
      st.textContent = patch.css;
      appliedPatches.set(patch.id, { type: 'css', el: st });
      return true;
    }
    if (patch.type === 'attr' && patch.selector && patch.attr) {
      const target = doc.querySelector(patch.selector);
      if (target) {
        const prev = target.getAttribute(patch.attr.name);
        target.setAttribute(patch.attr.name, patch.attr.value);
        appliedPatches.set(patch.id, { type: 'attr', el: target, name: patch.attr.name, prev });
        return true;
      }
    }
    return false;
  }

  function revertPatch(id) {
    const entry = appliedPatches.get(id);
    if (!entry) return false;
    if (entry.type === 'css') entry.el.remove?.();
    if (entry.type === 'attr') {
      if (entry.prev == null) entry.el.removeAttribute?.(entry.name);
      else entry.el.setAttribute?.(entry.name, entry.prev);
    }
    appliedPatches.delete(id);
    return true;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (routeTimer != null && typeof clearInterval === 'function') clearInterval(routeTimer);
    win?.removeEventListener?.('popstate', onRouteEv);
    win?.removeEventListener?.('hashchange', onRouteEv);
    if (hist && origPush) hist.pushState = origPush;
    if (hist && origReplace) hist.replaceState = origReplace;
    for (const id of Array.from(appliedPatches.keys())) revertPatch(id);
    cursors.clearAll();
    issuePins.destroy();
    consoleCollector.destroy();
    host.remove?.();
  }

  return {
    spawnCursors,
    moveCursor,
    triggerClick: (id) => cursors.triggerClick(id),
    removeCursor: (id) => cursors.removeCursor(id),
    runAudit,
    setTickets,
    applyPatch,
    revertPatch,
    clearConsole: () => consoleCollector.clear(),
    updateSummary: (stats) => issuePins.updateSummary(stats),
    getRoute,
    probeSource: () => MAIN_WORLD_PROBE_SOURCE(nonce),
    destroy
  };
}
