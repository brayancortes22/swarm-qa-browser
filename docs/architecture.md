# Arquitectura — Swarm QA Browser

## Visión general

```text
  Cliente MCP (Antigravity, Claude Code, Cursor)        CLI `npm run swarm`
              │ stdio · JSON-RPC 2.0                          │
              ▼                                               │
     packages/mcp-server  (40 herramientas) ──► packages/desktop-adapter (pantalla, ratón, teclado)
              │ POST /rpc + x-swarm-token                     │
              ▼                                               ▼
     packages/core/src/swarm-bus.mjs  ── 127.0.0.1:47921 ──────────────
       ├─ TicketStore   tickets, deduplicación, máximo 3 rondas
       ├─ LockManager   candado exclusivo por pestaña con TTL
       ├─ SessionAuth   token de sesión, lista de orígenes, código de emparejamiento
       └─ Eventos       long-poll (`events.await`), WebSocket y SSE (`GET /events`)
              ▲                               ▲
   WebSocket  │                               │ WebSocket
              │                               │
   packages/extension (Chrome MV3)     packages/cdp-adapter
   background.js · chrome.debugger     cdp-bridge.mjs · Page.createIsolatedWorld
   content.js · mundo ISOLATED
              │                               │
              └───────────────┬───────────────┘
                              ▼
        packages/overlay  (ShadowRoot cerrado #__swarm_qa_overlay)
```

## El overlay

El overlay es un único bundle (`overlay.bundle.js`, generado con esbuild) que los adaptadores inyectan en la página. Expone un controlador con `exec(action, command)`; las acciones desconocidas se rechazan.

| Módulo | Responsabilidad |
| :--- | :--- |
| `clock.js` | Reloj virtual sobre `requestAnimationFrame`. Toda animación lo usa, así que un único factor acelera el enjambre (1×, 2×, 4×). |
| `swarm.js`, `cursor-view.js` | Agentes: trabajadores autónomos y cursores de rol dirigidos desde el bus. Vuelan por una curva hacia un objetivo que se recalcula en cada fotograma. |
| `selection.js`, `rulers.js` | Cajas de selección con tiradores y medidas, marcadores grises, guías y reglas en canvas. |
| `layers.js` | Lista las "capas" de la página: texto, medios, controles y cajas con fondo, borde o sombra. Solo lee. |
| `tour.js`, `style-vault.js` | Tour de reconstrucción. Oculta capas con estilos en línea `!important` y guarda el valor original para restaurarlo exactamente. |
| `dom-auditor.js`, `inspector.js` | Auditoría síncrona del DOM y su coreografía visual. |
| `issue-pins.js`, `hud.js` | Pines que siguen a su elemento y barra de control. |
| `patches.js` | Parches reversibles validados (declaraciones CSS o atributos `aria-*`, `title`, `alt`, `role`). |
| `page-reader.js` | Lectura para agentes de prueba: esquema de elementos interactivos, búsqueda por texto visible o etiqueta de campo, y scroll. |
| `network-console.js` | Sonda del mundo MAIN que reenvía errores de consola y red con un nonce. |

**Tiempo real.** El bus solo envía órdenes de alto nivel ("ve a este selector", "empieza el tour"). El movimiento se calcula en la página, por lo que no depende de la latencia del bus. El progreso vuelve como eventos (`tour_progress`, `tour_done`, `audit_report`).

**No destructivo.** El overlay nunca borra ni reescribe nodos. Los únicos cambios en la página son estilos en línea temporales (tour) y parches explícitos; ambos se revierten al terminar, al detener o al destruir el overlay. Una auditoría detiene primero cualquier tour en curso, porque auditar una página a medio reconstruir ocultaría defectos reales.

## Flujo de una sesión

1. La extensión pide el token con `POST /pair`, enviando el código de emparejamiento.
2. Abre el WebSocket con el token y registra la pestaña (`hello` → `hello_ack`).
3. El agente llama a `swarm_run_dom_audit`. El overlay audita y el bus guarda los hallazgos nuevos como tickets (`tickets.ingest` deduplica por regla, selector y descripción).
4. El agente corrige el código y llama a `swarm_mark_fixed`, que espera al HMR, re-audita y verifica o reabre cada ticket. Tras 3 rondas fallidas el ticket pasa a `escalated`.
5. Alternativa: `swarm_heal_findings` prueba un parche en caliente por ticket y solo marca `verified` los que la re-auditoría confirma.

