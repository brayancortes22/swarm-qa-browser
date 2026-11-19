# Plan Maestro: Swarm QA 2.0 (Integrated Agentic Ecosystem)

Este documento detalla la hoja de ruta para la evolución de **Swarm QA Browser** hacia un ecosistema de agentes autónomos con telemetría en tiempo real, control de SO y auto-sanación.

## 1. Estado Actual (Validado)
- ✅ **Arquitectura Bus Core:** Estable, coordinada por `cli-bus.mjs`.
- ✅ **Adaptador de Escritorio:** Funcional, capaz de escanear ventanas y controlar el cursor.
- ✅ **Capa Visual (Overlay):** Implementada en Electron, preparada para renderizar cursores (60 FPS).
- ✅ **Auto-Sanación:** Integrada en el flujo de auditoría `tour:heal`.
- ✅ **Git Workflow:** Estricto (dev -> qa -> main).

## 2. Plan de Mejora Evolutiva (Fases 1-4)

### Fase 1: Telemetría de Clics y Cursores (In Progress)
- [ ] Refinar `renderer.js` para sincronizar estados reales (bus) con el movimiento en pantalla.
- [ ] Añadir pulso visual de "clic" (`isTrusted: true`) y etiquetas de rol dinámicas.

### Fase 2: Guardrails y Autonomía Acotada
- [ ] Implementar `budget` por sesión en `cli-bus.mjs` (max steps/retries).
- [ ] Integrar `LockManager` con TTL estricto para evitar *deadlocks* en la interacción web/desktop.

### Fase 3: Integración Integrada (Antigravity 2.0 + OS Mode)
- [ ] Unificar el adaptador de navegador embebido con los esquemas del bus.
- [ ] Implementar el *kill-switch* físico (monitoreo de teclado/ratón) para aborto inmediato.

### Fase 4: Telemetría Visual (Snapshot/Rebuild)
- [ ] Desarrollar módulo para reconstrucción de DOM/estilos en lienzo independiente.

## 3. Acciones inmediatas
1. **Validación:** El sistema ya cumple con la mayoría de los RNF (Seguridad, Fidelidad).
2. **Mejora:** Optimizar la latencia del bus en Windows (Node + PowerShell I/O).
3. **Documentación:** Actualizar README principal con este plan y los nuevos endpoints del bus.

---
*Este plan será la base de nuestra hoja de ruta técnica.*
