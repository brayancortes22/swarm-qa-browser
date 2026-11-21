/* Standalone demo: mounts the overlay straight into the page, no extension or bus required. */
(() => {
  const factory = globalThis.__swarmQaOverlayFactory;
  if (!factory) return;
  const params = new URLSearchParams(location.search);
  // ?bare=1 leaves the page untouched so an adapter (extension / CDP bridge) can mount the overlay instead.
  if (params.has('bare')) return;
  const nonce = Math.random().toString(36).slice(2, 12);
  const log = [];
  const overlay = factory.mountSwarmOverlay({
    nonce,
    swarm: { agents: Number(params.get('agents')) || 10, speed: Number(params.get('speed')) || 1 },
    onEvent: (event) => log.push(event),
    onAction: (action) => log.push(action)
  });
  // Same-world page: install the console/network probe directly (adapters do this through CDP).
  (0, eval)(overlay.probeSource());
  // A deliberate failing request so the console/network audit has something to report.
  fetch('/api/metrics/live').catch(() => {});

  globalThis.__swarmDemo = { overlay, log };
  if (params.has('tour')) setTimeout(() => overlay.startTour(), 600);
})();
