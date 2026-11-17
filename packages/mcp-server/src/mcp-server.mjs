import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROLES, resolveRole } from '../../core/src/roles.mjs';
import { getRegistryPath, readBusRegistry } from '../../core/src/session-auth.mjs';
import { startSwarmBus } from '../../core/src/swarm-bus.mjs';
import { SWARM_TOOLS } from './tool-schemas.mjs';

const SERVER_INFO = { name: 'swarm-qa-browser', version: '0.1.0' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (src, keys) => Object.fromEntries(keys.filter((k) => src?.[k] !== undefined).map((k) => [k, src[k]]));
const tabOf = (st, id) => st.tabs.find((t) => t.tabId === (id ?? st.selectedTabId)) || null;
const dedupKey = (f) => `${f.ruleId || ''}::${f.selector || ''}::${f.description || ''}`;

function httpClient(url, token) {
  return {
    async rpc(action, params = {}) {
      const res = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-swarm-token': token }, body: JSON.stringify({ action, params }) });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw Object.assign(new Error(data?.error || `RPC ${action} failed`), { code: data?.code || 'RPC_ERROR', statusCode: res.status });
      return data.result;
    }
  };
}

async function resolveBus(registryPath, busClient) {
  if (typeof busClient?.rpc === 'function') return { client: busClient, ownedBus: null };
  if (busClient?.url && busClient?.token) return { client: httpClient(busClient.url, busClient.token), ownedBus: null };
  const regPath = registryPath || getRegistryPath(), reg = readBusRegistry(regPath);
  if (reg?.port && reg?.token) {
    const h = reg.host || '127.0.0.1', url = `http://${h.includes(':') ? `[${h}]` : h}:${reg.port}`;
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok && (await res.json())?.ok) return { client: httpClient(url, reg.token), ownedBus: null };
    } catch { /* dead/unreachable bus -> start embedded */ }
  }
  const bus = await startSwarmBus({ registryPath: regPath });
  return { client: httpClient(bus.url, bus.token), ownedBus: bus };
}

async function refreshPins(rpc, tabIds, status) {
  const st = status || await rpc('session.status', {}), byId = new Map(st.tabs.map((t) => [t.tabId, t]));
  for (const tid of new Set(tabIds)) {
    const tab = byId.get(tid);
    if (!tab) continue;
    const tickets = await rpc('tickets.list', { tabId: tid });
    await rpc('tab.command', { tabId: tid, command: { action: 'set_tickets', tickets, pathname: tab.pathname } });
  }
}

function moveCursorCmd(rpc, tabId, args, defaultRole, statusText) {
  const role = resolveRole(args?.role ?? (args?.agentId || defaultRole));
  return rpc('tab.command', { tabId, command: { action: 'move_cursor', id: args?.id ?? args?.agentId ?? role.id, label: args?.label ?? role.label, color: args?.color ?? role.color, ...pick(args, ['status', 'x', 'y', 'selector', 'box']), ...(statusText !== undefined ? { status: statusText } : {}) } });
}

async function withMutationLock(rpc, args, scope, defaultRole, statusText, command) {
  const st = await rpc('session.status', { tabId: args.tabId }), tabId = args.tabId ?? st.selectedTabId;
  if (tabId == null) throw new Error('No connected browser tab selected');
  const lock = Array.isArray(st.locks) ? st.locks.find((l) => l.tabId === tabId) : st.locks;
  if (lock?.locked && lock.agentId !== args.agentId) throw new Error(`Tab ${tabId} is locked by "${lock.agentId}"`);
  let autoAcquired = false;
  if (!lock?.locked && args.agentId) { await rpc('lock.acquire', { agentId: args.agentId, tabId, scope, ttlMs: 10000 }); autoAcquired = true; }
  try {
    await moveCursorCmd(rpc, tabId, args, defaultRole, statusText);
    return await rpc('tab.command', { tabId, agentId: args.agentId, command });
  } finally {
    if (autoAcquired) await rpc('lock.release', { agentId: args.agentId, tabId }).catch(() => {});
  }
}

