#!/usr/bin/env node
/**
 * Swarm QA command line: drive a connected tab through the running bus without an MCP client.
 *
 *   npm run swarm -- open <url> [--tour] [--audit] [--agents 18] [--headless]
 *                                           Open a browser on the URL with the swarm already attached
 *   npm run swarm -- status                 Connected tabs, tickets and the pairing code
 *   npm run swarm -- tour [--agents 18] [--speed 2]
 *   npm run swarm -- stop
 *   npm run swarm -- audit [--follow]       Audit the selected tab and file tickets
 *   npm run swarm -- heal                   Hot-patch open tickets, keep only verified fixes
 *   npm run swarm -- watch                  Stream bus events live (Ctrl+C to exit)
 *
 * Results are printed as JSON on stdout. Reports from `heal` are also written to .qa/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { openBrowserSession } from '../packages/cdp-adapter/src/browser-launcher.mjs';
import { readBusRegistry } from '../packages/core/src/session-auth.mjs';
import { startSwarmBus } from '../packages/core/src/swarm-bus.mjs';
import { createHttpBusClient } from '../packages/mcp-server/src/bus-client.mjs';
import { buildToolHandlers } from '../packages/mcp-server/src/tools.mjs';

const [command = 'status', ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 1) {
  if (!rest[i].startsWith('--')) continue;
  const key = rest[i].slice(2);
  const next = rest[i + 1];
  flags[key] = next === undefined || next.startsWith('--') ? true : Number.isNaN(Number(next)) ? next : Number(next);
}

const print = (value) => console.log(JSON.stringify(value, null, 2));

/** A bus that answers on the registered port, or null. */
async function findRunningBus() {
  const registry = readBusRegistry();
  if (!registry?.port || !registry?.token) return null;
  const host = registry.host === '::1' ? '[::1]' : registry.host || '127.0.0.1';
  const url = `http://${host}:${registry.port}`;
  const alive = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) }).then(
    (res) => res.ok,
    () => false
  );
  return alive ? { url, token: registry.token } : null;
}

let ownedBus = null;
let running = await findRunningBus();
if (!running && command === 'open') {
  // `open` is the zero-setup entry point: bring the bus up too.
  ownedBus = await startSwarmBus();
  running = { url: ownedBus.url, token: ownedBus.token };
}
if (!running) {
  console.error('No hay un bus en ejecución. Usa "npm run swarm -- open <url>" o inícialo con: npm run start:bus');
  process.exit(1);
}
const busUrl = running.url;
const registry = { token: running.token };
const client = createHttpBusClient(busUrl, running.token);
const tools = buildToolHandlers((action, params) => client.rpc(action, params), { openBrowser: (options) => openBrowserSession(options) });

async function watch() {
  const res = await fetch(`${busUrl}/events`, { headers: { 'x-swarm-token': registry.token } });
  if (!res.ok) throw new Error(`Event stream HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .find((line) => line.startsWith('data: '));
      buffer = buffer.slice(end + 2);
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      const detail = event.payload?.type
        ? `${event.payload.type} ${event.payload.done ?? ''}${event.payload.total ? `/${event.payload.total}` : ''}`
        : (event.pathname ?? event.ticket?.ruleId ?? '');
      console.log(`${event.ts.slice(11, 19)}  #${String(event.seq).padEnd(4)} ${event.type.padEnd(20)} ${event.tabId ?? ''} ${detail}`);
    }
  }
}

const commands = {
  /** Opens a browser on the URL with the swarm attached and stays alive until Ctrl+C. */
  async open() {
    const url = rest.find((arg) => /^https?:\/\//i.test(arg));
    if (!url) throw new Error('Indica la URL: npm run swarm -- open https://tu-sitio.com');
    const session = await openBrowserSession({ url, headless: Boolean(flags.headless) });
    await client.rpc('tabs.select', { tabId: session.tabId });
    if (flags.agents) await tools.swarm_configure_swarm({ agents: flags.agents });
    print({ ok: true, url, tabId: session.tabId, browser: session.executable, bus: busUrl });
    if (flags.tour) print({ tour: await tools.swarm_start_tour(flags) });
    if (flags.audit) print({ audit: (await tools.swarm_run_dom_audit({ follow: true })).findingsCount });
    console.error('Enjambre activo. En otra terminal: npm run swarm -- tour | audit | heal.  Ctrl+C para cerrar.');
    await new Promise((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, resolve);
    });
    await session.close();
    await ownedBus?.close();
  },
  async status() {
    const s = await tools.swarm_session_status({});
    print({
      bus: busUrl,
      pairingCode: s.pairingCode,
      selectedTabId: s.selectedTabId,
      tabs: s.tabs.map((t) => ({ tabId: t.tabId, url: t.url, viewport: t.viewport })),
      tickets: s.ticketsSummary
    });
  },
  tour: async () => print(await tools.swarm_start_tour(flags)),
  stop: async () => print(await tools.swarm_stop_tour(flags)),
  async audit() {
    const result = await tools.swarm_run_dom_audit({ ...flags, follow: Boolean(flags.follow) });
    print({
      ...result,
      createdTickets: result.createdTickets.map((t) => ({ id: t.id, severity: t.severity, ruleId: t.ruleId, selector: t.selector }))
    });
  },
  async heal() {
    const result = await tools.swarm_heal_findings(flags);
    mkdirSync('.qa', { recursive: true });
    writeFileSync('.qa/heal-report.json', JSON.stringify(result, null, 2));
    writeFileSync('.qa/patches.json', JSON.stringify(result.manifest, null, 2));
    print({
      healed: result.healed.length,
      failed: result.failed,
      skipped: result.skipped,
      report: '.qa/heal-report.json',
      patches: '.qa/patches.json',
      note: result.note
    });
  },
  watch
};

if (!Object.hasOwn(commands, command)) {
  console.error(`Comando desconocido "${command}". Usa: ${Object.keys(commands).join(' | ')}`);
  process.exit(1);
}
commands[command]().catch((err) => {
  console.error(`Error: ${err?.message ?? err}`);
  process.exit(1);
});
