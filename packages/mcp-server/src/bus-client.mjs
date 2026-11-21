import { getRegistryPath, isLoopbackHost, readBusRegistry } from '../../core/src/session-auth.mjs';
import { startSwarmBus } from '../../core/src/swarm-bus.mjs';

const HEALTH_TIMEOUT_MS = 1500;

/** Minimal authenticated JSON-RPC client for the local bus. */
export function createHttpBusClient(url, token) {
  return {
    async rpc(action, params = {}) {
      const res = await fetch(`${url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-swarm-token': token },
        body: JSON.stringify({ action, params })
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw Object.assign(new Error(data?.error || `RPC ${action} failed`), { code: data?.code || 'RPC_ERROR', statusCode: res.status });
      }
      return data.result;
    }
  };
}

async function isBusAlive(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok && Boolean((await res.json())?.ok);
  } catch {
    return false;
  }
}

/**
 * Finds a running bus through the registry file, or starts an embedded one when none answers.
 * Returns `{ client, ownedBus }`; `ownedBus` is set only when this process must close it.
 */
export async function resolveBus(registryPath, busClient) {
  if (typeof busClient?.rpc === 'function') return { client: busClient, ownedBus: null };
  if (busClient?.url && busClient?.token) return { client: createHttpBusClient(busClient.url, busClient.token), ownedBus: null };

  const regPath = registryPath || getRegistryPath();
  const registry = readBusRegistry(regPath);
  if (registry?.port && registry?.token) {
    const host = String(registry.host || '127.0.0.1')
      .trim()
      .toLowerCase();
    const port = Number(registry.port);
    if (!isLoopbackHost(host)) throw new Error(`Refusing non-loopback bus host: ${host}`);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      const url = `http://${host === '::1' ? '[::1]' : host}:${port}`;
      if (await isBusAlive(url)) return { client: createHttpBusClient(url, registry.token), ownedBus: null };
    }
  }
  const bus = await startSwarmBus({ registryPath: regPath });
  return { client: createHttpBusClient(bus.url, bus.token), ownedBus: bus };
}
