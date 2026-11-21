const IGNORED_IDS = new Set(['__swarm_qa_overlay', '__antigravity_native_browser_ui']);
const ALL_CHECKS = ['overflow', 'overlap', 'a11y', 'media', 'tap-target', 'console-net'];
const tagOf = (el) => String(el?.tagName || el?.nodeName || '').toLowerCase();
const attrOf = (el, k) => (typeof el?.getAttribute === 'function' ? el.getAttribute(k) : null);
const inputType = (el) =>
  String(attrOf(el, 'type') ?? el?.type ?? 'text')
    .trim()
    .toLowerCase();

export function sanitizeText(value, maxLen = 280) {
  if (value == null) return '';
  const clean = String(value)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return maxLen <= 0 ? '' : clean.length > maxLen ? `${clean.slice(0, Math.max(0, maxLen - 1))}…` : clean;
}

export const isSensitiveElement = (el) =>
  Boolean(el && tagOf(el) === 'input' && (inputType(el) === 'password' || inputType(el) === 'hidden'));

const escCss = (val) => (globalThis.CSS?.escape ? globalThis.CSS.escape(String(val)) : String(val).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

export function buildSelector(el) {
  if (!el) return 'document';
  const parts = [];
  for (let cur = el, d = 0; cur && d < 4 && tagOf(cur) && !tagOf(cur).startsWith('#'); d += 1) {
    if (cur.id) {
      parts.unshift(`#${escCss(cur.id)}`);
      break;
    }
    let seg = tagOf(cur);
    const tid = attrOf(cur, 'data-testid');
    if (tid) seg += `[data-testid="${escCss(tid)}"]`;
    else if (cur.parentElement?.children?.length > 1) {
      const same = Array.from(cur.parentElement.children).filter((c) => tagOf(c) === seg);
      if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(seg);
    cur = cur.parentElement || cur.parentNode;
  }
  return sanitizeText(parts.join(' > ') || 'document', 280);
}

const getRect = (el) => {
  const r = typeof el?.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  return {
    x: Number(r?.left ?? r?.x ?? 0) || 0,
    y: Number(r?.top ?? r?.y ?? 0) || 0,
    width: Number(r?.width ?? el?.clientWidth ?? 0) || 0,
    height: Number(r?.height ?? el?.clientHeight ?? 0) || 0
  };
};

function isVisible(el, win) {
  for (
    let cur = el;
    cur && tagOf(cur) && !tagOf(cur).startsWith('#') && (cur.nodeType == null || cur.nodeType === 1);
    cur = cur.parentElement || cur.parentNode
  ) {
    if (IGNORED_IDS.has(cur.id)) return false;
    const stAttr = String(attrOf(cur, 'style') || ''),
      s = cur.style || {};
    if (cur.hidden === true || (attrOf(cur, 'hidden') !== null && attrOf(cur, 'hidden') !== 'false')) return false;
    if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?(?:\s*;|\s*$)/i.test(stAttr)) return false;
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0' || s.opacity === 0) return false;
    const cs = typeof win?.getComputedStyle === 'function' ? win.getComputedStyle(cur) : null;
    if (
      cs &&
      (cs.display === 'none' || cs.visibility === 'hidden' || (cs.opacity !== '' && cs.opacity != null && Number(cs.opacity) === 0))
    )
      return false;
  }
  return true;
}

function collectElements(doc) {
  const list = [];
  const walk = (node) => {
    if (!node || IGNORED_IDS.has(node.id)) return;
    if (tagOf(node)) list.push(node);
    for (const child of Array.from(node.children || [])) walk(child);
  };
  walk(doc?.documentElement || doc?.body);
  if (!list.length && typeof doc?.querySelectorAll === 'function') {
    for (const n of Array.from(doc.querySelectorAll('*'))) {
      let ok = true;
      for (let c = n; c; c = c.parentElement || c.parentNode)
        if (IGNORED_IDS.has(c.id)) {
          ok = false;
          break;
        }
      if (ok) list.push(n);
    }
  }
  return list;
}

const makeFinding = (ruleId, severity, category, selector, rect, description, expected, actual) => ({
  ruleId,
  severity,
  category,
  selector: sanitizeText(selector, 280),
  rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  description: sanitizeText(description, 280),
  expected: sanitizeText(expected, 280),
  actual: sanitizeText(actual, 280),
  untrustedPageData: true
});

const isControl = (el) => {
  const t = tagOf(el);
  return (
    t === 'button' ||
    t === 'select' ||
    t === 'textarea' ||
    (t === 'a' && attrOf(el, 'href') != null) ||
    (t === 'input' && inputType(el) !== 'hidden') ||
    attrOf(el, 'role') === 'button'
  );
};
const isAncestorOrSelf = (a, b) => {
  if (a === b || a.contains?.(b) || b.contains?.(a)) return true;
  for (let c = a.parentElement; c; c = c.parentElement) if (c === b) return true;
  for (let c = b.parentElement; c; c = c.parentElement) if (c === a) return true;
  return false;
};
const hasImgAlt = (el) =>
  Array.from(el.children || []).some((c) => (tagOf(c) === 'img' && String(attrOf(c, 'alt') ?? c.alt ?? '').trim()) || hasImgAlt(c));
const hasAccessibleName = (el) =>
  Boolean(
    String(el.textContent || '').trim() ||
    attrOf(el, 'aria-label')?.trim() ||
    attrOf(el, 'aria-labelledby')?.trim() ||
    attrOf(el, 'title')?.trim() ||
    hasImgAlt(el)
  );

function checkConsoleNet(entries = []) {
  return entries.flatMap((e) => {
    const status = Number(e?.status ?? e?.statusCode ?? 0);
    const kind = String(e?.kind || e?.type || e?.level || '').toLowerCase();
    if (status > 0 && status < 400) return [];
    const isP1 =
      status >= 500 ||
      e?.uncaught === true ||
      /uncaught|unhandled|exception|pageerror/.test(kind) ||
      (kind === 'error' && Boolean(e?.source || e?.line));
    const ruleId =
      status >= 500 ? 'console-net-5xx' : status >= 400 ? 'console-net-4xx' : isP1 ? 'console-net-uncaught' : 'console-net-error';
    const detail =
      status >= 400 ? `HTTP ${status} ${e?.url || ''} ${e?.message || ''}` : e?.message || e?.text || e?.reason || kind || 'error';
    return [
      makeFinding(
        ruleId,
        isP1 ? 'P1' : 'P2',
        'console-net',
        e?.selector || e?.url || 'document',
        { x: 0, y: 0, width: 0, height: 0 },
        status >= 400 ? `Network failure: ${detail}` : `Console error: ${detail}`,
        status >= 400 ? 'HTTP status < 400' : 'Zero runtime/console errors',
        detail
      )
    ];
  });
}

export function runDomAudit({
  doc = globalThis.document,
  rootDocument,
  win = globalThis.window,
  checks,
  viewport,
  consoleEntries = []
} = {}) {
  const docRef = doc || rootDocument;
  const active = new Set(Array.isArray(checks) && checks.length ? checks : ALL_CHECKS);
  const vp = viewport || {
    width: win?.innerWidth || docRef?.documentElement?.clientWidth || 1440,
    height: win?.innerHeight || docRef?.documentElement?.clientHeight || 900
  };
  const all = docRef ? collectElements(docRef) : [];
  const vis = all.filter((el) => isVisible(el, win));
  const out = [];
  if (active.has('overflow') && docRef?.documentElement) {
    const root = docRef.documentElement;
    if (Number(root.scrollWidth) > Number(vp.width))
      out.push(
        makeFinding(
          'overflow-document',
          'P1',
          'overflow',
          'html',
          getRect(root),
          `Page overflows viewport width (${vp.width}px)`,
          `scrollWidth <= ${vp.width}px`,
          `scrollWidth=${root.scrollWidth}px`
        )
      );
    for (const el of vis) {
      if (el === root || el.clientWidth <= 0 || el.scrollWidth <= el.clientWidth + 2) continue;
      const cs = win?.getComputedStyle?.(el);
      const ox = String(cs?.overflowX ?? el.style?.overflowX ?? '').toLowerCase();
      const to = String(cs?.textOverflow ?? el.style?.textOverflow ?? '').toLowerCase();
      if (ox === 'auto' || ox === 'scroll' || ((ox === 'hidden' || ox === 'clip') && to === 'ellipsis')) continue;
      out.push(
        makeFinding(
          'overflow-container',
          'P2',
          'overflow',
          buildSelector(el),
          getRect(el),
          'Container overflows horizontally',
          `scrollWidth <= ${el.clientWidth + 2}px`,
          `scrollWidth=${el.scrollWidth}px, clientWidth=${el.clientWidth}px`
        )
      );
    }
  }
  if (active.has('overlap')) {
    const boxes = vis
      .filter(
        (el) =>
          tagOf(el) !== 'html' &&
          tagOf(el) !== 'body' &&
          (isControl(el) ||
            (!el.children?.length && String(el.textContent || '').trim()) ||
            Array.from(el.childNodes || []).some((n) => n.nodeType === 3 && n.nodeValue?.trim()))
      )
      .map((el) => ({ el, rect: getRect(el) }))
      .filter((b) => b.rect.width > 0 && b.rect.height > 0)
      .slice(0, 400);
    for (let i = 0, hits = 0; i < boxes.length && hits < 40; i += 1) {
      for (let j = i + 1; j < boxes.length && hits < 40; j += 1) {
        if (isAncestorOrSelf(boxes[i].el, boxes[j].el)) continue;
        const a = boxes[i].rect,
          b = boxes[j].rect;
        const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (ox > 4 && oy > 4) {
          hits += 1;
          out.push(
            makeFinding(
              'overlap-elements',
              'P1',
              'overlap',
              buildSelector(boxes[j].el),
              b,
              `Overlaps ${buildSelector(boxes[i].el)} by ${Math.round(ox)}x${Math.round(oy)}px`,
              'Overlap <= 4px',
              `overlap=${Math.round(ox)}x${Math.round(oy)}px`
            )
          );
        }
      }
    }
  }
  if (active.has('a11y')) {
    const forLabels = new Set(
      all
        .filter((e) => tagOf(e) === 'label')
        .map((e) => String(attrOf(e, 'for') ?? e.htmlFor ?? '').trim())
        .filter(Boolean)
    );
    for (const el of vis) {
      const t = tagOf(el);
      if ((t === 'button' || (t === 'a' && attrOf(el, 'href') != null) || attrOf(el, 'role') === 'button') && !hasAccessibleName(el)) {
        out.push(
          makeFinding(
            'a11y-accessible-name',
            'P2',
            'a11y',
            buildSelector(el),
            getRect(el),
            `${t} lacks accessible name`,
            'text, aria-label, aria-labelledby, title, or img[alt]',
            'empty accessible name'
          )
        );
      } else if ((t === 'input' || t === 'select' || t === 'textarea') && inputType(el) !== 'hidden') {
        const isBtn = t === 'input' && /^(submit|button|reset)$/.test(inputType(el)) && String(el.value || '').trim();
        let wrap = false;
        for (let c = el.parentElement; c; c = c.parentElement)
          if (tagOf(c) === 'label') {
            wrap = true;
            break;
          }
        const named =
          isBtn ||
          wrap ||
          (el.id && forLabels.has(el.id)) ||
          attrOf(el, 'aria-label')?.trim() ||
          attrOf(el, 'aria-labelledby')?.trim() ||
          attrOf(el, 'placeholder')?.trim() ||
          attrOf(el, 'title')?.trim();
        if (!named) {
          const red = isSensitiveElement(el) ? ', value=[redacted]' : '';
          out.push(
            makeFinding(
              'a11y-form-label',
              'P2',
              'a11y',
              buildSelector(el),
              getRect(el),
              `Form ${t} missing label${red}`,
              '<label>, aria-label, or placeholder',
              `unlabeled ${t} (type=${inputType(el)}${red})`
            )
          );
        }
      }
    }
  }
  if (active.has('media'))
    for (const el of vis)
      if (tagOf(el) === 'img' && el.complete === true && Number(el.naturalWidth) === 0)
        out.push(
          makeFinding(
            'media-broken-image',
            'P2',
            'media',
            buildSelector(el),
            getRect(el),
            `Broken image (${attrOf(el, 'src') || 'no src'})`,
            'naturalWidth > 0',
            'complete=true, naturalWidth=0'
          )
        );
  if (active.has('tap-target') && Number(vp.width) <= 480)
    for (const el of vis)
      if (isControl(el)) {
        const r = getRect(el);
        if (r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44))
          out.push(
            makeFinding(
              'tap-target-size',
              'P2',
              'tap-target',
              buildSelector(el),
              r,
              'Mobile tap target smaller than 44x44px',
              '>= 44x44px',
              `${Math.round(r.width)}x${Math.round(r.height)}px`
            )
          );
      }
  if (active.has('console-net')) out.push(...checkConsoleNet(consoleEntries));
  return out;
}
