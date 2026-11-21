# Checklist de seguridad

Cada punto indica la prueba que lo verifica.

- [x] El bus rechaza hosts que no son loopback. `swarm-bus-security.test.mjs`
- [x] `Origin` externo → `403` en HTTP y WebSocket. `swarm-bus-security.test.mjs`
- [x] Token de sesión aleatorio (`crypto.randomBytes(24)`), comparado en tiempo constante; sin token → `401`. `swarm-bus-security.test.mjs`
- [x] `/pair` exige origen de la extensión **y** código de emparejamiento; 5 fallos bloquean un minuto. `swarm-bus-security.test.mjs`, `test:e2e`
- [x] Registro y código de emparejamiento escritos con permisos `0600`. Revisión de código (`session-auth.mjs`); en Windows el sistema ignora el modo.
- [x] `manifest.json` limita `host_permissions` a `localhost`/`127.0.0.1`; el resto es opcional y se pide por origen. `extension.test.mjs`
- [x] Consentimiento explícito antes de `chrome.debugger.attach()`. `extension.test.mjs`
- [x] Mensajes de scripts de contenido limitados a tres tipos; el resto se rechaza. `extension.test.mjs`
- [x] Texto de la página saneado, limitado y marcado `untrustedPageData: true`; `password`/`hidden` → `[redacted]`. `dom-auditor.test.mjs`, `ticket-store.test.mjs`
- [x] Overlay en ShadowRoot cerrado, sin referencias globales en la página. `overlay.test.mjs`, `cdp-bridge.test.mjs`
- [x] Comandos desconocidos del overlay se rechazan. `overlay.test.mjs`, `extension.test.mjs`
- [x] Mutaciones (incluidos parches) exigen candado; roles de solo lectura no pueden mutar. `swarm-bus-security.test.mjs`, `test:e2e`
- [x] Parches validados: selector existente, declaraciones una a una, solo atributos `aria-*`, `title`, `alt`, `role`. `overlay.test.mjs`, `patch-generator.test.mjs`

## Riesgos aceptados

- Cualquier proceso del mismo usuario puede leer `bus.json` y usar el bus. El modelo protege frente a páginas web y otros usuarios de la máquina, no frente a software que ya se ejecuta con tu cuenta.
- El token viaja en la URL del WebSocket (`?token=`) porque la API de WebSocket del navegador no admite cabeceras. La conexión es solo loopback.
