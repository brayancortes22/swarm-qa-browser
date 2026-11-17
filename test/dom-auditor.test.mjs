import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { sanitizeText, isSensitiveElement, buildSelector, runDomAudit } from '../packages/overlay/src/dom-auditor.js';
import { createIssuePins } from '../packages/overlay/src/issue-pins.js';
import { createCursorLayer } from '../packages/overlay/src/cursor-layer.js';
import { MAIN_WORLD_PROBE_SOURCE } from '../packages/overlay/src/network-console.js';
import { mountSwarmOverlay } from '../packages/overlay/src/overlay-entry.js';

function el(tag, { id = '', attrs = {}, text = '', rect = { x: 0, y: 0, width: 100, height: 48 }, style = {}, children = [], ...rest } = {}) {
  const node = {
    tagName: tag.toUpperCase(), id, type: attrs.type ?? rest.type, value: rest.value ?? '',
    hidden: Boolean(rest.hidden), alt: attrs.alt ?? '', htmlFor: attrs.for ?? '',
    complete: rest.complete ?? false, naturalWidth: rest.naturalWidth ?? 0,
    scrollWidth: rest.scrollWidth ?? rect.width, clientWidth: rest.clientWidth ?? rect.width,
    clientHeight: rest.clientHeight ?? rect.height, style: { ...style }, children, parentElement: null,
    dataset: {}, classList: { toggle: () => false },
    get textContent() { return text + children.map((c) => c.textContent || '').join(''); },
    set textContent(v) { text = String(v ?? ''); children.length = 0; },
    getAttribute(n) { return n === 'id' ? (id || null) : n === 'style' ? (rest.styleAttr ?? null) : (Object.hasOwn(attrs, n) ? attrs[n] : null); },
    setAttribute(k, v) { if (k === 'class') node.className = v; else attrs[k] = v; },
    hasAttribute: (n) => (n === 'id' ? Boolean(id) : Object.hasOwn(attrs, n)),
    contains: (other) => children.some((c) => c === other || c.contains(other)),
    appendChild(c) { c.parentElement = node; children.push(c); return c; },
    addEventListener: () => {}, replaceChildren: () => { children.length = 0; }, remove: () => {},
    getBoundingClientRect: () => ({ left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, ...rect })
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function makeDoc(bodyChildren, rootOverrides = {}) {
  const body = el('body', { children: bodyChildren, rect: { x: 0, y: 0, width: 390, height: 844 } });
  const html = el('html', { children: [body], rect: { x: 0, y: 0, width: 390, height: 844 }, ...rootOverrides });
  const win = { innerWidth: 390, innerHeight: 844, getComputedStyle: (n) => ({ display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', ...n.style }) };
  return { doc: { documentElement: html, body }, win };
}

test('sanitizeText strips control/bidi chars, truncates to 280, and isSensitiveElement detects password/hidden', () => {
  const clean = sanitizeText('Hello\x00 \x1b[31mworld\u202E\u200B\n' + 'x'.repeat(300), 280);
  assert.equal(clean.length <= 280, true);
  assert.equal(/[\x00-\x1f\u202e\u200b]/.test(clean), false);
  assert.equal(clean.startsWith('Hello world'), true);
  assert.equal(isSensitiveElement(el('input', { attrs: { type: 'password' } })), true);
  assert.equal(isSensitiveElement(el('input', { attrs: { type: 'hidden' } })), true);
  assert.equal(isSensitiveElement(el('input', { attrs: { type: 'email' } })), false);
  assert.equal(buildSelector(el('button', { id: 'pay-btn' })), '#pay-btn');
});

test('overflow check flags document and non-scrollable container overflow while ignoring auto scroll', () => {
  const badBox = el('div', { id: 'wide-card', clientWidth: 300, scrollWidth: 360 });
  const okBox = el('div', { id: 'scroll-card', clientWidth: 300, scrollWidth: 450, style: { overflowX: 'auto' } });
  const { doc, win } = makeDoc([badBox, okBox], { clientWidth: 390, scrollWidth: 430 });
  const findings = runDomAudit({ doc, win, checks: ['overflow'], viewport: { width: 390, height: 844 } });
  assert.equal(findings.length, 2);
  assert.equal(findings.every((f) => f.category === 'overflow' && f.untrustedPageData === true), true);
});

test('overlap check detects >4px collision on both axes and ignores ancestor-descendant pairs', () => {
  const labelA = el('span', { id: 'a', text: 'Track', rect: { x: 10, y: 10, width: 100, height: 24 } });
  const labelB = el('span', { id: 'b', text: 'Artist', rect: { x: 90, y: 20, width: 100, height: 24 } });
  const parent = el('div', { id: 'wrap', rect: { x: 10, y: 10, width: 200, height: 60 }, children: [labelA, labelB] });
  const touch = el('span', { id: 'c', text: 'Ok', rect: { x: 186, y: 20, width: 60, height: 24 } });
  const { doc, win } = makeDoc([parent, touch]);
  const findings = runDomAudit({ doc, win, checks: ['overlap'], viewport: { width: 390, height: 844 } });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'overlap');
  assert.match(findings[0].selector, /#(a|b)/);
});

test('a11y check detects unnamed buttons/inputs and redacts password values', () => {
  const badBtn = el('button', { id: 'icon-btn', text: '' });
  const okBtn = el('button', { id: 'ok-btn', attrs: { 'aria-label': 'Play' } });
  const badLink = el('a', { id: 'empty-link', attrs: { href: '/home' }, text: '' });
  const secretInput = el('input', { id: 'pw', attrs: { type: 'password' }, value: 'SuperSecret123!' });
  const okInput = el('input', { id: 'search', attrs: { type: 'text', placeholder: 'Search' } });
  const wrapped = el('label', { text: 'Name', children: [el('input', { id: 'nm', attrs: { type: 'text' } })] });
  const lbl = el('label', { text: 'Email', attrs: { for: 'email-in' } });
  const emailIn = el('input', { id: 'email-in', attrs: { type: 'email' } });
  const { doc, win } = makeDoc([badBtn, okBtn, badLink, secretInput, okInput, wrapped, lbl, emailIn]);
  const findings = runDomAudit({ doc, win, checks: ['a11y'], viewport: { width: 1440, height: 900 } });
  assert.equal(findings.length, 3);
  const serialized = JSON.stringify(findings);
  assert.equal(serialized.includes('SuperSecret123!'), false);
  assert.equal(serialized.includes('[redacted]'), true);
});

test('media and tap-target checks flag broken images and <44px mobile controls only at <=480px', () => {
  const brokenImg = el('img', { id: 'cover', attrs: { src: '/bad.png' }, complete: true, naturalWidth: 0 });
  const okImg = el('img', { id: 'ok-cover', attrs: { src: '/ok.png' }, complete: true, naturalWidth: 200 });
  const smallBtn = el('button', { id: 'tiny', text: 'X', rect: { x: 10, y: 10, width: 32, height: 32 } });
  const bigBtn = el('button', { id: 'big', text: 'Play', rect: { x: 60, y: 10, width: 48, height: 48 } });
  const { doc, win } = makeDoc([brokenImg, okImg, smallBtn, bigBtn]);
  const mobile = runDomAudit({ doc, win, checks: ['media', 'tap-target'], viewport: { width: 390, height: 844 } });
  assert.equal(mobile.filter((f) => f.category === 'media').length, 1);
  assert.equal(mobile.filter((f) => f.category === 'tap-target').length, 1);
  assert.equal(runDomAudit({ doc, win, checks: ['tap-target'], viewport: { width: 1440, height: 900 } }).length, 0);
});

test('console-net maps severities and auditor ignores overlay/hidden/zero-opacity subtrees', () => {
  const overlay = el('div', { id: '__swarm_qa_overlay', children: [el('button', { id: 'ov-btn', rect: { x: 0, y: 0, width: 20, height: 20 } })] });
  const nativeUi = el('div', { id: '__antigravity_native_browser_ui', children: [el('button', { id: 'ag-btn' })] });
  const hiddenBtn = el('button', { id: 'hid', styleAttr: 'display:none', rect: { x: 0, y: 0, width: 20, height: 20 } });
  const zeroOp = el('img', { id: 'inv', style: { opacity: '0' }, complete: true, naturalWidth: 0 });
  const { doc, win } = makeDoc([overlay, nativeUi, hiddenBtn, zeroOp]);
  const entries = [
    { kind: 'unhandledrejection', message: 'Boom\u202E\x07' },
    { kind: 'fetch', status: 503, url: '/api/play' },
    { kind: 'error', source: 'app.js', line: 12, message: 'Uncaught crash' },
    { kind: 'fetch', status: 404, url: '/api/missing' },
    { kind: 'console.error', message: 'Failed render' }
  ];
  const findings = runDomAudit({ doc, win, viewport: { width: 390, height: 844 }, consoleEntries: entries });
  assert.equal(findings.filter((f) => f.category !== 'console-net').length, 0);
  const net = findings.filter((f) => f.category === 'console-net');
  assert.deepEqual(net.map((f) => f.severity), ['P1', 'P1', 'P1', 'P2', 'P2']);
  assert.equal(/[\u202e\x07]/.test(net[0].description), false);
});

test('mountSwarmOverlay isolates closed shadow root, omits window leak, and tracks SPA routes', async () => {
  const { mountSwarmOverlay } = await import('../packages/overlay/src/overlay-entry.js');
  const { doc, win } = makeDoc([el('button', { id: 'go', text: '' })]);
  let path = '/home';
  const events = [];
  doc.defaultView = win;
  doc.createElement = (t) => {
    const n = el(t);
    n.attachShadow = (o) => { n._shadowMode = o.mode; const s = el('shadow'); s.ownerDocument = doc; return s; };
    return n;
  };
  win.location = { get pathname() { return path; } };
  win.history = { pushState: (_, __, url) => { path = url; }, replaceState: () => {} };
  win.addEventListener = () => {};
  win.removeEventListener = () => {};
  const ctrl = mountSwarmOverlay({ doc, win, nonce: 'n1', onEvent: (e) => events.push(e) });
  assert.equal('__swarmQaOverlayFactory' in win, false);
  const host = doc.documentElement.children.find((c) => c.id === '__swarm_qa_overlay');
  assert.equal(host._shadowMode, 'closed');
  ctrl.spawnCursors([{ id: 'layout', label: 'Layout', color: '#0D99FF', x: 10, y: 20 }]);
  ctrl.setTickets([{ id: 't1', pathname: '/albums', severity: 'P1', status: 'open', rect: { x: 4, y: 4, width: 20, height: 20 } }]);
  win.history.pushState({}, '', '/albums');
  assert.equal(ctrl.getRoute(), '/albums');
  assert.equal(events.some((e) => e.type === 'route_change' && e.pathname === '/albums'), true);
  assert.equal(ctrl.runAudit({ viewport: { width: 390, height: 844 } }).findings.some((f) => f.category === 'a11y'), true);
  ctrl.destroy();
});

test('isVisible never passes #document (nodeType 9) to window.getComputedStyle', () => {
  const btn = el('button', { id: 'ok', text: '' });
  const { doc, win } = makeDoc([btn]);
  doc.nodeType = 9;
  doc.nodeName = '#document';
  doc.documentElement.nodeType = 1;
  doc.documentElement.parentNode = doc;
  doc.body.nodeType = 1;
  btn.nodeType = 1;
  win.getComputedStyle = (node) => {
    if (node?.nodeType !== 1) throw new TypeError("Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.");
    return {};
  };
  const findings = runDomAudit({ doc, win, checks: ['a11y'], viewport: { width: 1440, height: 900 } });
  assert.equal(findings.some((f) => f.selector === '#ok'), true);
});

test('dom-auditor ignores CSS ellipsis truncation, catches real overflow, and escapes special selector IDs', () => {
  const truncHidden = el('div', { id: 'trunc-h', clientWidth: 180, scrollWidth: 260, style: { overflowX: 'hidden', textOverflow: 'ellipsis' } });
  const truncClip = el('div', { id: 'trunc-c', clientWidth: 180, scrollWidth: 260, style: { overflowX: 'clip', textOverflow: 'ellipsis' } });
  const realHidden = el('div', { id: 'clip-bad', clientWidth: 180, scrollWidth: 260, style: { overflowX: 'hidden' } });
  const { doc, win } = makeDoc([truncHidden, truncClip, realHidden], { clientWidth: 390, scrollWidth: 390 });
  const findings = runDomAudit({ doc, win, checks: ['overflow'], viewport: { width: 390, height: 844 } });
  assert.deepEqual(findings.map((f) => f.selector), ['#clip-bad']);
  assert.equal(buildSelector(el('div', { id: 'sec.1:2' })), '#sec\\.1\\:2');
  assert.equal(buildSelector(el('button', { attrs: { 'data-testid': 'pay:btn"1' } })), 'button[data-testid="pay\\:btn\\"1"]');
});

test('issue-pins sets untruncated CSS including .swarm-hud, strips bidi chars, and scopes pins by viewport bucket', () => {
  const { doc } = makeDoc([]);
  doc.createElement = (t) => el(t);
  const shadow = el('shadow');
  shadow.ownerDocument = doc;
  const pins = createIssuePins(shadow);
  const styleEl = shadow.children.find((c) => c.tagName === 'STYLE');
  assert.equal(styleEl.textContent.includes('.swarm-hud'), true);
  assert.equal(styleEl.textContent.includes('.swarm-hud.is-collapsed'), true);
  assert.equal(styleEl.textContent.length > 280, true);

  const layer = shadow.children.find((c) => c.className === 'swarm-pins-layer');
  const tickets = [
    { id: 't-\u202E1\u200B', pathname: '/home', severity: 'P1', status: 'open', viewport: { width: 390, height: 844 } },
    { id: 't-desktop', pathname: '/home', severity: 'P2', status: 'open', viewport: { width: 1440, height: 900 } },
    { id: 't-laptop', pathname: '/home', severity: 'P3', status: 'open', viewport: { width: 1280, height: 800 } },
    { id: 't-tablet', pathname: '/home', severity: 'P2', status: 'open', viewport: { width: 768, height: 1024 } },
    { id: 't-any', pathname: '/home', severity: 'P2', status: 'open' }
  ];
  pins.setTickets(tickets, '/home', 1440);
  assert.deepEqual(layer.children.map((c) => c.getAttribute('data-ticket-id')), ['t-desktop', 't-laptop', 't-tablet', 't-any']);
  pins.setTickets(tickets, '/home', 390);
  assert.deepEqual(layer.children.map((c) => c.getAttribute('data-ticket-id')), ['t-1', 't-any']);
  pins.destroy();
});

test('cursor-layer preserves (x, y) on status-only updates and strips bidi/zero-width chars', () => {
  const { doc } = makeDoc([]);
  doc.createElement = (t) => el(t);
  const shadow = el('shadow');
  shadow.ownerDocument = doc;
  const layerApi = createCursorLayer(shadow);
  layerApi.upsertCursor({ id: 'layout', label: 'Layout\u202E\u200B', color: '#38BDF8', x: 150, y: 240, status: 'Listo' });
  layerApi.upsertCursor({ id: 'layout', status: 'Auditando\u200B' });
  const layer = shadow.children.find((c) => c.className === 'swarm-cursor-layer');
  const cursor = layer.children[0];
  assert.equal(cursor.style.transform, 'translate3d(150px, 240px, 0)');
  const [pill] = cursor.children.filter((c) => c.className === 'swarm-cursor-pill');
  const [, labelEl, statusEl] = pill.children;
  assert.equal(labelEl.textContent, 'Layout');
  assert.equal(statusEl.textContent, 'Auditando');
});

test('network probe normalizes fetch URLs and overlay-entry supports clearConsole, runAudit clearConsole, and viewport pin filtering', async () => {
  const dispatched = [];
  const winCtx = {
    location: { href: 'http://localhost:5173/albums' },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent: (ev) => dispatched.push(ev),
    addEventListener: () => {},
    console: { error: () => {} },
    fetch: async () => ({ status: 500, ok: false }),
    URL
  };
  winCtx.window = winCtx;
  vm.runInNewContext(MAIN_WORLD_PROBE_SOURCE('nonce1'), winCtx);
  await winCtx.fetch('/api/tracks');
  assert.equal(dispatched[0]?.detail?.url, 'http://localhost:5173/api/tracks');

  const { doc, win } = makeDoc([]);
  let path = '/home';
  const listeners = new Map();
  doc.defaultView = win;
  let shadowRef = null;
  doc.createElement = (t) => {
    const n = el(t);
    n.attachShadow = () => { const s = el('shadow'); s.ownerDocument = doc; shadowRef = s; return s; };
    return n;
  };
  win.innerWidth = 390;
  win.location = { get pathname() { return path; } };
  win.history = { pushState: (_, __, url) => { path = url; }, replaceState: () => {} };
  win.addEventListener = (k, fn) => listeners.set(k, fn);
  win.removeEventListener = (k) => listeners.delete(k);

  const ctrl = mountSwarmOverlay({ doc, win, nonce: 'n2', clearConsoleOnRouteChange: true });
  listeners.get('__swarm_qa_probe_n2')({ detail: { kind: 'fetch', status: 500, url: 'http://localhost:5173/api/fail' } });
  assert.equal(ctrl.runAudit({ clearConsole: true }).findings.some((f) => f.category === 'console-net'), true);
  assert.equal(ctrl.runAudit().findings.some((f) => f.category === 'console-net'), false);

  listeners.get('__swarm_qa_probe_n2')({ detail: { kind: 'console.error', message: 'Stale error' } });
  ctrl.clearConsole();
  assert.equal(ctrl.runAudit().findings.some((f) => f.category === 'console-net'), false);

  listeners.get('__swarm_qa_probe_n2')({ detail: { kind: 'console.error', message: 'Pre-route error' } });
  win.history.pushState({}, '', '/next');
  assert.equal(ctrl.runAudit().findings.some((f) => f.category === 'console-net'), false);

  ctrl.setTickets([
    { id: 'm1', pathname: '/next', severity: 'P1', status: 'open', viewport: { width: 390, height: 844 } },
    { id: 'd1', pathname: '/next', severity: 'P1', status: 'open', viewport: { width: 1440, height: 900 } }
  ]);
  const pinsLayer = shadowRef.children.find((c) => c.className === 'swarm-pins-layer');
  assert.deepEqual(pinsLayer.children.map((c) => c.getAttribute('data-ticket-id')), ['m1']);
  ctrl.destroy();
});
