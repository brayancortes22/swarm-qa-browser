import { DEFAULT_PORT, loadBusPort, loadPairCode, loadSessionTabs, mapDebuggerEvent, saveSessionTabs } from './helpers.js';
import { createBusCommandHandler } from './commands.js';

const TAB_ALLOWED = new Set(['route_changed', 'overlay_action', 'overlay_event']);
const authorizedTabs = new Map(),
  helloWaiters = new Map();
let busPort = DEFAULT_PORT,
  ws = null,
  connectPromise = null,
  reconnectTimer = null,
  keepaliveTimer = null,
  retryMs = 2000;
// Pairing state shown in the popup: 'unknown' (not tried yet) | 'ok' | 'missing' (no code saved) | 'invalid' (bus rejected it) | 'locked' (too many attempts).
let pairState = 'unknown';

const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
const tabMsg = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg);
const sendWs = (data) => {
  if (ws?.readyState === 1) ws.send(JSON.stringify(data));
};
const stopKeepalive = () => {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
};
const metaOf = (e) => ({ url: e.url, pathname: e.pathname, title: e.title, viewport: e.viewport });
const publicTab = (t) =>
  t
    ? { tabId: t.tabId, debuggerAttached: t.debuggerAttached, ...metaOf(t), probeEnabled: t.probeEnabled, findingsCount: t.findings.length }
    : null;
const pushLog = (e, log) => {
  e.cdpLogs.push({ ...log, untrustedPageData: true });
  if (e.cdpLogs.length > 50) e.cdpLogs.splice(0, e.cdpLogs.length - 50);
};

export async function hasHostPermission(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
    return Boolean(await chrome.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] }));
  } catch {
    return false;
  }
}

function scheduleReconnect() {
  // A missing/rejected pairing code needs the user, not retries (retries would trip the bus rate limit).
  if (reconnectTimer || pairState === 'missing' || pairState === 'invalid') return;
  const wait = retryMs;
  retryMs = Math.min(10000, retryMs * 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBus()
      .then((ok) => {
        if (!ok) scheduleReconnect();
      })
      .catch(() => scheduleReconnect());
  }, wait);
  reconnectTimer.unref?.();
}

async function connectBus() {
  if (ws?.readyState === 1) return true;
  return (connectPromise ||= (async () => {
    busPort = await loadBusPort();
    const ctl = new AbortController(),
      timer = setTimeout(() => ctl.abort(), 1200);
    const pairCode = await loadPairCode();
    if (pairState === 'invalid' || pairState === 'missing') {
      clearTimeout(timer);
      throw new Error(pairState === 'missing' ? 'El bus exige código de emparejamiento' : 'Código de emparejamiento incorrecto');
    }
    let pairRes;
    try {
      pairRes = await fetch(`http://127.0.0.1:${busPort}/pair`, {
        method: 'POST',
        headers: pairCode ? { 'x-swarm-pair-code': pairCode } : {},
        signal: ctl.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (pairRes.status === 401) {
      // Only buses started in strict mode ask for a code.
      pairState = pairCode ? 'invalid' : 'missing';
      throw new Error(pairCode ? 'Código de emparejamiento incorrecto' : 'El bus exige código de emparejamiento');
    }
    if (pairRes.status === 429) {
      pairState = 'locked';
      throw new Error('Demasiados intentos de emparejamiento; espera un minuto');
    }
    if (!pairRes.ok) throw new Error(`Pair HTTP ${pairRes.status}`);
    pairState = 'ok';
    const { token } = await pairRes.json(),
      sock = new WebSocket(`ws://127.0.0.1:${busPort}/?token=${encodeURIComponent(token)}`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        try {
          sock.close();
        } catch {}
        reject(new Error('WS timeout'));
      }, 2000);
      sock.addEventListener(
        'open',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true }
      );
      sock.addEventListener(
        'error',
        () => {
          clearTimeout(t);
          reject(new Error('WS connect error'));
        },
        { once: true }
      );
    });
    ws = sock;
    // Announce that this browser can open and attach tabs on request, with or without sessions.
    sock.send(JSON.stringify({ type: 'extension_hello' }));
    retryMs = 2000;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopKeepalive();
    keepaliveTimer = setInterval(() => (ws?.readyState === 1 ? sendWs({ type: 'ping' }) : stopKeepalive()), 20000);
    keepaliveTimer.unref?.();
    sock.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(String(ev.data || ''));
        if (m?.type === 'hello_ack') {
          const w = helloWaiters.get(m.tabId);
          if (w) {
            helloWaiters.delete(m.tabId);
            w();
          }
        }
        if (m?.type === 'command') handleBusCommand(m);
        if (m?.type === 'browser_command') handleBrowserCommand(m);
      } catch {}
    });
    sock.addEventListener('close', () => {
      if (ws === sock) {
        ws = null;
        stopKeepalive();
        for (const e of authorizedTabs.values()) e.helloSent = false;
        for (const w of helloWaiters.values()) w();
        helloWaiters.clear();
        scheduleReconnect();
      }
    });
    await Promise.all(
      Array.from(authorizedTabs.values())
        .filter((e) => e.debuggerAttached)
        .map((e) => sendHello(e))
    );
    return true;
  })().finally(() => {
    connectPromise = null;
  }));
}

