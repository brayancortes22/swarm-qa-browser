import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import WebSocket from 'ws';
import { connectCdpBridge } from './cdp-bridge.mjs';

const STARTUP_TIMEOUT_MS = 20_000;
const POLL_MS = 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Well-known install locations of Chromium-based browsers, most common first. */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const apps = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'Chromium\\Application\\chrome.exe'
    ];
    return apps.flatMap((app) => roots.map((root) => join(root, app)));
  }
  if (platform === 'darwin') {
    return ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'].map(
      (name) => `/Applications/${name}.app/Contents/MacOS/${name}`
    );
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  const dirs = String(env.PATH || '')
    .split(delimiter)
    .filter(Boolean);
  return names.flatMap((name) => dirs.map((dir) => join(dir, name)));
}

/** Finds a Chromium-based browser: explicit path, then SWARM_BROWSER_PATH / CHROME_PATH, then known locations. */
export function findBrowserExecutable({ executablePath, platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const explicit = executablePath || env.SWARM_BROWSER_PATH || env.CHROME_PATH;
  if (explicit) {
    if (!exists(explicit)) throw new Error(`Browser not found at "${explicit}"`);
    return explicit;
  }
  const found = browserCandidates(platform, env).find((candidate) => exists(candidate));
  if (!found)
    throw new Error('No Chrome, Edge, Brave or Chromium installation was found. Set SWARM_BROWSER_PATH to the browser executable.');
  return found;
}

/**
 * Command-line flags for a QA browser window with remote debugging on a private profile.
 * `--remote-debugging-port=0` lets the browser pick a free port and write it to the profile's
 * `DevToolsActivePort` file: that is the port the real (possibly forked headless) browser bound,
 * so there is no port race and no reliance on the launcher process staying alive.
 */
export function browserArgs({ url, userDataDir, headless = false, width = 1440, height = 900, isRoot = process.getuid?.() === 0 }) {
  return [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${width},${height}`,
    ...(headless ? ['--headless=new'] : []),
    // Chromium refuses to start its sandbox as root (containers, CI).
    ...(isRoot ? ['--no-sandbox'] : []),
    url
  ];
}

/** Reads the debugging port the browser actually bound from the profile's DevToolsActivePort file. */
export function readDevToolsPort(userDataDir, read = readFileSync) {
  const first = String(read(join(userDataDir, 'DevToolsActivePort'), 'utf8'))
    .split('\n')[0]
    .trim();
  const port = Number(first);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Unexpected DevToolsActivePort content: ${first}`);
  return port;
}

const getJson = (url) =>
  new Promise((resolve, reject) => {
    httpGet(url, { agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    })
      .setTimeout(2000, function onTimeout() {
        this.destroy(new Error('timeout'));
      })
      .on('error', reject);
  });

/**
 * Opens a browser window on `url` that is already connected to the swarm: launches a Chromium-based
 * browser with its own profile and remote debugging on loopback, then attaches the CDP bridge.
 * Nothing has to be installed or enabled in the browser. Returns `{ tabId, executable, close }`.
 */
export async function openBrowserSession({ url, registryPath, executablePath, headless = false, width, height, userDataDir } = {}) {
  const target = new URL(String(url ?? ''));
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('swarm_open needs an http(s) URL');
  const executable = findBrowserExecutable({ executablePath });
  // A fresh, throwaway profile by default: no "restore pages?" prompts or state from earlier runs.
  // Pass `userDataDir` to keep a profile (logins, cookies) between sessions.
  const profile = userDataDir || mkdtempSync(join(tmpdir(), 'swarm-qa-browser-'));
  mkdirSync(profile, { recursive: true });
  const cleanProfile = () => {
    if (!userDataDir) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  const child = spawn(executable, browserArgs({ url: target.href, userDataDir: profile, headless, width, height }), {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  // The browser prints "DevTools listening on ws://127.0.0.1:PORT/devtools/browser/..." to stderr once
  // it is ready. That is the signal Playwright and Puppeteer use: it survives `--headless=new` forking
  // the real browser (the child inherits this stderr pipe), unlike the launcher PID or a fixed port.
  let endpointFromStderr = '';
  let stderrTail = '';
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    stderrTail = (stderrTail + text).slice(-2000);
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
    if (match && !endpointFromStderr) endpointFromStderr = match[1];
  });
  // The LAUNCHER process exiting is not the same as the browser dying: with `--headless=new` the
  // spawned process can exit 0 while the real browser keeps running.
  let launcherExit = null;
  child.once('exit', (code) => (launcherExit = code ?? 0));
  child.once('error', (err) => (launcherExit = err.message));

  const killLauncher = async () => {
    if (launcherExit !== null) return;
    child.kill();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
  };
  const cleanup = () => {
    try {
      cleanProfile();
    } catch {
      /* The OS may still hold a file for a moment; a stale temp profile is harmless. */
    }
  };

  let port = 0;
  let browserWsUrl = '';
  try {
    // Learn the debug endpoint the browser actually bound: prefer the "DevTools listening" line on
    // stderr, fall back to the profile's DevToolsActivePort file. Either way it is the real (possibly
    // forked) browser's endpoint, so a clean launcher exit is not a failure on its own.
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (!port) {
      if (Date.now() > deadline) {
        const detail =
          launcherExit === null
            ? 'it never reported a debugging port'
            : `launcher exited (${launcherExit}) and no debugging port was reported${stderrTail ? `. Last output: ${stderrTail.slice(-200)}` : ''}`;
        throw new Error(`Timed out starting "${executable}": ${detail}`);
      }
      if (endpointFromStderr) {
        browserWsUrl = endpointFromStderr;
        port = Number(new URL(endpointFromStderr).port) || 0;
      }
      if (!port) {
        try {
          port = readDevToolsPort(profile);
        } catch {
          await sleep(POLL_MS);
        }
      }
    }
    let page = null;
    while (!page) {
      if (Date.now() > deadline) throw new Error(`Timed out starting "${executable}": the page never opened on port ${port}`);
      if (!browserWsUrl) {
        const version = await getJson(`http://127.0.0.1:${port}/json/version`).catch(() => null);
        browserWsUrl = version?.webSocketDebuggerUrl || '';
      }
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      page = targets.find((t) => t.type === 'page' && String(t.url).startsWith(target.origin));
      if (!page) await sleep(POLL_MS);
    }

    const bridge = await connectCdpBridge({ cdpPort: port, targetId: page.id, registryPath });
    await bridge.whenLoaded();
    return {
      tabId: bridge.tabId,
      executable,
      port,
      async close() {
        await bridge.close().catch(() => {});
        // Close the browser itself through CDP so it shuts down whether or not it forked.
        await closeBrowserOverCdp(browserWsUrl).catch(() => {});
        await killLauncher();
        cleanup();
      }
    };
  } catch (err) {
    if (port) await closeBrowserOverCdp(browserWsUrl || `http://127.0.0.1:${port}`).catch(() => {});
    await killLauncher();
    cleanup();
    throw err;
  }
}

/** Sends `Browser.close` over the browser-level CDP WebSocket, ending even a forked headless process. */
async function closeBrowserOverCdp(wsOrHttp) {
  let wsUrl = wsOrHttp;
  if (!/^wss?:/i.test(String(wsUrl))) {
    const version = await getJson(`${wsOrHttp.replace(/\/$/, '')}/json/version`).catch(() => null);
    wsUrl = version?.webSocketDebuggerUrl;
  }
  if (!wsUrl) return;
  await new Promise((resolve) => {
    const socket = new WebSocket(wsUrl);
    const done = () => {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      resolve();
    };
    socket.once('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      setTimeout(done, 400);
    });
    socket.once('error', resolve);
    setTimeout(resolve, 2000);
  });
}
