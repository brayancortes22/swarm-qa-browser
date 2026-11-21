#!/usr/bin/env node
/**
 * Swarm QA command line: drive a connected tab through the running bus without an MCP client.
 *
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
import { readBusRegistry } from '../packages/core/src/session-auth.mjs';
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

const registry = readBusRegistry();
if (!registry?.port || !registry?.token) {
  console.error('No hay un bus en ejecución. Inícialo con: npm run start:bus');
  process.exit(1);
}
const host = registry.host === '::1' ? '[::1]' : registry.host || '127.0.0.1';
const busUrl = `http://${host}:${registry.port}`;
const client = createHttpBusClient(busUrl, registry.token);
const tools = buildToolHandlers((action, params) => client.rpc(action, params));
const print = (value) => console.log(JSON.stringify(value, null, 2));

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