Si alguien pulsa **Auditar** en la barra del overlay, el informe viaja al bus como `audit_report`, se convierte en tickets y los pines vuelven a la pestaña.

## Pruebas dirigidas por la IA

El servidor MCP añade tres piezas sobre el bus:

- **Observación.** `swarm_screenshot` (CDP `Page.captureScreenshot`, en píxeles CSS para que las coordenadas sirvan para hacer clic) y `swarm_snapshot` (esquema de la página generado por el overlay).
- **Verificación.** `swarm_wait_for` y `swarm_expect` consultan el overlay cada 150 ms hasta que la condición se cumple o vence el tiempo.
- **Registro.** Cada acción (web o de escritorio) y cada comprobación se anota en memoria; `swarm_test_report` lo escribe en `.qa/`. Los textos escritos nunca se guardan.

## Control del PC

`packages/desktop-adapter/src/desktop-driver.mjs` ofrece una interfaz única con dos backends:

| Backend | Entrada | Captura | Ventanas |
| :--- | :--- | :--- | :--- |
| Windows | `user32` (`SetCursorPos`, `mouse_event`, `keybd_event`) y `SendKeys` desde PowerShell | `System.Drawing` | `EnumWindows`, `SetForegroundWindow` |
| Linux/X11 | `xdotool` | ImageMagick `import` | `xdotool` |

El puntero se desplaza por una trayectoria suavizada para que una persona pueda seguirlo. Estas herramientas se ejecutan en el proceso del servidor MCP y no pasan por el bus.

**El control del PC no tiene restricciones.** No hay candado, lista de permitidos ni límite de acciones: es una decisión de diseño pedida expresamente. El único límite es quién puede hablar con el servidor MCP, que se comunica por stdio con el cliente que lo lanzó.

## Modelo de seguridad

1. **Solo loopback.** El bus se niega a enlazar en una dirección que no sea `127.0.0.1`, `localhost` o `::1`.
2. **Orígenes.** Cualquier petición con `Origin` externo recibe `403`. Se aceptan la extensión (`chrome-extension://<id fijo>`), `http://localhost` y `http://127.0.0.1`, y clientes sin `Origin` (CLI, MCP).
3. **Token de sesión.** RPC, WebSocket y SSE exigen un token aleatorio de 24 bytes que cambia en cada arranque. Se guarda en `~/.swarm-qa-browser/bus.json` con permisos `0600`.
4. **Emparejamiento.** `POST /pair` exige el origen de la extensión **y** un código persistente (`~/.swarm-qa-browser/pairing.json`, `0600`). La cabecera `Origin` la puede falsificar cualquier proceso local; el código no. Cinco intentos fallidos bloquean el emparejamiento un minuto.
5. **Aislamiento.** El overlay se ejecuta en el mundo `ISOLATED` de la extensión o en un mundo aislado creado por CDP, dentro de un ShadowRoot cerrado. Si un webview no admite mundos aislados, el puente CDP usa el mundo principal y no deja ninguna referencia global.
6. **Datos no confiables.** El texto que sale de la página se limpia de caracteres de control y bidi, se limita a 280 caracteres y viaja marcado con `untrustedPageData: true`. Los valores de campos `password` y `hidden` se sustituyen por `[redacted]`.
7. **Mutaciones con candado.** `set_viewport`, `click`, `hover`, `scroll`, `fill`, `press_key`, `navigate`, `apply_patch` y `revert_patch` exigen el candado de la pestaña. Los roles marcados como solo lectura (`layout`, `forms-a11y`, `console-net`) no pueden mutar.
8. **Parches como datos.** Un parche nunca contiene CSS ni HTML libre: el selector debe existir en la página y cada declaración se valida por separado.
9. **Consentimiento.** La extensión no adjunta el depurador sin confirmación explícita y pide permiso de origen para sitios fuera de `localhost`.

Los puntos anteriores protegen la superficie **web**. Las herramientas de escritorio quedan fuera de este modelo: ver la sección *Control del PC*.

## Decisiones

- **Sin persistencia de tickets.** El bus es un proceso de sesión; los informes duraderos se exportan a `.qa/`.
- **Bundle generado, no versionado.** `npm install` y `npm test` lo regeneran, lo que evita copias desincronizadas.
- **Estilos en línea en lugar de hojas de estilo.** Modificar `element.style` por CSSOM funciona con cualquier CSP de la página; inyectar `<style>` no.
