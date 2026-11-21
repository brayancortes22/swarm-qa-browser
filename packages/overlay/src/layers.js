/**
 * Layer scanner: walks the live DOM (read-only) and lists the elements that paint something on
 * their own — text blocks, media, form controls and boxes with a background, border or shadow.
 * These are the "layers" the swarm rebuilds during a tour and samples during audit sweeps.
 */

const IGNORED_IDS = new Set(['__swarm_qa_overlay', '__antigravity_native_browser_ui']);
const SKIP_TAGS = new Set([
  'script',
  'style',
  'meta',
  'link',
  'head',
  'noscript',
  'template',
  'title',
  'base',
  'br',
  'wbr',
  'source',
  'track',
  'param',
  'option',
  'optgroup',
  'datalist',
  'area',
  'map'
]);
const MEDIA_TAGS = new Set(['img', 'picture', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed', 'audio']);
const CONTROL_TAGS = new Set(['input', 'textarea', 'select', 'progress', 'meter']);
const MAX_NODES = 8000;

const isTransparent = (color) => !color || color === 'transparent' || /rgba\([^)]*,\s*0\s*\)$/.test(color);

function hasOwnPaint(cs) {
  if (!isTransparent(cs.backgroundColor)) return true;
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
  if (cs.boxShadow && cs.boxShadow !== 'none') return true;
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none') return true;
  }
  return false;
}

function hasDirectText(el) {
  for (const node of el.childNodes) {
    if (node.nodeType === 3 && node.nodeValue.trim()) return true;
  }
  return false;
}

const isInlineDisplay = (display) => String(display || '').startsWith('inline') || display === 'contents';

/** True when a DOMRect-like box intersects the viewport (with an optional margin). */
export function inViewport(rect, win, margin = 0) {
  const width = win?.innerWidth || 1280;
  const height = win?.innerHeight || 800;
  return rect.bottom > -margin && rect.top < height + margin && rect.right > 0 && rect.left < width;
}

/**
 * Returns up to `max` layers in document order: `{ el, kind, inline, chars }` where kind is
 * 'text' | 'media' | 'control' | 'box'. Never mutates the page.
 */
export function scanLayers({ doc, win, max = 400 } = {}) {
  const root = doc?.body;
  if (!root || typeof win?.getComputedStyle !== 'function') return [];
  const layers = [];
  let visited = 0;

  function visit(el) {
    if (layers.length >= max || visited >= MAX_NODES) return;
    visited += 1;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag) || IGNORED_IDS.has(el.id)) return;
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || Number(cs.opacity) === 0) return;
    const rect = el.getBoundingClientRect();
    const sized = rect.width >= 2 && rect.height >= 2;
    const shown = sized && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';

    if (MEDIA_TAGS.has(tag) || CONTROL_TAGS.has(tag)) {
      if (shown) layers.push({ el, kind: MEDIA_TAGS.has(tag) ? 'media' : 'control', inline: false, chars: 0 });
      return;
    }
    const children = Array.from(el.children);
    if (shown && hasDirectText(el)) {
      const flowsInline = children.every((child) => isInlineDisplay(win.getComputedStyle(child).display));
      if (flowsInline) {
        layers.push({ el, kind: 'text', inline: cs.display === 'inline', chars: el.textContent.trim().length });
        return;
      }
    }
    if (shown && el !== root && (hasOwnPaint(cs) || hasDirectText(el))) {
      layers.push({ el, kind: 'box', inline: false, chars: 0 });
    }
    for (const child of children) visit(child);
  }

  visit(root);
  return layers;
}
