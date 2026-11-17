function assertAgentAndTab(agentId, tabId) {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('agentId is required for lock operations');
  }
  if (tabId === undefined || tabId === null || tabId === '') {
    throw new Error('tabId is required for lock operations');
  }
}

function lockHeldError(lock, now) {
  const remainingMs = Math.max(1, lock.expiresAt - now);
  const err = new Error(
    `Tab ${lock.tabId} is locked by "${lock.agentId}" (scope: ${lock.scope}, ${remainingMs}ms remaining)`
  );
  err.code = 'LOCK_HELD';
  err.holder = lock.agentId;
  err.remainingMs = remainingMs;
  return err;
}

function snapshotLock(lock, now) {
  return {
    locked: true,
    tabId: lock.tabId,
    agentId: lock.agentId,
    scope: lock.scope,
    acquiredAt: lock.acquiredAt,
    expiresAt: lock.expiresAt,
    remainingMs: Math.max(0, lock.expiresAt - now)
  };
}

/**
 * Per-tab exclusive mutation/viewport lock manager with TTL expiration and idempotent renewal.
 */
export class LockManager {
  #locks = new Map();
  #now;

  constructor({ now = () => Date.now() } = {}) {
    this.#now = now;
  }

  pruneExpired() {
    const now = this.#now();
    let pruned = 0;
    for (const [tabId, lock] of this.#locks.entries()) {
      if (lock.expiresAt <= now) {
        this.#locks.delete(tabId);
        pruned += 1;
      }
    }
    return pruned;
  }

  acquire({ agentId, scope, tabId, ttlMs = 15000 } = {}) {
    assertAgentAndTab(agentId, tabId);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('ttlMs must be a positive finite number');
    }
    this.pruneExpired();
    const now = this.#now();
    const existing = this.#locks.get(tabId);

    if (existing && existing.agentId !== agentId) {
      throw lockHeldError(existing, now);
    }

    const lock = {
      tabId,
      agentId,
      scope: String(scope ?? existing?.scope ?? 'interaction'),
      acquiredAt: existing ? existing.acquiredAt : now,
      expiresAt: now + ttlMs
    };
    this.#locks.set(tabId, lock);
    return snapshotLock(lock, now);
  }

  release({ agentId, tabId } = {}) {
    assertAgentAndTab(agentId, tabId);
    this.pruneExpired();
    const existing = this.#locks.get(tabId);
    if (!existing) {
      return { released: false, tabId };
    }
    if (existing.agentId !== agentId) {
      throw lockHeldError(existing, this.#now());
    }
    this.#locks.delete(tabId);
    return { released: true, tabId, agentId };
  }

  status(tabId) {
    this.pruneExpired();
    const now = this.#now();
    if (tabId === undefined || tabId === null) {
      return Array.from(this.#locks.values(), (lock) => snapshotLock(lock, now));
    }
    const existing = this.#locks.get(tabId);
    if (!existing) {
      return { locked: false, tabId, agentId: null, scope: null, remainingMs: 0 };
    }
    return snapshotLock(existing, now);
  }

  assertCanMutate({ agentId, tabId } = {}) {
    assertAgentAndTab(agentId, tabId);
    this.pruneExpired();
    const now = this.#now();
    const existing = this.#locks.get(tabId);
    if (!existing) {
      throw new Error(`Tab ${tabId} has no active mutation lock; agent "${agentId}" must acquire lock first`);
    }
    if (existing.agentId !== agentId) {
      throw lockHeldError(existing, now);
    }
    return snapshotLock(existing, now);
  }
}
