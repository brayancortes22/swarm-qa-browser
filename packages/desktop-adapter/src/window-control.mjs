import { execFileSync } from 'node:child_process';

const PS_CONTROL_SNIPPET = (hwnd, action) => `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinCtl {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    public static bool Exec(long hwnd, string a) {
        IntPtr h = new IntPtr(hwnd);
        if (a == "foreground") { ShowWindow(h, 9); return SetForegroundWindow(h); }
        if (a == "minimize") return ShowWindow(h, 6);
        if (a == "maximize") return ShowWindow(h, 3);
        if (a == "restore") return ShowWindow(h, 9);
        return false;
    }
}
"@ -ErrorAction SilentlyContinue
[WinCtl]::Exec(${hwnd}, "${action}")
`;

export function controlWindow(hwnd, action = 'foreground') {
  if (process.platform !== 'win32' || !hwnd) return false;
  const numHwnd = Number(hwnd);
  if (!Number.isFinite(numHwnd) || numHwnd <= 0) return false;

  const validActions = new Set(['foreground', 'minimize', 'maximize', 'restore']);
  if (!validActions.has(action)) return false;

  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      PS_CONTROL_SNIPPET(numHwnd, action)
    ], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true
    }).trim();
    return out.toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export function bringToFront(hwnd) {
  return controlWindow(hwnd, 'foreground');
}

export function minimizeWindow(hwnd) {
  return controlWindow(hwnd, 'minimize');
}
