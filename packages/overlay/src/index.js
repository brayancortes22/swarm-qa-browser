/** Bundle entry: exposes the overlay factory on the (isolated-world) global for adapters. */
import { buildSelector, runDomAudit, sanitizeText } from './dom-auditor.js';
import { MAIN_WORLD_PROBE_SOURCE } from './network-console.js';
import { mountSwarmOverlay, OVERLAY_ACTIONS } from './overlay.js';

globalThis.__swarmQaOverlayFactory = {
  mountSwarmOverlay,
  runDomAudit,
  MAIN_WORLD_PROBE_SOURCE,
  sanitizeText,
  buildSelector,
  OVERLAY_ACTIONS
};
