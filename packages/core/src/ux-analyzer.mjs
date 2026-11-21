/**
 * Senior UX, Information Architecture & Multi-Viewport Critique Analyzer.
 * Turns raw page structure + multi-screen DOM audits into human-readable product recommendations.
 */

const SLUG_RE = /[^a-z0-9]+/g;
const slugify = (text) =>
  String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(SLUG_RE, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);

function uniqueRoutesFromPage(elements = []) {
  const seen = new Set();
  const routes = [];
  for (const el of elements) {
    if (el.tag === 'a' && typeof el.href === 'string' && el.href.includes('#')) {
      const hash = el.href.split('#')[1]?.trim();
      const slug = slugify(hash);
      if (slug && slug !== 'inicio' && slug !== 'top' && !seen.has(slug)) {
        seen.add(slug);
        routes.push(`/${slug}`);
      }
    }
  }
  if (routes.length < 2) {
    for (const el of elements) {
      if (el.tag !== 'h2' || !el.name) continue;
      const slug = slugify(el.name.split(/\s+/).slice(0, 2).join(' '));
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        routes.push(`/${slug}`);
      }
      if (routes.length >= 4) break;
    }
  }
  return routes.slice(0, 4);
}

function summarizeViewport(vp) {
  const findings = Array.isArray(vp?.findings) ? vp.findings : [];
  const byCategory = {};
  for (const f of findings) byCategory[f.category || 'other'] = (byCategory[f.category || 'other'] || 0) + 1;
  return {
    name: vp.name,
    width: vp.width,
    height: vp.height,
    totalFindings: findings.length,
    p1: findings.filter((f) => f.severity === 'P1').length,
    p2: findings.filter((f) => f.severity === 'P2').length,
    byCategory
  };
}

