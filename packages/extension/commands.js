import { buildKeyEvent, clean } from './helpers.js';

export function createBusCommandHandler(ctx) {
  const { authorizedTabs, cdp, tabMsg, hasHostPermission, syncTabAfterNav, waitTabLoad, runAuditAndCache, sendWs, metaOf } = ctx;

  /**
   * Resolves a selector to viewport coordinates once the element has stopped moving: a page that is
   * still smooth-scrolling would shift it after the first measurement and the pointer would miss.
   */
  async function settledTarget(tabId, selector, label) {
    const resolve = async (scroll) => {
      const r = await tabMsg(tabId, { type: 'resolve_rect', selector, scroll });
      if (!r?.ok || !Number.isFinite(r.x) || !Number.isFinite(r.y)) throw new Error(r?.error || `Invalid ${label} target`);
      return r;
    };
    let target = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const before = await resolve(true);
      // Measure again WITHOUT scrolling: re-scrolling first would hide an ongoing scroll animation.
      await new Promise((done) => setTimeout(done, 60));
      target = await resolve(false);
      if (Math.abs(before.x - target.x) < 0.5 && Math.abs(before.y - target.y) < 0.5) return target;
    }
    return target;
  }

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
        const w = Number(cmd.width) || 1440,
          h = Number(cmd.height) || 900;
        const mobile = cmd.mobile !== undefined ? Boolean(cmd.mobile) : w <= 480;
        await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
          width: w,
          height: h,
          deviceScaleFactor: Number(cmd.deviceScaleFactor) || (mobile ? 2 : 1),
          mobile
        });
        entry.viewport = { width: w, height: h };
      }
      sendWs({ type: 'route_changed', tabId, ...metaOf(entry) });
      return { ok: true, viewport: entry.viewport, reset: Boolean(cmd.reset) };
    },
    async hover(tabId, _entry, cmd) {
      const r = cmd.selector
        ? await settledTarget(tabId, cmd.selector, 'hover')
        : { ok: true, x: Number(cmd.x), y: Number(cmd.y), selector: null };
      if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) throw new Error('Invalid hover target');
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
      return { hovered: true, x: r.x, y: r.y, selector: r.selector };
    },
    /** Captures what the tab shows, in CSS pixels so coordinates match click targets. */
    async screenshot(tabId, _entry, cmd = {}) {
      const format = cmd.format === 'png' ? 'png' : 'jpeg';
      const info =
        (
          await cdp(tabId, 'Runtime.evaluate', {
            expression: '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 })',
            returnByValue: true
          })
        )?.result?.value || {};
      const params = { format, ...(format === 'jpeg' ? { quality: Math.max(10, Math.min(100, Number(cmd.quality) || 70)) } : {}) };
      let size = { width: info.width, height: info.height };
      if (cmd.fullPage) {
        const content = (await cdp(tabId, 'Page.getLayoutMetrics'))?.cssContentSize;
        if (content) size = { width: Math.ceil(content.width), height: Math.min(Math.ceil(content.height), 12000) };
        params.captureBeyondViewport = true;
      }
      if (size.width > 0 && size.height > 0)
        params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 / (info.dpr || 1) };
      const shot = await cdp(tabId, 'Page.captureScreenshot', params);
      return { data: shot.data, mimeType: `image/${format}`, ...size, fullPage: Boolean(cmd.fullPage) };
    },
    async click(tabId, _entry, cmd) {
      const r = cmd.selector
        ? await settledTarget(tabId, cmd.selector, 'click')
        : { ok: true, x: Number(cmd.x), y: Number(cmd.y), selector: null };
      if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) throw new Error('Invalid click target');
      const button = cmd.button || 'left',
        clickCount = Number(cmd.clickCount) || 1;
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp(
          tabId,
          'Input.dispatchMouseEvent',
          type === 'mouseMoved' ? { type, x: r.x, y: r.y } : { type, x: r.x, y: r.y, button, clickCount }
        );
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
      const entry = authorizedTabs.get(tabId),
        action = command.action || command.type;
      if (!entry) throw new Error(`Tab ${tabId} is not authorized`);
      // Debugger-backed commands run here; anything else is forwarded to the overlay, which rejects unknown actions.
      const result = Object.hasOwn(COMMANDS, action)
        ? await COMMANDS[action](tabId, entry, command)
        : await tabMsg(tabId, { type: String(action ?? ''), command }).then((r) => {
            if (r?.ok === false && r.error) throw new Error(r.error);
            return r;
          });
      sendWs({ type: 'command_result', commandId, tabId, ok: true, result });
    } catch (err) {
      sendWs({ type: 'command_result', commandId, tabId, ok: false, error: clean(err?.message || String(err)) });
    }
  };
}
