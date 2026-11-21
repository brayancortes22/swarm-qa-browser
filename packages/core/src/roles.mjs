const FALLBACK_COLORS = ['#60A5FA', '#FB7185', '#2DD4BF', '#F97316', '#C084FC'];

/**
 * Default multi-cursor QA swarm roles with display metadata and mutation permissions.
 */
export const DEFAULT_ROLES = Object.freeze({
  layout: Object.freeze({
    id: 'layout',
    label: 'Layout',
    color: '#38BDF8',
    readOnly: true,
    description: 'Audits box geometry, horizontal overflow, and element collisions.'
  }),
  responsive: Object.freeze({
    id: 'responsive',
    label: 'Responsive',
    color: '#A78BFA',
    readOnly: false,
    description: 'Switches viewports (390px/1440px) and checks mobile tap targets.'
  }),
  'forms-a11y': Object.freeze({
    id: 'forms-a11y',
    label: 'Forms & A11y',
    color: '#34D399',
    readOnly: true,
    description: 'Inspects accessible names, labels, form controls, and ARIA semantics.'
  }),
  'console-net': Object.freeze({
    id: 'console-net',
    label: 'Console & Net',
    color: '#FBBF24',
    readOnly: true,
    description: 'Monitors runtime errors, rejected promises, and HTTP >= 400 responses.'
  }),
  interactive: Object.freeze({
    id: 'interactive',
    label: 'Interactive',
    color: '#F472B6',
    readOnly: false,
    description: 'Executes locked real clicks, form inputs, and route transitions.'
  })
});

function normalizeKey(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function pickFallbackColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

function matchDefaultRole(candidate) {
  if (!candidate) return null;
  const key = normalizeKey(candidate);
  if (DEFAULT_ROLES[key]) return DEFAULT_ROLES[key];
  for (const roleKey of Object.keys(DEFAULT_ROLES)) {
    if (key.includes(roleKey)) return DEFAULT_ROLES[roleKey];
  }
  return null;
}

/**
 * Resolves a role key or agent descriptor into a normalized role configuration.
 */
export function resolveRole(roleOrAgent) {
  if (typeof roleOrAgent === 'string') {
    const matched = matchDefaultRole(roleOrAgent);
    if (matched) return { ...matched };
    const id = normalizeKey(roleOrAgent) || 'qa-observer';
    return {
      id,
      label: roleOrAgent.trim() || 'QA Observer',
      color: pickFallbackColor(id),
      readOnly: true,
      description: 'Custom QA swarm agent role.'
    };
  }

  if (roleOrAgent && typeof roleOrAgent === 'object') {
    const base = matchDefaultRole(roleOrAgent.role ?? roleOrAgent.roleId) ?? matchDefaultRole(roleOrAgent.id);
    const id = base?.id ?? (normalizeKey(roleOrAgent.role ?? roleOrAgent.id ?? 'qa-observer') || 'qa-observer');
    return {
      id,
      label: roleOrAgent.label ?? base?.label ?? id,
      color: roleOrAgent.color ?? base?.color ?? pickFallbackColor(id),
      readOnly: typeof roleOrAgent.readOnly === 'boolean' ? roleOrAgent.readOnly : (base?.readOnly ?? true),
      description: roleOrAgent.description ?? base?.description ?? 'Custom QA swarm agent role.'
    };
  }

  return { ...DEFAULT_ROLES.layout };
}
