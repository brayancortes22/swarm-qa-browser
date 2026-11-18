export const AGENTS = [
  { id: 'layout', name: 'Layout Inspector', role: 'layout', color: '#38BDF8', status: 'Iniciando sesión' },
  { id: 'a11y', name: 'Forms & A11y', role: 'forms-a11y', color: '#34D399', status: 'Iniciando sesión' },
  { id: 'responsive', name: 'Responsive QA', role: 'responsive', color: '#A78BFA', status: 'Iniciando sesión' },
  { id: 'interactive', name: 'Interactive QA', role: 'interactive', color: '#F472B6', status: 'Coordinador listo' }
];

export const INICIO_STEPS = [
  {
    agent: 'responsive',
    selector: 'header a[href="/"], header h1, header img',
    status: 'Midiendo Logo Yanbal Prestige',
    hud: { open: 0, agents: 4 }
  },
  {
    agent: 'layout',
    selector: 'header button',
    status: '¡Alerta! Desborde en botón Carrito (4px)',
    finding: { id: 'YANBAL-1', ruleId: 'overflow-horizontal', severity: 'warn', title: 'Desborde horizontal en botón Carrito' },
    hud: { open: 1, agents: 4 }
  },
  {
    agent: 'a11y',
    selector: 'main section:nth-of-type(1) button:nth-of-type(1)',
    status: 'Falla: Falta aria-label en flecha carrusel',
    finding: { id: 'YANBAL-2', ruleId: 'a11y-missing-label', severity: 'crit', title: 'Botón de carrusel sin nombre accesible' },
    hud: { open: 2, agents: 4 }
  },
  {
    agent: 'interactive',
    selector: 'main section:nth-of-type(1) button:nth-of-type(2)',
    status: 'Probando clic en flecha carrusel...',
    realClick: true,
    hud: { open: 2, agents: 4 }
  },
  {
    agent: 'interactive',
    selector: 'main section:nth-of-type(1) a[href*="catalogo"], main section:nth-of-type(1) a',
    status: 'Verificando botón CTA: Conoce Más...',
    hud: { open: 2, agents: 4 }
  }
];

export const SCROLL_INICIO_STEPS = [
  {
    agent: 'interactive',
    scrollTo: 'main section:nth-of-type(2)',
    selector: 'main section:nth-of-type(2) h2, main section:nth-of-type(2)',
    status: 'Haciendo scroll a sección de productos...'
  },
  {
    agent: 'layout',
    selector: 'main section:nth-of-type(2) div[class*="grid"] > div:nth-child(1), main section:nth-of-type(2) article',
    status: 'Midiendo tarjeta de producto destacada (desborde 13px)',
    finding: { id: 'YANBAL-3', ruleId: 'overflow-horizontal', severity: 'warn', title: 'Tarjeta de producto con desborde' },
    hud: { open: 3, agents: 4 }
  }
];

export const CONVOCATORIA_STEPS = [
  { agent: 'layout', selector: 'header nav a[href*="catalogo"], header nav a:nth-child(2)', status: 'Reagrupando en Catálogo' },
  { agent: 'a11y', selector: 'header nav a[href*="catalogo"], header nav a:nth-child(2)', status: 'Listo para navegación' },
  { agent: 'responsive', selector: 'header nav a[href*="catalogo"], header nav a:nth-child(2)', status: 'Monitoreando viewport' },
  { agent: 'interactive', selector: 'header nav a[href*="catalogo"], header nav a:nth-child(2)', status: 'Navegando a Catálogo...', realClick: true }
];

export const CATALOGO_STEPS = [
  {
    agent: 'layout',
    selector: 'main > div > div > div:nth-of-type(3) > div:nth-of-type(1)',
    status: 'Auditando tarjeta de producto #1 real',
    finding: { id: 'YANBAL-4', ruleId: 'grid-spacing', severity: 'info', title: 'Rejilla alineada con espaciado 24px' },
    hud: { open: 4, agents: 4 }
  },
  {
    agent: 'a11y',
    selector: 'select',
    status: 'Dropdown Ordenar por sin etiqueta accesible',
    finding: { id: 'YANBAL-5', ruleId: 'a11y-form-label', severity: 'warn', title: 'Form select sin label ni aria-label' },
    hud: { open: 5, agents: 4 }
  },
  {
    agent: 'responsive',
    selector: 'header input',
    status: 'Inspeccionando buscador de productos',
    hud: { open: 5, agents: 4 }
  },
  {
    agent: 'interactive',
    selector: 'main > div > div > div:nth-of-type(3) > div:nth-of-type(2)',
    status: 'Verificando tarjeta de producto #2',
    hud: { open: 5, agents: 4 }
  }
];
