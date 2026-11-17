import { sanitizePageText } from '../../core/src/ticket-store.mjs';

const PROTECTED_UI_RE = /__(?:antigravity_native_browser_ui|swarm_qa_overlay)\b/;
const MODS = { alt: 1, control: 2, ctrl: 2, meta: 4, shift: 8 };
const KEY_META = {
  Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
  Space: ['Space', 32, ' '], ' ': ['Space', 32, ' '], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40]
};

/** Maps a key name and modifier list into CDP Input.dispatchKeyEvent parameters. */
export function buildKeyParams(rawKey, rawMods) {
  const raw = String(rawKey ?? '');
  if (!raw) throw new Error('press_key requires key');
  const key = raw === 'Space' ? ' ' : raw;
  const modifiers = Array.isArray(rawMods) ? rawMods.reduce((m, x) => m | (MODS[String(x ?? '').trim().toLowerCase()] || 0), 0) : (Number(rawMods) || 0);
  if (Object.hasOwn(KEY_META, raw)) { const [code, vk, text] = KEY_META[raw]; return { key, code, windowsVirtualKeyCode: vk, text, modifiers }; }
  const vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
  const code = key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /[0-9]/.test(key) ? `Digit${key}` : key) : key;
  return { key, code, windowsVirtualKeyCode: vk, text: key.length === 1 ? key : undefined, modifiers };
}

/** Resolves a selector via CDP DOM and fails closed if protected, missing, or unreachable. */
export async function querySafeNode(cdp, evalCtx, selector, waitReady) {
  if (!selector || typeof selector !== 'string' || PROTECTED_UI_RE.test(selector)) throw new Error('Invalid or protected selector');
  if (waitReady) await waitReady();
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root?.nodeId, selector });
  if (!nodeId) throw new Error(`Element not found: ${sanitizePageText(selector, 120)}`);
  let meta;
  try {
    meta = await evalCtx(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? { protected: Boolean(el.closest?.('#__antigravity_native_browser_ui, #__swarm_qa_overlay')), tag: String(el.tagName || '').toLowerCase(), type: String(el.getAttribute?.('type') || el.type || '').toLowerCase() } : null; })()`);
  } catch (err) {
    throw new Error(`Refusing unreachable or protected DOM: ${err?.message || err}`);
  }
  if (!meta || meta.protected) throw new Error(meta?.protected ? 'Refusing protected UI element' : `Refusing unreachable or protected DOM: ${sanitizePageText(selector, 120)}`);
  return { nodeId, meta };
}

/** Creates viewport, pointer, keyboard, and navigation command handlers for a CDP session. */
export function createInputHandlers({ cdp, state, tabId, evalCtx, waitReady, waitLoad, injectOverlay, sendBus }) {
  const emitRoute = () => sendBus({ type: 'route_changed', tabId, url: state.url, pathname: state.pathname, title: state.title, viewport: state.viewport });
  return {
    set_viewport: async (a) => {
      await waitReady();
      if (a.reset === true) {
        await cdp.send('Emulation.clearDeviceMetricsOverride');
        state.viewportOverride = false;
        const vp = await evalCtx('({ width: innerWidth || 1440, height: innerHeight || 900 })').catch(() => state.viewport);
        if (vp?.width && vp?.height) state.viewport = vp;
        emitRoute();
        return { ok: true, viewport: state.viewport, reset: true };
      }
      const width = Number(a.width) || 1440, height = Number(a.height) || 900, mobile = typeof a.mobile === 'boolean' ? a.mobile : width <= 480;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: Number(a.deviceScaleFactor ?? (mobile ? 2 : 1)) || 1, mobile });
      state.viewport = { width, height }; state.viewportOverride = true;
      emitRoute();
      return { ok: true, viewport: state.viewport, mobile, reset: false };
    },
    click: async (a) => {
      let x = Number(a.x), y = Number(a.y);
      if (a.selector) {
        const { nodeId } = await querySafeNode(cdp, evalCtx, a.selector, waitReady);
        await cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
        const m = (await cdp.send('DOM.getBoxModel', { nodeId }))?.model, pts = m?.content || m?.border;
        if (!Array.isArray(pts) || pts.length < 8) throw new Error('Missing box model for click target');
        x = (pts[0] + pts[2] + pts[4] + pts[6]) / 4; y = (pts[1] + pts[3] + pts[5] + pts[7]) / 4;
      } else {
        await waitReady();
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click requires selector or coordinates');
      }
      const button = a.button || 'left', clickCount = Number(a.clickCount) || 1;
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : button, ...(type === 'mouseMoved' ? {} : { clickCount }) });
      }
      return { ok: true, x, y, selector: a.selector ? sanitizePageText(a.selector) : null };
    },
    fill: async (a) => {
      const { nodeId, meta } = await querySafeNode(cdp, evalCtx, a.selector, waitReady);
      const attrs = (await cdp.send('DOM.getAttributes', { nodeId }).catch(() => null))?.attributes || [];
      const idx = attrs.findIndex((v, i) => i % 2 === 0 && String(v).toLowerCase() === 'type');
      const kind = meta?.type || (idx >= 0 ? String(attrs[idx + 1] || '').toLowerCase() : '');
      const sensitive = (meta?.tag ? meta.tag === 'input' : true) && (kind === 'password' || kind === 'hidden');
      if (a.clear !== false) await evalCtx(`(() => { const el = document.querySelector(${JSON.stringify(a.selector)}); if (!el) return false; if (el.isContentEditable) el.textContent = ''; else if ('value' in el) el.value = ''; return true; })()`);
      await cdp.send('DOM.focus', { nodeId }).catch(() => {});
      const text = String(a.value ?? '');
      await cdp.send('Input.insertText', { text });
      return { ok: true, selector: sanitizePageText(a.selector), redacted: sensitive, value: sensitive ? '[redacted]' : sanitizePageText(text), untrustedPageData: true };
    },
    press_key: async (a) => {
      await waitReady();
      if (a.selector) {
        const { nodeId } = await querySafeNode(cdp, evalCtx, a.selector);
        await cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
        await cdp.send('DOM.focus', { nodeId }).catch(() => {});
      }
      const kp = buildKeyParams(a.key, a.modifiers);
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', {
          type, key: kp.key, ...(kp.code ? { code: kp.code } : {}),
          ...(kp.windowsVirtualKeyCode ? { windowsVirtualKeyCode: kp.windowsVirtualKeyCode, nativeVirtualKeyCode: kp.windowsVirtualKeyCode } : {}),
          modifiers: kp.modifiers, ...(type === 'keyDown' && kp.text ? { text: kp.text, unmodifiedText: kp.text } : {})
        });
      }
      return { ok: true, key: sanitizePageText(kp.key, 40), modifiers: kp.modifiers };
    },
    navigate: async (a) => {
      await waitReady();
      const raw = String(a.url ?? ''), u = raw.startsWith('/') && state.url ? new URL(raw, state.url) : new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Disallowed navigation protocol: ${u.protocol}`);
      const waiter = waitLoad(Boolean(state.url) && state.url.split('#')[0] === u.href.split('#')[0]);
      try { const res = await cdp.send('Page.navigate', { url: u.href }); if (res?.errorText) throw new Error(res.errorText); } catch (err) { waiter.cancel(); throw err; }
      const info = await waiter.promise;
      await (info.mount || injectOverlay(true, 0));
      return { ok: true, url: state.url || u.href, pathname: state.pathname, frameId: state.frameId };
    }
  };
}
