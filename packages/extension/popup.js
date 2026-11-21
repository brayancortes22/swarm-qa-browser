const $ = (id) => document.getElementById(id);
const ENABLE_TEXT = 'Arrancar enjambre en esta pestaña';
const ACTIVE_TEXT = 'Sesión activa en esta pestaña';
const els = {
  busDot: $('busDot'),
  busText: $('busText'),
  portInput: $('portInput'),
  savePortBtn: $('savePortBtn'),
  pairInput: $('pairInput'),
  savePairBtn: $('savePairBtn'),
  tabUrl: $('tabUrl'),
  tabViewport: $('tabViewport'),
  probeCheck: $('probeCheck'),
  enableBtn: $('enableBtn'),
  detachBtn: $('detachBtn'),
  exportBtn: $('exportBtn'),
  feedback: $('feedback')
};

let activeTab = null;
let sessionActive = false;

function setFeedback(text = '', kind = '') {
  els.feedback.textContent = text;
  els.feedback.className = `feedback${kind ? ` ${kind}` : ''}`;
}

function parseTarget(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const isLocal = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    return { url: u, isLocal, originPattern: `${u.protocol}//${u.hostname}/*` };
  } catch {
    return null;
  }
}

const PAIR_TEXT = { missing: 'Falta código', invalid: 'Código incorrecto', locked: 'Bloqueado 1 min' };

function renderBus(connected, port, pairState) {
  els.busDot.classList.toggle('on', Boolean(connected));
  els.busText.textContent = connected ? 'Conectado' : PAIR_TEXT[pairState] || 'Desconectado';
  if (port && document.activeElement !== els.portInput) els.portInput.value = String(port);
}

function renderTab(tabInfo, sessionTab) {
  const rawUrl = sessionTab?.url || tabInfo?.url || '';
  const target = parseTarget(rawUrl);
  els.tabUrl.textContent = target ? `${target.url.host}${target.url.pathname}` : rawUrl || 'Página interna no auditable';
  els.tabUrl.title = rawUrl;
  sessionActive = Boolean(sessionTab?.debuggerAttached);
  if (sessionTab?.viewport?.width) {
    els.tabViewport.textContent = `${sessionTab.viewport.width}×${sessionTab.viewport.height}`;
  } else {
    els.tabViewport.textContent = sessionActive ? 'Activo' : 'Sin sesión';
  }
  els.enableBtn.disabled = sessionActive || !target;
  els.enableBtn.textContent = sessionActive ? ACTIVE_TEXT : ENABLE_TEXT;
  els.detachBtn.disabled = !sessionActive;
  els.exportBtn.disabled = !sessionActive;
}

async function refreshStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  const res = await chrome.runtime.sendMessage({ type: 'get_status', tabId: activeTab?.id });
  if (res?.ok) {
    renderBus(res.busConnected, res.port, res.pairState);
    if (res.hasPairCode && document.activeElement !== els.pairInput && !els.pairInput.value) els.pairInput.placeholder = 'Guardado ✓';
    renderTab(activeTab, res.tab);
  } else {
    renderBus(false, 47921);
    renderTab(activeTab, null);
  }
}

els.savePortBtn.addEventListener('click', async () => {
  const port = Number(els.portInput.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    setFeedback('Ingresa un puerto válido entre 1 y 65535.', 'err');
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'set_port', port });
  if (!res?.ok) {
    setFeedback(res?.error || 'No se pudo actualizar el puerto.', 'err');
    return;
  }
  renderBus(res.busConnected, res.port);
  setFeedback(
    res.busConnected ? `Bus conectado en puerto ${res.port}.` : `Puerto ${res.port} guardado (Bus sin conexión).`,
    res.busConnected ? 'ok' : ''
  );
});

els.savePairBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'set_pair_code', code: els.pairInput.value });
  if (!res?.ok) {
    setFeedback(res?.error || 'No se pudo guardar el código.', 'err');
    return;
  }
  els.pairInput.value = '';
  renderBus(res.busConnected, Number(els.portInput.value), res.pairState);
  const failed =
    res.pairState === 'invalid' ? 'Código incorrecto: revisa el que muestra el bus.' : 'Código guardado. Inicia el bus para conectar.';
  setFeedback(
    res.busConnected ? 'Extensión vinculada con el bus local.' : failed,
    res.busConnected ? 'ok' : res.pairState === 'invalid' ? 'err' : ''
  );
});

els.enableBtn.addEventListener('click', async () => {
  const target = parseTarget(activeTab?.url);
  if (!activeTab?.id || !target) {
    setFeedback('Abre una pestaña http:// o https:// válida para iniciar QA.', 'err');
    return;
  }
  els.enableBtn.disabled = true;
  els.enableBtn.textContent = 'Activando sesión...';
  setFeedback('');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'authorize_tab',
      tabId: activeTab.id,
      url: activeTab.url,
      probeEnabled: els.probeCheck.checked
    });
    if (!res?.ok) throw new Error(res?.error || 'Error al autorizar pestaña');
    renderBus(res.busConnected, Number(els.portInput.value));
    renderTab(activeTab, res.tab);
    setFeedback(
      res.busConnected ? 'Enjambre activo y conectado al Bus local.' : `Sesión lista. Inicia el Bus en 127.0.0.1:${els.portInput.value}.`,
      'ok'
    );
  } catch (err) {
    setFeedback(err?.message || String(err), 'err');
    await refreshStatus().catch(() => {
      els.enableBtn.textContent = sessionActive ? ACTIVE_TEXT : ENABLE_TEXT;
    });
  }
});

els.detachBtn.addEventListener('click', async () => {
  if (!activeTab?.id) return;
  const res = await chrome.runtime.sendMessage({ type: 'detach_tab', tabId: activeTab.id });
  await refreshStatus();
  setFeedback(res?.ok ? 'Enjambre detenido en esta pestaña.' : res?.error || 'Error al desconectar.', res?.ok ? 'ok' : 'err');
});

els.exportBtn.addEventListener('click', async () => {
  if (!activeTab?.id) return;
  const res = await chrome.runtime.sendMessage({ type: 'export_findings', tabId: activeTab.id });
  if (!res?.ok || !res.report) {
    setFeedback(res?.error || 'No se pudo exportar el reporte.', 'err');
    return;
  }
  const blob = new Blob([JSON.stringify(res.report, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = `swarm-qa-findings-${activeTab.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  setFeedback(`Exportados ${res.report.findings?.length ?? 0} hallazgos en JSON.`, 'ok');
});

refreshStatus().catch((err) => setFeedback(err?.message || 'Error al cargar estado.', 'err'));
