# Checklist de Pruebas & Verificación (Hard Gate)

- [x] Suite unitaria e integración `node --test` cubriendo:
  - `ticket-store.test.mjs` (ciclo de 3 rondas exactas, `tabId`/`pathname`/`viewport`, `escalated`).
  - `lock-manager.test.mjs` (exclusión mutua, TTL, liberación y reemplazo seguro).
  - `swarm-bus-security.test.mjs` (rechazo `403` sin token / origen externo, pairing, WS real).
  - `dom-auditor.test.mjs` (overflow horizontal, colisión de cajas, A11y, imágenes rotas, tap targets `<44px`, redacción `password`).
  - `mcp-server.test.mjs` (protocolo stdio JSON-RPC end-to-end, `swarm_mark_fixed`, `swarm_report_finding`, `swarm_await_event`).
- [x] Build de overlay (`node scripts/build-overlay.mjs`) verificado sin errores de sintaxis.
- [x] Verificación visual en vivo de `popup.html` y overlay sobre `sonora-music-player` (`1440×900` y `390×844`) usando flujo permitido (`qa-annotator` / `antigravity-native-browser`).
