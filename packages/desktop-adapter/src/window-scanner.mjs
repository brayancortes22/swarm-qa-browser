import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = join(__dirname, 'win-probe.ps1');

export function scanDesktopWindows() {
  if (process.platform !== 'win32') return [];
  try {
    const raw = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      PROBE_PATH
    ], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true
    }).trim();

    if (!raw.startsWith('[') || !raw.endsWith(']')) return [];
    const list = JSON.parse(raw);
    return list.map((w) => ({
      hwnd: String(w.hwnd),
      pid: Number(w.pid) || 0,
      title: String(w.title || '').trim(),
      rect: {
        x: Number(w.rect?.x) || 0,
        y: Number(w.rect?.y) || 0,
        width: Math.max(0, Number(w.rect?.width) || 0),
        height: Math.max(0, Number(w.rect?.height) || 0)
      }
    }));
  } catch (err) {
    return [];
  }
}

export function filterAuditableWindows(windows = [], options = {}) {
  const allowlist = Array.isArray(options.allowlist) ? options.allowlist.map((s) => s.toLowerCase()) : null;
  const minWidth = options.minWidth ?? 120;
  const minHeight = options.minHeight ?? 100;

  return windows.filter((w) => {
    if (!w.title || w.rect.width < minWidth || w.rect.height < minHeight) return false;
    const lower = w.title.toLowerCase();
    if (lower === 'experiencia de entrada de windows' || lower.includes('geforce overlay')) return false;
    if (allowlist && !allowlist.some((a) => lower.includes(a))) return false;
    return true;
  });
}
