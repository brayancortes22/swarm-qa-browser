export const AGENTS = [
  { id: 'layout', name: 'Layout Inspector', role: 'layout', color: '#38BDF8', x: 120, y: 70, width: 80, height: 30, status: 'Iniciando sesión' },
  { id: 'a11y', name: 'Forms & A11y', role: 'forms-a11y', color: '#34D399', x: 220, y: 70, width: 80, height: 30, status: 'Iniciando sesión' },
  { id: 'responsive', name: 'Responsive QA', role: 'responsive', color: '#A78BFA', x: 320, y: 70, width: 80, height: 30, status: 'Iniciando sesión' },
  { id: 'interactive', name: 'Interactive QA', role: 'interactive', color: '#F472B6', x: 420, y: 70, width: 80, height: 30, status: 'Coordinador listo' }
];

export const INICIO_STEPS = [
  {
    agent: 'responsive',
    x: 180, y: 65, w: 170, h: 48,
    status: 'Midiendo Logo Yanbal Prestige',
    hud: { open: 0, agents: 4 }
  },
  {
    agent: 'layout',
    x: 1320, y: 65, w: 98, h: 44,
    status: '¡Alerta! Desborde en botón Carrito (4px)',
    finding: { id: 'YANBAL-1', ruleId: 'overflow-horizontal', severity: 'warn', title: 'Desborde horizontal en botón Carrito' },
    hud: { open: 1, agents: 4 }
  },
  {
    agent: 'a11y',
    x: 36, y: 375, w: 46, h: 46,
    status: 'Falla: Falta aria-label en flecha carrusel',
    finding: { id: 'YANBAL-2', ruleId: 'a11y-missing-label', severity: 'crit', title: 'Botón de carrusel sin nombre accesible' },
    hud: { open: 2, agents: 4 }
  },
  {
    agent: 'interactive',
    x: 1475, y: 375, w: 46, h: 46,
    status: 'Probando clic en flecha carrusel...',
    realClick: true,
    hud: { open: 2, agents: 4 }
  },
  {
    agent: 'interactive',
    x: 195, y: 535, w: 195, h: 50,
    status: 'Verificando botón CTA: Conoce Más...',
    hud: { open: 2, agents: 4 }
  },
  {
    agent: 'responsive',
    x: 760, y: 605, w: 56, h: 24,
    status: 'Auditando dots paginación carrusel',
    hud: { open: 2, agents: 4 }
  }
];

export const SCROLL_INICIO_STEPS = [
  {
    agent: 'interactive',
    scrollTo: 'main section:nth-of-type(2)',
    x: 760, y: 350, w: 300, h: 60,
    status: 'Haciendo scroll a sección de productos...'
  },
  {
    agent: 'layout',
    x: 480, y: 400, w: 260, h: 320,
    status: 'Midiendo tarjeta de producto destacada (desborde 13px)',
    finding: { id: 'YANBAL-3', ruleId: 'overflow-horizontal', severity: 'warn', title: 'Tarjeta de producto con desborde' },
    hud: { open: 3, agents: 4 }
  },
  {
    agent: 'a11y',
    x: 820, y: 450, w: 200, h: 50,
    status: 'Verificando contraste de precios COP',
    hud: { open: 3, agents: 4 }
  }
];

export const CONVOCATORIA_STEPS = [
  {
    agent: 'layout', x: 530, y: 65, w: 75, h: 36, status: 'Reagrupando en Catálogo'
  },
  {
    agent: 'a11y', x: 485, y: 65, w: 60, h: 32, status: 'Listo para navegación'
  },
  {
    agent: 'responsive', x: 580, y: 65, w: 70, h: 32, status: 'Monitoreando viewport'
  },
  {
    agent: 'interactive', x: 535, y: 65, w: 80, h: 36, status: 'Navegando a Catálogo...', realClick: true
  }
];

export const CATALOGO_STEPS = [
  {
    agent: 'layout',
    x: 280, y: 280, w: 240, h: 340,
    status: 'Auditando cuadrícula de catálogo #1',
    finding: { id: 'YANBAL-4', ruleId: 'grid-spacing', severity: 'info', title: 'Rejilla alineada con espaciado 24px' },
    hud: { open: 4, agents: 4 }
  },
  {
    agent: 'a11y',
    x: 580, y: 300, w: 240, h: 340,
    status: 'Comprobando etiquetas alt en productos',
    hud: { open: 4, agents: 4 }
  },
  {
    agent: 'responsive',
    x: 880, y: 300, w: 240, h: 340,
    status: 'Verificando carga de imágenes cosméticos',
    hud: { open: 4, agents: 4 }
  },
  {
    agent: 'interactive',
    x: 1180, y: 220, w: 180, h: 44,
    status: 'Probando filtro de categorías',
    hud: { open: 4, agents: 4 }
  }
];
