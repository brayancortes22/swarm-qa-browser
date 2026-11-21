import { buildSelector, isSensitiveElement, sanitizeText } from './dom-auditor.js';
import { queryOne } from './dom-utils.js';

/**
 * Read-only page inspection for AI test agents: an outline of what can be interacted with, element
 * lookup by selector or visible text, and scrolling. Everything returned is untrusted page data.
 */

const INTERACTIVE =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, label, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], h1, h2, h3';
const IGNORED = '#__swarm_qa_overlay, #__antigravity_native_browser_ui';
const MAX_SNAPSHOT = 200;

const round = (n) => Math.round(n * 10) / 10;
const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) };
};
const inView = (rect, win) =>
  rect.y + rect.height > 0 && rect.y < (win.innerHeight || 800) && rect.x + rect.width > 0 && rect.x < (win.innerWidth || 1280);

function isRendered(el, win) {
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
    const cs = win.getComputedStyle(cur);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
  }
  return true;
}

function accessibleName(el) {
  const labelled = el.getAttribute('aria-labelledby');
  const fromLabelled = labelled ? el.ownerDocument.getElementById(labelled.split(/\s+/)[0])?.textContent : '';
  return sanitizeText(
    el.getAttribute('aria-label') ||
      fromLabelled ||
      el.getAttribute('alt') ||
      el.textContent ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      '',
    100
  );
}

function describe(el, win) {
  const tag = el.tagName.toLowerCase();
  const rect = rectOf(el);
  const entry = { selector: buildSelector(el), tag, name: accessibleName(el), rect, inViewport: inView(rect, win) };
  const role = el.getAttribute('role');
  if (role) entry.role = sanitizeText(role, 24);
  if (tag === 'a') entry.href = sanitizeText(el.getAttribute('href'), 160);
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    entry.type = sanitizeText(el.getAttribute('type') || tag, 24);
    entry.value = isSensitiveElement(el) ? '[redacted]' : sanitizeText(el.value, 120);
    if (el.type === 'checkbox' || el.type === 'radio') entry.checked = Boolean(el.checked);
  }
  if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') entry.disabled = true;
  return entry;
}

/** Outline of the interactive elements and headings, in document order. */
export function snapshotPage({ doc, win, scope = 'viewport', max = 80 } = {}) {
  const limit = Math.max(1, Math.min(MAX_SNAPSHOT, Number(max) || 80));
  const elements = [];
  let truncated = false;
  for (const el of doc.querySelectorAll(INTERACTIVE)) {
    if (el.closest(IGNORED) || !isRendered(el, win)) continue;
    const entry = describe(el, win);
    if (entry.rect.width < 1 || entry.rect.height < 1) continue;
    if (scope === 'viewport' && !entry.inViewport) continue;
    if (elements.length >= limit) {
      truncated = true;
      break;
    }
    elements.push(entry);
  }
  const root = doc.documentElement;
  return {
    url: sanitizeText(win.location?.href, 512),
    title: sanitizeText(doc.title, 160),
    viewport: { width: win.innerWidth || 0, height: win.innerHeight || 0 },
    scroll: {
      x: Math.round(win.scrollX || 0),
      y: Math.round(win.scrollY || 0),
      maxY: Math.max(0, (root?.scrollHeight || 0) - (win.innerHeight || 0))
    },
    scope,
    elements,
    truncated,
    untrustedPageData: true
  };
}

/** Smallest rendered element whose own text contains `text` (case-insensitive). */
function findByText(doc, win, text) {
  const needle = String(text).trim().toLowerCase();
  if (!needle || !doc.body) return [];
  const walker = doc.createTreeWalker(doc.body, 4);
  const matches = [];
  for (let node = walker.nextNode(); node && matches.length < 20; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.nodeValue.toLowerCase().includes(needle)) continue;
    if (parent.closest(IGNORED) || /^(script|style|noscript|template)$/i.test(parent.tagName) || !isRendered(parent, win)) continue;
    // Prefer the clickable ancestor (a button's text lives in a child span).
    matches.push(parent.closest('a[href], button, [role="button"], label, summary') || parent);
  }
  return [...new Set(matches)];
}

/** Form controls whose label, placeholder, aria-label or name contains `text`. */
function findControlsByText(doc, win, text) {
  const needle = String(text).trim().toLowerCase();
  if (!needle) return [];
  return Array.from(
    doc.querySelectorAll('input:not([type="hidden"]), textarea, select, [contenteditable=""], [contenteditable="true"]')
  ).filter((el) => {
    if (el.closest(IGNORED) || !isRendered(el, win)) return false;
    const labels = Array.from(el.labels || [])
      .map((label) => label.textContent)
      .join(' ');
    const hints = [
      labels,
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('name'),
      el.getAttribute('title')
    ];
    return hints.some((hint) =>
      String(hint ?? '')
        .toLowerCase()
        .includes(needle)
    );
  });
}

/**
 * Looks an element up by CSS selector or by visible text and reports its observable state.
 * With `prefer: 'control'`, text is matched against form-field labels and hints instead.
 */
export function queryElement({ doc, win, selector, text, prefer } = {}) {
  let matches = [];
  if (selector) {
    try {
      matches = Array.from(doc.querySelectorAll(selector)).filter((el) => !el.closest(IGNORED));
    } catch {
      return { found: false, count: 0, error: `Invalid selector: ${sanitizeText(selector, 120)}`, untrustedPageData: true };
    }
    if (text) matches = matches.filter((el) => el.textContent.toLowerCase().includes(String(text).trim().toLowerCase()));
  } else if (text) {
    matches = prefer === 'control' ? findControlsByText(doc, win, text) : findByText(doc, win, text);
  }
  const el = matches[0];
  if (!el) return { found: false, count: 0, visible: false, untrustedPageData: true };
  const entry = describe(el, win);
  return {
    found: true,
    count: matches.length,
    visible: isRendered(el, win) && entry.rect.width > 0 && entry.rect.height > 0,
    ...entry,
    text: sanitizeText(el.textContent, 280),
    untrustedPageData: true
  };
}

/** Scrolls the page (or brings an element into view) and reports the new position. */
export function scrollPage({ doc, win, selector, to, by, smooth = true } = {}) {
  const behavior = smooth && !win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'smooth' : 'auto';
  const target = selector ? queryOne(doc, selector) : null;
  if (selector && (!target || target.closest(IGNORED))) return { ok: false, error: `Element not found: ${sanitizeText(selector, 120)}` };
  if (target) target.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior });
  else if (to === 'top') win.scrollTo?.({ top: 0, behavior });
  else if (to === 'bottom') win.scrollTo?.({ top: doc.documentElement?.scrollHeight || 0, behavior });
  else win.scrollBy?.({ left: Number(by?.x) || 0, top: Number(by?.y ?? (win.innerHeight || 800) * 0.8) || 0, behavior });
  return { ok: true, scroll: { x: Math.round(win.scrollX || 0), y: Math.round(win.scrollY || 0) } };
}
