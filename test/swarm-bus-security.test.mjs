import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { startSwarmBus } from '../packages/core/src/swarm-bus.mjs';
import { DEFAULT_EXTENSION_ID, readBusRegistry } from '../packages/core/src/session-auth.mjs';

function makeTempRegistry(prefix = 'swarm-bus-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, registryPath: join(dir, 'bus.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function connectWs(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    let settled = false;
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, ws });
    });
    ws.once('unexpected-response', (_req, res) => {
      if (settled) return;
      settled = true;
      res.resume();
      resolve({ ok: false, statusCode: res.statusCode });
    });
    ws.once('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: err });
    });
  });
}

async function rpc(bus, action, params = {}, headers = {}) {
  const res = await fetch(`${bus.url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-swarm-token': bus.token, ...headers },
    body: JSON.stringify({ action, params })
  });
  return { status: res.status, body: await res.json() };
}

describe('swarm-bus security & lifecycle', () => {
  it('refuses non-loopback host bindings', async () => {
    const tmp = makeTempRegistry();
    try {
      await assert.rejects(
        () => startSwarmBus({ port: 0, host: '0.0.0.0', registryPath: tmp.registryPath }),
        /loopback/i
      );
      await assert.rejects(
        () => startSwarmBus({ port: 0, host: '192.168.1.50', registryPath: tmp.registryPath }),
        /loopback/i
      );
    } finally {
      tmp.cleanup();
    }
  });

  it('rejects disallowed Origins with 403 and invalid/missing tokens with 401 across HTTP and WS', async () => {
    const tmp = makeTempRegistry();
    let bus;
    try {
      bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });

      // /health allows local/empty origin without leaking token, blocks evil origin
      const healthOk = await fetch(`${bus.url}/health`);
      assert.equal(healthOk.status, 200);
      const healthBody = await healthOk.json();
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.port, bus.port);
      assert.equal(healthBody.token, undefined);

      const healthEvil = await fetch(`${bus.url}/health`, { headers: { origin: 'https://evil.example' } });
      assert.equal(healthEvil.status, 403);

      // /pair rejects arbitrary web origins (even localhost app) and allows pinned extension or local CLI
      const pairEvil = await fetch(`${bus.url}/pair`, {
        method: 'POST',
        headers: { origin: 'https://evil.example' }
      });
      assert.equal(pairEvil.status, 403);

      const pairLocalWeb = await fetch(`${bus.url}/pair`, {
        method: 'POST',
        headers: { origin: 'http://localhost:5173' }
      });
      assert.equal(pairLocalWeb.status, 403);

      const pairExt = await fetch(`${bus.url}/pair`, {
        method: 'POST',
        headers: { origin: `chrome-extension://${DEFAULT_EXTENSION_ID}` }
      });
      assert.equal(pairExt.status, 200);
      const paired = await pairExt.json();
      assert.equal(paired.token, bus.token);
      assert.equal(paired.port, bus.port);

      // /rpc rejects evil Origin (even with valid token) -> 403, missing/wrong token -> 401
      const rpcEvil = await rpc(bus, 'session.status', {}, { origin: 'https://evil.example' });
      assert.equal(rpcEvil.status, 403);

      const rpcNoToken = await fetch(`${bus.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'session.status' })
      });
      assert.equal(rpcNoToken.status, 401);

      const rpcBadToken = await rpc(bus, 'session.status', {}, { 'x-swarm-token': 'wrong-token' });
      assert.equal(rpcBadToken.status, 401);

      // WS upgrade rejects evil Origin -> 403, missing/wrong token -> 401
      const wsEvil = await connectWs(`${bus.wsUrl}/?token=${bus.token}`, { origin: 'https://evil.example' });
      assert.equal(wsEvil.ok, false);
      assert.equal(wsEvil.statusCode, 403);

      const wsNoToken = await connectWs(`${bus.wsUrl}/`);
      assert.equal(wsNoToken.ok, false);
      assert.equal(wsNoToken.statusCode, 401);

      const wsBadToken = await connectWs(`${bus.wsUrl}/?token=bad`);
      assert.equal(wsBadToken.ok, false);
      assert.equal(wsBadToken.statusCode, 401);
    } finally {
      if (bus) await bus.close();
      tmp.cleanup();
    }
  });

  it('replaces stale dead-PID bus.json on start, cleans up on close, and handles port fallback', async () => {
    const tmp = makeTempRegistry();
    let blocker;
    let bus;
    try {
      writeFileSync(tmp.registryPath, JSON.stringify({ pid: 99999999, port: 47921, token: 'stale' }), 'utf8');

      blocker = createNetServer();
      await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      const busyPort = blocker.address().port;

      await assert.rejects(
        () => startSwarmBus({ port: busyPort, registryPath: tmp.registryPath, autoFallbackPort: false }),
        /EADDRINUSE/i
      );

      bus = await startSwarmBus({ port: busyPort, registryPath: tmp.registryPath, autoFallbackPort: true });
      assert.notEqual(bus.port, busyPort);
      const reg = readBusRegistry(tmp.registryPath);
      assert.equal(reg.pid, process.pid);
      assert.equal(reg.port, bus.port);
      assert.equal(reg.token, bus.token);

      await assert.rejects(
        () => startSwarmBus({ port: 0, registryPath: tmp.registryPath }),
        /already held by live PID/i
      );

      await bus.close();
      assert.equal(readBusRegistry(tmp.registryPath), null);
      bus = null;
    } finally {
      if (bus) await bus.close();
      if (blocker) await new Promise((resolve) => blocker.close(resolve));
      tmp.cleanup();
    }
  });

  it('handles WS tab registration, dispatchToTab, waitForEvent wakeup, and full RPC lifecycle', async () => {
    const tmp = makeTempRegistry();
    let bus;
    let ws1;
    let ws2;
    try {
      bus = await startSwarmBus({ port: 0, registryPath: tmp.registryPath });

      const c1 = await connectWs(`${bus.wsUrl}/?token=${bus.token}`, {
        origin: `chrome-extension://${DEFAULT_EXTENSION_ID}`
      });
      assert.equal(c1.ok, true);
      ws1 = c1.ws;

      ws1.on('message', (raw) => {
        const msg = JSON.parse(raw.toString('utf8'));
        if (msg.type === 'command') {
          if (msg.command?.action === 'hang_cmd') return;
          if (msg.command?.action === 'fail_cmd') {
            ws1.send(JSON.stringify({ type: 'command_result', commandId: msg.commandId, ok: false, error: 'boom' }));
          } else {
            ws1.send(
              JSON.stringify({
                type: 'command_result',
                commandId: msg.commandId,
                ok: true,
                result: { echo: msg.command, tabId: msg.tabId }
              })
            );
          }
        }
      });

      const waitHello = bus.waitForEvent(0, 2000);
      ws1.send(JSON.stringify({
        type: 'hello',
        tabId: 101,
        url: 'http://localhost:5173/player',
        title: 'Sonora\x00Player',
        viewport: { width: 1440, height: 900 }
      }));
      const helloEv = await waitHello;
      assert.equal(helloEv.timedOut, false);
      assert.equal(helloEv.events[0].type, 'tab_hello');
      assert.equal(helloEv.events[0].title, 'SonoraPlayer');

      // Second tab connects via x-swarm-token header
      const c2 = await connectWs(`${bus.wsUrl}/`, { 'x-swarm-token': bus.token });
      assert.equal(c2.ok, true);
      ws2 = c2.ws;
      ws2.send(JSON.stringify({ type: 'hello', tabId: 202, url: 'http://localhost:5173/settings' }));

      // Wait until tab 202 registers
      await bus.waitForEvent(helloEv.seq, 2000);

      const sel = await rpc(bus, 'tabs.select', { tabId: 202 });
      assert.equal(sel.status, 200);
      assert.equal(sel.body.result.selectedTabId, 202);

      // dispatchToTab direct & via /rpc
      const cmdRes = await rpc(bus, 'tab.command', {
        tabId: 101,
        command: { action: 'run_audit', checks: ['overflow'] }
      });
      assert.equal(cmdRes.status, 200);
      assert.deepEqual(cmdRes.body.result.echo, { action: 'run_audit', checks: ['overflow'] });

      await assert.rejects(() => bus.dispatchToTab(101, { action: 'fail_cmd' }), /boom/);
      await assert.rejects(() => bus.dispatchToTab(101, { action: 'hang_cmd' }, 30), /timed out/i);
      await assert.rejects(() => bus.dispatchToTab(9999, { action: 'ping' }), /not connected/i);

      // Sanitized finding_event + waitForEvent wakeup
      const seqPreFinding = (await rpc(bus, 'session.status')).body.result.seq;
      const waitFinding = bus.waitForEvent(seqPreFinding, 2000);
      ws1.send(JSON.stringify({
        type: 'finding_event',
        tabId: 101,
        selector: '.btn\x00',
        details: JSON.parse('{"__proto__":{"polluted":true},"note":"bad\\u0007text"}')
      }));
      const findingEv = (await waitFinding).events.at(-1);
      assert.equal(findingEv.type, 'finding_event');
      assert.equal(findingEv.untrustedPageData, true);
      assert.equal(findingEv.selector, '.btn');
      assert.deepEqual(findingEv.details, { note: 'badtext' });
      assert.equal({}.polluted, undefined);

      // requireLock enforces active lock before mutating tab.command
      const unlockFail = await rpc(bus, 'tab.command', {
        tabId: 101,
        agentId: 'qa-1',
        requireLock: true,
        command: { action: 'click', selector: '#play' }
      });
      assert.equal(unlockFail.status, 400);

      // waitForEvent wakes up on route_changed and times out cleanly when idle
      const statusBefore = await rpc(bus, 'session.status');
      const seqBefore = statusBefore.body.result.seq;
      const awaitPromise = rpc(bus, 'events.await', { sinceSeq: seqBefore, timeoutMs: 2000 });
      ws1.send(JSON.stringify({
        type: 'route_changed',
        tabId: 101,
        url: 'http://localhost:5173/album/9',
        pathname: '/album/9'
      }));
      const awaited = await awaitPromise;
      assert.equal(awaited.status, 200);
      assert.equal(awaited.body.result.timedOut, false);
      assert.equal(awaited.body.result.events.at(-1).pathname, '/album/9');

      const idle = await bus.waitForEvent(awaited.body.result.seq, 40);
      assert.equal(idle.timedOut, true);
      assert.deepEqual(idle.events, []);

      // Locks & ticket lifecycle via /rpc
      const l1 = await rpc(bus, 'lock.acquire', { agentId: 'qa-1', tabId: 101, scope: 'interaction' });
      assert.equal(l1.status, 200);
      const l2 = await rpc(bus, 'lock.acquire', { agentId: 'qa-2', tabId: 101, scope: 'interaction' });
      assert.equal(l2.status, 409);
      const mutBlocked = await rpc(bus, 'tab.command', {
        tabId: 101,
        agentId: 'qa-2',
        command: { action: 'click', selector: '#play' }
      });
      assert.equal(mutBlocked.status, 409);
      const rel = await rpc(bus, 'lock.release', { agentId: 'qa-1', tabId: 101 });
      assert.equal(rel.status, 200);
      assert.equal(rel.body.result.released, true);

      const created = await rpc(bus, 'tickets.create', {
        tabId: 101,
        pathname: '/album/9',
        viewport: { width: 390, height: 844 },
        description: 'Play button overflow'
      });
      assert.equal(created.status, 200);
      const tid = created.body.result.id;

      const list = await rpc(bus, 'tickets.list', { tabId: 101, viewportWidth: 390 });
      assert.equal(list.body.result.length, 1);

      const claimed = await rpc(bus, 'tickets.claim', { ticketIds: [tid], devAgentId: 'dev-1' });
      assert.equal(claimed.body.result[0].status, 'claimed');

      const fixed = await rpc(bus, 'tickets.markFixed', {
        ticketIds: [tid],
        devAgentId: 'dev-1',
        summary: 'Wrapped flex row'
      });
      assert.equal(fixed.body.result[0].status, 'awaiting_reverify');

      const verified = await rpc(bus, 'tickets.verify', {
        id: tid,
        agentId: 'qa-1',
        passed: true,
        evidence: 'scrollWidth === clientWidth'
      });
      assert.equal(verified.body.result.status, 'verified');
    } finally {
      ws1?.close();
      ws2?.close();
      if (bus) await bus.close();
      tmp.cleanup();
    }
  });

  it('starts via cli-bus.mjs without leaking full token and serves /health', async () => {
    const tmp = makeTempRegistry('swarm-cli-test-');
    const child = spawn(
      process.execPath,
      ['packages/core/src/cli-bus.mjs', '--port', '0', '--registry', tmp.registryPath],
      { cwd: process.cwd(), env: { ...process.env, SWARM_REGISTRY_PATH: tmp.registryPath }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      const stdoutLine = await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error(`cli-bus startup timeout: ${buf}`)), 5000);
        child.stdout.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const nl = buf.indexOf('\n');
          if (nl !== -1) {
            clearTimeout(timer);
            resolve(buf.slice(0, nl).trim());
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`cli-bus exited early (${code}): ${buf}`));
        });
      });

      const info = JSON.parse(stdoutLine);
      assert.equal(info.ok, true);
      assert.ok(Number.isInteger(info.port) && info.port > 0);
      assert.equal(info.registryPath, tmp.registryPath);
      assert.equal(info.token, undefined);

      const reg = readBusRegistry(tmp.registryPath);
      assert.equal(reg.port, info.port);
      assert.ok(!stdoutLine.includes(reg.token));

      const health = await fetch(`http://127.0.0.1:${info.port}/health`);
      assert.equal(health.status, 200);
    } finally {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
      tmp.cleanup();
    }
  });
});
