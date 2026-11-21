import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  corsHeaders,
  createFailureLimiter,
  httpError,
  listenLoopback,
  parseRequestUrl,
  readJsonBody,
  safeEqual,
  sendJson
} from './http-utils.mjs';
import { LockManager } from './lock-manager.mjs';
import { DEFAULT_ROLES } from './roles.mjs';
import {
  DEFAULT_EXTENSION_ID,
  DEFAULT_PORT,
  acquireRegistryLock,
  clearBusRegistryIfOwned,
  createToken,
  getPairingPath,
  getRegistryPath,
  isAllowedOrigin,
  isLoopbackHost,
  loadOrCreatePairingCode,
  normalizePairingCode
} from './session-auth.mjs';
import { TicketStore, sanitizeData, sanitizePageText } from './ticket-store.mjs';

/** Tab commands that change the page or its viewport and therefore require the tab lock. */
export const MUTATING_ACTIONS = new Set([
  'set_viewport',
  'click',
  'hover',
  'scroll',
  'fill',
  'press_key',
  'navigate',
  'apply_patch',
  'revert_patch'
]);
const MAX_EVENTS = 250;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const WS_OPEN = 1;

const pickTicketIds = (params) => params.ticketIds ?? params.ids ?? params.id ?? params.ticketId;

function normalizeTab(source, previous) {
  const url = sanitizePageText(source.url ?? previous?.url ?? '');
  let pathname = source.pathname != null && source.pathname !== '' ? sanitizePageText(source.pathname) : '';
  if (!pathname) {
    try {
      pathname = url ? sanitizePageText(new URL(url).pathname) : '/';
    } catch {
      pathname = '/';
    }
  }
  const viewport =
    source.viewport && typeof source.viewport === 'object'
      ? { width: Number(source.viewport.width) || 0, height: Number(source.viewport.height) || 0 }
      : (previous?.viewport ?? null);
  return { url, pathname, viewport, title: source.title != null ? sanitizePageText(source.title) : (previous?.title ?? '') };
}

function summarizeTickets(tickets) {
  const summary = { total: 0, open: 0, claimed: 0, awaiting_reverify: 0, verified: 0, reopened: 0, escalated: 0 };
  for (const ticket of tickets) {
    summary.total += 1;
    if (Object.hasOwn(summary, ticket.status)) summary[ticket.status] += 1;
  }
  return summary;
}

/**
 * Starts the local Swarm QA bus: a loopback-only HTTP + WebSocket hub that connects agent clients
 * (MCP server, CLI scripts) with browser tabs (extension, CDP bridge).
 *
 * Security model:
 *  - binds to loopback only and rejects foreign `Origin` headers (403);
 *  - every RPC / WebSocket / event-stream request needs the random per-session token (401);
 *  - the extension obtains that token through `POST /pair`, which additionally requires the
 *    persistent pairing code known only to this machine's user (rate limited).
 */
