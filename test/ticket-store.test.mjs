import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ROLES, resolveRole } from '../packages/core/src/roles.mjs';
import { TicketStore, sanitizePageText } from '../packages/core/src/ticket-store.mjs';

describe('roles', () => {
  it('exposes the 5 default roles with required metadata', () => {
    const ids = ['layout', 'responsive', 'forms-a11y', 'console-net', 'interactive'];
    assert.deepEqual(Object.keys(DEFAULT_ROLES), ids);
    for (const id of ids) {
      const role = DEFAULT_ROLES[id];
      assert.equal(role.id, id);
      assert.equal(typeof role.label, 'string');
      assert.match(role.color, /^#[0-9A-Fa-f]{6}$/);
      assert.equal(typeof role.readOnly, 'boolean');
      assert.equal(typeof role.description, 'string');
    }
    assert.equal(DEFAULT_ROLES.layout.readOnly, true);
    assert.equal(DEFAULT_ROLES['forms-a11y'].readOnly, true);
    assert.equal(DEFAULT_ROLES['console-net'].readOnly, true);
    assert.equal(DEFAULT_ROLES.responsive.readOnly, false);
    assert.equal(DEFAULT_ROLES.interactive.readOnly, false);
  });

  it('resolves role strings, agent objects, and custom fallback agents', () => {
    assert.equal(resolveRole('FORMS_A11Y').id, 'forms-a11y');
    assert.equal(resolveRole('qa-console-net-2').id, 'console-net');

    const customized = resolveRole({ id: 'qa-1', role: 'layout', color: '#112233' });
    assert.equal(customized.id, 'layout');
    assert.equal(customized.color, '#112233');
    assert.equal(customized.readOnly, true);

    const unknown = resolveRole('custom-auditor');
    assert.equal(unknown.id, 'custom-auditor');
    assert.match(unknown.color, /^#[0-9A-Fa-f]{6}$/);
  });
});

describe('sanitizePageText', () => {
  it('strips ASCII control chars except tab/newline, truncates to 280, and preserves [redacted]', () => {
    const dirty = 'A\x00B\tC\nD\r\x1B[31mE\x7F [redacted]';
    assert.equal(sanitizePageText(dirty), 'AB\tC\nD[31mE [redacted]');
    assert.equal(sanitizePageText('[redacted]'), '[redacted]');
    assert.equal(sanitizePageText(null), '');

    const longText = 'x'.repeat(350);
    const truncated = sanitizePageText(longText);
    assert.equal(truncated.length, 280);

    const straddling = `${'y'.repeat(275)}[redacted]`;
    const kept = sanitizePageText(straddling);
    assert.equal(kept.length, 280);
    assert.ok(kept.endsWith('[redacted]'));
  });
});

describe('TicketStore', () => {
  it('creates sanitized untrusted tickets and filters list by tabId, pathname, viewportWidth, and status', () => {
    const store = new TicketStore();
    const t1 = store.create({
      tabId: 1, url: 'http://localhost:5173/library', pathname: '/library',
      viewport: { width: 390, height: 844 }, selector: '.track-row', ruleId: 'tap-target',
      severity: 'high', category: 'responsive',
      description: 'Button\x00 too small\n[redacted] ' + 'z'.repeat(300),
      expected: '44x44', actual: '32x32', reportedBy: 'qa-responsive'
    });
    const t2 = store.create({
      tabId: 1, url: 'http://localhost:5173/settings',
      viewport: { width: 1440, height: 900 }, description: 'Desktop overlap'
    });

    assert.equal(t1.round, 1);
    assert.equal(t1.status, 'open');
    assert.equal(t1.untrustedPageData, true);
    assert.equal(t1.description.length, 280);
    assert.ok(t1.description.includes('\n[redacted]'));
    assert.equal(t2.pathname, '/settings');

    assert.equal(store.list({ tabId: 1, pathname: '/library', viewportWidth: 390 }).length, 1);
    assert.equal(store.list({ status: 'open' }).length, 2);

    const fetched = store.get(t1.id);
    fetched.status = 'tampered';
    assert.equal(store.get(t1.id).status, 'open');
  });

  it('enforces exact 3-round escalation and blocks further claims once escalated', () => {
    const store = new TicketStore();
    const ticket = store.create({ tabId: 7, pathname: '/', description: 'Horizontal overflow' });

    // Round 1 fail -> round 2 reopened
    store.claim([ticket.id], 'dev-1');
    assert.equal(store.get(ticket.id).status, 'claimed');
    store.markFixed([ticket.id], { devAgentId: 'dev-1', summary: 'attempt 1' });
    assert.equal(store.get(ticket.id).status, 'awaiting_reverify');
    let res = store.verify(ticket.id, { agentId: 'qa-1', passed: false, evidence: 'still 410px' });
    assert.equal(res.round, 2);
    assert.equal(res.status, 'reopened');

    // Round 2 fail -> round 3 reopened
    store.claim([ticket.id], 'dev-1');
    store.markFixed([ticket.id], { devAgentId: 'dev-1', summary: 'attempt 2' });
    res = store.verify(ticket.id, { agentId: 'qa-1', passed: false, evidence: 'still 398px' });
    assert.equal(res.round, 3);
    assert.equal(res.status, 'reopened');

    // Round 3 fail -> escalated (no round 4)
    store.claim([ticket.id], 'dev-1');
    store.markFixed([ticket.id], { devAgentId: 'dev-1', summary: 'attempt 3' });
    res = store.verify(ticket.id, { agentId: 'qa-1', passed: false, evidence: 'still 392px' });
    assert.equal(res.round, 3);
    assert.equal(res.status, 'escalated');

    assert.throws(() => store.claim([ticket.id], 'dev-1'), /escalated/i);
    assert.throws(() => store.markFixed([ticket.id], { devAgentId: 'dev-1', summary: 'x' }), /escalated/i);
  });

  it('supports single-agent implicit claim on markFixed and verifies pass, rejecting invalid states', () => {
    const store = new TicketStore();
    const ticket = store.create({ tabId: 2, pathname: '/play', description: 'Missing aria-label' });

    assert.throws(() => store.verify(ticket.id, { agentId: 'qa-1', passed: true }), /awaiting_reverify/i);

    store.markFixed([ticket.id], { devAgentId: 'solo-dev', summary: 'Added aria-label' });
    const awaiting = store.get(ticket.id);
    assert.equal(awaiting.status, 'awaiting_reverify');
    assert.equal(awaiting.fixSummary, 'Added aria-label');

    const verified = store.verify(ticket.id, {
      agentId: 'qa-a11y',
      passed: true,
      evidence: 'Accessible name present'
    });
    assert.equal(verified.status, 'verified');
    assert.equal(verified.verifiedBy, 'qa-a11y');
    assert.equal(verified.evidence, 'Accessible name present');

    assert.throws(() => store.claim([ticket.id], 'dev-2'), /verified/i);
  });
});
