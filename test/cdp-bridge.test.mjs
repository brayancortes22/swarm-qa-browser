import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { WebSocketServer } from 'ws';
import { createTestDom } from './helpers/test-dom.mjs';

import { startSwarmBus } from '../packages/core/src/swarm-bus.mjs';
import { connectCdpBridge, selectCdpTarget } from '../packages/cdp-adapter/src/cdp-bridge.mjs';

function makeTempRegistry(prefix = 'swarm-cdp-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, registryPath: join(dir, 'bus.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeMockDom(initialUrl = 'http://localhost:5173/player') {
  const dom = createTestDom({ url: initialUrl, width: 1440, height: 900 });
  return dom;
}

async function startMockCdp({ allowIsolatedWorld = true, initialUrl = 'http://localhost:5173/player', badJsonList = false } = {}) {
  const dom = makeMockDom(initialUrl);
  const cdpCalls = [],
    worlds = new Map(),
    remoteObjects = new Map(),
    nodeIds = new Map(),
    activeIntervals = new Set();
  let nextWorldId = 1,
    nextObjId = 1,
    nextNodeId = 10,
    activeWs = null,
    focusedEl = null;
  const mockState = { failQueryEval: false, autoLoadOnNavigate: false };
  const makeWorld = () =>
    vm.createContext({
      document: dom.doc,
      window: dom.win,
      location: dom.win.location,
      get innerWidth() {
        return dom.win.innerWidth;
      },
      get innerHeight() {
        return dom.win.innerHeight;
      },
      setInterval: (fn, ms) => {
        const handle = setInterval(fn, ms);
        activeIntervals.add(handle);
        return handle;
      },
      clearInterval: (handle) => {
        clearInterval(handle);
        activeIntervals.delete(handle);
      },
      setTimeout,
      clearTimeout,
      Symbol,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Math,
      JSON,
      Date,
      RegExp,
      Error,
      Set,
      Map
    });
  const mainWorld = makeWorld();

  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      if (badJsonList) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{bad-json');
        return;
      }
      const wsBase = `ws://127.0.0.1:${server.address().port}`;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify([
          {
            id: 'dev-1',
            type: 'page',
            url: 'devtools://devtools/bundled/inspector.html',
            webSocketDebuggerUrl: `${wsBase}/devtools/page/dev-1`
          },
          { id: 'ext-1', type: 'page', url: 'chrome-extension://abc/popup.html', webSocketDebuggerUrl: `${wsBase}/devtools/page/ext-1` },
          { id: 'wv-1', type: 'webview', url: initialUrl, title: 'Sonora Player', webSocketDebuggerUrl: `${wsBase}/devtools/page/wv-1` }
        ])
      );
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    activeWs = ws;
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      cdpCalls.push({ method: msg.method, params: msg.params });
      const reply = (result) => ws.send(JSON.stringify({ id: msg.id, result }));
      const fail = (message) => ws.send(JSON.stringify({ id: msg.id, error: { message } }));
      const p = msg.params || {};
      if (msg.method === 'Page.getFrameTree') return reply({ frameTree: { frame: { id: 'frame-main', url: dom.win.location.href } } });
      if (msg.method === 'Page.createIsolatedWorld') {
        if (!allowIsolatedWorld) return fail('Isolated world disabled in webview');
        const id = nextWorldId++;
        worlds.set(id, makeWorld());
        return reply({ executionContextId: id });
      }
      if (msg.method === 'Runtime.addBinding') {
        const attach = (ctx, ctxId) => {
          if (!ctx) return;
          ctx[p.name] = (payload) =>
            ws.send(
              JSON.stringify({
                method: 'Runtime.bindingCalled',
                params: { name: p.name, payload: String(payload ?? ''), ...(ctxId != null ? { executionContextId: ctxId } : {}) }
              })
            );
        };
        if (p.executionContextId) attach(worlds.get(p.executionContextId), p.executionContextId);
        else {
          attach(mainWorld, null);
          for (const [id, w] of worlds) attach(w, id);
        }
        return reply({});
      }
      if (msg.method === 'Runtime.evaluate') {
        if (mockState.failQueryEval && String(p.expression).includes('el.closest')) return fail('Execution context destroyed');
        try {
          const ctx = p.contextId ? worlds.get(p.contextId) : mainWorld;
          if (!ctx) return fail('Cannot find context with specified id');
          const value = vm.runInContext(p.expression, ctx);
          if (p.returnByValue === false && value !== null && (typeof value === 'object' || typeof value === 'function')) {
            const objectId = `obj-${nextObjId++}`;
            remoteObjects.set(objectId, { value, ctx });
            return reply({ result: { type: typeof value, objectId } });
          }
          return reply({ result: { type: typeof value, value } });
        } catch (err) {
          return reply({ exceptionDetails: { text: err.message } });
        }
      }
      if (msg.method === 'Runtime.callFunctionOn') {
        try {
          const entry = remoteObjects.get(p.objectId);
          if (!entry) return fail('Cannot find remote object');
          const fn = vm.runInContext(`(${p.functionDeclaration})`, entry.ctx);
          const args = (p.arguments || []).map((a) =>
            Object.hasOwn(a, 'value') ? vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(a.value))})`, entry.ctx) : undefined
          );
          const value = await fn.apply(entry.value, args);
          if (p.returnByValue === false && value !== null && (typeof value === 'object' || typeof value === 'function')) {
            const objectId = `obj-${nextObjId++}`;
            remoteObjects.set(objectId, { value, ctx: entry.ctx });
            return reply({ result: { type: typeof value, objectId } });
          }
          return reply({ result: { type: typeof value, value } });
        } catch (err) {
          return reply({ exceptionDetails: { text: err.message } });
        }
      }
      if (msg.method === 'Runtime.releaseObject') {
        remoteObjects.delete(p.objectId);
        return reply({});
      }
      if (msg.method === 'Emulation.setDeviceMetricsOverride') {
        dom.win.innerWidth = p.width;
        dom.win.innerHeight = p.height;
        return reply({});
      }
      if (msg.method === 'Emulation.clearDeviceMetricsOverride') {
        dom.win.innerWidth = 1440;
        dom.win.innerHeight = 900;
        return reply({});
      }
      if (msg.method === 'DOM.getDocument') return reply({ root: { nodeId: 1 } });
      if (msg.method === 'DOM.querySelector') {
        const el = dom.doc.querySelector(p.selector);
        if (!el) return reply({ nodeId: 0 });
        const nid = nextNodeId++;
        nodeIds.set(nid, el);
        return reply({ nodeId: nid });
      }
      if (msg.method === 'DOM.focus') {
        focusedEl = nodeIds.get(p.nodeId) || null;
        return reply({});
      }
      if (msg.method === 'Input.insertText') {
        if (focusedEl && 'value' in focusedEl) focusedEl.value = `${focusedEl.value || ''}${p.text || ''}`;
        return reply({});
      }
      if (msg.method === 'DOM.getBoxModel') {
        const r = nodeIds.get(p.nodeId)?.getBoundingClientRect();
        return reply({ model: { content: [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom] } });
      }
      if (msg.method === 'DOM.getAttributes') {
        const el = nodeIds.get(p.nodeId);
        return reply({ attributes: (el?.getAttributeNames() || []).flatMap((n) => [n, el.getAttribute(n)]) });
      }
      if (msg.method === 'Page.navigate') {
        const sameDoc = dom.win.location.href.split('#')[0] === String(p.url).split('#')[0];
        dom.setUrl(p.url);
        reply({ frameId: 'frame-main' });
        if (mockState.autoLoadOnNavigate)
          setTimeout(() => {
            if (sameDoc) ws.send(JSON.stringify({ method: 'Page.navigatedWithinDocument', params: { frameId: 'frame-main', url: p.url } }));
            else {
              ws.send(JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'frame-main', url: p.url } } }));
              ws.send(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));
            }
          }, 10);
        return;
      }
      return reply({});
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    dom,
    cdpCalls,
    mainWorld,
    remoteObjects,
    activeIntervals,
    mockState,
    emit: (method, params) => activeWs?.send(JSON.stringify({ method, params })),
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(r));
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      dom.close();
    }
  };
}

describe('cdp-bridge unit & integration', () => {
  it('selectCdpTarget filters devtools/extensions, respects urlIncludes, and prefers page/webview', () => {
    const targets = [
      { id: 'sw', type: 'service_worker', url: 'http://localhost:5173/sw.js', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/1' },
      { id: 'dev', type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/2' },
      {
        id: 'ext',
        type: 'page',
        url: 'chrome-extension://jgfhckehijkedmcellcjglbnibgccifg/popup.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/3'
      },
      { id: 'wv', type: 'webview', url: 'http://localhost:5173/home', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/4' },
      { id: 'pg', type: 'page', url: 'http://localhost:3000/docs', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/5' }
    ];
    assert.equal(selectCdpTarget(targets, { urlIncludes: 'localhost:5173' })?.id, 'wv');
    assert.equal(selectCdpTarget(targets)?.id, 'pg');
    assert.equal(selectCdpTarget(targets, { targetId: 'dev' }), null);
    assert.equal(selectCdpTarget(targets, { urlIncludes: 'missing:9999' }), null);
    assert.equal(selectCdpTarget(targets, { type: 'service_worker' })?.id, 'sw');
  });

  it('rejects non-loopback URLs and malformed CDP /json/list responses', async () => {
    await assert.rejects(
      () => connectCdpBridge({ cdpUrl: 'http://192.168.1.50:9222', busUrl: 'http://127.0.0.1:47921', token: 'abc' }),
      /non-loopback/i
    );
    await assert.rejects(
      () => connectCdpBridge({ cdpUrl: 'ws://127.0.0.1:9222/devtools/page/1', busUrl: 'http://evil.example:47921', token: 'abc' }),
      /non-loopback/i
    );
    const mock = await startMockCdp({ badJsonList: true });
    try {
      await assert.rejects(
        () => connectCdpBridge({ cdpPort: mock.port, busUrl: 'http://127.0.0.1:47921', token: 'abc' }),
        /Invalid CDP JSON/i
      );
    } finally {
      await mock.close();
    }
  });

  it('routes commands, fails closed on unreachable DOM, syncs viewport/reset/SPA routes, clears consoleNet, and awaits coalesced navigate', async () => {
    const tmp = makeTempRegistry();
    const bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });
    const mock = await startMockCdp({ allowIsolatedWorld: true });
    const rpc = async (action, params = {}) =>
      (
        await fetch(`${bus.url}/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-swarm-token': bus.token },
          body: JSON.stringify({ action, params })
        })
      ).json();
    let bridge;
    try {
      bridge = await connectCdpBridge({ cdpPort: mock.port, urlIncludes: 'localhost:5173', registryPath: tmp.registryPath });
      assert.equal(bridge.target.id, 'wv-1');
      assert.equal('__swarmQaOverlayFactory' in mock.mainWorld, false);
      assert.equal(Object.getOwnPropertySymbols(mock.mainWorld).length, 0);
      assert.equal(mock.dom.getEl('__swarm_qa_overlay')?._shadowMode, 'closed');

      assert.equal(
        (
          await bus.dispatchToTab(bridge.tabId, {
            action: 'spawn_cursors',
            cursors: [{ id: 'layout', label: 'Layout', color: '#38BDF8', x: 12, y: 24 }]
          })
        ).count,
        1
      );
      assert.equal((await bus.dispatchToTab(bridge.tabId, { action: 'move_cursor', id: 'layout', x: 64, y: 80 })).ok, true);
      assert.equal((await bus.dispatchToTab(bridge.tabId, { action: 'remove_cursor', id: 'layout' })).ok, true);

      const st0 = await rpc('session.status');
      const waitVp = bus.waitForEvent(st0.result.seq, 2000);
      const vpRes = await bus.dispatchToTab(bridge.tabId, { action: 'set_viewport', width: 390, height: 844 });
      assert.deepEqual(vpRes.viewport, { width: 390, height: 844 });
      assert.equal(vpRes.mobile, true);
      const vpEv = await waitVp;
      assert.equal(
        vpEv.events.some((e) => e.type === 'route_changed' && e.viewport?.width === 390),
        true
      );

      const vpReset = await bus.dispatchToTab(bridge.tabId, { action: 'set_viewport', reset: true });
      assert.equal(vpReset.reset, true);
      assert.deepEqual(vpReset.viewport, { width: 1440, height: 900 });
      assert.ok(mock.cdpCalls.some((c) => c.method === 'Emulation.clearDeviceMetricsOverride'));
      assert.deepEqual((await rpc('session.status')).result.tabs[0].viewport, { width: 1440, height: 900 });
      await bus.dispatchToTab(bridge.tabId, { action: 'set_viewport', width: 390, height: 844 });

      mock.emit('Runtime.exceptionThrown', {
        exceptionDetails: { text: 'TypeError: boom', url: 'app.js', lineNumber: 12, columnNumber: 4 }
      });
      mock.emit('Network.responseReceived', {
        response: { url: 'http://localhost:5173/api/fail', status: 503, statusText: 'Unavailable' }
      });
      await new Promise((r) => setTimeout(r, 25));

      const audit = await bus.dispatchToTab(bridge.tabId, {
        action: 'run_audit',
        checks: ['tap-target', 'console-net'],
        clearConsole: true
      });
      assert.equal(audit.untrustedPageData, true);
      assert.equal(audit.viewport.width, 390);
      assert.ok(audit.findings.some((f) => f.category === 'tap-target' && f.selector === '#play-btn'));
      assert.ok(audit.findings.some((f) => f.category === 'console-net' && f.severity === 'P1'));
      assert.equal(
        audit.findings.some((f) => f.selector.includes('ag-btn')),
        false
      );
      assert.equal((await bus.dispatchToTab(bridge.tabId, { action: 'get_console_network' })).entries.length, 0);

      mock.emit('Runtime.exceptionThrown', {
        exceptionDetails: { text: 'TypeError: stale', url: 'app.js', lineNumber: 1, columnNumber: 1 }
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal((await bus.dispatchToTab(bridge.tabId, { action: 'get_console_network', clear: true })).entries.length, 1);
      assert.equal((await bus.dispatchToTab(bridge.tabId, { action: 'get_console_network' })).entries.length, 0);

      const tRes = await bus.dispatchToTab(bridge.tabId, {
        action: 'set_tickets',
        tickets: [{ id: 'T-1', pathname: '/player', severity: 'P1', status: 'open' }]
      });
      assert.equal(tRes.count, 1);
      assert.ok(mock.dom.shadows.at(-1).textContent.includes('Abiertos 1'));

      const clickRes = await bus.dispatchToTab(bridge.tabId, { action: 'click', selector: '#play-btn' });
      assert.deepEqual({ x: clickRes.x, y: clickRes.y }, { x: 36, y: 56 });
      await assert.rejects(() => bus.dispatchToTab(bridge.tabId, { action: 'click', selector: '#ag-btn' }), /protected UI/i);

      mock.mockState.failQueryEval = true;
      await assert.rejects(() => bus.dispatchToTab(bridge.tabId, { action: 'click', selector: '#play-btn' }), /unreachable|protected/i);
      mock.mockState.failQueryEval = false;

      assert.equal(
        (await bus.dispatchToTab(bridge.tabId, { action: 'fill', selector: '#pw-input', value: 'TopSecret!99' })).value,
        '[redacted]'
      );
      assert.equal(
        (await bus.dispatchToTab(bridge.tabId, { action: 'fill', selector: '#csrf-token', value: 'csrf-abc' })).value,
        '[redacted]'
      );
      await bus.dispatchToTab(bridge.tabId, { action: 'fill', selector: '#email-input', value: 'qa@test.local' });
      await bus.dispatchToTab(bridge.tabId, { action: 'fill', selector: '#email-input', value: '+v2', clear: false });
      assert.equal(mock.dom.getEl('email-input').value, 'qa@test.local+v2');

      const keyRes = await bus.dispatchToTab(bridge.tabId, {
        action: 'press_key',
        selector: '#play-btn',
        key: 'Space',
        modifiers: ['Control', 'Shift']
      });
      assert.equal(keyRes.key, ' ');
      assert.equal(keyRes.modifiers, 10);
      assert.ok(mock.cdpCalls.some((c) => c.method === 'DOM.focus'));
      assert.ok(
        mock.cdpCalls.some(
          (c) =>
            c.method === 'Input.dispatchKeyEvent' &&
            c.params.type === 'keyDown' &&
            c.params.key === ' ' &&
            c.params.code === 'Space' &&
            c.params.modifiers === 10
        )
      );

      const stSpa = await rpc('session.status');
      const waitSpa = bus.waitForEvent(stSpa.result.seq, 2000);
      mock.dom.win.history.pushState({}, '', '/queue');
      assert.equal(
        (await waitSpa).events.some((e) => e.type === 'route_changed' && e.pathname === '/queue'),
        true
      );

      await assert.rejects(
        () => bus.dispatchToTab(bridge.tabId, { action: 'navigate', url: 'javascript:alert(1)' }),
        /Disallowed navigation protocol/i
      );
      mock.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Error before nav' } });
      await new Promise((r) => setTimeout(r, 15));

      const stNav = await rpc('session.status');
      const worldBefore = mock.cdpCalls.filter((c) => c.method === 'Page.createIsolatedWorld').length;
      mock.mockState.autoLoadOnNavigate = true;
      const navRes = await bus.dispatchToTab(bridge.tabId, { action: 'navigate', url: 'http://localhost:5173/albums' });
      assert.equal(navRes.pathname, '/albums');
      assert.equal(mock.cdpCalls.filter((c) => c.method === 'Page.createIsolatedWorld').length, worldBefore + 1);
      assert.equal(mock.activeIntervals.size, 1);
      assert.equal((await bus.dispatchToTab(bridge.tabId, { action: 'get_console_network' })).entries.length, 0);
      assert.equal(
        (await bus.dispatchToTab(bridge.tabId, { action: 'navigate', url: 'http://localhost:5173/albums#track2' })).url,
        'http://localhost:5173/albums#track2'
      );
      assert.equal((await rpc('session.status')).result.tabs[0].pathname, '/albums');
      assert.ok((await bus.waitForEvent(stNav.result.seq, 500)).events.some((e) => e.type === 'route_changed' && e.pathname === '/albums'));

      mock.mockState.autoLoadOnNavigate = false;
      mock.emit('Page.frameNavigated', { frame: { id: 'frame-main', url: 'http://localhost:5173/artist' } });
      const concurrentCursor = bus.dispatchToTab(bridge.tabId, { action: 'spawn_cursors', cursors: [{ id: 'a11y', x: 10, y: 10 }] });
      await new Promise((r) => setTimeout(r, 10));
      mock.dom.setUrl('http://localhost:5173/artist');
      mock.emit('Page.loadEventFired', {});
      assert.equal((await concurrentCursor).count, 1);
      assert.equal(mock.cdpCalls.filter((c) => c.method === 'Runtime.evaluate' && c.params.contextId == null).length, 0);
    } finally {
      if (bridge) await bridge.close();
      assert.equal(mock.activeIntervals.size, 0);
      assert.equal(mock.remoteObjects.size, 0);
      await mock.close();
      await bus.close();
      tmp.cleanup();
    }
  });

  it('uses Runtime.callFunctionOn objectId in non-isolated fallback without Symbol.for on globalThis, and supports CLI', async () => {
    const tmp = makeTempRegistry('swarm-cdp-fb-');
    const bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });
    const mock = await startMockCdp({ allowIsolatedWorld: false });
    let bridge;
    try {
      bridge = await connectCdpBridge({ cdpPort: mock.port, urlIncludes: 'localhost:5173', registryPath: tmp.registryPath });
      assert.equal(Object.getOwnPropertySymbols(mock.mainWorld).length, 0);
      assert.equal('__swarmQaOverlayFactory' in mock.mainWorld, false);
      assert.equal(
        Object.keys(mock.mainWorld).some((k) => k.startsWith('__swarmQa')),
        false
      );
      assert.ok(mock.cdpCalls.some((c) => c.method === 'Runtime.callFunctionOn' && typeof c.params.objectId === 'string'));
      assert.equal(
        (await bus.dispatchToTab(bridge.tabId, { action: 'spawn_cursors', cursors: [{ id: 'responsive', x: 5, y: 5 }] })).count,
        1
      );
      assert.equal(
        (
          await bus.dispatchToTab(bridge.tabId, {
            action: 'set_tickets',
            tickets: [{ id: 'T-2', pathname: '/player', severity: 'P2', status: 'verified' }]
          })
        ).count,
        1
      );
      assert.ok(mock.dom.shadows.at(-1).textContent.includes('Verificados 1'));
      await bridge.close();
      bridge = null;
      assert.ok(mock.cdpCalls.some((c) => c.method === 'Runtime.releaseObject'));
      assert.equal(mock.remoteObjects.size, 0);
      assert.equal(mock.activeIntervals.size, 0);

      const child = spawn(
        process.execPath,
        ['packages/cdp-adapter/src/cdp-bridge.mjs', '--port', String(mock.port), '--url', 'localhost:5173', '--registry', tmp.registryPath],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
      );
      try {
        const line = await new Promise((resolve, reject) => {
          let buf = '';
          const t = setTimeout(() => reject(new Error(`CLI timeout: ${buf}`)), 5000);
          child.stdout.on('data', (d) => {
            buf += d.toString('utf8');
            const nl = buf.indexOf('\n');
            if (nl !== -1) {
              clearTimeout(t);
              resolve(buf.slice(0, nl));
            }
          });
          child.once('exit', (c) => {
            clearTimeout(t);
            reject(new Error(`CLI exited (${c}): ${buf}`));
          });
        });
        const info = JSON.parse(line);
        assert.equal(info.ok, true);
        assert.equal(info.targetId, 'wv-1');
        assert.equal(line.includes(bus.token), false);
        assert.equal(Object.getOwnPropertySymbols(mock.mainWorld).length, 0);
      } finally {
        child.kill();
        await new Promise((r) => child.once('exit', r));
      }
    } finally {
      if (bridge) await bridge.close();
      await mock.close();
      await bus.close();
      tmp.cleanup();
    }
  });
});
