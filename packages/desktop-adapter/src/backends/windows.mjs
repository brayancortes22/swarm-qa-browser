import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { controlWindow } from '../window-control.mjs';
import { scanDesktopWindows } from '../window-scanner.mjs';

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../win-input.ps1', import.meta.url));

/** Runs one action of win-input.ps1 and parses its JSON reply. */
async function ps(action, payload) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Action', action];
  if (payload) args.push('-Payload', Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'));
  const { stdout } = await exec('powershell.exe', args, { timeout: 30_000, windowsHide: true, maxBuffer: 96 * 1024 * 1024 });
  return JSON.parse(stdout.trim().split('\n').pop());
}

/** Desktop backend for Windows built on user32 (input), System.Drawing (capture) and SendKeys (text). */
export function createWindowsBackend() {
  return {
    name: 'windows',
    missingTools: async () => null,
    async screenSize() {
      const status = await ps('status');
      return { width: status.width, height: status.height };
    },
    pointer: async () => (await ps('status')).pointer,
    move: (x, y) => ps('move', { x, y }),
    click: ({ x, y, button, count }) => ps('click', { x, y, button, count }),
    drag: (points) => ps('drag', points),
    scroll: (options) => ps('scroll', options),
    type: (text) => ps('type', { text: String(text) }),
    key: (keys) => ps('key', { keys: String(keys) }),
    listWindows: async () => scanDesktopWindows().map((w) => ({ id: w.hwnd, title: w.title, pid: w.pid, rect: w.rect })),
    focusWindow: async (id) => controlWindow(id, 'foreground'),
    screenshot: (options = {}) => ps('screenshot', options)
  };
}
