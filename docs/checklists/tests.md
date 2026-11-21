# Checklist de pruebas

- [x] `npm test`: 55 pruebas en verde (unitarias e integración). Ver [docs/testing.md](../testing.md).
- [x] `npm run test:e2e`: página standalone, puente CDP + MCP y extensión MV3 en Chromium real.
- [x] `npm run lint` y `npm run format:check` sin errores.
- [x] El bundle del overlay se genera y se verifica en cada `npm install` y `npm test`.
- [x] CI (`.github/workflows/ci.yml`) ejecuta lint, formato, pruebas y E2E.
- [ ] Sondeo de ventanas de Windows (`win-probe.ps1`) probado en una máquina real.
- [ ] Prueba de rendimiento con páginas de más de 5000 nodos.
