# Checklist de Seguridad (Hard Gate)

- [x] Bus local enlazado estrictamente a `127.0.0.1` (nunca `0.0.0.0`).
- [x] Validación estricta de `Origin` en HTTP y WebSocket (`chrome-extension://<id-fijo>` o clientes locales; `403` para orígenes web externos).
- [x] Token criptográfico efímero de sesión (`crypto.randomBytes(24)`), nunca quemado en código.
- [x] `manifest.json` con `host_permissions` limitado a `localhost`/`127.0.0.1` y `optional_host_permissions` explícito para otros sitios + tarjeta de consentimiento antes de `chrome.debugger.attach()`.
- [x] Datos del DOM/red sanitizados, acotados y marcados con `untrustedPageData: true` + redacción `[redacted]` para inputs `password` y `hidden`.
- [x] Overlay aislado en `ISOLATED` world + `ShadowRoot` cerrado (`#__swarm_qa_overlay`).