export async function startSwarmBus({
  port,
  host = '127.0.0.1',
  registryPath,
  pairingPath,
  extensionId = DEFAULT_EXTENSION_ID,
  autoFallbackPort = true
} = {}) {
  if (typeof host !== 'string' || !isLoopbackHost(host)) throw new Error(`Refusing non-loopback host "${host}"`);
  const bindHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const requestedPort = Number(port === undefined ? (process.env.SWARM_BUS_PORT ?? DEFAULT_PORT) : port);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error(`Invalid bus port "${port}"`);

  const regPath = registryPath || getRegistryPath();
  const token = createToken();
  const pairingCode = loadOrCreatePairingCode(pairingPath || getPairingPath(regPath));
  const pairLimiter = createFailureLimiter();
  const extensionOrigin =
    typeof extensionId === 'string' && extensionId && !extensionId.includes('/') ? `chrome-extension://${extensionId}` : null;

  const store = new TicketStore();
  const locks = new LockManager();
  const tabs = new Map();
  const events = [];
  const waiters = new Set();
  const pending = new Map();
  const eventStreams = new Set();
  let seq = 0;
  let selectedTabId = null;
  let boundPort = requestedPort;
  let closing = null;

  const publicTab = ({ ws: _ws, ...rest }) => ({ ...rest });
  const eventsSince = (since) => events.filter((event) => event.seq > since);

  // --- Events ----------------------------------------------------------------------------------

  function pushEvent(type, data = {}) {
    const event = { ...data, seq: ++seq, type, ts: new Date().toISOString() };
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

    for (const waiter of [...waiters]) {
      if (seq <= waiter.sinceSeq) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve({ seq, events: eventsSince(waiter.sinceSeq), timedOut: false });
    }
    const frame = JSON.stringify({ type: 'event', event });
    for (const client of wss.clients) if (client.readyState === WS_OPEN) client.send(frame);
    for (const stream of eventStreams) stream.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    return event;
  }

  function waitForEvent(sinceSeq = 0, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    const since = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0;
    const waitMs = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : DEFAULT_COMMAND_TIMEOUT_MS;
    if (seq > since) return Promise.resolve({ seq, events: eventsSince(since), timedOut: false });
    if (waitMs === 0) return Promise.resolve({ seq, events: [], timedOut: true });
    return new Promise((resolve) => {
      const waiter = { sinceSeq: since, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve({ seq, events: [], timedOut: true });
      }, waitMs);
      waiters.add(waiter);
    });
  }

  // --- Tab commands ----------------------------------------------------------------------------

  function rejectPending(predicate, describe) {
    for (const [id, entry] of [...pending.entries()]) {
      if (!predicate(entry)) continue;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(describe(entry)));
    }
  }

  function dispatchToTab(tabId, command, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    const tab = tabs.get(tabId);
    if (!tab || tab.ws.readyState !== WS_OPEN) return Promise.reject(httpError(`Tab ${tabId} is not connected`, 404, 'TAB_NOT_CONNECTED'));
    const commandId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(commandId);
          reject(httpError(`Tab ${tabId} command timed out`, 504, 'TIMEOUT'));
        },
        Math.max(1, Number(timeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS)
      );
      pending.set(commandId, { tabId, ws: tab.ws, resolve, reject, timer });
      tab.ws.send(JSON.stringify({ type: 'command', commandId, tabId, command }));
    });
  }

  function removeTab(tabId) {
    if (!tabs.delete(tabId)) return;
    rejectPending(
      (entry) => entry.tabId === tabId,
      (entry) => `Tab ${entry.tabId} disconnected`
    );
    if (selectedTabId === tabId) selectedTabId = tabs.keys().next().value ?? null;
    pushEvent('tab_closed', { tabId });
  }

  /** Stores new findings as tickets and announces each one. */
  function ingestFindings({ tabId, findings, pathname, viewport, url, reportedBy }) {
    const tab = tabs.get(tabId);
    const created = store.ingest({
      findings,
      tabId: tabId ?? null,
      url: url ?? tab?.url ?? '',
      pathname: pathname ?? tab?.pathname ?? '/',
      viewport: viewport ?? tab?.viewport ?? null,
      reportedBy
    });
    for (const ticket of created) pushEvent('ticket_created', { ticket });
    return created;
  }

  /** Pushes the authoritative ticket list for a tab back to its overlay (best effort). */
  function refreshTabPins(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const summary = summarizeTickets(store.list());
    dispatchToTab(tabId, {
      action: 'set_tickets',
      tickets: store.list({ tabId }),
      pathname: tab.pathname,
      ...(tab.viewport?.width ? { viewportWidth: tab.viewport.width } : {}),
      summary: { open: summary.open + summary.reopened, awaiting_reverify: summary.awaiting_reverify, verified: summary.verified }
    }).catch(() => {});
  }

  // --- RPC -------------------------------------------------------------------------------------

  function assertCanMutate(agentId, tabId) {
    if (Object.hasOwn(DEFAULT_ROLES, agentId) && DEFAULT_ROLES[agentId].readOnly) {
      throw httpError(`Role "${agentId}" is read-only and cannot mutate the page`, 403, 'ROLE_READ_ONLY');
    }
    try {
      locks.assertCanMutate({ agentId, tabId });
    } catch (err) {
      const missingTab = tabId == null || tabId === '';
      throw httpError(err.message, missingTab ? 400 : 409, missingTab ? 'RPC_ERROR' : 'LOCK_HELD');
    }
  }

  const rpc = {
    'session.status': (p) => ({
      ok: true,
      port: boundPort,
      host: bindHost,
      extensionId,
      pairingCode,
      seq,
      selectedTabId,
      tabs: Array.from(tabs.values(), publicTab),
      locks: locks.status(p.tabId),
      roles: DEFAULT_ROLES,
      ticketsSummary: summarizeTickets(store.list())
    }),
    'tabs.select': (p) => {
      if (!tabs.has(p.tabId)) throw httpError(`Tab ${p.tabId} is not connected`, 404, 'TAB_NOT_CONNECTED');
      selectedTabId = p.tabId;
      pushEvent('tab_selected', { tabId: selectedTabId });
      return { selectedTabId, tab: publicTab(tabs.get(selectedTabId)) };
    },
    'tickets.list': (p) => store.list(p),
    'tickets.create': (p) => {
      const ticket = store.create(p);
      pushEvent('ticket_created', { ticket });
      return ticket;
    },
    'tickets.ingest': (p) => {
      const tabId = p.tabId ?? selectedTabId;
      const created = ingestFindings({ ...p, tabId });
      return { created, findingsCount: Array.isArray(p.findings) ? p.findings.length : 0 };
    },
    'tickets.claim': (p) => {
      const list = store.claim(pickTicketIds(p), p.devAgentId ?? p.agentId);
      pushEvent('tickets_claimed', { ids: list.map((t) => t.id), claimedBy: list[0]?.claimedBy });
      return list;
    },
    'tickets.markFixed': (p) => {
      const list = store.markFixed(pickTicketIds(p), { devAgentId: p.devAgentId ?? p.agentId, summary: p.summary });
      pushEvent('tickets_marked_fixed', { ids: list.map((t) => t.id) });
      return list;
    },
    'tickets.verify': (p) => {
      const ticket = store.verify(p.id ?? p.ticketId, { agentId: p.agentId, passed: p.passed, evidence: p.evidence });
      pushEvent('ticket_verified', { id: ticket.id, status: ticket.status, round: ticket.round });
      return ticket;
    },
    'lock.acquire': (p) => {
      const lock = locks.acquire({ ...p, tabId: p.tabId ?? selectedTabId });
      pushEvent('lock_acquired', lock);
      return lock;
    },
    'lock.release': (p) => {
      const released = locks.release({ ...p, tabId: p.tabId ?? selectedTabId });
      pushEvent('lock_released', released);
      return released;
    },
    'tab.command': (p) => {
      const tabId = p.tabId ?? selectedTabId;
      const command = p.command ?? p;
      const action = command?.action ?? command?.type;
      if (p.requireLock || MUTATING_ACTIONS.has(action)) assertCanMutate(p.agentId, tabId);
      return dispatchToTab(tabId, command, p.timeoutMs);
    },
    'events.await': (p) => waitForEvent(p.sinceSeq ?? 0, p.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
  };

  // --- HTTP ------------------------------------------------------------------------------------

  function handlePair(req, res, origin) {
    if (pairLimiter.blocked())
      return sendJson(res, 429, { ok: false, error: 'Too many pairing attempts; wait a minute', code: 'PAIR_RATE_LIMITED' }, origin, true);
    if (!safeEqual(normalizePairingCode(req.headers['x-swarm-pair-code']), pairingCode)) {
      pairLimiter.fail();
      return sendJson(res, 401, { ok: false, error: 'Invalid pairing code', code: 'PAIR_CODE_INVALID' }, origin, true);
    }
    pairLimiter.reset();
    return sendJson(res, 200, { port: boundPort, token, extensionId }, origin, true);
  }

  function handleEventStream(req, res, url, origin) {
    const since = Number(url.searchParams.get('since') ?? req.headers['last-event-id'] ?? seq) || 0;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      ...corsHeaders(origin)
    });
    res.write(`retry: 2000\n\n`);
    for (const event of eventsSince(since)) res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    eventStreams.add(res);
    req.on('close', () => eventStreams.delete(res));
  }

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = parseRequestUrl(req.url);
    if (!url) return sendJson(res, 400, { ok: false, error: 'Malformed request URL', code: 'INVALID_URL' }, origin, false);
    const path = url.pathname;
    const forbidden = !isAllowedOrigin(origin, extensionId) || (path === '/pair' && (!extensionOrigin || origin !== extensionOrigin));
    if (forbidden) return sendJson(res, 403, { ok: false, error: 'Forbidden origin' }, origin, false);
    if (req.method === 'OPTIONS') return sendJson(res, 204, {}, origin, true);
    if (req.method === 'GET' && path === '/health')
      return sendJson(res, 200, { ok: true, port: boundPort, extensionId, tabsCount: tabs.size, seq }, origin, true);
    if (req.method === 'POST' && path === '/pair') return handlePair(req, res, origin);

    const isEvents = req.method === 'GET' && path === '/events';
    if (!isEvents && (req.method !== 'POST' || path !== '/rpc')) return sendJson(res, 404, { ok: false, error: 'Not found' }, origin, true);
    const candidate = req.headers['x-swarm-token'] || (isEvents ? url.searchParams.get('token') : '');
    if (!safeEqual(candidate, token)) return sendJson(res, 401, { ok: false, error: 'Unauthorized' }, origin, true);
    if (isEvents) return handleEventStream(req, res, url, origin);

    try {
      const body = await readJsonBody(req);
      const action = body?.action ?? body?.method;
      if (!Object.hasOwn(rpc, action)) throw httpError(`Unknown RPC action "${action}"`, 400, 'UNKNOWN_ACTION');
      const params = body?.params && typeof body.params === 'object' ? body.params : (body ?? {});
      sendJson(res, 200, { ok: true, result: await rpc[action](params) }, origin, true);
    } catch (err) {
      const status = err?.statusCode ?? (err?.code === 'LOCK_HELD' ? 409 : 400);
      sendJson(res, status, { ok: false, error: err?.message ?? 'RPC error', code: err?.code ?? 'RPC_ERROR' }, origin, true);
    }
  });

  // --- WebSocket (tabs) ------------------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const deny = (status, reason, message) =>
      socket.end(
        `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ error: message })}`
      );
    const url = parseRequestUrl(req.url);
    if (!url) return deny(400, 'Bad Request', 'Malformed request URL');
    if (url.pathname !== '/') return deny(404, 'Not Found', 'Invalid WebSocket path');
    if (!isAllowedOrigin(req.headers.origin, extensionId)) return deny(403, 'Forbidden', 'Forbidden origin');
    const headerToken = typeof req.headers['x-swarm-token'] === 'string' ? req.headers['x-swarm-token'] : '';
    if (!safeEqual(headerToken || url.searchParams.get('token') || '', token)) return deny(401, 'Unauthorized', 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function handleCommandResult(msg) {
    const commandId = msg.commandId ?? msg.id ?? msg.requestId;
    const entry = pending.get(commandId);
    if (!entry) return;
    pending.delete(commandId);
    clearTimeout(entry.timer);
    if (msg.ok === false || msg.error) {
      entry.reject(new Error(typeof msg.error === 'string' ? msg.error : msg.error?.message || 'Tab command failed'));
    } else {
      entry.resolve(msg.result !== undefined ? msg.result : msg);
    }
  }

  function handleFindingEvent(msg, fallbackTabId) {
    const tabId = msg.tabId ?? fallbackTabId;
    const payload = msg.payload;
    if (payload?.type === 'audit_report' && tabs.has(tabId)) {
      // The overlay audited on its own (HUD button): turn the report into tickets and pins.
      const created = ingestFindings({ tabId, findings: payload.findings, pathname: payload.pathname, viewport: payload.viewport });
      pushEvent('audit_report', {
        tabId,
        findingsCount: Array.isArray(payload.findings) ? payload.findings.length : 0,
        created: created.map((t) => t.id),
        untrustedPageData: true
      });
      refreshTabPins(tabId);
      return;
    }
    const { type: _type, ...rest } = msg;
    pushEvent('finding_event', { ...sanitizeData(rest), tabId, untrustedPageData: true });
  }

  wss.on('connection', (ws) => {
    let primaryTabId = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'command_result') return handleCommandResult(msg);
      if (msg.type === 'finding_event') return handleFindingEvent(msg, primaryTabId);
      if (msg.type === 'tab_closed') {
        if (tabs.get(msg.tabId)?.ws === ws) removeTab(msg.tabId);
        return;
      }
      if (msg.type !== 'hello' && msg.type !== 'route_changed' && msg.type !== 'route_change') return;

      const source = msg.tab && typeof msg.tab === 'object' ? msg.tab : msg;
      const isHello = msg.type === 'hello';
      const tabId = isHello ? source.tabId : (source.tabId ?? primaryTabId);
      if (tabId == null || tabId === '') return;
      const previous = tabs.get(tabId);
      const meta = normalizeTab(source, previous);
      const now = new Date().toISOString();
      if (isHello || previous)
        tabs.set(tabId, { tabId, ...meta, untrustedPageData: true, connectedAt: previous?.connectedAt ?? now, updatedAt: now, ws });
      if (isHello) {
        primaryTabId = tabId;
        if (selectedTabId === null || !tabs.has(selectedTabId) || msg.selected === true) selectedTabId = tabId;
      }
      pushEvent(isHello ? 'tab_hello' : 'route_changed', { tabId, ...meta, untrustedPageData: true });
      if (isHello) ws.send(JSON.stringify({ type: 'hello_ack', tabId, selectedTabId, seq }));
    });

    ws.on('close', () => {
      rejectPending(
        (entry) => entry.ws === ws,
        (entry) => `Tab ${entry.tabId} disconnected`
      );
      for (const [tabId, tab] of [...tabs.entries()]) if (tab.ws === ws) removeTab(tabId);
    });
  });

  // --- Lifecycle -------------------------------------------------------------------------------

  boundPort = await listenLoopback(server, requestedPort, bindHost, autoFallbackPort);
  const hostForUrl = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  try {
    acquireRegistryLock(
      { pid: process.pid, port: boundPort, host: bindHost, token, extensionId, startedAt: new Date().toISOString() },
      regPath
    );
  } catch (err) {
    wss.close();
    server.close();
    server.closeAllConnections?.();
    throw err;
  }

  const close = () =>
    (closing ??= (async () => {
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        waiter.resolve({ seq, events: [], timedOut: true, closed: true });
      }
      waiters.clear();
      rejectPending(
        () => true,
        () => 'Swarm bus closed'
      );
      for (const stream of eventStreams) stream.end();
      eventStreams.clear();
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      clearBusRegistryIfOwned(process.pid, regPath);
    })());

  return {
    port: boundPort,
    host: bindHost,
    token,
    pairingCode,
    extensionId,
    registryPath: regPath,
    url: `http://${hostForUrl}:${boundPort}`,
    wsUrl: `ws://${hostForUrl}:${boundPort}`,
    store,
    locks,
    dispatchToTab,
    waitForEvent,
    close
  };
}
