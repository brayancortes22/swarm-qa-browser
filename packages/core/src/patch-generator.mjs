/**
 * Swarm QA — Deterministic Patch Generator
 * Genera parches defensivos CSS/DOM en caliente para auto-sanación.
 */

export function generatePatch(finding) {
  if (!finding?.ruleId || !finding?.selector) return null;

  const { ruleId, selector } = finding;
  const id = `patch_${Math.random().toString(36).slice(2, 9)}`;

  switch (ruleId) {
    case 'overflow-container':
    case 'overflow-horizontal':
      return {
        id,
        ruleId,
        type: 'css',
        selector,
        css: `${selector} { max-width: 100% !important; box-sizing: border-box !important; overflow-x: clip !important; }`,
        title: 'Contención de desborde horizontal (box-sizing + max-width)'
      };

    case 'tap-target-undersized':
      return {
        id,
        ruleId,
        type: 'css',
        selector,
        css: `${selector} { min-width: 44px !important; min-height: 44px !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; }`,
        title: 'Ampliación de tap-target móvil a 44x44px estándar WCAG'
      };

    case 'a11y-missing-label':
      return {
        id,
        ruleId,
        type: 'attr',
        selector,
        attr: { name: 'aria-label', value: inferAccessibleName(finding) },
        title: 'Asignación de nombre accesible aria-label defensivo'
      };

    case 'a11y-form-label':
      return {
        id,
        ruleId,
        type: 'attr',
        selector,
        attr: { name: 'aria-label', value: 'Selector de opciones' },
        title: 'Asignación de aria-label para control de formulario'
      };

    default:
      return null;
  }
}

function inferAccessibleName(finding) {
  const sel = String(finding.selector || '').toLowerCase();
  if (sel.includes('cart') || sel.includes('carrito')) return 'Ver carrito de compras';
  if (sel.includes('next') || sel.includes('flecha') || sel.includes('right')) return 'Siguiente diapositiva';
  if (sel.includes('prev') || sel.includes('left')) return 'Diapositiva anterior';
  if (sel.includes('search') || sel.includes('buscar')) return 'Buscar en el catálogo';
  if (sel.includes('close') || sel.includes('cerrar')) return 'Cerrar ventana';
  return 'Elemento interactivo';
}

export function exportPatchManifest(patches = []) {
  return {
    timestamp: new Date().toISOString(),
    totalPatches: patches.length,
    patches: patches.map((p) => ({
      id: p.id,
      ruleId: p.ruleId,
      selector: p.selector,
      type: p.type,
      css: p.css || null,
      attr: p.attr || null,
      title: p.title
    }))
  };
}
