import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { WebSocketServer } from 'ws';

import { startSwarmBus } from '../packages/core/src/swarm-bus.mjs';
import { connectCdpBridge, selectCdpTarget } from '../packages/cdp-adapter/src/cdp-bridge.mjs';

function makeTempRegistry(prefix = 'swarm-cdp-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, registryPath: join(dir, 'bus.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeMockDom(initialUrl = 'http://localhost:5173/player') {
  const mkEl = (tag, { id = '', attrs = {}, text = '', rect = { x: 0, y: 0, width: 100, height: 48 }, style = {}, children = [], value = '' } = {}) => {
    const node = {
      tagName: tag.toUpperCase(), id, type: attrs.type ?? '', value, attrs: { ...attrs }, style: { ...style },
      children, parentElement: null, dataset: {}, classList: { toggle: () => false },
      get textContent() { return text + children.map((c) => c.textContent || '').join(''); },
      set textContent(v) { text = String(v ?? ''); children.length = 0; },
      getAttribute(n) { return n === 'id' ? (id || null) : (Object.hasOwn(node.attrs, n) ? node.attrs[n] : null); },
      setAttribute(k, v) { if (k === 'id') node.id = v; else node.attrs[k] = v; },
      hasAttribute: (n) => (n === 'id' ? Boolean(node.id) : Object.hasOwn(node.attrs, n)),
      contains: (o) => children.some((c) => c === o || c.contains(o)),
      closest(sel) {
        const ids = sel.split(',').map((s) => s.trim().replace(/^#/, ''));
        for (let cur = node; cur; cur = cur.parentElement) if (ids.includes(cur.id)) return cur;
        return null;
      },
      appendChild(c) { c.parentElement = node; children.push(c); return c; },
      addEventListener: () => {}, replaceChildren: () => { children.length = 0; },
      remove() { const p = node.parentElement; if (p) p.children = p.children.filter((c) => c !== node); node.parentElement = null; },
      attachShadow(o) { node._shadowMode = o.mode; const s = mkEl('shadow'); s.ownerDocument = doc; return s; },
      getBoundingClientRect: () => ({ left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, ...rect })
    };
    for (const c of children) c.parentElement = node;
    return node;
  };
  const findAll = (root, out = []) => { out.push(root); for (const c of root.children) findAll(c, out); return out; };
  const btn = mkEl('button', { id: 'play-btn', text: 'Play', rect: { x: 20, y: 40, width: 32, height: 32 } });
  const pw = mkEl('input', { id: 'pw-input', attrs: { type: 'password' }, rect: { x: 20, y: 100, width: 180, height: 48 } });
  const hidden = mkEl('input', { id: 'csrf-token', attrs: { type: 'hidden' }, value: 'secret-csrf' });
  const email = mkEl('input', { id: 'email-input', attrs: { type: 'email', placeholder: 'Email' }, rect: { x: 20, y: 160, width: 180, height: 48 } });
  const agUi = mkEl('div', { id: '__antigravity_native_browser_ui', children: [mkEl('button', { id: 'ag-btn', text: 'AG' })] });
  const body = mkEl('body', { children: [agUi, btn, pw, hidden, email], rect: { x: 0, y: 0, width: 390, height: 844 } });
  const html = mkEl('html', { children: [body], rect: { x: 0, y: 0, width: 390, height: 844 } });
  let curUrl = new URL(initialUrl);
  const win = {
    innerWidth: 1440, innerHeight: 900,
    location: { get href() { return curUrl.href; }, get pathname() { return curUrl.pathname; } },
    history: { pushState: (_, __, u) => { curUrl = new URL(u, curUrl); }, replaceState: () => {} },
    addEventListener: () => {}, removeEventListener: () => {},
    getComputedStyle: (n) => ({ display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', ...n.style })
  };
  const doc = {
    documentElement: html, body, defaultView: win,
    createElement: (t) => mkEl(t),
    getElementById: (id) => findAll(html).find((n) => n.id === id) || null,
    querySelector: (sel) => {
      if (sel.startsWith('#')) return findAll(html).find((n) => n.id === sel.slice(1)) || null;
      return findAll(html).find((n) => n.tagName.toLowerCase() === sel.toLowerCase()) || null;
    },
    querySelectorAll: () => findAll(html)
  };
  return { doc, win, setUrl: (u) => { curUrl = new URL(u); }, getEl: (id) => doc.getElementById(id) };
}

async function startMockCdp({ allowIsolatedWorld = true, initialUrl = 'http://localhost:5173/player' } = {}) {
  const dom = makeMockDom(initialUrl);
  const cdpCalls = [];
  const worlds = new Map();
  let nextWorldId = 1, activeWs = null;
  const makeWorld = () => vm.createContext({
    document: dom.doc, window: dom.win, location: dom.win.location,
    get innerWidth() { return dom.win.innerWidth; }, get innerHeight() { return dom.win.innerHeight; },
    setInterval: () => ({ unref: () => {} }), clearInterval: () => {},
    Symbol, Object, Array, String, Number, Boolean, Math, JSON, Date, RegExp, Error, Set, Map
  });
  const mainWorld = makeWorld();
  const nodeIds = new Map();
  let nextNodeId = 10;

  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      const wsBase = `ws://127.0.0.1:${server.address().port}`;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
        { id: 'dev-1', type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: `${wsBase}/devtools/page/dev-1` },
        { id: 'ext-1', type: 'page', url: 'chrome-extension://abc/popup.html', webSocketDebuggerUrl: `${wsBase}/devtools/page/ext-1` },
        { id: 'wv-1', type: 'webview', url: initialUrl, title: 'Sonora Player', webSocketDebuggerUrl: `${wsBase}/devtools/page/wv-1` }
      ]));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    activeWs = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      cdpCalls.push({ method: msg.method, params: msg.params });
      const reply = (result) => ws.send(JSON.stringify({ id: msg.id, result }));
      const fail = (message) => ws.send(JSON.stringify({ id: msg.id, error: { message } }));
      const p = msg.params || {};
      if (msg.method === 'Page.getFrameTree') return reply({ frameTree: { frame: { id: 'frame-main', url: dom.win.location.href } } });
      if (msg.method === 'Page.createIsolatedWorld') {
        if (!allowIsolatedWorld) return fail('Isolated world disabled in webview');
        const id = nextWorldId++; worlds.set(id, makeWorld()); return reply({ executionContextId: id });
      }
      if (msg.method === 'Runtime.evaluate') {
        try {
          const ctx = p.contextId ? worlds.get(p.contextId) : mainWorld;
          const value = vm.runInContext(p.expression, ctx);
          return reply({ result: { type: typeof value, value } });
        } catch (err) { return reply({ exceptionDetails: { text: err.message } }); }
      }
      if (msg.method === 'Emulation.setDeviceMetricsOverride') {
        dom.win.innerWidth = p.width; dom.win.innerHeight = p.height; return reply({});
      }
      if (msg.method === 'DOM.getDocument') return reply({ root: { nodeId: 1 } });
      if (msg.method === 'DOM.querySelector') {
        const el = dom.doc.querySelector(p.selector);
        if (!el) return reply({ nodeId: 0 });
        const nid = nextNodeId++; nodeIds.set(nid, el); return reply({ nodeId: nid });
      }
      if (msg.method === 'DOM.getBoxModel') {
        const r = nodeIds.get(p.nodeId)?.getBoundingClientRect();
        return reply({ model: { content: [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom] } });
      }
      if (msg.method === 'DOM.getAttributes') {
        const el = nodeIds.get(p.nodeId);
        const flat = Object.entries(el?.attrs || {}).flat();
        return reply({ attributes: flat });
      }
      if (msg.method === 'Page.navigate') {
        dom.setUrl(p.url); return reply({ frameId: 'frame-main' });
      }
      return reply({});
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port, dom, cdpCalls, mainWorld,
    emit: (method, params) => activeWs?.send(JSON.stringify({ method, params })),
    close: async () => { for (const c of wss.clients) c.terminate(); await new Promise((r) => wss.close(r)); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
  };
}

describe('cdp-bridge unit & integration', () => {
  it('selectCdpTarget filters devtools/extensions, respects urlIncludes, and prefers page/webview', () => {
    const targets = [
      { id: 'sw', type: 'service_worker', url: 'http://localhost:5173/sw.js', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/1' },
      { id: 'dev', type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/2' },
      { id: 'ext', type: 'page', url: 'chrome-extension://jgfhckehijkedmcellcjglbnibgccifg/popup.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/3' },
      { id: 'wv', type: 'webview', url: 'http://localhost:5173/home', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/4' },
      { id: 'pg', type: 'page', url: 'http://localhost:3000/docs', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/5' }
    ];
    assert.equal(selectCdpTarget(targets, { urlIncludes: 'localhost:5173' })?.id, 'wv');
    assert.equal(selectCdpTarget(targets)?.id, 'pg');
    assert.equal(selectCdpTarget(targets, { targetId: 'dev' }), null);
    assert.equal(selectCdpTarget(targets, { urlIncludes: 'missing:9999' }), null);
    assert.equal(selectCdpTarget(targets, { type: 'service_worker' })?.id, 'sw');
  });

  it('rejects non-loopback CDP or bus URLs before connecting', async () => {
    await assert.rejects(
      () => connectCdpBridge({ cdpUrl: 'http://192.168.1.50:9222', busUrl: 'http://127.0.0.1:47921', token: 'abc' }),
      /non-loopback/i
    );
    await assert.rejects(
      () => connectCdpBridge({ cdpUrl: 'ws://127.0.0.1:9222/devtools/page/1', busUrl: 'http://evil.example:47921', token: 'abc' }),
      /non-loopback/i
    );
  });

  it('routes bus commands (spawn_cursors, set_viewport, run_audit, click, fill redaction, press_key, navigate, console/net) & reinjects on navigation', async () => {
    const tmp = makeTempRegistry();
    const bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });
    const mock = await startMockCdp({ allowIsolatedWorld: true });
    let bridge;
    try {
      bridge = await connectCdpBridge({ cdpPort: mock.port, urlIncludes: 'localhost:5173', registryPath: tmp.registryPath });
      assert.equal(bridge.target.id, 'wv-1');
      assert.equal('__swarmQaOverlayFactory' in mock.mainWorld, false);
      assert.equal(mock.dom.getEl('__swarm_qa_overlay')?._shadowMode, 'closed');

      const spawnRes = await bus.dispatchToTab(bridge.tabId, {
        action: 'spawn_cursors',
        cursors: [{ id: 'layout', label: 'Layout', color: '#38BDF8', x: 12, y: 24 }]
      });
      assert.equal(spawnRes.count, 1);
      assert.equal((await bus.dispatchToTab(bridge.tabId, { action: 'move_cursor', id: 'layout', x: 64, y: 80 })).ok, true);
      assert.equal((await bus.dispatchToTab(bridge.tabId, { action: 'remove_cursor', id: 'layout' })).ok, true);

      const vpRes = await bus.dispatchToTab(bridge.tabId, { action: 'set_viewport', width: 390, height: 844 });
      assert.deepEqual(vpRes.viewport, { width: 390, height: 844 });
      assert.equal(vpRes.mobile, true);
      assert.ok(mock.cdpCalls.some((c) => c.method === 'Emulation.setDeviceMetricsOverride' && c.params.width === 390));

      mock.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'TypeError: boom', url: 'app.js', lineNumber: 12, columnNumber: 4 } });
      mock.emit('Network.responseReceived', { response: { url: 'http://localhost:5173/api/fail', status: 503, statusText: 'Unavailable' } });
      await new Promise((r) => setTimeout(r, 25));

      const audit = await bus.dispatchToTab(bridge.tabId, { action: 'run_audit', checks: ['tap-target', 'console-net'] });
      assert.equal(audit.untrustedPageData, true);
      assert.equal(audit.viewport.width, 390);
      assert.ok(audit.findings.some((f) => f.category === 'tap-target' && f.selector === '#play-btn'));
      assert.ok(audit.findings.some((f) => f.category === 'console-net' && f.severity === 'P1'));
      assert.equal(audit.findings.some((f) => f.selector.includes('ag-btn')), false);

      const net = await bus.dispatchToTab(bridge.tabId, { action: 'get_console_network', clear: true });
      assert.equal(net.entries.length, 2);
      assert.equal((await bus.dispatchToTab(bridge.tabId, { action: 'get_console_network' })).entries.length, 0);

      const tRes = await bus.dispatchToTab(bridge.tabId, { action: 'set_tickets', tickets: [{ id: 'T-1', pathname: '/player', severity: 'P1', status: 'open' }] });
      assert.equal(tRes.count, 1);

      const clickRes = await bus.dispatchToTab(bridge.tabId, { action: 'click', selector: '#play-btn' });
      assert.deepEqual({ x: clickRes.x, y: clickRes.y }, { x: 36, y: 56 });
      assert.ok(mock.cdpCalls.some((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed' && c.params.x === 36));
      await assert.rejects(() => bus.dispatchToTab(bridge.tabId, { action: 'click', selector: '#ag-btn' }), /protected UI/i);

      const pwFill = await bus.dispatchToTab(bridge.tabId, { action: 'fill', selector: '#pw-input', value: 'TopSecret!99' });
      assert.equal(pwFill.redacted, true);
      assert.equal(pwFill.value, '[redacted]');
      const hidFill = await bus.dispatchToTab(bridge.tabId, { action: 'fill', selector: '#csrf-token', value: 'csrf-abc' });
      assert.equal(hidFill.redacted, true);
      assert.equal(hidFill.value, '[redacted]');
      const emailFill = await bus.dispatchToTab(bridge.tabId, { action: 'fill', selector: '#email-input', value: 'qa@test.local' });
      assert.equal(emailFill.redacted, false);
      assert.equal(emailFill.value, 'qa@test.local');

      const keyRes = await bus.dispatchToTab(bridge.tabId, { action: 'press_key', key: 'Enter' });
      assert.equal(keyRes.key, 'Enter');
      assert.ok(mock.cdpCalls.some((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyDown' && c.params.key === 'Enter'));

      await assert.rejects(() => bus.dispatchToTab(bridge.tabId, { action: 'navigate', url: 'javascript:alert(1)' }), /Disallowed navigation protocol/i);
      const statusPre = await (await fetch(`${bus.url}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-swarm-token': bus.token }, body: JSON.stringify({ action: 'session.status' }) })).json();
      const waitNav = bus.waitForEvent(statusPre.result.seq, 2000);
      await bus.dispatchToTab(bridge.tabId, { action: 'navigate', url: 'http://localhost:5173/albums' });
      const worldCountBefore = mock.cdpCalls.filter((c) => c.method === 'Page.createIsolatedWorld').length;
      mock.emit('Page.frameNavigated', { frame: { id: 'frame-main', url: 'http://localhost:5173/albums' } });
      mock.emit('Page.loadEventFired', {});
      const navEv = await waitNav;
      assert.equal(navEv.events.some((e) => e.type === 'route_changed' && e.pathname === '/albums'), true);
      assert.ok(mock.cdpCalls.filter((c) => c.method === 'Page.createIsolatedWorld').length > worldCountBefore);
    } finally {
      if (bridge) await bridge.close();
      await mock.close();
      await bus.close();
      tmp.cleanup();
    }
  });

  it('falls back to Runtime.evaluate when webview refuses Page.createIsolatedWorld without leaking globals or touching native UI, and supports CLI', async () => {
    const tmp = makeTempRegistry('swarm-cdp-fb-');
    const bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });
    const mock = await startMockCdp({ allowIsolatedWorld: false });
    const child = spawn(process.execPath, [
      'packages/cdp-adapter/src/cdp-bridge.mjs', '--port', String(mock.port), '--url', 'localhost:5173', '--registry', tmp.registryPath
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const line = await new Promise((resolve, reject) => {
        let buf = '';
        const t = setTimeout(() => reject(new Error(`CLI timeout: ${buf}`)), 5000);
        child.stdout.on('data', (d) => { buf += d.toString('utf8'); const nl = buf.indexOf('\n'); if (nl !== -1) { clearTimeout(t); resolve(buf.slice(0, nl)); } });
        child.once('exit', (c) => { clearTimeout(t); reject(new Error(`CLI exited (${c}): ${buf}`)); });
      });
      const info = JSON.parse(line);
      assert.equal(info.ok, true);
      assert.equal(info.targetId, 'wv-1');
      assert.equal(line.includes(bus.token), false);
      assert.equal('__swarmQaOverlayFactory' in mock.mainWorld, false);
      assert.equal(mock.dom.getEl('__swarm_qa_overlay')?._shadowMode, 'closed');
      assert.equal(mock.dom.getEl('__antigravity_native_browser_ui')?.children.length, 1);

      const res = await bus.dispatchToTab(info.tabId, { action: 'spawn_cursors', cursors: [{ id: 'responsive', x: 5, y: 5 }] });
      assert.equal(res.count, 1);
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
      await mock.close();
      await bus.close();
      tmp.cleanup();
    }
  });
});
