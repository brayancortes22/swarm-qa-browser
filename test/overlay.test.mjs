import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createTestDom } from './helpers/test-dom.mjs';
import { scanLayers } from '../packages/overlay/src/layers.js';
import { MAIN_WORLD_PROBE_SOURCE } from '../packages/overlay/src/network-console.js';
import { mountSwarmOverlay, OVERLAY_ACTIONS } from '../packages/overlay/src/overlay.js';
import { createPatchManager } from '../packages/overlay/src/patches.js';
import { arcPoint, createRng, flightDuration, inkFor } from '../packages/overlay/src/physics.js';
import { createStyleVault } from '../packages/overlay/src/style-vault.js';

const PAGE = `
  <header id="nav" style="background-color: rgb(255, 255, 255);"><a id="brand" href="/">Lumen</a></header>
  <h1 id="title">Entiende tu <em>producto</em></h1>
  <img id="hero" src="hero.png" alt="Panel">
  <div id="wrap"><p id="copy" style="visibility: visible;">Texto de prueba</p></div>
  <input id="email" type="email">
  <div id="tags" style="background-color: rgb(240, 240, 240);"><span>a</span></div>
  <p id="ghost" style="display: none;">oculto</p>
  <button id="icon-btn" class="cart"></button>`;
const RECTS = Object.fromEntries(
  ['nav', 'brand', 'title', 'hero', 'copy', 'email', 'tags', 'icon-btn'].map((id, i) => [
    id,
    { x: 20, y: 20 + i * 60, width: 200, height: 40 }
  ])
);

