# Checklist de seguridad

Cada punto indica la prueba que lo verifica.

- [x] El bus rechaza hosts que no son loopback. `swarm-bus-security.test.mjs`
- [x] `Origin` externo → `403` en HTTP y WebSocket. `swarm-bus-security.test.mjs`
- [x] Token de sesión aleatorio (`crypto.randomBytes(24)`), comparado en tiempo constante; sin token → `401`. `swarm-bus-security.test.mjs`
- [x] `/pair` exige el origen de la extensión. El código de emparejamiento y el límite de intentos solo aplican en modo estricto (`SWARM_REQUIRE_PAIR_CODE=1`). `swarm-bus-security.test.mjs`
- [x] Registro y código de emparejamiento escritos con permisos `0600`. Revisión de código (`session-auth.mjs`); en Windows el sistema ignora el modo.
- [ ] ~~`host_permissions` limitado a `localhost`~~: retirado. La extensión tiene acceso a todos los sitios.
- [ ] ~~Consentimiento antes de `chrome.debugger.attach()`~~: retirado. El agente puede adjuntar pestañas por sí mismo.
- [x] Mensajes de scripts de contenido limitados a tres tipos; el resto se rechaza. `extension.test.mjs`
- [x] Texto de la página saneado, limitado y marcado `untrustedPageData: true`; `password`/`hidden` → `[redacted]`. `dom-auditor.test.mjs`, `ticket-store.test.mjs`
- [x] Overlay en ShadowRoot cerrado, sin referencias globales en la página. `overlay.test.mjs`, `cdp-bridge.test.mjs`
- [x] Comandos desconocidos del overlay se rechazan. `overlay.test.mjs`, `extension.test.mjs`
- [x] Mutaciones (incluidos parches) exigen candado; roles de solo lectura no pueden mutar. `swarm-bus-security.test.mjs`, `test:e2e`
- [x] Parches validados: selector existente, declaraciones una a una, solo atributos `aria-*`, `title`, `alt`, `role`. `overlay.test.mjs`, `patch-generator.test.mjs`

## Riesgos aceptados

- **Modo automático.** Sin código de emparejamiento, cualquier proceso local puede obtener el token del bus falsificando la cabecera `Origin`; con acceso a todos los sitios y sin consentimiento, eso equivale a controlar el navegador del usuario, incluidas sus sesiones iniciadas. Decisión expresa del propietario.
- **El control del PC no tiene salvaguardas.** Las herramientas `swarm_desktop_*` permiten ver la pantalla, escribir en cualquier ventana y abrir programas sin confirmación, límite ni lista de permitidos. Es una decisión expresa del propietario del proyecto. Un agente comprometido o confundido por contenido malicioso (por ejemplo, texto de una página que le dé instrucciones) puede hacer en el equipo todo lo que podría hacer su usuario.
- Cualquier proceso del mismo usuario puede leer `bus.json` y usar el bus. El modelo protege frente a páginas web y otros usuarios de la máquina, no frente a software que ya se ejecuta con tu cuenta.
- El token viaja en la URL del WebSocket (`?token=`) porque la API de WebSocket del navegador no admite cabeceras. La conexión es solo loopback.
