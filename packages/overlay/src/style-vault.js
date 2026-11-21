/**
 * Applies temporary `!important` inline styles through CSSOM (allowed under any page CSP) and
 * remembers the original value + priority so the page can be restored exactly.
 */
export function createStyleVault() {
  const saved = new Map();
  const hadStyleAttr = new WeakMap();

  /** Drops the empty `style=""` attribute CSSOM leaves behind on elements that never had one. */
  function tidy(el) {
    if (hadStyleAttr.get(el) || el.style.length !== 0) return;
    // Chromium serializes the style attribute lazily: read it first so the removal is not undone
    // by a later lazy re-serialization of the (now empty) inline style.
    el.getAttribute('style');
    el.removeAttribute('style');
  }

  function set(el, prop, value) {
    if (!el?.style) return;
    let props = saved.get(el);
    if (!props) {
      saved.set(el, (props = new Map()));
      hadStyleAttr.set(el, el.hasAttribute('style'));
    }
    if (!props.has(prop)) props.set(prop, [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    el.style.setProperty(prop, value, 'important');
  }

  function restoreProp(el, prop, [value, priority]) {
    if (value) el.style.setProperty(prop, value, priority);
    else el.style.removeProperty(prop);
  }

  function restore(el, prop) {
    const props = saved.get(el);
    if (!props?.has(prop)) return;
    restoreProp(el, prop, props.get(prop));
    props.delete(prop);
    if (!props.size) {
      saved.delete(el);
      tidy(el);
    }
  }

  function restoreAll() {
    for (const [el, props] of saved) {
      for (const [prop, original] of props) restoreProp(el, prop, original);
      tidy(el);
    }
    saved.clear();
  }

  return {
    set,
    restore,
    restoreAll,
    get size() {
      return saved.size;
    }
  };
}