const doms = new Set();
after(() => {
  for (const dom of doms) dom.close();
});
function page(options = {}) {
  const dom = createTestDom({ url: 'http://localhost:5173/home', width: 1280, height: 800, body: PAGE, rects: RECTS, ...options });
  doms.add(dom);
  return dom;
}
const until = async (predicate, ms = 4000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('physics helpers are bounded, deterministic and hit their endpoints', () => {
  assert.equal(flightDuration(0), 220);
  assert.equal(flightDuration(100000), 880);
  const from = { x: 10, y: 20 };
  const to = { x: 300, y: 400 };
  assert.deepEqual(arcPoint(from, to, 0.3, 0), from);
  assert.deepEqual(arcPoint(from, to, 0.3, 1), to);
  assert.notDeepEqual(arcPoint(from, to, 0.3, 0.5), arcPoint(from, to, 0, 0.5));
  const a = createRng(42);
  const b = createRng(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.equal(inkFor('#FFC700'), '#0b0c10');
  assert.equal(inkFor('#4F6BFF'), '#ffffff');
});

test('scanLayers classifies painted layers in document order and skips hidden or unpainted nodes', () => {
  const { doc, win } = page();
  const layers = scanLayers({ doc, win }).map((layer) => `${layer.el.id}:${layer.kind}`);
  assert.deepEqual(layers, ['nav:box', 'brand:text', 'title:text', 'hero:media', 'copy:text', 'email:control', 'tags:box', 'icon-btn:box']);
  assert.equal(scanLayers({ doc, win, max: 2 }).length, 2);
});

test('style vault restores the exact original inline value and priority', () => {
  const { doc } = page();
  const vault = createStyleVault();
  const copy = doc.getElementById('copy');
  const title = doc.getElementById('title');
  vault.set(copy, 'visibility', 'hidden');
  vault.set(copy, 'visibility', 'visible');
  vault.set(title, 'clip-path', 'inset(0 100% 100% 0)');
  assert.equal(copy.style.getPropertyPriority('visibility'), 'important');
  vault.restoreAll();
  assert.equal(copy.getAttribute('style'), 'visibility: visible;');
  assert.equal(title.hasAttribute('style'), false, 'no empty style attribute is left behind');
  assert.equal(vault.size, 0);
});

test('patch manager applies validated, reversible patches and rejects anything executable', () => {
  const { doc } = page();
  const patches = createPatchManager(doc);
  const tags = doc.getElementById('tags');
  assert.equal(
    patches.apply({
      id: 'p-1',
      type: 'css',
      selector: '#tags',
      declarations: { 'max-width': '100%', 'overflow-x': 'auto', 'background-image': 'url(x) } body { display: none' }
    }),
    true
  );
  assert.equal(tags.style.getPropertyValue('overflow-x'), 'auto');
  assert.equal(tags.style.backgroundImage, '');
  assert.equal(patches.apply({ id: 'p-2', type: 'attr', selector: '#icon-btn', attr: { name: 'aria-label', value: 'Ver carrito' } }), true);
  assert.equal(doc.getElementById('icon-btn').getAttribute('aria-label'), 'Ver carrito');
  assert.equal(patches.apply({ id: 'p-3', type: 'attr', selector: '#icon-btn', attr: { name: 'onclick', value: 'alert(1)' } }), false);
  assert.equal(patches.apply({ id: 'p-4', type: 'css', selector: '#missing', declarations: { color: 'red' } }), false);
  assert.equal(patches.apply({ id: 'p-5', type: 'css', selector: 'a{} body{display:none}', declarations: { color: 'red' } }), false);
  assert.equal(patches.apply({ id: '../x', type: 'css', selector: '#tags', declarations: { color: 'red' } }), false);
  patches.revertAll();
  assert.equal(tags.getAttribute('style'), 'background-color: rgb(240, 240, 240);');
  assert.equal(doc.getElementById('icon-btn').hasAttribute('aria-label'), false);
});

test('MAIN-world probe forwards failed fetches with absolute URLs under its nonce', async () => {
  const dispatched = [];
  const ctx = {
    location: { href: 'http://localhost:5173/albums' },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    dispatchEvent: (ev) => dispatched.push(ev),
    addEventListener: () => {},
    console: { error: () => {} },
    fetch: async () => ({ status: 500, ok: false }),
    URL
  };
  ctx.window = ctx;
  vm.runInNewContext(MAIN_WORLD_PROBE_SOURCE('nonce1'), ctx);
  await ctx.fetch('/api/tracks');
  assert.equal(dispatched[0].type, '__swarm_qa_probe_nonce1');
  assert.equal(dispatched[0].detail.url, 'http://localhost:5173/api/tracks');
});

test('overlay mounts in a closed shadow root, drives role cursors, pins and swarm config, and fails closed on unknown commands', async () => {
  const dom = page();
  const { doc, win, shadows } = dom;
  const events = [];
  const overlay = mountSwarmOverlay({ doc, win, nonce: 'n1', swarm: { agents: 3 }, onEvent: (e) => events.push(e) });
  const host = doc.getElementById('__swarm_qa_overlay');
  assert.equal(host._shadowMode, 'closed');
  assert.equal(host.shadowRoot, null);
  assert.equal('__swarmQaOverlayFactory' in win, false);
  const shadow = shadows.at(-1);
  assert.equal(shadow.querySelectorAll('.sw-cursor').length, 3);

  assert.deepEqual(overlay.exec('eval_script', { code: 'alert(1)' }), { ok: false, error: 'Unknown overlay command "eval_script"' });
  assert.equal(OVERLAY_ACTIONS.includes('start_tour'), true);

  assert.equal(
    overlay.exec('spawn_cursors', { cursors: [{ id: 'layout', label: 'Layout‮\x07', color: 'red; background:url(x)', x: 10, y: 10 }] })
      .count,
    1
  );
  const role = shadow.querySelector('[data-cursor-id="layout"]');
  assert.equal(role.hasAttribute('data-tag'), true);
  assert.equal(/[‮\x07]/.test(role.textContent), false);
  assert.match(role.querySelector('.sw-tag').style.background, /^rgb\(\d+, \d+, \d+\)$/, 'unsafe colors fall back to a palette color');
  overlay.exec('move_cursor', { id: 'layout', selector: '#title', status: 'Auditando' });
  assert.equal(role.querySelector('.sw-tag-status').textContent, 'Auditando');
  assert.equal(shadow.querySelectorAll('.sw-sel').length, 1);
  await until(() => role.style.transform.startsWith('translate3d(120px, 160px'));
  assert.equal(overlay.exec('trigger_click', { id: 'layout' }).ok, true);
  assert.equal(overlay.exec('remove_cursor', { id: 'layout' }).ok, true);
  assert.equal(shadow.querySelector('[data-cursor-id="layout"]'), null);

  assert.equal(overlay.exec('configure_swarm', { agents: 99, speed: 4 }).workers, 32);
  assert.equal(overlay.exec('configure_swarm', { agents: 2 }).workers, 2);
  assert.equal(overlay.getState().speed, 4);

  const tickets = [
    { id: 'T-1', severity: 'P1', status: 'open', pathname: '/home', selector: '#title', description: '<img src=x onerror=alert(1)>' },
    { id: 'T-2', severity: 'P2', status: 'verified', pathname: '/home', selector: '#email', viewport: { width: 390 } },
    { id: 'T-3', severity: 'P3', status: 'open', pathname: '/other' }
  ];
  assert.deepEqual(overlay.exec('set_tickets', { tickets, pathname: '/home' }), { ok: true, count: 3, pins: 1 });
  shadow.querySelector('.sw-pin').click();
  assert.equal(shadow.querySelector('.sw-pop-title').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(shadow.querySelector('.sw-pop img'), null);
  assert.equal(events.at(-1).type, 'ticket_selected');
  assert.equal(shadow.querySelector('.sw-hud-stats').textContent, 'Abiertos 2Verificados 1');

  win.history.pushState({}, '', '/other');
  await until(() => events.some((e) => e.type === 'route_change' && e.pathname === '/other'));
  assert.equal(shadow.querySelectorAll('.sw-pin').length, 1);

  // Mission log: orchestrator instructions and agent reports, always rendered as text.
  assert.equal(shadow.querySelector('.sw-feed').hasAttribute('data-on'), false);
  assert.equal(overlay.exec('post_message', { from: 'Orquestador', kind: 'instruction', text: 'Auditad <b>todo</b>\u202E' }).ok, true);
  assert.equal(overlay.exec('post_message', { from: 'Layout', kind: 'report', text: '' }).ok, false);
  const entry = shadow.querySelector('.sw-feed-item');
  assert.deepEqual(
    [entry.dataset.kind, entry.querySelector('.sw-feed-text').textContent, entry.querySelector('b')],
    ['instruction', 'Auditad <b>todo</b>', null]
  );
  assert.equal(overlay.exec('clear_messages').ok, true);
  assert.equal(shadow.querySelectorAll('.sw-feed-item').length, 0);

  overlay.destroy();
  assert.equal(doc.getElementById('__swarm_qa_overlay'), null);
  assert.deepEqual(overlay.exec('get_swarm_state'), { ok: false, error: 'Overlay destroyed' });
});

test('tour hides every layer, rebuilds them all, and leaves the page byte-identical (also when stopped midway)', async () => {
  const dom = page();
  const { doc, win } = dom;
  const before = doc.body.innerHTML;
  const events = [];
  const overlay = mountSwarmOverlay({ doc, win, swarm: { agents: 2, speed: 8 }, onEvent: (e) => events.push(e) });
  const bodyHtml = () => doc.body.innerHTML;

  const started = overlay.exec('start_tour', { agents: 6 });
  assert.deepEqual({ ok: started.ok, running: started.running, total: started.total }, { ok: true, running: true, total: 8 });
  assert.equal(doc.getElementById('hero').style.getPropertyValue('visibility'), 'hidden');
  assert.equal(doc.getElementById('ghost').style.visibility, '', 'non-layers are never touched');

  assert.equal(overlay.exec('stop_tour').stopped, true);
  assert.equal(bodyHtml(), before);
  assert.equal(events.at(-1).cancelled, true);

  // Auditing a half-built page would hide real defects, so an audit ends the tour first.
  overlay.exec('start_tour', {});
  assert.deepEqual(
    overlay.runAudit({}).findings.map((f) => f.ruleId),
    ['a11y-form-label', 'a11y-accessible-name']
  );
  assert.equal(overlay.getState().tour.running, false);
  assert.equal(bodyHtml(), before);

  overlay.exec('start_tour', { agents: 6 });
  await until(() => events.some((e) => e.type === 'tour_done' && !e.cancelled), 15000);
  const done = events.findLast((e) => e.type === 'tour_done');
  assert.deepEqual({ done: done.done, total: done.total }, { done: 8, total: 8 });
  assert.equal(bodyHtml(), before);
  assert.equal(overlay.getState().tour.running, false);

  overlay.exec('start_tour', {});
  overlay.destroy();
  assert.equal(bodyHtml(), before, 'destroying the overlay mid-tour restores the page');
});

test('page reader outlines the page, finds elements by text or field label, redacts secrets and scrolls', () => {
  const dom = page({
    body: `<h1 id="title">Acceso</h1>
      <label for="mail">Correo</label><input id="mail" type="email" value="ana@example.com">
      <input id="pw" type="password" value="hunter2" aria-label="Contraseña">
      <button id="go"><span>Entrar</span></button>
      <a id="far" href="/ayuda">Ayuda</a>
      <button id="ghost" style="display: none">Oculto</button>`,
    rects: {
      title: { x: 20, y: 20, width: 300, height: 40 },
      mail: { x: 20, y: 80, width: 200, height: 40 },
      pw: { x: 20, y: 140, width: 200, height: 40 },
      go: { x: 20, y: 200, width: 100, height: 40 },
      far: { x: 20, y: 3000, width: 80, height: 20 }
    }
  });
  const scrolled = [];
  dom.win.scrollTo = (options) => scrolled.push(options);
  dom.win.scrollBy = (options) => scrolled.push(options);
  const overlay = mountSwarmOverlay({ doc: dom.doc, win: dom.win, swarm: { agents: 0 } });

  const snap = overlay.exec('snapshot', {});
  assert.deepEqual(
    snap.elements.map((e) => e.selector),
    ['#title', '#mail', '#pw', '#go']
  );
  assert.equal(snap.elements.find((e) => e.selector === '#pw').value, '[redacted]');
  assert.equal(snap.elements.find((e) => e.selector === '#mail').value, 'ana@example.com');
  assert.equal(snap.untrustedPageData, true);
  assert.equal(overlay.exec('snapshot', { scope: 'page' }).elements.at(-1).selector, '#far');

  const byText = overlay.exec('query', { text: 'entrar' });
  assert.deepEqual({ found: byText.found, selector: byText.selector, tag: byText.tag }, { found: true, selector: '#go', tag: 'button' });
  assert.equal(overlay.exec('query', { text: 'Correo', prefer: 'control' }).selector, '#mail');
  assert.equal(overlay.exec('query', { text: 'contraseña', prefer: 'control' }).selector, '#pw');
  assert.equal(overlay.exec('query', { text: 'Oculto' }).found, false);
  assert.equal(overlay.exec('query', { selector: '##bad' }).found, false);
  assert.deepEqual(
    { count: overlay.exec('query', { selector: 'button' }).count, missing: overlay.exec('query', { selector: '#nope' }).found },
    { count: 2, missing: false }
  );

  assert.equal(overlay.exec('scroll', { to: 'bottom', smooth: false }).ok, true);
  assert.equal(overlay.exec('scroll', {}).ok, true);
  assert.equal(overlay.exec('scroll', { selector: '#nope' }).ok, false);
  assert.deepEqual(
    scrolled.map((o) => o.behavior),
    ['auto', 'smooth']
  );
  overlay.destroy();
});
