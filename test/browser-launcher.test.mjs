import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  browserArgs,
  browserCandidates,
  findBrowserExecutable,
  openBrowserSession,
  readDevToolsPort
} from '../packages/cdp-adapter/src/browser-launcher.mjs';

test('browserCandidates lists Chrome, Edge and Brave locations per platform', () => {
  const win = browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
  assert.ok(win[0].endsWith('Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(win.some((p) => p.includes('Microsoft\\Edge')));
  assert.ok(browserCandidates('darwin', {})[0].endsWith('/Google Chrome.app/Contents/MacOS/Google Chrome'));
  const linux = browserCandidates('linux', { PATH: '/usr/bin:/snap/bin' });
  assert.ok(linux.includes('/usr/bin/google-chrome') && linux.includes('/snap/bin/chromium'));
});

test('findBrowserExecutable honours explicit paths and env overrides and explains how to fix a miss', () => {
  const exists = (p) => p === '/opt/chrome' || p === '/usr/bin/chromium';
  assert.equal(findBrowserExecutable({ executablePath: '/opt/chrome', exists, env: {} }), '/opt/chrome');
  assert.equal(findBrowserExecutable({ exists, env: { SWARM_BROWSER_PATH: '/opt/chrome' } }), '/opt/chrome');
  assert.equal(findBrowserExecutable({ exists, platform: 'linux', env: { PATH: '/usr/bin' } }), '/usr/bin/chromium');
  assert.throws(() => findBrowserExecutable({ executablePath: '/nope', exists, env: {} }), /not found at "\/nope"/);
  assert.throws(() => findBrowserExecutable({ exists: () => false, platform: 'linux', env: { PATH: '/usr/bin' } }), /SWARM_BROWSER_PATH/);
});

test('browserArgs uses a private profile and a self-chosen debug port, and never passes the URL as a flag', () => {
  const args = browserArgs({ url: 'https://example.com/a?b=--evil', userDataDir: '/tmp/p', headless: true, isRoot: false });
  assert.deepEqual(args.slice(0, 2), ['--remote-debugging-port=0', '--user-data-dir=/tmp/p']);
  assert.ok(
    ['--headless=new', '--disable-dev-shm-usage', '--disable-gpu'].every((f) => args.includes(f)),
    'headless gets the CI-hardening flags'
  );
  assert.ok(!args.includes('--no-sandbox'));
  assert.equal(args.at(-1), 'https://example.com/a?b=--evil');
  // A headed window keeps hardware acceleration and does not force the shm/gpu workarounds.
  const headed = browserArgs({ url: 'http://a.test/', userDataDir: '/p', isRoot: true });
  assert.ok(headed.includes('--no-sandbox') && !headed.includes('--disable-gpu') && !headed.includes('--headless=new'));
});

test('readDevToolsPort parses the port the browser wrote and rejects garbage', () => {
  assert.equal(
    readDevToolsPort('/profile', () => '41965\n/devtools/browser/abc\n'),
    41965
  );
  assert.throws(() => readDevToolsPort('/profile', () => 'not-a-port'), /Unexpected DevToolsActivePort/);
  assert.throws(
    () =>
      readDevToolsPort('/profile', () => {
        throw new Error('ENOENT');
      }),
    /ENOENT/
  );
});

test('openBrowserSession rejects anything that is not an http(s) URL before launching', async () => {
  await assert.rejects(() => openBrowserSession({ url: 'file:///etc/passwd' }), /http\(s\) URL/);
  await assert.rejects(() => openBrowserSession({ url: '--remote-debugging-address=0.0.0.0' }), /Invalid URL/);
});
