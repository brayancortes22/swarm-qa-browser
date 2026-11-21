# Guía de pruebas

## Pruebas automáticas

```bash
npm test
```

Ejecuta 58 pruebas con `node:test`. No necesitan navegador.

| Archivo | Cubre |
| :--- | :--- |
| `ticket-store.test.mjs` | Ciclo de vida de tickets, 3 rondas exactas, saneado de texto. |
| `lock-manager.test.mjs` | Exclusión mutua, TTL, renovación y registro del bus. |
| `swarm-bus-security.test.mjs` | Orígenes (`403`), token (`401`), código de emparejamiento y límite de intentos, `tab_closed`, roles de solo lectura, candado de parches, `tickets.ingest`, SSE. |
| `mcp-server.test.mjs` | Protocolo stdio, las 42 herramientas, bucle QA → Dev → re-verificación, auto-sanación, herramientas de prueba (texto visible, esperas, comprobaciones, informe) y de escritorio con un controlador simulado. |
| `patch-generator.test.mjs` | Recetas alineadas con las reglas del auditor, rechazo de selectores peligrosos. |
| `dom-auditor.test.mjs` | Cada comprobación del auditor y la redacción de campos sensibles. |
| `overlay.test.mjs` | Motor del overlay sobre jsdom: capas, cursores, pines, parches, tour, restauración exacta de la página y lector de página (esquema, búsqueda por texto, redacción). |
| `extension.test.mjs` | Popup, script de contenido y service worker con `chrome.*` simulado. |
| `cdp-bridge.test.mjs` | Puente CDP contra un servidor CDP simulado. |
| `desktop-adapter.test.mjs` | Filtros y reglas del adaptador de escritorio. |

## Prueba de extremo a extremo

```bash
npm i -D playwright
npx playwright install chromium
npm run test:e2e
```

Lanza Chromium real y comprueba tres rutas:

1. **Página standalone.** El tour reconstruye todas las capas y deja `document.body.innerHTML` idéntico.
2. **Agente → MCP → bus → puente CDP.** Auditoría con tickets sin duplicados, auto-sanación verificada por re-auditoría, tour dirigido por MCP con progreso por eventos, clic real y rechazo de un rol de solo lectura. Incluye una prueba funcional completa hecha por el agente: captura, clic por texto, relleno por etiqueta, tres comprobaciones (una falla de verdad y crea un ticket) e informe.
3. **Extensión MV3.** Emparejamiento (código incorrecto rechazado), `chrome.debugger`, tour, auditoría, clic, captura, hover y desconexión.

`npm run test:e2e -- --shots` regenera las capturas de `docs/media/`. Si Playwright no está instalado, el script lo indica y termina sin error.

## Prueba de control del PC

```bash
npm run test:e2e:desktop
```

Abre una ventana visible de Chromium y la maneja con el ratón y el teclado **reales** a través de las herramientas `swarm_desktop_*`: captura la pantalla, localiza la ventana, hace clic en un campo, escribe, borra con `ctrl+a`, usa la rueda, arrastra y pulsa un enlace. La propia página confirma cada entrada (`isTrusted: true`).

- **Linux sin pantalla:** se relanza sola dentro de Xvfb. Necesita `xdotool`, `imagemagick` y `xvfb`.
- **Windows:** usa tu escritorio real durante unos segundos; no toques el ratón mientras corre. Es la forma de validar el backend de Windows, que no se ha ejecutado en el entorno donde se desarrolló.

## Comprobación manual

1. `npm run demo` y abre <http://127.0.0.1:5173>.
2. Pulsa **Tour**: la página se vacía y el enjambre la reconstruye. Pulsa **Detener** a mitad: la página vuelve al instante.
3. Pulsa **Auditar**: los agentes recorren la página y aparecen pines. La demo contiene estos defectos intencionales:

| Defecto | Regla esperada |
| :--- | :--- |
| Botón de tema sin nombre accesible | `a11y-accessible-name` |
| Campo de correo sin etiqueta | `a11y-form-label` |
| Imagen `panel-en-vivo.png` inexistente | `media-broken-image` |
| Etiqueta "Nuevo" encima del título | `overlap-elements` |
| Fila de etiquetas más ancha que su tarjeta | `overflow-container` |
| Petición a `/api/metrics/live` | `console-net-4xx` |

## Qué no cubren las pruebas

- Los scripts de PowerShell (`win-probe.ps1`, `win-input.ps1`) no se ejecutan en CI ni se han ejecutado nunca en este desarrollo; el backend de Linux sí.
- No hay pruebas de rendimiento con páginas de miles de nodos. El escáner de capas se limita a 8000 nodos y 400 capas por defecto.
