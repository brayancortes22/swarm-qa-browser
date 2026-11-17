# Swarm QA Browser

Sistema modular (**Extensión Chrome MV3 + Overlay Multi-Cursor + Servidor MCP + Adaptador CDP**) para que múltiples agentes de IA auditen interfaces web en vivo con cursores identificados por rol, registren hallazgos anclados al DOM, esperen correcciones de código y re-verifiquen automáticamente tras HMR.

## Arquitectura

- `packages/core`: Máquina de estados de tickets (tope de 3 rondas), candado exclusivo por pestaña, autenticación por token/Origin y bus local `127.0.0.1` (`ws` + HTTP).
- `packages/overlay`: Capa visual clean-room en `ShadowRoot` cerrado (`#__swarm_qa_overlay`), auditores geométricos/A11y/media/tap-targets y pines filtrados por ruta SPA.
- `packages/mcp-server`: Servidor MCP `stdio` compatible con Antigravity, Cursor y Claude Code.
- `packages/extension`: Extensión Chrome MV3 con consentimiento explícito antes de adjuntar `chrome.debugger` (`390px` móvil y clics/teclado `isTrusted`).
- `packages/cdp-adapter`: Puente CDP directo para webviews o sesiones Chromium locales.

## Uso rápido

```powershell
npm install
npm run build:overlay
npm test
```

> Ver guía detallada de arquitectura en [docs/superpowers/specs/2026-11-17-swarm-qa-browser-design.md](docs/superpowers/specs/2026-11-17-swarm-qa-browser-design.md).
