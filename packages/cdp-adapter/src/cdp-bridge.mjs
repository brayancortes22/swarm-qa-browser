import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { readBusRegistry } from '../../core/src/session-auth.mjs';
import { sanitizePageText } from '../../core/src/ticket-store.mjs';
import { createInputHandlers } from './cdp-input.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']), IGNORED_URL_RE = /^(?:devtools|chrome-extension):\/\//i;
const OVERLAY_BUNDLE = readFileSync(new URL('../overlay.bundle.js', import.meta.url), 'utf8');
const CLI_FLAGS = { '--port': ['cdpPort', Number], '--cdp-port': ['cdpPort', Number], '--cdp-url': ['cdpUrl'], '--url': ['urlIncludes'], '--target': ['targetId'], '--target-id': ['targetId'], '--type': ['type'], '--registry': ['registryPath'], '--bus-url': ['busUrl'], '--token': ['token'], '--tab-id': ['tabId'] };
const assertLoopback = (raw) => { const u = new URL(String(raw)); if (!LOOPBACK.has(u.hostname.toLowerCase())) throw new Error(`Refusing non-loopback URL: ${u.origin || raw}`); return u.href; };
const closeWs = (ws) => (!ws || ws.readyState === 3 ? Promise.resolve() : new Promise((r) => { ws.once('close', r); ws.readyState === 0 ? ws.terminate() : ws.readyState === 1 && ws.close(); }));
const sendBus = (ws, payload) => { if (ws?.readyState === 1) ws.send(JSON.stringify(payload)); };
const httpGetJson = (url) => new Promise((res, rej) => httpGet(url, { agent: false }, (r) => {
  const chunks = []; r.on('data', (c) => chunks.push(c));
  r.on('end', () => { if ((r.statusCode ?? 500) >= 400) return rej(new Error(`CDP HTTP ${r.statusCode}`)); try { res(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { rej(new Error(`Invalid CDP JSON: ${e?.message || e}`)); } });
}).setTimeout(5000, function () { this.destroy(new Error('CDP HTTP timeout')); }).on('error', rej));

/** Selects a CDP target (preferring page or webview matching urlIncludes), ignoring devtools:// and chrome-extension://. */
export function selectCdpTarget(targets, { targetId, urlIncludes, type } = {}) {
  const pool = (Array.isArray(targets) ? targets : []).filter((t) => t && typeof t === 'object' && !IGNORED_URL_RE.test(String(t.url || '')));
  if (targetId) return pool.find((t) => t.id === targetId) ?? null;
  let list = pool.filter((t) => (type ? t.type === type : t.type === 'page' || t.type === 'webview'));
  if (urlIncludes) list = list.filter((t) => String(t.url || '').includes(urlIncludes));
  const rank = (t) => (t.webSocketDebuggerUrl ? 4 : 0) + (t.type === 'page' ? 2 : t.type === 'webview' ? 1 : 0) + (t.url && t.url !== 'about:blank' ? 1 : 0);
  return list.length ? [...list].sort((a, b) => rank(b) - rank(a))[0] : null;
}

function openCdpClient(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl), pending = new Map(), events = new Set(), onClose = new Set();
    let nextId = 1, settled = false;
    const rejectAll = (msg) => { for (const [id, p] of pending) { pending.delete(id); p.reject(new Error(msg)); } };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (m.id == null) { if (m.method) for (const fn of events) fn(m.method, m.params || {}); return; }
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result ?? {});
    });
    ws.once('open', () => { settled = true; res({ send: (method, params = {}) => (ws.readyState !== 1 ? Promise.reject(new Error('CDP WebSocket closed')) : new Promise((a, b) => { const id = nextId++; pending.set(id, { resolve: a, reject: b }); ws.send(JSON.stringify({ id, method, params })); })), onEvent: (fn) => events.add(fn), onClose: (fn) => onClose.add(fn), close: () => { rejectAll('CDP bridge closed'); return closeWs(ws); } }); });
    ws.once('error', (err) => { if (!settled) { settled = true; rej(err); } });
    ws.on('close', () => { rejectAll('CDP WebSocket closed'); for (const fn of onClose) fn(); });
  });
}