function sendHello(entry, selected = false) {
  if (ws?.readyState !== 1) return Promise.resolve(false);
  entry.helloSent = true;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      helloWaiters.delete(entry.tabId);
      resolve(false);
    }, 1500);
    t.unref?.();
    helloWaiters.set(entry.tabId, () => {
      clearTimeout(t);
      resolve(true);
    });
    sendWs({ type: 'hello', tabId: entry.tabId, ...metaOf(entry), ...(selected || entry.selected ? { selected: true } : {}) });
    entry.selected = false;
  });
}

async function injectAndInit(tabId, probeEnabled, runProbe = true) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.bundle.js', 'content.js'], world: 'ISOLATED' });
  const info = await tabMsg(tabId, { type: 'init_overlay', nonce: crypto.randomUUID().replace(/-/g, ''), tabId });
  if (!info?.ok) throw new Error(info?.error || 'Overlay init failed');
  if (runProbe && probeEnabled && info.probeSource) await cdp(tabId, 'Runtime.evaluate', { expression: info.probeSource, silent: true });
  return info;
}

function syncTabAfterNav(tabId, tab) {
  const entry = authorizedTabs.get(tabId);
  if (!entry) return Promise.resolve(null);
  return (entry.syncing ||= (async () => {
    try {
      const liveTab = tab?.url ? tab : await chrome.tabs.get?.(tabId)?.catch?.(() => null);
      const curUrl = liveTab?.url || entry.url;
      if (!(await hasHostPermission(curUrl))) {
        await detachSession(tabId);
        return null;
      }
      const info = await injectAndInit(tabId, entry.probeEnabled, true);
      if (!(await hasHostPermission(info.url || curUrl))) {
        await detachSession(tabId);
        return null;
      }
      Object.assign(entry, { url: info.url, pathname: info.pathname, title: info.title, viewport: info.viewport });
      await saveSessionTabs(authorizedTabs);
      sendWs({ type: 'route_changed', tabId, ...metaOf(entry) });
      return entry;
    } catch {
      await detachSession(tabId).catch(() => {});
      return null;
    }
  })().finally(() => {
    entry.syncing = null;
  }));
}

async function detachSession(tabId, { tabAlive = true } = {}) {
  const entry = authorizedTabs.get(tabId);
  if (!entry) return { ok: true };
  authorizedTabs.delete(tabId);
  await saveSessionTabs(authorizedTabs);
  if (tabAlive) {
    try {
      await tabMsg(tabId, { type: 'destroy_overlay' });
    } catch {}
    if (entry.debuggerAttached)
      try {
        await chrome.debugger.detach({ tabId });
      } catch {}
  }
  if (entry.helloSent && ws?.readyState === 1) sendWs({ type: 'tab_closed', tabId });
  return { ok: true };
}

