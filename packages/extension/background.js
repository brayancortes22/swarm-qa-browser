const DEFAULT_PORT = 47921, CTRL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const MODS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };
const KEYS = { Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46], Space: ['Space', 32, ' '], ' ': ['Space', 32, ' '], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40] };
const OVERLAY_CMDS = new Set(['spawn_cursors', 'move_cursor', 'remove_cursor', 'set_tickets', 'update_summary']);
const authorizedTabs = new Map();
let busPort = DEFAULT_PORT, ws = null, connectPromise = null, reconnectTimer = null, keepaliveTimer = null, retryMs = 2000;

const clean = (v, max = 280) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(CTRL_RE, '').slice(0, max);
const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
const tabMsg = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg);
const sendWs = (data) => { if (ws?.readyState === 1) ws.send(JSON.stringify(data)); };
const stopKeepalive = () => { if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; } };
const metaOf = (e) => ({ url: e.url, pathname: e.pathname, title: e.title, viewport: e.viewport });
const publicTab = (t) => (t ? { tabId: t.tabId, debuggerAttached: t.debuggerAttached, ...metaOf(t), probeEnabled: t.probeEnabled, findingsCount: t.findings.length } : null);
const pushLog = (e, log) => { e.cdpLogs.push({ ...log, untrustedPageData: true }); if (e.cdpLogs.length > 50) e.cdpLogs.splice(0, e.cdpLogs.length - 50); };

