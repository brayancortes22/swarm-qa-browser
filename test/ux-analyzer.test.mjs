import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeUxAndArchitecture, formatUxCritiqueMarkdown } from '../packages/core/src/ux-analyzer.mjs';

test('analyzeUxAndArchitecture recommends splitting monolithic pages into dedicated views', () => {
  const snapshot = {
    url: 'https://tienda.example.com/',
    title: 'Tienda Artesanal',
    viewport: { width: 1440, height: 800 },
    scroll: { x: 0, y: 0, maxY: 3200 },
    elements: [
      { tag: 'h1', name: 'Tienda Artesanal', selector: 'h1' },
      { tag: 'a', name: 'Catálogo', href: '#catalogo', selector: 'nav a:nth-of-type(1)' },
      { tag: 'a', name: 'Nosotros', href: '#nosotros', selector: 'nav a:nth-of-type(2)' },
      { tag: 'a', name: 'Contacto', href: '#contacto', selector: 'nav a:nth-of-type(3)' },
      { tag: 'h2', name: 'Catálogo', selector: '#catalogo h2' },
      { tag: 'h2', name: 'Nosotros', selector: '#nosotros h2' },
      { tag: 'h2', name: 'Contacto', selector: '#contacto h2' },
      { tag: 'button', name: 'Agregar', selector: 'article:nth-of-type(1) button' },
      { tag: 'button', name: 'Agregar', selector: 'article:nth-of-type(2) button' },
      { tag: 'button', name: 'Agregar', selector: 'article:nth-of-type(3) button' },
      { tag: 'button', name: 'Agregar', selector: 'article:nth-of-type(4) button' }
    ]
  };
  const auditsByViewport = [
    { name: 'Escritorio', width: 1440, height: 900, findings: [{ severity: 'P2', category: 'overflow', ruleId: 'overflow-container', selector: '#catalogo' }] },
    { name: 'Tablet', width: 768, height: 1024, findings: [] },
    {
      name: 'Móvil',
      width: 390,
      height: 844,
      findings: [
        { severity: 'P1', category: 'console-net', ruleId: 'console-net-5xx', selector: 'https://api.example.com/products' },
        { severity: 'P2', category: 'tap-target', ruleId: 'tap-target-small', selector: 'button.whatsapp' }
      ]
    }
  ];

  const report = analyzeUxAndArchitecture({ snapshot, auditsByViewport });
  assert.equal(report.viewportMatrix.length, 3);
  assert.ok(report.recommendations.some((r) => r.id === 'UX-ARCH-1' && r.recommendation.includes('/catalogo')));
  assert.ok(report.recommendations.some((r) => r.id === 'UX-UI-2'));
  assert.ok(report.recommendations.some((r) => r.id === 'UX-RESP-3'));
  assert.ok(report.recommendations.some((r) => r.id === 'UX-QA-4'));

  const md = formatUxCritiqueMarkdown(report);
  assert.ok(md.includes('Matriz Responsive Multi-Pantalla'));
  assert.ok(md.includes('390×844'));
  assert.ok(md.includes('Separar la aplicación en vistas dedicadas'));
});
