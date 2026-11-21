import { randomUUID } from 'node:crypto';
import { exportPatchManifest, generatePatch } from '../../core/src/patch-generator.mjs';
import { DEFAULT_ROLES, resolveRole } from '../../core/src/roles.mjs';
import { buildDesktopTools } from './desktop-tools.mjs';
import { buildTestTools, createTestRecorder } from './test-tools.mjs';

const TICKET_FIELDS = ['ruleId', 'severity', 'category', 'selector', 'rect', 'description', 'expected', 'actual'];
const LOCK_TTL_MS = 15_000;
const DEFAULT_HMR_WAIT_MS = 800;
const MAX_HEAL_TICKETS = 25;
/** Which reviewing role owns each audit category. */
const REVIEWER_BY_CATEGORY = {
  overflow: 'layout',
  overlap: 'layout',
  a11y: 'forms-a11y',
  media: 'responsive',
  'tap-target': 'responsive',
  'console-net': 'console-net'
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = (source, keys) => Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
const findTab = (status, tabId) => status.tabs.find((tab) => tab.tabId === (tabId ?? status.selectedTabId)) || null;
const isFiniteCount = (value) => Number.isFinite(Number(value)) && value !== null && value !== '' && value !== undefined;
const isAutomated = (ticket) => Boolean(ticket.ruleId) && ticket.ruleId !== 'manual';

/** True when a fresh audit finding is the same defect a ticket tracks. */
function findingMatchesTicket(finding, ticket) {
  if (finding.ruleId !== ticket.ruleId) return false;
  if (ticket.selector && finding.selector !== ticket.selector) return false;
  return ticket.selector !== 'document' || !ticket.description || finding.description === ticket.description;
}

/** Remembers which cursor ids exist per tab so the HUD can show an accurate agent count. */
function createCursorRegistry() {
  const byTab = new Map();
  return {
    track(tabId, cursorId) {
      if (tabId == null || !cursorId) return;
      if (!byTab.has(tabId)) byTab.set(tabId, new Set());
      byTab.get(tabId).add(cursorId);
    },
    reset: (tabId) => byTab.delete(tabId),
    count: (tabId) => byTab.get(tabId)?.size || 0
  };
}

/**
 * Builds the MCP tool handlers. `call(action, params)` performs a bus RPC; handlers return plain
 * JSON that the transport serializes into the MCP `tools/call` result.
 */
export function buildToolHandlers(call, { desktopDriver, openBrowser, closeBrowsers, recorder = createTestRecorder() } = {}) {
  const cursors = createCursorRegistry();

  /** Re-sends each tab's tickets and counters to its overlay so pins match the store. */
  async function refreshPins(tabIds, viewportByTab) {
    const ids = [...new Set(tabIds)].filter((id) => id != null);
    if (!ids.length) return;
    const status = await call('session.status', {});
    const tabsById = new Map(status.tabs.map((tab) => [tab.tabId, tab]));
    const counts = status.ticketsSummary || {};
    for (const tabId of ids) {
      const tab = tabsById.get(tabId);
      if (!tab) continue;
      const viewportWidth = viewportByTab?.get(tabId)?.width ?? tab.viewport?.width;
      await call('tab.command', {
        tabId,
        command: {
          action: 'set_tickets',
          tickets: await call('tickets.list', { tabId }),
          pathname: tab.pathname,
          ...(viewportWidth ? { viewportWidth } : {}),
          summary: {
            activeAgents: cursors.count(tabId),
            open: (counts.open || 0) + (counts.reopened || 0),
            awaiting_reverify: counts.awaiting_reverify || 0,
            verified: counts.verified || 0
          }
        }
      });
    }
  }

  function moveCursor(tabId, args, defaultRole, statusText) {
    const role = resolveRole(args?.role ?? (args?.agentId || defaultRole));
    const id = args?.id ?? args?.agentId ?? role.id;
    cursors.track(tabId, id);
    return call('tab.command', {
      tabId,
      command: {
        action: 'move_cursor',
        id,
        label: args?.label ?? role.label,
        color: args?.color ?? role.color,
        ...pick(args, ['status', 'x', 'y', 'selector', 'box']),
        ...(statusText !== undefined ? { status: statusText } : {})
      }
    });
  }

  /**
   * Runs a mutating tab command under the tab lock. Reuses a lock the caller already holds;
   * otherwise acquires one for the duration of the command and always releases it.
   */
  async function withMutationLock(args, scope, defaultRole, statusText, command) {
    const status = await call('session.status', { tabId: args.tabId });
    const tabId = args.tabId ?? status.selectedTabId;
    if (tabId == null) throw new Error('No connected browser tab selected');
    const owner = (typeof args.agentId === 'string' && args.agentId.trim()) || `mcp-${randomUUID().slice(0, 8)}`;
    const lock = Array.isArray(status.locks) ? status.locks.find((entry) => entry.tabId === tabId) : status.locks;
    if (lock?.locked && lock.agentId !== owner) {
      throw Object.assign(new Error(`Tab ${tabId} is locked by "${lock.agentId}"`), { code: 'LOCK_HELD' });
    }
    const autoAcquired = !lock?.locked;
    if (autoAcquired) await call('lock.acquire', { agentId: owner, tabId, scope, ttlMs: LOCK_TTL_MS });
    try {
      await moveCursor(tabId, args, defaultRole, statusText);
      return await call('tab.command', { tabId, agentId: owner, requireLock: true, command });
    } finally {
      if (autoAcquired) await call('lock.release', { agentId: owner, tabId }).catch(() => {});
    }
  }

  /**
   * Builds a locked page action. Targets may be given as a CSS selector or as visible `text`;
   * every run is logged in the test recorder (form values by length only).
   */
  const mutation = (scope, role, action, keys, describe, extra) => async (rawArgs) => {
    const detail = {
      ...pick(rawArgs, ['selector', 'text', 'url', 'key', 'x', 'y', 'width', 'height', 'to']),
      ...(rawArgs.value !== undefined ? { valueLength: String(rawArgs.value).length } : {})
    };
    try {
      // For fill, `text` names the field (label, placeholder…) rather than a piece of visible text.
      const args = await testTools.resolveTarget(rawArgs, action === 'fill' ? 'control' : undefined);
      const result = await withMutationLock(args, scope, role, describe(args), {
        action,
        ...pick(args, keys),
        ...(extra ? extra(args) : {})
      });
      recorder.record({ kind: 'action', surface: 'web', tool: `swarm_${action}`, detail, ok: true });
      return result;
    } catch (err) {
      recorder.record({
        kind: 'action',
        surface: 'web',
        tool: `swarm_${action}`,
        detail,
        ok: false,
        error: String(err?.message ?? err).slice(0, 200)
      });
      throw err;
    }
  };

  const overlayCommand = (action, keys) => (args) => call('tab.command', { tabId: args.tabId, command: { action, ...pick(args, keys) } });

  const testTools = buildTestTools({ call, recorder, refreshPins, findTab });

  async function runDomAudit(args) {
    const status = await call('session.status', {});
    const tab = findTab(status, args.tabId);
    if (!tab) throw new Error(`Tab ${args.tabId ?? '(none)'} is not connected`);
    await moveCursor(tab.tabId, args, 'layout', 'Auditando');
    const audit = await call('tab.command', {
      tabId: tab.tabId,
      command: { action: 'run_audit', ...pick(args, ['checks', 'viewport', 'follow']), animate: args.animate !== false }
    });
    const findings = Array.isArray(audit?.findings) ? audit.findings : [];
    const pathname = audit?.pathname ?? tab.pathname ?? '/';
    const viewport = audit?.viewport ?? args.viewport ?? tab.viewport ?? null;
    let createdTickets = [];
    if (args.createTickets !== false) {
      const ingest = await call('tickets.ingest', {
        tabId: tab.tabId,
        url: tab.url || '',
        pathname,
        viewport,
        findings,
        reportedBy: args.agentId
      });
      createdTickets = ingest.created;
    }
    await refreshPins([tab.tabId]);
    if (args.notes !== false) await postAuditNotes(tab.tabId, findings);
    return { tabId: tab.tabId, pathname, viewport, createdTickets, findingsCount: findings.length, untrustedPageData: true };
  }

  /** Restores the viewport a group of tickets was reported at, then re-audits the tab. */
  async function reauditGroup(group, activeViewports, verifierAgentId) {
    const { tabId, viewport } = group[0];
    const current = activeViewports.get(tabId);
    const height = viewport?.height || current?.height || 900;
    if (viewport?.width > 0 && (current?.width !== viewport.width || current?.height !== height)) {
      await withMutationLock(
        { tabId, agentId: verifierAgentId || 'responsive', role: 'responsive' },
        'viewport',
        'responsive',
        'Re-verificando',
        {
          action: 'set_viewport',
          width: viewport.width,
          height,
          mobile: viewport.width <= 480
        }
      );
      activeViewports.set(tabId, { width: viewport.width, height });
    }
    return call('tab.command', { tabId, command: { action: 'run_audit', animate: false, ...(viewport ? { viewport } : {}) } });
  }

  async function markFixed(args) {
    const autoVerify = args.autoVerify !== false;
    const tickets = await call('tickets.markFixed', {
      ticketIds: args.ticketIds ?? args.ids ?? args.id,
      devAgentId: args.devAgentId ?? args.agentId,
      summary: args.summary
    });
    if (autoVerify) {
      // Drop console/network noise captured before the fix so only post-fix errors count.
      const tabsToClear = new Set(tickets.filter((t) => isAutomated(t) && t.tabId != null).map((t) => t.tabId));
      for (const tabId of tabsToClear)
        await call('tab.command', { tabId, command: { action: 'get_console_network', clear: true } }).catch(() => {});
    }
    const waitMs = args.waitForHmrMs === undefined ? DEFAULT_HMR_WAIT_MS : Math.max(0, Number(args.waitForHmrMs) || 0);
    if (waitMs > 0) await sleep(waitMs);

    const status = await call('session.status', {});
    const tabsById = new Map(status.tabs.map((tab) => [tab.tabId, tab]));
    const activeViewports = new Map(status.tabs.map((tab) => [tab.tabId, tab.viewport]));
    const tabIds = [...new Set(tickets.map((t) => t.tabId).filter((id) => tabsById.has(id)))];
    for (const tabId of tabIds)
      await moveCursor(tabId, { agentId: args.verifierAgentId || 'layout', role: 'layout' }, 'layout', 'Re-verificando');

    const verifications = [];
    if (autoVerify) {
      const groups = new Map();
      for (const ticket of tickets) {
        if (!isAutomated(ticket) || !tabsById.has(ticket.tabId)) continue;
        const key = `${ticket.tabId}::${ticket.viewport?.width || 0}x${ticket.viewport?.height || 0}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ticket);
      }
      for (const group of groups.values()) {
        const audit = await reauditGroup(group, activeViewports, args.verifierAgentId);
        const findings = Array.isArray(audit?.findings) ? audit.findings : [];
        for (const ticket of group) {
          if (audit?.pathname && ticket.pathname && audit.pathname !== ticket.pathname) continue;
          const hit = findings.find((finding) => findingMatchesTicket(finding, ticket));
          const passed = !hit;
          const evidence = hit
            ? hit.actual || hit.description || 'Finding persisted on re-audit'
            : `Re-audit passed (0 matching ${ticket.ruleId} on ${ticket.selector || ticket.pathname})`;
          const verified = await call('tickets.verify', { id: ticket.id, agentId: args.verifierAgentId || 'layout', passed, evidence });
          tickets[tickets.indexOf(ticket)] = verified;
          verifications.push({ ticketId: ticket.id, passed, status: verified.status, round: verified.round, evidence });
        }
      }
    }
    await refreshPins(tabIds, activeViewports);
    return { tickets, verifications, untrustedPageData: true };
  }

  /** Writes an entry in the tab's mission log; never fails the calling tool. */
  const postNote = (tabId, entry) => call('tab.command', { tabId, command: { action: 'post_message', ...entry } }).catch(() => {});

  /** Each reviewing role reports its own findings in the mission log, like a teammate's note. */
  async function postAuditNotes(tabId, findings) {
    const byRole = new Map();
    for (const finding of findings) {
      const role = REVIEWER_BY_CATEGORY[finding.category] ?? 'layout';
      if (!byRole.has(role)) byRole.set(role, new Map());
      const rules = byRole.get(role);
      rules.set(finding.ruleId, (rules.get(finding.ruleId) || 0) + 1);
    }
    for (const [role, rules] of byRole) {
      const total = [...rules.values()].reduce((sum, n) => sum + n, 0);
      const detail = [...rules].map(([ruleId, n]) => `${ruleId} ×${n}`).join(', ');
      await postNote(tabId, {
        from: DEFAULT_ROLES[role].label,
        agentId: role,
        color: DEFAULT_ROLES[role].color,
        kind: 'report',
        text: `${total} ${total === 1 ? 'hallazgo' : 'hallazgos'}: ${detail}`
      });
    }
    if (!findings.length)
      await postNote(tabId, {
        from: DEFAULT_ROLES.layout.label,
        agentId: 'layout',
        color: DEFAULT_ROLES.layout.color,
        kind: 'report',
        text: 'Sin hallazgos en esta vista.'
      });
  }

  /**
   * Applies one reversible patch for a ticket under lock and re-audits. The patch is kept and the
   * ticket verified only when the finding is gone; otherwise the patch is reverted.
   */
  async function tryPatch(ticket, patch, healer) {
    const lockArgs = { tabId: ticket.tabId, agentId: healer, label: 'Healer', selector: patch.selector };
    const applied = await withMutationLock(lockArgs, 'patch', 'interactive', 'Aplicando parche', { action: 'apply_patch', patch });
    if (!applied?.ok)
      return { failed: { ticketId: ticket.id, reason: 'patch could not be applied (element not found or patch rejected)' } };
    const audit = await call('tab.command', {
      tabId: ticket.tabId,
      command: { action: 'run_audit', animate: false, ...(ticket.viewport ? { viewport: ticket.viewport } : {}) }
    });
    const persists = (Array.isArray(audit?.findings) ? audit.findings : []).some((finding) => findingMatchesTicket(finding, ticket));
    if (persists) {
      await withMutationLock(lockArgs, 'patch', 'interactive', 'Revirtiendo parche', { action: 'revert_patch', id: patch.id });
      return { failed: { ticketId: ticket.id, reason: 'finding persisted after patch; patch reverted' } };
    }
    await call('tickets.markFixed', { ticketIds: [ticket.id], devAgentId: healer, summary: `Hot patch (runtime only): ${patch.title}` });
    const verified = await call('tickets.verify', {
      id: ticket.id,
      agentId: 'layout',
      passed: true,
      evidence: { hotPatch: true, patchId: patch.id, change: patch.css || `${patch.attr.name}="${patch.attr.value}"` }
    });
    return {
      healed: {
        ticketId: ticket.id,
        status: verified.status,
        patch: { id: patch.id, selector: patch.selector, css: patch.css || null, attr: patch.attr || null, title: patch.title }
      }
    };
  }

  /**
   * Orchestrator-designed fix: apply the caller's own declarations/attribute for one ticket and
   * verify it with a re-audit, exactly like a recipe.
   */
  async function applyFix(args) {
    const ticket = (await call('tickets.list', { status: ['open', 'reopened'] })).find((t) => t.id === args.ticketId);
    if (!ticket) throw new Error(`Ticket ${args.ticketId} is not open`);
    const selector = String(args.selector || ticket.selector || '').trim();
    const declarations = args.declarations && typeof args.declarations === 'object' ? args.declarations : null;
    if (!selector || (!declarations && !args.attr)) throw new Error('swarm_apply_fix needs declarations or attr, and a selector');
    const patch = {
      id: `patch-${randomUUID().slice(0, 8)}`,
      ruleId: ticket.ruleId,
      selector,
      title: String(args.title || 'Corrección decidida por el orquestador').slice(0, 120),
      ...(declarations
        ? {
            type: 'css',
            declarations,
            css: `${selector} { ${Object.entries(declarations)
              .map(([prop, value]) => `${prop}: ${value};`)
              .join(' ')} }`
          }
        : { type: 'attr', attr: args.attr })
    };
    const healer = (typeof args.agentId === 'string' && args.agentId.trim()) || 'healer';
    const outcome = await tryPatch(ticket, patch, healer);
    await refreshPins([ticket.tabId]);
    await postNote(ticket.tabId, {
      from: 'Healer',
      agentId: healer,
      kind: outcome.healed ? 'done' : 'report',
      text: outcome.healed
        ? `${ticket.id} corregido y verificado: ${patch.title}`
        : `${ticket.id}: la corrección no eliminó el hallazgo y se revirtió.`
    });
    return {
      ...(outcome.healed ?? { ticketId: ticket.id, status: ticket.status, ...outcome.failed }),
      verified: Boolean(outcome.healed),
      untrustedPageData: true
    };
  }

  /**
   * Self-healing: for each open ticket with a known recipe, apply a reversible hot patch, re-audit
   * and keep the patch only if the finding is really gone. Failed patches are reverted and the
   * ticket is left untouched. Verified patches are returned so they can be ported to the source.
   */
  async function healFindings(args) {
    const status = await call('session.status', {});
    const tabsById = new Map(status.tabs.map((tab) => [tab.tabId, tab]));
    const healer = (typeof args.agentId === 'string' && args.agentId.trim()) || 'healer';
    const wanted = args.ticketIds ?? args.ids;
    const open = await call('tickets.list', { status: ['open', 'reopened'], ...(args.tabId != null ? { tabId: args.tabId } : {}) });
    const candidates = (Array.isArray(wanted) ? open.filter((t) => wanted.includes(t.id)) : open).slice(0, MAX_HEAL_TICKETS);
    const healed = [];
    const failed = [];
    const skipped = [];
    const keptPatches = [];

    for (const ticket of candidates) {
      const tab = tabsById.get(ticket.tabId);
      const patch = generatePatch(ticket);
      const skipReason = !tab
        ? 'tab not connected'
        : !patch
          ? `no automatic recipe for "${ticket.ruleId}"`
          : tab.pathname !== ticket.pathname
            ? 'tab is on a different route'
            : ticket.viewport?.width && tab.viewport?.width && ticket.viewport.width !== tab.viewport.width
              ? 'tab viewport differs from the ticket viewport'
              : null;
      if (skipReason) {
        skipped.push({ ticketId: ticket.id, reason: skipReason });
        continue;
      }
      const outcome = await tryPatch(ticket, patch, healer);
      if (outcome.healed) {
        keptPatches.push(patch);
        healed.push(outcome.healed);
      } else {
        failed.push(outcome.failed);
      }
    }

    const summary = `${healed.length} corregidos y verificados, ${failed.length} revertidos, ${skipped.length} sin receta.`;
    if (candidates.length) await postNote(candidates[0].tabId, { from: 'Healer', agentId: healer, kind: 'done', text: summary });
    await refreshPins(candidates.map((t) => t.tabId));
    return {
      healed,
      failed,
      skipped,
      manifest: exportPatchManifest(keptPatches),
      note: 'Hot patches live only in the open page. Port each verified change to the application source; a reload removes them.',
      untrustedPageData: true
    };
  }

  return {
    swarm_session_status: (a) => call('session.status', { tabId: a.tabId }),

    /**
     * Fully automatic start: opens a browser window on the URL, already attached to the swarm,
     * selects it and can start a tour or an audit right away. Nothing to install, pair or enable.
     */
    async swarm_open(a) {
      const status = await call('session.status', {});
      const viaExtension = a.mode !== 'launch' && status.browserConnected;
      let tabId;
      let browser;
      if (viaExtension) {
        // The user's own Chrome (their sessions and logins), through the connected extension.
        tabId = (await call('browser.command', { command: { action: 'open_tab', url: a.url } })).tabId;
        browser = 'extension';
      } else {
        if (typeof openBrowser !== 'function') throw new Error('No browser extension is connected and this client cannot launch a browser');
        const session = await openBrowser(pick(a, ['url', 'headless', 'executablePath', 'width', 'height']));
        tabId = session.tabId;
        browser = session.executable;
      }
      await call('tabs.select', { tabId });
      if (isFiniteCount(a.agents)) await call('tab.command', { tabId, command: { action: 'configure_swarm', agents: a.agents } });
      const tour = a.tour ? await call('tab.command', { tabId, command: { action: 'start_tour', ...pick(a, ['agents', 'speed']) } }) : null;
      const audit = a.audit && !a.tour ? await runDomAudit({ tabId, follow: true }) : null;
      return { ok: true, tabId, url: a.url, browser, ...(tour ? { tour } : {}), ...(audit ? { audit } : {}) };
    },
    /** Tabs open in the user's browser (needs the extension). */
    swarm_browser_tabs: () => call('browser.command', { command: { action: 'list_tabs' } }),
    /** Attaches the swarm to a tab that is already open: by id, by part of its URL, or the active one. */
    async swarm_attach_tab(a) {
      const attached = await call('browser.command', { command: { action: 'attach_tab', ...pick(a, ['tabId', 'urlIncludes']) } });
      await call('tabs.select', { tabId: attached.tabId });
      return attached;
    },
    async swarm_close_browser(a) {
      if (typeof closeBrowsers !== 'function') return { ok: true, closed: 0 };
      return { ok: true, closed: await closeBrowsers(a.tabId) };
    },
    swarm_select_tab: (a) => call('tabs.select', { tabId: a.tabId }),

    async swarm_spawn_cursors(a) {
      const status = await call('session.status', {});
      const tabId = findTab(status, a.tabId)?.tabId ?? a.tabId;
      const source = a.cursors?.length ? a.cursors : a.roles?.length ? a.roles : Object.values(DEFAULT_ROLES);
      const list = source.map((cursor, i) => {
        const role = resolveRole(cursor);
        return {
          id: cursor?.id ?? role.id,
          label: cursor?.label ?? role.label,
          color: cursor?.color ?? role.color,
          x: cursor?.x ?? 48 + i * 150,
          y: cursor?.y ?? 56,
          status: cursor?.status ?? 'ready',
          ...pick(cursor, ['selector', 'box'])
        };
      });
      if (a.clear && tabId != null) cursors.reset(tabId);
      for (const cursor of list) cursors.track(tabId, cursor.id);
      const result = await call('tab.command', { tabId, command: { action: 'spawn_cursors', clear: Boolean(a.clear), cursors: list } });
      return { tabId, spawned: list, result };
    },
    async swarm_move_cursor(a) {
      const tabId = a.tabId ?? (await call('session.status', {})).selectedTabId;
      return moveCursor(tabId, a, 'layout', undefined);
    },

    swarm_configure_swarm: overlayCommand('configure_swarm', ['agents', 'speed', 'sound', 'rulers', 'minimized']),
    swarm_start_tour: overlayCommand('start_tour', ['agents', 'speed', 'maxLayers']),
    swarm_stop_tour: overlayCommand('stop_tour', []),

    swarm_acquire_lock: (a) => call('lock.acquire', pick(a, ['agentId', 'tabId', 'scope', 'ttlMs'])),
    swarm_release_lock: (a) => call('lock.release', pick(a, ['agentId', 'tabId'])),
    swarm_set_viewport: mutation(
      'viewport',
      'responsive',
      'set_viewport',
      ['width', 'height', 'deviceScaleFactor'],
      (a) => `Viewport ${a.width}x${a.height}`,
      (a) => ({ mobile: a.mobile ?? a.width <= 480 })
    ),
    swarm_click: mutation('interaction', 'interactive', 'click', ['selector', 'x', 'y', 'button', 'clickCount'], () => 'Click'),
    swarm_hover: mutation('interaction', 'interactive', 'hover', ['selector', 'x', 'y'], () => 'Hover'),
    swarm_scroll: mutation('interaction', 'interactive', 'scroll', ['selector', 'to', 'by', 'smooth'], () => 'Scroll'),
    swarm_fill: mutation('interaction', 'interactive', 'fill', ['selector', 'value', 'clear'], () => 'Fill'),
    swarm_press_key: mutation('interaction', 'interactive', 'press_key', ['key', 'selector', 'modifiers'], (a) => `Key ${a.key}`),
    swarm_navigate: mutation('interaction', 'interactive', 'navigate', ['url'], () => 'Navigate'),

    swarm_run_dom_audit: runDomAudit,
    async swarm_report_finding(a) {
      const status = await call('session.status', {});
      const tab = findTab(status, a.tabId);
      const pathname = a.pathname ?? (a.url ? undefined : (tab?.pathname ?? '/'));
      const ticket = await call('tickets.create', {
        ...pick(a, TICKET_FIELDS),
        tabId: a.tabId ?? tab?.tabId ?? null,
        url: a.url ?? tab?.url ?? '',
        ...(pathname !== undefined ? { pathname } : {}),
        viewport: a.viewport ?? tab?.viewport ?? null,
        ruleId: a.ruleId || 'manual',
        reportedBy: a.reportedBy ?? a.agentId ?? 'qa-agent'
      });
      if (tab) await refreshPins([tab.tabId]);
      return ticket;
    },
    async swarm_list_findings(a) {
      const tickets = await call('tickets.list', pick(a, ['status', 'tabId', 'pathname', 'viewportWidth']));
      return { tickets, count: tickets.length, untrustedPageData: true };
    },
    async swarm_claim_findings(a) {
      const tickets = await call('tickets.claim', { ticketIds: a.ticketIds ?? a.ids ?? a.id, devAgentId: a.devAgentId ?? a.agentId });
      await refreshPins(tickets.map((t) => t.tabId));
      return { tickets };
    },
    swarm_mark_fixed: markFixed,
    swarm_heal_findings: healFindings,
    swarm_apply_fix: applyFix,
    swarm_post_message: (a) =>
      call('tab.command', {
        tabId: a.tabId,
        command: { action: 'post_message', ...pick(a, ['from', 'text', 'kind', 'color', 'agentId']) }
      }),
    async swarm_verify_finding(a) {
      const ticket = await call('tickets.verify', {
        id: a.id ?? a.ticketId,
        agentId: a.agentId ?? 'qa-agent',
        passed: a.passed,
        evidence: a.evidence
      });
      await refreshPins([ticket.tabId]);
      return ticket;
    },
    swarm_await_event: (a) => call('events.await', { sinceSeq: a.sinceSeq ?? 0, timeoutMs: a.timeoutMs ?? 15000 }),

    ...testTools.tools,
    ...buildDesktopTools({ recorder, ...(desktopDriver ? { driver: desktopDriver } : {}) })
  };
}