const entryOf = (tabId, url, probeEnabled, attached = false, selected = false) => ({
  tabId,
  debuggerAttached: attached,
  url,
  pathname: '/',
  title: '',
  viewport: null,
  probeEnabled: Boolean(probeEnabled),
  cdpLogs: [],
  findings: [],
  syncing: null,
  helloSent: false,
  selected
});

const ready = (async () => {
  for (const item of await loadSessionTabs()) {
    const tabId = item?.tabId;
    if (!Number.isInteger(tabId) || authorizedTabs.has(tabId)) continue;
    const liveTab = await chrome.tabs.get?.(tabId)?.catch?.(() => null);
    if (chrome.tabs?.get && !liveTab) continue;
    const url = liveTab?.url || item.url;
    if (!(await hasHostPermission(url))) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      continue;
    }
    if (
      !(await cdp(tabId, 'DOM.enable').then(
        () => true,
        () => false
      ))
    ) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      try {
        await tabMsg(tabId, { type: 'destroy_overlay' });
      } catch {}
      continue;
    }
    authorizedTabs.set(tabId, entryOf(tabId, url, item.probeEnabled, true));
    await syncTabAfterNav(tabId, liveTab).catch(() => {});
  }
  await saveSessionTabs(authorizedTabs);
  if (!(await connectBus().catch(() => false))) scheduleReconnect();
})();

async function authorizeTab({ tabId, url, probeEnabled = true }) {
  if (!Number.isInteger(tabId) || !(await hasHostPermission(url)))
    throw new Error('Solo se admiten pestañas http:// o https:// con permiso de origen');
  if (authorizedTabs.has(tabId)) await detachSession(tabId);
  const entry = entryOf(tabId, url, probeEnabled, false, true);
  authorizedTabs.set(tabId, entry);
  try {
    const info = await injectAndInit(tabId, entry.probeEnabled, false);
    if (!(await hasHostPermission(info.url || url))) throw new Error('Permiso de origen no concedido');
    await chrome.debugger.attach({ tabId }, '1.3');
    entry.debuggerAttached = true;
    await Promise.all(['DOM.enable', 'Runtime.enable', 'Network.enable', 'Page.enable'].map((m) => cdp(tabId, m)));
    if (entry.probeEnabled && info.probeSource) await cdp(tabId, 'Runtime.evaluate', { expression: info.probeSource, silent: true });
    Object.assign(entry, { url: info.url, pathname: info.pathname, title: info.title, viewport: info.viewport });
    await saveSessionTabs(authorizedTabs);
    const connected = await connectBus().catch(() => false);
    if (!connected) scheduleReconnect();
    else if (!entry.helloSent) await sendHello(entry, true);
    return { ok: true, tab: publicTab(entry), busConnected: ws?.readyState === 1 };
  } catch (err) {
    await detachSession(tabId);
    throw err;
  }
}

const waitTabLoad = (tabId, ms = 4500) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      chrome.tabs.onUpdated.removeListener?.(fn);
      resolve();
    };
    const fn = (id, ch) => {
      if (id === tabId && ch.status === 'complete') done();
    };
    const t = setTimeout(done, ms);
    t.unref?.();
    chrome.tabs.onUpdated.addListener(fn);
  });
async function runAuditAndCache(tabId, entry, cmd = {}) {
  const r = await tabMsg(tabId, { type: 'run_audit', command: cmd, cdpLogs: entry.cdpLogs });
  if (r?.ok === false) throw new Error(r.error || 'Audit failed');
  if (cmd.clearConsole) entry.cdpLogs.length = 0;
  entry.findings = Array.isArray(r?.findings) ? r.findings : [];
  return r;
}