/** Produces prioritized UX, architecture, and responsive recommendations from live page telemetry. */
export function analyzeUxAndArchitecture({ snapshot = {}, auditsByViewport = [] } = {}) {
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  const vh = snapshot.viewport?.height || 800;
  const totalHeight = (snapshot.scroll?.maxY || 0) + vh;
  const screensLong = Math.round((totalHeight / Math.max(300, vh)) * 10) / 10;
  const headings = elements.filter((e) => e.tag === 'h1' || e.tag === 'h2');
  const h2s = elements.filter((e) => e.tag === 'h2');
  const hashLinks = elements.filter((e) => e.tag === 'a' && typeof e.href === 'string' && e.href.includes('#'));
  const buttons = elements.filter((e) => e.tag === 'button');
  const inputs = elements.filter((e) => e.tag === 'input' || e.tag === 'select');

  const viewportMatrix = auditsByViewport.map(summarizeViewport);
  const allFindings = auditsByViewport.flatMap((v) => v.findings || []);
  const recommendations = [];

  // 1. Arquitectura de información: landing monolítica vs separación por vistas
  const suggestedRoutes = uniqueRoutesFromPage(elements);
  if (screensLong >= 3.2 || h2s.length >= 3 || hashLinks.length >= 3) {
    const routeHint = suggestedRoutes.length ? ` (ej. /, ${suggestedRoutes.join(', ')})` : ' (ej. /, /catalogo, /nosotros, /contacto)';
    recommendations.push({
      id: 'UX-ARCH-1',
      priority: 'P1',
      role: 'Arquitecto UX',
      agentId: 'layout',
      color: '#A78BFA',
      kind: 'decision',
      selector: h2s[0]?.selector || headings[0]?.selector || 'main',
      title: 'Separar la aplicación en vistas dedicadas',
      finding: `La página concentra ${screensLong} pantallas de scroll vertical, ${h2s.length} secciones principales y ${elements.length} elementos interactivos en una sola vista.`,
      recommendation: `Dividir el flujo en vistas independientes${routeHint} para evitar saturación visual, reducir la fatiga de scroll y mejorar el foco del usuario.`
    });
  }

  // 2. Densidad de catálogo / controles repetidos
  const labelCounts = new Map();
  for (const b of buttons) {
    const key = String(b.name || '').trim().toLowerCase();
    if (key) labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
  }
  const repeatedCta = [...labelCounts.entries()].find(([, count]) => count >= 4);
  if (repeatedCta || (inputs.length >= 1 && buttons.length >= 10)) {
    const targetBtn = buttons.find((b) => String(b.name || '').trim().toLowerCase() === repeatedCta?.[0]) || inputs[0];
    recommendations.push({
      id: 'UX-UI-2',
      priority: 'P2',
      role: 'Diseñador UI',
      agentId: 'layout',
      color: '#38BDF8',
      kind: 'report',
      selector: targetBtn?.selector || 'main',
      title: 'Aislar el catálogo y reducir ruido visual en tarjetas',
      finding: repeatedCta
        ? `Se repiten ${repeatedCta[1]} botones "${repeatedCta[0]}" junto a filtros y secciones informativas en la misma vista.`
        : `Alta densidad de controles (${buttons.length} botones y ${inputs.length} campos) compitiendo por atención en la misma pantalla.`,
      recommendation: 'Llevar el catálogo a su propia vista con barra de filtros limpia y paginación/carga progresiva para no interrumpir el recorrido principal.'
    });
  }

  // 3. Responsive multi-pantalla (Desktop, Tablet, Mobile)
  const mobile = viewportMatrix.find((v) => v.width <= 480);
  const tablet = viewportMatrix.find((v) => v.width > 480 && v.width <= 900);
  const desktop = viewportMatrix.find((v) => v.width > 900);
  const responsiveIssues = allFindings.filter((f) => ['overflow', 'overlap', 'tap-target'].includes(f.category));
  if (responsiveIssues.length > 0) {
    const worst = mobile?.totalFindings >= (desktop?.totalFindings || 0) ? mobile : desktop || viewportMatrix[0];
    recommendations.push({
      id: 'UX-RESP-3',
      priority: mobile?.p1 > 0 || desktop?.p1 > 0 ? 'P1' : 'P2',
      role: 'Responsive QA',
      agentId: 'responsive',
      color: '#34D399',
      kind: 'report',
      selector: responsiveIssues[0]?.selector || 'body',
      title: `Fricción responsive detectada en ${viewportMatrix.length} resoluciones`,
      finding: `Escritorio: ${desktop?.totalFindings ?? 0} · Tablet: ${tablet?.totalFindings ?? 0} · Móvil (390px): ${mobile?.totalFindings ?? 0} hallazgos (desbordes, solapamientos o botones pequeños).`,
      recommendation: `Corregir contenedores desbordados y controles táctiles (<44px) priorizando la vista ${worst?.name || 'móvil'} para evitar recortes y scroll horizontal.`
    });
  }

  // 4. Salud funcional (API 5xx, imágenes rotas, accesibilidad)
  const net5xx = allFindings.filter((f) => f.ruleId === 'console-net-5xx');
  const brokenMedia = allFindings.filter((f) => f.category === 'media');
  const a11y = allFindings.filter((f) => f.category === 'a11y');
  if (net5xx.length || brokenMedia.length || a11y.length) {
    const parts = [];
    if (net5xx.length) parts.push(`${net5xx.length} errores HTTP 5xx de backend`);
    if (brokenMedia.length) parts.push(`${brokenMedia.length} imágenes rotas`);
    if (a11y.length) parts.push(`${a11y.length} fallos de accesibilidad`);
    recommendations.push({
      id: 'UX-QA-4',
      priority: net5xx.length || brokenMedia.length ? 'P1' : 'P2',
      role: 'QA Lead',
      agentId: 'console-net',
      color: '#FBBF24',
      kind: 'report',
      selector: brokenMedia[0]?.selector || a11y[0]?.selector || 'body',
      title: 'Impacto directo en confianza y disponibilidad',
      finding: `Detectados ${parts.join(', ')} durante el recorrido real.`,
      recommendation: 'Restaurar endpoints 5xx, añadir fallback visual para imágenes rotas y agregar aria-label/labels accesibles en controles clave.'
    });
  }

  return {
    url: snapshot.url || '',
    title: snapshot.title || '',
    metrics: { screensLong, sectionsH2: h2s.length, interactiveElements: elements.length, suggestedRoutes },
    viewportMatrix,
    recommendations
  };
}

/** Formats a UX critique report into readable Markdown for `.qa/ux-critique.md`. */
export function formatUxCritiqueMarkdown(report) {
  const lines = [
    `# Dictamen UX, Arquitectura y Responsive — ${report.title || report.url}`,
    '',
    `- **URL:** ${report.url}`,
    `- **Extensión vertical:** ~${report.metrics.screensLong} pantallas · **Secciones H2:** ${report.metrics.sectionsH2} · **Controles:** ${report.metrics.interactiveElements}`,
    '',
    '## Matriz Responsive Multi-Pantalla',
    '',
    '| Pantalla | Resolución | Hallazgos | P1 | P2 |',
    '| :--- | :---: | :---: | :---: | :---: |',
    ...report.viewportMatrix.map((v) => `| ${v.name} | ${v.width}×${v.height} | ${v.totalFindings} | ${v.p1} | ${v.p2} |`),
    '',
    '## Recomendaciones del Enjambre',
    ''
  ];
  for (const r of report.recommendations) {
    lines.push(`### [${r.priority}] ${r.title} *(${r.role})*`);
    lines.push(`- **Hallazgo:** ${r.finding}`);
    lines.push(`- **Recomendación:** ${r.recommendation}`);
    lines.push(`- **Objetivo DOM:** \`${r.selector}\``);
    lines.push('');
  }
  return lines.join('\n');
}