function buildKeyEvent(rawKey = '', rawMods = []) {
  const k = String(rawKey || ''), modifiers = Array.isArray(rawMods) ? rawMods.reduce((m, x) => m | (MODS[x] || 0), 0) : (Number(rawMods) || 0);
  if (KEYS[k]) { const [code, vk, text] = KEYS[k]; return { key: k === 'Space' ? ' ' : k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text, unmodifiedText: text } : {}) }; }
  const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0, code = k.length === 1 && /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k;
  return { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(k.length === 1 ? { text: k, unmodifiedText: k } : {}) };
}
const loadPort = async () => { const p = Number((await chrome.storage.local.get('swarmBusPort'))?.swarmBusPort); return (busPort = Number.isInteger(p) && p >= 1 && p <= 65535 ? p : DEFAULT_PORT); };
function scheduleReconnect() {
  if (reconnectTimer || !authorizedTabs.size) return;
  const wait = retryMs; retryMs = Math.min(10000, retryMs * 2);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectBus().catch(() => {}); }, wait);
}
async function connectBus() {
  if (ws?.readyState === 1) return true;
  return (connectPromise ||= (async () => {
    const port = await loadPort(), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 1200);
    let pairRes; try { pairRes = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', signal: ctl.signal }); } finally { clearTimeout(timer); }
    if (!pairRes.ok) throw new Error(`Pair HTTP ${pairRes.status}`);
    const { token } = await pairRes.json(), sock = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { try { sock.close(); } catch {} reject(new Error('WS timeout')); }, 2000);
      sock.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      sock.addEventListener('error', () => { clearTimeout(t); reject(new Error('WS connect error')); }, { once: true });
    });
    ws = sock; retryMs = 2000;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopKeepalive(); keepaliveTimer = setInterval(() => (ws?.readyState === 1 ? sendWs({ type: 'ping' }) : stopKeepalive()), 20000);
    sock.addEventListener('message', (ev) => { try { const m = JSON.parse(String(ev.data || '')); if (m?.type === 'command') handleBusCommand(m); } catch {} });
    sock.addEventListener('close', () => { if (ws === sock) { ws = null; stopKeepalive(); scheduleReconnect(); } });
    for (const e of authorizedTabs.values()) sendWs({ type: 'hello', tabId: e.tabId, ...metaOf(e) });
    return true;
  })().finally(() => { connectPromise = null; }));
}
async function injectAndInit(tabId, probeEnabled, runProbe = true) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.bundle.js', 'content.js'], world: 'ISOLATED' });
  const info = await tabMsg(tabId, { type: 'init_overlay', nonce: crypto.randomUUID().replace(/-/g, ''), tabId });
  if (!info?.ok) throw new Error(info?.error || 'Overlay init failed');
  if (runProbe && probeEnabled && info.probeSource) await cdp(tabId, 'Runtime.evaluate', { expression: info.probeSource, silent: true });
  return info;
}
function syncTabAfterNav(tabId) {
  const entry = authorizedTabs.get(tabId);
  if (!entry) return Promise.resolve(null);
  return (entry.syncing ||= (async () => {
    const info = await injectAndInit(tabId, entry.probeEnabled, true);
    Object.assign(entry, { url: info.url, pathname: info.pathname, title: info.title, viewport: info.viewport });
    sendWs({ type: 'route_changed', tabId, ...metaOf(entry) });
    return entry;
  })().finally(() => { entry.syncing = null; }));
}
async function detachSession(tabId, { keepWs = false, tabAlive = true } = {}) {
  const entry = authorizedTabs.get(tabId); authorizedTabs.delete(tabId);
  if (tabAlive) { try { await tabMsg(tabId, { type: 'destroy_overlay' }); } catch {} if (entry?.debuggerAttached) try { await chrome.debugger.detach({ tabId }); } catch {} }
  if (!keepWs && ws?.readyState === 1) { ws.close(); ws = null; stopKeepalive(); connectBus().catch(() => {}); }
  return { ok: true };
}
async function authorizeTab({ tabId, url, probeEnabled = true }) {
  if (!Number.isInteger(tabId) || !/^https?:\/\//i.test(String(url || ''))) throw new Error('Solo se admiten pestañas http:// o https://');
  if (authorizedTabs.has(tabId)) await detachSession(tabId, { keepWs: true });
  const entry = { tabId, debuggerAttached: false, url, pathname: '/', title: '', viewport: null, probeEnabled: Boolean(probeEnabled), cdpLogs: [], findings: [], syncing: null };
  authorizedTabs.set(tabId, entry);
  try {
    const info = await injectAndInit(tabId, entry.probeEnabled, false);
    await chrome.debugger.attach({ tabId }, '1.3'); entry.debuggerAttached = true;
    await Promise.all(['DOM.enable', 'Runtime.enable', 'Network.enable', 'Page.enable'].map((m) => cdp(tabId, m)));
    if (entry.probeEnabled && info.probeSource) await cdp(tabId, 'Runtime.evaluate', { expression: info.probeSource, silent: true });
    Object.assign(entry, { url: info.url, pathname: info.pathname, title: info.title, viewport: info.viewport });
    await connectBus().catch(() => false);
    sendWs({ type: 'hello', tabId, ...metaOf(entry), selected: true });
    return { ok: true, tab: publicTab(entry), busConnected: ws?.readyState === 1 };
  } catch (err) { await detachSession(tabId, { keepWs: true }); throw err; }
}

const waitTabLoad = (tabId, ms = 4500) => new Promise((resolve) => {
  const done = () => { clearTimeout(t); chrome.tabs.onUpdated.removeListener(fn); resolve(); };
  const fn = (id, ch) => { if (id === tabId && ch.status === 'complete') done(); };
  const t = setTimeout(done, ms); chrome.tabs.onUpdated.addListener(fn);
});
async function runAuditAndCache(tabId, entry, cmd = {}) {
  const r = await tabMsg(tabId, { type: 'run_audit', command: cmd, cdpLogs: entry.cdpLogs });
  if (r?.ok === false) throw new Error(r.error || 'Audit failed');
  entry.findings = Array.isArray(r?.findings) ? r.findings : [];
  return r;
}
const COMMANDS = {
  run_audit: runAuditAndCache,
  async set_viewport(tabId, entry, cmd) {
    if (cmd.reset) await cdp(tabId, 'Emulation.clearDeviceMetricsOverride');
    else {
      const w = Number(cmd.width) || 1440, h = Number(cmd.height) || 900, mobile = cmd.mobile !== undefined ? Boolean(cmd.mobile) : w <= 480;
      await cdp(tabId, 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: Number(cmd.deviceScaleFactor) || (mobile ? 2 : 1), mobile });
      entry.viewport = { width: w, height: h };
    }
    sendWs({ type: 'route_changed', tabId, url: entry.url, pathname: entry.pathname, title: entry.title, viewport: entry.viewport });
    return { ok: true, viewport: entry.viewport, reset: Boolean(cmd.reset) };
  },
  async click(tabId, _entry, cmd) {
    const r = cmd.selector ? await tabMsg(tabId, { type: 'resolve_rect', selector: cmd.selector }) : { ok: true, x: Number(cmd.x), y: Number(cmd.y), selector: null };
    if (!r?.ok || !Number.isFinite(r.x) || !Number.isFinite(r.y)) throw new Error(r?.error || 'Invalid click target');
    const button = cmd.button || 'left', clickCount = Number(cmd.clickCount) || 1;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp(tabId, 'Input.dispatchMouseEvent', type === 'mouseMoved' ? { type, x: r.x, y: r.y } : { type, x: r.x, y: r.y, button, clickCount });
    return { clicked: true, x: r.x, y: r.y, selector: r.selector, trusted: true };
  },
  async fill(tabId, _entry, cmd) {
    const r = await tabMsg(tabId, { type: 'fill_element', selector: cmd.selector, value: cmd.value });
    if (!r?.ok) throw new Error(r?.error || 'Fill failed');
    return r.sensitive ? { ...r, value: '[redacted]' } : r;
  },
  async press_key(tabId, _entry, cmd) {
    if (cmd.selector) { const r = await tabMsg(tabId, { type: 'resolve_rect', selector: cmd.selector, focus: true }); if (!r?.ok) throw new Error(r?.error || 'Key target not found'); }
    const kp = buildKeyEvent(cmd.key, cmd.modifiers);
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...kp });
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...kp });
    return { pressed: true, key: kp.key };
  },
  async navigate(tabId, entry, cmd) {
    const u = new URL(String(cmd.url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http/https URLs allowed');
    const wait = entry.url.split('#')[0] === u.href.split('#')[0] ? new Promise((r) => setTimeout(r, 150)) : waitTabLoad(tabId);
    await cdp(tabId, 'Page.navigate', { url: u.href }); await wait; await syncTabAfterNav(tabId);
    return { navigated: true, url: entry.url, pathname: entry.pathname };
  }
};
async function handleBusCommand({ commandId, tabId, command = {} }) {
  try {
    const entry = authorizedTabs.get(tabId), action = command.action || command.type;
    if (!entry) throw new Error(`Tab ${tabId} is not authorized`);
    const result = OVERLAY_CMDS.has(action)
      ? await tabMsg(tabId, { type: action, command }).then((r) => { if (r?.ok === false) throw new Error(r.error || 'Overlay failed'); return r; })
      : Object.hasOwn(COMMANDS, action) ? await COMMANDS[action](tabId, entry, command) : (() => { throw new Error(`Unknown command "${action}"`); })();
    sendWs({ type: 'command_result', commandId, tabId, ok: true, result });
  } catch (err) { sendWs({ type: 'command_result', commandId, tabId, ok: false, error: clean(err?.message || String(err)) }); }
}

chrome.debugger.onEvent.addListener((src, method, p) => {
  const e = authorizedTabs.get(src.tabId); if (!e) return;
  if (method === 'Runtime.exceptionThrown') pushLog(e, { kind: 'error', uncaught: true, message: clean(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text), source: clean(p?.exceptionDetails?.url), line: Number(p?.exceptionDetails?.lineNumber) || 0 });
  else if (method === 'Runtime.consoleAPICalled' && p?.type === 'error') pushLog(e, { kind: 'console.error', message: clean((p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')) });
  else if (method === 'Network.responseReceived' && Number(p?.response?.status) >= 400) pushLog(e, { kind: 'fetch', status: p.response.status, url: clean(p.response.url) });
  else if (method === 'Network.loadingFailed' && !p?.canceled) pushLog(e, { kind: 'fetch', status: 0, message: clean(p?.errorText || 'Network failure') });
});
chrome.debugger.onDetach.addListener((src) => { const e = authorizedTabs.get(src.tabId); if (e) { e.debuggerAttached = false; detachSession(src.tabId).catch(() => {}); } });
chrome.tabs.onRemoved.addListener((tabId) => { if (authorizedTabs.has(tabId)) detachSession(tabId, { tabAlive: false }).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, ch) => { if (ch.status === 'complete' && authorizedTabs.has(tabId)) syncTabAfterNav(tabId).catch(() => {}); });

const emitEvent = async (msg, tid) => { if (!authorizedTabs.has(tid)) return { ok: false }; await connectBus().catch(() => false); sendWs({ type: 'finding_event', tabId: tid, eventType: msg.type, payload: msg.action ?? msg.event }); return { ok: true }; };
const RUNTIME_HANDLERS = {
  async route_changed(msg, tid) { const e = authorizedTabs.get(tid); if (!e) return { ok: false }; Object.assign(e, { url: msg.url, pathname: msg.pathname, title: msg.title, viewport: msg.viewport }); await connectBus().catch(() => false); sendWs({ type: 'route_changed', tabId: tid, url: e.url, pathname: e.pathname, title: e.title, viewport: e.viewport }); return { ok: true }; },
  overlay_action: emitEvent, overlay_event: emitEvent, authorize_tab: (msg) => authorizeTab(msg), detach_tab: (_msg, tid) => detachSession(tid),
  async get_status(_msg, tid) { await connectBus().catch(() => false); return { ok: true, busConnected: ws?.readyState === 1, port: busPort, tab: publicTab(authorizedTabs.get(tid)) }; },
  async set_port(msg) { const p = Number(msg.port); if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Puerto inválido (1-65535)'); await chrome.storage.local.set({ swarmBusPort: p }); busPort = p; if (ws) { ws.close(); ws = null; } return { ok: true, port: busPort, busConnected: await connectBus().catch(() => false) }; },
  async export_findings(_msg, tid) {
    const e = authorizedTabs.get(tid); if (!e) throw new Error('Activa primero la sesión en esta pestaña');
    try { await runAuditAndCache(tid, e); } catch {}
    return { ok: true, report: { exportedAt: new Date().toISOString(), tabId: tid, url: e.url, pathname: e.pathname, viewport: e.viewport, untrustedPageData: true, findings: e.findings } };
  }
};
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = RUNTIME_HANDLERS[msg?.type];
  if (!fn) { sendResponse({ ok: false }); return false; }
  Promise.resolve(fn(msg, msg?.tabId ?? sender?.tab?.id)).then(sendResponse).catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});
