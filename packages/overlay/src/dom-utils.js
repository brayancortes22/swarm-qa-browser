/** Small DOM helpers shared by the overlay views. */

const CTRL_RE = /[\u0000-\u001F\u007F-\u009F\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)$/;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Collapses whitespace and strips control/bidi characters from untrusted text before display. */
export const cleanText = (value, max = 280) =>
  String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CTRL_RE, '')
    .trim()
    .slice(0, max);

/** Accepts only hex / rgb() colors so untrusted input can never inject arbitrary CSS. */
export const safeColor = (color, fallback = '#0D99FF') => {
  const value = String(color ?? '').trim();
  return COLOR_RE.test(value) ? value : fallback;
};

export const isFiniteNumber = (value) =>
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));

/** Creates an element with an optional class, text content and attributes. */
export function h(doc, tag, className, text, attrs) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = cleanText(text);
  if (attrs) for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** Builds a small inline SVG icon from path data (no innerHTML, CSP-safe). */
export function svgIcon(doc, { viewBox = '0 0 20 20', paths = [], className = '' } = {}) {
  const make = (tag) => (doc.createElementNS ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag));
  const svg = make('svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  for (const spec of paths) {
    const path = make('path');
    for (const [key, value] of Object.entries(typeof spec === 'string' ? { d: spec } : spec)) {
      path.setAttribute(key, value);
    }
    svg.appendChild(path);
  }
  return svg;
}

/** Normalizes `{x,y,width,height}` / DOMRect-like input into `{left,top,width,height}`. */
export function toBox(rect) {
  if (!rect || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)) return null;
  return {
    left: Number(rect.left ?? rect.x ?? 0) || 0,
    top: Number(rect.top ?? rect.y ?? 0) || 0,
    width: Math.max(0, Number(rect.width)),
    height: Math.max(0, Number(rect.height))
  };
}

/** `querySelector` that never throws on invalid or untrusted selectors. */
export function queryOne(doc, selector) {
  if (!selector || typeof selector !== 'string' || typeof doc?.querySelector !== 'function') return null;
  try {
    return doc.querySelector(selector);
  } catch {
    return null;
  }
}
