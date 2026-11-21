import { randomUUID } from 'node:crypto';

/**
 * Deterministic hot-patch recipes for self-healing experiments.
 *
 * A patch is plain data (`declarations` or a whitelisted `attr`), never executable code; the
 * overlay validates and applies it reversibly. Patches only prove that a fix works in the live
 * page — the same change must still be made in the application source by a developer agent.
 */

const UNSAFE_SELECTOR_RE = /[{};\\]|\/\*/;
const INPUT_LABELS = {
  email: 'Correo electrónico',
  search: 'Buscar',
  tel: 'Teléfono',
  password: 'Contraseña',
  url: 'Dirección web',
  number: 'Número',
  date: 'Fecha'
};
const NAME_HINTS = [
  [/cart|carrito|basket/, 'Ver carrito'],
  [/next|siguiente|right|forward/, 'Siguiente'],
  [/prev|anterior|left|back/, 'Anterior'],
  [/search|buscar/, 'Buscar'],
  [/close|cerrar|dismiss/, 'Cerrar'],
  [/menu|hamburger|nav/, 'Abrir menú'],
  [/theme|tema|dark|light/, 'Cambiar tema'],
  [/play|reproducir/, 'Reproducir'],
  [/share|compartir/, 'Compartir']
];

/** Rule ids emitted by the DOM auditor, plus legacy aliases kept for older tickets. */
const RULE_ALIASES = {
  'overflow-horizontal': 'overflow-container',
  'tap-target-undersized': 'tap-target-size',
  'a11y-missing-label': 'a11y-accessible-name'
};

function inferControlName(finding) {
  const haystack = `${finding.selector || ''} ${finding.description || ''}`.toLowerCase();
  return NAME_HINTS.find(([pattern]) => pattern.test(haystack))?.[1] ?? 'Botón';
}

function inferFieldLabel(finding) {
  const type = /type=([a-z-]+)/i.exec(String(finding.actual || ''))?.[1]?.toLowerCase();
  return INPUT_LABELS[type] ?? 'Campo de formulario';
}

const RECIPES = {
  'overflow-container': () => ({
    type: 'css',
    title: 'Contener el desborde horizontal dentro del elemento',
    declarations: { 'max-width': '100%', 'box-sizing': 'border-box', 'overflow-x': 'auto' }
  }),
  'tap-target-size': () => ({
    type: 'css',
    title: 'Ampliar el área táctil a 44×44 px',
    declarations: {
      'min-width': '44px',
      'min-height': '44px',
      display: 'inline-flex',
      'align-items': 'center',
      'justify-content': 'center'
    }
  }),
  'a11y-accessible-name': (finding) => ({
    type: 'attr',
    title: 'Añadir nombre accesible (aria-label)',
    attr: { name: 'aria-label', value: inferControlName(finding) }
  }),
  'a11y-form-label': (finding) => ({
    type: 'attr',
    title: 'Añadir etiqueta accesible al campo (aria-label)',
    attr: { name: 'aria-label', value: inferFieldLabel(finding) }
  })
};

/** Rule ids (canonical) that have an automatic patch recipe. */
export const PATCHABLE_RULES = Object.freeze(Object.keys(RECIPES));

const toCss = (selector, declarations) =>
  `${selector} { ${Object.entries(declarations)
    .map(([prop, value]) => `${prop}: ${value};`)
    .join(' ')} }`;

/** Builds a patch for a finding/ticket, or `null` when the rule has no safe automatic recipe. */
export function generatePatch(finding) {
  const selector = typeof finding?.selector === 'string' ? finding.selector.trim() : '';
  if (!finding?.ruleId || !selector || selector.length > 280 || UNSAFE_SELECTOR_RE.test(selector)) return null;
  if (selector === 'document' || selector === 'html' || selector === 'body') return null;
  const ruleId = RULE_ALIASES[finding.ruleId] ?? finding.ruleId;
  if (!Object.hasOwn(RECIPES, ruleId)) return null;
  const recipe = RECIPES[ruleId](finding);
  return {
    id: `patch-${randomUUID().slice(0, 8)}`,
    ruleId,
    selector,
    ...recipe,
    ...(recipe.declarations ? { css: toCss(selector, recipe.declarations) } : {})
  };
}

/** Serializable manifest of applied patches, meant to be ported to the application source. */
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