const handleBusCommand = createBusCommandHandler({
  authorizedTabs,
  cdp,
  tabMsg,
  hasHostPermission,
  syncTabAfterNav,
  waitTabLoad,
  runAuditAndCache,
  sendWs,
  metaOf
});

chrome.debugger.onEvent.addListener((src, method, p) => {
  const e = authorizedTabs.get(src.tabId),
    log = e && mapDebuggerEvent(method, p, e.url);
  if (log) pushLog(e, log);
});
chrome.debugger.onDetach.addListener((src) => {
  ready
    .then(() => {
      const e = authorizedTabs.get(src.tabId);
      if (e) {
        e.debuggerAttached = false;
        return detachSession(src.tabId);
      }
    })
    .catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => (authorizedTabs.has(tabId) ? detachSession(tabId, { tabAlive: false }) : null)).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, ch, tab) => {
  const cur = authorizedTabs.get(tabId);
  if (cur && ch.status === 'loading' && ch.url) cur.cdpLogs.length = 0;
  ready
    .then(async () => {
      const e = authorizedTabs.get(tabId);
      if (!e) return;
      const navUrl = ch.url || tab?.url;
      if (navUrl && !(await hasHostPermission(navUrl))) return detachSession(tabId);
      if (ch.status === 'complete') await syncTabAfterNav(tabId, tab);
    })
    .catch(() => {});
});

const emitEvent = async (msg, tid) => {
  if (!authorizedTabs.has(tid)) return { ok: false };
  await connectBus().catch(() => false);
  sendWs({ type: 'finding_event', tabId: tid, eventType: msg.type, payload: msg.action ?? msg.event });
  return { ok: true };
};
/**
 * Browser-level commands from the bus: the agent can list tabs, open a URL or attach the swarm to
 * a tab on its own — no click in the popup is needed.
 */
async function handleBrowserCommand({ commandId, command = {} }) {
  const reply = (payload) => sendWs({ type: 'command_result', commandId, ...payload });
  try {
    await ready;
    const action = command.action;
    if (action === 'list_tabs') {
      const tabs = await chrome.tabs.query({});
      const list = tabs
        .filter((t) => /^https?:/i.test(t.url || ''))
        .map((t) => ({
          tabId: t.id,
          url: t.url,
          title: t.title || '',
          active: Boolean(t.active),
          attached: authorizedTabs.get(t.id)?.debuggerAttached === true
        }));
      return reply({ ok: true, result: { tabs: list } });
    }
    if (action === 'open_tab') {
      const url = new URL(String(command.url || ''));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http/https URLs can be opened');
      const tab = await chrome.tabs.create({ url: url.href, active: command.active !== false });
      // Poll instead of listening: the load may finish before a listener could be registered.
      for (let waited = 0; waited < 15000 && (await chrome.tabs.get(tab.id))?.status !== 'complete'; waited += 150) {
        await new Promise((done) => setTimeout(done, 150));
      }
      const session = await authorizeTab({ tabId: tab.id, url: (await chrome.tabs.get(tab.id))?.url || url.href, probeEnabled: true });
      return reply({ ok: true, result: { tabId: tab.id, ...session } });
    }
    if (action === 'attach_tab') {
      const tabs = await chrome.tabs.query({});
      const wanted = String(command.urlIncludes || '').toLowerCase();
      const tab = tabs.find((t) =>
        command.tabId != null
          ? t.id === command.tabId
          : wanted
            ? String(t.url || '')
                .toLowerCase()
                .includes(wanted)
            : t.active
      );
      if (!tab) throw new Error('No matching tab is open');
      const session = await authorizeTab({ tabId: tab.id, url: tab.url, probeEnabled: true });
      return reply({ ok: true, result: { tabId: tab.id, ...session } });
    }
    if (action === 'detach_tab') return reply({ ok: true, result: await detachSession(command.tabId) });
    throw new Error(`Unknown browser command "${String(action).slice(0, 40)}"`);
  } catch (err) {
    reply({ ok: false, error: String(err?.message || err).slice(0, 280) });
  }
}

