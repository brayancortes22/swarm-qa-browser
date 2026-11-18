import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAuditableWindows } from '../packages/desktop-adapter/src/window-scanner.mjs';
import { createDesktopTarget, auditDesktopWindows } from '../packages/desktop-adapter/src/desktop-session.mjs';

test('createDesktopTarget formats window into canonical swarm target', () => {
  const win = {
    hwnd: '12345',
    pid: 999,
    title: 'Discord - General',
    rect: { x: 0, y: 0, width: 1280, height: 720 }
  };
  const target = createDesktopTarget(win);
  assert.equal(target.targetId, 'win-12345');
  assert.equal(target.type, 'desktop_window');
  assert.equal(target.hwnd, '12345');
  assert.equal(target.pid, 999);
  assert.ok(target.url.startsWith('desktop://'));
});

test('filterAuditableWindows removes tiny windows and system overlays', () => {
  const sample = [
    { hwnd: '1', title: 'Experiencia de entrada de Windows', rect: { x: 0, y: 0, width: 800, height: 600 } },
    { hwnd: '2', title: 'VS Code', rect: { x: 10, y: 10, width: 1400, height: 900 } },
    { hwnd: '3', title: 'Tiny', rect: { x: 50, y: 50, width: 50, height: 40 } },
    { hwnd: '4', title: '', rect: { x: 0, y: 0, width: 500, height: 500 } }
  ];

  const filtered = filterAuditableWindows(sample);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].title, 'VS Code');
});

test('filterAuditableWindows respects allowlist', () => {
  const sample = [
    { hwnd: '1', title: 'VS Code - main.js', rect: { x: 0, y: 0, width: 800, height: 600 } },
    { hwnd: '2', title: 'Discord', rect: { x: 0, y: 0, width: 800, height: 600 } }
  ];

  const filtered = filterAuditableWindows(sample, { allowlist: ['discord'] });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].title, 'Discord');
});

test('auditDesktopWindows detects desktop window overflow on mock or live windows', () => {
  const report = auditDesktopWindows({ monitorWidth: 1920, monitorHeight: 1080 });
  assert.ok(report);
  assert.ok(Array.isArray(report.windows));
  assert.ok(Array.isArray(report.findings));
  assert.equal(typeof report.totalFindings, 'number');
});
