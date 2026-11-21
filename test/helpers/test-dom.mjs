import { JSDOM, VirtualConsole } from 'jsdom';

const DEFAULT_BODY = `
  <div id="__antigravity_native_browser_ui"><button id="ag-btn">AG</button></div>
  <button id="play-btn">Play</button>
  <input id="note" type="text" placeholder="Note" value="hello">
  <input id="pw" type="password" placeholder="PW" value="oldpw">
  <input id="pw-input" type="password">
  <input id="csrf" type="hidden" value="tok-1">
  <input id="csrf-token" type="hidden" value="secret-csrf">
  <input id="email-input" type="email" placeholder="Email">`;
const DEFAULT_RECTS = {
  'play-btn': { x: 20, y: 40, width: 32, height: 32 },
  note: { x: 20, y: 100, width: 180, height: 48 },
  pw: { x: 20, y: 160, width: 180, height: 48 },
  'pw-input': { x: 20, y: 220, width: 180, height: 48 },
  'email-input': { x: 20, y: 280, width: 180, height: 48 },
  'ag-btn': { x: 0, y: 0, width: 40, height: 40 }
};

/**
 * jsdom page for adapter tests. jsdom has no layout engine, so element geometry is stubbed with
 * `setRect`; closed shadow roots are recorded in `shadows` (and tagged on the host as
 * `_shadowMode`) because they are otherwise unreachable by design.
 */
export function createTestDom({
  url = 'http://localhost:5173/player',
  title = 'Sonora',
  width = 390,
  height = 844,
  body = DEFAULT_BODY,
  rects = DEFAULT_RECTS
} = {}) {
  const jsdom = new JSDOM(`<!doctype html><html><head><title></title></head><body>${body}</body></html>`, {
    url,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole()
  });
  const win = jsdom.window;
  const doc = win.document;
  doc.title = title;
  win.innerWidth = width;
  win.innerHeight = height;
  const shadows = [];
  const nativeAttachShadow = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function attachShadow(init) {
    const root = nativeAttachShadow.call(this, init);
    this._shadowMode = init.mode;
    shadows.push(root);
    return root;
  };

  function setRect(target, rect) {
    const el = typeof target === 'string' ? doc.getElementById(target) : target;
    if (!el) return;
    el.getBoundingClientRect = () => ({ ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height });
  }
  for (const [id, rect] of Object.entries(rects)) setRect(id, rect);

  return {
    jsdom,
    win,
    doc,
    shadows,
    setRect,
    getEl: (id) => doc.getElementById(id),
    setUrl: (next) => jsdom.reconfigure({ url: next }),
    /** Evaluates script source inside the page's own global (like a content script would run). */
    run: (source) => win.eval(source),
    close: () => win.close()
  };
}