async function runDomAuditTool(rpc, args) {
  const st = await rpc('session.status', {}), tab = tabOf(st, args.tabId);
  if (!tab) throw new Error(`Tab ${args.tabId ?? '(none)'} is not connected`);
  await moveCursorCmd(rpc, tab.tabId, args, 'layout', 'Auditando');
  const audit = await rpc('tab.command', { tabId: tab.tabId, command: { action: 'run_audit', ...pick(args, ['checks', 'viewport']) } });
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  const pathname = audit?.pathname ?? tab.pathname ?? '/', viewport = audit?.viewport ?? args.viewport ?? tab.viewport ?? null;
  const existing = await rpc('tickets.list', { tabId: tab.tabId, pathname, ...(viewport?.width ? { viewportWidth: viewport.width } : {}) });
  const seen = new Set(existing.filter((t) => t.status !== 'verified').map(dedupKey)), createdTickets = [];
  if (args.createTickets !== false) for (const f of findings) {
    if (seen.has(dedupKey(f))) continue;
    seen.add(dedupKey(f));
    createdTickets.push(await rpc('tickets.create', { ...pick(f, ['ruleId', 'severity', 'category', 'selector', 'rect', 'description', 'expected', 'actual']), tabId: tab.tabId, url: tab.url || '', pathname, viewport, reportedBy: args.agentId || f.category || 'qa-auditor' }));
  }
  await refreshPins(rpc, [tab.tabId], st);
  return { tabId: tab.tabId, pathname, viewport, createdTickets, findingsCount: findings.length, untrustedPageData: true };
}

async function markFixedTool(rpc, args) {
  const tickets = await rpc('tickets.markFixed', { ticketIds: args.ticketIds ?? args.ids ?? args.id, devAgentId: args.devAgentId ?? args.agentId, summary: args.summary });
  const waitMs = args.waitForHmrMs === undefined ? 800 : Math.max(0, Number(args.waitForHmrMs) || 0);
  if (waitMs > 0) await sleep(waitMs);
  const st = await rpc('session.status', {}), byId = new Map(st.tabs.map((t) => [t.tabId, t]));
  const tabIds = [...new Set(tickets.map((t) => t.tabId).filter((id) => byId.has(id)))];
  for (const tid of tabIds) await moveCursorCmd(rpc, tid, { agentId: args.verifierAgentId || 'layout', role: 'layout' }, 'layout', 'Re-verificando');
  const verifications = [];
  if (args.autoVerify !== false) {
    const groups = new Map();
    for (const t of tickets) if (t.ruleId && t.ruleId !== 'manual' && byId.has(t.tabId)) {
      const k = `${t.tabId}::${t.viewport?.width || 0}x${t.viewport?.height || 0}`;
      (groups.get(k) || groups.set(k, []).get(k)).push(t);
    }
    for (const group of groups.values()) {
      const tab = byId.get(group[0].tabId), vp = group[0].viewport;
      if (vp?.width > 0 && (tab.viewport?.width !== vp.width || tab.viewport?.height !== vp.height)) {
        await withMutationLock(rpc, { tabId: tab.tabId, agentId: args.verifierAgentId || 'responsive', role: 'responsive' }, 'viewport', 'responsive', 'Re-verificando', { action: 'set_viewport', width: vp.width, height: vp.height, mobile: vp.width <= 480 });
      }
      const audit = await rpc('tab.command', { tabId: tab.tabId, command: { action: 'run_audit', ...(vp ? { viewport: vp } : {}) } });
      const findings = Array.isArray(audit?.findings) ? audit.findings : [];
      for (const t of group) {
        if (audit?.pathname && t.pathname && audit.pathname !== t.pathname) continue;
        const hit = findings.find((f) => f.ruleId === t.ruleId && (!t.selector || f.selector === t.selector) && (t.selector !== 'document' || !t.description || f.description === t.description));
        const passed = !hit, evidence = hit ? (hit.actual || hit.description || 'Finding persisted on re-audit') : `Re-audit passed (0 matching ${t.ruleId} on ${t.selector || t.pathname})`;
        const verified = await rpc('tickets.verify', { id: t.id, agentId: args.verifierAgentId || 'layout', passed, evidence });
        tickets[tickets.indexOf(t)] = verified;
        verifications.push({ ticketId: t.id, passed, status: verified.status, round: verified.round, evidence });
      }
    }
  }
  await refreshPins(rpc, tabIds, st);
  return { tickets, verifications, untrustedPageData: true };
}

