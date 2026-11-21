(() => {
  'use strict';

  const CTRL_RE = /[\u0000-\u001F\u007F-\u009F\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
  const state = (globalThis.__swarmQaContentState ||= { overlay: null, listenerBound: false });
  const factory = () => globalThis.__swarmQaOverlayFactory;
  const viewportNow = () => ({
    width: window.innerWidth || document.documentElement?.clientWidth || 0,
    height: window.innerHeight || document.documentElement?.clientHeight || 0
  });
  const clean = (v, max = 280) => {
    const f = factory();
    if (f?.sanitizeText) return f.sanitizeText(v, max);
    return String(v ?? '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(CTRL_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  };
  const normUrl = (raw) => {
    try {
      return new URL(String(raw ?? ''), location.href).href;
    } catch {
      return String(raw ?? '');
    }
  };
  const findingKey = (x) => {
    const act = String(x?.actual || '').replace(/^(HTTP\s+\d{3}\s+)(\S+)/, (_, p, u) => `${p}${normUrl(u)}`);
    return `${x?.ruleId}|${act}`;
  };
  const isProtected = (el) => Boolean(el.closest?.('#__swarm_qa_overlay') || el.closest?.('#__antigravity_native_browser_ui'));

  function querySafe(selector) {
    if (!selector || typeof selector !== 'string') return { el: null, error: 'Element not found: (empty)' };
    try {
      return { el: document.querySelector(selector), error: null };
    } catch {
      return { el: null, error: `Invalid selector: ${clean(selector, 120)}` };
    }
  }

  function safeSend(payload) {
    try {
      chrome.runtime.sendMessage(payload)?.catch?.(() => {});
    } catch {}
  }

  function mountOverlay(nonce = '') {
    const f = factory();
    if (!f?.mountSwarmOverlay) return { ok: false, error: 'Overlay factory not loaded' };
    state.overlay?.destroy?.();
    state.overlay = f.mountSwarmOverlay({
      doc: document,
      win: window,
      nonce,
      onEvent: (ev) => {
        if (ev?.type === 'route_change')
          safeSend({
            type: 'route_changed',
            pathname: clean(ev.pathname),
            url: clean(location.href, 1024),
            title: clean(document.title),
            viewport: viewportNow()
          });
        else if (ev) safeSend({ type: 'overlay_event', event: ev });
      },
      onAction: (action) => safeSend({ type: 'overlay_action', action })
    });
    return {
      ok: true,
      url: clean(location.href, 1024),
      pathname: clean(location.pathname || '/'),
      title: clean(document.title),
      viewport: viewportNow(),
      probeSource: state.overlay.probeSource()
    };
  }

  function resolveTarget(selector, focus = false, scroll = true) {
    const f = factory(),
      { el, error } = querySafe(selector);
    if (error) return { ok: false, error };
    if (!el || isProtected(el)) return { ok: false, error: `Element not found: ${clean(selector, 120)}` };
    if (scroll) el.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { ok: false, error: `Element has zero bounding box: ${clean(selector, 120)}` };
    if (focus) el.focus?.({ preventScroll: true });
    return {
      ok: true,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      selector: f ? f.buildSelector(el) : clean(selector)
    };
  }

  function fillElement(selector, value, clear = true) {
    const f = factory(),
      { el, error } = querySafe(selector);
    if (error) return { ok: false, error };
    if (!el || isProtected(el)) return { ok: false, error: `Element not found: ${clean(selector, 120)}` };
    const tag = String(el.tagName || '').toLowerCase(),
      type = String(el.getAttribute?.('type') ?? el.type ?? 'text')
        .trim()
        .toLowerCase();
    const sensitive = tag === 'input' && (type === 'password' || type === 'hidden'),
      text = value == null ? '' : String(value);
    const shouldClear = clear !== false;
    if (type !== 'hidden') {
      el.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
      el.focus?.({ preventScroll: true });
    }
    let nextValue;
    if (el.isContentEditable) {
      nextValue = shouldClear ? text : `${el.textContent || ''}${text}`;
      el.textContent = nextValue;
    } else {
      nextValue = shouldClear ? text : `${el.value ?? ''}${text}`;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) setter.call(el, nextValue);
      else el.value = nextValue;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      ok: true,
      filled: true,
      selector: f ? f.buildSelector(el) : clean(selector),
      sensitive,
      value: sensitive ? '[redacted]' : clean(nextValue, 280),
      untrustedPageData: true
    };
  }

  function runAuditWithLogs(cmd = {}, cdpLogs = []) {
    const f = factory();
    const res = state.overlay.runAudit({
      checks: cmd.checks,
      viewport: cmd.viewport,
      clearConsole: Boolean(cmd.clearConsole),
      animate: cmd.animate !== false,
      follow: Boolean(cmd.follow)
    });
    const allowConsole = !Array.isArray(cmd.checks) || !cmd.checks.length || cmd.checks.includes('console-net');
    if (allowConsole && Array.isArray(cdpLogs) && cdpLogs.length && f?.runDomAudit) {
      const normLogs = cdpLogs.map((l) => (l?.url ? { ...l, url: normUrl(l.url) } : l));
      const extra = f.runDomAudit({ doc: null, checks: ['console-net'], consoleEntries: normLogs });
      const seen = new Set(res.findings.map(findingKey));
      for (const item of extra) {
        const k = findingKey(item);
        if (!seen.has(k)) {
          seen.add(k);
          res.findings.push(item);
        }
      }
    }
    return { ok: true, ...res, url: clean(location.href, 1024), untrustedPageData: true };
  }

  function handleMessage(msg) {
    const cmd = msg?.command && typeof msg.command === 'object' ? msg.command : msg || {};
    if (msg?.type === 'init_overlay') return mountOverlay(msg.nonce || '');
    if (msg?.type === 'destroy_overlay') {
      state.overlay?.destroy?.();
      state.overlay = null;
      return { ok: true };
    }
    if (msg?.type === 'resolve_rect') return resolveTarget(msg.selector, Boolean(msg.focus), msg.scroll !== false);
    if (msg?.type === 'fill_element') return fillElement(msg.selector, msg.value, msg.clear);
    if (!state.overlay) return { ok: false, error: 'Overlay is not mounted on this tab' };
    if (msg?.type === 'clear_console') {
      state.overlay.clearConsole();
      return { ok: true };
    }
    if (msg?.type === 'run_audit') return runAuditWithLogs(cmd, msg.cdpLogs);
    // Everything else is an overlay command (cursors, tickets, tour, patches…); unknown ones fail closed.
    return state.overlay.exec(String(msg?.type ?? ''), cmd);
  }

  if (!state.listenerBound) {
    state.listenerBound = true;
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      try {
        sendResponse(handleMessage(msg));
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return false;
    });
  }
})();
