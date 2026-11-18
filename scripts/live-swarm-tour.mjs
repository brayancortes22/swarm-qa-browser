import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readBusRegistry } from '../packages/core/src/session-auth.mjs';
import { AGENTS, INICIO_STEPS, SCROLL_INICIO_STEPS, CONVOCATORIA_STEPS, CATALOGO_STEPS } from './tour-steps.mjs';

const reg = readBusRegistry();
if (!reg) { console.error('Bus no encontrado en el registro.'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(action, params = {}) {
  const res = await fetch(`http://127.0.0.1:${reg.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-swarm-token': reg.token },
    body: JSON.stringify({ action, params })
  });
  return res.json();
}

async function tabCmd(tabId, command, agentId = null) {
  return rpc('tab.command', { tabId, command, ...(agentId ? { agentId } : {}) });
}

async function moveWithBox(tabId, { agent, x, y, w, h, status }) {
  return tabCmd(tabId, {
    action: 'move_cursor',
    cursor: { id: agent, x, y, status, box: { left: x - w / 2, top: y - h / 2, width: w, height: h } }
  });
}

async function safeClick(tabId, x, y, selector = null) {
  try {
    await rpc('lock.acquire', { agentId: 'interactive', tabId, role: 'interactive' });
    const cmd = selector ? { action: 'click', selector } : { action: 'click', x, y };
    const res = await tabCmd(tabId, cmd, 'interactive');
    await rpc('lock.release', { agentId: 'interactive', tabId });
    return res;
  } catch (err) {
    await rpc('lock.release', { agentId: 'interactive', tabId }).catch(() => {});
    return null;
  }
}

async function executeSteps(tabId, steps, accumulatedTickets) {
  for (const step of steps) {
    if (step.scrollTo) {
      await safeClick(tabId, 0, 0, step.scrollTo);
      await sleep(1000);
    }
    await moveWithBox(tabId, step);
    if (step.realClick) {
      await safeClick(tabId, step.x, step.y);
      await sleep(800);
    }
    if (step.finding) {
      accumulatedTickets.push({
        id: step.finding.id, ruleId: step.finding.ruleId, severity: step.finding.severity,
        title: step.finding.title, status: 'open', rect: { left: step.x - step.w / 2, top: step.y - step.h / 2, width: step.w, height: step.h }
      });
      await tabCmd(tabId, { action: 'set_tickets', tickets: accumulatedTickets });
    }
    if (step.hud) {
      await tabCmd(tabId, { action: 'update_summary', summary: step.hud });
    }
    await sleep(1400);
  }
}

async function main() {
  const status = await rpc('session.status');
  const tab = status.result?.tabs?.[0];
  if (!tab) { console.error('No hay pestañas activas conectadas al bus.'); process.exit(1); }
  const tabId = tab.tabId;
  const allTickets = [];

  console.log(`[Tour Swarm] Conectado a pestaña ${tabId} (${tab.url})`);
  await tabCmd(tabId, { action: 'spawn_cursors', cursors: AGENTS });
  await tabCmd(tabId, { action: 'update_summary', summary: { agents: 4, open: 0, awaiting: 0, verified: 0 } });
  await sleep(1000);

  // FASE 1: INICIO
  console.log('--- FASE 1: AUDITORÍA EN PÁGINA DE INICIO ---');
  await executeSteps(tabId, INICIO_STEPS, allTickets);

  console.log('--- FASE 1B: SCROLL EN INICIO ---');
  await executeSteps(tabId, SCROLL_INICIO_STEPS, allTickets);
  await sleep(1000);

  // FASE 2: CONVOCATORIA A CATÁLOGO
  console.log('--- FASE 2: CONVOCATORIA Y NAVEGACIÓN A CATÁLOGO ---');
  await safeClick(tabId, 0, 0, 'header');
  await sleep(800);
  for (const step of CONVOCATORIA_STEPS) {
    await moveWithBox(tabId, step);
    await sleep(400);
  }
  await sleep(1000);

  // Clic en navegación a catálogo
  const navRes = await safeClick(tabId, 535, 65, 'header nav a[href*="catalogo"], header nav a:nth-child(2)');
  if (!navRes || !navRes.ok) {
    await rpc('lock.acquire', { agentId: 'interactive', tabId, role: 'interactive' });
    await tabCmd(tabId, { action: 'navigate', url: 'https://yanbal-prestige-9g5o.vercel.app/catalogo' }, 'interactive');
    await rpc('lock.release', { agentId: 'interactive', tabId });
  }
  await sleep(2500);

  // FASE 3: CATÁLOGO
  console.log('--- FASE 3: AUDITORÍA EN CATÁLOGO ---');
  await tabCmd(tabId, { action: 'spawn_cursors', cursors: AGENTS });
  await executeSteps(tabId, CATALOGO_STEPS, allTickets);
  await sleep(1500);

  // Finalización y guardado de reporte
  console.log('--- AUDITORÍA FINALIZADA ---');
  mkdirSync('.qa', { recursive: true });
  writeFileSync('.qa/latest.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    tabId, url: tab.url,
    ticketsFound: allTickets.length,
    tickets: allTickets
  }, null, 2));

  console.log(`Reporte guardado en .qa/latest.json con ${allTickets.length} hallazgos.`);
}

main().catch(console.error);
