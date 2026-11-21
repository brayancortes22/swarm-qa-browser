import { spawn } from 'node:child_process';
import { createLinuxX11Backend } from './backends/linux-x11.mjs';
import { createWindowsBackend } from './backends/windows.mjs';

const num = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return Math.round(n);
};

function pickBackend(platform) {
  if (platform === 'win32') return createWindowsBackend();
  if (platform === 'linux') return createLinuxX11Backend();
  return null;
}

/**
 * Full desktop control for AI test agents: see the screen, move and click the real mouse, type,
 * press key chords, manage windows and open programs. There are deliberately no restrictions —
 * whoever can call this driver controls the whole computer, exactly like a person at the keyboard.
 */
export function createDesktopDriver({ platform = process.platform, backend = pickBackend(platform) } = {}) {
  const unsupported = () => new Error(`Desktop control is not supported on "${platform}" (supported: Windows, Linux/X11)`);
  const need = () => {
    if (!backend) throw unsupported();
    return backend;
  };

  return {
    supported: Boolean(backend),
    async status() {
      if (!backend) return { supported: false, platform, reason: unsupported().message };
      const missing = await backend.missingTools();
      if (missing) return { supported: false, platform, backend: backend.name, ...missing };
      try {
        return { supported: true, platform, backend: backend.name, screen: await backend.screenSize(), pointer: await backend.pointer() };
      } catch (err) {
        // Typically: no graphical session (headless server, missing DISPLAY).
        return {
          supported: false,
          platform,
          backend: backend.name,
          reason: String(err?.message ?? err)
            .split('\n')
            .slice(0, 2)
            .join(' ')
            .trim()
        };
      }
    },
    screenshot: (options = {}) => need().screenshot(options),
    listWindows: () => need().listWindows(),
    async focusWindow({ windowId, title } = {}) {
      const windows = await need().listWindows();
      const wanted = String(title ?? '').toLowerCase();
      const target = windows.find((w) =>
        windowId != null ? String(w.id) === String(windowId) : wanted && w.title.toLowerCase().includes(wanted)
      );
      if (!target) throw new Error(`No window matches ${windowId != null ? `id ${windowId}` : `"${title}"`}`);
      return { focused: Boolean(await backend.focusWindow(target.id)), window: target };
    },
    move: ({ x, y }) => need().move(num(x, 'x'), num(y, 'y')),
    click: ({ x, y, button = 'left', clickCount = 1 } = {}) =>
      need().click({ x: x == null ? undefined : num(x, 'x'), y: y == null ? undefined : num(y, 'y'), button, count: clickCount }),
    drag: ({ fromX, fromY, toX, toY }) =>
      need().drag({ fromX: num(fromX, 'fromX'), fromY: num(fromY, 'fromY'), toX: num(toX, 'toX'), toY: num(toY, 'toY') }),
    scroll: ({ x, y, deltaY = 0, deltaX = 0 } = {}) =>
      need().scroll({
        x: x == null ? undefined : num(x, 'x'),
        y: y == null ? undefined : num(y, 'y'),
        deltaY: Number(deltaY) || 0,
        deltaX: Number(deltaX) || 0
      }),
    type: ({ text }) => need().type(String(text ?? '')),
    key: ({ keys }) => need().key(String(keys ?? '')),
    /** Starts a program, or opens a file/URL with its default application, detached from this process. */
    open({ target, args = [] }) {
      if (!target || typeof target !== 'string') throw new Error('open requires a target (program, file or URL)');
      const list = Array.isArray(args) ? args.map(String) : [];
      const isUrlOrFile = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
      const [command, commandArgs] = isUrlOrFile
        ? platform === 'win32'
          ? ['cmd.exe', ['/c', 'start', '', target]]
          : ['xdg-open', [target]]
        : [target, list];
      const child = spawn(command, commandArgs, { detached: true, stdio: 'ignore', windowsHide: false });
      return new Promise((resolve, reject) => {
        child.once('error', (err) => reject(new Error(`Could not open "${target}": ${err.message}`)));
        child.once('spawn', () => {
          child.unref();
          resolve({ opened: true, target, pid: child.pid });
        });
      });
    }
  };
}
