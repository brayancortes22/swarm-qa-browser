import { queryOne } from './dom-utils.js';

const PROP_RE = /^-?[a-z][a-z-]{1,40}$/;
const VALUE_RE = /^[^{};<>\\]{1,120}$/;
const SAFE_ATTR_RE = /^(aria-[a-z]{2,24}|title|alt|role)$/;
const ID_RE = /^[\w-]{1,48}$/;

/**
 * Reversible hot patches for self-healing experiments. Patches are data, never raw CSS/HTML:
 *  - `{ type: 'css', selector, declarations: { prop: value } }`
 *  - `{ type: 'attr', selector, attr: { name, value } }` (aria-*, title, alt, role only)
 * Selectors must parse and match a live element; declarations are validated one by one.
 */
export function createPatchManager(doc) {
  const applied = new Map();

  function apply(patch) {
    if (!patch || !ID_RE.test(String(patch.id ?? ''))) return false;
    const target = queryOne(doc, patch.selector);
    if (!target) return false;
    revert(patch.id);

    if (patch.type === 'css' && patch.declarations && typeof patch.declarations === 'object') {
      const entries = Object.entries(patch.declarations).filter(([prop, value]) => PROP_RE.test(prop) && VALUE_RE.test(String(value)));
      if (!entries.length) return false;
      const targets = Array.from(doc.querySelectorAll(patch.selector)).slice(0, 200);
      const undo = targets.map((el) => {
        const hadStyleAttr = el.hasAttribute('style');
        const previous = entries.map(([prop]) => [prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
        for (const [prop, value] of entries) el.style.setProperty(prop, String(value), 'important');
        return { el, previous, hadStyleAttr };
      });
      applied.set(patch.id, { type: 'css', undo });
      return true;
    }

    if (patch.type === 'attr' && SAFE_ATTR_RE.test(String(patch.attr?.name ?? ''))) {
      const { name } = patch.attr;
      const previous = target.getAttribute(name);
      target.setAttribute(name, String(patch.attr.value ?? '').slice(0, 160));
      applied.set(patch.id, { type: 'attr', el: target, name, previous });
      return true;
    }
    return false;
  }

  function revert(id) {
    const entry = applied.get(id);
    if (!entry) return false;
    if (entry.type === 'css') {
      for (const { el, previous, hadStyleAttr } of entry.undo) {
        for (const [prop, value, priority] of previous) {
          if (value) el.style.setProperty(prop, value, priority);
          else el.style.removeProperty(prop);
        }
        if (!hadStyleAttr && el.style.length === 0) {
          el.getAttribute('style'); // force Chromium's lazy style-attribute sync before removing it
          el.removeAttribute('style');
        }
      }
    } else if (entry.previous == null) {
      entry.el.removeAttribute(entry.name);
    } else {
      entry.el.setAttribute(entry.name, entry.previous);
    }
    applied.delete(id);
    return true;
  }

  return {
    apply,
    revert,
    ids: () => [...applied.keys()],
    revertAll() {
      for (const id of [...applied.keys()]) revert(id);
    }
  };
}
