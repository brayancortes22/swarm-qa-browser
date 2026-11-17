# Swarm QA Browser

Producto independiente (**Extensión Chrome MV3 + Overlay Multi-Cursor + Servidor MCP + Adaptador CDP**) para que múltiples agentes de IA (**Antigravity 2.0**, Cursor, Claude Code, Codex) auditen interfaces web en vivo con cursores identificados por rol, registren hallazgos anclados al DOM, esperen correcciones de código y re-verifiquen automáticamente tras HMR.

---

## Instalación y Pruebas

```powershell
cd swarm-qa-browser
npm install
npm run build:overlay
npm test
```

## Cómo Cargar la Extensión en Chrome (Modo Desarrollador)

1. Ejecuta `npm run build:overlay` para asegurar que `packages/extension/overlay.bundle.js` esté actualizado.
2. Abre `chrome://extensions` y activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y selecciona `swarm-qa-browser/packages/extension`.
4. Abre tu aplicación web (ej. `http://localhost:5173`), haz clic en el icono **Swarm QA Browser**, lee y acepta el consentimiento explícito de depuración y pulsa **Habilitar permisos y arrancar enjambre**.
   - Chrome mostrará la barra *"started debugging this browser"* mientras el enjambre emula `390×844` o envía clics reales (`isTrusted: true`).
   - Puedes detener la sesión y revocar permisos en cualquier momento con **Desconectar y revocar depuración**.

## Cómo Conectar Cualquier Agente por MCP (`stdio`)

Registra el servidor MCP en tu cliente (Antigravity `mcp_config.json`, Claude Code, Cursor):

```json
{
  "mcpServers": {
    "swarm-qa-browser": {
      "command": "node",
      "args": ["c:/Users/NITRO ACER/Desktop/proyectos con ia/swarm-qa-browser/packages/mcp-server/src/mcp-server.mjs"]
    }
  }
}
```

### Herramientas MCP Disponibles (18)

| Categoría | Herramientas |
| :--- | :--- |
| **Sesión y Cursores** | `swarm_session_status`, `swarm_select_tab`, `swarm_spawn_cursors`, `swarm_move_cursor` |
| **Candado e Interacción** | `swarm_acquire_lock`, `swarm_release_lock`, `swarm_set_viewport`, `swarm_click`, `swarm_fill`, `swarm_press_key`, `swarm_navigate` |
| **Auditoría y Bucle QA ↔ Dev** | `swarm_run_dom_audit`, `swarm_report_finding`, `swarm_list_findings`, `swarm_claim_findings`, `swarm_mark_fixed`, `swarm_verify_finding`, `swarm_await_event` |

## Adaptador CDP Directo (Webviews / Chromium Local)

```powershell
node packages/core/src/cli-bus.mjs
node packages/cdp-adapter/src/cdp-bridge.mjs --port 9222 --url localhost:5173
```

## Estructura y Documentación

- Especificación: [docs/superpowers/specs/2026-11-17-swarm-qa-browser-design.md](docs/superpowers/specs/2026-11-17-swarm-qa-browser-design.md)
- Arquitectura y seguridad: [docs/architecture.md](docs/architecture.md)
- Plan de tareas: [docs/superpowers/plans/2026-11-17-swarm-qa-browser-plan.md](docs/superpowers/plans/2026-11-17-swarm-qa-browser-plan.md)
- Checklists: [security.md](docs/checklists/security.md), [ux.md](docs/checklists/ux.md), [tests.md](docs/checklists/tests.md)
