import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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

/** Command-line flags for a QA browser window with remote debugging on a private profile. */
export function browserArgs({ url, port, userDataDir, headless = false, width = 1440, height = 900, isRoot = process.getuid?.() === 0 }) {
  return [
    `--remote-debugging-port=${port}`,
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

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
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
  const port = await freePort();
  const child = spawn(executable, browserArgs({ url: target.href, port, userDataDir: profile, headless, width, height }), {
    stdio: 'ignore'
  });
  let exited = null;
  child.once('exit', (code) => (exited = code ?? 0));
  child.once('error', (err) => (exited = err.message));
  const kill = async () => {
    if (exited === null) {
      child.kill();
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 3000);
      });
    }
    try {
      cleanProfile();
    } catch {
      /* The OS may still hold a file for a moment; a stale temp profile is harmless. */
    }
  };

  try {
    // Wait for the page target to exist, then attach the bridge to exactly that target.
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let page = null;
    while (!page) {
      if (exited !== null)
        throw new Error(`The browser exited before it was ready (${exited}). Is another window already using this profile?`);
      if (Date.now() > deadline) throw new Error('Timed out waiting for the browser to open the page');
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
        await kill();
      }
    };
  } catch (err) {
    await kill();
    throw err;
  }
}
