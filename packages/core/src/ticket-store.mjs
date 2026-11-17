const MAX_FIX_ROUNDS = 3;
const REDACTED_TAG = '[redacted]';
const ANSI_CSI_RE = /(?:\u001b\[|\u009b)[0-9;?]*[ -/]*[@-~]/g;
const STRIP_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
const TEXT_DEFAULTS = {
  url: '', selector: '', ruleId: '', severity: 'medium',
  category: 'general', description: '', expected: '', actual: '', reportedBy: 'qa-agent'
};

/**
 * Strips ANSI CSI, bidi overrides, zero-width, and control chars (except tab/newline), truncating while keeping [redacted].
 */
export function sanitizePageText(value, maxLen = 280) {
  if (value === null || value === undefined) return '';
  const cleaned = String(value).replace(ANSI_CSI_RE, '').replace(STRIP_CHARS_RE, '');
  if (!Number.isFinite(maxLen) || maxLen <= 0) return '';
  if (cleaned.length <= maxLen) return cleaned;
  const tagIdx = cleaned.lastIndexOf(REDACTED_TAG, maxLen - 1);
  if (tagIdx !== -1 && tagIdx + REDACTED_TAG.length > maxLen && maxLen >= REDACTED_TAG.length) {
    return `${cleaned.slice(0, maxLen - REDACTED_TAG.length)}${REDACTED_TAG}`;
  }
  return cleaned.slice(0, maxLen);
}

function sanitizeEvidence(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (typeof value !== 'object') return sanitizePageText(value);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') {
      out[sanitizePageText(k, 64)] = sanitizeEvidence(v);
    }
  }
  return out;
}

function derivePathname(url) {
  try { return url ? new URL(String(url)).pathname : ''; } catch { return ''; }
}

function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) return null;
  const num = (v) => {
    if (v === null || v === undefined || typeof v === 'boolean' || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? (n === 0 ? 0 : n) : 0;
  };
  return { x: num(rect.x ?? rect.left), y: num(rect.y ?? rect.top), width: num(rect.width), height: num(rect.height) };
}

/**
 * In-memory QA ticket queue with sanitization and a strict 3-round escalation cap.
 */
export class TicketStore {
  #tickets = new Map();
  #nextId = 1;

  create(input = {}) {
    const now = new Date().toISOString();
    const id = `T-${this.#nextId++}`;
    const vp = input.viewport && typeof input.viewport === 'object'
      ? { width: Number(input.viewport.width) || 0, height: Number(input.viewport.height) || 0 }
      : null;
    const ticket = {
      id, tabId: input.tabId ?? null, pathname: sanitizePageText(input.pathname ?? derivePathname(input.url)),
      viewport: vp, rect: normalizeRect(input.rect), round: 1, status: 'open', untrustedPageData: true,
      claimedBy: null, fixSummary: null, verifiedBy: null, evidence: null, createdAt: now, updatedAt: now
    };
    for (const [field, fallback] of Object.entries(TEXT_DEFAULTS)) {
      ticket[field] = sanitizePageText(input[field] ?? fallback);
    }
    this.#tickets.set(id, ticket);
    return structuredClone(ticket);
  }

  get(id) {
    const ticket = this.#tickets.get(id);
    return ticket ? structuredClone(ticket) : null;
  }

  list({ status, tabId, pathname, viewportWidth } = {}) {
    const wantedPath = pathname != null ? sanitizePageText(pathname) : null;
    const out = [];
    for (const t of this.#tickets.values()) {
      if (status != null && !(Array.isArray(status) ? status.includes(t.status) : t.status === status)) continue;
      if (tabId != null && t.tabId !== tabId) continue;
      if (wantedPath !== null && t.pathname !== wantedPath) continue;
      if (viewportWidth != null && t.viewport?.width !== Number(viewportWidth)) continue;
      out.push(structuredClone(t));
    }
    return out;
  }

  claim(ticketIds, devAgentId) {
    const agent = typeof devAgentId === 'string' ? sanitizePageText(devAgentId) : '';
    if (!agent) throw new Error('devAgentId is required to claim tickets');
    const tickets = this.#resolveAll(ticketIds);
    for (const t of tickets) {
      if (t.status === 'escalated') throw new Error(`Ticket ${t.id} is escalated after ${t.round} rounds`);
      if (t.round > MAX_FIX_ROUNDS || (t.status !== 'open' && t.status !== 'reopened')) {
        throw new Error(`Ticket ${t.id} cannot be claimed from status "${t.status}" (round ${t.round})`);
      }
    }
    const now = new Date().toISOString();
    return tickets.map((t) => structuredClone(Object.assign(t, { status: 'claimed', claimedBy: agent, updatedAt: now })));
  }

  markFixed(ticketIds, { devAgentId, summary } = {}) {
    const tickets = this.#resolveAll(ticketIds);
    const agent = typeof devAgentId === 'string' ? (sanitizePageText(devAgentId) || null) : null;
    for (const t of tickets) {
      if (t.status === 'escalated') throw new Error(`Ticket ${t.id} is escalated and cannot be marked fixed`);
      if (t.status === 'claimed') {
        if (t.claimedBy && agent !== t.claimedBy) {
          throw new Error(`Ticket ${t.id} is claimed by "${t.claimedBy}", not "${agent ?? 'unknown'}"`);
        }
      } else if (t.status !== 'open' && t.status !== 'reopened') {
        throw new Error(`Ticket ${t.id} cannot be marked fixed from status "${t.status}"`);
      }
    }
    const now = new Date().toISOString();
    const fixSummary = sanitizePageText(summary ?? '');
    return tickets.map((t) => {
      if (!t.claimedBy && agent) t.claimedBy = agent;
      return structuredClone(Object.assign(t, { status: 'awaiting_reverify', fixSummary, updatedAt: now }));
    });
  }

  verify(id, { agentId, passed, evidence } = {}) {
    const t = this.#tickets.get(id);
    if (!t) throw new Error(`Ticket ${id} not found`);
    if (t.status !== 'awaiting_reverify') {
      throw new Error(`Ticket ${id} must be in "awaiting_reverify" status to verify, got "${t.status}"`);
    }
    if (typeof passed !== 'boolean') throw new Error('verify requires boolean "passed"');
    t.verifiedBy = sanitizePageText(agentId ?? 'qa-agent');
    t.evidence = sanitizeEvidence(evidence);
    t.updatedAt = new Date().toISOString();
    if (passed) {
      t.status = 'verified';
    } else {
      t.claimedBy = null;
      if (t.round < MAX_FIX_ROUNDS) { t.round += 1; t.status = 'reopened'; } else { t.status = 'escalated'; }
    }
    return structuredClone(t);
  }

  #resolveAll(ticketIds) {
    const ids = Array.isArray(ticketIds) ? ticketIds : [ticketIds];
    if (ids.length === 0) throw new Error('At least one ticket id is required');
    return ids.map((id) => {
      const ticket = this.#tickets.get(id);
      if (!ticket) throw new Error(`Ticket ${id} not found`);
      return ticket;
    });
  }
}
