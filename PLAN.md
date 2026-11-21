# Hoja de ruta — Swarm QA Browser

Este documento separa lo que **funciona y está probado** de lo que está pendiente. Si una línea no tiene una prueba que la respalde, no aparece como hecha.

## Hecho (v0.2)

- Motor de enjambre en tiempo real: hasta 32 cursores, selección con medidas, reglas, guías y sonido opcional.
- Tour de reconstrucción reversible, con velocidad 1×/2×/4× y scroll automático.
- Auditoría del DOM con coreografía visual, tickets deduplicados y pines que siguen a su elemento.
- Auto-sanación con verificación real: parche, re-auditoría y reversión si el hallazgo persiste.
- Bus local con emparejamiento por código, roles de solo lectura, candado para parches y eventos por SSE.
- Tres transportes probados en Chromium real: página standalone, puente CDP y extensión MV3.
- CLI `npm run swarm`, página de demostración, lint, formato y CI.

## Siguiente

| Prioridad | Tarea | Motivo |
| :--- | :--- | :--- |
| 1 | Persistir tickets en disco | Hoy se pierden al reiniciar el bus. |
| 2 | Presupuesto por sesión (pasos y reintentos) | Evita bucles largos de un agente. |
| 3 | Botón de parada de emergencia en la barra del overlay | El candado caduca por TTL, pero no hay un aborto manual global. |
| 4 | Más recetas de auto-sanación (`overflow-document`, `overlap-elements`) | Hoy solo hay 4 reglas con receta. |
| 5 | Contraste de color y orden de foco en el auditor | Completa la cobertura de accesibilidad. |
| 6 | Grabación y reproducción de sesiones | Revisar un recorrido sin repetirlo. |

## Más adelante

- Cursores sobre el escritorio (el adaptador de Windows hoy solo audita ventanas).
- Ejecución en CI con comentarios automáticos en pull requests.
- Elegir una licencia y publicar la extensión.

## Flujo de ramas

`development` (trabajo activo, rama por defecto) → `qa` (validación) → `main` (estable). Las ramas de funcionalidad salen de `development` y vuelven a ella por pull request; CI se ejecuta en las tres ramas y en cada pull request.
