import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { readBusRegistry } from '../../core/src/session-auth.mjs';
import { sanitizePageText } from '../../core/src/ticket-store.mjs';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const IGNORED_URL_RE = /^(?:devtools|chrome-extension):\/\//i, PROTECTED_UI_RE = /__(?:antigravity_native_browser_ui|swarm_qa_overlay)\b/;
const OVERLAY_BUNDLE = readFileSync(new URL('../overlay.bundle.js', import.meta.url), 'utf8');
const KEY_META = { Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46], Space: ['Space', 32, ' '], ' ': ['Space', 32, ' '], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40] };
const CLI_FLAGS = { '--port': ['cdpPort', Number], '--cdp-port': ['cdpPort', Number], '--cdp-url': ['cdpUrl'], '--url': ['urlIncludes'], '--target': ['targetId'], '--target-id': ['targetId'], '--type': ['type'], '--registry': ['registryPath'], '--bus-url': ['busUrl'], '--token': ['token'], '--tab-id': ['tabId'] };

const assertLoopback = (raw) => { const u = new URL(String(raw)); if (!LOOPBACK.has(u.hostname.toLowerCase())) throw new Error(`Refusing non-loopback URL: ${u.origin || raw}`); return u.href; };
const closeWs = (ws) => (!ws || ws.readyState === 3 ? Promise.resolve() : new Promise((r) => { ws.once('close', r); ws.readyState === 0 ? ws.terminate() : ws.readyState === 1 && ws.close(); }));
const httpGetJson = (url) => new Promise((res, rej) => httpGet(url, { agent: false }, (r) => {
  const chunks = []; r.on('data', (c) => chunks.push(c));
  r.on('end', () => ((r.statusCode ?? 500) >= 400 ? rej(new Error(`CDP HTTP ${r.statusCode}`)) : res(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
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
    ws.once('open', () => { settled = true; res({
      send: (method, params = {}) => (ws.readyState !== 1 ? Promise.reject(new Error('CDP WebSocket closed')) : new Promise((a, b) => { const id = nextId++; pending.set(id, { resolve: a, reject: b }); ws.send(JSON.stringify({ id, method, params })); })),
      onEvent: (fn) => events.add(fn), onClose: (fn) => onClose.add(fn), close: () => { rejectAll('CDP bridge closed'); return closeWs(ws); }
    }); });
    ws.once('error', (err) => { if (!settled) { settled = true; rej(err); } });
    ws.on('close', () => { rejectAll('CDP WebSocket closed'); for (const fn of onClose) fn(); });
  });
}

async function querySafeNode(cdp, evalCtx, selector) {
  if (!selector || typeof selector !== 'string' || PROTECTED_UI_RE.test(selector)) throw new Error('Invalid or protected selector');
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 }), { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root?.nodeId, selector });
  if (!nodeId) throw new Error(`Element not found: ${sanitizePageText(selector, 120)}`);
  const meta = await evalCtx(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? { protected: Boolean(el.closest?.('#__antigravity_native_browser_ui, #__swarm_qa_overlay')), tag: String(el.tagName || '').toLowerCase(), type: String(el.getAttribute?.('type') || el.type || '').toLowerCase() } : null; })()`).catch(() => null);
  if (meta?.protected) throw new Error('Refusing protected UI element');
  return { nodeId, meta };
}

/** Connects a Chromium CDP target (page/webview) to the local swarm QA bus with isolated overlay injection. */
export async function connectCdpBridge({ cdpUrl, cdpPort = 9222, targetId, urlIncludes, type, registryPath, busUrl, token, tabId: customTabId } = {}) {
  const reg = !busUrl || !token ? readBusRegistry(registryPath) : null;
  const authToken = token || reg?.token, resolvedBus = busUrl || (reg?.port ? `http://${reg.host === '::1' ? '[::1]' : (reg.host || '127.0.0.1')}:${reg.port}` : '');
  if (!resolvedBus || !authToken) throw new Error('Swarm bus registry or token unavailable');
  const busWsUrl = assertLoopback(resolvedBus.replace(/^http/i, 'ws')), port = Number(cdpPort);
  if (!cdpUrl && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`Invalid CDP port: ${cdpPort}`);
  const target = cdpUrl && /^wss?:/i.test(cdpUrl) ? { id: targetId || 'cdp-direct', type: type || 'page', url: '', webSocketDebuggerUrl: cdpUrl }
    : selectCdpTarget(await httpGetJson(`${cdpUrl ? assertLoopback(cdpUrl).replace(/\/json(?:\/list)?\/?$/, '') : `http://127.0.0.1:${port}`}/json/list`), { targetId, urlIncludes, type });
  if (!target?.webSocketDebuggerUrl) throw new Error('No matching CDP target with webSocketDebuggerUrl');
  const wsTargetUrl = assertLoopback(target.webSocketDebuggerUrl);

  const cdp = await openCdpClient(wsTargetUrl), tabId = customTabId || `cdp-${target.id || randomUUID().slice(0, 8)}`, nonce = randomUUID().slice(0, 12);
  const state = { frameId: target.id || 'main', contextId: null, viewport: { width: 1440, height: 900 }, viewportOverride: false, url: target.url || '', pathname: '/', title: target.title || '', consoleNet: [] };
  const pushNet = (e) => { state.consoleNet.push({ ...e, ts: Date.now(), untrustedPageData: true }); if (state.consoleNet.length > 100) state.consoleNet.shift(); };
  const evalCtx = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, ...(state.contextId != null ? { contextId: state.contextId } : {}), returnByValue: true, awaitPromise: true });
    if (res?.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'CDP eval error');
    return res?.result?.value;
  };
  let mountQueue = Promise.resolve(), closing = null, busWs = null;
  const close = () => (closing ??= Promise.all([closeWs(busWs), cdp.close()]).then(() => {}));
  cdp.onClose(() => close());

  const injectOverlay = (notifyBus = false) => (mountQueue = mountQueue.then(async () => {
    if (closing) return;
    let isolated = true;
    try { state.contextId = (await cdp.send('Page.createIsolatedWorld', { frameId: state.frameId, worldName: 'swarm_qa_isolated' }))?.executionContextId ?? null; }
    catch { isolated = false; state.contextId = null; }
    if (!(await evalCtx('Boolean(globalThis.__swarmQaOverlayFactory)'))) await evalCtx(OVERLAY_BUNDLE);
    const meta = await evalCtx(`(() => { const f = globalThis.__swarmQaOverlayFactory, sym = Symbol.for('__swarm_qa_overlay_ctrl'); globalThis[sym]?.destroy?.(); const ctrl = f.mountSwarmOverlay({ nonce: ${JSON.stringify(nonce)} }); Object.defineProperty(globalThis, sym, { value: ctrl, configurable: true }); ${isolated ? '' : 'delete globalThis.__swarmQaOverlayFactory;'} return { url: location.href, pathname: location.pathname || '/', title: document.title || '', viewport: { width: innerWidth || 1440, height: innerHeight || 900 } }; })()`);
    if (meta) { state.url = meta.url || state.url; state.pathname = meta.pathname || state.pathname; state.title = meta.title ?? state.title; if (!state.viewportOverride && meta.viewport) state.viewport = meta.viewport; }
    if (notifyBus && busWs?.readyState === 1) busWs.send(JSON.stringify({ type: 'route_changed', tabId, url: state.url, pathname: state.pathname, title: state.title, viewport: state.viewport }));
  }));

  await Promise.all(['Page.enable', 'DOM.enable', 'Runtime.enable', 'Network.enable'].map((m) => cdp.send(m)));
  const tree = await cdp.send('Page.getFrameTree').catch(() => null);
  if (tree?.frameTree?.frame?.id) state.frameId = tree.frameTree.frame.id;
  cdp.onEvent((method, p) => {
    if (method === 'Runtime.exceptionThrown') pushNet({ kind: 'exception', uncaught: true, message: sanitizePageText(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'Uncaught error'), source: sanitizePageText(p.exceptionDetails?.url || ''), line: Number(p.exceptionDetails?.lineNumber) || 0, col: Number(p.exceptionDetails?.columnNumber) || 0 });
    else if (method === 'Runtime.consoleAPICalled' && p.type === 'error') pushNet({ kind: 'console.error', message: sanitizePageText((p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')) });
    else if (method === 'Network.responseReceived' && Number(p.response?.status) >= 400) pushNet({ kind: 'network', status: Number(p.response.status), url: sanitizePageText(p.response.url || ''), message: sanitizePageText(`${p.response.status} ${p.response.statusText || ''}`.trim()) });
    else if (method === 'Runtime.executionContextsCleared') state.contextId = null;
    else if (method === 'Page.frameNavigated' && !p.frame?.parentId) { state.frameId = p.frame?.id || state.frameId; state.contextId = null; injectOverlay(true).catch(() => {}); }
    else if (method === 'Page.loadEventFired') injectOverlay(true).catch(() => {});
  });

  const evalCtrl = (call) => evalCtx(`(() => { const ctrl = globalThis[Symbol.for('__swarm_qa_overlay_ctrl')]; if (!ctrl) throw new Error('Swarm overlay not mounted'); return ${call}; })()`);
  const handlers = {
    spawn_cursors: async (a, c) => ({ ok: true, count: await evalCtrl(`ctrl.spawnCursors(${JSON.stringify(a.cursors ? { cursors: a.cursors, clear: Boolean(a.clear) } : (Array.isArray(c) ? c : (a.id ? [a] : [])))})`) }),
    move_cursor: async (a) => (await evalCtrl(`ctrl.moveCursor(${JSON.stringify(a.cursor ?? a)})`), { ok: true }),
    remove_cursor: async (a) => (await evalCtrl(`ctrl.removeCursor(${JSON.stringify(a.id ?? a.cursorId ?? '')})`), { ok: true }),
    run_audit: async (a) => ({ ...(await evalCtrl(`ctrl.runAudit(${JSON.stringify({ checks: a.checks ?? null, viewport: a.viewport ?? state.viewport, consoleEntries: state.consoleNet.slice() })})`)), untrustedPageData: true }),
    set_tickets: (a) => evalCtrl(`(() => { ctrl.setTickets(${JSON.stringify(a.tickets ?? [])}, ${JSON.stringify(a.pathname ?? null)}); ${a.summary ? `ctrl.updateSummary(${JSON.stringify(a.summary)});` : ''} return { ok: true, count: ${Array.isArray(a.tickets) ? a.tickets.length : 0} }; })()`),
    set_viewport: async (a) => {
      const width = Number(a.width) || 1440, height = Number(a.height) || 900, mobile = typeof a.mobile === 'boolean' ? a.mobile : width <= 480;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: Number(a.deviceScaleFactor ?? 1) || 1, mobile });
      state.viewport = { width, height }; state.viewportOverride = true; return { ok: true, viewport: state.viewport, mobile };
    },
    click: async (a) => {
      let x = Number(a.x), y = Number(a.y);
      if (a.selector) {
        const { nodeId } = await querySafeNode(cdp, evalCtx, a.selector);
        await cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
        const m = (await cdp.send('DOM.getBoxModel', { nodeId }))?.model, pts = m?.content || m?.border;
        if (!Array.isArray(pts) || pts.length < 8) throw new Error('Missing box model for click target');
        x = (pts[0] + pts[2] + pts[4] + pts[6]) / 4; y = (pts[1] + pts[3] + pts[5] + pts[7]) / 4;
      } else if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click requires selector or coordinates');
      const button = a.button || 'left', clickCount = Number(a.clickCount) || 1;
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : button, ...(type === 'mouseMoved' ? {} : { clickCount }) });
      return { ok: true, x, y, selector: a.selector ? sanitizePageText(a.selector) : null };
    },
    fill: async (a) => {
      const { nodeId, meta } = await querySafeNode(cdp, evalCtx, a.selector);
      const attrs = (await cdp.send('DOM.getAttributes', { nodeId }).catch(() => null))?.attributes || [], idx = attrs.findIndex((v, i) => i % 2 === 0 && String(v).toLowerCase() === 'type');
      const kind = meta?.type || (idx >= 0 ? String(attrs[idx + 1] || '').toLowerCase() : ''), sensitive = (meta?.tag ? meta.tag === 'input' : true) && (kind === 'password' || kind === 'hidden');
      if (a.clear !== false) await evalCtx(`(() => { const el = document.querySelector(${JSON.stringify(a.selector)}); if (el && 'value' in el) el.value = ''; })()`).catch(() => {});
      await cdp.send('DOM.focus', { nodeId }).catch(() => {});
      const text = String(a.value ?? ''); await cdp.send('Input.insertText', { text });
      return { ok: true, selector: sanitizePageText(a.selector), redacted: sensitive, value: sensitive ? '[redacted]' : sanitizePageText(text), untrustedPageData: true };
    },
    press_key: async (a) => {
      const key = String(a.key ?? ''); if (!key) throw new Error('press_key requires key');
      const [code, vk, text] = KEY_META[key] || [key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : undefined, key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, key.length === 1 ? key : undefined];
      const base = { key, ...(code ? { code } : {}), ...(vk ? { windowsVirtualKeyCode: vk } : {}), modifiers: Number(a.modifiers) || 0 };
      for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, ...base, ...(type === 'keyDown' && text ? { text } : {}) });
      return { ok: true, key: sanitizePageText(key, 40) };
    },
    navigate: async (a) => {
      const u = String(a.url ?? '').startsWith('/') && state.url ? new URL(a.url, state.url) : new URL(String(a.url ?? ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Disallowed navigation protocol: ${u.protocol}`);
      const res = await cdp.send('Page.navigate', { url: u.href }); if (res?.errorText) throw new Error(res.errorText);
      return { ok: true, url: u.href, frameId: res?.frameId ?? state.frameId };
    },
    get_console_network: (a) => ({ entries: a.clear ? state.consoleNet.splice(0) : state.consoleNet.slice(), untrustedPageData: true })
  };

  try {
    await injectOverlay(false);
    busWs = await new Promise((resolvePromise, reject) => {
      const ws = new WebSocket(busWsUrl, { headers: { 'x-swarm-token': authToken } });
      let acked = false; const fail = (err) => { if (!acked) { acked = true; reject(err); } };
      ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', tabId, url: state.url, pathname: state.pathname, title: state.title, viewport: state.viewport })));
      ws.on('message', async (raw) => {
        let msg; try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
        if (msg.type === 'hello_ack' && !acked) { acked = true; return resolvePromise(ws); }
        if (msg.type !== 'command') return;
        const cmd = msg.command, act = cmd?.action ?? cmd?.type, args = cmd?.params && typeof cmd.params === 'object' ? { ...cmd, ...cmd.params } : (cmd || {});
        const reply = (p) => ws.send(JSON.stringify({ type: 'command_result', commandId: msg.commandId, ...p }));
        try { if (!Object.hasOwn(handlers, act)) throw new Error(`Unsupported command: ${act}`); reply({ ok: true, result: await handlers[act](args, cmd) }); }
        catch (err) { reply({ ok: false, error: err?.message || 'Command failed' }); }
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
  connectCdpBridge(opts).then((b) => {
    process.stdout.write(`${JSON.stringify({ ok: true, tabId: b.tabId, targetId: b.target?.id, url: b.target?.url, type: b.target?.type })}\n`);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.once(sig, () => b.close().finally(() => process.exit(0)));
  }).catch((err) => { process.stderr.write(`${err?.message ?? err}\n`); process.exit(1); });
}
