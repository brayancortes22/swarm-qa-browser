/**
 * Whole-computer control check: an agent (through the MCP desktop tools) uses the REAL mouse and
 * keyboard to operate a visible browser window, and the page confirms every input arrived.
 *
 *   npm run test:e2e:desktop
 *
 * On Linux without a display it re-runs itself inside Xvfb. On Windows it uses your actual
 * desktop: the pointer moves and types for a few seconds — do not touch the mouse meanwhile.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createMcpServer } from '../../packages/mcp-server/src/mcp-server.mjs';
import { startDemoServer } from '../../scripts/demo.mjs';

if (process.platform === 'linux' && !process.env.DISPLAY) {
  const run = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', process.execPath, fileURLToPath(import.meta.url)], {
    stdio: 'inherit'
  });
  if (run.error) console.log('SKIP desktop e2e: no display and xvfb-run is not installed.');
  process.exit(run.error ? 0 : (run.status ?? 1));
}

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
const chromium = await loadChromium();
if (!chromium) {
  console.log('SKIP desktop e2e: Playwright is not installed (npm i -D playwright && npx playwright install chromium).');
  process.exit(0);
}

const step = (label) => console.log(`  ✓ ${label}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = mkdtempSync(join(tmpdir(), 'swarm-desktop-e2e-'));
process.env.SWARM_QA_DIR = join(tmp, 'qa');
const demo = await startDemoServer({ port: 0 });
const stdin = new PassThrough();
const stdout = new PassThrough();
const mcp = createMcpServer({ registryPath: join(tmp, 'bus.json'), stdin, stdout });
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
async function callTool(name, args = {}) {
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
}

const browser = await chromium.launch({ headless: false, args: ['--window-position=40,30', '--window-size=1100,720'] });
let failed = false;
try {
  const page = await (await browser.newContext({ viewport: null })).newPage();
  await page.goto(`${demo.url}/?bare=1`);
  await page.evaluate(() => {
    window.__input = { moves: 0, downs: [], ups: [], offset: null };
    addEventListener('mousemove', (e) => {
      window.__input.moves += 1;
      window.__input.offset = { x: e.screenX - e.clientX, y: e.screenY - e.clientY };
    });
    addEventListener('mousedown', (e) => window.__input.downs.push([e.clientX, e.clientY, e.isTrusted]));
    addEventListener('mouseup', (e) => window.__input.ups.push([e.clientX, e.clientY]));
  });

  console.log('Desktop control through MCP');
  const status = await callTool('swarm_desktop_status');
  assert.equal(status.supported, true, JSON.stringify(status));
  assert.ok(status.screen.width >= 800 && status.screen.height >= 600);
  step(`backend ${status.backend}, screen ${status.screen.width}×${status.screen.height}`);

  // The browser needs a moment to map and paint its window; poll instead of assuming it is already on screen.
  const until = async (label, probe, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await sleep(250);
    }
  };
  let titles = '';
  const browserWindow = await until('the browser window to be listed', async () => {
    const { windows } = await callTool('swarm_desktop_list_windows');
    titles = windows.map((w) => w.title).join(' | ');
    return windows.find((w) => /lumen|chrom/i.test(w.title));
  }).catch((err) => assert.fail(`${err.message}; windows seen: ${titles || '(none)'}`));
  await callTool('swarm_desktop_focus_window', { windowId: browserWindow.id });

  // An empty 1280×800 screen compresses to ~4 KB; a painted page is several times larger.
  let lastSize = 0;
  const jpeg = await until('the screenshot to show the painted window', async () => {
    const shot = await callTool('swarm_desktop_screenshot', {});
    const bytes = Buffer.from(shot.image.data, 'base64');
    assert.ok(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), 'screenshot must be JPEG data');
    lastSize = bytes.length;
    return bytes.length > 12_000 ? bytes : null;
  }).catch((err) => assert.fail(`${err.message}; last screenshot was ${lastSize} bytes (a blank screen is ~4 KB)`));
  step(`saw the screen (${Math.round(jpeg.length / 1024)} KB JPEG) and found the window "${browserWindow.title.slice(0, 40)}"`);

  // Learn where the page sits on screen from a real pointer event, then aim at elements exactly.
  const { rect } = browserWindow;
  await callTool('swarm_desktop_move', { x: rect.x + Math.round(rect.width / 2), y: rect.y + Math.round(rect.height * 0.6) });
  await page.waitForFunction(() => window.__input.offset !== null, null, { timeout: 5000 });
  const toScreen = async (selector) => {
    const point = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 + window.__input.offset.x, y: r.top + r.height / 2 + window.__input.offset.y };
    }, selector);
    return { x: Math.round(point.x), y: Math.round(point.y) };
  };
  assert.ok((await page.evaluate(() => window.__input.moves)) >= 5, 'the pointer glides through intermediate positions');
  step('real pointer movement reached the page (smooth path, several mousemove events)');

  await callTool('swarm_desktop_click', await toScreen('#email'));
  await page.waitForFunction(() => document.activeElement?.id === 'email', null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__input.downs.at(-1)[2]), true, 'click must be a trusted OS event');
  await callTool('swarm_desktop_type', { text: 'qa@lumen.test' });
  await page.waitForFunction(() => document.querySelector('#email').value === 'qa@lumen.test', null, { timeout: 5000 });
  await callTool('swarm_desktop_key', { keys: 'ctrl+a' });
  await callTool('swarm_desktop_key', { keys: 'Backspace' });
  await page.waitForFunction(() => document.querySelector('#email').value === '', null, { timeout: 5000 });
  step('clicked a field, typed with the real keyboard, then cleared it with ctrl+a and Backspace');

  const before = await page.evaluate(() => scrollY);
  await callTool('swarm_desktop_scroll', { deltaY: -400 });
  await page.waitForFunction((y) => scrollY < y, before, { timeout: 5000 });
  step('mouse wheel scrolled the page');

  const from = await toScreen('.plan h3');
  await callTool('swarm_desktop_drag', { fromX: from.x - 40, fromY: from.y, toX: from.x + 120, toY: from.y + 30 });
  await sleep(200);
  const drag = await page.evaluate(() => ({ down: window.__input.downs.at(-1), up: window.__input.ups.at(-1) }));
  assert.ok(
    Math.abs(drag.up[0] - drag.down[0] - 160) <= 3 && Math.abs(drag.up[1] - drag.down[1] - 30) <= 3,
    `drag distance mismatch: ${JSON.stringify(drag)}`
  );
  step('drag pressed, moved 160×30 px and released');

  await callTool('swarm_desktop_click', await toScreen('.footer-links a'));
  await page.waitForFunction(() => location.hash === '#inicio', null, { timeout: 5000 });
  const report = await callTool('swarm_test_report', { name: 'desktop control' });
  assert.equal(report.totals.failedActions, 0);
  assert.ok(report.steps.every((s) => s.surface === 'desktop') && report.totals.actions >= 9);
  assert.equal(JSON.stringify(report).includes('qa@lumen.test'), false, 'typed text is not stored in the report');
  step(`clicked a link; ${report.totals.actions} desktop actions logged in the test report`);
  console.log('DESKTOP E2E OK');
} catch (err) {
  failed = true;
  console.error(`DESKTOP E2E FAILED: ${err?.stack || err}`);
} finally {
  await browser.close().catch(() => {});
  await mcp.close().catch(() => {});
  await demo.close().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
