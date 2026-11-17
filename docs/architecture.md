# Arquitectura — Swarm QA Browser

## Visión General

```text
  [ Cliente MCP: Antigravity / Cursor / Claude Code ]
                       │  stdio (JSON-RPC 2.0)
                       ▼
           packages/mcp-server (18 tools)
                       │  HTTP /rpc + x-swarm-token
                       ▼
         packages/core/src/swarm-bus.mjs (127.0.0.1)
          ├── TicketStore (open -> claimed -> awaiting_reverify -> verified / reopened / escalated)
          ├── LockManager (candado exclusivo por pestaña para mutaciones y viewport)
          └── SessionAuth (registro ~/.swarm-qa-browser/bus.json, Origin allowlist, token 24B)
                 ▲                           ▲
     WS + /pair  │                           │ WS local
   (Chrome MV3)  │                           │ (CDP Loopback)
                 │                           │
   packages/extension/                 packages/cdp-adapter/
   ├── background.js (chrome.debugger) └── src/cdp-bridge.mjs
   ├── content.js (ISOLATED world)         └── Page.createIsolatedWorld
   └── popup.html/js (Consentimiento)          └── overlay.bundle.js
                 │                           │
                 └───────────┬───────────────┘
                             ▼
             packages/overlay (ShadowRoot #__swarm_qa_overlay)
             ├── cursor-layer.js (N cursores con rol, color, caja W×H)
             ├── dom-auditor.js (overflow, overlap, a11y, media, tap-target, console-net)
             ├── issue-pins.js (pines P1/P2/P3 filtrados por pathname + barra HUD)
             └── network-console.js (sonda MAIN world con nonce + sanitización)
```

## Límites de Seguridad

1. **Aislamiento de Red:** El bus solo enlaza en `127.0.0.1` / `localhost` / `::1`. Rechaza con `403` cualquier `Origin` web externo y protege `POST /pair` únicamente para `chrome-extension://jgfhckehijkedmcellcjglbnibgccifg` o clientes locales sin `Origin`.
2. **Aislamiento de Ejecución:** El overlay y los auditores corren exclusivamente en mundo `ISOLATED` (`content.js`) o `Page.createIsolatedWorld` (`cdp-bridge.mjs`) dentro de un `ShadowRoot` cerrado. Ninguna página inspeccionada tiene acceso al controlador.
3. **Datos No Confiables:** Textos extraídos del DOM, consola o red eliminan caracteres de control/bidi, se acortan a 280 caracteres, redactan campos `password` y `hidden` como `[redacted]` y viajan marcados con `untrustedPageData: true`.
4. **Consentimiento Explícito en Chrome MV3:** `popup.html` exige confirmación explícita del usuario (advirtiendo sobre la barra *"started debugging this browser"*, emulación `390px` y clics reales) y pide `chrome.permissions.request()` antes de actuar fuera de `localhost`/`127.0.0.1`.
5. **Anti-Bucles:** Cada ticket inicia en `round = 1` y permite hasta 3 intentos de corrección; si falla en ronda 3 pasa a `escalated` y bloquea nuevos `claim`.
