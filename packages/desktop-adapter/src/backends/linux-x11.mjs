import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const BUTTONS = { left: 1, middle: 2, right: 3 };
const KEY_ALIASES = {
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'space',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
  insert: 'Insert',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  win: 'super',
  meta: 'super',
  super: 'super',
  cmd: 'super'
};
const MOVE_STEPS = 14;

const xdo = async (...args) => (await exec('xdotool', args.map(String), { timeout: 15_000 })).stdout.trim();
const parseShell = (text) => Object.fromEntries([...text.matchAll(/^([A-Z]+)=(-?\d+)$/gm)].map((m) => [m[1], Number(m[2])]));

/** Translates "ctrl+shift+s" / "Enter" into an xdotool keysym chord. */
export function toXdotoolChord(keys) {
  const parts = String(keys ?? '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('key requires a key name, e.g. "Enter" or "ctrl+s"');
  return parts.map((part) => KEY_ALIASES[part.toLowerCase()] ?? (/^f\d{1,2}$/i.test(part) ? part.toUpperCase() : part)).join('+');
}

/**
 * Desktop backend for Linux/X11 built on `xdotool` (input, windows) and ImageMagick `import`
 * (screen capture). Wayland sessions are not supported by these tools.
 */
export function createLinuxX11Backend() {
  async function pointer() {
    const loc = parseShell(await xdo('getmouselocation', '--shell'));
    return { x: loc.X, y: loc.Y };
  }

  /** Glides the pointer along an eased path so a person watching can follow it. */
  async function move(x, y) {
    const from = await pointer();
    const args = [];
    for (let i = 1; i <= MOVE_STEPS; i += 1) {
      const eased = 1 - Math.pow(1 - i / MOVE_STEPS, 3);
      args.push('mousemove', Math.round(from.x + (x - from.x) * eased), Math.round(from.y + (y - from.y) * eased), 'sleep', '0.008');
    }
    await xdo(...args);
    return { x, y };
  }

  return {
    name: 'linux-x11',
    pointer,
    move,
    async missingTools() {
      const missing = [];
      for (const tool of ['xdotool', 'import']) await exec('which', [tool]).catch(() => missing.push(tool));
      return missing.length ? { missing, hint: 'sudo apt-get install -y xdotool imagemagick' } : null;
    },
    async screenSize() {
      const [width, height] = (await xdo('getdisplaygeometry')).split(/\s+/).map(Number);
      return { width, height };
    },
    async click({ x, y, button = 'left', count = 1 }) {
      if (Number.isFinite(x) && Number.isFinite(y)) await move(x, y);
      await xdo('click', '--repeat', Math.max(1, Number(count) || 1), '--delay', 80, BUTTONS[button] ?? 1);
      return pointer();
    },
    async drag({ fromX, fromY, toX, toY }) {
      await move(fromX, fromY);
      await xdo('mousedown', 1, 'sleep', '0.08');
      await move(toX, toY);
      await xdo('sleep', '0.08', 'mouseup', 1);
      return pointer();
    },
    async scroll({ x, y, deltaY = 0, deltaX = 0 }) {
      if (Number.isFinite(x) && Number.isFinite(y)) await move(x, y);
      const notches = (delta) => Math.max(1, Math.round(Math.abs(delta) / 100));
      if (deltaY) await xdo('click', '--repeat', notches(deltaY), '--delay', 30, deltaY > 0 ? 5 : 4);
      if (deltaX) await xdo('click', '--repeat', notches(deltaX), '--delay', 30, deltaX > 0 ? 7 : 6);
    },
    async type(text) {
      await xdo('type', '--delay', 14, '--', String(text));
    },
    async key(keys) {
      await xdo('key', '--', toXdotoolChord(keys));
    },
    async listWindows() {
      const ids = (await xdo('search', '--onlyvisible', '--name', '').catch(() => '')).split('\n').filter(Boolean).slice(0, 80);
      const windows = [];
      for (const id of ids) {
        const title = await xdo('getwindowname', id).catch(() => '');
        const geo = parseShell(await xdo('getwindowgeometry', '--shell', id).catch(() => ''));
        if (!title || !(geo.WIDTH > 60) || !(geo.HEIGHT > 40)) continue;
        const pid = Number(await xdo('getwindowpid', id).catch(() => 0)) || 0;
        windows.push({ id, title, pid, rect: { x: geo.X, y: geo.Y, width: geo.WIDTH, height: geo.HEIGHT } });
      }
      return windows;
    },
    async focusWindow(id) {
      // `windowactivate` needs a window manager; fall back to raw focus + raise without one.
      await xdo('windowactivate', '--sync', id).catch(() => xdo('windowraise', id, 'windowfocus', id));
      return true;
    },
    async screenshot({ region, maxWidth, quality = 60 } = {}) {
      const args = ['-window', 'root', '-silent'];
      if (region)
        args.push(
          '-crop',
          `${Math.round(region.width)}x${Math.round(region.height)}+${Math.round(region.x)}+${Math.round(region.y)}`,
          '+repage'
        );
      if (maxWidth) args.push('-resize', `${Math.round(maxWidth)}x>`);
      args.push('-quality', String(quality), 'jpg:-');
      const { stdout } = await exec('import', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
      return { data: stdout.toString('base64'), mimeType: 'image/jpeg' };
    }
  };
}
