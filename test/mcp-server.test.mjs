import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  'swarm_configure_swarm',
  'swarm_start_tour',
  'swarm_stop_tour',
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
  'swarm_heal_findings',
  'swarm_verify_finding',
  'swarm_await_event',
  'swarm_screenshot',
  'swarm_snapshot',
  'swarm_hover',
  'swarm_scroll',
  'swarm_wait_for',
  'swarm_expect',
  'swarm_test_report',
  'swarm_desktop_status',
  'swarm_desktop_screenshot',
  'swarm_desktop_list_windows',
  'swarm_desktop_focus_window',
  'swarm_desktop_move',
  'swarm_desktop_click',
  'swarm_desktop_drag',
  'swarm_desktop_scroll',
  'swarm_desktop_type',
  'swarm_desktop_key',
  'swarm_desktop_open'
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
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          }
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

function connectMockTab(
  bus,
  { tabId = 101, url = 'http://localhost:5173/player', viewport = { width: 390, height: 844 }, findings = [] } = {}
) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${bus.wsUrl}/?token=${bus.token}`);
    const state = {
      commands: [],
      auditViewports: [],
      tickets: [],
      lastSetTickets: null,
      viewport: { ...viewport },
      findings: typeof findings === 'function' ? findings : [...findings]
    };
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
        state.lastSetTickets = cmd;
      } else if (cmd.action === 'run_audit') {
        state.auditViewports.push({ ...state.viewport });
        const list = typeof state.findings === 'function' ? state.findings(cmd, state) : state.findings;
        return ws.send(
          JSON.stringify({
            type: 'command_result',
            commandId: msg.commandId,
            ok: true,
            result: { pathname: new URL(url).pathname, viewport: cmd.viewport || state.viewport, findings: list }
          })
        );
      }
      ws.send(JSON.stringify({ type: 'command_result', commandId: msg.commandId, ok: true, result: { ok: true, action: cmd.action } }));
    });
    ws.once('error', reject);
  });
}

describe('mcp-server tools & stdio transport', () => {
  it('exposes all 40 tool schemas and handles initialize, notifications, and tools/list (plus Content-Length)', async () => {
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
      assert.deepEqual(
        list.result.tools.map((t) => t.name),
        EXPECTED_TOOLS
      );
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
      assert.equal(res.result.tools.length, EXPECTED_TOOLS.length);

      // Verify Content-Type preceding Content-Length (split across chunks)
      const payload2 = JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping', params: {} });
      const resPromise2 = new Promise((resolve) => {
        let acc = '';
        const onChunk = (c) => {
          acc += c.toString('utf8');
          const idx = acc.indexOf('\r\n\r\n');
          if (idx !== -1) {
            const len = Number(/Content-Length:\s*(\d+)/i.exec(acc.slice(0, idx))?.[1] || 0);
            const body = acc.slice(idx + 4);
            if (Buffer.byteLength(body, 'utf8') >= len) {
              stdout2.off('data', onChunk);
              resolve(JSON.parse(body.slice(0, len)));
            }
          }
        };
        stdout2.on('data', onChunk);
      });
      stdin2.write('Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n');
      stdin2.write(`Content-Length: ${Buffer.byteLength(payload2, 'utf8')}\r\n\r\n${payload2}`);
      const res2 = await resPromise2;
      assert.equal(res2.id, 10);
      assert.deepEqual(res2.result, {});
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
      {
        ruleId: 'overflow-document',
        severity: 'P1',
        category: 'overflow',
        selector: 'html',
        description: 'Page overflows 390px',
        expected: 'scrollWidth <= 390',
        actual: 'scrollWidth=440'
      },
      {
        ruleId: 'tap-target-size',
        severity: 'P2',
        category: 'tap-target',
        selector: '#play-btn',
        description: 'Tap target < 44px',
        expected: '>= 44x44px',
        actual: '32x32px'
      }
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

      await client.callTool('swarm_move_cursor', { tabId: 101, agentId: 'layout', x: 120, y: 80, status: 'Inspecting' });
      assert.ok(tab.state.commands.some((c) => c.action === 'move_cursor' && c.x === 120 && c.status === 'Inspecting'));

      const unknown = await client.request('tools/call', { name: 'swarm_nonexistent', arguments: {} });
      assert.equal(unknown.error.code, -32602);

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
      const claimed = await client.callTool('swarm_claim_findings', {
        ticketIds: [tOverflow.id, tTap.id, manual.data.id],
        devAgentId: 'dev-1'
      });
      assert.equal(claimed.data.tickets.length, 3);

      // Switch viewport away so swarm_mark_fixed must restore 390px before re-audit
      await client.callTool('swarm_set_viewport', { tabId: 101, agentId: 'responsive', width: 1440, height: 900 });
      tab.ws.send(
        JSON.stringify({ type: 'route_changed', tabId: 101, url: 'http://localhost:5173/player', viewport: { width: 1440, height: 900 } })
      );
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

  it('enforces mandatory lock with synthesized agentId on swarm_click and forwards rect in swarm_report_finding', async () => {
    const calls = [];
    const spyBus = {
      rpc: async (action, params) => {
        calls.push({ action, params });
        if (action === 'session.status')
          return {
            selectedTabId: 101,
            tabs: [{ tabId: 101, pathname: '/player', url: 'http://localhost:5173/player', viewport: { width: 390, height: 844 } }],
            locks: { locked: false, tabId: 101 },
            ticketsSummary: { open: 1, reopened: 0, awaiting_reverify: 0, verified: 0 }
          };
        if (action === 'tickets.create') return { id: 'T-1', tabId: 101, ...params };
        if (action === 'tickets.list')
          return [{ id: 'T-1', tabId: 101, pathname: '/player', viewport: { width: 390, height: 844 }, status: 'open' }];
        return { ok: true };
      }
    };
    const stdin = new PassThrough(),
      stdout = new PassThrough();
    const server = createMcpServer({ busClient: spyBus, stdin, stdout });
    const client = createJsonRpcClient(stdin, stdout);

    try {
      const clickRes = await client.callTool('swarm_click', { tabId: 101, selector: '#play-btn' });
      assert.equal(clickRes.isError, false);
      const acq = calls.find((c) => c.action === 'lock.acquire');
      const cmd = calls.find((c) => c.action === 'tab.command' && c.params.command?.action === 'click');
      const rel = calls.find((c) => c.action === 'lock.release');
      assert.match(acq.params.agentId, /^mcp-[0-9a-f]{8}$/);
      assert.equal(acq.params.scope, 'interaction');
      assert.equal(acq.params.ttlMs, 15000);
      assert.equal(cmd.params.requireLock, true);
      assert.equal(cmd.params.agentId, acq.params.agentId);
      assert.equal(rel.params.agentId, acq.params.agentId);

      const rect = { x: 10, y: 20, width: 120, height: 32 };
      await client.callTool('swarm_report_finding', { tabId: 101, description: 'Misaligned badge', rect });
      const created = calls.find((c) => c.action === 'tickets.create');
      assert.deepEqual(created.params.rect, rect);
    } finally {
      await server.close();
    }

    // Real bus verification: omitted agentId acquires/releases lock and respects another agent's active lock
    const tmp = makeTempRegistry('swarm-mcp-lock-');
    const bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });
    const tab = await connectMockTab(bus, { tabId: 101 });
    const stdin2 = new PassThrough(),
      stdout2 = new PassThrough();
    const srv2 = createMcpServer({ registryPath: tmp.registryPath, stdin: stdin2, stdout: stdout2 });
    const cli2 = createJsonRpcClient(stdin2, stdout2);

    try {
      await cli2.request('initialize', {});
      const preSeq = (await cli2.callTool('swarm_session_status', { tabId: 101 })).data.seq;
      const unlockedClick = await cli2.callTool('swarm_click', { tabId: 101, selector: '#play-btn' });
      assert.equal(unlockedClick.isError, false);
      assert.equal((await cli2.callTool('swarm_session_status', { tabId: 101 })).data.locks.locked, false);
      const lockEvs = (await cli2.callTool('swarm_await_event', { sinceSeq: preSeq, timeoutMs: 200 })).data.events;
      const acqEv = lockEvs.find((e) => e.type === 'lock_acquired');
      const relEv = lockEvs.find((e) => e.type === 'lock_released');
      assert.match(acqEv?.agentId || '', /^mcp-[0-9a-f]{8}$/);
      assert.equal(relEv?.agentId, acqEv.agentId);

      await cli2.callTool('swarm_acquire_lock', { agentId: 'qa-1', tabId: 101, scope: 'interaction' });
      const clickCountBefore = tab.state.commands.filter((c) => c.action === 'click').length;
      const blocked = await cli2.callTool('swarm_click', { tabId: 101, selector: '#play-btn' });
      assert.equal(blocked.isError, true);
      assert.equal(blocked.data.code, 'LOCK_HELD');
      assert.match(blocked.data.error, /locked/i);
      assert.equal(tab.state.commands.filter((c) => c.action === 'click').length, clickCountBefore);
      await cli2.callTool('swarm_release_lock', { agentId: 'qa-1', tabId: 101 });
    } finally {
      tab.ws.close();
      await srv2.close();
      await bus.close();
      tmp.cleanup();
    }
  });

  it('restores multiple viewports (390x844 & 1440x900), clears stale console logs, syncs pins/summary, and rejects non-loopback registry hosts', async () => {
    const tmp = makeTempRegistry('swarm-mcp-multivp-');
    const bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });
    let activeFindings = {
      390: [
        {
          ruleId: 'overflow-document',
          severity: 'P1',
          category: 'overflow',
          selector: 'html',
          description: 'Mobile overflow',
          expected: 'scrollWidth <= 390',
          actual: 'scrollWidth=440'
        }
      ],
      1440: [
        {
          ruleId: 'overlap-elements',
          severity: 'P1',
          category: 'overlap',
          selector: '.hero',
          description: 'Desktop overlap',
          expected: 'Overlap <= 4px',
          actual: 'overlap=12x8px'
        }
      ]
    };
    const tab = await connectMockTab(bus, {
      tabId: 101,
      viewport: { width: 1440, height: 900 },
      findings: (cmd, st) => activeFindings[cmd.viewport?.width ?? st.viewport.width] || []
    });
    const stdin = new PassThrough(),
      stdout = new PassThrough();
    const server = createMcpServer({ registryPath: tmp.registryPath, stdin, stdout });
    const client = createJsonRpcClient(stdin, stdout);

    try {
      await client.request('initialize', {});
      await client.callTool('swarm_spawn_cursors', { tabId: 101, roles: ['layout', 'responsive'] });

      const desktopAudit = await client.callTool('swarm_run_dom_audit', { tabId: 101, agentId: 'layout' });
      const tDesktop = desktopAudit.data.createdTickets[0];
      assert.equal(tab.state.lastSetTickets.viewportWidth, 1440);
      assert.deepEqual(tab.state.lastSetTickets.summary, { activeAgents: 2, open: 1, awaiting_reverify: 0, verified: 0 });

      await client.callTool('swarm_set_viewport', { tabId: 101, agentId: 'responsive', width: 390, height: 844 });
      tab.ws.send(
        JSON.stringify({ type: 'route_changed', tabId: 101, url: 'http://localhost:5173/player', viewport: { width: 390, height: 844 } })
      );
      await new Promise((r) => setTimeout(r, 40));

      const mobileAudit = await client.callTool('swarm_run_dom_audit', { tabId: 101, agentId: 'layout' });
      const tMobile = mobileAudit.data.createdTickets[0];
      assert.equal(tab.state.lastSetTickets.viewportWidth, 390);
      assert.equal(tab.state.lastSetTickets.summary.open, 2);

      // Switch to unrelated 800x600 viewport so mark_fixed must restore BOTH 390x844 and 1440x900
      await client.callTool('swarm_set_viewport', { tabId: 101, agentId: 'responsive', width: 800, height: 600 });
      tab.ws.send(
        JSON.stringify({ type: 'route_changed', tabId: 101, url: 'http://localhost:5173/player', viewport: { width: 800, height: 600 } })
      );
      await new Promise((r) => setTimeout(r, 40));

      await client.callTool('swarm_claim_findings', { ticketIds: [tMobile.id, tDesktop.id], devAgentId: 'dev-1' });
      activeFindings = { 390: [], 1440: [] };
      const cmdStart = tab.state.commands.length;
      tab.state.auditViewports.length = 0;

      const fixed = await client.callTool('swarm_mark_fixed', {
        ticketIds: [tMobile.id, tDesktop.id],
        devAgentId: 'dev-1',
        summary: 'Fixed mobile overflow and desktop overlap',
        waitForHmrMs: 0
      });
      assert.deepEqual(
        fixed.data.tickets.map((t) => t.status),
        ['verified', 'verified']
      );
      const cmds = tab.state.commands.slice(cmdStart);
      const clearIdx = cmds.findIndex((c) => c.action === 'get_console_network' && c.clear === true);
      const firstAuditIdx = cmds.findIndex((c) => c.action === 'run_audit');
      assert.ok(clearIdx !== -1 && clearIdx < firstAuditIdx, 'get_console_network({ clear: true }) must precede run_audit');
      assert.deepEqual(tab.state.auditViewports, [
        { width: 390, height: 844 },
        { width: 1440, height: 900 }
      ]);
      assert.equal(tab.state.lastSetTickets.viewportWidth, 1440);
      assert.deepEqual(tab.state.lastSetTickets.summary, { activeAgents: 2, open: 0, awaiting_reverify: 0, verified: 2 });
    } finally {
      tab.ws.close();
      await server.close();
      await bus.close();
      tmp.cleanup();
    }

    // Non-loopback bus.json host validation
    const badTmp = makeTempRegistry('swarm-mcp-badhost-');
    writeFileSync(
      badTmp.registryPath,
      JSON.stringify({ pid: process.pid, port: 47999, host: 'evil.example.com', token: 'secret' }),
      'utf8'
    );
    const badServer = createMcpServer({ registryPath: badTmp.registryPath, stdin: new PassThrough(), stdout: new PassThrough() });
    try {
      await assert.rejects(() => badServer.ensureBus(), /non-loopback/i);
    } finally {
      await badServer.close();
      badTmp.cleanup();
    }
  });

  it('runs as a standalone stdio CLI child process', async () => {
    const tmp = makeTempRegistry('swarm-mcp-cli-');
    const child = spawn(process.execPath, ['packages/mcp-server/src/mcp-server.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_REGISTRY_PATH: tmp.registryPath },
      stdio: ['pipe', 'pipe', 'pipe']
    });
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

describe('mcp-server swarm control & self-healing', () => {
  it('forwards tour/swarm commands and heals only findings that a re-audit proves fixed', async () => {
    const tmp = makeTempRegistry();
    const bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = createMcpServer({ registryPath: tmp.registryPath, stdin, stdout });
    const client = createJsonRpcClient(stdin, stdout);
    const label = {
      ruleId: 'a11y-form-label',
      severity: 'P2',
      category: 'a11y',
      selector: '#email',
      description: 'Form input missing label',
      actual: 'unlabeled input (type=email)'
    };
    const overflow = {
      ruleId: 'overflow-container',
      severity: 'P2',
      category: 'overflow',
      selector: '#tags',
      description: 'Container overflows horizontally'
    };
    const overlap = { ruleId: 'overlap-elements', severity: 'P1', category: 'overlap', selector: '#badge', description: 'Overlaps #title' };
    // The mock page: the label patch really fixes its finding, the overflow patch does not.
    const patched = new Set();
    const tab = await connectMockTab(bus, {
      url: 'http://localhost:5173/',
      findings: () => [overflow, overlap, ...(patched.has('#email') ? [] : [label])]
    });
    tab.ws.on('message', (raw) => {
      const cmd = JSON.parse(raw.toString('utf8')).command;
      if (cmd?.action === 'apply_patch') patched.add(cmd.patch.selector);
      if (cmd?.action === 'revert_patch') patched.clear();
    });
    try {
      await server.start();
      const tour = await client.callTool('swarm_start_tour', { agents: 18, speed: 2 });
      assert.equal(tour.isError, false);
      assert.deepEqual(tab.state.commands.at(-1), { action: 'start_tour', agents: 18, speed: 2 });
      await client.callTool('swarm_configure_swarm', { agents: 24, rulers: false });
      assert.deepEqual(tab.state.commands.at(-1), { action: 'configure_swarm', agents: 24, rulers: false });
      await client.callTool('swarm_stop_tour');
      assert.equal(tab.state.commands.at(-1).action, 'stop_tour');

      const audit = await client.callTool('swarm_run_dom_audit', {});
      assert.equal(audit.data.createdTickets.length, 3);
      assert.equal(tab.state.commands.find((c) => c.action === 'run_audit').animate, true);

      const heal = await client.callTool('swarm_heal_findings', {});
      assert.equal(heal.isError, false);
      assert.deepEqual(
        heal.data.healed.map((h) => h.patch.attr),
        [{ name: 'aria-label', value: 'Correo electrónico' }]
      );
      assert.equal(heal.data.failed.length, 1);
      assert.match(heal.data.failed[0].reason, /reverted/);
      assert.equal(heal.data.skipped.length, 1);
      assert.match(heal.data.skipped[0].reason, /no automatic recipe/);
      assert.equal(heal.data.manifest.totalPatches, 1);
      assert.equal(tab.state.commands.filter((c) => c.action === 'revert_patch').length, 1);

      const byRule = Object.fromEntries(bus.store.list().map((t) => [t.ruleId, t]));
      assert.equal(byRule['a11y-form-label'].status, 'verified');
      assert.equal(byRule['a11y-form-label'].evidence.hotPatch, true);
      assert.equal(byRule['overflow-container'].status, 'open');
      assert.equal(byRule['overflow-container'].round, 1);
      assert.equal(bus.locks.status(101).locked, false);
    } finally {
      tab.ws.close();
      await server.close();
      await bus.close();
      tmp.cleanup();
    }
  });
});

describe('mcp-server AI testing tools (web + desktop)', () => {
  it('targets elements by text, verifies expectations with retries, returns images, drives the desktop and writes a test report', async () => {
    const tmp = makeTempRegistry();
    const bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const desktopCalls = [];
    const desktopDriver = {
      status: async () => ({ supported: true, platform: 'test', screen: { width: 1920, height: 1080 }, pointer: { x: 5, y: 6 } }),
      screenshot: async (o) => (desktopCalls.push(['screenshot', o]), { data: 'ZmFrZQ==', mimeType: 'image/jpeg' }),
      listWindows: async () => [{ id: '7', title: 'Bloc de notas', pid: 1, rect: { x: 0, y: 0, width: 800, height: 600 } }],
      focusWindow: async (a) => (desktopCalls.push(['focus', a]), { focused: true }),
      move: async (a) => (desktopCalls.push(['move', a]), a),
      click: async (a) => (desktopCalls.push(['click', a]), { x: a.x, y: a.y }),
      drag: async (a) => (desktopCalls.push(['drag', a]), { x: a.toX, y: a.toY }),
      scroll: async (a) => void desktopCalls.push(['scroll', a]),
      type: async (a) => void desktopCalls.push(['type', a]),
      key: async (a) => {
        if (a.keys === 'boom') throw new Error('Unknown key: boom');
        desktopCalls.push(['key', a]);
      },
      open: async (a) => (desktopCalls.push(['open', a]), { opened: true, target: a.target, pid: 99 })
    };
    const server = createMcpServer({ registryPath: tmp.registryPath, desktopDriver, stdin, stdout });
    const client = createJsonRpcClient(stdin, stdout);
    const tab = await connectMockTab(bus, { url: 'http://localhost:5173/login' });
    // A tiny fake page: the welcome banner appears only after the button has been clicked, 300 ms later.
    let clickedAt = null;
    const reply = (msg, result) => tab.ws.send(JSON.stringify({ type: 'command_result', commandId: msg.commandId, ok: true, result }));
    tab.ws.removeAllListeners('message');
    tab.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type !== 'command') return;
      const cmd = msg.command;
      tab.state.commands.push(cmd);
      if (cmd.action === 'query') {
        if (cmd.text === 'Entrar' && !cmd.prefer)
          return reply(msg, { found: true, visible: true, count: 1, selector: '#login-btn', text: 'Entrar' });
        if (cmd.text === 'Correo' && cmd.prefer === 'control')
          return reply(msg, { found: true, visible: true, count: 1, selector: '#email', value: '' });
        if (cmd.selector === '#welcome') {
          const shown = clickedAt !== null && Date.now() - clickedAt > 300;
          return reply(
            msg,
            shown
              ? { found: true, visible: true, count: 1, selector: '#welcome', text: 'Hola, Ana' }
              : { found: false, count: 0, visible: false }
          );
        }
        return reply(msg, { found: false, count: 0, visible: false });
      }
      if (cmd.action === 'click') clickedAt = Date.now();
      if (cmd.action === 'screenshot')
        return reply(msg, { data: 'aW1n', mimeType: 'image/jpeg', width: 390, height: 844, fullPage: false });
      if (cmd.action === 'snapshot')
        return reply(msg, { url: 'http://localhost:5173/login', title: 'Acceso', elements: [{ selector: '#login-btn', name: 'Entrar' }] });
      reply(msg, { ok: true, action: cmd.action });
    });
    const qaDir = join(tmp.dir, 'qa');
    process.env.SWARM_QA_DIR = qaDir;
    try {
      await server.start();
      const shot = await client.callTool('swarm_snapshot', {});
      assert.equal(shot.data.elements[0].name, 'Entrar');
      const image = await client.request('tools/call', { name: 'swarm_screenshot', arguments: {} });
      assert.deepEqual(image.result.content[0], { type: 'image', data: 'aW1n', mimeType: 'image/jpeg' });
      assert.equal(JSON.parse(image.result.content[1].text).width, 390);

      await client.callTool('swarm_fill', { text: 'Correo', value: 'ana@example.com' });
      assert.deepEqual(
        tab.state.commands.findLast((c) => c.action === 'fill'),
        { action: 'fill', selector: '#email', value: 'ana@example.com' }
      );
      await client.callTool('swarm_click', { text: 'Entrar' });
      assert.equal(tab.state.commands.findLast((c) => c.action === 'click').selector, '#login-btn');
      const missing = await client.callTool('swarm_click', { text: 'No existe' });
      assert.equal(missing.isError, true);
      assert.equal(missing.data.code, 'ELEMENT_NOT_FOUND');

      const waited = await client.callTool('swarm_wait_for', { selector: '#welcome', timeoutMs: 2000 });
      assert.equal(waited.data.ok, true);
      const ok = await client.callTool('swarm_expect', {
        description: 'Saluda al usuario',
        selector: '#welcome',
        textIncludes: 'ana',
        urlIncludes: '/login'
      });
      assert.equal(ok.data.passed, true);
      const bad = await client.callTool('swarm_expect', {
        selector: '#welcome',
        textIncludes: 'Bienvenida',
        timeoutMs: 200,
        reportOnFail: true
      });
      assert.equal(bad.data.passed, false);
      assert.equal(bus.store.get(bad.data.ticketId).ruleId, 'expectation-failed');
      assert.equal((await client.callTool('swarm_wait_for', { selector: '#nope', timeoutMs: 100 })).data.code, 'WAIT_TIMEOUT');

      const desk = await client.request('tools/call', { name: 'swarm_desktop_screenshot', arguments: {} });
      assert.equal(desk.result.content[0].type, 'image');
      assert.match(JSON.parse(desk.result.content[1].text).note, /screen pixels/);
      assert.equal((await client.callTool('swarm_desktop_list_windows', {})).data.count, 1);
      await client.callTool('swarm_desktop_focus_window', { title: 'bloc' });
      await client.callTool('swarm_desktop_click', { x: 400, y: 300, clickCount: 2 });
      await client.callTool('swarm_desktop_type', { text: 'secreto123' });
      await client.callTool('swarm_desktop_key', { keys: 'ctrl+s' });
      await client.callTool('swarm_desktop_open', { target: 'notepad.exe' });
      assert.equal((await client.callTool('swarm_desktop_key', { keys: 'boom' })).isError, true);
      assert.deepEqual(
        desktopCalls.map((c) => c[0]),
        ['screenshot', 'focus', 'click', 'type', 'key', 'open']
      );

      const report = (await client.callTool('swarm_test_report', { name: 'Login feliz' })).data;
      assert.equal(report.passed, false);
      assert.deepEqual(report.totals, { steps: 11, actions: 9, expectations: 2, failedActions: 2, failedExpectations: 1 });
      assert.equal(report.file, join(qaDir, 'test-report-login-feliz.json'));
      const saved = readFileSync(report.file, 'utf8');
      assert.equal(JSON.parse(saved).steps.length, 11);
      assert.equal(saved.includes('secreto123') || saved.includes('ana@example.com'), false, 'typed values never reach the report');
      assert.equal((await client.callTool('swarm_test_report', {})).data.totals.steps, 0);
    } finally {
      delete process.env.SWARM_QA_DIR;
      tab.ws.close();
      await server.close();
      await bus.close();
      tmp.cleanup();
    }
  });
});
