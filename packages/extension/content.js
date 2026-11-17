(() => {
  'use strict';

  const CTRL_RE = /[\u0000-\u001F\u007F-\u009F\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
  const state = (globalThis.__swarmQaContentState ||= { overlay: null, listenerBound: false });
  const factory = () => globalThis.__swarmQaOverlayFactory;
  const viewportNow = () => ({ width: window.innerWidth || document.documentElement?.clientWidth || 0, height: window.innerHeight || document.documentElement?.clientHeight || 0 });
  const clean = (v, max = 280) => {
    const f = factory();
    if (f?.sanitizeText) return f.sanitizeText(v, max);
    return String(v ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  };
  const normUrl = (raw) => {
    try { return new URL(String(raw ?? ''), location.href).href; } catch { return String(raw ?? ''); }
  };
  const findingKey = (x) => {
    const act = String(x?.actual || '').replace(/^(HTTP\s+\d{3}\s+)(\S+)/, (_, p, u) => `${p}${normUrl(u)}`);
    return `${x?.ruleId}|${act}`;
  };
  const isProtected = (el) => Boolean(el.closest?.('#__swarm_qa_overlay') || el.closest?.('#__antigravity_native_browser_ui'));

  function querySafe(selector) {
    if (!selector || typeof selector !== 'string') return { el: null, error: 'Element not found: (empty)' };
    try { return { el: document.querySelector(selector), error: null }; }
    catch { return { el: null, error: `Invalid selector: ${clean(selector, 120)}` }; }
  }

  function safeSend(payload) {
    try { chrome.runtime.sendMessage(payload)?.catch?.(() => {}); } catch {}
  }

  function mountOverlay(nonce = '') {
    const f = factory();
    if (!f?.mountSwarmOverlay) return { ok: false, error: 'Overlay factory not loaded' };
    state.overlay?.destroy?.();
    state.overlay = f.mountSwarmOverlay({
      doc: document, win: window, nonce,
      onEvent: (ev) => {
        if (ev?.type === 'route_change') safeSend({ type: 'route_changed', pathname: clean(ev.pathname), url: clean(location.href, 1024), title: clean(document.title), viewport: viewportNow() });
        else if (ev) safeSend({ type: 'overlay_event', event: ev });
      },
      onAction: (action) => safeSend({ type: 'overlay_action', action })
    });
    return { ok: true, url: clean(location.href, 1024), pathname: clean(location.pathname || '/'), title: clean(document.title), viewport: viewportNow(), probeSource: state.overlay.probeSource() };
  }

  function resolveTarget(selector, focus = false) {
    const f = factory(), { el, error } = querySafe(selector);
    if (error) return { ok: false, error };
    if (!el || isProtected(el)) return { ok: false, error: `Element not found: ${clean(selector, 120)}` };
    el.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { ok: false, error: `Element has zero bounding box: ${clean(selector, 120)}` };
    if (focus) el.focus?.({ preventScroll: true });
    return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, selector: f ? f.buildSelector(el) : clean(selector) };
  }

  function fillElement(selector, value, clear = true) {
    const f = factory(), { el, error } = querySafe(selector);
    if (error) return { ok: false, error };
    if (!el || isProtected(el)) return { ok: false, error: `Element not found: ${clean(selector, 120)}` };
    const tag = String(el.tagName || '').toLowerCase(), type = String(el.getAttribute?.('type') ?? el.type ?? 'text').trim().toLowerCase();
    const sensitive = tag === 'input' && (type === 'password' || type === 'hidden'), text = value == null ? '' : String(value);
    const shouldClear = clear !== false;
    if (type !== 'hidden') { el.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' }); el.focus?.({ preventScroll: true }); }
    let nextValue;
    if (el.isContentEditable) {
      nextValue = shouldClear ? text : `${el.textContent || ''}${text}`;
      el.textContent = nextValue;
    } else {
      nextValue = shouldClear ? text : `${el.value ?? ''}${text}`;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) setter.call(el, nextValue); else el.value = nextValue;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, filled: true, selector: f ? f.buildSelector(el) : clean(selector), sensitive, value: sensitive ? '[redacted]' : clean(nextValue, 280), untrustedPageData: true };
  }

  function runAuditWithLogs(cmd = {}, cdpLogs = []) {
    const f = factory();
    const res = state.overlay.runAudit({ checks: cmd.checks, viewport: cmd.viewport, clearConsole: Boolean(cmd.clearConsole) });
    const allowConsole = !Array.isArray(cmd.checks) || !cmd.checks.length || cmd.checks.includes('console-net');
    if (allowConsole && Array.isArray(cdpLogs) && cdpLogs.length && f?.runDomAudit) {
      const normLogs = cdpLogs.map((l) => (l?.url ? { ...l, url: normUrl(l.url) } : l));
      const extra = f.runDomAudit({ doc: null, checks: ['console-net'], consoleEntries: normLogs });
      const seen = new Set(res.findings.map(findingKey));
      for (const item of extra) {
        const k = findingKey(item);
        if (!seen.has(k)) { seen.add(k); res.findings.push(item); }
      }
    }
    return { ok: true, ...res, url: clean(location.href, 1024), untrustedPageData: true };
  }

  function handleMessage(msg) {
    const cmd = msg?.command && typeof msg.command === 'object' ? msg.command : (msg || {});
    if (msg?.type === 'init_overlay') return mountOverlay(msg.nonce || '');
    if (msg?.type === 'destroy_overlay') { state.overlay?.destroy?.(); state.overlay = null; return { ok: true }; }
    if (msg?.type === 'resolve_rect') return resolveTarget(msg.selector, Boolean(msg.focus));
    if (msg?.type === 'fill_element') return fillElement(msg.selector, msg.value, msg.clear);
    if (!state.overlay) return { ok: false, error: 'Overlay is not mounted on this tab' };
    switch (msg?.type) {
      case 'spawn_cursors': return { ok: true, count: state.overlay.spawnCursors(cmd.cursors ? cmd : (Array.isArray(cmd.agents) ? { cursors: cmd.agents, clear: cmd.clear } : cmd)) };
      case 'move_cursor': state.overlay.moveCursor(cmd.cursor ?? cmd); return { ok: true };
      case 'remove_cursor': state.overlay.removeCursor(cmd.id ?? msg.id); return { ok: true };
      case 'set_tickets': {
        const list = Array.isArray(cmd.tickets) ? cmd.tickets : (Array.isArray(msg.tickets) ? msg.tickets : []);
        state.overlay.setTickets(list, cmd.pathname, cmd.viewportWidth ?? window.innerWidth);
        const counts = list.reduce((a, t) => ((a[t?.status] = (a[t?.status] || 0) + 1), a), {});
        state.overlay.updateSummary(cmd.summary || { open: (counts.open || 0) + (counts.reopened || 0), awaiting_reverify: counts.awaiting_reverify || 0, verified: counts.verified || 0 });
        return { ok: true, count: list.length };
      }
      case 'update_summary': state.overlay.updateSummary(cmd.summary ?? cmd); return { ok: true };
      case 'clear_console': state.overlay.runAudit({ checks: ['__noop__'], clearConsole: true }); return { ok: true };
      case 'run_audit': return runAuditWithLogs(cmd, msg.cdpLogs);
      default: return { ok: false, error: `Unknown content command "${clean(msg?.type, 40)}"` };
    }
  }

  if (!state.listenerBound) {
    state.listenerBound = true;
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      try { sendResponse(handleMessage(msg)); } catch (err) { sendResponse({ ok: false, error: err?.message || String(err) }); }
      return false;
    });
  }
})();
