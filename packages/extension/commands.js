import { buildKeyEvent, clean } from './helpers.js';

const OVERLAY_CMDS = new Set(['spawn_cursors', 'move_cursor', 'remove_cursor', 'set_tickets', 'update_summary']);

export function createBusCommandHandler(ctx) {
  const { authorizedTabs, cdp, tabMsg, hasHostPermission, syncTabAfterNav, waitTabLoad, runAuditAndCache, sendWs, metaOf } = ctx;

  const COMMANDS = {
    run_audit: runAuditAndCache,
    async get_console_network(tabId, entry, cmd = {}) {
      const entries = cmd.clear ? entry.cdpLogs.splice(0) : entry.cdpLogs.slice();
      if (cmd.clear) await tabMsg(tabId, { type: 'clear_console' }).catch(() => {});
      return { entries, untrustedPageData: true };
    },
    async set_viewport(tabId, entry, cmd) {
      if (cmd.reset) {
        await cdp(tabId, 'Emulation.clearDeviceMetricsOverride');
        entry.viewport = null;
      } else {
        const w = Number(cmd.width) || 1440, h = Number(cmd.height) || 900;
        const mobile = cmd.mobile !== undefined ? Boolean(cmd.mobile) : w <= 480;
        await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
          width: w, height: h, deviceScaleFactor: Number(cmd.deviceScaleFactor) || (mobile ? 2 : 1), mobile
        });
        entry.viewport = { width: w, height: h };
      }
      sendWs({ type: 'route_changed', tabId, ...metaOf(entry) });
      return { ok: true, viewport: entry.viewport, reset: Boolean(cmd.reset) };
    },
    async click(tabId, _entry, cmd) {
      const r = cmd.selector
        ? await tabMsg(tabId, { type: 'resolve_rect', selector: cmd.selector })
        : { ok: true, x: Number(cmd.x), y: Number(cmd.y), selector: null };
      if (!r?.ok || !Number.isFinite(r.x) || !Number.isFinite(r.y)) throw new Error(r?.error || 'Invalid click target');
      const button = cmd.button || 'left', clickCount = Number(cmd.clickCount) || 1;
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp(tabId, 'Input.dispatchMouseEvent', type === 'mouseMoved' ? { type, x: r.x, y: r.y } : { type, x: r.x, y: r.y, button, clickCount });
      }
      return { clicked: true, x: r.x, y: r.y, selector: r.selector, trusted: true };
    },
    async fill(tabId, _entry, cmd) {
      const r = await tabMsg(tabId, { type: 'fill_element', selector: cmd.selector, value: cmd.value, clear: cmd.clear });
      if (!r?.ok) throw new Error(r?.error || 'Fill failed');
      return r.sensitive ? { ...r, value: '[redacted]' } : r;
    },
    async press_key(tabId, _entry, cmd) {
      if (cmd.selector) {
        const r = await tabMsg(tabId, { type: 'resolve_rect', selector: cmd.selector, focus: true });
        if (!r?.ok) throw new Error(r?.error || 'Key target not found');
      }
      const kp = buildKeyEvent(cmd.key, cmd.modifiers);
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...kp });
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...kp });
      return { pressed: true, key: kp.key };
    },
    async navigate(tabId, entry, cmd) {
      const raw = String(cmd.url || '').trim();
      if (!raw) throw new Error('Invalid navigation URL');
      const u = (raw.startsWith('/') || raw.startsWith('#') || raw.startsWith('?')) && entry.url ? new URL(raw, entry.url) : new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http/https URLs allowed');
      if (!(await hasHostPermission(u.href))) throw new Error(`Permiso de origen no concedido para navegar a ${u.origin}`);
      const sameDoc = String(entry.url || '').split('#')[0] === u.href.split('#')[0];
      if (!sameDoc) entry.cdpLogs.length = 0;
      const wait = sameDoc ? new Promise((r) => setTimeout(r, 150)) : waitTabLoad(tabId);
      const nav = await cdp(tabId, 'Page.navigate', { url: u.href });
      if (nav?.errorText) throw new Error(nav.errorText);
      await wait;
      if (!(await syncTabAfterNav(tabId))) throw new Error('Sesión desconectada tras navegación sin permiso');
      return { navigated: true, url: entry.url, pathname: entry.pathname };
    }
  };

  return async function handleBusCommand({ commandId, tabId, command = {} }) {
    try {
      const entry = authorizedTabs.get(tabId), action = command.action || command.type;
      if (!entry) throw new Error(`Tab ${tabId} is not authorized`);
      const result = OVERLAY_CMDS.has(action)
        ? await tabMsg(tabId, { type: action, command }).then((r) => { if (r?.ok === false) throw new Error(r.error || 'Overlay failed'); return r; })
        : Object.hasOwn(COMMANDS, action) ? await COMMANDS[action](tabId, entry, command) : (() => { throw new Error(`Unknown command "${action}"`); })();
      sendWs({ type: 'command_result', commandId, tabId, ok: true, result });
    } catch (err) {
      sendWs({ type: 'command_result', commandId, tabId, ok: false, error: clean(err?.message || String(err)) });
    }
  };
}
