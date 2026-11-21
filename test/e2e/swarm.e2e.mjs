/**
 * End-to-end check in a real Chromium: standalone overlay tour, then the full agent loop
 * (MCP server → bus → CDP bridge → page) with audit, self-healing, tour and a trusted click.
 *
 *   npm run test:e2e              # needs Playwright (`npm i -D playwright && npx playwright install chromium`)
 *   npm run test:e2e -- --shots   # also refreshes docs/media/*.png
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { connectCdpBridge } from '../../packages/cdp-adapter/src/cdp-bridge.mjs';
import { startSwarmBus } from '../../packages/core/src/swarm-bus.mjs';
import { createMcpServer } from '../../packages/mcp-server/src/mcp-server.mjs';
import { startDemoServer } from '../../scripts/demo.mjs';

async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    try {
      return createRequire(import.meta.url)('playwright').chromium;
    } catch {
      return null;
    }
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Minimal MCP client speaking newline-delimited JSON-RPC over in-memory streams. */
function createMcpClient(stdin, stdout) {
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  return async function callTool(name, args = {}) {
    const id = nextId++;
    const response = await new Promise((resolve) => {
      pending.set(id, resolve);
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    });
    const content = response.result.content;
    if (content[0].type === 'image') return { image: content[0], ...JSON.parse(content[1].text) };
    const data = JSON.parse(content[0].text);
    if (response.result.isError) throw new Error(`${name}: ${data.error}`);
    return data;
  };
}

const chromium = await loadChromium();
if (!chromium) {
  console.log('SKIP e2e: Playwright is not installed (npm i -D playwright && npx playwright install chromium).');
  process.exit(0);
}

const shotsDir = process.argv.includes('--shots') ? fileURLToPath(new URL('../../docs/media/', import.meta.url)) : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const shot = async (page, name) => shotsDir && page.screenshot({ path: join(shotsDir, `${name}.png`) });
const step = (label) => console.log(`  ✓ ${label}`);

