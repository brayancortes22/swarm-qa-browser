import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';

import { startSwarmBus } from '../packages/core/src/swarm-bus.mjs';
import { readBusRegistry } from '../packages/core/src/session-auth.mjs';
import { SWARM_TOOLS } from '../packages/mcp-server/src/tool-schemas.mjs';
import { createMcpServer } from '../packages/mcp-server/src/mcp-server.mjs';

const EXPECTED_TOOLS = [
  'swarm_session_status',
  'swarm_select_tab',
  'swarm_spawn_cursors',
  'swarm_move_cursor',
  'swarm_acquire_lock',
  'swarm_release_lock',
  'swarm_set_viewport',
  'swarm_click',
  'swarm_fill',
  'swarm_press_key',
  'swarm_navigate',
  'swarm_run_dom_audit',
  'swarm_report_finding',
  'swarm_list_findings',
  'swarm_claim_findings',
  'swarm_mark_fixed',
  'swarm_verify_finding',
  'swarm_await_event'
];

function makeTempRegistry(prefix = 'swarm-mcp-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, registryPath: join(dir, 'bus.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function createJsonRpcClient(stdin, stdout) {
  let buf = '';
  const pending = new Map();
  let nextId = 1;

  stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    while (true) {
      const nl = buf.indexOf('\n');
      if (nl === -1) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        entry.resolve(msg);
      }
    }
  });

  return {
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for JSON-RPC response to ${method} (id=${id})`));
        }, 5000);
        pending.set(id, {
          resolve: (msg) => { clearTimeout(timer); resolve(msg); }
        });
        stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params = {}) {
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async callTool(name, args = {}) {
      const res = await this.request('tools/call', { name, arguments: args });
      if (res.error) throw new Error(res.error.message);
      const text = res.result?.content?.[0]?.text ?? '{}';
      return { raw: res.result, isError: Boolean(res.result?.isError), data: JSON.parse(text) };
    }
  };
}

function connectMockTab(bus, { tabId = 101, url = 'http://localhost:5173/player', viewport = { width: 390, height: 844 }, findings = [] } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${bus.wsUrl}/?token=${bus.token}`);
    const state = { commands: [], tickets: [], viewport: { ...viewport }, findings: [...findings] };
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'hello', tabId, url, title: 'Sonora Mock', viewport: state.viewport }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'hello_ack') return resolve({ ws, state });
      if (msg.type !== 'command') return;
      state.commands.push(msg.command);
      const cmd = msg.command || {};
      if (cmd.action === 'set_viewport') {
        state.viewport = { width: cmd.width, height: cmd.height };
      } else if (cmd.action === 'set_tickets') {
        state.tickets = cmd.tickets || [];
      } else if (cmd.action === 'run_audit') {
        return ws.send(JSON.stringify({
          type: 'command_result',
          commandId: msg.commandId,
          ok: true,
          result: { pathname: new URL(url).pathname, viewport: cmd.viewport || state.viewport, findings: state.findings }
        }));
      }
      ws.send(JSON.stringify({ type: 'command_result', commandId: msg.commandId, ok: true, result: { ok: true, action: cmd.action } }));
    });
    ws.once('error', reject);
  });
}