function buildHandlers(ensureBus) {
  const call = async (action, params) => (await ensureBus()).rpc(action, params);
  const mut = (scope, role, statusFn, cmdFn) => (a) => withMutationLock(call, a, scope, role, statusFn(a), cmdFn(a));
  return {
    swarm_session_status: (a) => call('session.status', { tabId: a.tabId }),
    swarm_select_tab: (a) => call('tabs.select', { tabId: a.tabId }),
    swarm_spawn_cursors: async (a) => {
      const st = await call('session.status', {}), tab = tabOf(st, a.tabId), src = a.cursors?.length ? a.cursors : (a.roles?.length ? a.roles : Object.values(DEFAULT_ROLES));
      const cursors = src.map((c, i) => { const r = resolveRole(c); return { id: c?.id ?? r.id, label: c?.label ?? r.label, color: c?.color ?? r.color, x: c?.x ?? 40 + i * 32, y: c?.y ?? 40, status: c?.status ?? 'ready', ...pick(c, ['selector', 'box']) }; });
      return { tabId: tab?.tabId ?? a.tabId, spawned: cursors, result: await call('tab.command', { tabId: tab?.tabId ?? a.tabId, command: { action: 'spawn_cursors', clear: Boolean(a.clear), cursors } }) };
    },
    swarm_move_cursor: (a) => moveCursorCmd(call, a.tabId, a, 'layout'),
    swarm_acquire_lock: (a) => call('lock.acquire', pick(a, ['agentId', 'tabId', 'scope', 'ttlMs'])),
    swarm_release_lock: (a) => call('lock.release', pick(a, ['agentId', 'tabId'])),
    swarm_set_viewport: mut('viewport', 'responsive', (a) => `Viewport ${a.width}x${a.height}`, (a) => ({ action: 'set_viewport', width: a.width, height: a.height, mobile: a.mobile ?? a.width <= 480, ...pick(a, ['deviceScaleFactor']) })),
    swarm_click: mut('interaction', 'interactive', () => 'Click', (a) => ({ action: 'click', ...pick(a, ['selector', 'x', 'y', 'button', 'clickCount']) })),
    swarm_fill: mut('interaction', 'interactive', () => 'Fill', (a) => ({ action: 'fill', ...pick(a, ['selector', 'value', 'clear']) })),
    swarm_press_key: mut('interaction', 'interactive', (a) => `Key ${a.key}`, (a) => ({ action: 'press_key', ...pick(a, ['key', 'selector', 'modifiers']) })),
    swarm_navigate: mut('interaction', 'interactive', () => 'Navigate', (a) => ({ action: 'navigate', url: a.url })),
    swarm_run_dom_audit: (a) => runDomAuditTool(call, a),
    swarm_report_finding: async (a) => {
      const st = await call('session.status', {}), tab = tabOf(st, a.tabId), tabId = a.tabId ?? tab?.tabId ?? null, pathname = a.pathname ?? (a.url ? undefined : tab?.pathname ?? '/');
      const ticket = await call('tickets.create', { ...a, tabId, url: a.url ?? tab?.url ?? '', ...(pathname !== undefined ? { pathname } : {}), viewport: a.viewport ?? tab?.viewport ?? null, ruleId: a.ruleId || 'manual', reportedBy: a.reportedBy ?? a.agentId ?? 'qa-agent' });
      if (tab) await refreshPins(call, [tab.tabId], st);
      return ticket;
    },
    swarm_list_findings: async (a) => { const tickets = await call('tickets.list', pick(a, ['status', 'tabId', 'pathname', 'viewportWidth'])); return { tickets, count: tickets.length, untrustedPageData: true }; },
    swarm_claim_findings: async (a) => { const tickets = await call('tickets.claim', { ticketIds: a.ticketIds ?? a.ids ?? a.id, devAgentId: a.devAgentId ?? a.agentId }); await refreshPins(call, tickets.map((t) => t.tabId)); return { tickets }; },
    swarm_mark_fixed: (a) => markFixedTool(call, a),
    swarm_verify_finding: async (a) => { const ticket = await call('tickets.verify', { id: a.id ?? a.ticketId, agentId: a.agentId ?? 'qa-agent', passed: a.passed, evidence: a.evidence }); await refreshPins(call, [ticket.tabId]); return ticket; },
    swarm_await_event: (a) => call('events.await', { sinceSeq: a.sinceSeq ?? 0, timeoutMs: a.timeoutMs ?? 15000 })
  };
}

