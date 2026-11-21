import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createTestDom } from './helpers/test-dom.mjs';

import { startSwarmBus } from '../packages/core/src/swarm-bus.mjs';
import { DEFAULT_EXTENSION_ID, getPairingPath, loadOrCreatePairingCode } from '../packages/core/src/session-auth.mjs';

const OVERLAY_BUNDLE = readFileSync(new URL('../packages/extension/overlay.bundle.js', import.meta.url), 'utf8');
const CONTENT_SRC = readFileSync(new URL('../packages/extension/content.js', import.meta.url), 'utf8');
let modSeq = 0;

function makeTempRegistry(prefix = 'swarm-ext-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, registryPath: join(dir, 'bus.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function getFreePort() {
  const srv = createNetServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const openDoms = new Set();

/** Runs the real overlay bundle + content script inside a jsdom page with a mocked `chrome.runtime`. */
function makeContentSandbox({ initialUrl = 'http://localhost:5173/player', title = 'Sonora', width = 390, height = 844 } = {}) {
  const dom = createTestDom({ url: initialUrl, title, width, height });
  openDoms.add(dom);
  const sent = [];
  let listener = null;
  dom.win.chrome = {
    runtime: {
      sendMessage: (p) => {
        sent.push(p);
        return Promise.resolve({ ok: true });
      },
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        }
      }
    }
  };
  dom.run(OVERLAY_BUNDLE);
  dom.run(CONTENT_SRC);
  const send = (msg) => {
    let reply;
    listener(msg, {}, (r) => {
      reply = r;
    });
    return reply;
  };
  return {
    sandbox: dom.win,
    doc: dom.doc,
    win: dom.win,
    sent,
    send,
    run: dom.run,
    getEl: dom.getEl,
    setUrl: dom.setUrl,
    close: () => {
      send({ type: 'destroy_overlay' });
      dom.close();
      openDoms.delete(dom);
    }
  };
}

function makePopupEnv({ tab = { id: 101, url: 'http://localhost:5173/player' }, statusRes, onMessage, onPermReq, onPermRem } = {}) {
  const ids = [
    'busDot',
    'busText',
    'portInput',
    'savePortBtn',
    'pairInput',
    'savePairBtn',
    'tabUrl',
    'tabViewport',
    'probeCheck',
    'consentCheck',
    'enableBtn',
    'detachBtn',
    'exportBtn',
    'feedback'
  ];
  const elems = Object.fromEntries(
    ids.map((id) => {
      const listeners = new Map();
      const el = {
        id,
        textContent: id === 'enableBtn' ? 'Habilitar permisos y arrancar enjambre' : '',
        className: '',
        title: '',
        value: id === 'portInput' ? '47921' : '',
        checked: id === 'probeCheck',
        disabled: false,
        classList: {
          toggle: (c, f) => {
            el._toggled = { c, f };
          }
        },
        addEventListener: (t, fn) => {
          if (!listeners.has(t)) listeners.set(t, []);
          listeners.get(t).push(fn);
        },
        async trigger(t) {
          for (const fn of listeners.get(t) || []) await fn();
        }
      };
      return [id, el];
    })
  );
  const downloads = [];
  const doc = {
    activeElement: null,
    getElementById: (id) => elems[id] || null,
    createElement: () => ({
      click: () => {
        downloads.push({ href: doc._last.href, download: doc._last.download });
      },
      set href(v) {
        doc._last.href = v;
      },
      set download(v) {
        doc._last.download = v;
      }
    }),
    _last: {}
  };
  const messages = [];
  const chromeMock = {
    tabs: { query: async () => (tab ? [tab] : []) },
    permissions: {
      request: async (q) => (onPermReq ? onPermReq(q) : true),
      remove: async (q) => (onPermRem ? onPermRem(q) : true)
    },
    runtime: {
      sendMessage: async (msg) => {
        messages.push(msg);
        if (onMessage) return onMessage(msg);
        if (msg.type === 'get_status') return statusRes ?? { ok: true, busConnected: false, port: 47921, tab: null };
        return { ok: true };
      }
    }
  };
  return { elems, doc, chromeMock, messages, downloads };
}