describe('mcp-server tools & stdio transport', () => {
  it('exposes all 18 tool schemas and handles initialize, notifications, and tools/list (plus Content-Length)', async () => {
    assert.equal(SWARM_TOOLS.length, EXPECTED_TOOLS.length);
    for (const name of EXPECTED_TOOLS) {
      const tool = SWARM_TOOLS.find((t) => t.name === name);
      assert.ok(tool, `Missing tool schema: ${name}`);
      assert.equal(tool.inputSchema?.type, 'object');
      assert.ok(tool.annotations && typeof tool.annotations === 'object', `Missing annotations on ${name}`);
    }

    const tmp = makeTempRegistry();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = createMcpServer({ registryPath: tmp.registryPath, stdin, stdout });
    const client = createJsonRpcClient(stdin, stdout);

    try {
      const init = await client.request('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '1.0' } });
      assert.equal(init.result.serverInfo.name, 'swarm-qa-browser');
      assert.ok(init.result.capabilities.tools);

      client.notify('notifications/initialized');
      const list = await client.request('tools/list');
      assert.deepEqual(list.result.tools.map((t) => t.name), EXPECTED_TOOLS);
    } finally {
      await server.close();
      tmp.cleanup();
    }

    // Verify Content-Length framing support in a fresh stream
    const stdin2 = new PassThrough();
    const stdout2 = new PassThrough();
    const server2 = createMcpServer({ registryPath: tmp.registryPath, stdin: stdin2, stdout: stdout2 });
    try {
      const payload = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} });
      const resPromise = new Promise((resolve) => {
        let acc = '';
        stdout2.on('data', (c) => {
          acc += c.toString('utf8');
          const idx = acc.indexOf('\r\n\r\n');
          if (idx !== -1) {
            const lenMatch = /Content-Length:\s*(\d+)/i.exec(acc.slice(0, idx));
            const len = Number(lenMatch?.[1] || 0);
            const body = acc.slice(idx + 4);
            if (Buffer.byteLength(body, 'utf8') >= len) resolve(JSON.parse(body.slice(0, len)));
          }
        });
      });
      stdin2.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
      const res = await resPromise;
      assert.equal(res.id, 9);
      assert.equal(res.result.tools.length, 18);
    } finally {
      await server2.close();
    }
  });

  it('auto-starts an embedded bus when registry is absent or stale and closes it cleanly', async () => {
    const tmp = makeTempRegistry();
    writeFileSync(tmp.registryPath, JSON.stringify({ pid: 99999999, port: 47999, token: 'stale' }), 'utf8');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = createMcpServer({ registryPath: tmp.registryPath, stdin, stdout });
    const client = createJsonRpcClient(stdin, stdout);

    try {
      const status = await client.callTool('swarm_session_status');
      assert.equal(status.isError, false);
      assert.equal(status.data.ok, true);
      assert.ok(status.data.port > 0);
      const reg = readBusRegistry(tmp.registryPath);
      assert.equal(reg.port, status.data.port);
    } finally {
      await server.close();
      assert.equal(readBusRegistry(tmp.registryPath), null);
      tmp.cleanup();
    }
  });

  it('executes full QA -> Dev -> auto-reverify (close + reopen) -> manual report/verify -> locks -> await_event lifecycle', async () => {
    const tmp = makeTempRegistry();
    const bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });
    const findings = [
      { ruleId: 'overflow-document', severity: 'P1', category: 'overflow', selector: 'html', description: 'Page overflows 390px', expected: 'scrollWidth <= 390', actual: 'scrollWidth=440' },
      { ruleId: 'tap-target-size', severity: 'P2', category: 'tap-target', selector: '#play-btn', description: 'Tap target < 44px', expected: '>= 44x44px', actual: '32x32px' }
    ];
    const tab = await connectMockTab(bus, { tabId: 101, viewport: { width: 390, height: 844 }, findings });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = createMcpServer({ registryPath: tmp.registryPath, stdin, stdout });
    const client = createJsonRpcClient(stdin, stdout);

    try {
      await client.request('initialize', {});

      const sel = await client.callTool('swarm_select_tab', { tabId: 101 });
      assert.equal(sel.data.selectedTabId, 101);

      const spawned = await client.callTool('swarm_spawn_cursors', { tabId: 101, roles: ['layout', 'responsive'] });
      assert.equal(spawned.data.spawned.length, 2);
      assert.equal(tab.state.commands.at(-1).action, 'spawn_cursors');

      // Run DOM audit & verify deduplication on second run
      const audit1 = await client.callTool('swarm_run_dom_audit', { tabId: 101, agentId: 'layout' });
      assert.equal(audit1.data.untrustedPageData, true);
      assert.equal(audit1.data.findingsCount, 2);
      assert.equal(audit1.data.createdTickets.length, 2);
      assert.ok(tab.state.commands.some((c) => c.action === 'move_cursor' && c.status === 'Auditando'));
      assert.equal(tab.state.tickets.length, 2);

      const audit2 = await client.callTool('swarm_run_dom_audit', { tabId: 101, agentId: 'layout' });
      assert.equal(audit2.data.createdTickets.length, 0);

      // Manual finding report
      const manual = await client.callTool('swarm_report_finding', {
        tabId: 101,
        agentId: 'forms-a11y',
        severity: 'P2',
        selector: '#volume',
        description: 'Slider lacks aria-valuetext'
      });
      assert.equal(manual.data.ruleId, 'manual');
      assert.equal(manual.data.status, 'open');
      assert.equal(tab.state.tickets.length, 3);

      const listed = await client.callTool('swarm_list_findings', { tabId: 101, status: 'open' });
      assert.equal(listed.data.count, 3);

      // Claim & test mark_fixed: T-1 resolved, T-2 persists!
      const [tOverflow, tTap] = audit1.data.createdTickets;
      const claimed = await client.callTool('swarm_claim_findings', { ticketIds: [tOverflow.id, tTap.id, manual.data.id], devAgentId: 'dev-1' });
      assert.equal(claimed.data.tickets.length, 3);

      // Switch viewport away so swarm_mark_fixed must restore 390px before re-audit
      await client.callTool('swarm_set_viewport', { tabId: 101, agentId: 'responsive', width: 1440, height: 900 });
      tab.ws.send(JSON.stringify({ type: 'route_changed', tabId: 101, url: 'http://localhost:5173/player', viewport: { width: 1440, height: 900 } }));
      await new Promise((r) => setTimeout(r, 40));

      // Remove overflow finding so T-1 passes, keep tap-target so T-2 reopens
      tab.state.findings = [findings[1]];
      const fixedAuto = await client.callTool('swarm_mark_fixed', {
        ticketIds: [tOverflow.id, tTap.id],
        devAgentId: 'dev-1',
        summary: 'Fixed flex wrap on player container',
        waitForHmrMs: 0
      });
      const resOverflow = fixedAuto.data.tickets.find((t) => t.id === tOverflow.id);
      const resTap = fixedAuto.data.tickets.find((t) => t.id === tTap.id);
      assert.equal(resOverflow.status, 'verified');
      assert.equal(resTap.status, 'reopened');
      assert.equal(resTap.round, 2);
      assert.ok(tab.state.commands.some((c) => c.action === 'move_cursor' && c.status === 'Re-verificando'));
      assert.ok(tab.state.commands.some((c) => c.action === 'set_viewport' && c.width === 390));

      // Manual ticket markFixed stays awaiting_reverify, then verified manually via swarm_verify_finding
      const fixedManual = await client.callTool('swarm_mark_fixed', {
        ticketIds: [manual.data.id],
        devAgentId: 'dev-1',
        summary: 'Added aria-valuetext',
        waitForHmrMs: 0
      });
      assert.equal(fixedManual.data.tickets[0].status, 'awaiting_reverify');

      const verifiedManual = await client.callTool('swarm_verify_finding', {
        id: manual.data.id,
        agentId: 'forms-a11y',
        passed: true,
        evidence: 'aria-valuetext="65%" confirmed'
      });
      assert.equal(verifiedManual.data.status, 'verified');

      // Locks + interactive tools (click, fill, press_key, navigate)
      const acq = await client.callTool('swarm_acquire_lock', { agentId: 'qa-1', tabId: 101, scope: 'interaction' });
      assert.equal(acq.data.locked, true);

      const blocked = await client.callTool('swarm_click', { tabId: 101, agentId: 'qa-2', selector: '#play-btn' });
      assert.equal(blocked.isError, true);
      assert.match(blocked.data.error, /locked/i);

      const allowed = await client.callTool('swarm_click', { tabId: 101, agentId: 'qa-1', selector: '#play-btn' });
      assert.equal(allowed.isError, false);
      await client.callTool('swarm_release_lock', { agentId: 'qa-1', tabId: 101 });

      // Auto-acquire & release lock for fill / press_key / navigate
      await client.callTool('swarm_fill', { tabId: 101, agentId: 'qa-2', selector: '#search', value: 'ambient' });
      await client.callTool('swarm_press_key', { tabId: 101, agentId: 'qa-2', key: 'Enter' });
      await client.callTool('swarm_navigate', { tabId: 101, agentId: 'qa-2', url: 'http://localhost:5173/queue' });
      const postStatus = await client.callTool('swarm_session_status', { tabId: 101 });
      assert.equal(postStatus.data.locks.locked, false);

      // swarm_await_event wakes up on WS event
      const awaitPromise = client.callTool('swarm_await_event', { sinceSeq: postStatus.data.seq, timeoutMs: 2000 });
      tab.ws.send(JSON.stringify({ type: 'route_changed', tabId: 101, url: 'http://localhost:5173/queue', pathname: '/queue' }));
      const ev = await awaitPromise;
      assert.equal(ev.data.timedOut, false);
      assert.equal(ev.data.events.at(-1).pathname, '/queue');
    } finally {
      tab.ws.close();
      await server.close();
      await bus.close();
      tmp.cleanup();
    }
  });

  it('runs as a standalone stdio CLI child process', async () => {
    const tmp = makeTempRegistry('swarm-mcp-cli-');
    const child = spawn(
      process.execPath,
      ['packages/mcp-server/src/mcp-server.mjs'],
      { cwd: process.cwd(), env: { ...process.env, SWARM_REGISTRY_PATH: tmp.registryPath }, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    try {
      const client = createJsonRpcClient(child.stdin, child.stdout);
      const init = await client.request('initialize', {});
      assert.equal(init.result.serverInfo.name, 'swarm-qa-browser');
      const status = await client.callTool('swarm_session_status');
      assert.equal(status.data.ok, true);
      child.stdin.end();
      const code = await new Promise((resolve) => child.once('exit', resolve));
      assert.equal(code, 0);
    } finally {
      if (!child.killed) child.kill();
      tmp.cleanup();
    }
  });
});