/**
 * Creates a stdio JSON-RPC 2.0 MCP server wired to the local Swarm QA bus.
 */
export function createMcpServer({ registryPath, busClient, stdin = process.stdin, stdout = process.stdout } = {}) {
  let busState = null, busPromise = null, buf = Buffer.alloc(0);
  const inflight = new Set(), ensureBus = () => (busPromise ??= resolveBus(registryPath, busClient).then((s) => (busState = s).client)), handlers = buildHandlers(ensureBus);
  const send = (msg, framed) => { const j = JSON.stringify(msg); stdout.write(framed ? `Content-Length: ${Buffer.byteLength(j, 'utf8')}\r\n\r\n${j}` : `${j}\n`); };
  async function handleMessage(msg, framed = false) {
    if (!msg || typeof msg !== 'object' || msg.id === undefined) return;
    const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result }, framed);
    if (msg.method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    if (msg.method === 'ping') return reply({});
    if (msg.method === 'tools/list') return reply({ tools: SWARM_TOOLS });
    if (msg.method !== 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }, framed);
    const fn = handlers[msg.params?.name];
    if (!fn) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${msg.params?.name}` } }, framed);
    try { return reply({ content: [{ type: 'text', text: JSON.stringify(await fn(msg.params?.arguments || {})) }] }); }
    catch (err) { return reply({ isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err?.message ?? String(err), code: err?.code ?? 'TOOL_ERROR' }) }] }); }
  }
  const dispatch = (raw, framed) => {
    try { const p = handleMessage(JSON.parse(raw), framed); inflight.add(p); p.finally(() => inflight.delete(p)); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, framed); }
  };
  const onData = (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buf.length > 0) {
      while (buf.length && (buf[0] === 0x0a || buf[0] === 0x0d)) buf = buf.subarray(1);
      if (!buf.length) break;
      if (/^content-length:/i.test(buf.subarray(0, 16).toString('utf8'))) {
        const cr = buf.indexOf('\r\n\r\n'), lf = buf.indexOf('\n\n'), idx = cr !== -1 ? cr : lf, sep = cr !== -1 ? 4 : 2;
        if (idx === -1) break;
        const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, idx).toString('utf8'))?.[1] || 0);
        if (buf.length < idx + sep + len) break;
        dispatch(buf.subarray(idx + sep, idx + sep + len).toString('utf8'), true); buf = buf.subarray(idx + sep + len);
      } else {
        const nl = buf.indexOf(0x0a); if (nl === -1) break;
        const line = buf.subarray(0, nl).toString('utf8').trim(); buf = buf.subarray(nl + 1);
        if (line) dispatch(line, false);
      }
    }
  };
  stdin.on('data', onData);
  const close = async () => { stdin.off('data', onData); await Promise.allSettled([...inflight]); if (busPromise) await busPromise.catch(() => {}); if (busState?.ownedBus) await busState.ownedBus.close(); };
  return { start: () => ensureBus(), close, ensureBus, handleMessage };
}

const entry = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : '';
if (entry === fileURLToPath(import.meta.url).toLowerCase()) {
  const srv = createMcpServer();
  void srv.start().catch((err) => { process.stderr.write(`${err?.message ?? err}\n`); process.exit(1); });
  const shutdown = async () => { await srv.close(); process.exit(0); };
  process.stdin.once('end', shutdown);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.once(sig, shutdown);
}
