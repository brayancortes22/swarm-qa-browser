import { createDesktopDriver } from '../../desktop-adapter/src/desktop-driver.mjs';
import { imageResult } from './test-tools.mjs';

/**
 * MCP tools that give the agent the whole computer: screen capture, real mouse and keyboard,
 * window management and launching programs. Unrestricted by design.
 */
export function buildDesktopTools({ recorder, driver = createDesktopDriver() }) {
  /** Runs an input action and logs it in the test run (typed text is logged by length only). */
  const action = (tool, describe, run) => async (args) => {
    const detail = describe(args);
    try {
      const result = await run(args);
      recorder.record({ kind: 'action', surface: 'desktop', tool, detail, ok: true });
      return { ok: true, ...(result && typeof result === 'object' ? result : {}) };
    } catch (err) {
      recorder.record({ kind: 'action', surface: 'desktop', tool, detail, ok: false, error: String(err?.message ?? err).slice(0, 200) });
      throw err;
    }
  };

  return {
    swarm_desktop_status: () => driver.status(),
    async swarm_desktop_screenshot(a) {
      const [shot, status] = await Promise.all([
        driver.screenshot({ region: a.region, maxWidth: a.maxWidth, quality: a.quality }),
        driver.status()
      ]);
      const scaled = Boolean(a.maxWidth) && status.screen && a.maxWidth < (a.region?.width ?? status.screen.width);
      return imageResult(shot, {
        screen: status.screen,
        pointer: status.pointer,
        ...(a.region ? { region: a.region, note: 'Image shows only the region: add region.x / region.y to image coordinates.' } : {}),
        ...(scaled
          ? {
              scale: a.maxWidth / (a.region?.width ?? status.screen.width),
              note: 'Image was downscaled: divide image coordinates by "scale" to get screen pixels.'
            }
          : {}),
        ...(!a.region && !scaled ? { note: 'Image pixels are screen pixels: use them directly with swarm_desktop_click.' } : {})
      });
    },
    async swarm_desktop_list_windows() {
      const windows = await driver.listWindows();
      return { windows, count: windows.length };
    },
    swarm_desktop_focus_window: action(
      'swarm_desktop_focus_window',
      (a) => `focus ${a.title ?? a.windowId}`,
      (a) => driver.focusWindow(a)
    ),
    swarm_desktop_move: action(
      'swarm_desktop_move',
      (a) => `move to ${a.x},${a.y}`,
      async (a) => ({ pointer: await driver.move(a) })
    ),
    swarm_desktop_click: action(
      'swarm_desktop_click',
      (a) => `${a.button || 'left'} click ×${a.clickCount || 1} at ${a.x ?? '·'},${a.y ?? '·'}`,
      async (a) => ({ pointer: await driver.click(a) })
    ),
    swarm_desktop_drag: action(
      'swarm_desktop_drag',
      (a) => `drag ${a.fromX},${a.fromY} → ${a.toX},${a.toY}`,
      async (a) => ({ pointer: await driver.drag(a) })
    ),
    swarm_desktop_scroll: action(
      'swarm_desktop_scroll',
      (a) => `scroll dy=${a.deltaY || 0} dx=${a.deltaX || 0}`,
      (a) => driver.scroll(a)
    ),
    swarm_desktop_type: action(
      'swarm_desktop_type',
      (a) => `type ${String(a.text ?? '').length} characters`,
      (a) => driver.type(a)
    ),
    swarm_desktop_key: action(
      'swarm_desktop_key',
      (a) => `key ${a.keys}`,
      (a) => driver.key(a)
    ),
    swarm_desktop_open: action(
      'swarm_desktop_open',
      (a) => `open ${a.target}`,
      (a) => driver.open(a)
    )
  };
}
