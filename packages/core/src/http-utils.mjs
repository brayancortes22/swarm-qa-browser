import { timingSafeEqual } from 'node:crypto';

export const MAX_BODY_BYTES = 1024 * 1024;

/** Error carrying an HTTP status and a machine-readable code for RPC responses. */
export function httpError(message, statusCode = 400, code = 'RPC_ERROR') {
  return Object.assign(new Error(message), { statusCode, code });
}

/** Constant-time comparison for secrets (tokens, pairing codes). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function parseRequestUrl(raw) {
  try {
    return new URL(raw || '/', 'http://127.0.0.1');
  } catch {
    return null;
  }
}

/** CORS headers echoed only for origins that already passed the allowlist. */
export function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, x-swarm-token, x-swarm-pair-code',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'Origin'
  };
}

export function sendJson(res, status, data, origin, allowCors) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(allowCors ? corsHeaders(origin) : {})
  };
  res.writeHead(status, headers).end(JSON.stringify(data));
}

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw httpError('Request body too large', 413, 'PAYLOAD_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw httpError('Invalid JSON body', 400, 'INVALID_JSON');
  }
}

/** Listens on a loopback host; optionally falls back to an ephemeral port when the port is busy. */
export function listenLoopback(server, port, host, autoFallbackPort) {
  return new Promise((resolve, reject) => {
    const bind = (target, canFallback) => {
      server.once('error', (err) => {
        if (err?.code === 'EADDRINUSE' && canFallback && target !== 0) bind(0, false);
        else reject(err);
      });
      server.listen(target, host, () => resolve(server.address().port));
    };
    bind(port, autoFallbackPort);
  });
}

/** Sliding-window failure limiter (used to throttle pairing-code guesses). */
export function createFailureLimiter({ maxFailures = 5, windowMs = 60_000, now = () => Date.now() } = {}) {
  let failures = [];
  const prune = () => {
    failures = failures.filter((at) => now() - at < windowMs);
  };
  return {
    blocked() {
      prune();
      return failures.length >= maxFailures;
    },
    fail() {
      prune();
      failures.push(now());
    },
    reset() {
      failures = [];
    }
  };
}
