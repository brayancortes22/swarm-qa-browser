import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText, isSensitiveElement, buildSelector, runDomAudit } from '../packages/overlay/src/dom-auditor.js';

function el(
  tag,
  { id = '', attrs = {}, text = '', rect = { x: 0, y: 0, width: 100, height: 48 }, style = {}, children = [], ...rest } = {}
) {
  const node = {
    tagName: tag.toUpperCase(),
    id,
    type: attrs.type ?? rest.type,
    value: rest.value ?? '',
    hidden: Boolean(rest.hidden),
    alt: attrs.alt ?? '',
    htmlFor: attrs.for ?? '',
    complete: rest.complete ?? false,
    naturalWidth: rest.naturalWidth ?? 0,
    scrollWidth: rest.scrollWidth ?? rect.width,
    clientWidth: rest.clientWidth ?? rect.width,
    clientHeight: rest.clientHeight ?? rect.height,
    style: { ...style },
    children,
    parentElement: null,
    dataset: {},
    classList: { toggle: () => false },
    get textContent() {
      return text + children.map((c) => c.textContent || '').join('');
    },
    set textContent(v) {
      text = String(v ?? '');
      children.length = 0;
    },
    getAttribute(n) {
      return n === 'id' ? id || null : n === 'style' ? (rest.styleAttr ?? null) : Object.hasOwn(attrs, n) ? attrs[n] : null;
    },
    setAttribute(k, v) {
      if (k === 'class') node.className = v;
      else attrs[k] = v;
    },
    hasAttribute: (n) => (n === 'id' ? Boolean(id) : Object.hasOwn(attrs, n)),
    contains: (other) => children.some((c) => c === other || c.contains(other)),
    appendChild(c) {
      c.parentElement = node;
      children.push(c);
      return c;
    },
    addEventListener: () => {},
    replaceChildren: () => {
      children.length = 0;
    },
    remove: () => {},
    getBoundingClientRect: () => ({ left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, ...rect })
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function makeDoc(bodyChildren, rootOverrides = {}) {
  const body = el('body', { children: bodyChildren, rect: { x: 0, y: 0, width: 390, height: 844 } });
  const html = el('html', { children: [body], rect: { x: 0, y: 0, width: 390, height: 844 }, ...rootOverrides });
  const win = {
    innerWidth: 390,
    innerHeight: 844,
    getComputedStyle: (n) => ({ display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', ...n.style })
  };
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
  assert.equal(
    findings.every((f) => f.category === 'overflow' && f.untrustedPageData === true),
    true
  );
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
  const overlay = el('div', {
    id: '__swarm_qa_overlay',
    children: [el('button', { id: 'ov-btn', rect: { x: 0, y: 0, width: 20, height: 20 } })]
  });
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
  assert.deepEqual(
    net.map((f) => f.severity),
    ['P1', 'P1', 'P1', 'P2', 'P2']
  );
  assert.equal(/[\u202e\x07]/.test(net[0].description), false);
});