/** Loads the unpacked extension in Chromium: it connects alone and the agent opens/attaches tabs, then tour → audit → click → detach. */
async function runExtensionFlow() {
  const extensionPath = fileURLToPath(new URL('../../packages/extension', import.meta.url));
  let context;
  try {
    context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      viewport: { width: 1280, height: 800 }
    });
  } catch (err) {
    console.log(`  - skipped: this Chromium build cannot load extensions headlessly (${String(err.message).split('\n')[0]})`);
    return;
  }
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    const extensionId = new URL(worker.url()).host;
    assert.equal(extensionId, bus.extensionId, 'manifest key must yield the extension id the bus trusts');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const send = (message) => popup.evaluate((msg) => chrome.runtime.sendMessage(msg), message);
    const rpc = async (action, params = {}) => {
      const res = await fetch(`${bus.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-swarm-token': bus.token },
        body: JSON.stringify({ action, params })
      });
      return res.json();
    };

    // Only test plumbing: this bus is on a random port. With the default port nothing has to be set.
    await send({ type: 'set_port', port: bus.port });
    for (let i = 0; i < 40 && !(await rpc('session.status')).result.browserConnected; i += 1) await new Promise((r) => setTimeout(r, 150));
    assert.equal((await rpc('session.status')).result.browserConnected, true, 'the extension connects by itself, with no pairing code');

    // The agent opens the site in this Chrome and gets the swarm attached, with no click anywhere.
    const openedHere = await callTool('swarm_open', { url: `${demo.url}/?bare=1&ext=1` });
    assert.equal(openedHere.browser, 'extension');
    const tabId = openedHere.tabId;
    const target = context.pages().find((p) => p.url().includes('ext=1'));
    assert.ok(target, 'the tab opened by the agent exists in the browser');
    await target.waitForFunction(() => Boolean(document.getElementById('__swarm_qa_overlay')));
    assert.ok((await rpc('session.status')).result.tabs.some((t) => t.tabId === tabId));

    // A tab the person already had open can be attached by the agent too.
    const other = await context.newPage();
    await other.goto(`${demo.url}/?bare=1&second=1`);
    const listed = (await callTool('swarm_browser_tabs', {})).tabs;
    assert.deepEqual(
      listed
        .filter((t) => t.url.includes('bare=1'))
        .map((t) => [t.url.includes('ext=1'), t.attached])
        .sort(),
      [
        [false, false],
        [true, true]
      ]
    );
    const attached = await callTool('swarm_attach_tab', { urlIncludes: 'second=1' });
    await other.waitForFunction(() => Boolean(document.getElementById('__swarm_qa_overlay')));
    assert.equal((await send({ type: 'detach_tab', tabId: attached.tabId })).ok, true);
    await other.close();
    await rpc('tabs.select', { tabId });
    step('extension connected by itself; the agent opened one tab and attached another with no code, consent or click');

    await target.bringToFront();
    assert.equal((await rpc('tab.command', { tabId, command: { action: 'start_tour', speed: 4 } })).result.running, true);
    await target.evaluate(() => fetch('/api/metrics/live').catch(() => {}));
    const audit = (await rpc('tab.command', { tabId, command: { action: 'run_audit', animate: false } })).result;
    assert.ok(audit.findings.some((f) => f.ruleId === 'a11y-accessible-name'));
    assert.ok(
      audit.findings.some((f) => f.ruleId === 'console-net-4xx'),
      'a request failing after attach must surface as a console/network finding'
    );
    await rpc('lock.acquire', { agentId: 'interactive', tabId });
    const click = (
      await rpc('tab.command', { tabId, agentId: 'interactive', command: { action: 'click', selector: '.nav-links a[href="#precios"]' } })
    ).result;
    assert.equal(click.trusted, true);
    await target.waitForFunction(() => location.hash === '#precios');
    step(`overlay injected in the isolated world: tour, audit (${audit.findings.length} findings) and trusted click work`);

    const shot = (await rpc('tab.command', { tabId, command: { action: 'screenshot' } })).result;
    assert.ok(
      Buffer.from(shot.data, 'base64')
        .subarray(0, 3)
        .equals(Buffer.from([0xff, 0xd8, 0xff])) && shot.width === 1280,
      'extension screenshot is a JPEG in CSS pixels'
    );
    assert.equal(
      (await rpc('tab.command', { tabId, agentId: 'interactive', command: { action: 'hover', selector: '.btn-primary' } })).result.hovered,
      true
    );
    assert.equal((await rpc('tab.command', { tabId, command: { action: 'query', text: 'Ver planes' } })).result.found, true);
    step('screenshot, hover and find-by-text work through chrome.debugger');

    assert.equal((await send({ type: 'detach_tab', tabId })).ok, true);
    await bus.waitForEvent((await rpc('session.status')).result.seq - 1, 3000);
    assert.equal(
      (await rpc('session.status')).result.tabs.some((t) => t.tabId === tabId),
      false
    );
    await target.waitForFunction(() => !document.getElementById('__swarm_qa_overlay'));
    step('detach removed the overlay and the tab left the bus immediately');
  } finally {
    await context.close();
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'swarm-e2e-'));
const registryPath = join(tmp, 'bus.json');
const cdpPort = await freePort();
const demo = await startDemoServer({ port: 0 });
const bus = await startSwarmBus({ port: 0, registryPath });
const browser = await chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`] });
const stdin = new PassThrough();
const stdout = new PassThrough();
const mcp = createMcpServer({ registryPath, stdin, stdout });
const callTool = createMcpClient(stdin, stdout);
let bridge = null;
let failed = false;

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: shotsDir ? 2 : 1 });
  const pageErrors = [];

  console.log('Standalone overlay');
  const standalone = await context.newPage();
  standalone.on('pageerror', (err) => pageErrors.push(String(err)));
  await standalone.goto(`${demo.url}/?agents=10`);
  await standalone.waitForFunction(() => globalThis.__swarmDemo?.overlay.getState().workers === 10);
  const htmlBefore = await standalone.evaluate(() => document.body.innerHTML);
  const started = await standalone.evaluate(() => __swarmDemo.overlay.startTour({ agents: 18 }));
  assert.equal(started.running, true);
  assert.ok(started.total > 40, `expected a real layer count, got ${started.total}`);
  const hiddenLayers = await standalone.evaluate(
    () => [...document.querySelectorAll('body *')].filter((el) => el.style.visibility === 'hidden').length
  );
  assert.equal(hiddenLayers, started.total);
  await standalone.waitForFunction(() => __swarmDemo.overlay.getState().tour.done > 12);
  await shot(standalone, 'tour');
  await standalone.evaluate(() => __swarmDemo.overlay.configure({ speed: 4 }));
  await standalone.waitForFunction(() => !__swarmDemo.overlay.getState().tour.running, null, { timeout: 60_000 });
  const tourDone = await standalone.evaluate(() => __swarmDemo.log.findLast((e) => e.type === 'tour_done'));
  assert.deepEqual({ done: tourDone.done, cancelled: tourDone.cancelled }, { done: started.total, cancelled: false });
  assert.equal(await standalone.evaluate(() => document.body.innerHTML), htmlBefore);
  assert.equal((await standalone.evaluate(() => __swarmDemo.overlay.getState())).workers, 18);
  step(`tour rebuilt ${started.total} layers with 18 agents and restored the page exactly`);
  await standalone.close();

  console.log('Agent loop: MCP → bus → CDP bridge → page');
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto(`${demo.url}/?bare=1`);
  bridge = await connectCdpBridge({ cdpPort, urlIncludes: 'bare=1', registryPath });
  await mcp.start();
  const status = await callTool('swarm_session_status');
  assert.equal(status.tabs.length, 1);
  assert.equal(status.tabs[0].pathname, '/');
  step(`bridge registered tab ${bridge.tabId}`);

  await callTool('swarm_configure_swarm', { agents: 12 });
  const spawned = await callTool('swarm_spawn_cursors', {});
  assert.equal(spawned.spawned.length, 5);
  await callTool('swarm_move_cursor', { agentId: 'layout', selector: 'h1', status: 'Midiendo titular' });

  const audit = await callTool('swarm_run_dom_audit', { agentId: 'layout', follow: true });
  const rules = audit.createdTickets.map((t) => t.ruleId).sort();
  for (const expected of ['a11y-accessible-name', 'a11y-form-label', 'media-broken-image', 'overflow-container', 'overlap-elements']) {
    assert.ok(rules.includes(expected), `audit should report ${expected}; got ${rules.join(', ')}`);
  }
  assert.equal((await callTool('swarm_run_dom_audit', { animate: false })).createdTickets.length, 0, 're-audit must not duplicate tickets');
  step(`audit filed ${audit.createdTickets.length} tickets (${[...new Set(rules)].join(', ')})`);
  await page.waitForTimeout(2600);
  await shot(page, 'audit');

  const heal = await callTool('swarm_heal_findings', {});
  const healedRules = heal.healed.map((h) => bus.store.get(h.ticketId).ruleId);
  for (const rule of ['a11y-accessible-name', 'a11y-form-label', 'overflow-container'])
    assert.ok(healedRules.includes(rule), `expected ${rule} to be healed; healed: ${healedRules.join(', ')}`);
  assert.equal(await page.getAttribute('#theme-toggle', 'aria-label'), 'Cambiar tema');
  assert.equal(await page.getAttribute('#email', 'aria-label'), 'Correo electrónico');
  for (const item of heal.healed) assert.equal(bus.store.get(item.ticketId).status, 'verified');
  for (const item of [...heal.failed, ...heal.skipped]) assert.notEqual(bus.store.get(item.ticketId).status, 'verified');
  const afterHeal = await callTool('swarm_run_dom_audit', { animate: false, createTickets: false });
  assert.ok(afterHeal.findingsCount < audit.findingsCount, 'verified patches must remove findings from a fresh audit');
  step(
    `self-healing verified ${heal.healed.length} patches, reverted ${heal.failed.length}, skipped ${heal.skipped.length} (${[...new Set(heal.skipped.map((x) => x.reason))].join('; ')})`
  );

  const seq = (await callTool('swarm_session_status')).seq;
  const tour = await callTool('swarm_start_tour', { agents: 16, speed: 4 });
  assert.equal(tour.running, true);
  let tourEvent = null;
  for (let since = seq; !tourEvent;) {
    const batch = await callTool('swarm_await_event', { sinceSeq: since, timeoutMs: 20_000 });
    assert.equal(batch.timedOut, false, 'tour_done event never arrived');
    since = batch.seq;
    tourEvent = batch.events.find((e) => e.type === 'finding_event' && e.payload?.type === 'tour_done');
  }
  assert.equal(tourEvent.payload.done, tour.total);
  step(`tour driven over MCP finished (${tour.total} layers), progress streamed through the bus`);

  await assert.rejects(() => callTool('swarm_click', { agentId: 'layout', selector: 'a[href="#precios"]' }), /read-only/);
  await callTool('swarm_click', { agentId: 'interactive', selector: '.nav-links a[href="#precios"]' });
  await page.waitForFunction(() => location.hash === '#precios');
  step('trusted click navigated the page; read-only role was refused');

  // Regression: a click issued while the page is still smooth-scrolling must wait for the target to settle.
  for (let round = 0; round < 4; round += 1) {
    await page.evaluate(() => {
      history.replaceState(null, '', location.pathname + location.search);
      window.scrollTo({ top: 0, behavior: 'instant' });
      document.querySelector('#contacto').scrollIntoView({ behavior: 'smooth' });
    });
    await page.waitForTimeout(120);
    await callTool('swarm_click', { agentId: 'interactive', selector: '.hero-cta a[href="#precios"]' });
    await page.waitForFunction(() => location.hash === '#precios', null, { timeout: 3000 });
  }
  step('clicks land on their target even while the page is smooth-scrolling (4/4)');

  // AI-driven functional test: observe → act → verify → report.
  process.env.SWARM_QA_DIR = join(tmp, 'qa');
  const outline = await callTool('swarm_snapshot', { scope: 'page', max: 200 });
  assert.ok(
    outline.elements.some((e) => e.name === 'Ver planes' && e.tag === 'a'),
    'outline lists the hero call to action'
  );
  const shotResult = await callTool('swarm_screenshot', {});
  assert.equal(shotResult.image.mimeType, 'image/jpeg');
  assert.ok(
    Buffer.from(shotResult.image.data, 'base64')
      .subarray(0, 3)
      .equals(Buffer.from([0xff, 0xd8, 0xff])),
    'screenshot is a real JPEG'
  );
  assert.deepEqual({ width: shotResult.width, height: shotResult.height }, { width: 1440, height: 860 });
  await callTool('swarm_click', { agentId: 'interactive', text: 'Probar demo' });
  assert.equal((await callTool('swarm_expect', { description: 'El enlace lleva a Producto', urlIncludes: '#producto' })).passed, true);
  await callTool('swarm_scroll', { agentId: 'interactive', selector: '#email' });
  await callTool('swarm_fill', { agentId: 'interactive', text: 'Correo', value: 'qa@lumen.test' });
  assert.equal((await callTool('swarm_expect', { selector: '#email', valueEquals: 'qa@lumen.test' })).passed, true);
  await callTool('swarm_hover', { agentId: 'interactive', text: 'Suscribirme' });
  await callTool('swarm_wait_for', { text: 'Recibe novedades de Lumen', timeoutMs: 3000 });
  const failing = await callTool('swarm_expect', {
    description: 'Aparece un mensaje de confirmación',
    text: 'Gracias por suscribirte',
    timeoutMs: 400,
    reportOnFail: true
  });
  assert.equal(failing.passed, false);
  assert.equal(bus.store.get(failing.ticketId).ruleId, 'expectation-failed');
  const report = await callTool('swarm_test_report', { name: 'Suscripción demo' });
  assert.deepEqual(
    { passed: report.passed, expectations: report.totals.expectations, failed: report.totals.failedExpectations },
    { passed: false, expectations: 3, failed: 1 }
  );
  assert.equal(JSON.parse(readFileSync(report.file, 'utf8')).steps.length, report.totals.steps);
  step(
    `AI test run: saw the page (outline + screenshot), acted by visible text, ${report.totals.expectations} expectations (1 real failure → ticket ${failing.ticketId}), report written`
  );

  await bridge.close();
  bridge = null;
  await page.waitForFunction(() => !document.getElementById('__swarm_qa_overlay'));
  assert.equal(await page.getAttribute('#theme-toggle', 'aria-label'), null, 'closing the bridge reverts hot patches');
  assert.deepEqual(pageErrors, []);
  step('bridge shutdown removed the overlay and reverted hot patches; no page errors');

  console.log('Automatic start (swarm_open: no extension, no pairing, no clicks)');
  const userDataDir = join(tmp, 'auto-profile');
  process.env.SWARM_BROWSER_PATH = chromium.executablePath();
  const opened = await callTool('swarm_open', { url: `${demo.url}/?bare=1&auto=1`, headless: true, agents: 14, tour: true, speed: 4 });
  assert.equal(opened.tour.running, true);
  const afterOpen = await callTool('swarm_session_status');
  assert.equal(afterOpen.selectedTabId, opened.tabId);
  assert.ok(afterOpen.tabs.some((t) => t.tabId === opened.tabId && t.url.includes('auto=1')));
  let autoDone = null;
  for (let since = afterOpen.seq - 5; !autoDone;) {
    const batch = await callTool('swarm_await_event', { sinceSeq: since, timeoutMs: 20_000 });
    assert.equal(batch.timedOut, false, 'tour_done never arrived from the launched browser');
    since = batch.seq;
    autoDone = batch.events.find((e) => e.tabId === opened.tabId && e.payload?.type === 'tour_done');
  }
  assert.equal(autoDone.payload.done, opened.tour.total);
  assert.equal(
    (await callTool('swarm_run_dom_audit', { tabId: opened.tabId, animate: false, createTickets: false })).findingsCount > 0,
    true
  );
  assert.equal((await callTool('swarm_close_browser', {})).closed, 1);
  assert.equal(
    (await callTool('swarm_session_status')).tabs.some((t) => t.tabId === opened.tabId),
    false
  );
  step(
    `one call opened ${opened.browser.split('/').pop()}, attached the swarm and ran a ${opened.tour.total}-layer tour; closing it removed the tab`
  );
  void userDataDir;

  console.log('Chrome extension (MV3, chrome.debugger)');
  await runExtensionFlow();
  console.log('E2E OK');
} catch (err) {
  failed = true;
  console.error(`E2E FAILED: ${err?.stack || err}`);
} finally {
  await bridge?.close().catch(() => {});
  await mcp.close().catch(() => {});
  await browser.close().catch(() => {});
  await bus.close().catch(() => {});
  await demo.close().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