const buildMountExpr = (nonce, bindingName, isolated) => `(() => {\nif (!globalThis.__swarmQaOverlayFactory) {\n${OVERLAY_BUNDLE}\n}\nconst f = globalThis.__swarmQaOverlayFactory, b = ${JSON.stringify(bindingName)}, emit = typeof globalThis[b] === 'function' ? globalThis[b] : null;\ntry { delete globalThis[b]; } catch {}\nconst send = (o) => { if (emit) try { emit(JSON.stringify(o)); } catch {} };\nconst ctrl = f.mountSwarmOverlay({ nonce: ${JSON.stringify(nonce)}, onEvent: (ev) => ev?.type === 'route_change' ? send({ kind: 'route_changed', url: location.href, pathname: ev.pathname || location.pathname || '/', title: f.sanitizeText ? f.sanitizeText(document.title) : document.title, viewport: { width: innerWidth || 1440, height: innerHeight || 900 } }) : (ev && send({ kind: 'finding_event', eventType: 'overlay_event', payload: ev })), onAction: (action) => send({ kind: 'finding_event', eventType: 'overlay_action', payload: action }) });\n${isolated ? '' : 'delete globalThis.__swarmQaOverlayFactory;'}\nreturn ctrl;\n})()`;

/** Connects a Chromium CDP target (page/webview) to the local swarm QA bus with isolated overlay injection. */
export async function connectCdpBridge({ cdpUrl, cdpPort = 9222, targetId, urlIncludes, type, registryPath, busUrl, token, tabId: customTabId } = {}) {
  const reg = !busUrl || !token ? readBusRegistry(registryPath) : null, authToken = token || reg?.token;
  const resolvedBus = busUrl || (reg?.port ? `http://${reg.host === '::1' ? '[::1]' : (reg.host || '127.0.0.1')}:${reg.port}` : '');
  if (!resolvedBus || !authToken) throw new Error('Swarm bus registry or token unavailable');
  const busWsUrl = assertLoopback(resolvedBus.replace(/^http/i, 'ws')), port = Number(cdpPort);
  if (!cdpUrl && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`Invalid CDP port: ${cdpPort}`);
  const target = cdpUrl && /^wss?:/i.test(cdpUrl) ? { id: targetId || 'cdp-direct', type: type || 'page', url: '', webSocketDebuggerUrl: cdpUrl }
    : selectCdpTarget(await httpGetJson(`${cdpUrl ? assertLoopback(cdpUrl).replace(/\/json(?:\/list)?\/?$/, '') : `http://127.0.0.1:${port}`}/json/list`), { targetId, urlIncludes, type });
  if (!target?.webSocketDebuggerUrl) throw new Error('No matching CDP target with webSocketDebuggerUrl');
  const cdp = await openCdpClient(assertLoopback(target.webSocketDebuggerUrl)), tabId = customTabId || `cdp-${target.id || randomUUID().slice(0, 8)}`, nonce = randomUUID().slice(0, 12), bindingName = `__swarmQaEmit_${nonce}`;
  const state = { frameId: target.id || 'main', contextId: null, isolated: true, contextCleared: false, ctrlObjectId: null, viewport: { width: 1440, height: 900 }, viewportOverride: false, url: target.url || '', pathname: '/', title: target.title || '', consoleNet: [] };
  const pushNet = (e) => { state.consoleNet.push({ ...e, ts: Date.now(), untrustedPageData: true }); if (state.consoleNet.length > 100) state.consoleNet.shift(); };
  let mountQueue = Promise.resolve(), pendingMount = null, closing = null, busWs = null;
  const loadWaiters = new Set(), waitReady = () => mountQueue, sendToBus = (p) => sendBus(busWs, p);
  const callCtrl = async (objectId, functionDeclaration, ...args) => {
    const res = await cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: args.map((v) => (v === undefined ? {} : { value: v })), returnByValue: true, awaitPromise: true });
    if (res?.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'CDP callFunctionOn error');
    return res?.result?.value;
  };
  const releaseCtrl = async () => { const oid = state.ctrlObjectId; state.ctrlObjectId = null; if (oid) { await callCtrl(oid, 'function() { this?.destroy?.(); }').catch(() => {}); await cdp.send('Runtime.releaseObject', { objectId: oid }).catch(() => {}); } };
  const evalCtx = async (expression) => {
    await mountQueue; if (!state.ctrlObjectId || state.contextCleared || (state.isolated && state.contextId == null)) throw new Error('Swarm overlay context unavailable');
    const res = await cdp.send('Runtime.evaluate', { expression, ...(state.contextId != null ? { contextId: state.contextId } : {}), returnByValue: true, awaitPromise: true });
    if (res?.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'CDP eval error');
    return res?.result?.value;
  };
  const evalCtrl = async (fnDecl, ...args) => { await mountQueue; if (!state.ctrlObjectId || state.contextCleared) throw new Error('Swarm overlay not mounted'); return callCtrl(state.ctrlObjectId, fnDecl, ...args); };
  const waitLoad = (sameDoc) => {
    let settled = false, timer = null;
    const entry = { sameDoc, done: (fromLoadEvent, mount) => { if (!settled) { settled = true; clearTimeout(timer); loadWaiters.delete(entry); entry.resolve({ fromLoadEvent, mount }); } } };
    const promise = new Promise((r) => { entry.resolve = r; timer = setTimeout(() => entry.done(false, null), sameDoc ? 150 : 4500); timer.unref?.(); });
    loadWaiters.add(entry); return { promise, cancel: () => entry.done(false, null) };
  };
  const close = () => (closing ??= (async () => { pendingMount?.wake?.(); for (const w of [...loadWaiters]) w.cancel(); let rt; await Promise.race([releaseCtrl(), new Promise((r) => { rt = setTimeout(r, 300); rt.unref?.(); })]); clearTimeout(rt); await Promise.all([closeWs(busWs), cdp.close()]); })());
  cdp.onClose(() => close());

  const injectOverlay = (notifyBus = false, delayMs = 0) => {
    if (closing) return Promise.resolve();
    if (pendingMount) { pendingMount.notifyBus ||= notifyBus; if (delayMs === 0) pendingMount.wake(); return pendingMount.promise; }
    let timer = null, wakeFn = null;
    const entry = { notifyBus, delayMs, wake: () => { entry.delayMs = 0; if (timer) { clearTimeout(timer); timer = null; wakeFn?.(); } }, promise: null };
    const queued = mountQueue.then(async () => {
      if (entry.delayMs > 0 && !closing) await new Promise((r) => { wakeFn = r; timer = setTimeout(() => { timer = null; r(); }, entry.delayMs); timer.unref?.(); });
      if (pendingMount === entry) pendingMount = null;
      if (closing) return;
      await releaseCtrl();
      let isolated = true, ctxId = null;
      try { ctxId = (await cdp.send('Page.createIsolatedWorld', { frameId: state.frameId, worldName: 'swarm_qa_isolated' }))?.executionContextId ?? null; if (ctxId == null) isolated = false; } catch { isolated = false; ctxId = null; }
      state.isolated = isolated; state.contextId = ctxId; state.contextCleared = false;
      await cdp.send('Runtime.addBinding', isolated ? { name: bindingName, executionContextId: ctxId } : { name: bindingName }).catch(() => (isolated ? cdp.send('Runtime.addBinding', { name: bindingName }) : null)).catch(() => {});
      const res = await cdp.send('Runtime.evaluate', { expression: buildMountExpr(nonce, bindingName, isolated), ...(ctxId != null ? { contextId: ctxId } : {}), returnByValue: false, awaitPromise: true });
      if (res?.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'CDP mount error');
      if (!res?.result?.objectId) throw new Error('Failed to acquire overlay controller objectId');
      state.ctrlObjectId = res.result.objectId;
      const meta = await callCtrl(state.ctrlObjectId, 'function() { return { url: location.href, pathname: location.pathname || "/", title: document.title || "", viewport: { width: innerWidth || 1440, height: innerHeight || 900 } }; }');
      if (meta) { state.url = meta.url || state.url; state.pathname = meta.pathname || state.pathname; state.title = meta.title ?? state.title; if (!state.viewportOverride && meta.viewport) state.viewport = meta.viewport; }
      if (entry.notifyBus) sendToBus({ type: 'route_changed', tabId, url: state.url, pathname: state.pathname, title: state.title, viewport: state.viewport });
    });
    entry.promise = queued; pendingMount = entry; mountQueue = queued.catch(() => {}); return queued;
  };

  await Promise.all(['Page.enable', 'DOM.enable', 'Runtime.enable', 'Network.enable'].map((m) => cdp.send(m)));
  const tree = await cdp.send('Page.getFrameTree').catch(() => null);
  if (tree?.frameTree?.frame?.id) state.frameId = tree.frameTree.frame.id;
  cdp.onEvent((method, p) => {
    if (method === 'Runtime.exceptionThrown') pushNet({ kind: 'exception', uncaught: true, message: sanitizePageText(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'Uncaught error'), source: sanitizePageText(p.exceptionDetails?.url || ''), line: Number(p.exceptionDetails?.lineNumber) || 0, col: Number(p.exceptionDetails?.columnNumber) || 0 });
    else if (method === 'Runtime.consoleAPICalled' && p.type === 'error') pushNet({ kind: 'console.error', message: sanitizePageText((p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')) });
    else if (method === 'Network.responseReceived' && Number(p.response?.status) >= 400) pushNet({ kind: 'network', status: Number(p.response.status), url: sanitizePageText(p.response.url || ''), message: sanitizePageText(`${p.response.status} ${p.response.statusText || ''}`.trim()) });
    else if (method === 'Runtime.executionContextsCleared') { state.contextId = null; state.contextCleared = true; }
    else if (method === 'Page.frameNavigated' && !p.frame?.parentId) { state.frameId = p.frame?.id || state.frameId; state.contextId = null; state.contextCleared = true; state.consoleNet.length = 0; injectOverlay(true, 25).catch(() => {}); }
    else if (method === 'Page.loadEventFired') { const mount = injectOverlay(true, 0); mount.catch(() => {}); for (const w of [...loadWaiters]) w.done(true, mount); }
    else if (method === 'Page.navigatedWithinDocument') { if (p.url) state.url = sanitizePageText(p.url, 512); for (const w of [...loadWaiters]) if (w.sameDoc) w.done(false, null); }
    else if (method === 'Runtime.bindingCalled' && p.name === bindingName) {
      if (state.isolated && state.contextId != null && p.executionContextId != null && p.executionContextId !== state.contextId) return;
      let ev; try { ev = JSON.parse(String(p.payload || '')); } catch { return; }
      if (ev?.kind === 'route_changed') { state.url = sanitizePageText(ev.url || state.url, 512); state.pathname = sanitizePageText(ev.pathname || state.pathname || '/', 280); state.title = sanitizePageText(ev.title ?? state.title, 280); if (!state.viewportOverride && ev.viewport) state.viewport = ev.viewport; sendToBus({ type: 'route_changed', tabId, url: state.url, pathname: state.pathname, title: state.title, viewport: state.viewport }); }
      else if (ev?.kind === 'finding_event') sendToBus({ type: 'finding_event', tabId, eventType: ev.eventType, payload: ev.payload });
    }
  });

  const handlers = {
    spawn_cursors: async (a, c) => ({ ok: true, count: await evalCtrl('function(arg) { return this.spawnCursors(arg); }', a.cursors ? { cursors: a.cursors, clear: Boolean(a.clear) } : (Array.isArray(c) ? c : (a.id ? [a] : []))) }),
    move_cursor: async (a) => (await evalCtrl('function(arg) { return this.moveCursor(arg); }', a.cursor ?? a), { ok: true }),
    remove_cursor: async (a) => (await evalCtrl('function(id) { return this.removeCursor(id); }', a.id ?? a.cursorId ?? ''), { ok: true }),
    run_audit: async (a) => { await mountQueue; const entries = state.consoleNet.slice(); const res = await evalCtrl('function(o) { return this.runAudit(o); }', { checks: a.checks ?? null, viewport: a.viewport ?? state.viewport, consoleEntries: entries }); if (a.clearConsole) state.consoleNet.length = 0; return { ...res, untrustedPageData: true }; },
    set_tickets: async (a) => {
      const tickets = Array.isArray(a.tickets) ? a.tickets : [], counts = tickets.reduce((acc, t) => ((acc[t?.status] = (acc[t?.status] || 0) + 1), acc), {}), vw = a.viewportWidth ?? state.viewport?.width ?? null;
      const summary = { ...(a.summary && typeof a.summary === 'object' ? a.summary : { open: (counts.open || 0) + (counts.reopened || 0), awaiting_reverify: counts.awaiting_reverify || 0, verified: counts.verified || 0 }), viewportWidth: vw };
      return evalCtrl('function(t, p, s, vw) { this.setTickets(t, p, { viewportWidth: vw }); this.updateSummary(s); return { ok: true, count: t.length }; }', tickets, a.pathname ?? null, summary, vw);
    },
    update_summary: async (a) => (await evalCtrl('function(s) { this.updateSummary(s); }', a.summary ?? a), { ok: true }),
    apply_patch: async (a) => ({ ok: await evalCtrl('function(p) { return this.applyPatch?.(p) ?? false; }', a.patch ?? a) }),
    revert_patch: async (a) => ({ ok: await evalCtrl('function(id) { return this.revertPatch?.(id) ?? false; }', a.id ?? a) }),
    get_console_network: async (a) => { await mountQueue; const entries = state.consoleNet.slice(); if (a.clear) state.consoleNet.length = 0; return { entries, untrustedPageData: true }; },
    ...createInputHandlers({ cdp, state, tabId, evalCtx, waitReady, waitLoad, injectOverlay, sendBus: sendToBus })
  };

  try {
    await injectOverlay(false, 0);
    busWs = await new Promise((resolvePromise, reject) => {
      const ws = new WebSocket(busWsUrl, { headers: { 'x-swarm-token': authToken } });
      let acked = false; const fail = (err) => { if (!acked) { acked = true; reject(err); } };
      ws.once('open', () => sendBus(ws, { type: 'hello', tabId, url: state.url, pathname: state.pathname, title: state.title, viewport: state.viewport }));
      ws.on('message', async (raw) => {
        let msg; try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
        if (msg.type === 'hello_ack' && !acked) { acked = true; return resolvePromise(ws); }
        if (msg.type !== 'command') return;
        const cmd = msg.command, act = cmd?.action ?? cmd?.type, args = cmd?.params && typeof cmd.params === 'object' ? { ...cmd, ...cmd.params } : (cmd || {});
        const reply = (p) => sendBus(ws, { type: 'command_result', commandId: msg.commandId, ...p });
        try { if (!Object.hasOwn(handlers, act)) throw new Error(`Unsupported command: ${act}`); reply({ ok: true, result: await handlers[act](args, cmd) }); } catch (err) { reply({ ok: false, error: err?.message || 'Command failed' }); }
      });
      ws.once('error', fail); ws.once('close', () => fail(new Error('Swarm bus disconnected before hello_ack')));
    });
  } catch (err) { await close(); throw err; }
  busWs.on('close', () => close());
  return { close, tabId, target };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const opts = {};
  for (let i = 2; i < process.argv.length; i += 1) { const s = CLI_FLAGS[process.argv[i]]; if (s && process.argv[i + 1] !== undefined) opts[s[0]] = s[1] ? s[1](process.argv[++i]) : process.argv[++i]; }
  connectCdpBridge(opts).then((b) => { process.stdout.write(`${JSON.stringify({ ok: true, tabId: b.tabId, targetId: b.target?.id, url: b.target?.url, type: b.target?.type })}\n`); for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.once(sig, () => b.close().finally(() => process.exit(0))); })
    .catch((err) => { process.stderr.write(`${err?.message ?? err}\n`); process.exit(1); });
}
