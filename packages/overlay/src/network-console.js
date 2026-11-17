const CTRL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Returns a self-invoking MAIN-world probe script (~30 lines) forwarding console/network failures
 * via a nonce-scoped CustomEvent without altering page return values or rejections.
 */
export function MAIN_WORLD_PROBE_SOURCE(nonce) {
  const safeNonce = JSON.stringify(String(nonce ?? ''));
  return `(() => {
  const n = ${safeNonce}, k = '__swarm_qa_installed_' + n;
  if (!n || window[k]) return;
  window[k] = true;
  const CE = window.CustomEvent || CustomEvent;
  const cut = (v) => String(v == null ? '' : v).slice(0, 280);
  const emit = (kind, data) => {
    try { window.dispatchEvent(new CE('__swarm_qa_probe_' + n, { detail: Object.assign({ kind, ts: Date.now() }, data) })); } catch {}
  };
  const origError = console.error;
  console.error = function (...args) {
    try { emit('console.error', { message: cut(args.map((a) => a?.message || String(a)).join(' ')) }); } catch {}
    return origError.apply(this, args);
  };
  const origOnError = window.onerror;
  window.onerror = function (msg, src, line, col, err) {
    emit('error', { message: cut(err?.message || msg), source: cut(src), line: Number(line) || 0, col: Number(col) || 0 });
    return typeof origOnError === 'function' ? origOnError.apply(this, arguments) : false;
  };
  window.addEventListener('unhandledrejection', (ev) => {
    emit('unhandledrejection', { message: cut(ev?.reason?.message || ev?.reason || 'Unhandled rejection') });
  });
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = cut(typeof input === 'string' ? input : (input?.url ?? String(input ?? '')));
      const method = cut(init?.method || input?.method || 'GET').toUpperCase();
      return origFetch.apply(this, arguments).then(
        (res) => { if (res && res.status >= 400) emit('fetch', { url, method, status: res.status, ok: false }); return res; },
        (err) => { emit('fetch', { url, method, status: 0, message: cut(err?.message || err || 'Network error') }); throw err; }
      );
    };
  }
})();`;
}

function sanitizeDetail(raw) {
  const out = { untrustedPageData: true };
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (typeof v === 'string') {
      out[k] = v.replace(/[\r\n\t]+/g, ' ').replace(CTRL_RE, '').slice(0, 280);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Listens in the ISOLATED world for nonce-scoped probe events and stores sanitized entries.
 */
export function createConsoleCollector(optionsOrNonce = {}) {
  const opts = typeof optionsOrNonce === 'string' ? { nonce: optionsOrNonce } : (optionsOrNonce || {});
  const {
    targetWindow = typeof window !== 'undefined' ? window : undefined,
    nonce = '',
    maxEntries = 50
  } = opts;

  const limit = Math.max(1, Number(maxEntries) || 50);
  const eventName = `__swarm_qa_probe_${String(nonce ?? '')}`;
  const entries = [];

  function onProbe(ev) {
    entries.push(sanitizeDetail(ev?.detail));
    if (entries.length > limit) entries.splice(0, entries.length - limit);
  }

  targetWindow?.addEventListener?.(eventName, onProbe);

  return {
    getEntries: () => entries.slice(),
    clear: () => { entries.length = 0; },
    destroy: () => {
      targetWindow?.removeEventListener?.(eventName, onProbe);
      entries.length = 0;
    }
  };
}