function makeBackgroundEnv({
  initialTabs = [],
  grantedOrigins = [],
  localStore = {},
  sessionStore = {},
  failInjectOrigins = [],
  registryPath
} = {}) {
  // The extension must know the bus pairing code (normally typed once into the popup).
  if (registryPath && !('swarmPairCode' in localStore))
    localStore = { ...localStore, swarmPairCode: loadOrCreatePairingCode(getPairingPath(registryPath)) };
  const tabs = new Map(initialTabs.map((t) => [t.id, { ...t }]));
  const granted = new Set(grantedOrigins);
  const localData = new Map(Object.entries(localStore));
  const sessionData = new Map(Object.entries(sessionStore));
  const attached = new Set();
  const cdpCalls = [],
    detachCalls = [],
    wsSent = [];
  const listeners = { dbgEvent: [], dbgDetach: [], tabRemoved: [], tabUpdated: [], runtimeMsg: [] };
  const tabSandboxes = new Map();

  const chromeMock = {
    storage: {
      local: {
        get: async (k) => (k in Object.fromEntries(localData) ? { [k]: localData.get(k) } : {}),
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) localData.set(k, v);
        }
      },
      session: {
        get: async (k) => (sessionData.has(k) ? { [k]: sessionData.get(k) } : {}),
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) sessionData.set(k, structuredClone(v));
        }
      }
    },
    permissions: {
      contains: async ({ origins = [] }) => origins.every((o) => granted.has(o))
    },
    scripting: {
      executeScript: async ({ target: { tabId } }) => {
        const t = tabs.get(tabId);
        if (!t) throw new Error('No tab');
        const u = new URL(t.url);
        const isLocal = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
        if (failInjectOrigins.includes(u.origin) || (!isLocal && !granted.has(`${u.protocol}//${u.hostname}/*`))) {
          throw new Error(`Cannot access contents of url "${t.url}". Extension manifest must request permission.`);
        }
        if (!tabSandboxes.has(tabId)) tabSandboxes.set(tabId, makeContentSandbox({ initialUrl: t.url }));
        else tabSandboxes.get(tabId).setUrl(t.url);
      }
    },
    tabs: {
      get: async (tabId) => (tabs.has(tabId) ? { ...tabs.get(tabId) } : null),
      sendMessage: async (tabId, msg) => {
        const sb = tabSandboxes.get(tabId);
        if (!sb) throw new Error(`No content script in tab ${tabId}`);
        return sb.send(msg);
      },
      onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) },
      onUpdated: {
        addListener: (fn) => listeners.tabUpdated.push(fn),
        removeListener: (fn) => {
          const i = listeners.tabUpdated.indexOf(fn);
          if (i !== -1) listeners.tabUpdated.splice(i, 1);
        }
      }
    },
    debugger: {
      attach: async ({ tabId }) => {
        attached.add(tabId);
      },
      detach: async ({ tabId }) => {
        detachCalls.push(tabId);
        attached.delete(tabId);
      },
      sendCommand: async ({ tabId }, method, params) => {
        cdpCalls.push({ tabId, method, params });
        if (!attached.has(tabId) && method === 'DOM.enable') throw new Error('Debugger is not attached');
        if (method === 'Page.navigate' && params?.url) {
          const t = tabs.get(tabId);
          if (t) t.url = params.url;
          for (const fn of [...listeners.tabUpdated]) fn(tabId, { status: 'loading', url: params.url }, { id: tabId, url: params.url });
          queueMicrotask(() => {
            for (const fn of [...listeners.tabUpdated]) fn(tabId, { status: 'complete' }, { id: tabId, url: params.url });
          });
        }
        if (method === 'Runtime.evaluate' && params?.expression) {
          const sb = tabSandboxes.get(tabId);
          if (sb) sb.run(params.expression);
        }
        return {};
      },
      onEvent: { addListener: (fn) => listeners.dbgEvent.push(fn) },
      onDetach: { addListener: (fn) => listeners.dbgDetach.push(fn) }
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.runtimeMsg.push(fn) }
    }
  };

  const callRuntime = (msg, sender = {}) =>
    new Promise((resolve) => {
      listeners.runtimeMsg[0](msg, sender, resolve);
    });

  const orig = { chrome: globalThis.chrome, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
  const extOrigin = `chrome-extension://${DEFAULT_EXTENSION_ID}`;
  globalThis.chrome = chromeMock;
  globalThis.fetch = (url, init = {}) => orig.fetch(url, { ...init, headers: { origin: extOrigin, ...(init.headers || {}) } });
  globalThis.WebSocket = class ExtWs extends WebSocket {
    constructor(url, protocols) {
      if (protocols && typeof protocols !== 'object') super(url, protocols, { headers: { origin: extOrigin } });
      else super(url, { headers: { origin: extOrigin } });
    }
    send(data) {
      wsSent.push(JSON.parse(String(data)));
      return super.send(data);
    }
  };

  return {
    tabs,
    granted,
    localData,
    sessionData,
    attached,
    cdpCalls,
    detachCalls,
    wsSent,
    listeners,
    tabSandboxes,
    callRuntime,
    emitDbgEvent: (tabId, method, params) => listeners.dbgEvent.forEach((fn) => fn({ tabId }, method, params)),
    emitTabUpdated: (tabId, ch, tab) => listeners.tabUpdated.forEach((fn) => fn(tabId, ch, tab)),
    emitTabRemoved: (tabId) => listeners.tabRemoved.forEach((fn) => fn(tabId)),
    restoreGlobals: () => {
      for (const sb of tabSandboxes.values()) sb.close();
      globalThis.chrome = orig.chrome;
      globalThis.fetch = orig.fetch;
      globalThis.WebSocket = orig.WebSocket;
    }
  };
}

