import { analyzeUxAndArchitecture, formatUxCritiqueMarkdown } from '../../core/src/ux-analyzer.mjs';

const DEFAULT_VIEWPORTS = [
  { name: 'Escritorio', width: 1440, height: 900, mobile: false },
  { name: 'Tablet', width: 768, height: 1024, mobile: false },
  { name: 'Móvil', width: 390, height: 844, mobile: true }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Builds the `swarm_ux_critique` MCP handler: multi-viewport responsive sweep + live UX Bitácora verdict. */
export function buildCritiqueTool({ call, resolveTabId, withMutationLock, postNote, moveRoleCursor }) {
  return {
    async swarm_ux_critique(args = {}) {
      const tabId = await resolveTabId(args.tabId);
      const viewports = Array.isArray(args.viewports) && args.viewports.length ? args.viewports : DEFAULT_VIEWPORTS;
      const pauseMs = Math.max(0, Math.min(2000, Number(args.pauseMs ?? 450) || 0));

      await postNote(tabId, {
        from: 'Orquestador UX',
        agentId: 'layout',
        color: '#A78BFA',
        kind: 'instruction',
        text: `Evaluando arquitectura UX y responsive en ${viewports.length} pantallas (${viewports.map((v) => `${v.width}px`).join(', ')}).`
      });

      const snapshot = await call('tab.command', {
        tabId,
        command: { action: 'snapshot', scope: 'page', max: 200 }
      }).catch(() => ({ elements: [], scroll: { maxY: 0 }, viewport: { width: 1440, height: 900 } }));

      const auditsByViewport = [];
      try {
        for (const vp of viewports) {
          await withMutationLock(
            { tabId, agentId: 'responsive', label: 'Responsive QA' },
            'viewport',
            'responsive',
            `Probando ${vp.name} (${vp.width}×${vp.height})`,
            { action: 'set_viewport', width: vp.width, height: vp.height, mobile: Boolean(vp.mobile) }
          );
          if (pauseMs) await sleep(pauseMs);
          const audit = await call('tab.command', {
            tabId,
            command: { action: 'run_audit', animate: false, viewport: { width: vp.width, height: vp.height } }
          }).catch(() => ({ findings: [] }));
          const findings = Array.isArray(audit?.findings) ? audit.findings : [];
          auditsByViewport.push({ ...vp, findings });
          await postNote(tabId, {
            from: 'Responsive QA',
            agentId: 'responsive',
            color: '#34D399',
            kind: 'note',
            text: `${vp.name} (${vp.width}×${vp.height}): ${findings.length} ${findings.length === 1 ? 'hallazgo' : 'hallazgos'}.`
          });
        }
      } finally {
        await withMutationLock(
          { tabId, agentId: 'responsive', label: 'Responsive QA' },
          'viewport',
          'responsive',
          'Restaurando pantalla original',
          { action: 'set_viewport', reset: true }
        ).catch(() => {});
      }

      const report = analyzeUxAndArchitecture({ snapshot, auditsByViewport });
      for (const rec of report.recommendations) {
        await moveRoleCursor(tabId, rec.agentId, rec.selector, rec.title).catch(() => {});
        await postNote(tabId, {
          from: rec.role,
          agentId: rec.agentId,
          color: rec.color,
          kind: rec.kind,
          text: `[${rec.priority}] ${rec.title} — ${rec.recommendation}`
        });
        if (pauseMs) await sleep(Math.min(700, pauseMs));
      }

      await postNote(tabId, {
        from: 'Orquestador UX',
        agentId: 'layout',
        color: '#A78BFA',
        kind: 'done',
        text: `Dictamen listo: ${report.recommendations.length} recomendaciones UX/arquitectura generadas.`
      });

      return { tabId, ...report, markdown: formatUxCritiqueMarkdown(report), untrustedPageData: true };
    }
  };
}
