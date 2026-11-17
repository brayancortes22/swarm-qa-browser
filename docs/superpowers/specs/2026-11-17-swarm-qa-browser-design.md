# Swarm QA Browser — Especificación Técnica Oficial (V1 MVP)

- **Repositorio:** `c:\Users\NITRO ACER\Desktop\proyectos con ia\swarm-qa-browser\`
- **Ramas Git:** `main` (producción/estable) ← `qa` (staging/validación) ← `development` (desarrollo activo)
- **Aprobación:** Validado por Brayan Stid Cortés Lombana (`bscl`) el 2026-11-17
- **Banco de pruebas objetivo:** `sonora-music-player` (rama `development`)

## 1. Propósito
Sistema modular independiente (**Extensión Chrome MV3 + Overlay Multi-Cursor Clean-Room + Bus WebSocket/HTTP local + Servidor MCP + Adaptador CDP**) para que cualquier agente o enjambre de IA (**Antigravity 2.0**, Cursor, Claude Code, Codex) pueda:
1. Desplegar múltiples cursores nombrados por rol y color sobre la web real sin borrar el DOM ni copiar código sin licencia de `swarm-cursors`.
2. Ejecutar auditorías paralelas no destructivas (layout/overflow, solapamientos de texto/cajas, accesibilidad, imágenes rotas, tap targets móviles, consola/red) y acciones interactivas reales protegidas por candado de turno único (`lock-manager`).
3. Emular `390×844` (móvil) y `1440×900` (escritorio) y despachar clics/teclado reales `isTrusted: true` mediante `"debugger"` en Chrome MV3 (con consentimiento explícito del usuario y revocación de 1 clic en `popup.html`) o vía `cdp-bridge`.
4. Mantener una cola viva de hallazgos (`open` → `claimed` → `awaiting_reverify` → `verified` / `reopened` / `escalated` tras 3 rondas) con pines filtrados por `tabId` + `pathname` + `viewport`, y re-verificación automática tras cambios HMR del agente desarrollador.

## 2. Restricciones Globales Obligatorias
- **Ponytail & SRP (Regla 5 y 11):** Todo archivo fuente bajo `packages/` y `scripts/` debe tener una única responsabilidad y mantenerse por debajo de 150–200 líneas.
- **Cero Hardcoding (Regla 6):** Puertos, roles, umbrales y rutas de sesión configurables por entorno/configuración; sin secretos ni tokens quemados.
- **Permisos Chrome MV3 y Consentimiento (Regla 8 + requisito de usuario):**
  - `manifest.json` declara `"permissions": ["activeTab", "scripting", "storage", "debugger"]`, `"host_permissions": ["http://localhost/*", "http://127.0.0.1/*"]` y `"optional_host_permissions": ["http://*/*", "https://*/*"]`, además de una clave pública `"key"` fija para mantener `chrome-extension://<id-fijo>` determinista.
  - `popup.html` exige consentimiento explícito del usuario antes de `chrome.debugger.attach()` y llama `chrome.permissions.request()` si el origen no es `localhost`/`127.0.0.1`. Incluye botón inmediato para desconectar (`chrome.debugger.detach()`).
- **Seguridad del Bus Local (Regla 8):**
  - Escucha exclusivamente en `127.0.0.1` (puerto por defecto `47921` configurable vía `SWARM_BUS_PORT`, o `0` en tests).
  - Registro único en `~/.swarm-qa-browser/bus.json` (sobrescribible con `SWARM_REGISTRY_PATH` para pruebas aisladas) con `{ pid, port, token, extensionId, startedAt }`.
  - Validación estricta de `Origin` (solo `chrome-extension://<extensionId>`, `http://127.0.0.1*`, `http://localhost*`, o clientes CLI/MCP sin `Origin`) + token bearer (`x-swarm-token` o `?token=` en WS). Rechazo con `403` ante orígenes externos o tokens inválidos.
  - Todo dato extraído del DOM/consola/red de páginas inspeccionadas se sanitiza (elimina caracteres de control, máx. 280 chars por campo), redacta `password`/`hidden` como `[redacted]` y se etiqueta `untrustedPageData: true`.
- **Aislamiento `ISOLATED` vs `MAIN` World:**
  - El overlay (`cursor-layer`, `dom-auditor`, `issue-pins`) se monta en mundo `ISOLATED` (o `Page.createIsolatedWorld` en CDP) dentro de un `ShadowRoot` cerrado `#__swarm_qa_overlay`, sin exponerse en `window` de la página ni colisionar con `#__antigravity_native_browser_ui`.
- **Límite Anti-Bucles:** `round` arranca en `1`. Cada ticket permite hasta 3 rondas de corrección; si vuelve a fallar estando en `round === 3`, transiciona a `escalated`.
