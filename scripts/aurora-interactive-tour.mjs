import { writeFileSync, mkdirSync } from 'node:fs';
import { readBusRegistry } from '../packages/core/src/session-auth.mjs';

const reg = readBusRegistry();
if (!reg) { console.error('Bus no encontrado en el registro.'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(action, params = {}) {
  const res = await fetch(`http://${reg.host}:${reg.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-swarm-token': reg.token },
    body: JSON.stringify({ action, params })
  });
  return res.json();
}

async function tabCmd(tabId, command, agentId = null) {
  return rpc('tab.command', { tabId, command, ...(agentId ? { agentId } : {}) });
}

async function moveWithSelector(tabId, agent, selector, status) {
  return tabCmd(tabId, { action: 'move_cursor', cursor: { id: agent, selector, status } });
}

async function safeClick(tabId, selector) {
  try {
    await rpc('lock.acquire', { agentId: 'interactive', tabId, role: 'interactive' });
    const res = await tabCmd(tabId, { action: 'click', selector }, 'interactive');
    await rpc('lock.release', { agentId: 'interactive', tabId });
    return res;
  } catch (err) {
    await rpc('lock.release', { agentId: 'interactive', tabId }).catch(() => {});
    return null;
  }
}

const ROLES = [
  { id: 'layout', name: 'Layout Inspector', role: 'layout', color: '#38BDF8', status: 'Iniciando sesión' },
  { id: 'a11y', name: 'Forms & A11y', role: 'forms-a11y', color: '#34D399', status: 'Iniciando sesión' },
  { id: 'responsive', name: 'Responsive QA', role: 'responsive', color: '#A78BFA', status: 'Iniciando sesión' },
  { id: 'interactive', name: 'Interactive QA', role: 'interactive', color: '#F472B6', status: 'Coordinador listo' }
];

async function main() {
  const status = await rpc('session.status');
  const tab = status.result?.tabs?.[0];
  if (!tab) { console.error('No hay pestañas activas conectadas al bus.'); process.exit(1); }
  const tabId = tab.tabId;
  const tickets = [];

  console.log(`[Swarm Tour Aurora Cero] Conectado a pestaña ${tabId} (${tab.url})`);

  // Asegurar navegación a la ficha de Aurora Cero
  await rpc('lock.acquire', { agentId: 'interactive', tabId, role: 'interactive' });
  await tabCmd(tabId, { action: 'navigate', url: 'https://glactintogames.com/juegos/aurora-cero' }, 'interactive');
  await rpc('lock.release', { agentId: 'interactive', tabId });
  await sleep(2000);

  // 1. Spawning
  await safeClick(tabId, '#raiz > header');
  await tabCmd(tabId, { action: 'spawn_cursors', cursors: ROLES });
  await tabCmd(tabId, { action: 'update_summary', summary: { agents: 4, open: 0, awaiting: 0, verified: 0 } });
  await sleep(1000);

  // FASE 1: HEADER
  console.log('--- FASE 1: INSPECCIÓN DEL HEADER ---');
  await moveWithSelector(tabId, 'responsive', '#raiz > header > div > nav', 'Midiendo navegación principal');
  await sleep(1200);
  await moveWithSelector(tabId, 'layout', '#raiz > a', 'Detectando salto raíz (desborde)');
  tickets.push({ id: 'AURORA-1', ruleId: 'overflow-container', severity: 'P2', title: 'Contenedor enlace raíz con desborde', status: 'open', selector: '#raiz > a' });
  await tabCmd(tabId, { action: 'set_tickets', tickets });
  await tabCmd(tabId, { action: 'update_summary', summary: { agents: 4, open: 1, awaiting: 0, verified: 0 } });
  await sleep(1400);

  // FASE 2: HERO & TITULO
  console.log('--- FASE 2: AUDITORÍA EN HERO SECTION ---');
  await moveWithSelector(tabId, 'interactive', '#contenido > section:nth-of-type(1)', 'Inspeccionando ficha de Aurora Cero');
  await sleep(1000);
  await moveWithSelector(tabId, 'layout', '#contenido > div:nth-of-type(1) > div > div:nth-of-type(1)', 'Alerta: Ancho de 1520px excede viewport');
  tickets.push({ id: 'AURORA-2', ruleId: 'overflow-container', severity: 'P2', title: 'Banner Hero desborda 1520px', status: 'open', selector: '#contenido > div:nth-of-type(1) > div > div:nth-of-type(1)' });
  await tabCmd(tabId, { action: 'set_tickets', tickets });
  await tabCmd(tabId, { action: 'update_summary', summary: { agents: 4, open: 2, awaiting: 0, verified: 0 } });
  await sleep(1400);

  // FASE 3: SCROLL A GALERÍA
  console.log('--- FASE 3: SCROLL A GALERÍA Y CAPTURAS ---');
  await safeClick(tabId, '#galeria-titulo');
  await sleep(1000);
  await moveWithSelector(tabId, 'a11y', '#galeria-titulo', 'Analizando título de galería');
  tickets.push({ id: 'AURORA-3', ruleId: 'overflow-container', severity: 'P2', title: 'Título galería con desborde en contenedor', status: 'open', selector: '#galeria-titulo' });
  await tabCmd(tabId, { action: 'set_tickets', tickets });
  await tabCmd(tabId, { action: 'update_summary', summary: { agents: 4, open: 3, awaiting: 0, verified: 0 } });
  await sleep(1400);

  await moveWithSelector(tabId, 'responsive', 'div > div > div:nth-of-type(1) > img', 'Comprobando carga de captura 4K');
  await sleep(1200);

  // FASE 4: SCROLL A FOOTER
  console.log('--- FASE 4: SCROLL A FOOTER Y CRÉDITOS ---');
  await safeClick(tabId, '#raiz > footer');
  await sleep(1000);
  await moveWithSelector(tabId, 'interactive', '#raiz > footer', 'Revisando enlaces de pie de página');
  await sleep(1400);

  // FASE 5: REGRESO A CABECERA
  console.log('--- FASE 5: RETORNO A CABECERA ---');
  await safeClick(tabId, '#raiz > header');
  await sleep(800);
  await moveWithSelector(tabId, 'interactive', '#raiz > header', 'Auditoría completada');

  mkdirSync('.qa', { recursive: true });
  writeFileSync('.qa/latest.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    tabId, url: tab.url,
    totalFindings: tickets.length,
    tickets
  }, null, 2));

  console.log(`[Swarm Tour Aurora Cero] Finalizado con ${tickets.length} hallazgos registrados.`);
}

main().catch(console.error);
