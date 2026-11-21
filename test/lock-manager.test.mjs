import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LockManager } from '../packages/core/src/lock-manager.mjs';
import {
  DEFAULT_EXTENSION_ID,
  DEFAULT_PORT,
  acquireRegistryLock,
  clearBusRegistryIfOwned,
  createToken,
  getRegistryPath,
  isAllowedOrigin,
  isPidAlive,
  readBusRegistry,
  writeBusRegistry
} from '../packages/core/src/session-auth.mjs';

describe('LockManager', () => {
  it('enforces mutual exclusion, idempotent renewal, release ownership, and TTL takeover', () => {
    let clock = 1000;
    const locks = new LockManager({ now: () => clock });

    const initial = locks.acquire({ agentId: 'qa-1', scope: 'interaction', tabId: 42, ttlMs: 5000 });
    assert.equal(initial.locked, true);
    assert.equal(initial.agentId, 'qa-1');
    assert.equal(initial.remainingMs, 5000);

    // Same agent can renew idempotently and extend TTL (and preserves scope if omitted)
    clock = 3000;
    const renewed = locks.acquire({ agentId: 'qa-1', scope: 'viewport', tabId: 42, ttlMs: 10000 });
    assert.equal(renewed.scope, 'viewport');
    assert.equal(renewed.expiresAt, 13000);
    const heartbeat = locks.acquire({ agentId: 'qa-1', tabId: 42, ttlMs: 10000 });
    assert.equal(heartbeat.scope, 'viewport');

    // Competing agent is blocked with holder and remaining ms
    assert.throws(() => locks.acquire({ agentId: 'qa-2', tabId: 42 }), /qa-1.*10000\s*ms/i);
    assert.throws(() => locks.assertCanMutate({ agentId: 'qa-2', tabId: 42 }), /qa-1/);
    assert.throws(() => locks.release({ agentId: 'qa-2', tabId: 42 }), /qa-1/);
    assert.equal(locks.assertCanMutate({ agentId: 'qa-1', tabId: 42 }).agentId, 'qa-1');

    // Past TTL expiry, competing agent can take over cleanly
    clock = 13001;
    assert.equal(locks.status(42).locked, false);
    const takenOver = locks.acquire({ agentId: 'qa-2', tabId: 42, ttlMs: 4000 });
    assert.equal(takenOver.agentId, 'qa-2');

    // Holder can release so another agent can acquire immediately
    const rel = locks.release({ agentId: 'qa-2', tabId: 42 });
    assert.equal(rel.released, true);
    assert.throws(() => locks.assertCanMutate({ agentId: 'qa-2', tabId: 42 }), /no active/i);
  });
});

describe('session-auth', () => {
  it('validates allowed origins and rejects external/spoofed origins', () => {
    assert.equal(DEFAULT_PORT, 47921);
    assert.equal(DEFAULT_EXTENSION_ID, 'jgfhckehijkedmcellcjglbnibgccifg');
    assert.match(createToken(), /^[0-9a-f]{48}$/);

    assert.equal(isAllowedOrigin(undefined), true);
    assert.equal(isAllowedOrigin(''), true);
    assert.equal(isAllowedOrigin('http://localhost'), true);
    assert.equal(isAllowedOrigin('http://localhost:5173'), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1:47921'), true);
    assert.equal(isAllowedOrigin(`chrome-extension://${DEFAULT_EXTENSION_ID}`), true);

    assert.equal(isAllowedOrigin('null'), false);
    assert.equal(isAllowedOrigin('https://evil.example'), false);
    assert.equal(isAllowedOrigin('http://localhost.evil.com'), false);
    assert.equal(isAllowedOrigin('http://127.0.0.1.evil.com'), false);
    assert.equal(isAllowedOrigin('https://localhost:5173'), false);
    assert.equal(isAllowedOrigin('http://localhost:99999'), false);
    assert.equal(isAllowedOrigin('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false);
  });

  it('resolves registry path and safely replaces stale dead-PID registry files', () => {
    const prevEnv = process.env.SWARM_REGISTRY_PATH;
    const tempDir = mkdtempSync(join(tmpdir(), 'swarm-qa-auth-'));
    const regPath = join(tempDir, 'bus.json');

    try {
      process.env.SWARM_REGISTRY_PATH = regPath;
      assert.equal(getRegistryPath(), regPath);
      delete process.env.SWARM_REGISTRY_PATH;
      assert.ok(getRegistryPath().endsWith(join('.swarm-qa-browser', 'bus.json')));

      assert.equal(isPidAlive(process.pid), true);
      assert.equal(isPidAlive(99999999), false);

      // Seed stale registry with dead PID -> acquireRegistryLock replaces it safely
      writeFileSync(regPath, JSON.stringify({ pid: 99999999, port: 47921, token: 'stale' }), 'utf8');
      const acquired = acquireRegistryLock(
        { pid: process.pid, port: 47922, token: 'fresh-token', extensionId: DEFAULT_EXTENSION_ID },
        regPath
      );
      assert.equal(acquired.port, 47922);
      assert.equal(readBusRegistry(regPath).token, 'fresh-token');

      // Live PID lock cannot be overwritten by acquireRegistryLock
      assert.throws(() => acquireRegistryLock({ pid: process.pid + 1, port: 47923, token: 'hijack' }, regPath), /already/i);

      // writeBusRegistry updates metadata and clearBusRegistryIfOwned only clears owned PID
      writeBusRegistry({ pid: process.pid, port: 47922, token: 'updated' }, regPath);
      assert.equal(readBusRegistry(regPath).token, 'updated');
      assert.equal(clearBusRegistryIfOwned(99999999, regPath), false);
      assert.ok(readBusRegistry(regPath) !== null);
      assert.equal(clearBusRegistryIfOwned(process.pid, regPath), true);
      assert.equal(readBusRegistry(regPath), null);
    } finally {
      if (prevEnv !== undefined) {
        process.env.SWARM_REGISTRY_PATH = prevEnv;
      } else {
        delete process.env.SWARM_REGISTRY_PATH;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
