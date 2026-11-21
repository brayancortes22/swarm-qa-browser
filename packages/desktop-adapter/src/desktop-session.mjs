import { scanDesktopWindows, filterAuditableWindows } from './window-scanner.mjs';
import { bringToFront } from './window-control.mjs';

export function createDesktopTarget(win) {
  return {
    targetId: `win-${win.hwnd}`,
    type: 'desktop_window',
    hwnd: win.hwnd,
    pid: win.pid,
    title: win.title,
    rect: win.rect,
    url: `desktop://${encodeURIComponent(win.title.slice(0, 32))}`
  };
}

export function auditDesktopWindows(options = {}) {
  const allWindows = scanDesktopWindows();
  const windows = filterAuditableWindows(allWindows, options);
  const monitorWidth = options.monitorWidth ?? 1920;
  const monitorHeight = options.monitorHeight ?? 1080;
  const findings = [];

  windows.forEach((w) => {
    // 1. Regla de Desborde de Monitor
    if (w.rect.x < -10 || w.rect.y < -10 || w.rect.x + w.rect.width > monitorWidth + 20 || w.rect.y + w.rect.height > monitorHeight + 20) {
      findings.push({
        id: `DESK-OVERFLOW-${w.hwnd}`,
        ruleId: 'desktop-window-overflow',
        severity: 'P2',
        title: `Ventana ${w.title} desborda los límites del monitor (${w.rect.width}x${w.rect.height})`,
        target: createDesktopTarget(w),
        selector: `desktop[pid="${w.pid}"]`
      });
    }

    // 2. Regla de Título Accesible
    if (w.title.length < 3 || /^(sin t[íi]tulo|untitled|nuevo documento)$/i.test(w.title)) {
      findings.push({
        id: `DESK-A11Y-${w.hwnd}`,
        ruleId: 'desktop-window-unnamed',
        severity: 'P3',
        title: `Ventana con título no descriptivo: "${w.title}"`,
        target: createDesktopTarget(w),
        selector: `desktop[pid="${w.pid}"]`
      });
    }
  });

  return {
    timestamp: new Date().toISOString(),
    monitor: { width: monitorWidth, height: monitorHeight },
    totalWindowsScanned: allWindows.length,
    auditableWindows: windows.length,
    windows: windows.map(createDesktopTarget),
    totalFindings: findings.length,
    findings
  };
}

export function focusDesktopTarget(target) {
  if (!target?.hwnd) return false;
  return bringToFront(target.hwnd);
}