describe('extension MV3 (popup, content, background)', () => {
  it('popup.js gates enable button by consent, disables on sessionActive, and reverts on detach', async () => {
    const orig = { doc: globalThis.document, chrome: globalThis.chrome, URL: globalThis.URL, Blob: globalThis.Blob };
    let session = null;
    const permReqs = [],
      permRems = [];
    const env = makePopupEnv({
      tab: { id: 101, url: 'https://app.example.com/player' },
      onPermReq: (q) => {
        permReqs.push(q);
        return true;
      },
      onPermRem: (q) => {
        permRems.push(q);
        return true;
      },
      onMessage: async (msg) => {
        if (msg.type === 'get_status') return { ok: true, busConnected: true, port: 47921, tab: session };
        if (msg.type === 'authorize_tab') {
          session = { tabId: 101, debuggerAttached: true, url: msg.url, viewport: { width: 390, height: 844 } };
          return { ok: true, busConnected: true, tab: session };
        }
        if (msg.type === 'detach_tab') {
          session = null;
          return { ok: true };
        }
        if (msg.type === 'set_port') return { ok: true, port: msg.port, busConnected: true };
        if (msg.type === 'export_findings') return { ok: true, report: { findings: [{ id: 'F1' }] } };
        return { ok: true };
      }
    });
    globalThis.document = env.doc;
    globalThis.chrome = env.chromeMock;
    globalThis.Blob = class {
      constructor(parts) {
        this.parts = parts;
      }
    };
    globalThis.URL = class extends orig.URL {
      static createObjectURL() {
        return 'blob:mock-1';
      }
      static revokeObjectURL() {}
    };
    try {
      await import(`../packages/extension/popup.js?case=${++modSeq}`);
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(env.elems.enableBtn.disabled, true);
      assert.equal(env.elems.enableBtn.textContent, 'Habilitar permisos y arrancar enjambre');
      assert.equal(env.elems.detachBtn.disabled, true);

      env.elems.consentCheck.checked = true;
      await env.elems.consentCheck.trigger('change');
      assert.equal(env.elems.enableBtn.disabled, false);

      await env.elems.enableBtn.trigger('click');
      assert.deepEqual(permReqs, [{ origins: ['https://app.example.com/*'] }]);
      assert.equal(env.elems.enableBtn.disabled, true);
      assert.equal(env.elems.enableBtn.textContent, 'Sesión activa en esta pestaña');
      assert.equal(env.elems.detachBtn.disabled, false);
      assert.equal(env.elems.exportBtn.disabled, false);

      // Toggling consentCheck while sessionActive remains disabled
      env.elems.consentCheck.checked = false;
      await env.elems.consentCheck.trigger('change');
      assert.equal(env.elems.enableBtn.disabled, true);

      await env.elems.exportBtn.trigger('click');
      assert.equal(env.downloads[0]?.download, 'swarm-qa-findings-101.json');

      await env.elems.detachBtn.trigger('click');
      assert.deepEqual(permRems, [{ origins: ['https://app.example.com/*'] }]);
      assert.equal(env.elems.consentCheck.checked, false);
      assert.equal(env.elems.enableBtn.textContent, 'Habilitar permisos y arrancar enjambre');
      assert.equal(env.elems.enableBtn.disabled, true);
      assert.equal(env.elems.detachBtn.disabled, true);
    } finally {
      globalThis.document = orig.doc;
      globalThis.chrome = orig.chrome;
      globalThis.URL = orig.URL;
      globalThis.Blob = orig.Blob;
    }
  });

  it('content.js handles invalid selectors safely, honors fill clear:false + [redacted], deduplicates relative fetch URLs, and sanitizes bidi chars', () => {
    const c = makeContentSandbox({ initialUrl: 'http://localhost:5173/player', title: 'Sonora\u202E\x07App', width: 390, height: 844 });
    after(() => {
      if (openDoms.size) c.close();
    });
    const init = c.send({ type: 'init_overlay', nonce: 'n-1' });
    assert.equal(init.ok, true);
    assert.equal(/[\u202e\x07]/.test(init.title), false);
    assert.equal(c.getEl('__swarm_qa_overlay')?._shadowMode, 'closed');

    // Invalid CSS selector caught via try/catch; protected UI blocked
    const badSel = c.send({ type: 'resolve_rect', selector: '##broken' });
    assert.equal(badSel.ok, false);
    assert.match(badSel.error, /Invalid selector/i);
    assert.equal(c.send({ type: 'resolve_rect', selector: '#ag-btn' }).ok, false);

    // fill clear:false appends, default overwrites, password & hidden redact
    const appended = c.send({ type: 'fill_element', selector: '#note', value: ' world', clear: false });
    assert.equal(appended.ok, true);
    assert.equal(c.getEl('note').value, 'hello world');
    assert.equal(appended.value, 'hello world');

    c.send({ type: 'fill_element', selector: '#note', value: 'fresh' });
    assert.equal(c.getEl('note').value, 'fresh');

    const pwRes = c.send({ type: 'fill_element', selector: '#pw', value: 'Secret99!', clear: false });
    assert.equal(pwRes.sensitive, true);
    assert.equal(pwRes.value, '[redacted]');
    assert.equal(c.getEl('pw').value, 'oldpwSecret99!');

    // Overlay commands go through overlay.exec: pins are filtered by the tab's real viewport class; unknown commands fail closed
    const pinned = c.send({
      type: 'set_tickets',
      command: {
        pathname: '/player',
        tickets: [
          { id: 'T1', pathname: '/player', severity: 'P1', status: 'open', viewport: { width: 390, height: 844 } },
          { id: 'T2', pathname: '/player', severity: 'P2', status: 'open', viewport: { width: 1440, height: 900 } },
          { id: 'T3', pathname: '/other', severity: 'P2', status: 'open' }
        ]
      }
    });
    assert.deepEqual({ ok: pinned.ok, count: pinned.count, pins: pinned.pins }, { ok: true, count: 3, pins: 1 });
    assert.equal(c.send({ type: 'spawn_cursors', command: { cursors: [{ id: 'layout', label: 'Layout' }] } }).count, 1);
    assert.deepEqual([...c.send({ type: 'get_swarm_state' }).roles], ['layout']);
    assert.equal(c.send({ type: 'eval_script', command: { code: '1' } }).ok, false);

    // Deduplicate relative MAIN-world probe fetch (/api/play) vs full CDP URL (http://localhost:5173/api/play)
    const evCtor = c.sandbox.CustomEvent;
    c.win.dispatchEvent(new evCtor('__swarm_qa_probe_n-1', { detail: { kind: 'fetch', status: 503, url: '/api/play' } }));
    const audit = c.send({
      type: 'run_audit',
      command: { checks: ['console-net'], clearConsole: true },
      cdpLogs: [
        { kind: 'fetch', status: 503, url: 'http://localhost:5173/api/play' },
        { kind: 'console.error', message: 'Crash\u202E\x07' }
      ]
    });
    assert.equal(audit.findings.filter((f) => f.ruleId === 'console-net-5xx').length, 1);
    const errFinding = audit.findings.find((f) => f.ruleId === 'console-net-error');
    assert.equal(/[\u202e\x07]/.test(errFinding.actual), false);
    // clearConsole: true emptied consoleCollector
    const auditAfter = c.send({ type: 'run_audit', command: { checks: ['console-net'] }, cdpLogs: [] });
    assert.equal(auditAfter.findings.length, 0);
    c.close();
  });

  it('background.js rejects unpermitted cross-origin navigate, auto-detaches on unpermitted navigation, and resolves relative /path', async () => {
    const tmp = makeTempRegistry();
    const bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });
    const env = makeBackgroundEnv({
      registryPath: tmp.registryPath,
      initialTabs: [{ id: 101, url: 'http://localhost:5173/player' }],
      localStore: { swarmBusPort: bus.port }
    });
    try {
      const bg = await import(`../packages/extension/background.js?case=${++modSeq}`);
      assert.equal(await bg.hasHostPermission('http://localhost:5173/a'), true);
      assert.equal(await bg.hasHostPermission('http://127.0.0.1:8080/b'), true);
      assert.equal(await bg.hasHostPermission('https://localhost:5173/c'), false);
      assert.equal(await bg.hasHostPermission('https://evil.example/'), false);
      assert.equal(await bg.hasHostPermission('chrome://settings'), false);

      const auth = await env.callRuntime({ type: 'authorize_tab', tabId: 101, url: 'http://localhost:5173/player', probeEnabled: true });
      assert.equal(auth.ok, true);
      assert.equal(auth.busConnected, true);

      // Relative /path works on localhost
      const navOk = await bus.dispatchToTab(101, { action: 'navigate', url: '/albums' });
      assert.equal(navOk.navigated, true);
      assert.equal(navOk.pathname, '/albums');

      // Disallowed cross-origin & protocol rejected without Page.navigate
      const preNavCalls = env.cdpCalls.filter((c) => c.method === 'Page.navigate').length;
      await assert.rejects(
        () => bus.dispatchToTab(101, { action: 'navigate', url: 'https://evil.example/steal' }),
        /Permiso de origen no concedido/
      );
      await assert.rejects(
        () => bus.dispatchToTab(101, { action: 'navigate', url: '//evil.example/phish' }),
        /Permiso de origen no concedido/
      );
      await assert.rejects(() => bus.dispatchToTab(101, { action: 'navigate', url: 'javascript:alert(1)' }), /http\/https/i);
      assert.equal(env.cdpCalls.filter((c) => c.method === 'Page.navigate').length, preNavCalls);

      // Granted optional_host_permissions allows navigation
      env.granted.add('https://app.example.com/*');
      const navExt = await bus.dispatchToTab(101, { action: 'navigate', url: 'https://app.example.com/dash' });
      assert.equal(navExt.url, 'https://app.example.com/dash');

      // Revoke permission & simulate tab update -> auto-detaches debugger and emits tab_closed
      env.granted.delete('https://app.example.com/*');
      env.tabs.get(101).url = 'https://unpermitted.example/secret';
      env.emitTabUpdated(101, { status: 'complete' }, { id: 101, url: 'https://unpermitted.example/secret' });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(env.attached.has(101), false);
      assert.ok(env.detachCalls.includes(101));
      assert.ok(env.wsSent.some((m) => m.type === 'tab_closed' && m.tabId === 101));
    } finally {
      await env.callRuntime({ type: 'detach_tab', tabId: 101 });
      env.restoreGlobals();
      await bus.close();
      tmp.cleanup();
    }
  });

  it('background.js auto-reconnects when bus starts after authorizeTab, preserves WS across multi-tab detach, validates sender.tab, and clears cdpLogs', async () => {
    const tmp = makeTempRegistry('swarm-ext-multi-');
    const port = await getFreePort();
    const env = makeBackgroundEnv({
      registryPath: tmp.registryPath,
      initialTabs: [
        { id: 101, url: 'http://localhost:5173/one' },
        { id: 202, url: 'http://127.0.0.1:4173/two' }
      ],
      localStore: { swarmBusPort: port }
    });
    let bus;
    try {
      await import(`../packages/extension/background.js?case=${++modSeq}`);

      // Authorize tab 101 BEFORE bus starts -> triggers scheduleReconnect()
      const preAuth = await env.callRuntime({ type: 'authorize_tab', tabId: 101, url: 'http://localhost:5173/one', probeEnabled: true });
      assert.equal(preAuth.ok, true);
      assert.equal(preAuth.busConnected, false);

      // Start bus after authorization and await auto-reconnect hello
      bus = await startSwarmBus({ port, autoFallbackPort: false, registryPath: tmp.registryPath });
      const helloEv = await bus.waitForEvent(0, 4500);
      assert.equal(
        helloEv.events.some((e) => e.type === 'tab_hello' && e.tabId === 101),
        true
      );

      // Sender validation: reject privileged actions from sender.tab, allow overlay/route events
      for (const action of ['authorize_tab', 'detach_tab', 'set_port', 'export_findings']) {
        const res = await env.callRuntime({ type: action, tabId: 101 }, { tab: { id: 101 } });
        assert.equal(res.ok, false);
        assert.match(res.error, /Forbidden from content script/);
      }
      const routeOk = await env.callRuntime(
        {
          type: 'route_changed',
          tabId: 999,
          url: 'http://localhost:5173/two',
          pathname: '/two',
          title: 'Two',
          viewport: { width: 390, height: 844 }
        },
        { tab: { id: 101 } }
      );
      assert.equal(routeOk.ok, true);
      assert.equal((await env.callRuntime({ type: 'get_status', tabId: 101 })).tab.pathname, '/two');

      // Authorize tab 202 on same WS, then detach tab 101 -> tab 202 stays operational!
      await env.callRuntime({ type: 'authorize_tab', tabId: 202, url: 'http://127.0.0.1:4173/two' });
      await env.callRuntime({ type: 'detach_tab', tabId: 101 });
      assert.ok(env.wsSent.some((m) => m.type === 'tab_closed' && m.tabId === 101));
      const audit202 = await bus.dispatchToTab(202, { action: 'run_audit', checks: ['overflow'] });
      assert.equal(audit202.ok, true);

      // fill clear:false & password [redacted] over bus
      const fillAppend = await bus.dispatchToTab(202, { action: 'fill', selector: '#note', value: '!', clear: false });
      assert.equal(fillAppend.value, 'hello!');
      const fillSecret = await bus.dispatchToTab(202, { action: 'fill', selector: '#pw', value: 'Secret!', clear: false });
      assert.equal(fillSecret.value, '[redacted]');

      // cdpLogs populated & cleared by get_console_network({ clear: true }), run_audit({ clearConsole: true }), and tabs.onUpdated loading
      env.emitDbgEvent(202, 'Network.responseReceived', { response: { status: 500, url: '/api/err' } });
      const logs1 = await bus.dispatchToTab(202, { action: 'get_console_network', clear: true });
      assert.equal(logs1.entries.length, 1);
      assert.equal(logs1.entries[0].url, 'http://127.0.0.1:4173/api/err');
      assert.equal((await bus.dispatchToTab(202, { action: 'get_console_network' })).entries.length, 0);

      env.emitDbgEvent(202, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'bad' }] });
      const logsAudit = await bus.dispatchToTab(202, { action: 'run_audit', checks: ['console-net'], clearConsole: true });
      assert.equal(logsAudit.findings.length, 1);
      assert.equal((await bus.dispatchToTab(202, { action: 'get_console_network' })).entries.length, 0);

      env.emitDbgEvent(202, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'stale' }] });
      env.emitTabUpdated(202, { status: 'loading', url: 'http://127.0.0.1:4173/next' }, { id: 202, url: 'http://127.0.0.1:4173/next' });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal((await bus.dispatchToTab(202, { action: 'get_console_network' })).entries.length, 0);

      await env.callRuntime({ type: 'detach_tab', tabId: 202 });
    } finally {
      await env.callRuntime({ type: 'detach_tab', tabId: 101 });
      await env.callRuntime({ type: 'detach_tab', tabId: 202 });
      env.restoreGlobals();
      if (bus) await bus.close();
      tmp.cleanup();
    }
  });

  it('background.js recovers permitted tabs and detaches orphaned unpermitted tabs from chrome.storage.session on SW restart', async () => {
    const tmp = makeTempRegistry('swarm-ext-sw-');
    const bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });
    const env = makeBackgroundEnv({
      registryPath: tmp.registryPath,
      initialTabs: [
        { id: 301, url: 'http://localhost:5173/recovered' },
        { id: 302, url: 'https://unpermitted.example/moved' }
      ],
      localStore: { swarmBusPort: bus.port },
      sessionStore: {
        swarmAuthorizedTabs: [
          { tabId: 301, url: 'http://localhost:5173/recovered', probeEnabled: true },
          { tabId: 302, url: 'http://localhost:5173/before', probeEnabled: false }
        ]
      }
    });
    env.attached.add(301);
    env.attached.add(302);
    try {
      await import(`../packages/extension/background.js?case=${++modSeq}`);
      const st301 = await env.callRuntime({ type: 'get_status', tabId: 301 });
      assert.equal(st301.tab?.tabId, 301);
      assert.equal(st301.tab?.debuggerAttached, true);
      assert.equal(st301.busConnected, true);

      const st302 = await env.callRuntime({ type: 'get_status', tabId: 302 });
      assert.equal(st302.tab, null);
      assert.ok(env.detachCalls.includes(302));
      assert.deepEqual(
        env.sessionData.get('swarmAuthorizedTabs').map((t) => t.tabId),
        [301]
      );

      await env.callRuntime({ type: 'detach_tab', tabId: 301 });
    } finally {
      await env.callRuntime({ type: 'detach_tab', tabId: 301 });
      env.restoreGlobals();
      await bus.close();
      tmp.cleanup();
    }
  });
});
