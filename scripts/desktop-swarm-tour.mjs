import { writeFileSync, mkdirSync } from 'node:fs';
import { auditDesktopWindows, focusDesktopTarget } from '../packages/desktop-adapter/src/desktop-session.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROLES = [
  { id: 'layout', name: 'Layout Inspector', role: 'layout', color: '#38BDF8', status: 'Iniciando escáner de ventanas' },
  { id: 'a11y', name: 'Forms & A11y', role: 'forms-a11y', color: '#34D399', status: 'Iniciando verificación de títulos OS' },
  { id: 'responsive', name: 'Responsive QA', role: 'responsive', color: '#A78BFA', status: 'Midiendo resoluciones de pantalla' },
  { id: 'interactive', name: 'Interactive QA', role: 'interactive', color: '#F472B6', status: 'Controlador de foco listo' }
];

async function main() {
  console.log('🛸 ===============================================');
  console.log('🛸 SWARM DESKTOP — AUDITORÍA DE SISTEMA OPERATIVO');
  console.log('🛸 ===============================================\n');

  console.log('1. Escaneando ventanas abiertas en el escritorio de Windows...');
  const audit = auditDesktopWindows({ monitorWidth: 1920, monitorHeight: 1080 });

  console.log(`\nMonitor detectado: ${audit.monitor.width}x${audit.monitor.height}`);
  console.log(`Ventanas del sistema analizadas: ${audit.totalWindowsScanned}`);
  console.log(`Aplicaciones auditables activas: ${audit.auditableWindows}\n`);

  if (!audit.windows.length) {
    console.log('No se encontraron aplicaciones auditables en este momento.');
    return;
  }

  // Despliegue de los 4 agentes sobre las ventanas del OS
  console.log('--- FASE 1: DESPLIEGUE DEL ENJAMBRE EN EL ESCRITORIO ---');
  for (const agent of ROLES) {
    console.log(`  [+] Agente @${agent.id} (${agent.name}) listo en canal ${agent.color}`);
  }
  await sleep(1000);

  console.log('\n--- FASE 2: INSPECCIÓN ESPACIAL DE VENTANAS NATIVAS ---');
  const tickets = [];

  for (let i = 0; i < audit.windows.length; i += 1) {
    const win = audit.windows[i];
    console.log(`\n[Objetivo ${i + 1}/${audit.windows.length}] "${win.title}"`);
    console.log(`  PID: ${win.pid} | HWND: ${win.hwnd}`);
    console.log(`  Coordenadas en pantalla: x=${win.rect.x}, y=${win.rect.y}, w=${win.rect.width}, h=${win.rect.height}`);

    // Asignación de Agente @layout para medir desborde
    console.log(`  -> @layout: Verificando geometría y límites de monitor...`);
    const isOverflow = win.rect.x < -10 || (win.rect.x + win.rect.width) > 1940;
    if (isOverflow) {
      console.log(`     ⚠️  Alerta: Ventana se extiende más allá de los bordes del monitor.`);
      tickets.push({ id: `DESK-TICK-${i + 1}`, ruleId: 'desktop-window-overflow', title: `Ventana ${win.title} en borde exterior`, severity: 'P2', target: win });
    } else {
      console.log(`     ✅ Geometría dentro del viewport seguro.`);
    }
    await sleep(600);

    // Asignación de Agente @a11y para verificar título
    console.log(`  -> @a11y: Auditando nombre accesible del proceso...`);
    if (win.title.length < 4) {
      console.log(`     ⚠️  Alerta: Título de ventana corto o genérico.`);
      tickets.push({ id: `DESK-TICK-A11Y-${i + 1}`, ruleId: 'desktop-unnamed-window', title: `Título poco descriptivo`, severity: 'P3', target: win });
    } else {
      console.log(`     ✅ Nombre accesible identificado: "${win.title.slice(0, 40)}"`);
    }
    await sleep(600);

    // Asignación de Agente @interactive para probar foco seguro
    if (i === 0) {
      console.log(`  -> @interactive: Adquiriendo cerrojo de foco para ventana...`);
      const focused = focusDesktopTarget(win);
      console.log(`     ${focused ? '✅ Foco de primer plano aplicado con éxito.' : 'ℹ️ Foco en segundo plano mantenido.'}`);
    }
  }

  // Guardar reporte formal de auditoría
  mkdirSync('.qa', { recursive: true });
  const finalReport = {
    timestamp: new Date().toISOString(),
    os: 'Windows 11',
    monitor: audit.monitor,
    totalAuditedWindows: audit.windows.length,
    windows: audit.windows,
    totalTickets: tickets.length,
    tickets
  };

  writeFileSync('.qa/desktop-audit.json', JSON.stringify(finalReport, null, 2));

  console.log('\n===============================================');
  console.log(`AUDITORÍA DE ESCRITORIO FINALIZADA: ${tickets.length} hallazgos registrados.`);
  console.log(`Informe persistido en: .qa/desktop-audit.json`);
  console.log('===============================================');
}

main().catch(console.error);
