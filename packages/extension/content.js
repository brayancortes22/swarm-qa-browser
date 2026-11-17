(() => {
  'use strict';

  const state = (globalThis.__swarmQaContentState ||= { overlay: null, listenerBound: false });
  const factory = () => globalThis.__swarmQaOverlayFactory;
  const viewportNow = () => ({ width: window.innerWidth || document.documentElement?.clientWidth || 0, height: window.innerHeight || document.documentElement?.clientHeight || 0 });

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
        if (ev?.type === 'route_change') safeSend({ type: 'route_changed', pathname: ev.pathname, url: location.href, title: f.sanitizeText(document.title), viewport: viewportNow() });
        else if (ev) safeSend({ type: 'overlay_event', event: ev });
      },
      onAction: (action) => safeSend({ type: 'overlay_action', action })
    });
    return { ok: true, url: location.href, pathname: location.pathname || '/', title: f.sanitizeText(document.title), viewport: viewportNow(), probeSource: state.overlay.probeSource() };
  }

  function resolveTarget(selector, focus = false) {
    const f = factory(), el = selector ? document.querySelector(selector) : null;
    if (!el || el.closest?.('#__swarm_qa_overlay')) return { ok: false, error: `Element not found: ${selector || '(empty)'}` };
    el.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { ok: false, error: `Element has zero bounding box: ${selector}` };
    if (focus) el.focus?.({ preventScroll: true });
    return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, selector: f ? f.buildSelector(el) : selector };
  }

  function fillElement(selector, value) {
    const f = factory(), el = selector ? document.querySelector(selector) : null;
    if (!el || el.closest?.('#__swarm_qa_overlay')) return { ok: false, error: `Element not found: ${selector || '(empty)'}` };
    const tag = String(el.tagName || '').toLowerCase(), type = String(el.getAttribute?.('type') ?? el.type ?? 'text').trim().toLowerCase();
    const sensitive = tag === 'input' && (type === 'password' || type === 'hidden'), text = value == null ? '' : String(value);
    if (type !== 'hidden') { el.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' }); el.focus?.({ preventScroll: true }); }
    if (el.isContentEditable) el.textContent = text;
    else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) setter.call(el, text); else el.value = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, filled: true, selector: f ? f.buildSelector(el) : selector, sensitive, value: sensitive ? '[redacted]' : (f ? f.sanitizeText(text, 280) : text.slice(0, 280)), untrustedPageData: true };
  }

  function runAuditWithLogs(cmd = {}, cdpLogs = []) {
    const f = factory(), res = state.overlay.runAudit({ checks: cmd.checks, viewport: cmd.viewport });
    const allowConsole = !Array.isArray(cmd.checks) || !cmd.checks.length || cmd.checks.includes('console-net');
    if (allowConsole && Array.isArray(cdpLogs) && cdpLogs.length && f?.runDomAudit) {
      const extra = f.runDomAudit({ doc: null, checks: ['console-net'], consoleEntries: cdpLogs });
      const seen = new Set(res.findings.map((x) => `${x.ruleId}|${x.actual}`));
      for (const item of extra) if (!seen.has(`${item.ruleId}|${item.actual}`)) { seen.add(`${item.ruleId}|${item.actual}`); res.findings.push(item); }
    }
    return { ok: true, ...res, url: location.href, untrustedPageData: true };
  }

  function handleMessage(msg) {
    const cmd = msg?.command && typeof msg.command === 'object' ? msg.command : (msg || {});
    if (msg?.type === 'init_overlay') return mountOverlay(msg.nonce || '');
    if (msg?.type === 'destroy_overlay') { state.overlay?.destroy?.(); state.overlay = null; return { ok: true }; }
    if (msg?.type === 'resolve_rect') return resolveTarget(msg.selector, Boolean(msg.focus));
    if (msg?.type === 'fill_element') return fillElement(msg.selector, msg.value);
    if (!state.overlay) return { ok: false, error: 'Overlay is not mounted on this tab' };
    switch (msg?.type) {
      case 'spawn_cursors': return { ok: true, count: state.overlay.spawnCursors(cmd.cursors ? cmd : (Array.isArray(cmd.agents) ? { cursors: cmd.agents, clear: cmd.clear } : cmd)) };
      case 'move_cursor': state.overlay.moveCursor(cmd.cursor ?? cmd); return { ok: true };
      case 'remove_cursor': state.overlay.removeCursor(cmd.id ?? msg.id); return { ok: true };
      case 'set_tickets': {
        const list = Array.isArray(cmd.tickets) ? cmd.tickets : (Array.isArray(msg.tickets) ? msg.tickets : []);
        state.overlay.setTickets(list, cmd.pathname);
        const counts = list.reduce((a, t) => ((a[t?.status] = (a[t?.status] || 0) + 1), a), {});
        state.overlay.updateSummary(cmd.summary || { open: (counts.open || 0) + (counts.reopened || 0), awaiting_reverify: counts.awaiting_reverify || 0, verified: counts.verified || 0 });
        return { ok: true, count: list.length };
      }
      case 'update_summary': state.overlay.updateSummary(cmd.summary ?? cmd); return { ok: true };
      case 'run_audit': return runAuditWithLogs(cmd, msg.cdpLogs);
      default: return { ok: false, error: `Unknown content command "${msg?.type}"` };
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