// Connect on browser start, on install/update and every 30 s, so the swarm is available without opening the popup.
const autoConnect = () => connectBus().catch(() => false);
chrome.runtime.onStartup?.addListener(autoConnect);
chrome.runtime.onInstalled?.addListener(autoConnect);
chrome.alarms?.create('swarm-connect', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'swarm-connect') autoConnect();
});

const RUNTIME_HANDLERS = {
  async route_changed(msg, tid) {
    const e = authorizedTabs.get(tid);
    if (!e) return { ok: false };
    Object.assign(e, { url: msg.url, pathname: msg.pathname, title: msg.title, viewport: msg.viewport });
    await saveSessionTabs(authorizedTabs);
    await connectBus().catch(() => false);
    sendWs({ type: 'route_changed', tabId: tid, ...metaOf(e) });
    return { ok: true };
  },
  overlay_action: emitEvent,
  overlay_event: emitEvent,
  authorize_tab: (msg) => authorizeTab(msg),
  detach_tab: (_msg, tid) => detachSession(tid),
  async get_status(_msg, tid) {
    await connectBus().catch(() => false);
    return {
      ok: true,
      busConnected: ws?.readyState === 1,
      port: busPort,
      pairState,
      hasPairCode: Boolean(await loadPairCode()),
      tab: publicTab(authorizedTabs.get(tid))
    };
  },
  async set_pair_code(msg) {
    const raw = String(msg.code ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (raw.length !== 8) throw new Error('El código tiene 8 caracteres (formato XXXX-XXXX)');
    await chrome.storage.local.set({ swarmPairCode: `${raw.slice(0, 4)}-${raw.slice(4)}` });
    pairState = 'unknown';
    if (ws) {
      const old = ws;
      ws = null;
      stopKeepalive();
      try {
        old.close();
      } catch {}
    }
    for (const e of authorizedTabs.values()) e.helloSent = false;
    const ok = await connectBus().catch(() => false);
    if (!ok) scheduleReconnect();
    return { ok: true, busConnected: ok, pairState };
  },
  async set_port(msg) {
    const p = Number(msg.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Puerto inválido (1-65535)');
    await chrome.storage.local.set({ swarmBusPort: p });
    busPort = p;
    if (ws) {
      const old = ws;
      ws = null;
      stopKeepalive();
      try {
        old.close();
      } catch {}
    }
    for (const e of authorizedTabs.values()) e.helloSent = false;
    const ok = await connectBus().catch(() => false);
    if (!ok) scheduleReconnect();
    return { ok: true, port: busPort, busConnected: ok };
  },
  async export_findings(_msg, tid) {
    const e = authorizedTabs.get(tid);
    if (!e) throw new Error('Activa primero la sesión en esta pestaña');
    try {
      await runAuditAndCache(tid, e);
    } catch {}
    return {
      ok: true,
      report: {
        exportedAt: new Date().toISOString(),
        tabId: tid,
        url: e.url,
        pathname: e.pathname,
        viewport: e.viewport,
        untrustedPageData: true,
        findings: e.findings
      }
    };
  }
};
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type,
    fn = RUNTIME_HANDLERS[type];
  if (!fn) {
    sendResponse({ ok: false });
    return false;
  }
  // Content scripts report their page URL as sender.url; extension pages (the popup, also when opened in a tab) report an extension URL.
  const extensionBase = chrome.runtime.getURL?.('') || '';
  const fromContentScript = Boolean(sender?.tab) && !(extensionBase && String(sender.url || '').startsWith(extensionBase));
  const tid = fromContentScript ? sender.tab.id : msg?.tabId;
  Promise.resolve(
    ready.then(() => {
      if (fromContentScript && !TAB_ALLOWED.has(type)) throw new Error('Forbidden from content script');
      return fn(msg, tid);
    })
  )
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});
