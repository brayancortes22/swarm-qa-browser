export const DEFAULT_PORT = 47921;
export const SESSION_KEY = 'swarmAuthorizedTabs';
export const CTRL_RE = /[\u0000-\u001F\u007F-\u009F\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const MODS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };
const KEYS = {
  Enter: ['Enter', 13, '\r'],
  Tab: ['Tab', 9],
  Escape: ['Escape', 27],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
  Space: ['Space', 32, ' '],
  ' ': ['Space', 32, ' '],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowUp: ['ArrowUp', 38],
  ArrowRight: ['ArrowRight', 39],
  ArrowDown: ['ArrowDown', 40]
};

export const clean = (v, max = 280) =>
  String(v ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CTRL_RE, '')
    .slice(0, max);

export const normUrl = (raw, base) => {
  try {
    return base ? new URL(String(raw), base).href : new URL(String(raw)).href;
  } catch {
    return String(raw ?? '');
  }
};

export function mapDebuggerEvent(method, p, baseUrl) {
  if (method === 'Runtime.exceptionThrown')
    return {
      kind: 'error',
      uncaught: true,
      message: clean(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text),
      source: clean(p?.exceptionDetails?.url),
      line: Number(p?.exceptionDetails?.lineNumber) || 0
    };
  if (method === 'Runtime.consoleAPICalled' && p?.type === 'error')
    return { kind: 'console.error', message: clean((p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')) };
  if (method === 'Network.responseReceived' && Number(p?.response?.status) >= 400)
    return { kind: 'fetch', status: p.response.status, url: clean(normUrl(p.response.url, baseUrl)) };
  if (method === 'Network.loadingFailed' && !p?.canceled)
    return { kind: 'fetch', status: 0, message: clean(p?.errorText || 'Network failure') };
  return null;
}

export function buildKeyEvent(rawKey = '', rawMods = []) {
  const k = String(rawKey || '');
  const modifiers = Array.isArray(rawMods) ? rawMods.reduce((m, x) => m | (MODS[x] || 0), 0) : Number(rawMods) || 0;
  if (KEYS[k]) {
    const [code, vk, text] = KEYS[k];
    return {
      key: k === 'Space' ? ' ' : k,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
      ...(text ? { text, unmodifiedText: text } : {})
    };
  }
  const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0;
  const code = k.length === 1 && /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k;
  return {
    key: k,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
    ...(k.length === 1 ? { text: k, unmodifiedText: k } : {})
  };
}

export async function loadBusPort() {
  const p = Number((await chrome.storage.local.get('swarmBusPort'))?.swarmBusPort);
  return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : DEFAULT_PORT;
}

export async function loadSessionTabs() {
  try {
    const saved = (await chrome.storage?.session?.get?.(SESSION_KEY))?.[SESSION_KEY];
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export async function saveSessionTabs(tabsMap) {
  try {
    if (!chrome.storage?.session?.set) return;
    const list = [...tabsMap.values()]
      .filter((e) => e.debuggerAttached)
      .map(({ tabId, url, probeEnabled }) => ({ tabId, url, probeEnabled }));
    await chrome.storage.session.set({ [SESSION_KEY]: list });
  } catch {}
}

export async function loadPairCode() {
  const raw = String((await chrome.storage.local.get('swarmPairCode'))?.swarmPairCode ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : '';
}
