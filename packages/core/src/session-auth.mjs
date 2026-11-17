import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_EXTENSION_ID = 'jgfhckehijkedmcellcjglbnibgccifg';
export const DEFAULT_PORT = 47921;

const LOCAL_HTTP_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/;

/**
 * Resolves the active bus registry path from SWARM_REGISTRY_PATH or the user home directory.
 */
export function getRegistryPath() {
  const override = process.env.SWARM_REGISTRY_PATH?.trim();
  return override || join(homedir(), '.swarm-qa-browser', 'bus.json');
}

/**
 * Generates a 24-byte random hex bearer token for local bus authentication.
 */
export function createToken() {
  return randomBytes(24).toString('hex');
}

/**
 * Checks whether an Origin header is permitted to connect to the local swarm bus.
 */
export function isAllowedOrigin(origin, allowedExtensionId = DEFAULT_EXTENSION_ID) {
  if (origin === undefined || origin === null || origin === '') return true;
  if (typeof origin !== 'string') return false;

  if (allowedExtensionId && typeof allowedExtensionId === 'string' && !allowedExtensionId.includes('/')) {
    if (origin === `chrome-extension://${allowedExtensionId}`) return true;
  }

  const match = LOCAL_HTTP_ORIGIN_RE.exec(origin);
  if (!match) return false;
  if (!match[2]) return true;
  const port = Number(match[2]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Checks whether a numeric process ID currently exists.
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Reads and parses the bus registry JSON file, returning null if missing or corrupt.
 */
export function readBusRegistry(registryPath = getRegistryPath()) {
  if (!existsSync(registryPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Atomically writes bus discovery metadata to disk with owner-only permissions.
 */
export function writeBusRegistry(info, registryPath = getRegistryPath()) {
  const payload = { ...info };
  mkdirSync(dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, registryPath);
    return payload;
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure for temp file.
    }
    throw err;
  }
}

/**
 * Exclusively acquires the bus registry file, replacing stale dead-PID entries safely.
 */
export function acquireRegistryLock(info, registryPath = getRegistryPath()) {
  const payload = { ...info, pid: info?.pid ?? process.pid };
  mkdirSync(dirname(registryPath), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(registryPath, JSON.stringify(payload, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      });
      return payload;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const existing = readBusRegistry(registryPath);
      if (existing?.pid && isPidAlive(existing.pid)) {
        throw new Error(
          `Swarm bus registry already held by live PID ${existing.pid} (port ${existing.port ?? 'unknown'})`
        );
      }
      try {
        unlinkSync(registryPath);
      } catch (unlinkErr) {
        if (unlinkErr?.code !== 'ENOENT') throw unlinkErr;
      }
    }
  }
  throw new Error('Failed to acquire swarm bus registry lock after stale cleanup');
}

/**
 * Removes the registry file only if it is still owned by the given PID.
 */
export function clearBusRegistryIfOwned(pid = process.pid, registryPath = getRegistryPath()) {
  const existing = readBusRegistry(registryPath);
  if (!existing || existing.pid !== pid) return false;
  try {
    unlinkSync(registryPath);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}
