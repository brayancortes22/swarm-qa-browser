import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { DEFAULT_ROLES } from './roles.mjs';
import { LockManager } from './lock-manager.mjs';
import { DEFAULT_EXTENSION_ID, DEFAULT_PORT, acquireRegistryLock, clearBusRegistryIfOwned, createToken, getRegistryPath, isAllowedOrigin } from './session-auth.mjs';
import { TicketStore, sanitizePageText } from './ticket-store.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MUTATING = new Set(['set_viewport', 'click', 'fill', 'press_key', 'navigate']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_EVENTS = 250, MAX_BODY_BYTES = 1024 * 1024;
const httpError = (msg, statusCode = 400, code = 'RPC_ERROR') => Object.assign(new Error(msg), { statusCode, code });
const pickIds = (p) => p.ticketIds ?? p.ids ?? p.id ?? p.ticketId;

function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
function sanitizeData(v, depth = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v ?? null;
  if (typeof v === 'string') return sanitizePageText(v);
  if (depth >= 3) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitizeData(x, depth + 1));
  if (typeof v !== 'object') return sanitizePageText(v);
  return Object.entries(v).reduce((o, [k, val]) => (FORBIDDEN_KEYS.has(k) ? o : ((o[sanitizePageText(k, 64)] = sanitizeData(val, depth + 1)), o)), {});
}
function normalizeTab(src, prev) {
  const url = sanitizePageText(src.url ?? prev?.url ?? '');
  let pathname = src.pathname != null && src.pathname !== '' ? sanitizePageText(src.pathname) : '';
  if (!pathname) try { pathname = url ? sanitizePageText(new URL(url).pathname) : '/'; } catch { pathname = '/'; }
  const vp = src.viewport && typeof src.viewport === 'object' ? { width: Number(src.viewport.width) || 0, height: Number(src.viewport.height) || 0 } : (prev?.viewport ?? null);
  return { url, pathname, viewport: vp, title: src.title != null ? sanitizePageText(src.title) : (prev?.title ?? '') };
}
function sendJson(res, status, data, origin, cors) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (origin && cors) Object.assign(headers, { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, x-swarm-token', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'Origin' });
  res.writeHead(status, headers).end(JSON.stringify(data));
}
async function readJsonBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { if ((size += chunk.length) > MAX_BODY_BYTES) { req.destroy(); throw httpError('Request body too large', 413, 'PAYLOAD_TOO_LARGE'); } chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  try { return text ? JSON.parse(text) : {}; } catch { throw httpError('Invalid JSON body', 400, 'INVALID_JSON'); }
}
function listenLoopback(server, port, host, autoFallbackPort) {
  return new Promise((resolve, reject) => {
    const bind = (t, fb) => server.once('error', (e) => (e?.code === 'EADDRINUSE' && fb && t !== 0 ? bind(0, false) : reject(e))).listen(t, host, () => resolve(server.address().port));
    bind(port, autoFallbackPort);
  });
}

/**
 * Starts the local loopback WebSocket + HTTP swarm QA bus with Origin and bearer token security.
 */
export async function startSwarmBus({ port, host = '127.0.0.1', registryPath, extensionId = DEFAULT_EXTENSION_ID, autoFallbackPort = true } = {}) {
  if (typeof host !== 'string' || !LOOPBACK.has(host)) throw new Error(`Refusing non-loopback host "${host}"`);
  const reqPort = Number(port === undefined ? (process.env.SWARM_BUS_PORT ?? DEFAULT_PORT) : port);
  if (!Number.isInteger(reqPort) || reqPort < 0 || reqPort > 65535) throw new Error(`Invalid bus port "${port}"`);
  const regPath = registryPath || getRegistryPath(), token = createToken();
  const store = new TicketStore(), locks = new LockManager(), tabs = new Map(), events = [], waiters = new Set(), pending = new Map();
  let seq = 0, selectedTabId = null, boundPort = reqPort, closing = null;
  const publicTab = ({ ws: _ws, ...rest }) => ({ ...rest });
  const rejectPending = (pred, errMsg) => { for (const [id, e] of [...pending.entries()]) if (pred(e)) { pending.delete(id); clearTimeout(e.timer); e.reject(new Error(errMsg(e))); } };
  function pushEvent(type, data = {}) {
    const event = { seq: ++seq, type, ts: new Date().toISOString(), ...data };
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    for (const w of [...waiters]) if (seq > w.sinceSeq) { waiters.delete(w); clearTimeout(w.timer); w.resolve({ seq, events: events.filter((e) => e.seq > w.sinceSeq), timedOut: false }); }
    const frame = JSON.stringify({ type: 'event', event });
    for (const c of wss.clients) if (c.readyState === 1) c.send(frame);
    return event;
  }
  function dispatchToTab(tabId, command, timeoutMs = 15000) {
    const tab = tabs.get(tabId);
    if (!tab || tab.ws.readyState !== 1) return Promise.reject(httpError(`Tab ${tabId} is not connected`, 404, 'TAB_NOT_CONNECTED'));
    const commandId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(commandId); reject(httpError(`Tab ${tabId} command timed out`, 504, 'TIMEOUT')); }, Math.max(1, Number(timeoutMs) || 15000));
      pending.set(commandId, { tabId, ws: tab.ws, resolve, reject, timer });
      tab.ws.send(JSON.stringify({ type: 'command', commandId, tabId, command }));
    });
  }
  function waitForEvent(sinceSeq = 0, timeoutMs = 15000) {
    const target = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0, waitMs = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 15000;
    if (seq > target) return Promise.resolve({ seq, events: events.filter((e) => e.seq > target), timedOut: false });
    if (waitMs === 0) return Promise.resolve({ seq, events: [], timedOut: true });
    return new Promise((resolve) => {
      const entry = { sinceSeq: target, resolve, timer: setTimeout(() => { waiters.delete(entry); resolve({ seq, events: [], timedOut: true }); }, waitMs) };
      waiters.add(entry);
    });
  }

  const rpc = {
    'session.status': (p) => ({ ok: true, port: boundPort, host, extensionId, seq, selectedTabId, tabs: Array.from(tabs.values(), publicTab), locks: locks.status(p.tabId), roles: DEFAULT_ROLES, ticketsSummary: store.list().reduce((a, t) => ((a.total += 1), Object.hasOwn(a, t.status) && (a[t.status] += 1), a), { total: 0, open: 0, claimed: 0, awaiting_reverify: 0, verified: 0, reopened: 0, escalated: 0 }) }),
    'tabs.select': (p) => { if (!tabs.has(p.tabId)) throw httpError(`Tab ${p.tabId} is not connected`, 404, 'TAB_NOT_CONNECTED'); selectedTabId = p.tabId; pushEvent('tab_selected', { tabId: selectedTabId }); return { selectedTabId, tab: publicTab(tabs.get(selectedTabId)) }; },
    'tickets.list': (p) => store.list(p),
    'tickets.create': (p) => { const t = store.create(p); pushEvent('ticket_created', { ticket: t }); return t; },
    'tickets.claim': (p) => { const l = store.claim(pickIds(p), p.devAgentId ?? p.agentId); pushEvent('tickets_claimed', { ids: l.map((t) => t.id), claimedBy: l[0]?.claimedBy }); return l; },
    'tickets.markFixed': (p) => { const l = store.markFixed(pickIds(p), { devAgentId: p.devAgentId ?? p.agentId, summary: p.summary }); pushEvent('tickets_marked_fixed', { ids: l.map((t) => t.id) }); return l; },
    'tickets.verify': (p) => { const t = store.verify(p.id ?? p.ticketId, { agentId: p.agentId, passed: p.passed, evidence: p.evidence }); pushEvent('ticket_verified', { id: t.id, status: t.status, round: t.round }); return t; },
    'lock.acquire': (p) => { const l = locks.acquire({ ...p, tabId: p.tabId ?? selectedTabId }); pushEvent('lock_acquired', l); return l; },
    'lock.release': (p) => { const r = locks.release({ ...p, tabId: p.tabId ?? selectedTabId }); pushEvent('lock_released', r); return r; },
    'tab.command': (p) => {
      const targetTabId = p.tabId ?? selectedTabId, cmd = p.command ?? p, act = cmd?.action ?? cmd?.type;
      if (p.requireLock) locks.assertCanMutate({ agentId: p.agentId, tabId: targetTabId });
      else if (MUTATING.has(act)) { const cur = locks.status(targetTabId); if (cur.locked && cur.agentId !== p.agentId) throw httpError(`Tab ${targetTabId} is locked by "${cur.agentId}"`, 409, 'LOCK_HELD'); }
      return dispatchToTab(targetTabId, cmd, p.timeoutMs);
    },
    'events.await': (p) => waitForEvent(p.sinceSeq ?? 0, p.timeoutMs ?? 15000)
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin, path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (!isAllowedOrigin(origin, extensionId) || (path === '/pair' && origin && origin !== `chrome-extension://${extensionId}`)) return sendJson(res, 403, { ok: false, error: 'Forbidden origin' }, origin, false);
    if (req.method === 'OPTIONS') return sendJson(res, 204, {}, origin, true);
    if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true, port: boundPort, extensionId, tabsCount: tabs.size, seq }, origin, true);
    if (req.method === 'POST' && path === '/pair') return sendJson(res, 200, { port: boundPort, token, extensionId }, origin, true);
    if (req.method !== 'POST' || path !== '/rpc') return sendJson(res, 404, { ok: false, error: 'Not found' }, origin, true);
    if (!safeTokenEqual(req.headers['x-swarm-token'], token)) return sendJson(res, 401, { ok: false, error: 'Unauthorized' }, origin, true);
    try {
      const body = await readJsonBody(req), action = body?.action ?? body?.method;
      if (!Object.hasOwn(rpc, action)) throw httpError(`Unknown RPC action "${action}"`, 400, 'UNKNOWN_ACTION');
      sendJson(res, 200, { ok: true, result: await rpc[action](body?.params && typeof body.params === 'object' ? body.params : (body ?? {})) }, origin, true);
    } catch (err) {
      sendJson(res, err?.statusCode ?? (err?.code === 'LOCK_HELD' ? 409 : 400), { ok: false, error: err?.message ?? 'RPC error', code: err?.code ?? 'RPC_ERROR' }, origin, true);
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1'), deny = (s, r, m) => socket.end(`HTTP/1.1 ${s} ${r}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ error: m })}`);
    if (u.pathname !== '/') return deny(404, 'Not Found', 'Invalid WebSocket path');
    if (!isAllowedOrigin(req.headers.origin, extensionId)) return deny(403, 'Forbidden', 'Forbidden origin');
    const cand = (typeof req.headers['x-swarm-token'] === 'string' && req.headers['x-swarm-token']) || u.searchParams.get('token') || '';
    if (!safeTokenEqual(cand, token)) return deny(401, 'Unauthorized', 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    let primaryTabId = null;
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'command_result') {
        const cid = msg.commandId ?? msg.id ?? msg.requestId, entry = pending.get(cid);
        if (!entry) return;
        pending.delete(cid); clearTimeout(entry.timer);
        return (msg.ok === false || msg.error)
          ? entry.reject(new Error(typeof msg.error === 'string' ? msg.error : (msg.error?.message || 'Tab command failed')))
          : entry.resolve(msg.result !== undefined ? msg.result : msg);
      }
      if (msg.type === 'finding_event') {
        const { type: _t, ...rest } = msg;
        return pushEvent('finding_event', { ...sanitizeData(rest), tabId: msg.tabId ?? primaryTabId, untrustedPageData: true });
      }
      if (msg.type !== 'hello' && msg.type !== 'route_changed' && msg.type !== 'route_change') return;
      const t = msg.tab && typeof msg.tab === 'object' ? msg.tab : msg, isHello = msg.type === 'hello', tabId = isHello ? t.tabId : (t.tabId ?? primaryTabId);
      if (tabId == null || tabId === '') return;
      const prev = tabs.get(tabId), meta = normalizeTab(t, prev), now = new Date().toISOString();
      if (isHello || prev) tabs.set(tabId, { tabId, ...meta, untrustedPageData: true, connectedAt: prev?.connectedAt ?? now, updatedAt: now, ws });
      if (isHello) { primaryTabId = tabId; if (selectedTabId === null || !tabs.has(selectedTabId) || msg.selected === true) selectedTabId = tabId; }
      pushEvent(isHello ? 'tab_hello' : 'route_changed', { tabId, ...meta, untrustedPageData: true });
      if (isHello) ws.send(JSON.stringify({ type: 'hello_ack', tabId, selectedTabId, seq }));
    });
    ws.on('close', () => {
      rejectPending((e) => e.ws === ws, (e) => `Tab ${e.tabId} disconnected`);
      for (const [tabId, tab] of [...tabs.entries()]) if (tab.ws === ws) { tabs.delete(tabId); if (selectedTabId === tabId) selectedTabId = tabs.keys().next().value ?? null; pushEvent('tab_closed', { tabId }); }
    });
  });

  boundPort = await listenLoopback(server, reqPort, host, autoFallbackPort);
  const hostFmt = host.includes(':') ? `[${host}]` : host;
  try { acquireRegistryLock({ pid: process.pid, port: boundPort, host, token, extensionId, startedAt: new Date().toISOString() }, regPath); }
  catch (err) { wss.close(); server.close(); server.closeAllConnections?.(); throw err; }

  const close = () => (closing ??= (async () => {
    for (const w of [...waiters]) { clearTimeout(w.timer); w.resolve({ seq, events: [], timedOut: true, closed: true }); }
    waiters.clear(); rejectPending(() => true, () => 'Swarm bus closed');
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
    server.closeAllConnections?.(); await new Promise((r) => server.close(r));
    clearBusRegistryIfOwned(process.pid, regPath);
  })());
  return { port: boundPort, host, token, extensionId, registryPath: regPath, url: `http://${hostFmt}:${boundPort}`, wsUrl: `ws://${hostFmt}:${boundPort}`, store, locks, dispatchToTab, waitForEvent, close };
}
